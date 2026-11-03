import { invoke } from "@tauri-apps/api/core";
import type { SchemaDiagram } from "../types";
import type { DiagramFormat } from "./diagram";
import type { ColumnInfo, ConnectionProfile, FilterGroup, FunctionInfo, ProfileSecrets, QueryFolder, QueryPage, SavedFilter, SavedQuery, SchemaInfo, SortRule, TableChangeResult, TableChanges, TableInfo } from "../types";

const isTauri = () => "__TAURI_INTERNALS__" in window;

export async function listProfiles(): Promise<ConnectionProfile[]> {
  if (!isTauri()) return (JSON.parse(localStorage.getItem("demo-profiles") ?? "[]") as ConnectionProfile[]).map((profile) => ({...profile, engine: profile.engine ?? "postgres"}));
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
export const keepConnectionAlive = (profileId: string) => invoke<void>("keep_connection_alive", { profileId });
export const listSchemas = (profileId: string) => invoke<SchemaInfo[]>("list_schemas", { profileId });
export const listTables = (profileId: string, schema: string) => invoke<TableInfo[]>("list_tables", { profileId, schema });
export const listFunctions = (profileId: string, schema: string) => invoke<FunctionInfo[]>("list_functions", { profileId, schema });
export const getColumns = (profileId: string, schema: string, table: string) => invoke<ColumnInfo[]>("get_columns", { profileId, schema, table });
export const getSchemaDiagram = (profileId: string, schema: string) => invoke<SchemaDiagram>("get_schema_diagram", {profileId, schema});

export async function exportDiagram(fileName: string, format: DiagramFormat, contents: string): Promise<string> {
  if (isTauri()) return invoke<string>("export_diagram", {fileName, format, contents});
  const mime = {png: "image/png", svg: "image/svg+xml", mmd: "text/plain", drawio: "application/xml"}[format];
  const anchor = document.createElement("a");
  anchor.href = `data:${mime};${format === "png" ? "base64," + contents : "charset=utf-8," + encodeURIComponent(contents)}`;
  anchor.download = fileName; anchor.click();
  return fileName;
}
export const getTableDdl = (profileId: string, schema: string, table: string) => invoke<string>("get_table_ddl", { profileId, schema, table });
export const getFunctionDdl = (profileId: string, schema: string, name: string, identityArguments: string) => invoke<string>("get_function_ddl", { profileId, schema, name, arguments: identityArguments });
export const queryTable = (profileId: string, schema: string, table: string, filter: FilterGroup, sorts: SortRule[], offset: number) =>
  invoke<QueryPage>("query_table", { profileId, schema, table, filter, sorts, offset });
export const applyTableChanges = (profileId: string, schema: string, table: string, changes: TableChanges) =>
  invoke<TableChangeResult>("apply_table_changes", { profileId, schema, table, changes });
export const executeSql = (profileId: string, sql: string) => invoke<QueryPage>("execute_sql", { profileId, sql });
export const cancelSql = (profileId: string) => invoke<void>("cancel_sql", { profileId });
export async function exportResults(fileName: string, format: "csv" | "json", contents: string): Promise<string | null> {
  if (isTauri()) return invoke<string>("export_results", {fileName, format, contents});
  const blob = new Blob([format === "csv" ? `\ufeff${contents}` : contents], {type: format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = fileName; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return fileName;
}

export function loadSavedFilters(): SavedFilter[] {
  return JSON.parse(localStorage.getItem("my-postico-filters") ?? "[]");
}

export function persistSavedFilters(filters: SavedFilter[]): void {
  localStorage.setItem("my-postico-filters", JSON.stringify(filters));
}

export function loadSavedQueries(): SavedQuery[] {
  try {
    const queries = JSON.parse(localStorage.getItem("my-postico-queries") ?? "[]") as Array<Partial<SavedQuery>>;
    return queries.filter((query) => Boolean(query.id && query.name && typeof query.sql === "string" && query.updatedAt))
      .map((query) => ({id: query.id!, profileId: query.profileId ?? "", folderId: query.folderId, name: query.name!, sql: query.sql!, updatedAt: query.updatedAt!}));
  } catch {
    return [];
  }
}

export function persistSavedQueries(queries: SavedQuery[]): void {
  localStorage.setItem("my-postico-queries", JSON.stringify(queries));
}

export function loadQueryFolders(): QueryFolder[] {
  try {
    const folders = JSON.parse(localStorage.getItem("my-postico-query-folders") ?? "[]") as Array<Partial<QueryFolder>>;
    return folders.filter((folder) => Boolean(folder.id && folder.profileId && folder.name))
      .map((folder) => ({id: folder.id!, profileId: folder.profileId!, name: folder.name!}));
  } catch {
    return [];
  }
}

export function persistQueryFolders(folders: QueryFolder[]): void {
  localStorage.setItem("my-postico-query-folders", JSON.stringify(folders));
}
