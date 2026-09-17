use crate::{models::ConnectionProfile, store};
use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
use ssh2::{HashType, Session};
use std::{
    io::{ErrorKind, Read, Write},
    net::{TcpListener, TcpStream, ToSocketAddrs},
    path::PathBuf,
    sync::{Arc, atomic::{AtomicBool, Ordering}},
    thread::{self, JoinHandle},
    time::Duration,
};

pub struct SshTunnel {
    port: u16,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl SshTunnel {
    pub fn start(profile: &ConnectionProfile) -> Result<Self, String> {
        let ssh = &profile.ssh;
        let address = format!("{}:{}", ssh.host, ssh.port).to_socket_addrs().map_err(|e| format!("SSHホストを解決できません: {e}"))?.next().ok_or("SSHホストを解決できません")?;
        let tcp = TcpStream::connect_timeout(&address, Duration::from_secs(12)).map_err(|e| format!("SSHサーバーに接続できません: {e}"))?;
        tcp.set_read_timeout(Some(Duration::from_secs(15))).map_err(|e| e.to_string())?;
        tcp.set_write_timeout(Some(Duration::from_secs(15))).map_err(|e| e.to_string())?;
        let mut session = Session::new().map_err(|e| e.to_string())?;
        session.set_tcp_stream(tcp);
        session.handshake().map_err(|e| format!("SSHハンドシェイクに失敗しました: {e}"))?;

        let fingerprint = session.host_key_hash(HashType::Sha256).map(|hash| format!("SHA256:{}", STANDARD_NO_PAD.encode(hash))).ok_or("SSHホスト鍵を取得できません")?;
        match ssh.trusted_fingerprint.as_deref() {
            None => return Err(format!("UNKNOWN_HOST_KEY:{fingerprint}")),
            Some(trusted) if trusted != fingerprint => return Err(format!("SSHホスト鍵が変更されています。接続を拒否しました。\n保存済み: {trusted}\n現在: {fingerprint}")),
            _ => {}
        }

        match ssh.auth_method.as_str() {
            "password" => {
                let password = store::get_secret(&profile.id, "ssh-password").ok_or("SSHパスワードがKeychainにありません")?;
                session.userauth_password(&ssh.username, &password).map_err(|e| format!("SSHパスワード認証に失敗しました: {e}"))?;
            }
            "privateKey" => {
                let path = expand_home(&ssh.private_key_path)?;
                let passphrase = store::get_secret(&profile.id, "key-passphrase");
                session.userauth_pubkey_file(&ssh.username, None, &path, passphrase.as_deref()).map_err(|e| format!("SSH秘密鍵認証に失敗しました: {e}"))?;
            }
            "agent" => {
                let mut agent = session.agent().map_err(|e| e.to_string())?;
                agent.connect().map_err(|e| format!("SSH Agentに接続できません: {e}"))?;
                agent.list_identities().map_err(|e| e.to_string())?;
                let identities = agent.identities().map_err(|e| e.to_string())?;
                let mut authenticated = false;
                for identity in identities {
                    if agent.userauth(&ssh.username, &identity).is_ok() { authenticated = true; break; }
                }
                if !authenticated { return Err("SSH Agent内の鍵では認証できませんでした".into()); }
            }
            _ => return Err("未対応のSSH認証方式です".into()),
        }
        if !session.authenticated() { return Err("SSH認証に失敗しました".into()); }
        session.set_keepalive(true, 30);

        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("ローカル転送ポートを確保できません: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let destination_host = profile.host.clone();
        let destination_port = profile.port;
        let worker = thread::Builder::new().name(format!("ssh-tunnel-{}", profile.id)).spawn(move || {
            while !worker_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((local, _)) => {
                        session.set_blocking(true);
                        let channel = session.channel_direct_tcpip(&destination_host, destination_port, None);
                        session.set_blocking(false);
                        if let Ok(channel) = channel { pump(local, channel, &worker_stop); }
                    }
                    Err(error) if error.kind() == ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(10)),
                    Err(_) => break,
                }
            }
            let _ = session.disconnect(None, "My Postico tunnel closed", None);
        }).map_err(|e| e.to_string())?;
        Ok(Self { port, stop, worker: Some(worker) })
    }

    pub fn local_port(&self) -> u16 { self.port }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() { let _ = worker.join(); }
    }
}

fn expand_home(path: &str) -> Result<PathBuf, String> {
    if path == "~" || path.starts_with("~/") {
        let home = directories::BaseDirs::new().ok_or("ホームディレクトリを取得できません")?;
        return Ok(if path == "~" { home.home_dir().to_path_buf() } else { home.home_dir().join(&path[2..]) });
    }
    Ok(PathBuf::from(path))
}

fn pump(mut local: TcpStream, mut channel: ssh2::Channel, stop: &AtomicBool) {
    if local.set_nonblocking(true).is_err() { return; }
    let mut to_ssh = Vec::<u8>::new();
    let mut to_local = Vec::<u8>::new();
    let mut local_eof = false;
    loop {
        if stop.load(Ordering::Relaxed) { break; }
        let mut progressed = false;
        if to_ssh.is_empty() && !local_eof {
            let mut buffer = [0_u8; 32 * 1024];
            match local.read(&mut buffer) {
                Ok(0) => { local_eof = true; let _ = channel.send_eof(); }
                Ok(size) => { to_ssh.extend_from_slice(&buffer[..size]); progressed = true; }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                Err(_) => break,
            }
        }
        if !to_ssh.is_empty() {
            match channel.write(&to_ssh) {
                Ok(size) => { to_ssh.drain(..size); progressed = true; }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                Err(_) => break,
            }
        }
        if to_local.is_empty() && !channel.eof() {
            let mut buffer = [0_u8; 32 * 1024];
            match channel.read(&mut buffer) {
                Ok(0) => {}
                Ok(size) => { to_local.extend_from_slice(&buffer[..size]); progressed = true; }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                Err(_) => break,
            }
        }
        if !to_local.is_empty() {
            match local.write(&to_local) {
                Ok(size) => { to_local.drain(..size); progressed = true; }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                Err(_) => break,
            }
        }
        if local_eof && channel.eof() && to_ssh.is_empty() && to_local.is_empty() { break; }
        if !progressed { thread::sleep(Duration::from_millis(2)); }
    }
    let _ = channel.close();
}
