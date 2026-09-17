import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Check, ClipboardCopy, Copy, Download, FilterX, KeyRound, Plus, RotateCcw, Trash2 } from "lucide-react";
import type { ExportFormat } from "../lib/export";
import type { ColumnInfo, ForeignKeyInfo, NullsOrder, PendingTableRow, QueryPage, SortDirection, SortRule, TableChanges } from "../types";

interface Props {
  page?: QueryPage;
  columns?: ColumnInfo[];
  loading: boolean;
  offset?: number;
  onPrevious?: () => void;
  onNext?: () => void;
  onQuickFilter: (column: string, value: unknown) => void;
  onApplyChanges?: (changes: TableChanges) => Promise<void>;
  drafts?: Record<string, string>;
  onDraftsChange?: (drafts: Record<string, string>) => void;
  inserts?: PendingTableRow[];
  onInsertsChange?: (rows: PendingTableRow[]) => void;
  deletedRows?: number[];
  onDeletedRowsChange?: (rows: number[]) => void;
  sortRules?: SortRule[];
  onSortChange?: (sorts: SortRule[]) => void;
  onOpenForeignTable?: (foreignKey: ForeignKeyInfo) => void;
  onFollowForeignKey?: (foreignKey: ForeignKeyInfo, value: unknown) => void;
  onExport?: (format: ExportFormat) => Promise<void>;
}

interface EditingCell { key: string; value: string }
interface ColumnMenu { column: string; x: number; y: number }
function display(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function spreadsheetCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `'${text.replace(/'/g, "''")}'`;
}

const cellKey = (row: number, column: string) => `${row}\u0000${column}`;
const MAX_SPREADSHEET_COPY_CELLS = 20_000;
const MAX_SPREADSHEET_COPY_CHARACTERS = 5_000_000;

function spreadsheetCopyBlocked(page: QueryPage): boolean {
  if ((page.rows.length + 1) * page.columns.length > MAX_SPREADSHEET_COPY_CELLS) return true;
  let size = page.columns.reduce((total, column) => total + column.length + 1, 0);
  for (const row of page.rows) {
    for (const column of page.columns) {
      const value = row[column];
      if (typeof value === "string") size += value.length;
      else if (value !== null && value !== undefined && typeof value === "object") {
        try { size += JSON.stringify(value).length; } catch { return true; }
      } else size += 16;
      if (size > MAX_SPREADSHEET_COPY_CHARACTERS) return true;
    }
  }
  return false;
}

export function DataGrid({ page, columns = [], loading, offset = 0, onPrevious, onNext, onQuickFilter, onApplyChanges, drafts = {}, onDraftsChange, inserts = [], onInsertsChange, deletedRows = [], onDeletedRowsChange, sortRules = [], onSortChange, onOpenForeignTable, onFollowForeignKey, onExport }: Props) {
  const [editing, setEditing] = useState<EditingCell>();
  const [applying, setApplying] = useState(false);
  const [columnMenu, setColumnMenu] = useState<ColumnMenu>();
  const [exporting, setExporting] = useState<ExportFormat>();
  const [copyStatus, setCopyStatus] = useState<"idle" | "copying" | "copied" | "error">("idle");

  useEffect(() => {
    if (!columnMenu) return;
    const close = () => setColumnMenu(undefined);
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [columnMenu]);

  if (loading && !page) return <div className="empty-state"><div className="spinner"/><p>データを取得しています</p></div>;
  if (!page) return <div className="empty-state"><FilterX size={36}/><p>左側からテーブルを選択してください</p></div>;

  const primaryKeys = columns.filter((column) => column.primaryKey);
  const writable = Boolean(onApplyChanges);
  const existingRowsEditable = writable && primaryKeys.length > 0;
  const updatedRows = new Set(Object.keys(drafts).map((key) => Number(key.split("\u0000", 1)[0]))).size;
  const pendingCount = Object.keys(drafts).length + inserts.length + deletedRows.length;
  const resultCopyBlocked = spreadsheetCopyBlocked(page);

  function visibleColumnValues(column: string) {
    return page!.rows.map((row, index) => {
      const draft = drafts[cellKey(index, column)];
      return draft === undefined ? row[column] : draft === "NULL" ? null : draft;
    });
  }

  function copyColumnValues(column: string, format: "json" | "spreadsheet" | "sqlIn") {
    const values = visibleColumnValues(column);
    const text = format === "json"
      ? JSON.stringify(values)
      : format === "spreadsheet"
        ? values.map(spreadsheetCell).join("\n")
        : (values.length > 0 ? `(${values.map(sqlLiteral).join(", ")})` : "(NULL)");
    void navigator.clipboard.writeText(text);
    setColumnMenu(undefined);
  }

  function sortColumn(column: string, direction: SortDirection, nulls: NullsOrder, additive: boolean) {
    if (!onSortChange) return;
    const rule = {column, direction, nulls};
    onSortChange(additive ? [...sortRules.filter((item) => item.column !== column), rule] : [rule]);
    setColumnMenu(undefined);
  }

  function finishEditing() {
    if (!editing) return;
    const [rowText, column] = editing.key.split("\u0000");
    const original = display(page!.rows[Number(rowText)]?.[column]);
    const next = {...drafts};
      if (editing.value === original) delete next[editing.key]; else next[editing.key] = editing.value;
    onDraftsChange?.(next);
    setEditing(undefined);
  }

  async function applyChanges() {
    if (!onApplyChanges) return;
    const grouped = new Map<number, Record<string, unknown>>();
    for (const [key, value] of Object.entries(drafts)) {
      const [rowText, column] = key.split("\u0000");
      const row = Number(rowText);
      if (deletedRows.includes(row)) continue;
      grouped.set(row, {...grouped.get(row), [column]: value === "NULL" ? null : value});
    }
    const updates = [...grouped].map(([row, values]) => ({
      primaryKey: Object.fromEntries(primaryKeys.map((column) => [column.name, page!.rows[row][column.name]])),
      values,
    }));
    const insertValues = inserts.map((row) => Object.fromEntries(Object.entries(row.values).map(([column, value]) => [column, value === "NULL" ? null : value])));
    const deletes = deletedRows.map((row) => Object.fromEntries(primaryKeys.map((column) => [column.name, page!.rows[row][column.name]])));
    setApplying(true);
    try {
      await onApplyChanges({updates, inserts: insertValues, deletes});
      onDraftsChange?.({});
      onInsertsChange?.([]);
      onDeletedRowsChange?.([]);
      setEditing(undefined);
    } catch {
      // The parent displays the database error; keep drafts for correction/retry.
    } finally {
      setApplying(false);
    }
  }

  function discardChanges() {
    onDraftsChange?.({});
    onInsertsChange?.([]);
    onDeletedRowsChange?.([]);
    setEditing(undefined);
  }

  function addRow() {
    onInsertsChange?.([...inserts, {id: crypto.randomUUID(), values: {}}]);
  }

  function updateInsert(id: string, column: string, value: string) {
    onInsertsChange?.(inserts.map((row) => row.id === id ? {...row, values: {...row.values, [column]: value}} : row));
  }

  function toggleDelete(row: number) {
    if (deletedRows.includes(row)) {
      onDeletedRowsChange?.(deletedRows.filter((index) => index !== row));
    } else {
      onDeletedRowsChange?.([...deletedRows, row]);
      setEditing(undefined);
    }
  }

  async function exportAs(format: ExportFormat) {
    if (!onExport || exporting) return;
    setExporting(format);
    try { await onExport(format); }
    finally { setExporting(undefined); }
  }

  async function copyResultsForSpreadsheet() {
    if (resultCopyBlocked || copyStatus === "copying") return;
    setCopyStatus("copying");
    const header = page!.columns.map(spreadsheetCell).join("\t");
    const rows = page!.rows.map((row) => page!.columns.map((column) => spreadsheetCell(row[column])).join("\t"));
    try {
      await navigator.clipboard.writeText([header, ...rows].join("\n"));
      setCopyStatus("copied");
      window.setTimeout(() => setCopyStatus("idle"), 1600);
    } catch {
      setCopyStatus("error");
    }
  }

  return <div className="data-view">
    {writable && <div className={`pending-changes ${pendingCount === 0 ? "no-pending-changes" : ""}`}><button className="add-row" disabled={applying || loading} onClick={addRow}><Plus size={13}/>行を追加</button>{pendingCount > 0 && <><span><b>{inserts.length}</b>行追加・<b>{updatedRows}</b>行編集・<b>{deletedRows.length}</b>行削除が未反映です</span><button onClick={discardChanges}><RotateCcw size={13}/>すべて破棄</button><button className="primary" disabled={applying || loading} onClick={() => void applyChanges()}><Check size={13}/>{applying ? "反映中…" : "変更を適用"}</button></>}</div>}
    <div className="grid-wrap">
      <table className="data-grid"><thead><tr><th className="row-number">#</th>{page.columns.map((column) => {
          const meta = columns.find((item) => item.name === column);
          const foreignKey = meta?.foreignKey;
          const sortIndex = sortRules.findIndex((item) => item.column === column);
          const sort = sortRules[sortIndex];
          return <th key={column} className={[foreignKey ? "foreign-key-column" : "", sort ? "sorted-column" : ""].filter(Boolean).join(" ")} onContextMenu={(event) => { event.preventDefault(); setColumnMenu({column, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 250)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 390))}); }} title="右クリックでカラム操作"><div className="column-heading"><span>{column}</span><span className="column-badges">{meta?.primaryKey && <b className="key-badge primary-key">PK</b>}{foreignKey && <button className="key-badge foreign-key" title={`${foreignKey.schema}.${foreignKey.table}.${foreignKey.column} を新しいタブで開く`} onClick={(event) => { event.stopPropagation(); onOpenForeignTable?.(foreignKey); }}><KeyRound size={9}/>FK → {foreignKey.table}.{foreignKey.column}</button>}{sort && <b className="sort-badge" title={`${sortIndex + 1}番目: ${sort.direction === "asc" ? "昇順" : "降順"}・NULL ${sort.nulls === "first" ? "先頭" : "末尾"}`}>{sort.direction === "asc" ? <ArrowUp size={10}/> : <ArrowDown size={10}/>} {sortIndex + 1}</b>}</span></div><small>{meta?.dataType}</small></th>;
        })}{writable && <th className="row-actions">操作</th>}</tr></thead>
        <tbody>{page.rows.map((row, index) => {
          const deleted = deletedRows.includes(index);
          return <tr key={index} className={deleted ? "pending-delete-row" : ""}><td className="row-number">{offset + index + 1}</td>{page.columns.map((column) => {
          const meta = columns.find((item) => item.name === column);
          const foreignKey = meta?.foreignKey;
          const key = cellKey(index, column);
          const pending = key in drafts;
          const isEditing = editing?.key === key;
          const classes = [row[column] === null && !pending ? "null-cell" : "", meta?.foreignKey ? "foreign-key-cell" : "", pending ? "pending-cell" : "", isEditing ? "editing-cell" : ""].filter(Boolean).join(" ");
          return <td key={column} className={classes} onDoubleClick={() => existingRowsEditable && !deleted && setEditing({key, value: drafts[key] ?? display(row[column])})} onContextMenu={(event) => { event.preventDefault(); if (!deleted) onQuickFilter(column, row[column]); }} title={existingRowsEditable ? "ダブルクリックで編集・右クリックで絞り込み（NULLと入力するとNULLを設定）" : primaryKeys.length === 0 && columns.length ? "主キーがないため編集・削除できません" : "右クリックでこの値に絞り込み"}>{isEditing ? <input autoFocus value={editing?.value ?? ""} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setEditing({key, value: event.target.value})} onBlur={finishEditing} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setEditing(undefined); }}/> : foreignKey && row[column] !== null && !pending && !deleted && onFollowForeignKey ? <button className="foreign-key-link" title={`${foreignKey.schema}.${foreignKey.table}.${foreignKey.column} の該当行を開く`} onClick={() => onFollowForeignKey(foreignKey, row[column])}>{display(row[column])}</button> : (pending ? drafts[key] : display(row[column]))}</td>;
        })}{writable && <td className="row-actions"><button disabled={!existingRowsEditable} className={deleted ? "undo-delete" : "delete-row"} title={existingRowsEditable ? deleted ? "削除を取り消す" : "この行を削除予定にする" : "主キーがないため削除できません"} onClick={() => toggleDelete(index)}>{deleted ? <RotateCcw size={13}/> : <Trash2 size={13}/>}</button></td>}</tr>;
        })}
        {inserts.map((row, index) => <tr key={row.id} className="pending-insert-row"><td className="row-number">新規 {index + 1}</td>{page.columns.map((column) => <td key={column} className={column in row.values ? "pending-cell" : "unset-cell"}><input aria-label={`新規行 ${index + 1} ${column}`} value={row.values[column] ?? ""} placeholder="未指定（DEFAULT）" title="未指定ならDBのDEFAULTを使用。NULLと入力するとNULLを設定" onChange={(event) => updateInsert(row.id, column, event.target.value)}/></td>)}{writable && <td className="row-actions"><button className="delete-row" title="新規行を取り消す" onClick={() => onInsertsChange?.(inserts.filter((item) => item.id !== row.id))}><Trash2 size={13}/></button></td>}</tr>)}
        </tbody>
      </table>
      {page.rows.length === 0 && inserts.length === 0 && <div className="no-rows">該当する行がありません</div>}
      <div className="sql-preview"><span>SQL</span><code>{page.sqlPreview}</code><div className="result-actions"><button title="SQLをコピー" onClick={() => navigator.clipboard.writeText(page.sqlPreview)}><Copy size={13}/></button><button className="spreadsheet-copy-button" disabled={resultCopyBlocked || copyStatus === "copying"} title={resultCopyBlocked ? "結果が大きすぎます（上限: 20,000セル・概算5MB）" : "ヘッダー付きでコピーしてスプレッドシートへ貼り付け"} onClick={() => void copyResultsForSpreadsheet()}><ClipboardCopy size={13}/>{copyStatus === "copying" ? "コピー中…" : copyStatus === "copied" ? "コピー済み" : copyStatus === "error" ? "コピー失敗" : "表をコピー"}</button>{onExport && <div className="export-actions"><button className="export-button" disabled={Boolean(exporting)} onClick={() => void exportAs("csv")}><Download size={13}/>{exporting === "csv" ? "保存中…" : "CSV"}</button><button className="export-button" disabled={Boolean(exporting)} onClick={() => void exportAs("json")}><Download size={13}/>{exporting === "json" ? "保存中…" : "JSON"}</button></div>}</div>{(onPrevious || onNext) && <div className="pager"><button disabled={loading || offset === 0} onClick={onPrevious}>前へ</button><span>{offset + 1}–{offset + page.rows.length}</span><button disabled={loading || !page.hasMore} onClick={onNext}>次へ</button></div>}</div>
    </div>
    {columnMenu && <div className="column-context-menu" role="menu" aria-label={`${columnMenu.column} カラムの操作`} style={{left: columnMenu.x, top: columnMenu.y}} onPointerDown={(event) => event.stopPropagation()}>
      <button role="menuitem" onClick={() => { void navigator.clipboard.writeText(columnMenu.column); setColumnMenu(undefined); }}><Copy size={14}/>カラム名をコピー</button>
      <div className="menu-label">表示中の値をコピー</div>
      <button role="menuitem" onClick={() => copyColumnValues(columnMenu.column, "json")}><Copy size={14}/>JSON配列</button>
      <button role="menuitem" onClick={() => copyColumnValues(columnMenu.column, "spreadsheet")}><Copy size={14}/>スプレッドシート（1列）</button>
      <button role="menuitem" onClick={() => copyColumnValues(columnMenu.column, "sqlIn")}><Copy size={14}/>SQL IN句<span>（…）</span></button>
      <div className="menu-separator"/>
      <div className="menu-label">カラムをソート</div>
      <button role="menuitem" disabled={!onSortChange} className={sortRules.some((item) => item.column === columnMenu.column && item.direction === "asc" && item.nulls === "last") ? "active" : ""} onClick={(event) => sortColumn(columnMenu.column, "asc", "last", event.altKey)}><ArrowUp size={14}/>昇順<span>NULLは末尾</span></button>
      <button role="menuitem" disabled={!onSortChange} className={sortRules.some((item) => item.column === columnMenu.column && item.direction === "asc" && item.nulls === "first") ? "active" : ""} onClick={(event) => sortColumn(columnMenu.column, "asc", "first", event.altKey)}><ArrowUp size={14}/>昇順（NULLを先頭）</button>
      <button role="menuitem" disabled={!onSortChange} className={sortRules.some((item) => item.column === columnMenu.column && item.direction === "desc" && item.nulls === "first") ? "active" : ""} onClick={(event) => sortColumn(columnMenu.column, "desc", "first", event.altKey)}><ArrowDown size={14}/>降順<span>NULLは先頭</span></button>
      <button role="menuitem" disabled={!onSortChange} className={sortRules.some((item) => item.column === columnMenu.column && item.direction === "desc" && item.nulls === "last") ? "active" : ""} onClick={(event) => sortColumn(columnMenu.column, "desc", "last", event.altKey)}><ArrowDown size={14}/>降順（NULLを末尾）</button>
      {sortRules.some((item) => item.column === columnMenu.column) && <button role="menuitem" className="remove-sort" onClick={() => { onSortChange?.(sortRules.filter((item) => item.column !== columnMenu.column)); setColumnMenu(undefined); }}><RotateCcw size={14}/>このカラムのソートを解除</button>}
      <div className="menu-hint">⌥を押しながら選択すると複数カラムでソート</div>
    </div>}
  </div>;
}
