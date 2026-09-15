mod db;
mod filters;
mod models;
mod ssh;
mod store;

use db::ConnectedDb;
use models::{ColumnInfo, ConnectionProfile, FilterNode, ProfileSecrets, QueryPage, SchemaInfo, SortRule, TableInfo, TableRowUpdate};
use std::{collections::HashMap, sync::Mutex};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![list_profiles, save_profile, delete_profile, test_connection, connect_profile, disconnect_profile, list_schemas, list_tables, get_columns, query_table, apply_table_updates, execute_sql])
        .run(tauri::generate_context!())
        .expect("failed to run My Postico");
}
