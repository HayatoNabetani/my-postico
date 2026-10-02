mod db;
mod filters;
mod models;
mod ssh;
mod store;

use db::ConnectedDb;
use models::{ColumnInfo, ConnectionProfile, FilterNode, FunctionInfo, ProfileSecrets, QueryPage, SchemaInfo, SortRule, TableChangeResult, TableChanges, TableInfo};
use std::{collections::HashMap, sync::{Arc, Mutex}};

#[derive(Clone, Default)]
struct AppState {
    connections: Arc<Mutex<HashMap<String, ConnectedDb>>>,
    query_cancellations: Arc<Mutex<HashMap<String, db::QueryCancel>>>,
}

// Database, SSH and Keychain calls block; never run them on the UI/runtime threads.
macro_rules! blocking_command {
    (fn $name:ident($state:ident: tauri::State<AppState> $(, $arg:ident: $ty:ty)*) -> $result:ty $body:block) => {
        #[tauri::command]
        async fn $name($state: tauri::State<'_, AppState>, $($arg: $ty),*) -> $result {
            let $state = $state.inner().clone();
            tauri::async_runtime::spawn_blocking(move || $body)
                .await.map_err(|error| format!("バックグラウンド処理に失敗しました: {error}"))?
        }
    };
    (fn $name:ident($($arg:ident: $ty:ty),*) -> $result:ty $body:block) => {
        #[tauri::command]
        async fn $name($($arg: $ty),*) -> $result {
            tauri::async_runtime::spawn_blocking(move || $body)
                .await.map_err(|error| format!("バックグラウンド処理に失敗しました: {error}"))?
        }
    };
}

blocking_command! {
fn list_profiles() -> Result<Vec<ConnectionProfile>, String> { store::list_profiles() }
}

blocking_command! {
fn save_profile(profile: ConnectionProfile, secrets: ProfileSecrets) -> Result<(), String> { store::save_profile(profile, secrets) }
}

blocking_command! {
fn delete_profile(state: tauri::State<AppState>, id: String) -> Result<(), String> {
    state.query_cancellations.lock().map_err(|_| "キャンセル状態をロックできません")?.remove(&id);
    state.connections.lock().map_err(|_| "接続状態をロックできません")?.remove(&id);
    store::delete_profile(&id)
}
}

blocking_command! {
fn test_connection(id: String) -> Result<String, String> {
    let profile = store::find_profile(&id)?;
    let _connection = db::connect(&profile)?;
    Ok("接続に成功しました".into())
}
}

blocking_command! {
fn connect_profile(state: tauri::State<AppState>, id: String) -> Result<(), String> {
    let profile = store::find_profile(&id)?;
    let connection = db::connect(&profile)?;
    state.connections.lock().map_err(|_| "接続状態をロックできません")?.insert(id, connection);
    Ok(())
}
}

blocking_command! {
fn disconnect_profile(state: tauri::State<AppState>, id: String) -> Result<(), String> {
    state.query_cancellations.lock().map_err(|_| "キャンセル状態をロックできません")?.remove(&id);
    state.connections.lock().map_err(|_| "接続状態をロックできません")?.remove(&id);
    Ok(())
}
}

fn reconnect(connections: &mut HashMap<String, ConnectedDb>, profile_id: &str) -> Result<(), String> {
    let profile = store::find_profile(profile_id)?;
    connections.insert(profile_id.to_owned(), db::connect(&profile)?);
    Ok(())
}

fn connection_error(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("connection closed") || message.contains("closed connection") || message.contains("broken pipe") || message.contains("connection reset") || message.contains("unexpected eof")
}

fn with_connection<T>(state: &AppState, profile_id: &str, mut action: impl FnMut(&mut ConnectedDb) -> Result<T, String>) -> Result<T, String> {
    let mut connections = state.connections.lock().map_err(|_| "接続状態をロックできません")?;
    let closed = connections.get(profile_id).ok_or("データベースへ接続してください")?.client.is_closed();
    if closed { reconnect(&mut connections, profile_id)?; }
    let result = action(connections.get_mut(profile_id).ok_or("データベースへ再接続できません")?);
    if result.as_ref().err().is_some_and(|message| connection_error(message)) {
        reconnect(&mut connections, profile_id)?;
        return action(connections.get_mut(profile_id).ok_or("データベースへ再接続できません")?);
    }
    result
}

fn with_connection_once<T>(state: &AppState, profile_id: &str, action: impl FnOnce(&mut ConnectedDb) -> Result<T, String>) -> Result<T, String> {
    let mut connections = state.connections.lock().map_err(|_| "接続状態をロックできません")?;
    let closed = connections.get(profile_id).ok_or("データベースへ接続してください")?.client.is_closed();
    if closed { reconnect(&mut connections, profile_id)?; }
    action(connections.get_mut(profile_id).ok_or("データベースへ再接続できません")?)
}

blocking_command! {
fn list_schemas(state: tauri::State<AppState>, profile_id: String) -> Result<Vec<SchemaInfo>, String> {
    with_connection(&state, &profile_id, |db| db::schemas(&mut db.client))
}
}

blocking_command! {
fn list_tables(state: tauri::State<AppState>, profile_id: String, schema: String) -> Result<Vec<TableInfo>, String> {
    with_connection(&state, &profile_id, |db| db::tables(&mut db.client, &schema))
}
}

blocking_command! {
fn list_functions(state: tauri::State<AppState>, profile_id: String, schema: String) -> Result<Vec<FunctionInfo>, String> {
    with_connection(&state, &profile_id, |db| db::functions(&mut db.client, &schema))
}
}

blocking_command! {
fn get_function_ddl(state: tauri::State<AppState>, profile_id: String, schema: String, name: String, arguments: String) -> Result<String, String> {
    with_connection(&state, &profile_id, |db| db::function_ddl(&mut db.client, &schema, &name, &arguments))
}
}

blocking_command! {
fn get_columns(state: tauri::State<AppState>, profile_id: String, schema: String, table: String) -> Result<Vec<ColumnInfo>, String> {
    with_connection(&state, &profile_id, |db| db::columns(&mut db.client, &schema, &table))
}
}

blocking_command! {
fn get_table_ddl(state: tauri::State<AppState>, profile_id: String, schema: String, table: String) -> Result<String, String> {
    with_connection(&state, &profile_id, |db| db::table_ddl(&mut db.client, &schema, &table))
}
}

blocking_command! {
fn query_table(state: tauri::State<AppState>, profile_id: String, schema: String, table: String, filter: FilterNode, sorts: Vec<SortRule>, offset: u32) -> Result<QueryPage, String> {
    with_connection(&state, &profile_id, |db| db::query_table(&mut db.client, &schema, &table, &filter, &sorts, offset))
}
}

blocking_command! {
fn apply_table_changes(state: tauri::State<AppState>, profile_id: String, schema: String, table: String, changes: TableChanges) -> Result<TableChangeResult, String> {
    with_connection_once(&state, &profile_id, |db| db::apply_table_changes(&mut db.client, &schema, &table, changes, db.read_only))
}
}

blocking_command! {
fn execute_sql(state: tauri::State<AppState>, profile_id: String, sql: String) -> Result<QueryPage, String> {
    let mut connections = state.connections.lock().map_err(|_| "接続状態をロックできません")?;
    let closed = connections.get(&profile_id).ok_or("データベースへ接続してください")?.client.is_closed();
    if closed { reconnect(&mut connections, &profile_id)?; }
    let database = connections.get_mut(&profile_id).ok_or("データベースへ再接続できません")?;
    state.query_cancellations.lock().map_err(|_| "キャンセル状態をロックできません")?.insert(profile_id.clone(), database.cancel_request());
    let result = db::execute_sql(&mut database.client, &sql, database.read_only);
    state.query_cancellations.lock().map_err(|_| "キャンセル状態をロックできません")?.remove(&profile_id);
    result
}
}

blocking_command! {
fn cancel_sql(state: tauri::State<AppState>, profile_id: String) -> Result<(), String> {
    let cancellation = state.query_cancellations.lock().map_err(|_| "キャンセル状態をロックできません")?.get(&profile_id).cloned().ok_or("実行中のSQLはありません")?;
    cancellation.cancel()
}
}

blocking_command! {
fn keep_connection_alive(state: tauri::State<AppState>, profile_id: String) -> Result<(), String> {
    with_connection(&state, &profile_id, |db| db.client.simple_query("SELECT 1").map(|_| ()).map_err(|error| error.to_string()))
}
}

#[tauri::command]
async fn export_results(file_name: String, format: String, contents: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let downloads = directories::UserDirs::new().and_then(|dirs| dirs.download_dir().map(std::path::Path::to_path_buf)).ok_or("ダウンロードフォルダを取得できません")?;
        let path = save_export(&downloads, &file_name, &format, &contents)?;
        Ok(path.to_string_lossy().into_owned())
    }).await.map_err(|error| format!("保存処理に失敗しました: {error}"))?
}


fn save_export(directory: &std::path::Path, file_name: &str, format: &str, contents: &str) -> Result<std::path::PathBuf, String> {
    use std::{fs::OpenOptions, io::{ErrorKind, Write}, path::Path};
    if !matches!(format, "csv" | "json") { return Err("未対応のエクスポート形式です".into()); }
    let name = Path::new(file_name);
    if name.file_name().and_then(|v| v.to_str()) != Some(file_name)
        || name.extension().and_then(|v| v.to_str()) != Some(format) {
        return Err("保存ファイル名または拡張子が不正です".into());
    }
    let stem = name.file_stem().and_then(|v| v.to_str()).ok_or("保存ファイル名が不正です")?;
    for index in 0..10_000 {
        let path = directory.join(if index == 0 { file_name.to_owned() } else { format!("{stem} ({index}).{format}") });
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(mut file) => {
                if format == "csv" { file.write_all("\u{feff}".as_bytes()).map_err(|e| e.to_string())?; }
                file.write_all(contents.as_bytes()).map_err(|e| format!("エクスポートに失敗しました: {e}"))?;
                return Ok(path);
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("エクスポートに失敗しました: {error}")),
        }
    }
    Err("保存ファイル名を決定できません".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![list_profiles, save_profile, delete_profile, test_connection, connect_profile, disconnect_profile, list_schemas, list_tables, list_functions, get_columns, get_table_ddl, get_function_ddl, query_table, apply_table_changes, execute_sql, cancel_sql, keep_connection_alive, export_results])
        .run(tauri::generate_context!())
        .expect("failed to run My Postico");
}

#[cfg(test)]
mod tests {
    use super::connection_error;

    #[test]
    fn export_rejects_paths_and_wrong_extensions() {
        for name in ["../x.json", "/tmp/x.json", "x.html", ".", ".."] {
            assert!(super::save_export(std::path::Path::new("/does-not-exist"), name, "json", "{}").is_err());
        }
    }

    #[test]
    fn export_preserves_existing_files_and_symlink_targets() {
        let dir = std::env::temp_dir().join(format!("my-postico-export-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let first = super::save_export(&dir, "result.json", "json", "original").unwrap();
        let second = super::save_export(&dir, "result.json", "json", "new").unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "original");
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&second).unwrap().permissions().mode() & 0o777, 0o600);
            std::os::unix::fs::symlink(&first, dir.join("link.json")).unwrap();
            let output = super::save_export(&dir, "link.json", "json", "replacement").unwrap();
            assert_ne!(output, dir.join("link.json"));
            assert_eq!(std::fs::read_to_string(&first).unwrap(), "original");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn detects_transport_disconnect_messages() {
        for message in ["connection closed", "Broken pipe", "Connection reset by peer", "unexpected EOF"] {
            assert!(connection_error(message), "{message}");
        }
        assert!(!connection_error("syntax error at or near SELECT"));
    }
}
