import { invoke } from "@tauri-apps/api/core";
import type { ColumnInfo, ConnectionProfile, FilterGroup, ProfileSecrets, QueryPage, SavedFilter, SavedQuery, SchemaInfo, SortRule, TableChangeResult, TableChanges, TableInfo } from "../types";

const isTauri = () => "__TAURI_INTERNALS__" in window;

export async function listProfiles(): Promise<ConnectionProfile[]> {
  if (!isTauri()) return JSON.parse(localStorage.getItem("demo-profiles") ?? "[]");
  return invoke("list_profiles");
}

export async function saveProfile(profile: ConnectionProfile, secrets: ProfileSecrets): Promise<void> {
  if (!isTauri()) {
    const profiles = await listProfiles();
    const next = [...profiles.filter((item) => item.id !== profile.id), profile];
    localStorage.setItem("demo-profiles", JSON.stringify(next));
    return;
  }
  await invoke("save_profile", { profile, secrets });
}

export async function deleteProfile(id: string): Promise<void> {
  if (!isTauri()) {
    localStorage.setItem("demo-profiles", JSON.stringify((await listProfiles()).filter((item) => item.id !== id)));
    return;
  }
  await invoke("delete_profile", { id });
}

export const testConnection = (id: string) => invoke<string>("test_connection", { id });
export const connectProfile = (id: string) => invoke<void>("connect_profile", { id });
export const disconnectProfile = (id: string) => invoke<void>("disconnect_profile", { id });
export const listSchemas = (profileId: string) => invoke<SchemaInfo[]>("list_schemas", { profileId });
export const listTables = (profileId: string, schema: string) => invoke<TableInfo[]>("list_tables", { profileId, schema });
export const getColumns = (profileId: string, schema: string, table: string) => invoke<ColumnInfo[]>("get_columns", { profileId, schema, table });
export const queryTable = (profileId: string, schema: string, table: string, filter: FilterGroup, sorts: SortRule[], offset: number) =>
  invoke<QueryPage>("query_table", { profileId, schema, table, filter, sorts, offset });
export const applyTableChanges = (profileId: string, schema: string, table: string, changes: TableChanges) =>
  invoke<TableChangeResult>("apply_table_changes", { profileId, schema, table, changes });
export const executeSql = (profileId: string, sql: string) => invoke<QueryPage>("execute_sql", { profileId, sql });
export const exportResults = (fileName: string, format: "csv" | "json", contents: string) =>
  invoke<string | null>("export_results", { fileName, format, contents });

export function loadSavedFilters(): SavedFilter[] {
  return JSON.parse(localStorage.getItem("my-postico-filters") ?? "[]");
}

export function persistSavedFilters(filters: SavedFilter[]): void {
  localStorage.setItem("my-postico-filters", JSON.stringify(filters));
}

export function loadSavedQueries(): SavedQuery[] {
  return JSON.parse(localStorage.getItem("my-postico-queries") ?? "[]");
}

export function persistSavedQueries(queries: SavedQuery[]): void {
  localStorage.setItem("my-postico-queries", JSON.stringify(queries));
}
