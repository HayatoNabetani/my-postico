import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, ClipboardCopy, Copy, Download, FilterX, KeyRound, Plus, RotateCcw, Trash2 } from "lucide-react";
import { nextSort, orderedColumns, pageRowIndices, sortRowIndices } from "../lib/grid";
import type { ExportFormat } from "../lib/export";
import type { ColumnInfo, ForeignKeyInfo, NullsOrder, PendingTableRow, QueryPage, SortDirection, SortRule, TableChanges } from "../types";

interface Props {
  layoutKey: string;
  page?: QueryPage;
  columns?: ColumnInfo[];
  loading: boolean;
  offset?: number;
  cachedPageSize?: number;
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
  onExport?: (format: ExportFormat, displayedPage: QueryPage) => Promise<void>;
}

const gridLayouts = new Map<string, {order: string[]; widths: Record<string, number>}>();

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
const GRID_ROW_HEIGHT = 31;
const GRID_OVERSCAN_ROWS = 12;
const GRID_VIRTUALIZE_AFTER = 150;

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

export function DataGrid({ layoutKey, page, columns = [], loading, offset = 0, cachedPageSize, onPrevious, onNext, onQuickFilter, onApplyChanges, drafts = {}, onDraftsChange, inserts = [], onInsertsChange, deletedRows = [], onDeletedRowsChange, sortRules: serverSortRules = [], onSortChange, onOpenForeignTable, onFollowForeignKey, onExport }: Props) {
  const [columnOrder, setColumnOrder] = useState<string[]>(() => gridLayouts.get(layoutKey)?.order ?? []);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => gridLayouts.get(layoutKey)?.widths ?? {});
  useEffect(() => { gridLayouts.set(layoutKey, {order: columnOrder, widths: columnWidths}); }, [layoutKey, columnOrder, columnWidths]);
  const [localSorts, setLocalSorts] = useState<SortRule[]>([]);
  const sortRules = onSortChange ? serverSortRules : localSorts;
  const changeSort = onSortChange ?? setLocalSorts;
  const displayColumns = useMemo(() => orderedColumns(page?.columns ?? [], columnOrder), [page?.columns, columnOrder]);
  const allRowIndices = useMemo(() => sortRowIndices(page?.rows ?? [], onSortChange ? [] : localSorts), [page?.rows, onSortChange, localSorts]);
  const rowIndices = useMemo(() => pageRowIndices(allRowIndices, offset, cachedPageSize), [allRowIndices, offset, cachedPageSize]);
  const [columnDrag, setColumnDrag] = useState<{source: string; target?: string}>();
  const reorderCleanup = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => reorderCleanup.current?.(), []);
  const suppressClick = useRef(false);
  const resizeCleanup = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => resizeCleanup.current?.(), []);
  useEffect(() => { setLocalSorts([]); }, [page]);

  function resizeColumn(event: React.PointerEvent, column: string) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    resizeCleanup.current?.();
    const start = event.clientX;
    const width = columnWidths[column] ?? 160;
    suppressClick.current = true;
    const move = (event: PointerEvent) => setColumnWidths((current) => ({...current, [column]: Math.max(64, Math.min(1200, width + event.clientX - start))}));
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      document.body.classList.remove("resizing-grid-column");
      resizeCleanup.current = undefined;
      window.setTimeout(() => { suppressClick.current = false; }, 0);
    };
    resizeCleanup.current = end;
    document.body.classList.add("resizing-grid-column");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function moveColumn(event: React.PointerEvent, column: string) {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, .grid-column-resizer")) return;
    event.preventDefault();
    reorderCleanup.current?.();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    handle.setPointerCapture(pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    const move = (event: PointerEvent) => {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > 5) {
        moved = true;
        suppressClick.current = true;
        document.body.classList.add("reordering-grid-column");
        const header = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLTableCellElement>("th[data-column]");
        const target = header && header.closest("table") === gridRef.current?.querySelector("table") ? header.dataset.column : undefined;
        setColumnDrag((current) => current?.source === column && current.target === target ? current : {source: column, target});
      }
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cleanup);
      window.removeEventListener("blur", cleanup);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      setColumnDrag(undefined);
      document.body.classList.remove("reordering-grid-column");
      reorderCleanup.current = undefined;
      window.setTimeout(() => { suppressClick.current = false; }, 0);
    };
    const end = (event: PointerEvent) => {
      if (moved) {
        const header = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLTableCellElement>("th[data-column]");
        const target = header && header.closest("table") === gridRef.current?.querySelector("table") ? header.dataset.column : undefined;
        if (target && target !== column) {
          const next = displayColumns.filter((item) => item !== column);
          next.splice(displayColumns.indexOf(target), 0, column);
          setColumnOrder(next);
        }
      }
      cleanup();
    };
    reorderCleanup.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cleanup);
    window.addEventListener("blur", cleanup);
  }

  function cycleColumnSort(column: string) {
    if (loading || suppressClick.current) { suppressClick.current = false; return; }
    const direction = nextSort(sortRules.find((sort) => sort.column === column)?.direction);
    changeSort(direction ? [{column, direction, nulls: direction === "desc" ? "first" : "last"}] : []);
  }

  const [editing, setEditing] = useState<EditingCell>();
  const [applying, setApplying] = useState(false);
  const [columnMenu, setColumnMenu] = useState<ColumnMenu>();
  const [exporting, setExporting] = useState<ExportFormat>();
  const [copyStatus, setCopyStatus] = useState<"idle" | "copying" | "copied" | "error">("idle");
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | undefined>(undefined);
  const [viewport, setViewport] = useState({scrollTop: 0, height: 600});
  const columnMeta = useMemo(() => new Map(columns.map((column) => [column.name, column])), [columns]);
  const primaryKeys = useMemo(() => columns.filter((column) => column.primaryKey), [columns]);
  const resultCopyBlocked = useMemo(() => page ? spreadsheetCopyBlocked(page) : false, [page]);
  const rowCount = rowIndices.length;
  const hasNextPage = cachedPageSize === undefined ? page?.hasMore : offset + rowCount < (page?.rows.length ?? 0);
  const shouldVirtualize = rowCount > GRID_VIRTUALIZE_AFTER;
  const firstVisibleRow = shouldVirtualize ? Math.max(0, Math.floor(viewport.scrollTop / GRID_ROW_HEIGHT) - GRID_OVERSCAN_ROWS) : 0;
  const lastVisibleRow = shouldVirtualize ? Math.min(rowCount, firstVisibleRow + Math.ceil(viewport.height / GRID_ROW_HEIGHT) + GRID_OVERSCAN_ROWS * 2) : rowCount;
  const visibleRows = useMemo(() => rowIndices.slice(firstVisibleRow, lastVisibleRow).map((index) => ({row: page!.rows[index], index})), [page, rowIndices, firstVisibleRow, lastVisibleRow]);

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

  useEffect(() => {
    const element = gridRef.current;
    if (!element) return;
    const measure = () => setViewport((current) => ({scrollTop: element.scrollTop, height: element.clientHeight || current.height}));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [Boolean(page)]);

  useEffect(() => {
    const element = gridRef.current;
    if (!element) return;
    element.scrollTop = 0;
    setViewport((current) => current.scrollTop === 0 ? current : {...current, scrollTop: 0});
  }, [page, offset, localSorts]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== undefined) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  if (loading && !page) return <div className="empty-state"><div className="spinner"/><p>データを取得しています</p></div>;
  if (!page) return <div className="empty-state"><FilterX size={36}/><p>左側からテーブルを選択してください</p></div>;

  const writable = Boolean(onApplyChanges);
  const existingRowsEditable = writable && primaryKeys.length > 0;
  const updatedRows = new Set(Object.keys(drafts).map((key) => Number(key.split("\u0000", 1)[0]))).size;
  const pendingCount = Object.keys(drafts).length + inserts.length + deletedRows.length;

  function visibleColumnValues(column: string) {
    return rowIndices.map((index) => {
      const row = page!.rows[index];
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
    const rule = {column, direction, nulls};
    changeSort(additive ? [...sortRules.filter((item) => item.column !== column), rule] : [rule]);
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
    try { await onExport(format, {...page!, columns: displayColumns, rows: allRowIndices.map((index) => Object.fromEntries(displayColumns.map((column) => [column, page!.rows[index][column]])))}); }
    finally { setExporting(undefined); }
  }

  async function copyResultsForSpreadsheet() {
    if (resultCopyBlocked || copyStatus === "copying") return;
    setCopyStatus("copying");
    const header = displayColumns.map(spreadsheetCell).join("\t");
    const rows = allRowIndices.map((index) => displayColumns.map((column) => spreadsheetCell(page!.rows[index][column])).join("\t"));
    try {
      await navigator.clipboard.writeText([header, ...rows].join("\n"));
      setCopyStatus("copied");
      window.setTimeout(() => setCopyStatus("idle"), 1600);
    } catch {
      setCopyStatus("error");
    }
  }

  function handleGridScroll(event: React.UIEvent<HTMLDivElement>) {
    const scrollTop = event.currentTarget.scrollTop;
    if (scrollTop === viewport.scrollTop) return;
    if (scrollFrameRef.current !== undefined) cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = requestAnimationFrame(() => {
      setViewport((current) => current.scrollTop === scrollTop ? current : {...current, scrollTop});
      scrollFrameRef.current = undefined;
    });
  }

  return <div className="data-view" data-layout-key={layoutKey}>
    {writable && <div className={`pending-changes ${pendingCount === 0 ? "no-pending-changes" : ""}`}><button className="add-row" disabled={applying || loading} onClick={addRow}><Plus size={13}/>行を追加</button>{pendingCount > 0 && <><span><b>{inserts.length}</b>行追加・<b>{updatedRows}</b>行編集・<b>{deletedRows.length}</b>行削除が未反映です</span><button onClick={discardChanges}><RotateCcw size={13}/>すべて破棄</button><button className="primary" disabled={applying || loading} onClick={() => void applyChanges()}><Check size={13}/>{applying ? "反映中…" : "変更を適用"}</button></>}</div>}
    <div className="grid-wrap" ref={gridRef} onScroll={handleGridScroll}>
      <table className="data-grid resizable-data-grid" style={{width: displayColumns.reduce((total, column) => total + (columnWidths[column] ?? 160), 56 + (writable ? 60 : 0))}}><colgroup><col style={{width: 56}}/>{displayColumns.map((column) => <col key={column} style={{width: columnWidths[column] ?? 160}}/>)}{writable && <col style={{width: 60}}/>}</colgroup><thead><tr><th className="row-number">#</th>{displayColumns.map((column) => {
          const meta = columnMeta.get(column);
          const foreignKey = meta?.foreignKey;
          const sortIndex = sortRules.findIndex((item) => item.column === column);
          const sort = sortRules[sortIndex];
          return <th key={column} aria-sort={sort ? sort.direction === "asc" ? "ascending" : "descending" : "none"} onClick={() => cycleColumnSort(column)} data-column={column} onPointerDown={(event) => moveColumn(event, column)} className={[columnDrag?.source === column ? "dragging-grid-column" : "", columnDrag?.target === column && columnDrag.source !== column ? "grid-column-drop-target" : "", foreignKey ? "foreign-key-column" : "", sort ? "sorted-column" : ""].filter(Boolean).join(" ")} onContextMenu={(event) => { event.preventDefault(); setColumnMenu({column, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 250)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 390))}); }} title="クリック: 降順 → 昇順 → 元の順番 / 右クリック: カラム操作"><div className="column-heading"><span role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); cycleColumnSort(column); } }} title="ドラッグでカラムの順番を変更">{column}</span><span className="column-badges">{meta?.primaryKey && <b className="key-badge primary-key">PK</b>}{foreignKey && <button className="key-badge foreign-key" title={`${foreignKey.schema}.${foreignKey.table}.${foreignKey.column} を新しいタブで開く`} onClick={(event) => { event.stopPropagation(); onOpenForeignTable?.(foreignKey); }}><KeyRound size={9}/>FK → {foreignKey.table}.{foreignKey.column}</button>}{sort && <b className="sort-badge" title={`${sortIndex + 1}番目: ${sort.direction === "asc" ? "昇順" : "降順"}・NULL ${sort.nulls === "first" ? "先頭" : "末尾"}`}>{sort.direction === "asc" ? <ArrowUp size={10}/> : <ArrowDown size={10}/>} {sortIndex + 1}</b>}</span></div><small>{meta?.dataType}</small><span className="grid-column-resizer" role="separator" aria-label={`${column} の幅を変更`} aria-orientation="vertical" aria-valuemin={64} aria-valuemax={1200} aria-valuenow={columnWidths[column] ?? 160} tabIndex={0} onClick={(event) => event.stopPropagation()} onPointerDown={(event) => resizeColumn(event, column)} onDoubleClick={(event) => { event.stopPropagation(); setColumnWidths((current) => ({...current, [column]: 160})); }} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); setColumnWidths((current) => ({...current, [column]: Math.max(64, Math.min(1200, (current[column] ?? 160) + (event.key === "ArrowRight" ? 16 : -16)))})); } }}/></th>;
        })}{writable && <th className="row-actions">操作</th>}</tr></thead>
        <tbody>{firstVisibleRow > 0 && <tr className="virtual-spacer" aria-hidden="true"><td colSpan={page.columns.length + 1 + (writable ? 1 : 0)} style={{height: firstVisibleRow * GRID_ROW_HEIGHT}}/></tr>}{visibleRows.map(({row, index}, visibleIndex) => {
          const deleted = deletedRows.includes(index);
          return <tr key={index} className={deleted ? "pending-delete-row" : ""}><td className="row-number">{offset + firstVisibleRow + visibleIndex + 1}</td>{displayColumns.map((column) => {
          const meta = columnMeta.get(column);
          const foreignKey = meta?.foreignKey;
          const key = cellKey(index, column);
          const pending = key in drafts;
          const isEditing = editing?.key === key;
          const classes = [row[column] === null && !pending ? "null-cell" : "", meta?.foreignKey ? "foreign-key-cell" : "", pending ? "pending-cell" : "", isEditing ? "editing-cell" : ""].filter(Boolean).join(" ");
          return <td key={column} className={classes} onDoubleClick={() => existingRowsEditable && !deleted && setEditing({key, value: drafts[key] ?? display(row[column])})} onContextMenu={(event) => { event.preventDefault(); if (!deleted) onQuickFilter(column, row[column]); }} title={existingRowsEditable ? "ダブルクリックで編集・右クリックで絞り込み（NULLと入力するとNULLを設定）" : primaryKeys.length === 0 && columns.length ? "主キーがないため編集・削除できません" : "右クリックでこの値に絞り込み"}>{isEditing ? <input autoFocus value={editing?.value ?? ""} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setEditing({key, value: event.target.value})} onBlur={finishEditing} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setEditing(undefined); }}/> : foreignKey && row[column] !== null && !pending && !deleted && onFollowForeignKey ? <button className="foreign-key-link" title={`${foreignKey.schema}.${foreignKey.table}.${foreignKey.column} の該当行を開く`} onClick={() => onFollowForeignKey(foreignKey, row[column])}>{display(row[column])}</button> : (pending ? drafts[key] : display(row[column]))}</td>;
        })}{writable && <td className="row-actions"><button disabled={!existingRowsEditable} className={deleted ? "undo-delete" : "delete-row"} title={existingRowsEditable ? deleted ? "削除を取り消す" : "この行を削除予定にする" : "主キーがないため削除できません"} onClick={() => toggleDelete(index)}>{deleted ? <RotateCcw size={13}/> : <Trash2 size={13}/>}</button></td>}</tr>;
        })}{lastVisibleRow < rowCount && <tr className="virtual-spacer" aria-hidden="true"><td colSpan={page.columns.length + 1 + (writable ? 1 : 0)} style={{height: (rowCount - lastVisibleRow) * GRID_ROW_HEIGHT}}/></tr>}
        {inserts.map((row, index) => <tr key={row.id} className="pending-insert-row"><td className="row-number">新規 {index + 1}</td>{displayColumns.map((column) => <td key={column} className={column in row.values ? "pending-cell" : "unset-cell"}><input aria-label={`新規行 ${index + 1} ${column}`} value={row.values[column] ?? ""} placeholder="未指定（DEFAULT）" title="未指定ならDBのDEFAULTを使用。NULLと入力するとNULLを設定" onChange={(event) => updateInsert(row.id, column, event.target.value)}/></td>)}{writable && <td className="row-actions"><button className="delete-row" title="新規行を取り消す" onClick={() => onInsertsChange?.(inserts.filter((item) => item.id !== row.id))}><Trash2 size={13}/></button></td>}</tr>)}
        </tbody>
      </table>
      {page.rows.length === 0 && inserts.length === 0 && <div className="no-rows">該当する行がありません</div>}
      <div className="sql-preview"><span>SQL</span><code>{page.sqlPreview}</code><div className="result-actions"><button title="SQLをコピー" onClick={() => navigator.clipboard.writeText(page.sqlPreview)}><Copy size={13}/></button><button className="spreadsheet-copy-button" disabled={resultCopyBlocked || copyStatus === "copying"} title={resultCopyBlocked ? "結果が大きすぎます（上限: 20,000セル・概算5MB）" : cachedPageSize !== undefined ? "取得した全件をヘッダー付きでコピー" : "ヘッダー付きでコピーしてスプレッドシートへ貼り付け"} onClick={() => void copyResultsForSpreadsheet()}><ClipboardCopy size={13}/>{copyStatus === "copying" ? "コピー中…" : copyStatus === "copied" ? "コピー済み" : copyStatus === "error" ? "コピー失敗" : cachedPageSize !== undefined ? "全件をコピー" : "表をコピー"}</button>{onExport && <div className="export-actions"><button className="export-button" title={cachedPageSize !== undefined ? "取得した全件を保存" : "表示中の結果を保存"} disabled={Boolean(exporting)} onClick={() => void exportAs("csv")}><Download size={13}/>{exporting === "csv" ? "保存中…" : "CSV"}</button><button className="export-button" title={cachedPageSize !== undefined ? "取得した全件を保存" : "表示中の結果を保存"} disabled={Boolean(exporting)} onClick={() => void exportAs("json")}><Download size={13}/>{exporting === "json" ? "保存中…" : "JSON"}</button></div>}</div>{(onPrevious || onNext) && <div className="pager"><button disabled={loading || offset === 0} onClick={onPrevious}>前へ</button><span>{rowCount ? offset + 1 : 0}–{offset + rowCount}{cachedPageSize !== undefined && ` / ${page.rows.length.toLocaleString()}件`}</span><button disabled={loading || !hasNextPage} onClick={onNext}>次へ</button></div>}</div>
    </div>
    {columnMenu && <div className="column-context-menu" role="menu" aria-label={`${columnMenu.column} カラムの操作`} style={{left: columnMenu.x, top: columnMenu.y}} onPointerDown={(event) => event.stopPropagation()}>
      <button role="menuitem" onClick={() => { void navigator.clipboard.writeText(columnMenu.column); setColumnMenu(undefined); }}><Copy size={14}/>カラム名をコピー</button>
      <div className="menu-label">表示中の値をコピー</div>
      <button role="menuitem" onClick={() => copyColumnValues(columnMenu.column, "json")}><Copy size={14}/>JSON配列</button>
      <button role="menuitem" onClick={() => copyColumnValues(columnMenu.column, "spreadsheet")}><Copy size={14}/>スプレッドシート（1列）</button>
      <button role="menuitem" onClick={() => copyColumnValues(columnMenu.column, "sqlIn")}><Copy size={14}/>SQL IN句<span>（…）</span></button>
      <div className="menu-separator"/>
      <div className="menu-label">カラムをソート</div>
      <button role="menuitem" disabled={loading} className={sortRules.some((item) => item.column === columnMenu.column && item.direction === "asc" && item.nulls === "last") ? "active" : ""} onClick={(event) => sortColumn(columnMenu.column, "asc", "last", event.altKey)}><ArrowUp size={14}/>昇順<span>NULLは末尾</span></button>
      <button role="menuitem" disabled={loading} className={sortRules.some((item) => item.column === columnMenu.column && item.direction === "asc" && item.nulls === "first") ? "active" : ""} onClick={(event) => sortColumn(columnMenu.column, "asc", "first", event.altKey)}><ArrowUp size={14}/>昇順（NULLを先頭）</button>
      <button role="menuitem" disabled={loading} className={sortRules.some((item) => item.column === columnMenu.column && item.direction === "desc" && item.nulls === "first") ? "active" : ""} onClick={(event) => sortColumn(columnMenu.column, "desc", "first", event.altKey)}><ArrowDown size={14}/>降順<span>NULLは先頭</span></button>
      <button role="menuitem" disabled={loading} className={sortRules.some((item) => item.column === columnMenu.column && item.direction === "desc" && item.nulls === "last") ? "active" : ""} onClick={(event) => sortColumn(columnMenu.column, "desc", "last", event.altKey)}><ArrowDown size={14}/>降順（NULLを末尾）</button>
      {sortRules.some((item) => item.column === columnMenu.column) && <button role="menuitem" className="remove-sort" onClick={() => { changeSort(sortRules.filter((item) => item.column !== columnMenu.column)); setColumnMenu(undefined); }}><RotateCcw size={14}/>このカラムのソートを解除</button>}
      <div className="menu-hint">⌥を押しながら選択すると複数カラムでソート</div>
    </div>}
  </div>;
}
