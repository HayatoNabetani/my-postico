use crate::models::{ConnectionProfile, ProfileSecrets};
use directories::ProjectDirs;
use keyring::Entry;
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

const SERVICE: &str = "dev.mypostico.desktop";
static SECRET_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn secret_cache() -> &'static Mutex<HashMap<String, String>> {
    SECRET_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn secret_key(id: &str, kind: &str) -> String { format!("{id}:{kind}") }

fn config_path() -> Result<PathBuf, String> {
    let dirs = ProjectDirs::from("dev", "MyPostico", "My Postico").ok_or("アプリ設定ディレクトリを取得できません")?;
    fs::create_dir_all(dirs.config_dir()).map_err(|e| e.to_string())?;
    Ok(dirs.config_dir().join("connections.json"))
}

pub fn list_profiles() -> Result<Vec<ConnectionProfile>, String> {
    let path = config_path()?;
    if !path.exists() { return Ok(Vec::new()); }
    let data = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| format!("接続設定が壊れています: {e}"))
}

pub fn find_profile(id: &str) -> Result<ConnectionProfile, String> {
    list_profiles()?.into_iter().find(|item| item.id == id).ok_or_else(|| "接続設定が見つかりません".into())
}

pub fn save_profile(profile: ConnectionProfile, secrets: ProfileSecrets) -> Result<(), String> {
    let mut profiles = list_profiles()?;
    profiles.retain(|item| item.id != profile.id);
    profiles.push(profile.clone());
    profiles.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    let json = serde_json::to_string_pretty(&profiles).map_err(|e| e.to_string())?;
    let path = config_path()?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, json).map_err(|e| e.to_string())?;
    fs::rename(temporary, path).map_err(|e| e.to_string())?;
    set_secret(&profile.id, "db-password", secrets.db_password)?;
    set_secret(&profile.id, "ssh-password", secrets.ssh_password)?;
    set_secret(&profile.id, "key-passphrase", secrets.key_passphrase)?;
    Ok(())
}

pub fn delete_profile(id: &str) -> Result<(), String> {
    let mut profiles = list_profiles()?;
    profiles.retain(|item| item.id != id);
    fs::write(config_path()?, serde_json::to_string_pretty(&profiles).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    for kind in ["db-password", "ssh-password", "key-passphrase"] {
        let key = secret_key(id, kind);
        if let Ok(mut cache) = secret_cache().lock() { cache.remove(&key); }
        let _ = Entry::new(SERVICE, &key).and_then(|entry| entry.delete_credential());
    }
    Ok(())
}

fn set_secret(id: &str, kind: &str, value: Option<String>) -> Result<(), String> {
    let Some(value) = value.filter(|value| !value.is_empty()) else { return Ok(()); };
    let key = secret_key(id, kind);
    Entry::new(SERVICE, &key).map_err(|e| e.to_string())?.set_password(&value).map_err(|e| e.to_string())?;
    secret_cache().lock().map_err(|_| "秘密情報キャッシュをロックできません")?.insert(key, value);
    Ok(())
}

pub fn get_secret(id: &str, kind: &str) -> Option<String> {
    let key = secret_key(id, kind);
    if let Some(value) = secret_cache().lock().ok()?.get(&key).cloned() { return Some(value); }
    let value = Entry::new(SERVICE, &key).ok()?.get_password().ok()?;
    secret_cache().lock().ok()?.insert(key, value.clone());
    Some(value)
}
