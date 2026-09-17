import { useEffect, useRef, useState } from "react";
import { KeyRound, Server, ShieldCheck, X } from "lucide-react";
import type { ConnectionProfile, ProfileSecrets, SshAuthMethod } from "../types";

const blankProfile = (): ConnectionProfile => ({
  id: crypto.randomUUID(), name: "New connection", host: "localhost", port: 5432,
  database: "postgres", username: "postgres", sslMode: "prefer", environment: "Local",
  readOnly: false,
  ssh: { enabled: false, host: "", port: 22, username: "", authMethod: "privateKey", privateKeyPath: "~/.ssh/id_ed25519" },
});

interface Props {
  initial?: ConnectionProfile;
  onClose: () => void;
  onSave: (profile: ConnectionProfile, secrets: ProfileSecrets) => Promise<void>;
  embedded?: boolean;
  focusRequest?: number;
}

export function ConnectionDialog({ initial, onClose, onSave, embedded = false, focusRequest = 0 }: Props) {
  const [profile, setProfile] = useState<ConnectionProfile>(initial ?? blankProfile());
  const [secrets, setSecrets] = useState<ProfileSecrets>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const typingProps = {autoCapitalize: "none", autoCorrect: "off", spellCheck: false} as const;
  useEffect(() => setProfile(initial ?? blankProfile()), [initial]);
  useEffect(() => {
    if (!embedded || focusRequest === 0) return;
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, [embedded, focusRequest]);

  const change = <K extends keyof ConnectionProfile>(key: K, value: ConnectionProfile[K]) =>
    setProfile((current) => ({ ...current, [key]: value }));
  const sshChange = <K extends keyof ConnectionProfile["ssh"]>(key: K, value: ConnectionProfile["ssh"][K]) =>
    setProfile((current) => ({ ...current, ssh: { ...current.ssh, [key]: value } }));

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      await onSave(profile, secrets);
      if (embedded) { setProfile(blankProfile()); setSecrets({}); }
      else onClose();
    }
    catch (reason) { setError(String(reason)); }
    finally { setSaving(false); }
  }

  const form = <form className={embedded ? "connection-inline-form" : "dialog"} autoCapitalize="none" autoCorrect="off" spellCheck={false} onSubmit={submit}>
      <header className="dialog-header">
        <div><span className="eyebrow">CONNECTION</span><h2>{initial ? "接続を編集" : "新しい接続"}</h2></div>
        {!embedded && <button className="icon-button" type="button" onClick={onClose}><X size={18}/></button>}
      </header>

      <section className="form-section">
        <h3><Server size={16}/> PostgreSQL</h3>
        <div className="form-grid">
          <label className="span-2">表示名<input ref={nameInputRef} {...typingProps} required value={profile.name} onChange={(e) => change("name", e.target.value)}/></label>
          <label>ホスト<input {...typingProps} required value={profile.host} onChange={(e) => change("host", e.target.value)}/></label>
          <label>ポート<input required type="number" value={profile.port} onChange={(e) => change("port", Number(e.target.value))}/></label>
          <label>データベース<input {...typingProps} required value={profile.database} onChange={(e) => change("database", e.target.value)}/></label>
          <label>ユーザー<input {...typingProps} required value={profile.username} onChange={(e) => change("username", e.target.value)}/></label>
          <label>パスワード<input {...typingProps} type="password" placeholder={initial ? "変更しない" : "Keychainに保存"} value={secrets.dbPassword ?? ""} onChange={(e) => setSecrets({...secrets, dbPassword: e.target.value})}/></label>
          <label>SSL<select value={profile.sslMode} onChange={(e) => change("sslMode", e.target.value as ConnectionProfile["sslMode"])}><option value="disable">Disable</option><option value="prefer">Prefer</option><option value="require">Require</option><option value="verifyFull">Verify Full</option></select></label>
          <label>環境<select value={profile.environment} onChange={(e) => change("environment", e.target.value as ConnectionProfile["environment"])}><option>Local</option><option>Development</option><option>Staging</option><option>Production</option></select></label>
          <label className="toggle-label"><input type="checkbox" checked={profile.readOnly} onChange={(e) => change("readOnly", e.target.checked)}/> 読み取り専用</label>
        </div>
      </section>

      <section className="form-section">
        <div className="section-title-row"><h3><ShieldCheck size={16}/> SSHトンネル</h3><label className="switch"><input type="checkbox" checked={profile.ssh.enabled} onChange={(e) => sshChange("enabled", e.target.checked)}/><span/></label></div>
        {profile.ssh.enabled && <div className="form-grid">
          <label>SSHホスト<input {...typingProps} required value={profile.ssh.host} onChange={(e) => sshChange("host", e.target.value)}/></label>
          <label>SSHポート<input required type="number" value={profile.ssh.port} onChange={(e) => sshChange("port", Number(e.target.value))}/></label>
          <label>SSHユーザー<input {...typingProps} required value={profile.ssh.username} onChange={(e) => sshChange("username", e.target.value)}/></label>
          <label>認証方式<select value={profile.ssh.authMethod} onChange={(e) => sshChange("authMethod", e.target.value as SshAuthMethod)}><option value="privateKey">秘密鍵</option><option value="password">パスワード</option><option value="agent">SSH Agent</option></select></label>
          {profile.ssh.authMethod === "privateKey" && <>
            <label className="span-2">秘密鍵のパス<input {...typingProps} required value={profile.ssh.privateKeyPath} onChange={(e) => sshChange("privateKeyPath", e.target.value)}/></label>
            <label className="span-2">パスフレーズ<input {...typingProps} type="password" placeholder={initial ? "変更しない" : "Keychainに保存"} value={secrets.keyPassphrase ?? ""} onChange={(e) => setSecrets({...secrets, keyPassphrase: e.target.value})}/></label>
          </>}
          {profile.ssh.authMethod === "password" && <label className="span-2">SSHパスワード<input {...typingProps} required={!initial} type="password" placeholder={initial ? "変更しない" : "Keychainに保存"} value={secrets.sshPassword ?? ""} onChange={(e) => setSecrets({...secrets, sshPassword: e.target.value})}/></label>}
          <p className="form-hint span-2"><KeyRound size={14}/> 初回接続時にホスト鍵のフィンガープリントを確認します。</p>
        </div>}
      </section>
      {error && <div className="error-banner">{error}</div>}
      <footer className="dialog-footer">{!embedded && <button type="button" className="secondary" onClick={onClose}>キャンセル</button>}<button className="primary" disabled={saving}>{saving ? "保存中…" : "接続を保存"}</button></footer>
    </form>;
  return embedded ? form : <div className="dialog-backdrop" role="presentation">{form}</div>;
}
