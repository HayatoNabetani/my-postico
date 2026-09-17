mod db;
mod filters;
mod models;
mod ssh;
mod store;

use db::ConnectedDb;
use models::{ColumnInfo, ConnectionProfile, FilterNode, FunctionInfo, ProfileSecrets, QueryPage, SchemaInfo, SortRule, TableChangeResult, TableChanges, TableInfo};
use std::{collections::HashMap, sync::Mutex};

#[derive(Default)]
struct AppState {
    connections: Mutex<HashMap<String, ConnectedDb>>,
    query_cancellations: Mutex<HashMap<String, db::QueryCancel>>,
}

#[tauri::command]
fn list_profiles() -> Result<Vec<ConnectionProfile>, String> { store::list_profiles() }

#[tauri::command]
fn save_profile(profile: ConnectionProfile, secrets: ProfileSecrets) -> Result<(), String> { store::save_profile(profile, secrets) }

#[tauri::command]
fn delete_profile(state: tauri::State<AppState>, id: String) -> Result<(), String> {
    state.query_cancellations.lock().map_err(|_| "キャンセル状態をロックできません")?.remove(&id);
    state.connections.lock().map_err(|_| "接続状態をロックできません")?.remove(&id);
    store::delete_profile(&id)
}

#[tauri::command]
fn test_connection(id: String) -> Result<String, String> {
    let profile = store::find_profile(&id)?;
    let _connection = db::connect(&profile)?;
    Ok("接続に成功しました".into())
}

#[tauri::command]
fn connect_profile(state: tauri::State<AppState>, id: String) -> Result<(), String> {
    let profile = store::find_profile(&id)?;
    let connection = db::connect(&profile)?;
    state.connections.lock().map_err(|_| "接続状態をロックできません")?.insert(id, connection);
    Ok(())
}

#[tauri::command]
fn disconnect_profile(state: tauri::State<AppState>, id: String) -> Result<(), String> {
    state.query_cancellations.lock().map_err(|_| "キャンセル状態をロックできません")?.remove(&id);
    state.connections.lock().map_err(|_| "接続状態をロックできません")?.remove(&id);
    Ok(())
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

fn with_connection<T>(state: &tauri::State<AppState>, profile_id: &str, mut action: impl FnMut(&mut ConnectedDb) -> Result<T, String>) -> Result<T, String> {
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

fn with_connection_once<T>(state: &tauri::State<AppState>, profile_id: &str, action: impl FnOnce(&mut ConnectedDb) -> Result<T, String>) -> Result<T, String> {
    let mut connections = state.connections.lock().map_err(|_| "接続状態をロックできません")?;
    let closed = connections.get(profile_id).ok_or("データベースへ接続してください")?.client.is_closed();
    if closed { reconnect(&mut connections, profile_id)?; }
    action(connections.get_mut(profile_id).ok_or("データベースへ再接続できません")?)
}

#[tauri::command]
fn list_schemas(state: tauri::State<AppState>, profile_id: String) -> Result<Vec<SchemaInfo>, String> {
    with_connection(&state, &profile_id, |db| db::schemas(&mut db.client))
}

#[tauri::command]
fn list_tables(state: tauri::State<AppState>, profile_id: String, schema: String) -> Result<Vec<TableInfo>, String> {
    with_connection(&state, &profile_id, |db| db::tables(&mut db.client, &schema))
}

#[tauri::command]
fn list_functions(state: tauri::State<AppState>, profile_id: String, schema: String) -> Result<Vec<FunctionInfo>, String> {
    with_connection(&state, &profile_id, |db| db::functions(&mut db.client, &schema))
}

#[tauri::command]
fn get_function_ddl(state: tauri::State<AppState>, profile_id: String, schema: String, name: String, arguments: String) -> Result<String, String> {
    with_connection(&state, &profile_id, |db| db::function_ddl(&mut db.client, &schema, &name, &arguments))
}

#[tauri::command]
fn get_columns(state: tauri::State<AppState>, profile_id: String, schema: String, table: String) -> Result<Vec<ColumnInfo>, String> {
    with_connection(&state, &profile_id, |db| db::columns(&mut db.client, &schema, &table))
}

#[tauri::command]
fn get_table_ddl(state: tauri::State<AppState>, profile_id: String, schema: String, table: String) -> Result<String, String> {
    with_connection(&state, &profile_id, |db| db::table_ddl(&mut db.client, &schema, &table))
}

#[tauri::command]
fn query_table(state: tauri::State<AppState>, profile_id: String, schema: String, table: String, filter: FilterNode, sorts: Vec<SortRule>, offset: u32) -> Result<QueryPage, String> {
    with_connection(&state, &profile_id, |db| db::query_table(&mut db.client, &schema, &table, &filter, &sorts, offset))
}

#[tauri::command]
fn apply_table_changes(state: tauri::State<AppState>, profile_id: String, schema: String, table: String, changes: TableChanges) -> Result<TableChangeResult, String> {
    with_connection_once(&state, &profile_id, |db| db::apply_table_changes(&mut db.client, &schema, &table, changes, db.read_only))
}

#[tauri::command]
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

#[tauri::command]
fn cancel_sql(state: tauri::State<AppState>, profile_id: String) -> Result<(), String> {
    let cancellation = state.query_cancellations.lock().map_err(|_| "キャンセル状態をロックできません")?.get(&profile_id).cloned().ok_or("実行中のSQLはありません")?;
    cancellation.cancel()
}

#[tauri::command]
fn keep_connection_alive(state: tauri::State<AppState>, profile_id: String) -> Result<(), String> {
    with_connection(&state, &profile_id, |db| db.client.simple_query("SELECT 1").map(|_| ()).map_err(|error| error.to_string()))
}

#[tauri::command]
async fn export_results(file_name: String, format: String, contents: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        if !matches!(format.as_str(), "csv" | "json") { return Err("未対応のエクスポート形式です".into()); }
        let safe_name = std::path::Path::new(&file_name).file_name().and_then(|name| name.to_str()).ok_or("保存ファイル名が不正です")?;
        let downloads = directories::UserDirs::new().and_then(|dirs| dirs.download_dir().map(std::path::Path::to_path_buf)).ok_or("ダウンロードフォルダを取得できません")?;
        let requested = downloads.join(safe_name);
        let path = if !requested.exists() { requested } else {
            let stem = requested.file_stem().and_then(|value| value.to_str()).unwrap_or("query-results");
            let extension = requested.extension().and_then(|value| value.to_str()).unwrap_or(&format);
            (1..10_000).map(|index| downloads.join(format!("{stem} ({index}).{extension}"))).find(|candidate| !candidate.exists()).ok_or("保存ファイル名を決定できません")?
        };
        let output = if format == "csv" { format!("\u{feff}{contents}") } else { contents };
        std::fs::write(&path, output).map_err(|error| format!("エクスポートに失敗しました: {error}"))?;
        Ok(path.to_string_lossy().into_owned())
    }).await.map_err(|error| format!("保存処理に失敗しました: {error}"))?
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
    fn detects_transport_disconnect_messages() {
        for message in ["connection closed", "Broken pipe", "Connection reset by peer", "unexpected EOF"] {
            assert!(connection_error(message), "{message}");
        }
        assert!(!connection_error("syntax error at or near SELECT"));
    }
}
