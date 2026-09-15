mod db;
mod filters;
mod models;
mod ssh;
mod store;

use db::ConnectedDb;
use models::{ColumnInfo, ConnectionProfile, FilterNode, ProfileSecrets, QueryPage, SchemaInfo, SortRule, TableInfo, TableRowUpdate};
use std::{collections::HashMap, sync::Mutex};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct AppState {
    connections: Mutex<HashMap<String, ConnectedDb>>,
}

#[tauri::command]
fn list_profiles() -> Result<Vec<ConnectionProfile>, String> { store::list_profiles() }

#[tauri::command]
fn save_profile(profile: ConnectionProfile, secrets: ProfileSecrets) -> Result<(), String> { store::save_profile(profile, secrets) }

#[tauri::command]
fn delete_profile(state: tauri::State<AppState>, id: String) -> Result<(), String> {
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
    state.connections.lock().map_err(|_| "接続状態をロックできません")?.remove(&id);
    Ok(())
}

fn with_connection<T>(state: &tauri::State<AppState>, profile_id: &str, action: impl FnOnce(&mut ConnectedDb) -> Result<T, String>) -> Result<T, String> {
    let mut connections = state.connections.lock().map_err(|_| "接続状態をロックできません")?;
    let connection = connections.get_mut(profile_id).ok_or("データベースへ接続してください")?;
    action(connection)
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
fn get_columns(state: tauri::State<AppState>, profile_id: String, schema: String, table: String) -> Result<Vec<ColumnInfo>, String> {
    with_connection(&state, &profile_id, |db| db::columns(&mut db.client, &schema, &table))
}

#[tauri::command]
fn query_table(state: tauri::State<AppState>, profile_id: String, schema: String, table: String, filter: FilterNode, sorts: Vec<SortRule>, offset: u32) -> Result<QueryPage, String> {
    with_connection(&state, &profile_id, |db| db::query_table(&mut db.client, &schema, &table, &filter, &sorts, offset))
}

#[tauri::command]
fn apply_table_updates(state: tauri::State<AppState>, profile_id: String, schema: String, table: String, updates: Vec<TableRowUpdate>) -> Result<u64, String> {
    with_connection(&state, &profile_id, |db| db::apply_table_updates(&mut db.client, &schema, &table, updates, db.read_only))
}

#[tauri::command]
fn execute_sql(state: tauri::State<AppState>, profile_id: String, sql: String) -> Result<QueryPage, String> {
    with_connection(&state, &profile_id, |db| db::execute_sql(&mut db.client, &sql, db.read_only))
}

#[tauri::command]
async fn export_results(app: tauri::AppHandle, file_name: String, format: String, contents: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
        let extension = match format.as_str() { "csv" => "csv", "json" => "json", _ => return Err("未対応のエクスポート形式です".into()) };
        let safe_name = std::path::Path::new(&file_name).file_name().and_then(|name| name.to_str()).ok_or("保存ファイル名が不正です")?;
        let Some(file_path) = app.dialog().file().set_title("結果をエクスポート").set_file_name(safe_name).add_filter(extension.to_uppercase(), &[extension]).blocking_save_file() else { return Ok(None); };
        let path = file_path.into_path().map_err(|error| format!("保存先を取得できません: {error}"))?;
        let output = if format == "csv" { format!("\u{feff}{contents}") } else { contents };
        std::fs::write(&path, output).map_err(|error| format!("エクスポートに失敗しました: {error}"))?;
        Ok(Some(path.to_string_lossy().into_owned()))
    }).await.map_err(|error| format!("保存処理に失敗しました: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![list_profiles, save_profile, delete_profile, test_connection, connect_profile, disconnect_profile, list_schemas, list_tables, get_columns, query_table, apply_table_updates, execute_sql, export_results])
        .run(tauri::generate_context!())
        .expect("failed to run My Postico");
}
