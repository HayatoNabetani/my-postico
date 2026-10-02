import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Circle, Clock3, Copy, Database, FileCode2, FilePlus2, Folder, FolderPlus, LoaderCircle, PanelLeftClose, PanelLeftOpen, Pencil, Play, Plus, RefreshCw, Search, Server, Shield, Square, Table2, Trash2, Unplug, Upload, X } from "lucide-react";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { DataGrid } from "./components/DataGrid";
import { emptyFilter, FilterBuilder, newCondition } from "./components/FilterBuilder";
import { SqlEditor, type SqlCompletionItem, type SqlEditorHandle, type SqlSelection } from "./components/SqlEditor";
import * as api from "./lib/api";
import { exportFileName, serializeQueryPage, type ExportFormat } from "./lib/export";
import { statementForExecution } from "./lib/sql";
import type { ColumnInfo, ConnectionProfile, FilterGroup, ForeignKeyInfo, FunctionInfo, PendingTableRow, ProfileSecrets, QueryFolder, QueryPage, SavedFilter, SavedQuery, SchemaInfo, SortRule, TableChanges, TableInfo } from "./types";

type DialogState = { open: false } | { open: true; profile?: ConnectionProfile };
type PendingHostKey = { profile: ConnectionProfile; fingerprint: string };
type QueryContextMenu = {x: number; y: number; folderId?: string; queryId?: string};
type TableContextMenu = {x: number; y: number; table?: TableInfo; schema?: string};
type ObjectBrowserMode = "tables" | "functions";
type TextDialogState =
  | {kind: "createFolder"; title: string; label: string; value: string}
  | {kind: "renameFolder"; title: string; label: string; value: string; folderId: string}
  | {kind: "renameQuery"; title: string; label: string; value: string; queryId: string};

interface TableTab {
  id: string;
  table: TableInfo;
  columns: ColumnInfo[];
  page?: QueryPage;
  offset: number;
  filter: FilterGroup;
  appliedFilter: FilterGroup;
  sorts: SortRule[];
  drafts: Record<string, string>;
  inserts: PendingTableRow[];
  deletedRows: number[];
  view: "content" | "structure" | "ddl";
  ddl?: string;
}

interface SqlTab {
  id: string;
  title: string;
  sql: string;
  page?: QueryPage;
  savedQueryId: string;
  folderId: string;
  running?: boolean;
  cancelRequested?: boolean;
  executionStartedAt?: number;
  executionDurationMs?: number;
}

interface ConnectionWorkspace {
  schemas: SchemaInfo[];
  tables: Record<string, TableInfo[]>;
  functions: Record<string, FunctionInfo[]>;
  tableTabs: TableTab[];
  activeTableTabId?: string;
  sqlTabs: SqlTab[];
  activeSqlTabId: string;
  sqlOpen: boolean;
  objectSearch: string;
  querySearch: string;
  collapsedQueryFolders: Record<string, boolean>;
  collapsedSchemas: Record<string, boolean>;
  objectBrowserMode: ObjectBrowserMode;
}

const DEFAULT_CONNECTION_WIDTH = 230;
const DEFAULT_OBJECT_WIDTH = 230;
const DEFAULT_SQL_EDITOR_HEIGHT = 180;
const DEFAULT_QUERY_PANE_HEIGHT = 260;
const DEFAULT_SQL = "select now() as server_time;";
const FUNCTION_RENDER_BATCH = 120;
const SQL_KEYWORDS = ["SELECT", "FROM", "WHERE", "JOIN", "LEFT JOIN", "INNER JOIN", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "INSERT INTO", "UPDATE", "DELETE FROM", "WITH", "AS", "AND", "OR", "NOT", "NULL", "IS NULL", "IN", "BETWEEN", "DISTINCT", "UNION ALL", "CASE", "WHEN", "THEN", "ELSE", "END"];
const SQL_BUILTIN_FUNCTIONS = ["COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE", "NULLIF", "NOW", "DATE_TRUNC", "EXTRACT", "STRING_AGG", "ARRAY_AGG", "JSONB_BUILD_OBJECT"];

function newSqlTab(index: number): SqlTab {
  return {id: crypto.randomUUID(), title: index === 1 ? "SQL Query" : `SQL Query ${index}`, sql: index === 1 ? DEFAULT_SQL : "", savedQueryId: "", folderId: ""};
}

function savedSize(key: string, fallback: number) {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function formatDuration(milliseconds: number) {
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))} ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 2 : 1)} 秒`;
}

function hasPendingChanges(tab: TableTab) {
  return Object.keys(tab.drafts).length > 0 || tab.inserts.length > 0 || tab.deletedRows.length > 0;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let value = ""; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { value += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { row.push(value); value = ""; }
    else if (character === "\n") { row.push(value.replace(/\r$/, "")); rows.push(row); row = []; value = ""; }
    else value += character;
  }
  if (value || row.length > 0) { row.push(value.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

export default function App() {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [active, setActive] = useState<ConnectionProfile>();
  const [connected, setConnected] = useState(false);
  const [schemas, setSchemas] = useState<SchemaInfo[]>([]);
  const [tables, setTables] = useState<Record<string, TableInfo[]>>({});
  const [functions, setFunctions] = useState<Record<string, FunctionInfo[]>>({});
  const [tableTabs, setTableTabs] = useState<TableTab[]>([]);
  const [activeTableTabId, setActiveTableTabId] = useState<string>();
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>(api.loadSavedFilters());
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>(api.loadSavedQueries());
  const [queryFolders, setQueryFolders] = useState<QueryFolder[]>(api.loadQueryFolders());
  const [sqlTabs, setSqlTabs] = useState<SqlTab[]>(() => [newSqlTab(1)]);
  const [activeSqlTabId, setActiveSqlTabId] = useState(() => "");
  const [queryContextMenu, setQueryContextMenu] = useState<QueryContextMenu>();
  const [tableContextMenu, setTableContextMenu] = useState<TableContextMenu>();
  const [objectBrowserMode, setObjectBrowserMode] = useState<ObjectBrowserMode>("tables");
  const [collapsedQueryFolders, setCollapsedQueryFolders] = useState<Record<string, boolean>>({});
  const [collapsedSchemas, setCollapsedSchemas] = useState<Record<string, boolean>>({});
  const [dialog, setDialog] = useState<DialogState>({ open: false });
  const [connectionPickerOpen, setConnectionPickerOpen] = useState(false);
  const [connectionHomeActive, setConnectionHomeActive] = useState(false);
  const [openConnectionIds, setOpenConnectionIds] = useState<string[]>([]);
  const connectionWorkspaces = useRef<Record<string, ConnectionWorkspace>>({});
  const [newConnectionFocusRequest, setNewConnectionFocusRequest] = useState(0);
  const [executionClock, setExecutionClock] = useState(() => Date.now());
  const [textDialog, setTextDialog] = useState<TextDialogState>();
  const [pendingHostKey, setPendingHostKey] = useState<PendingHostKey>();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("接続を選択してください");
  const [error, setError] = useState("");
  const [sqlOpen, setSqlOpen] = useState(false);
  const sqlEditorRef = useRef<SqlEditorHandle>(null);
  const [sqlSelection, setSqlSelection] = useState<SqlSelection>();
  const sqlColumnCache = useRef<Record<string, Promise<ColumnInfo[]>>>({});
  const cancelledSqlTabs = useRef(new Set<string>());
  const csvInputRef = useRef<HTMLInputElement>(null);
  const [csvImportTable, setCsvImportTable] = useState<TableInfo>();
  const [objectSearch, setObjectSearch] = useState("");
  const [functionRenderLimits, setFunctionRenderLimits] = useState<Record<string, number>>({});
  const [querySearch, setQuerySearch] = useState("");
  const objectSearchRef = useRef<HTMLInputElement>(null);
  const [filterFocusRequest, setFilterFocusRequest] = useState(0);
  const [connectionWidth, setConnectionWidth] = useState(() => savedSize("my-postico:connection-width", DEFAULT_CONNECTION_WIDTH));
  const [objectWidth, setObjectWidth] = useState(() => savedSize("my-postico:object-width", DEFAULT_OBJECT_WIDTH));
  const [sqlEditorHeight, setSqlEditorHeight] = useState(() => savedSize("my-postico:sql-editor-height", DEFAULT_SQL_EDITOR_HEIGHT));
  const [queryPaneHeight, setQueryPaneHeight] = useState(() => savedSize("my-postico:query-pane-height", DEFAULT_QUERY_PANE_HEIGHT));
  const [connectionSidebarCollapsed, setConnectionSidebarCollapsed] = useState(() => localStorage.getItem("my-postico:connection-sidebar-collapsed") === "true");
  const [objectSidebarCollapsed, setObjectSidebarCollapsed] = useState(() => localStorage.getItem("my-postico:object-sidebar-collapsed") === "true");

  const activeTab = tableTabs.find((tab) => tab.id === activeTableTabId);
  const activeSqlTab = sqlTabs.find((tab) => tab.id === activeSqlTabId) ?? sqlTabs[0];
  const runningSqlTab = sqlTabs.find((tab) => tab.running);
  const sql = activeSqlTab?.sql ?? "";
  const sqlPage = activeSqlTab?.page;
  const selectedQueryId = activeSqlTab?.savedQueryId ?? "";
  const selectedQueryFolderId = activeSqlTab?.folderId ?? "";
  const selectedTable = activeTab?.table;
  const tableSavedFilters = useMemo(() => selectedTable ? savedFilters.filter((item) => item.profileId === active?.id && item.schema === selectedTable.schema && item.table === selectedTable.name) : [], [savedFilters, selectedTable, active]);
  const connectionQueries = useMemo(() => savedQueries.filter((item) => item.profileId === active?.id), [savedQueries, active]);
  const connectionQueryFolders = useMemo(() => queryFolders.filter((item) => item.profileId === active?.id).sort((a, b) => a.name.localeCompare(b.name, "ja")), [queryFolders, active]);
  const unfiledQueries = useMemo(() => connectionQueries.filter((query) => !query.folderId || !connectionQueryFolders.some((folder) => folder.id === query.folderId)).sort((a, b) => a.name.localeCompare(b.name, "ja")), [connectionQueries, connectionQueryFolders]);
  const normalizedQuerySearch = querySearch.trim().toLocaleLowerCase();
  const visibleUnfiledQueries = useMemo(() => unfiledQueries.filter((query) => !normalizedQuerySearch || query.name.toLocaleLowerCase().includes(normalizedQuerySearch)), [unfiledQueries, normalizedQuerySearch]);
  const openConnectionProfiles = useMemo(() => openConnectionIds.map((id) => profiles.find((profile) => profile.id === id)).filter((profile): profile is ConnectionProfile => Boolean(profile)), [openConnectionIds, profiles]);
  const sqlCatalogCompletions = useMemo(() => {
    const options: SqlCompletionItem[] = [];
    for (const schema of schemas) options.push({label: schema.name, type: "class", detail: "スキーマ", boost: 20});
    for (const [schema, schemaTables] of Object.entries(tables)) for (const table of schemaTables) options.push({label: table.name, type: "class", detail: `${schema} · ${table.kind === "view" ? "ビュー" : "テーブル"}`, boost: 50});
    for (const [schema, schemaFunctions] of Object.entries(functions)) for (const item of schemaFunctions) options.push({label: item.name, type: "function", detail: `${schema} · ${item.arguments || "引数なし"}`, apply: `${item.name}()`, boost: 45});
    for (const keyword of SQL_KEYWORDS) options.push({label: keyword, type: "keyword"});
    for (const fn of SQL_BUILTIN_FUNCTIONS) options.push({label: fn, type: "function", apply: `${fn}()`});
    return options;
  }, [schemas, tables, functions]);

  useEffect(() => { api.listProfiles().then(setProfiles).catch((reason) => setError(String(reason))); }, []);
  useEffect(() => { localStorage.setItem("my-postico:connection-width", String(connectionWidth)); }, [connectionWidth]);
  useEffect(() => { localStorage.setItem("my-postico:object-width", String(objectWidth)); }, [objectWidth]);
  useEffect(() => { localStorage.setItem("my-postico:sql-editor-height", String(sqlEditorHeight)); }, [sqlEditorHeight]);
  useEffect(() => { localStorage.setItem("my-postico:query-pane-height", String(queryPaneHeight)); }, [queryPaneHeight]);
  useEffect(() => { localStorage.setItem("my-postico:connection-sidebar-collapsed", String(connectionSidebarCollapsed)); }, [connectionSidebarCollapsed]);
  useEffect(() => { localStorage.setItem("my-postico:object-sidebar-collapsed", String(objectSidebarCollapsed)); }, [objectSidebarCollapsed]);
  useEffect(() => { sqlColumnCache.current = {}; }, [active?.id]);
  useEffect(() => { setFunctionRenderLimits({}); }, [active?.id]);
  useEffect(() => { setSqlSelection(undefined); }, [activeSqlTab?.id]);
  useEffect(() => {
    if (!runningSqlTab) return;
    setExecutionClock(Date.now());
    const timer = window.setInterval(() => setExecutionClock(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [runningSqlTab?.id]);
  useEffect(() => {
    if (!activeSqlTabId && sqlTabs[0]) setActiveSqlTabId(sqlTabs[0].id);
  }, [activeSqlTabId, sqlTabs]);
  useEffect(() => {
    if (!connected || !active) return;
    const keepAlive = async () => {
      try { await api.keepConnectionAlive(active.id); }
      catch (reason) { setConnected(false); setError(`接続を維持できませんでした: ${String(reason)}`); setStatus("再接続が必要です"); }
    };
    const timer = window.setInterval(() => void keepAlive(), 30_000);
    return () => window.clearInterval(timer);
  }, [connected, active]);
  useEffect(() => {
    const focusFilter = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f" || !activeTab || sqlOpen) return;
      event.preventDefault();
      setFilterFocusRequest((current) => current + 1);
    };
    window.addEventListener("keydown", focusFilter);
    return () => window.removeEventListener("keydown", focusFilter);
  }, [activeTab, sqlOpen]);
  useEffect(() => {
    const newQueryShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "n") return;
      event.preventDefault(); addSqlTab();
    };
    window.addEventListener("keydown", newQueryShortcut);
    return () => window.removeEventListener("keydown", newQueryShortcut);
  }, [sqlTabs.length]);
  useEffect(() => {
    const toggleSidebars = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "b" || event.isComposing) return;
      event.preventDefault();
      const shouldOpen = connectionSidebarCollapsed && objectSidebarCollapsed;
      setConnectionSidebarCollapsed(!shouldOpen);
      setObjectSidebarCollapsed(!shouldOpen);
    };
    window.addEventListener("keydown", toggleSidebars);
    return () => window.removeEventListener("keydown", toggleSidebars);
  }, [connectionSidebarCollapsed, objectSidebarCollapsed]);
  useEffect(() => {
    const connectionShortcuts = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.isComposing) return;
      if (dialog.open || textDialog || pendingHostKey) return;
      if (event.key.toLowerCase() === "p") {
        event.preventDefault();
        setConnectionPickerOpen(true);
        setConnectionHomeActive(true);
        setNewConnectionFocusRequest((current) => current + 1);
        return;
      }
      if (event.key.toLowerCase() === "t") {
        event.preventDefault();
        setConnectionPickerOpen(true);
        setConnectionHomeActive(true);
        return;
      }
      if (!/^[1-9]$/.test(event.key)) return;
      const profile = profiles[Number(event.key) - 1];
      if (!profile) return;
      event.preventDefault();
      setConnectionPickerOpen(false);
      setConnectionHomeActive(false);
      void connect(profile);
    };
    window.addEventListener("keydown", connectionShortcuts);
    return () => window.removeEventListener("keydown", connectionShortcuts);
  }, [profiles, connected, active, tableTabs, sqlTabs, savedQueries, openConnectionIds, loading, dialog.open, connectionPickerOpen, textDialog, pendingHostKey]);
  useEffect(() => {
    if (!queryContextMenu && !tableContextMenu) return;
    const close = () => { setQueryContextMenu(undefined); setTableContextMenu(undefined); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", close);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", closeOnEscape); window.removeEventListener("resize", close); };
  }, [queryContextMenu, tableContextMenu]);

  function currentWorkspace(): ConnectionWorkspace {
    return {schemas, tables, functions, tableTabs, activeTableTabId, sqlTabs, activeSqlTabId: activeSqlTab?.id ?? sqlTabs[0]?.id ?? "", sqlOpen, objectSearch, querySearch, collapsedQueryFolders, collapsedSchemas, objectBrowserMode};
  }

  function rememberActiveWorkspace() {
    if (active && connected) connectionWorkspaces.current[active.id] = currentWorkspace();
  }

  function freshWorkspace(): ConnectionWorkspace {
    const firstSqlTab = newSqlTab(1);
    return {schemas: [], tables: {}, functions: {}, tableTabs: [], activeTableTabId: undefined, sqlTabs: [firstSqlTab], activeSqlTabId: firstSqlTab.id, sqlOpen: true, objectSearch: "", querySearch: "", collapsedQueryFolders: {}, collapsedSchemas: {}, objectBrowserMode: "tables"};
  }

  function restoreWorkspace(workspace: ConnectionWorkspace) {
    setSchemas(workspace.schemas); setTables(workspace.tables); setFunctions(workspace.functions); setTableTabs(workspace.tableTabs); setActiveTableTabId(workspace.activeTableTabId);
    setSqlTabs(workspace.sqlTabs); setActiveSqlTabId(workspace.activeSqlTabId); setSqlOpen(workspace.sqlOpen);
    setObjectSearch(workspace.objectSearch); setQuerySearch(workspace.querySearch);
    setCollapsedQueryFolders(workspace.collapsedQueryFolders); setCollapsedSchemas(workspace.collapsedSchemas); setObjectBrowserMode(workspace.objectBrowserMode);
  }

  function patchTab(id: string, patch: Partial<TableTab>) {
    setTableTabs((current) => current.map((tab) => tab.id === id ? {...tab, ...patch} : tab));
  }

  function patchSqlTab(id: string, patch: Partial<SqlTab>) {
    setSqlTabs((current) => current.map((tab) => tab.id === id ? {...tab, ...patch} : tab));
  }

  function patchActiveSqlTab(patch: Partial<SqlTab>) {
    if (activeSqlTab) patchSqlTab(activeSqlTab.id, patch);
  }

  function setSql(value: string) {
    patchActiveSqlTab({sql: value});
    if (!activeSqlTab?.savedQueryId) return;
    const next = savedQueries.map((query) => query.id === activeSqlTab.savedQueryId ? {...query, sql: value, updatedAt: new Date().toISOString()} : query);
    setSavedQueries(next);
    api.persistSavedQueries(next);
  }
  function setSqlPage(page: QueryPage | undefined) { patchActiveSqlTab({page}); }

  function addSqlTab(folderId = "") {
    if (!active || !connected) { setError("SQLファイルを作成するにはデータベースへ接続してください"); return; }
    const targetFolderId = connectionQueryFolders.some((folder) => folder.id === folderId) ? folderId : "";
    const existingNames = new Set(connectionQueries.map((query) => query.name));
    let index = 1;
    let name = "SQL Query";
    while (existingNames.has(name)) { index += 1; name = `SQL Query ${index}`; }
    const query: SavedQuery = {id: crypto.randomUUID(), profileId: active.id, folderId: targetFolderId || undefined, name, sql: "", updatedAt: new Date().toISOString()};
    const nextQueries = [...savedQueries, query];
    const tab: SqlTab = {id: crypto.randomUUID(), title: name, sql: "", savedQueryId: query.id, folderId: targetFolderId};
    setSavedQueries(nextQueries); api.persistSavedQueries(nextQueries);
    setSqlTabs((current) => [...current, tab]); setActiveSqlTabId(tab.id); setSqlOpen(true); setConnectionHomeActive(false); setQueryContextMenu(undefined); setStatus(`${name} を作成しました`);
    requestAnimationFrame(() => sqlEditorRef.current?.focus());
  }

  function openQueryContextMenu(event: ReactMouseEvent, folderId?: string, queryId?: string) {
    event.preventDefault(); event.stopPropagation();
    setQueryContextMenu({x: Math.max(8, Math.min(event.clientX, window.innerWidth - 230)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 180)), folderId, queryId});
  }

  function openTableContextMenu(event: ReactMouseEvent, table?: TableInfo, schema?: string) {
    event.preventDefault(); event.stopPropagation();
    setTableContextMenu({x: Math.max(8, Math.min(event.clientX, window.innerWidth - 260)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 620)), table, schema: schema ?? table?.schema});
  }

  function quoteIdentifier(value: string) { return `"${value.replaceAll('"', '""')}"`; }
  function qualifiedName(table: TableInfo) { return `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`; }

  function openSqlTemplate(title: string, template: string) {
    if (!active || !connected) return;
    const existingNames = new Set(connectionQueries.map((query) => query.name));
    let name = title; let suffix = 2;
    while (existingNames.has(name)) { name = `${title} ${suffix}`; suffix += 1; }
    const query: SavedQuery = {id: crypto.randomUUID(), profileId: active.id, name, sql: template, updatedAt: new Date().toISOString()};
    const nextQueries = [...savedQueries, query];
    const tab: SqlTab = {id: crypto.randomUUID(), title: name, sql: template, savedQueryId: query.id, folderId: ""};
    setSavedQueries(nextQueries); api.persistSavedQueries(nextQueries); setSqlTabs((current) => [...current, tab]); setActiveSqlTabId(tab.id); setSqlOpen(true); setTableContextMenu(undefined);
    requestAnimationFrame(() => sqlEditorRef.current?.focus());
  }

  function createObjectTemplate(kind: "table" | "view" | "materialized_view" | "function" | "procedure" | "schema", schemaName?: string) {
    const schema = quoteIdentifier(schemaName || schemas.find((item) => item.name === "public")?.name || schemas[0]?.name || "public");
    const templates = {
      table: [`New Table`, `CREATE TABLE ${schema}."new_table" (\n  "id" bigserial PRIMARY KEY,\n  "created_at" timestamptz NOT NULL DEFAULT now()\n);`],
      view: [`New View`, `CREATE VIEW ${schema}."new_view" AS\nSELECT 1 AS "value";`],
      materialized_view: [`New Materialized View`, `CREATE MATERIALIZED VIEW ${schema}."new_materialized_view" AS\nSELECT 1 AS "value";`],
      function: [`New Function`, `CREATE FUNCTION ${schema}."new_function"()\nRETURNS void\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  -- 処理を記述\nEND;\n$$;`],
      procedure: [`New Procedure`, `CREATE PROCEDURE ${schema}."new_procedure"()\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  -- 処理を記述\nEND;\n$$;`],
      schema: [`New Schema`, `CREATE SCHEMA "new_schema";`],
    } satisfies Record<string, [string, string]>;
    openSqlTemplate(templates[kind][0], templates[kind][1]);
  }

  async function refreshObjectCatalog() {
    if (!active) return;
    const nextSchemas = await api.listSchemas(active.id);
    const entries = await Promise.all(nextSchemas.map(async (schema) => {
      const [schemaTables, schemaFunctions] = await Promise.all([api.listTables(active.id, schema.name), api.listFunctions(active.id, schema.name)]);
      return [schema.name, schemaTables, schemaFunctions] as const;
    }));
    setSchemas(nextSchemas); setTables(Object.fromEntries(entries.map(([name, items]) => [name, items]))); setFunctions(Object.fromEntries(entries.map(([name, , items]) => [name, items])));
  }

  async function openFunctionDefinition(item: FunctionInfo) {
    if (!active) return;
    setLoading(true); setError("");
    try { openSqlTemplate(`${item.name}()`, await api.getFunctionDdl(active.id, item.schema, item.name, item.arguments)); }
    catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  }

  async function openTableView(table: TableInfo, view: TableTab["view"]) {
    await openTable(table);
    const id = `${table.schema}.${table.name}`;
    patchTab(id, {view});
    if (view === "ddl" && active) {
      try { patchTab(id, {ddl: await api.getTableDdl(active.id, table.schema, table.name)}); }
      catch (reason) { setError(String(reason)); }
    }
    setTableContextMenu(undefined);
  }

  async function runTableMaintenance(table: TableInfo, action: "truncate" | "drop" | "refresh") {
    if (!active || active.readOnly) return;
    const qualified = qualifiedName(table);
    const label = action === "truncate" ? "全データを削除" : action === "drop" ? "テーブルを削除" : "マテリアライズドビューを更新";
    const warning = action === "refresh" ? `${qualified} のマテリアライズドビューを更新しますか？` : `${qualified} を${label}します。元に戻せません。続けますか？`;
    if (!confirm(warning)) return;
    const sql = action === "truncate" ? `TRUNCATE TABLE ${qualified}` : action === "refresh" ? `REFRESH MATERIALIZED VIEW ${qualified}` : `DROP ${table.kind === "view" ? "VIEW" : table.kind === "materialized_view" ? "MATERIALIZED VIEW" : "TABLE"} ${qualified}`;
    setLoading(true); setError(""); setTableContextMenu(undefined);
    try {
      await api.executeSql(active.id, sql);
      if (action === "drop") {
        const remaining = tableTabs.filter((tab) => tab.table.schema !== table.schema || tab.table.name !== table.name);
        setTableTabs(remaining);
        if (activeTab?.table.schema === table.schema && activeTab.table.name === table.name) { setActiveTableTabId(remaining[0]?.id); if (remaining.length === 0) setSqlOpen(true); }
      }
      await refreshObjectCatalog(); setStatus(`${label}しました`);
    } catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  }

  async function exportTable(table: TableInfo) {
    if (!active) return;
    setLoading(true); setTableContextMenu(undefined);
    try { const page = await api.queryTable(active.id, table.schema, table.name, emptyFilter(), [], 0); await exportPage(page, `${table.schema}.${table.name}`, "csv"); }
    catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  }

  async function importCsv(file: File) {
    const table = csvImportTable; setCsvImportTable(undefined); if (!active || !table) return;
    if (file.size > 10 * 1024 * 1024) { setError("CSVは10MB以下にしてください"); return; }
    try {
      const parsed = parseCsv((await file.text()).replace(/^\ufeff/, ""));
      const headers = parsed[0]?.map((header) => header.trim()).filter(Boolean) ?? [];
      const rows = parsed.slice(1).filter((row) => row.some((value) => value !== ""));
      if (headers.length === 0 || rows.length === 0) { setError("CSVにヘッダーとデータ行が必要です"); return; }
      if (rows.length > 20_000) { setError("一度にインポートできるのは20,000行までです"); return; }
      if (rows.some((row) => row.length !== headers.length)) { setError("CSVの列数がヘッダーと一致していません"); return; }
      if (!confirm(`${qualifiedName(table)} に ${rows.length.toLocaleString()} 行を追加します。続けますか？`)) return;
      if (active.environment.toLocaleLowerCase() === "production" && !confirm("Production接続へのCSVインポートです。本当に実行しますか？")) return;
      setLoading(true); setError("");
      const columns = headers.map(quoteIdentifier).join(", ");
      for (let offset = 0; offset < rows.length; offset += 200) {
        const values = rows.slice(offset, offset + 200).map((row) => `(${row.map((value) => value === "" ? "NULL" : `'${value.replaceAll("'", "''").replaceAll("\0", "")}'`).join(", ")})`).join(",\n");
        await api.executeSql(active.id, `INSERT INTO ${qualifiedName(table)} (${columns}) VALUES\n${values}`);
        setStatus(`CSVをインポート中… ${Math.min(offset + 200, rows.length).toLocaleString()} / ${rows.length.toLocaleString()} 行`);
      }
      if (activeTab?.table.schema === table.schema && activeTab.table.name === table.name) await applyFilter(activeTab.appliedFilter, 0, activeTab.sorts);
      setStatus(`${rows.length.toLocaleString()} 行をインポートしました`);
    } catch (reason) { setError(String(reason)); }
    finally { setLoading(false); if (csvInputRef.current) csvInputRef.current.value = ""; }
  }

  function openSavedQuery(query: SavedQuery) {
    const existing = sqlTabs.find((tab) => tab.savedQueryId === query.id);
    setConnectionHomeActive(false);
    if (existing) { setActiveSqlTabId(existing.id); setSqlOpen(true); return; }
    const tab: SqlTab = {id: crypto.randomUUID(), title: query.name, sql: query.sql, savedQueryId: query.id, folderId: query.folderId ?? ""};
    setSqlTabs((current) => [...current, tab]); setActiveSqlTabId(tab.id); setSqlOpen(true);
  }

  function closeSqlTab(id: string) {
    const index = sqlTabs.findIndex((tab) => tab.id === id);
    const remaining = sqlTabs.filter((tab) => tab.id !== id);
    if (remaining.length === 0) {
      const replacement = newSqlTab(1); setSqlTabs([replacement]); setActiveSqlTabId(replacement.id); return;
    }
    setSqlTabs(remaining);
    if (activeSqlTab?.id === id) setActiveSqlTabId(remaining[Math.min(index, remaining.length - 1)].id);
  }

  function confirmDiscardTabs() {
    return !tableTabs.some(hasPendingChanges) || confirm("未反映の追加・編集・削除があります。破棄して続けますか？");
  }

  async function saveProfile(profile: ConnectionProfile, secrets: ProfileSecrets) {
    await api.saveProfile(profile, secrets);
    setProfiles(await api.listProfiles());
    setStatus(`${profile.name} を保存しました`);
  }

  async function removeProfile(profile: ConnectionProfile) {
    if (!confirm(`「${profile.name}」を削除しますか？`)) return;
    await api.deleteProfile(profile.id);
    setProfiles(await api.listProfiles());
    delete connectionWorkspaces.current[profile.id];
    const remaining = openConnectionIds.filter((id) => id !== profile.id);
    setOpenConnectionIds(remaining);
    if (active?.id === profile.id) {
      const nextProfile = profiles.find((item) => item.id === remaining[remaining.length - 1]);
      if (nextProfile && connectionWorkspaces.current[nextProfile.id]) {
        restoreWorkspace(connectionWorkspaces.current[nextProfile.id]); setActive(nextProfile); setConnected(true); setConnectionHomeActive(false); setStatus(nextProfile.ssh.enabled ? "SSHトンネル経由で接続済み" : "接続済み");
      } else {
        setActive(undefined); setConnected(false); restoreWorkspace(freshWorkspace()); setConnectionPickerOpen(true); setConnectionHomeActive(true);
      }
    }
  }

  async function connect(profile: ConnectionProfile, options?: {force?: boolean}) {
    if (loading || runningSqlTab) { setError("実行中の処理が完了してから接続を切り替えてください"); return; }
    if (!options?.force && openConnectionIds.includes(profile.id) && connectionWorkspaces.current[profile.id]) {
      rememberActiveWorkspace();
      restoreWorkspace(connectionWorkspaces.current[profile.id]);
      setActive(profile); setConnected(true); setConnectionPickerOpen(false); setConnectionHomeActive(false); setError("");
      setStatus(profile.ssh.enabled ? "SSHトンネル経由で接続済み" : "接続済み");
      return;
    }
    rememberActiveWorkspace();
    setLoading(true); setError(""); setStatus(`${profile.name} に接続中…`);
    try {
      await api.connectProfile(profile.id);
      const legacyQueries = savedQueries.filter((query) => !query.profileId);
      if (legacyQueries.length > 0) {
        const migrated = savedQueries.map((query) => query.profileId ? query : {...query, profileId: profile.id});
        setSavedQueries(migrated); api.persistSavedQueries(migrated);
      }
      const nextSchemas = await api.listSchemas(profile.id);
      const entries = await Promise.all(nextSchemas.map(async (schema) => {
        const [schemaTables, schemaFunctions] = await Promise.all([api.listTables(profile.id, schema.name), api.listFunctions(profile.id, schema.name)]);
        return [schema.name, schemaTables, schemaFunctions] as const;
      }));
      const previous = connectionWorkspaces.current[profile.id] ?? freshWorkspace();
      const workspace = {...previous, schemas: nextSchemas, tables: Object.fromEntries(entries.map(([name, items]) => [name, items])), functions: Object.fromEntries(entries.map(([name, , items]) => [name, items]))};
      connectionWorkspaces.current[profile.id] = workspace;
      restoreWorkspace(workspace);
      setActive(profile); setConnected(true); setStatus(profile.ssh.enabled ? "SSHトンネル経由で接続済み" : "接続済み");
      setConnectionPickerOpen(false); setConnectionHomeActive(false);
      setOpenConnectionIds((current) => current.includes(profile.id) ? current : [...current, profile.id]);
    } catch (reason) {
      const message = String(reason);
      const marker = "UNKNOWN_HOST_KEY:";
      if (message.includes(marker)) {
        const fingerprint = message.slice(message.indexOf(marker) + marker.length).trim();
        setPendingHostKey({profile, fingerprint}); setError(""); setStatus("SSHホスト鍵の確認が必要です"); return;
      }
      setError(message); setStatus("接続に失敗しました");
    } finally { setLoading(false); }
  }

  async function trustHostKey() {
    if (!pendingHostKey) return;
    const trusted = {...pendingHostKey.profile, ssh: {...pendingHostKey.profile.ssh, trustedFingerprint: pendingHostKey.fingerprint}};
    setPendingHostKey(undefined);
    try {
      await api.saveProfile(trusted, {});
      setProfiles(await api.listProfiles());
      await connect(trusted);
    } catch (reason) { setError(String(reason)); setStatus("接続に失敗しました"); }
  }

  async function disconnect() {
    if (active) await closeConnectionTab(active.id);
  }

  async function closeConnectionTab(profileId: string) {
    const isActive = active?.id === profileId;
    if (isActive && !confirmDiscardTabs()) return;
    if (isActive) rememberActiveWorkspace();
    await api.disconnectProfile(profileId).catch(() => undefined);
    delete connectionWorkspaces.current[profileId];
    const remaining = openConnectionIds.filter((id) => id !== profileId);
    setOpenConnectionIds(remaining);
    if (!isActive) return;
    const nextProfile = profiles.find((profile) => profile.id === remaining[remaining.length - 1]);
    if (nextProfile && connectionWorkspaces.current[nextProfile.id]) {
      restoreWorkspace(connectionWorkspaces.current[nextProfile.id]);
      setActive(nextProfile); setConnected(true); setConnectionHomeActive(false); setStatus(nextProfile.ssh.enabled ? "SSHトンネル経由で接続済み" : "接続済み");
      return;
    }
    setConnected(false); setActive(undefined); restoreWorkspace(freshWorkspace()); setConnectionPickerOpen(true); setConnectionHomeActive(true); setStatus("切断しました");
  }

  async function openTable(table: TableInfo, options?: {filter?: FilterGroup; forceNew?: boolean}) {
    if (!active) return;
    setConnectionHomeActive(false);
    const baseId = `${table.schema}.${table.name}`;
    const id = options?.forceNew ? `${baseId}:${crypto.randomUUID()}` : baseId;
    if (!options?.forceNew && tableTabs.some((tab) => tab.id === id)) { setActiveTableTabId(id); setSqlOpen(false); return; }
    const blank = emptyFilter();
    const last = savedFilters.find((item) => item.profileId === active.id && item.schema === table.schema && item.table === table.name && item.name === "__last__");
    const nextFilter = options?.filter ?? last?.root ?? blank;
    const tab: TableTab = {id, table, columns: [], offset: 0, filter: nextFilter, appliedFilter: nextFilter, sorts: [], drafts: {}, inserts: [], deletedRows: [], view: "content"};
    setTableTabs((current) => [...current, tab]); setActiveTableTabId(id); setSqlOpen(false); setLoading(true); setError("");
    try {
      const [nextColumns, nextPage] = await Promise.all([
        api.getColumns(active.id, table.schema, table.name),
        api.queryTable(active.id, table.schema, table.name, nextFilter, [], 0),
      ]);
      patchTab(id, {columns: nextColumns, page: nextPage});
    } catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  }

  function referencedTable(foreignKey: ForeignKeyInfo): TableInfo {
    return tables[foreignKey.schema]?.find((table) => table.name === foreignKey.table)
      ?? {schema: foreignKey.schema, name: foreignKey.table, kind: "table"};
  }

  function openForeignTable(foreignKey: ForeignKeyInfo) {
    void openTable(referencedTable(foreignKey), {forceNew: true});
  }

  function followForeignKey(foreignKey: ForeignKeyInfo, value: unknown) {
    const condition = newCondition(foreignKey.column);
    condition.operator = value === null ? "isNull" : "eq";
    condition.value = value === null ? "" : String(value);
    const filter = {...emptyFilter(), children: [condition]};
    void openTable(referencedTable(foreignKey), {filter, forceNew: true});
  }

  function closeTableTab(id: string) {
    const tab = tableTabs.find((item) => item.id === id);
    if (tab && hasPendingChanges(tab) && !confirm("このタブの未反映の追加・編集・削除を破棄しますか？")) return;
    const index = tableTabs.findIndex((item) => item.id === id);
    const remaining = tableTabs.filter((item) => item.id !== id);
    setTableTabs(remaining);
    if (activeTableTabId === id) {
      const next = remaining[Math.min(index, remaining.length - 1)];
      setActiveTableTabId(next?.id);
      if (!next) setSqlOpen(true);
    }
  }

  async function applyFilter(nextFilter = activeTab?.filter, nextOffset = 0, nextSorts = activeTab?.sorts) {
    if (!active || !activeTab || !nextFilter || !nextSorts) return;
    if (hasPendingChanges(activeTab) && !confirm("未反映の追加・編集・削除を破棄してフィルターを実行しますか？")) return;
    const {id, table} = activeTab;
    patchTab(id, {filter: nextFilter, appliedFilter: nextFilter, sorts: nextSorts, offset: nextOffset, drafts: {}, inserts: [], deletedRows: []});
    setLoading(true); setError("");
    try {
      const nextPage = await api.queryTable(active.id, table.schema, table.name, nextFilter, nextSorts, nextOffset);
      patchTab(id, {page: nextPage});
      const last: SavedFilter = {id: `${active.id}:${table.schema}:${table.name}:last`, profileId: active.id, schema: table.schema, table: table.name, name: "__last__", root: nextFilter};
      const next = [...savedFilters.filter((item) => item.id !== last.id), last]; setSavedFilters(next); api.persistSavedFilters(next);
    } catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  }

  async function applyTableChanges(changes: TableChanges) {
    if (!active || !activeTab) return;
    const {id, table, appliedFilter, sorts, offset} = activeTab;
    setLoading(true); setError("");
    try {
      const result = await api.applyTableChanges(active.id, table.schema, table.name, changes);
      const nextPage = await api.queryTable(active.id, table.schema, table.name, appliedFilter, sorts, offset);
      patchTab(id, {page: nextPage, drafts: {}, inserts: [], deletedRows: []});
      setStatus(`追加 ${result.inserted}行・更新 ${result.updated}行・削除 ${result.deleted}行を反映しました`);
    } catch (reason) { setError(String(reason)); throw reason; }
    finally { setLoading(false); }
  }

  async function applySort(nextSorts: SortRule[]) {
    if (!active || !activeTab) return;
    if (hasPendingChanges(activeTab) && !confirm("未反映の追加・編集・削除を破棄してソートしますか？")) return;
    const {id, table, appliedFilter} = activeTab;
    patchTab(id, {sorts: nextSorts, offset: 0, drafts: {}, inserts: [], deletedRows: []});
    setLoading(true); setError("");
    try {
      const nextPage = await api.queryTable(active.id, table.schema, table.name, appliedFilter, nextSorts, 0);
      patchTab(id, {page: nextPage});
    } catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  }

  function saveCurrentFilter() {
    if (!active || !activeTab) return;
    const name = prompt("フィルター名"); if (!name?.trim()) return;
    const {table, filter} = activeTab;
    const item: SavedFilter = {id: crypto.randomUUID(), profileId: active.id, schema: table.schema, table: table.name, name: name.trim(), root: filter};
    const next = [...savedFilters, item]; setSavedFilters(next); api.persistSavedFilters(next);
  }

  function deleteSavedFilter(id: string) {
    const next = savedFilters.filter((item) => item.id !== id); setSavedFilters(next); api.persistSavedFilters(next);
  }

  function quickFilter(column: string, value: unknown) {
    if (!activeTab) return;
    const condition = newCondition(column); condition.operator = value === null ? "isNull" : "eq"; condition.value = value === null ? "" : String(value);
    const next = {...activeTab.filter, children: [...activeTab.filter.children, condition]}; patchTab(activeTab.id, {filter: next}); void applyFilter(next);
  }

  async function runSql(selectionFrom?: number, selectionTo?: number) {
    if (!active || !activeSqlTab || runningSqlTab) return;
    const selection = selectionFrom === undefined || selectionTo === undefined ? sqlEditorRef.current?.selection() : {from: selectionFrom, to: selectionTo};
    const statement = statementForExecution(sql, selection?.from ?? 0, selection?.to ?? 0);
    if (!statement) { setError("実行するSQLを入力してください"); return; }
    const statementForSafety = statement.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "");
    const writesData = !/^\s*(select|values|explain)\b/i.test(statementForSafety);
    if (writesData && active.readOnly) { setError("読み取り専用接続では書き込みSQLを実行できません"); return; }
    if (writesData && active.environment.toLocaleLowerCase() === "production" && !confirm("Production接続で書き込みSQLを実行します。続けますか？")) return;
    const tabId = activeSqlTab.id;
    const startedAt = Date.now();
    cancelledSqlTabs.current.delete(tabId);
    patchSqlTab(tabId, {running: true, cancelRequested: false, executionStartedAt: startedAt, executionDurationMs: undefined});
    setExecutionClock(startedAt); setError(""); setStatus("SQLを実行中…");
    try {
      const page = await api.executeSql(active.id, statement);
      patchSqlTab(tabId, {page});
      if (/^\s*(create|alter|drop|truncate|refresh)\b/i.test(statement)) await refreshObjectCatalog();
      setStatus(`SQLを実行しました（${formatDuration(Date.now() - startedAt)}）`);
    } catch (reason) {
      if (cancelledSqlTabs.current.has(tabId)) setStatus(`SQLをキャンセルしました（${formatDuration(Date.now() - startedAt)}）`);
      else { setError(String(reason)); setStatus("SQL実行に失敗しました"); }
    } finally {
      const duration = Date.now() - startedAt;
      patchSqlTab(tabId, {running: false, cancelRequested: false, executionDurationMs: duration});
      cancelledSqlTabs.current.delete(tabId);
    }
  }

  async function cancelRunningSql() {
    if (!active || !runningSqlTab || runningSqlTab.cancelRequested) return;
    cancelledSqlTabs.current.add(runningSqlTab.id);
    patchSqlTab(runningSqlTab.id, {cancelRequested: true});
    setStatus("SQLをキャンセル中…");
    try { await api.cancelSql(active.id); }
    catch (reason) {
      cancelledSqlTabs.current.delete(runningSqlTab.id);
      patchSqlTab(runningSqlTab.id, {cancelRequested: false});
      setError(String(reason)); setStatus("SQLのキャンセルに失敗しました");
    }
  }

  async function getSqlCompletions(text: string, position: number): Promise<SqlCompletionItem[]> {
    if (!active) return [];
    const beforeCursor = text.slice(Math.max(0, text.lastIndexOf(";", position - 1) + 1), position);
    const reserved = new Set(["where", "join", "left", "right", "full", "inner", "outer", "cross", "on", "group", "order", "limit", "offset", "union", "having"]);
    const references: Array<{schema: string; table: string; alias?: string}> = [];
    const relationPattern = /\b(?:from|join)\s+(?:(?:"([^"]+)"|([a-z_$][\w$]*))\s*\.\s*)?(?:"([^"]+)"|([a-z_$][\w$]*))(?:\s+(?:as\s+)?(?:"([^"]+)"|([a-z_$][\w$]*)))?/gi;
    let match: RegExpExecArray | null;
    while ((match = relationPattern.exec(beforeCursor))) {
      const schemaToken = match[1] ?? match[2];
      const tableName = match[3] ?? match[4];
      const aliasToken = match[5] ?? match[6];
      const schemaName = schemaToken ?? (tables.public?.some((table) => table.name === tableName) ? "public" : Object.keys(tables).find((schema) => tables[schema]?.some((table) => table.name === tableName)) ?? "public");
      references.push({schema: schemaName, table: tableName, alias: aliasToken && !reserved.has(aliasToken.toLocaleLowerCase()) ? aliasToken : undefined});
    }

    const qualifier = /(?:"([^"]+)"|([a-z_$][\w$]*))\.\s*[\w$]*$/i.exec(beforeCursor)?.slice(1).find(Boolean);
    const matchingSchema = qualifier && tables[qualifier];
    if (matchingSchema) return matchingSchema.map((table) => ({label: table.name, type: "class", detail: table.kind === "view" ? "ビュー" : qualifier}));

    const targetReferences = qualifier ? references.filter((item) => item.alias === qualifier || item.table === qualifier) : references;
    const columnGroups = await Promise.all(targetReferences.map(async (reference) => {
      const key = `${active.id}:${reference.schema}.${reference.table}`;
      sqlColumnCache.current[key] ??= api.getColumns(active.id, reference.schema, reference.table).catch(() => []);
      return {reference, columns: await sqlColumnCache.current[key]};
    }));
    const seen = new Set<string>();
    const options: SqlCompletionItem[] = [];
    for (const {reference, columns} of columnGroups) for (const column of columns) {
      if (seen.has(column.name)) continue;
      seen.add(column.name);
      options.push({label: column.name, type: "property", detail: `${reference.alias ? `${reference.alias} → ` : ""}${reference.schema}.${reference.table}`, boost: 100});
    }
    if (qualifier) return options;
    options.push(...sqlCatalogCompletions);
    return options;
  }

  async function exportPage(page: QueryPage, baseName: string, format: ExportFormat) {
    setError("");
    setStatus(`${format.toUpperCase()} をダウンロードフォルダへ保存中…`);
    try {
      const path = await api.exportResults(exportFileName(baseName, format), format, serializeQueryPage(page, format));
      setStatus(path ? `${page.rows.length}行を ${path} に保存しました` : "エクスポートをキャンセルしました");
    } catch (reason) { setError(String(reason)); setStatus("エクスポートに失敗しました"); }
  }

  function createQueryFolder() {
    if (!active) return;
    setTextDialog({kind: "createFolder", title: "フォルダを作成", label: "フォルダ名", value: ""});
  }

  function renameQueryFolder(folderId = selectedQueryFolderId) {
    const folder = connectionQueryFolders.find((item) => item.id === folderId);
    if (!folder) return;
    setTextDialog({kind: "renameFolder", title: "フォルダ名を変更", label: "フォルダ名", value: folder.name, folderId: folder.id});
  }

  function renameSavedQuery(queryId: string) {
    const query = connectionQueries.find((item) => item.id === queryId);
    if (!query) return;
    setTextDialog({kind: "renameQuery", title: "SQLファイル名を変更", label: "ファイル名", value: query.name, queryId});
  }

  function removeQueryTabs(queryIds: Set<string>) {
    const remaining = sqlTabs.filter((tab) => !queryIds.has(tab.savedQueryId));
    if (remaining.length === 0) {
      const replacement = newSqlTab(1);
      setSqlTabs([replacement]); setActiveSqlTabId(replacement.id);
    } else {
      setSqlTabs(remaining);
      if (activeSqlTab && queryIds.has(activeSqlTab.savedQueryId)) setActiveSqlTabId(remaining[0].id);
    }
  }

  function deleteSavedQuery(queryId: string) {
    const query = connectionQueries.find((item) => item.id === queryId);
    if (!query || !confirm(`SQLファイル「${query.name}」を削除しますか？`)) return;
    const next = savedQueries.filter((item) => item.id !== queryId);
    setSavedQueries(next); api.persistSavedQueries(next); removeQueryTabs(new Set([queryId]));
    setQueryContextMenu(undefined); setStatus(`SQLファイル「${query.name}」を削除しました`);
  }

  function submitTextDialog() {
    if (!textDialog || !active) return;
    const name = textDialog.value.trim();
    if (!name) return;
    if (textDialog.kind === "renameQuery") {
      const duplicate = connectionQueries.some((query) => query.id !== textDialog.queryId && query.name.localeCompare(name, "ja", {sensitivity: "accent"}) === 0);
      if (duplicate) { setError(`SQLファイル「${name}」は既にあります`); setTextDialog(undefined); return; }
      const next = savedQueries.map((query) => query.id === textDialog.queryId ? {...query, name, updatedAt: new Date().toISOString()} : query);
      setSavedQueries(next); api.persistSavedQueries(next);
      setSqlTabs((current) => current.map((tab) => tab.savedQueryId === textDialog.queryId ? {...tab, title: name} : tab));
      setStatus(`SQLファイル名を「${name}」へ変更しました`); setTextDialog(undefined); return;
    }
    const duplicate = connectionQueryFolders.some((folder) => folder.id !== (textDialog.kind === "renameFolder" ? textDialog.folderId : "") && folder.name.localeCompare(name, "ja", {sensitivity: "accent"}) === 0);
    if (duplicate) { setError(`フォルダ「${name}」は既にあります`); setTextDialog(undefined); return; }
    if (textDialog.kind === "createFolder") {
      const folder: QueryFolder = {id: crypto.randomUUID(), profileId: active.id, name};
      const next = [...queryFolders, folder]; setQueryFolders(next); api.persistQueryFolders(next); setStatus(`フォルダ「${name}」を作成しました`);
    } else {
      const next = queryFolders.map((folder) => folder.id === textDialog.folderId ? {...folder, name} : folder); setQueryFolders(next); api.persistQueryFolders(next); setStatus(`フォルダ名を「${name}」へ変更しました`);
    }
    setTextDialog(undefined);
  }

  function deleteQueryFolder(folderId = selectedQueryFolderId) {
    const folder = connectionQueryFolders.find((item) => item.id === folderId);
    const childIds = new Set(connectionQueries.filter((query) => query.folderId === folderId).map((query) => query.id));
    if (!folder || !confirm(`フォルダ「${folder.name}」を削除しますか？${childIds.size ? `\n配下のSQLファイル ${childIds.size}件も削除されます。` : ""}`)) return;
    const nextFolders = queryFolders.filter((item) => item.id !== folder.id);
    const nextQueries = savedQueries.filter((query) => !childIds.has(query.id));
    setQueryFolders(nextFolders); setSavedQueries(nextQueries); api.persistQueryFolders(nextFolders); api.persistSavedQueries(nextQueries); removeQueryTabs(childIds); setQueryContextMenu(undefined); setStatus(`フォルダ「${folder.name}」を削除しました`);
  }

  async function selectTableView(view: TableTab["view"]) {
    if (!activeTab || !active) return;
    const {id, table} = activeTab;
    patchTab(id, {view});
    if (view !== "ddl" || activeTab.ddl !== undefined) return;
    setLoading(true); setError("");
    try { patchTab(id, {ddl: await api.getTableDdl(active.id, table.schema, table.name)}); }
    catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  }

  function beginHorizontalResize(event: ReactPointerEvent<HTMLDivElement>, current: number, update: (value: number) => void, min: number, max: number) {
    event.preventDefault(); const startX = event.clientX; event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => update(clamp(current + moveEvent.clientX - startX, min, max));
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); document.body.classList.remove("resizing-columns"); };
    document.body.classList.add("resizing-columns"); window.addEventListener("pointermove", move); window.addEventListener("pointerup", end);
  }

  function beginVerticalResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault(); const startY = event.clientY; const current = sqlEditorHeight; event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => setSqlEditorHeight(clamp(current + moveEvent.clientY - startY, 80, Math.max(120, window.innerHeight - 220)));
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); document.body.classList.remove("resizing-rows"); };
    document.body.classList.add("resizing-rows"); window.addEventListener("pointermove", move); window.addEventListener("pointerup", end);
  }

  function beginQueryPaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault(); const startY = event.clientY; const current = queryPaneHeight; event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => setQueryPaneHeight(clamp(current + moveEvent.clientY - startY, 120, Math.max(160, window.innerHeight - 260)));
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); document.body.classList.remove("resizing-rows"); };
    document.body.classList.add("resizing-rows"); window.addEventListener("pointermove", move); window.addEventListener("pointerup", end);
  }

  function resizeWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>, current: number, update: (value: number) => void, min: number, max: number) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault(); update(clamp(current + (event.key === "ArrowRight" ? 10 : -10), min, max));
  }

  const showConnectionHome = !connected || connectionHomeActive;
  const shellStyle = {
    "--connection-width": connectionSidebarCollapsed ? "38px" : `${connectionWidth}px`,
    "--connection-resizer-width": connectionSidebarCollapsed ? "0px" : "5px",
    "--object-width": showConnectionHome ? "0px" : objectSidebarCollapsed ? "38px" : `${objectWidth}px`,
    "--object-resizer-width": showConnectionHome || objectSidebarCollapsed ? "0px" : "5px",
  } as CSSProperties;
  const sqlStyle = {"--sql-editor-height": `${sqlEditorHeight}px`} as CSSProperties;
  const objectSidebarStyle = {"--query-pane-height": `${queryPaneHeight}px`} as CSSProperties;

  return <div className={`app-shell ${connectionSidebarCollapsed ? "connection-sidebar-is-collapsed" : ""}`} style={shellStyle}>
    <aside className={`connection-sidebar ${connectionSidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      {connectionSidebarCollapsed ? <button className="sidebar-expand" title="Connectionsを開く（⌘Bですべて切替）" aria-label="Connectionsを開く" onClick={() => setConnectionSidebarCollapsed(false)}><PanelLeftOpen size={16}/></button> : <>
      <div className="sidebar-heading connection-sidebar-heading" data-tauri-drag-region><span data-tauri-drag-region>CONNECTIONS</span><div><button title="Connectionsを折りたたむ（⌘Bですべて切替）" aria-label="Connectionsを折りたたむ" onClick={() => setConnectionSidebarCollapsed(true)}><PanelLeftClose size={15}/></button><button title="接続を追加（⌘P）" aria-label="接続を追加" onClick={() => { setConnectionPickerOpen(true); setConnectionHomeActive(true); setNewConnectionFocusRequest((current) => current + 1); }}><Plus size={16}/></button></div></div>
      <div className="connection-list">{profiles.map((profile, index) => <div className={`connection-card ${active?.id === profile.id ? "active" : ""}`} key={profile.id}>
        <button className="connection-main" title={index < 9 ? `接続（⌘${index + 1}）` : undefined} onClick={() => void connect(profile)}><span className={`environment-dot ${profile.environment.toLowerCase()}`}/><span><strong>{profile.name}</strong><small>{profile.username}@{profile.host}</small></span>{index < 9 && <kbd className="connection-shortcut">⌘{index + 1}</kbd>}</button>
        <div className="connection-actions"><button title="編集" onClick={() => setDialog({open: true, profile})}><Pencil size={13}/></button><button title="削除" onClick={() => void removeProfile(profile)}><Trash2 size={13}/></button></div>
      </div>)}</div>
      </>}
    </aside>

    <div className={`resize-handle column-resize-handle ${connectionSidebarCollapsed ? "collapsed-resizer" : ""}`} role="separator" aria-label="接続サイドバーの幅を変更" aria-orientation="vertical" tabIndex={connectionSidebarCollapsed ? -1 : 0} onPointerDown={(event) => beginHorizontalResize(event, connectionWidth, setConnectionWidth, 160, 420)} onKeyDown={(event) => resizeWithKeyboard(event, connectionWidth, setConnectionWidth, 160, 420)} onDoubleClick={() => setConnectionWidth(DEFAULT_CONNECTION_WIDTH)}/>

    <aside className={`object-sidebar ${objectSidebarCollapsed ? "sidebar-collapsed" : ""}`} style={objectSidebarStyle}>
      {objectSidebarCollapsed ? <button className="sidebar-expand" title="Queries / Tablesを開く（⌘Bですべて切替）" aria-label="Queries / Tablesを開く" onClick={() => setObjectSidebarCollapsed(false)}><PanelLeftOpen size={16}/></button> : <>
      <header data-tauri-drag-region><div data-tauri-drag-region><Server size={16}/><strong data-tauri-drag-region>{active?.database ?? "Database"}</strong></div><div className="sidebar-header-actions"><button title="Queries / Tablesを折りたたむ（⌘Bですべて切替）" aria-label="Queries / Tablesを折りたたむ" onClick={() => setObjectSidebarCollapsed(true)}><PanelLeftClose size={15}/></button><button title="再読み込み" aria-label="再読み込み" disabled={!connected} onClick={() => active && void connect(active, {force: true})}><RefreshCw size={14}/></button></div></header>
      <section className="browser-pane query-browser-pane">
        <div className="browser-pane-heading"><span><FileCode2 size={13}/>QUERIES</span><div><button disabled={!connected} title="クエリーフォルダを作成" onClick={createQueryFolder}><FolderPlus size={14}/></button><button disabled={!connected} title="新しいSQL Query" onClick={() => addSqlTab()}><Plus size={15}/></button></div></div>
        <div className="object-search"><Search size={13}/><input disabled={!connected} value={querySearch} onChange={(event) => setQuerySearch(event.target.value)} placeholder="クエリーを検索" aria-label="保存済みクエリーを検索"/>{querySearch && <button title="検索をクリア" onClick={() => setQuerySearch("")}><X size={12}/></button>}</div>
        {!connected ? <div className="browser-pane-empty">接続すると保存済みクエリーが<br/>ここに表示されます</div> : <div className="query-tree" onContextMenu={(event) => openQueryContextMenu(event)}>{visibleUnfiledQueries.map((query) => <button key={query.id} className={sqlOpen && selectedQueryId === query.id ? "selected" : ""} onClick={() => openSavedQuery(query)} onContextMenu={(event) => openQueryContextMenu(event, query.folderId, query.id)}><FileCode2 size={14}/><span>{query.name}</span></button>)}{connectionQueryFolders.map((folder) => {
          const folderMatches = folder.name.toLocaleLowerCase().includes(normalizedQuerySearch);
          const folderQueries = connectionQueries.filter((query) => query.folderId === folder.id && (!normalizedQuerySearch || folderMatches || query.name.toLocaleLowerCase().includes(normalizedQuerySearch))).sort((a, b) => a.name.localeCompare(b.name, "ja"));
          if (normalizedQuerySearch && !folderMatches && folderQueries.length === 0) return null;
          const collapsed = collapsedQueryFolders[folder.id] && !normalizedQuerySearch;
          return <div className="query-folder-group" key={folder.id} onContextMenu={(event) => openQueryContextMenu(event, folder.id)}><button className="query-folder-row" aria-expanded={!collapsed} onClick={() => setCollapsedQueryFolders((current) => ({...current, [folder.id]: !current[folder.id]}))}><ChevronRight className={`disclosure ${collapsed ? "" : "expanded"}`} size={12}/><Folder size={14}/><span>{folder.name}</span><small>{folderQueries.length}</small></button>{!collapsed && folderQueries.map((query) => <button className={`query-tree-item ${sqlOpen && selectedQueryId === query.id ? "selected" : ""}`} key={query.id} onClick={() => openSavedQuery(query)} onContextMenu={(event) => openQueryContextMenu(event, folder.id, query.id)}><FileCode2 size={14}/><span>{query.name}</span></button>)}</div>;
        })}{connectionQueries.length === 0 && <div className="browser-pane-empty">保存済みクエリーはありません<br/>＋ または右クリックで作成できます</div>}</div>}
      </section>
      <div className="object-pane-resize" role="separator" aria-label="QueriesとTablesの高さを変更" aria-orientation="horizontal" tabIndex={0} onPointerDown={beginQueryPaneResize} onKeyDown={(event) => { if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return; event.preventDefault(); setQueryPaneHeight(clamp(queryPaneHeight + (event.key === "ArrowDown" ? 10 : -10), 120, Math.max(160, window.innerHeight - 260))); }} onDoubleClick={() => setQueryPaneHeight(DEFAULT_QUERY_PANE_HEIGHT)}/>
      <section className="browser-pane table-browser-pane">
        <div className="object-type-tabs"><button className={objectBrowserMode === "tables" ? "active" : ""} onClick={() => { setObjectBrowserMode("tables"); setObjectSearch(""); }}><Table2 size={13}/>Tables</button><button className={objectBrowserMode === "functions" ? "active" : ""} onClick={() => { setObjectBrowserMode("functions"); setObjectSearch(""); }}><span className="function-symbol">ƒ</span>Functions</button><button className="object-create-button" title="新しいデータベースオブジェクト" onClick={(event) => openTableContextMenu(event, undefined, schemas.find((item) => item.name === "public")?.name)}><Plus size={15}/></button></div>
        <div className="object-search"><Search size={13}/><input ref={objectSearchRef} disabled={!connected} value={objectSearch} onChange={(event) => setObjectSearch(event.target.value)} placeholder={objectBrowserMode === "tables" ? "テーブルを検索" : "関数を検索"} aria-label={objectBrowserMode === "tables" ? "スキーマ、テーブル、ビューを検索" : "関数、プロシージャを検索"}/>{objectSearch && <button title="検索をクリア" onClick={() => { setObjectSearch(""); objectSearchRef.current?.focus(); }}><X size={12}/></button>}</div>
        {!connected ? <div className="browser-pane-empty">接続するとスキーマが<br/>ここに表示されます</div> : <div className="schema-tree" onContextMenu={(event) => openTableContextMenu(event)}>{schemas.map((schema) => {
          const query = objectSearch.trim().toLocaleLowerCase();
          const matchesSchema = schema.name.toLocaleLowerCase().includes(query);
          const schemaTables = (tables[schema.name] ?? []).filter((table) => !query || matchesSchema || table.name.toLocaleLowerCase().includes(query));
          const schemaFunctions = (functions[schema.name] ?? []).filter((item) => !query || matchesSchema || item.name.toLocaleLowerCase().includes(query) || item.arguments.toLocaleLowerCase().includes(query));
          const functionLimit = functionRenderLimits[schema.name] ?? FUNCTION_RENDER_BATCH;
          const renderedFunctions = schemaFunctions.slice(0, functionLimit);
          const visibleItems = objectBrowserMode === "tables" ? schemaTables : schemaFunctions;
          if (query && !matchesSchema && visibleItems.length === 0) return null;
          const collapsed = collapsedSchemas[schema.name] && !query;
          return <div key={schema.name} onContextMenu={(event) => openTableContextMenu(event, undefined, schema.name)}><button className="schema-name" aria-expanded={!collapsed} onClick={() => setCollapsedSchemas((current) => ({...current, [schema.name]: !current[schema.name]}))}><ChevronRight className={`disclosure ${collapsed ? "" : "expanded"}`} size={12}/><Folder size={13}/>{schema.name}</button>{!collapsed && objectBrowserMode === "tables" && schemaTables.map((table) => <button key={`${schema.name}.${table.name}`} className={!sqlOpen && selectedTable?.schema === schema.name && selectedTable.name === table.name ? "selected" : ""} onClick={() => void openTable(table)} onContextMenu={(event) => openTableContextMenu(event, table)}><Table2 size={14}/><span className="object-name">{table.name}</span><small>{table.kind === "view" ? "V" : table.kind === "materialized_view" ? "MV" : ""}</small></button>)}{!collapsed && objectBrowserMode === "functions" && renderedFunctions.map((item) => <button key={`${item.schema}.${item.name}(${item.arguments})`} onClick={() => void openFunctionDefinition(item)}><span className="function-symbol">ƒ</span><span className="object-name">{item.name}({item.arguments})</span><small>{item.kind === "procedure" ? "P" : item.returnType}</small></button>)}{!collapsed && objectBrowserMode === "functions" && renderedFunctions.length < schemaFunctions.length && <button className="object-load-more" onClick={(event) => { event.stopPropagation(); setFunctionRenderLimits((current) => ({...current, [schema.name]: functionLimit + FUNCTION_RENDER_BATCH})); }}><Plus size={12}/><span>さらに表示</span><small>残り {schemaFunctions.length - renderedFunctions.length}</small></button>}</div>;
        })}</div>}
      </section>
      </>}
    </aside>

    <div className={`resize-handle column-resize-handle ${showConnectionHome || objectSidebarCollapsed ? "collapsed-resizer" : ""}`} role="separator" aria-label="オブジェクトサイドバーの幅を変更" aria-orientation="vertical" tabIndex={showConnectionHome || objectSidebarCollapsed ? -1 : 0} onPointerDown={(event) => beginHorizontalResize(event, objectWidth, setObjectWidth, 160, 480)} onKeyDown={(event) => resizeWithKeyboard(event, objectWidth, setObjectWidth, 160, 480)} onDoubleClick={() => setObjectWidth(DEFAULT_OBJECT_WIDTH)}/>

    <main className="workspace">
      <header className="topbar" data-tauri-drag-region><div className="breadcrumbs" data-tauri-drag-region><Database size={14}/><span data-tauri-drag-region>{connectionHomeActive ? "New connection" : active?.name ?? "No connection"}</span>{!connectionHomeActive && !sqlOpen && selectedTable && <><b data-tauri-drag-region>/</b><span data-tauri-drag-region>{selectedTable.schema}</span><b data-tauri-drag-region>/</b><strong data-tauri-drag-region>{selectedTable.name}</strong></>}</div><div className="status-cluster">{!connectionHomeActive && active?.readOnly && <span className="readonly"><Shield size={12}/>READ ONLY</span>}<span className={error ? "status-error" : connected && !connectionHomeActive ? "online" : "offline"}><Circle size={8} fill="currentColor"/>{connectionHomeActive ? "接続情報を入力してください" : status}</span>{connected && !connectionHomeActive && <button className="icon-button" title="切断" onClick={() => void disconnect()}><Unplug size={15}/></button>}</div></header>
      {(openConnectionProfiles.length > 0 || connectionPickerOpen || !connected) && <div className="connection-tabbar"><div className="connection-tabs">{openConnectionProfiles.map((profile) => <div className={`connection-workspace-tab ${!connectionHomeActive && active?.id === profile.id ? "active" : ""}`} key={profile.id}><button className="connection-tab-select" disabled={loading || Boolean(runningSqlTab)} onClick={() => void connect(profile)}><span className={`environment-dot ${profile.environment.toLowerCase()}`}/><Database size={14}/><span>{profile.name}</span></button><button className="connection-tab-close" disabled={loading || Boolean(runningSqlTab)} title={`${profile.name} を閉じる`} onClick={() => void closeConnectionTab(profile.id)}><X size={12}/></button></div>)}{(connectionPickerOpen || !connected) && <div className={`connection-workspace-tab new-connection-tab ${connectionHomeActive || !connected ? "active" : ""}`}><button className="connection-tab-select" onClick={() => { rememberActiveWorkspace(); setConnectionPickerOpen(true); setConnectionHomeActive(true); }}><Plus size={14}/><span>新しい接続</span></button>{openConnectionProfiles.length > 0 && <button className="connection-tab-close" title="新しい接続を閉じる" onClick={() => { setConnectionPickerOpen(false); setConnectionHomeActive(false); }}><X size={12}/></button>}</div>}</div><button className="connection-tab-add" title="新しい接続（⌘T）" onClick={() => { rememberActiveWorkspace(); setConnectionPickerOpen(true); setConnectionHomeActive(true); setNewConnectionFocusRequest((current) => current + 1); }}><Plus size={15}/></button></div>}
      {connected && !connectionHomeActive && <div className="tabbar"><div className="table-tabs">{tableTabs.map((tab) => <div className={`table-tab ${!sqlOpen && tab.id === activeTableTabId ? "active" : ""}`} key={tab.id}><button className="tab-select" onClick={() => { setActiveTableTabId(tab.id); setSqlOpen(false); }}><Table2 size={14}/><span>{tab.table.name}</span>{hasPendingChanges(tab) && <i title="未反映の変更あり"/>}</button><button className="tab-close" title="タブを閉じる" onClick={() => closeTableTab(tab.id)}><X size={12}/></button></div>)}{sqlTabs.map((tab) => <div className={`table-tab sql-file-tab ${sqlOpen && tab.id === activeSqlTab?.id ? "active" : ""}`} key={tab.id}><button className="tab-select" onClick={() => { setActiveSqlTabId(tab.id); setSqlOpen(true); }}><FileCode2 size={14}/><span>{tab.title}</span>{tab.running && <LoaderCircle className="tab-running-spinner" size={11}/>}</button><button className="tab-close" disabled={tab.running} title={tab.running ? "実行中は閉じられません" : "SQLタブを閉じる"} onClick={() => closeSqlTab(tab.id)}><X size={12}/></button></div>)}</div></div>}
      {error && <div className="error-banner workspace-error">{error}<button onClick={() => setError("")}><Trash2 size={13}/></button></div>}
      {showConnectionHome ? <section className="connection-welcome"><div className="connection-welcome-card"><header className="connection-welcome-header"><div className="connection-welcome-icon"><Database size={25}/></div><div><h1>データベースに接続</h1><p>左のConnectionsから接続先を選ぶか、新しい接続を作成してください。</p></div></header><div className="connection-start-grid"><ConnectionDialog embedded focusRequest={newConnectionFocusRequest} onClose={() => undefined} onSave={saveProfile}/></div></div></section> : sqlOpen ? <div className="sql-workspace" style={sqlStyle}><div className="sql-toolbar"><button className="primary compact" disabled={!connected || Boolean(runningSqlTab)} title="実行（⌘↵）" onClick={() => void runSql()}><Play size={13}/>実行<kbd>⌘↵</kbd></button>{runningSqlTab && <><span className="sql-running-status"><LoaderCircle size={13}/><strong>{runningSqlTab.title}</strong> を実行中 · {formatDuration(executionClock - (runningSqlTab.executionStartedAt ?? executionClock))}</span><button className="sql-cancel-button" disabled={runningSqlTab.cancelRequested} onClick={() => void cancelRunningSql()}><Square size={11}/>{runningSqlTab.cancelRequested ? "キャンセル中…" : "キャンセル"}</button></>}{!runningSqlTab && activeSqlTab?.executionDurationMs !== undefined && <span className="sql-duration"><Clock3 size={12}/>実行時間 {formatDuration(activeSqlTab.executionDurationMs)}</span>}{sqlSelection && <span className="sql-selection-status">選択 {sqlSelection.fromLine}:{sqlSelection.fromColumn}–{sqlSelection.toLine}:{sqlSelection.toColumn} · {sqlSelection.to - sqlSelection.from}文字</span>}<span className="sql-editor-hint">コメント切替 <kbd>⌘/</kbd> · 候補 <kbd>⌃Space</kbd></span></div><SqlEditor ref={sqlEditorRef} value={sql} onChange={setSql} onRun={(from, to) => { if (!runningSqlTab) void runSql(from, to); }} getCompletions={getSqlCompletions} onSelectionChange={setSqlSelection}/><div className="resize-handle row-resize-handle" role="separator" aria-label="SQLエディタの高さを変更" aria-orientation="horizontal" tabIndex={0} onPointerDown={beginVerticalResize} onKeyDown={(event) => { if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return; event.preventDefault(); setSqlEditorHeight(clamp(sqlEditorHeight + (event.key === "ArrowDown" ? 10 : -10), 80, Math.max(120, window.innerHeight - 220))); }} onDoubleClick={() => setSqlEditorHeight(DEFAULT_SQL_EDITOR_HEIGHT)}/><DataGrid page={sqlPage} loading={Boolean(activeSqlTab?.running)} onQuickFilter={() => undefined} onExport={sqlPage ? (format) => exportPage(sqlPage, connectionQueries.find((query) => query.id === selectedQueryId)?.name ?? activeSqlTab?.title ?? "query-results", format) : undefined}/></div> : activeTab ? <div className="table-workspace">
        <nav className="table-view-tabs" aria-label="テーブル表示"><button className={activeTab.view === "content" ? "active" : ""} onClick={() => void selectTableView("content")}>内容</button><button className={activeTab.view === "structure" ? "active" : ""} onClick={() => void selectTableView("structure")}>構造</button><button className={activeTab.view === "ddl" ? "active" : ""} onClick={() => void selectTableView("ddl")}>DDL</button></nav>
        {activeTab.view === "content" ? <><FilterBuilder root={activeTab.filter} columns={activeTab.columns} saved={tableSavedFilters.filter((item) => item.name !== "__last__")} loading={loading} focusRequest={filterFocusRequest} onChange={(filter) => patchTab(activeTab.id, {filter})} onApply={() => void applyFilter()} onClear={() => { const next = emptyFilter(); patchTab(activeTab.id, {filter: next}); void applyFilter(next); }} onSave={saveCurrentFilter} onLoad={(item) => { patchTab(activeTab.id, {filter: item.root}); void applyFilter(item.root); }} onDeleteSaved={deleteSavedFilter}/><DataGrid page={activeTab.page} columns={activeTab.columns} loading={loading} offset={activeTab.offset} drafts={activeTab.drafts} onDraftsChange={(drafts) => patchTab(activeTab.id, {drafts})} inserts={activeTab.inserts} onInsertsChange={(inserts) => patchTab(activeTab.id, {inserts})} deletedRows={activeTab.deletedRows} onDeletedRowsChange={(deletedRows) => patchTab(activeTab.id, {deletedRows})} sortRules={activeTab.sorts} onSortChange={(sorts) => void applySort(sorts)} onPrevious={() => void applyFilter(activeTab.appliedFilter, Math.max(0, activeTab.offset - 100))} onNext={() => void applyFilter(activeTab.appliedFilter, activeTab.offset + 100)} onQuickFilter={quickFilter} onOpenForeignTable={openForeignTable} onFollowForeignKey={followForeignKey} onExport={activeTab.page ? (format) => exportPage(activeTab.page!, `${activeTab.table.schema}.${activeTab.table.name}`, format) : undefined} onApplyChanges={active?.readOnly ? undefined : applyTableChanges}/></> : activeTab.view === "structure" ? <div className="structure-view"><table><thead><tr><th>カラム</th><th>データ型</th><th>NULL</th><th>キー</th><th>参照先</th></tr></thead><tbody>{activeTab.columns.map((column) => <tr key={column.name}><td>{column.name}</td><td><code>{column.dataType}</code></td><td>{column.nullable ? "YES" : "NO"}</td><td>{column.primaryKey ? "PRIMARY KEY" : column.foreignKey ? "FOREIGN KEY" : ""}</td><td>{column.foreignKey ? `${column.foreignKey.schema}.${column.foreignKey.table}.${column.foreignKey.column}` : ""}</td></tr>)}</tbody></table></div> : <div className="ddl-view"><div className="ddl-toolbar"><span>{activeTab.table.schema}.{activeTab.table.name}</span><button disabled={!activeTab.ddl} onClick={() => activeTab.ddl && void navigator.clipboard.writeText(activeTab.ddl)}><Copy size={13}/>コピー</button></div><pre><code>{activeTab.ddl ?? (loading ? "DDLを取得中…" : "DDLを取得できませんでした")}</code></pre></div>}
      </div> : <div className="empty-state"><Table2 size={36}/><p>左側からテーブルを選択してください</p></div>}
    </main>
    {queryContextMenu && <div className="query-context-menu" role="menu" aria-label="Queriesの操作" style={{left: queryContextMenu.x, top: queryContextMenu.y}} onPointerDown={(event) => event.stopPropagation()}>
      <button role="menuitem" onClick={() => addSqlTab(queryContextMenu.folderId ?? "")}><FilePlus2 size={14}/>新しいSQL Query<span>⌘N</span></button>
      <button role="menuitem" onClick={() => { setQueryContextMenu(undefined); createQueryFolder(); }}><FolderPlus size={14}/>新しいフォルダ</button>
      {(queryContextMenu.queryId || queryContextMenu.folderId) && <div className="menu-separator"/>}
      {queryContextMenu.queryId && <><button role="menuitem" onClick={() => { renameSavedQuery(queryContextMenu.queryId!); setQueryContextMenu(undefined); }}><Pencil size={14}/>名前を変更</button><button className="danger" role="menuitem" onClick={() => deleteSavedQuery(queryContextMenu.queryId!)}><Trash2 size={14}/>削除</button></>}
      {!queryContextMenu.queryId && queryContextMenu.folderId && <><button role="menuitem" onClick={() => { renameQueryFolder(queryContextMenu.folderId); setQueryContextMenu(undefined); }}><Pencil size={14}/>名前を変更</button><button className="danger" role="menuitem" onClick={() => deleteQueryFolder(queryContextMenu.folderId)}><Trash2 size={14}/>削除</button></>}
    </div>}
    {tableContextMenu && <div className="query-context-menu table-context-menu" role="menu" aria-label="データベースオブジェクトの操作" style={{left: tableContextMenu.x, top: tableContextMenu.y}} onPointerDown={(event) => event.stopPropagation()}>
      {tableContextMenu.table && <>
        <button role="menuitem" onClick={() => void openTableView(tableContextMenu.table!, "content")}><Table2 size={14}/>内容を開く</button>
        <button role="menuitem" onClick={() => void openTableView(tableContextMenu.table!, "structure")}><Server size={14}/>構造を開く</button>
        <button role="menuitem" onClick={() => void openTableView(tableContextMenu.table!, "ddl")}><FileCode2 size={14}/>DDLを開く</button>
        <div className="menu-separator"/>
        <button role="menuitem" onClick={() => { void navigator.clipboard.writeText(tableContextMenu.table!.name); setStatus("テーブル名をコピーしました"); setTableContextMenu(undefined); }}><Copy size={14}/>名前をコピー</button>
        <button role="menuitem" onClick={() => { void navigator.clipboard.writeText(`${tableContextMenu.table!.schema}.${tableContextMenu.table!.name}`); setStatus("スキーマ付きテーブル名をコピーしました"); setTableContextMenu(undefined); }}><Copy size={14}/>スキーマ付きでコピー</button>
        <div className="menu-separator"/>
        {tableContextMenu.table.kind === "table" && <button disabled={active?.readOnly} role="menuitem" onClick={() => { setCsvImportTable(tableContextMenu.table); setTableContextMenu(undefined); requestAnimationFrame(() => csvInputRef.current?.click()); }}><Upload size={14}/>CSVをインポート…</button>}
        <button role="menuitem" onClick={() => void exportTable(tableContextMenu.table!)}><FilePlus2 size={14}/>CSVへエクスポート</button>
        {tableContextMenu.table.kind === "materialized_view" && <button disabled={active?.readOnly} role="menuitem" onClick={() => void runTableMaintenance(tableContextMenu.table!, "refresh")}><RefreshCw size={14}/>マテリアライズドビューを更新</button>}
        {tableContextMenu.table.kind === "table" && <button disabled={active?.readOnly} role="menuitem" onClick={() => openSqlTemplate(`Maintenance ${tableContextMenu.table!.name}`, `VACUUM (ANALYZE) ${qualifiedName(tableContextMenu.table!)};`)}><RefreshCw size={14}/>メンテナンスSQLを開く</button>}
        {tableContextMenu.table.kind === "table" && <button disabled={active?.readOnly} role="menuitem" onClick={() => void runTableMaintenance(tableContextMenu.table!, "truncate")}><Trash2 size={14}/>TRUNCATE…</button>}
        <button className="danger" disabled={active?.readOnly} role="menuitem" onClick={() => void runTableMaintenance(tableContextMenu.table!, "drop")}><Trash2 size={14}/>削除…</button>
        <div className="menu-separator"/>
      </>}
      <div className="menu-label">NEW</div>
      <button role="menuitem" onClick={() => createObjectTemplate("table", tableContextMenu.schema)}><Table2 size={14}/>新しいテーブル</button>
      <button role="menuitem" onClick={() => createObjectTemplate("view", tableContextMenu.schema)}><Table2 size={14}/>新しいビュー</button>
      <button role="menuitem" onClick={() => createObjectTemplate("materialized_view", tableContextMenu.schema)}><Table2 size={14}/>新しいマテリアライズドビュー</button>
      <button role="menuitem" onClick={() => createObjectTemplate("function", tableContextMenu.schema)}><FileCode2 size={14}/>新しい関数</button>
      <button role="menuitem" onClick={() => createObjectTemplate("procedure", tableContextMenu.schema)}><FileCode2 size={14}/>新しいプロシージャ</button>
      <button role="menuitem" onClick={() => createObjectTemplate("schema")}><FolderPlus size={14}/>新しいスキーマ</button>
    </div>}
    <input ref={csvInputRef} className="visually-hidden-file-input" type="file" accept=".csv,text/csv" tabIndex={-1} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importCsv(file); }}/>
    {dialog.open && <ConnectionDialog initial={dialog.profile} onClose={() => setDialog({open: false})} onSave={saveProfile}/>} 
    {textDialog && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setTextDialog(undefined); }}>
      <section className="dialog text-input-dialog" role="dialog" aria-modal="true" aria-labelledby="text-dialog-title">
        <header className="dialog-header"><div><span className="eyebrow">SAVED QUERY</span><h2 id="text-dialog-title">{textDialog.title}</h2></div><button className="icon-button" title="閉じる" onClick={() => setTextDialog(undefined)}><X size={17}/></button></header>
        <form autoCapitalize="none" autoCorrect="off" spellCheck={false} onSubmit={(event) => { event.preventDefault(); submitTextDialog(); }}><div className="form-section"><label className="text-dialog-label">{textDialog.label}<input autoFocus value={textDialog.value} onChange={(event) => setTextDialog({...textDialog, value: event.target.value})} onKeyDown={(event) => { if (event.key === "Escape") setTextDialog(undefined); }}/></label></div><footer className="dialog-footer"><button type="button" className="secondary" onClick={() => setTextDialog(undefined)}>キャンセル</button><button type="submit" className="primary" disabled={!textDialog.value.trim()}>{textDialog.kind === "createFolder" ? "作成" : "変更"}</button></footer></form>
      </section>
    </div>}
    {pendingHostKey && <div className="dialog-backdrop" role="presentation">
      <section className="dialog host-key-dialog" role="dialog" aria-modal="true" aria-labelledby="host-key-title">
        <header className="dialog-header"><div><span className="eyebrow">SSH SECURITY</span><h2 id="host-key-title">SSHホスト鍵を確認</h2></div><Shield size={22}/></header>
        <div className="host-key-content"><p>このSSHサーバーへ接続するのは初めてです。管理画面や管理者から案内された値と一致することを確認してください。</p><dl><div><dt>SSHホスト</dt><dd>{pendingHostKey.profile.ssh.host}:{pendingHostKey.profile.ssh.port}</dd></div><div><dt>SHA-256フィンガープリント</dt><dd><code>{pendingHostKey.fingerprint}</code></dd></div></dl><p className="host-key-warning">一致を確認せず信頼すると、別のサーバーへ接続して認証情報を渡す危険があります。</p></div>
        <footer className="dialog-footer"><button className="secondary" onClick={() => {setPendingHostKey(undefined); setStatus("接続をキャンセルしました");}}>キャンセル</button><button className="primary" onClick={() => void trustHostKey()}>この鍵を信頼して接続</button></footer>
      </section>
    </div>}
  </div>;
}
