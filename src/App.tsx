import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useState } from "react";
import { ChevronsLeft, Circle, Database, FileCode2, MoreHorizontal, Pencil, Play, Plus, RefreshCw, Save, Server, Settings, Shield, Table2, Trash2, Unplug, X } from "lucide-react";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { DataGrid } from "./components/DataGrid";
import { emptyFilter, FilterBuilder, newCondition } from "./components/FilterBuilder";
import * as api from "./lib/api";
import type { ColumnInfo, ConnectionProfile, FilterGroup, ProfileSecrets, QueryPage, SavedFilter, SavedQuery, SchemaInfo, TableInfo, TableRowUpdate } from "./types";

type DialogState = { open: false } | { open: true; profile?: ConnectionProfile };
type PendingHostKey = { profile: ConnectionProfile; fingerprint: string };

interface TableTab {
  id: string;
  table: TableInfo;
  columns: ColumnInfo[];
  page?: QueryPage;
  offset: number;
  filter: FilterGroup;
  appliedFilter: FilterGroup;
  drafts: Record<string, string>;
}

const DEFAULT_CONNECTION_WIDTH = 230;
const DEFAULT_OBJECT_WIDTH = 230;
const DEFAULT_SQL_EDITOR_HEIGHT = 180;

function savedSize(key: string, fallback: number) {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export default function App() {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [active, setActive] = useState<ConnectionProfile>();
  const [connected, setConnected] = useState(false);
  const [schemas, setSchemas] = useState<SchemaInfo[]>([]);
  const [tables, setTables] = useState<Record<string, TableInfo[]>>({});
  const [tableTabs, setTableTabs] = useState<TableTab[]>([]);
  const [activeTableTabId, setActiveTableTabId] = useState<string>();
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>(api.loadSavedFilters());
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>(api.loadSavedQueries());
  const [selectedQueryId, setSelectedQueryId] = useState("");
  const [dialog, setDialog] = useState<DialogState>({ open: false });
  const [pendingHostKey, setPendingHostKey] = useState<PendingHostKey>();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("接続を選択してください");
  const [error, setError] = useState("");
  const [sqlOpen, setSqlOpen] = useState(false);
  const [sql, setSql] = useState("select now() as server_time;");
  const [sqlPage, setSqlPage] = useState<QueryPage>();
  const [connectionWidth, setConnectionWidth] = useState(() => savedSize("my-postico:connection-width", DEFAULT_CONNECTION_WIDTH));
  const [objectWidth, setObjectWidth] = useState(() => savedSize("my-postico:object-width", DEFAULT_OBJECT_WIDTH));
  const [sqlEditorHeight, setSqlEditorHeight] = useState(() => savedSize("my-postico:sql-editor-height", DEFAULT_SQL_EDITOR_HEIGHT));

  const activeTab = tableTabs.find((tab) => tab.id === activeTableTabId);
  const selectedTable = activeTab?.table;
  const tableSavedFilters = useMemo(() => selectedTable ? savedFilters.filter((item) => item.profileId === active?.id && item.schema === selectedTable.schema && item.table === selectedTable.name) : [], [savedFilters, selectedTable, active]);

  useEffect(() => { api.listProfiles().then(setProfiles).catch((reason) => setError(String(reason))); }, []);
  useEffect(() => { localStorage.setItem("my-postico:connection-width", String(connectionWidth)); }, [connectionWidth]);
  useEffect(() => { localStorage.setItem("my-postico:object-width", String(objectWidth)); }, [objectWidth]);
  useEffect(() => { localStorage.setItem("my-postico:sql-editor-height", String(sqlEditorHeight)); }, [sqlEditorHeight]);

  function patchTab(id: string, patch: Partial<TableTab>) {
    setTableTabs((current) => current.map((tab) => tab.id === id ? {...tab, ...patch} : tab));
  }

  function confirmDiscardTabs() {
    return !tableTabs.some((tab) => Object.keys(tab.drafts).length > 0) || confirm("未反映のセル変更があります。破棄して続けますか？");
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
    if (active?.id === profile.id) {
      setActive(undefined); setConnected(false); setTableTabs([]); setActiveTableTabId(undefined);
    }
  }

  async function connect(profile: ConnectionProfile) {
    if (connected && !confirmDiscardTabs()) return;
    setLoading(true); setError(""); setStatus(`${profile.name} に接続中…`);
    try {
      await api.connectProfile(profile.id);
      setActive(profile); setConnected(true); setStatus(profile.ssh.enabled ? "SSHトンネル経由で接続済み" : "接続済み");
      const nextSchemas = await api.listSchemas(profile.id);
      const entries = await Promise.all(nextSchemas.map(async (schema) => [schema.name, await api.listTables(profile.id, schema.name)] as const));
      setSchemas(nextSchemas); setTables(Object.fromEntries(entries)); setTableTabs([]); setActiveTableTabId(undefined); setSqlPage(undefined);
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
    if (!confirmDiscardTabs()) return;
    if (active) await api.disconnectProfile(active.id).catch(() => undefined);
    setConnected(false); setActive(undefined); setSchemas([]); setTables({}); setTableTabs([]); setActiveTableTabId(undefined); setSqlPage(undefined); setStatus("切断しました");
  }

  async function openTable(table: TableInfo) {
    if (!active) return;
    const id = `${table.schema}.${table.name}`;
    if (tableTabs.some((tab) => tab.id === id)) { setActiveTableTabId(id); setSqlOpen(false); return; }
    const blank = emptyFilter();
    const last = savedFilters.find((item) => item.profileId === active.id && item.schema === table.schema && item.table === table.name && item.name === "__last__");
    const nextFilter = last?.root ?? blank;
    const tab: TableTab = {id, table, columns: [], offset: 0, filter: nextFilter, appliedFilter: nextFilter, drafts: {}};
    setTableTabs((current) => [...current, tab]); setActiveTableTabId(id); setSqlOpen(false); setLoading(true); setError("");
    try {
      const [nextColumns, nextPage] = await Promise.all([
        api.getColumns(active.id, table.schema, table.name),
        api.queryTable(active.id, table.schema, table.name, nextFilter, 0),
      ]);
      patchTab(id, {columns: nextColumns, page: nextPage});
    } catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  }

  function closeTableTab(id: string) {
    const tab = tableTabs.find((item) => item.id === id);
    if (tab && Object.keys(tab.drafts).length > 0 && !confirm("このタブの未反映変更を破棄しますか？")) return;
    const index = tableTabs.findIndex((item) => item.id === id);
    const remaining = tableTabs.filter((item) => item.id !== id);
    setTableTabs(remaining);
    if (activeTableTabId === id) {
      const next = remaining[Math.min(index, remaining.length - 1)];
      setActiveTableTabId(next?.id);
      if (!next) setSqlOpen(true);
    }
  }

  async function applyFilter(nextFilter = activeTab?.filter, nextOffset = 0) {
    if (!active || !activeTab || !nextFilter) return;
    if (Object.keys(activeTab.drafts).length > 0 && !confirm("未反映のセル変更を破棄してフィルターを実行しますか？")) return;
    const {id, table} = activeTab;
    patchTab(id, {filter: nextFilter, appliedFilter: nextFilter, offset: nextOffset, drafts: {}});
    setLoading(true); setError("");
    try {
      const nextPage = await api.queryTable(active.id, table.schema, table.name, nextFilter, nextOffset);
      patchTab(id, {page: nextPage});
      const last: SavedFilter = {id: `${active.id}:${table.schema}:${table.name}:last`, profileId: active.id, schema: table.schema, table: table.name, name: "__last__", root: nextFilter};
      const next = [...savedFilters.filter((item) => item.id !== last.id), last]; setSavedFilters(next); api.persistSavedFilters(next);
    } catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  }

  async function applyTableUpdates(updates: TableRowUpdate[]) {
    if (!active || !activeTab) return;
    const {id, table, appliedFilter, offset} = activeTab;
    setLoading(true); setError("");
    try {
      const updated = await api.applyTableUpdates(active.id, table.schema, table.name, updates);
      const nextPage = await api.queryTable(active.id, table.schema, table.name, appliedFilter, offset);
      patchTab(id, {page: nextPage, drafts: {}}); setStatus(`${updated}行の変更を反映しました`);
    } catch (reason) { setError(String(reason)); throw reason; }
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

  async function runSql() {
    if (!active) return; setLoading(true); setError("");
    try { setSqlPage(await api.executeSql(active.id, sql)); }
    catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  }

  function saveQuery() {
    const existing = savedQueries.find((item) => item.id === selectedQueryId);
    const name = existing?.name ?? prompt("クエリー名")?.trim();
    if (!name) return;
    const item: SavedQuery = {id: existing?.id ?? crypto.randomUUID(), name, sql, updatedAt: new Date().toISOString()};
    const next = [...savedQueries.filter((query) => query.id !== item.id), item].sort((a, b) => a.name.localeCompare(b.name, "ja"));
    setSavedQueries(next); setSelectedQueryId(item.id); api.persistSavedQueries(next); setStatus(`${name} を保存しました`);
  }

  function deleteQuery() {
    if (!selectedQueryId) return;
    const next = savedQueries.filter((item) => item.id !== selectedQueryId); setSavedQueries(next); setSelectedQueryId(""); api.persistSavedQueries(next);
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

  function resizeWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>, current: number, update: (value: number) => void, min: number, max: number) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault(); update(clamp(current + (event.key === "ArrowRight" ? 10 : -10), min, max));
  }

  const shellStyle = {"--connection-width": `${connectionWidth}px`, "--object-width": `${objectWidth}px`} as CSSProperties;
  const sqlStyle = {"--sql-editor-height": `${sqlEditorHeight}px`} as CSSProperties;

  return <div className="app-shell" style={shellStyle}>
    <aside className="connection-sidebar">
      <div className="brand" data-tauri-drag-region><div className="brand-mark" data-tauri-drag-region><Database size={19}/></div><div data-tauri-drag-region><strong data-tauri-drag-region>My Postico</strong><span data-tauri-drag-region>PostgreSQL studio</span></div></div>
      <div className="sidebar-heading"><span>CONNECTIONS</span><button onClick={() => setDialog({open: true})}><Plus size={16}/></button></div>
      <div className="connection-list">{profiles.map((profile) => <div className={`connection-card ${active?.id === profile.id ? "active" : ""}`} key={profile.id}>
        <button className="connection-main" onClick={() => void connect(profile)}><span className={`environment-dot ${profile.environment.toLowerCase()}`}/><span><strong>{profile.name}</strong><small>{profile.username}@{profile.host}</small></span></button>
        <div className="connection-actions"><button title="編集" onClick={() => setDialog({open: true, profile})}><Pencil size={13}/></button><button title="削除" onClick={() => void removeProfile(profile)}><Trash2 size={13}/></button></div>
      </div>)}</div>
      <div className="sidebar-bottom"><button><Settings size={16}/>設定</button></div>
    </aside>

    <div className="resize-handle column-resize-handle" role="separator" aria-label="接続サイドバーの幅を変更" aria-orientation="vertical" tabIndex={0} onPointerDown={(event) => beginHorizontalResize(event, connectionWidth, setConnectionWidth, 160, 420)} onKeyDown={(event) => resizeWithKeyboard(event, connectionWidth, setConnectionWidth, 160, 420)} onDoubleClick={() => setConnectionWidth(DEFAULT_CONNECTION_WIDTH)}/>

    <aside className="object-sidebar">
      <header data-tauri-drag-region><div data-tauri-drag-region><Server size={16}/><strong data-tauri-drag-region>{active?.database ?? "Database"}</strong></div><button disabled={!connected} onClick={() => active && void connect(active)}><RefreshCw size={14}/></button></header>
      {!connected ? <div className="sidebar-empty">接続するとスキーマが<br/>ここに表示されます</div> : <div className="schema-tree">{schemas.map((schema) => <div key={schema.name}><div className="schema-name"><ChevronsLeft size={13}/>{schema.name}</div>{tables[schema.name]?.map((table) => <button key={`${schema.name}.${table.name}`} className={!sqlOpen && selectedTable?.schema === schema.name && selectedTable.name === table.name ? "selected" : ""} onClick={() => void openTable(table)}><Table2 size={14}/>{table.name}<span>{table.kind === "view" ? "V" : ""}</span></button>)}</div>)}</div>}
    </aside>

    <div className="resize-handle column-resize-handle" role="separator" aria-label="オブジェクトサイドバーの幅を変更" aria-orientation="vertical" tabIndex={0} onPointerDown={(event) => beginHorizontalResize(event, objectWidth, setObjectWidth, 160, 480)} onKeyDown={(event) => resizeWithKeyboard(event, objectWidth, setObjectWidth, 160, 480)} onDoubleClick={() => setObjectWidth(DEFAULT_OBJECT_WIDTH)}/>

    <main className="workspace">
      <header className="topbar" data-tauri-drag-region><div className="breadcrumbs" data-tauri-drag-region><Database size={14}/><span data-tauri-drag-region>{active?.name ?? "No connection"}</span>{!sqlOpen && selectedTable && <><b data-tauri-drag-region>/</b><span data-tauri-drag-region>{selectedTable.schema}</span><b data-tauri-drag-region>/</b><strong data-tauri-drag-region>{selectedTable.name}</strong></>}</div><div className="status-cluster">{active?.readOnly && <span className="readonly"><Shield size={12}/>READ ONLY</span>}<span className={connected ? "online" : "offline"}><Circle size={8} fill="currentColor"/>{status}</span>{connected && <button className="icon-button" title="切断" onClick={() => void disconnect()}><Unplug size={15}/></button>}</div></header>
      <div className="tabbar"><div className="table-tabs">{tableTabs.map((tab) => <div className={`table-tab ${!sqlOpen && tab.id === activeTableTabId ? "active" : ""}`} key={tab.id}><button className="tab-select" onClick={() => { setActiveTableTabId(tab.id); setSqlOpen(false); }}><Table2 size={14}/><span>{tab.table.name}</span>{Object.keys(tab.drafts).length > 0 && <i title="未反映の変更あり"/>}</button><button className="tab-close" title="タブを閉じる" onClick={() => closeTableTab(tab.id)}><X size={12}/></button></div>)}</div><button className={sqlOpen ? "active sql-tab" : "sql-tab"} onClick={() => setSqlOpen(true)}><FileCode2 size={14}/>SQL Query</button><button className="tab-more"><MoreHorizontal size={16}/></button></div>
      {error && <div className="error-banner workspace-error">{error}<button onClick={() => setError("")}><Trash2 size={13}/></button></div>}
      {sqlOpen ? <div className="sql-workspace" style={sqlStyle}><div className="sql-toolbar"><button className="primary compact" disabled={!connected || loading} onClick={() => void runSql()}><Play size={13}/>{loading ? "実行中" : "実行"}</button><div className="query-actions"><select value={selectedQueryId} onChange={(event) => { const id = event.target.value; setSelectedQueryId(id); const selected = savedQueries.find((item) => item.id === id); if (selected) setSql(selected.sql); }}><option value="">保存済みクエリー</option>{savedQueries.map((query) => <option value={query.id} key={query.id}>{query.name}</option>)}</select><button onClick={saveQuery}><Save size={13}/>{selectedQueryId ? "上書き保存" : "名前を付けて保存"}</button><button className="mini-icon danger" disabled={!selectedQueryId} title="保存済みクエリーを削除" onClick={deleteQuery}><Trash2 size={13}/></button></div></div><textarea spellCheck={false} value={sql} onChange={(event) => setSql(event.target.value)}/><div className="resize-handle row-resize-handle" role="separator" aria-label="SQLエディタの高さを変更" aria-orientation="horizontal" tabIndex={0} onPointerDown={beginVerticalResize} onKeyDown={(event) => { if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return; event.preventDefault(); setSqlEditorHeight(clamp(sqlEditorHeight + (event.key === "ArrowDown" ? 10 : -10), 80, Math.max(120, window.innerHeight - 220))); }} onDoubleClick={() => setSqlEditorHeight(DEFAULT_SQL_EDITOR_HEIGHT)}/><DataGrid page={sqlPage} loading={loading} onQuickFilter={() => undefined}/></div> : activeTab ? <>
        <FilterBuilder root={activeTab.filter} columns={activeTab.columns} saved={tableSavedFilters.filter((item) => item.name !== "__last__")} loading={loading} onChange={(filter) => patchTab(activeTab.id, {filter})} onApply={() => void applyFilter()} onClear={() => { const next = emptyFilter(); patchTab(activeTab.id, {filter: next}); void applyFilter(next); }} onSave={saveCurrentFilter} onLoad={(item) => { patchTab(activeTab.id, {filter: item.root}); void applyFilter(item.root); }} onDeleteSaved={deleteSavedFilter}/>
        <DataGrid page={activeTab.page} columns={activeTab.columns} loading={loading} offset={activeTab.offset} drafts={activeTab.drafts} onDraftsChange={(drafts) => patchTab(activeTab.id, {drafts})} onPrevious={() => void applyFilter(activeTab.appliedFilter, Math.max(0, activeTab.offset - 100))} onNext={() => void applyFilter(activeTab.appliedFilter, activeTab.offset + 100)} onQuickFilter={quickFilter} onApplyChanges={active?.readOnly ? undefined : applyTableUpdates}/>
      </> : <div className="empty-state"><Table2 size={36}/><p>左側からテーブルを選択してください</p></div>}
    </main>
    {dialog.open && <ConnectionDialog initial={dialog.profile} onClose={() => setDialog({open: false})} onSave={saveProfile}/>} 
    {pendingHostKey && <div className="dialog-backdrop" role="presentation">
      <section className="dialog host-key-dialog" role="dialog" aria-modal="true" aria-labelledby="host-key-title">
        <header className="dialog-header"><div><span className="eyebrow">SSH SECURITY</span><h2 id="host-key-title">SSHホスト鍵を確認</h2></div><Shield size={22}/></header>
        <div className="host-key-content"><p>このSSHサーバーへ接続するのは初めてです。管理画面や管理者から案内された値と一致することを確認してください。</p><dl><div><dt>SSHホスト</dt><dd>{pendingHostKey.profile.ssh.host}:{pendingHostKey.profile.ssh.port}</dd></div><div><dt>SHA-256フィンガープリント</dt><dd><code>{pendingHostKey.fingerprint}</code></dd></div></dl><p className="host-key-warning">一致を確認せず信頼すると、別のサーバーへ接続して認証情報を渡す危険があります。</p></div>
        <footer className="dialog-footer"><button className="secondary" onClick={() => {setPendingHostKey(undefined); setStatus("接続をキャンセルしました");}}>キャンセル</button><button className="primary" onClick={() => void trustHostKey()}>この鍵を信頼して接続</button></footer>
      </section>
    </div>}
  </div>;
}
