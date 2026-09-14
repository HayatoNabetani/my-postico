import { useState } from "react";
import { Check, Copy, FilterX, KeyRound, RotateCcw } from "lucide-react";
import type { ColumnInfo, QueryPage, TableRowUpdate } from "../types";

interface Props {
  page?: QueryPage;
  columns?: ColumnInfo[];
  loading: boolean;
  offset?: number;
  onPrevious?: () => void;
  onNext?: () => void;
  onQuickFilter: (column: string, value: unknown) => void;
  onApplyChanges?: (updates: TableRowUpdate[]) => Promise<void>;
}

interface EditingCell { key: string; value: string }

function display(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const cellKey = (row: number, column: string) => `${row}\u0000${column}`;

export function DataGrid({ page, columns = [], loading, offset = 0, onPrevious, onNext, onQuickFilter, onApplyChanges }: Props) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<EditingCell>();
  const [applying, setApplying] = useState(false);
  if (loading && !page) return <div className="empty-state"><div className="spinner"/><p>データを取得しています</p></div>;
  if (!page) return <div className="empty-state"><FilterX size={36}/><p>左側からテーブルを選択してください</p></div>;

  const primaryKeys = columns.filter((column) => column.primaryKey);
  const editable = Boolean(onApplyChanges) && primaryKeys.length > 0;
  const pendingRows = new Set(Object.keys(drafts).map((key) => Number(key.split("\u0000", 1)[0]))).size;

  function finishEditing() {
    if (!editing) return;
    const [rowText, column] = editing.key.split("\u0000");
    const original = display(page!.rows[Number(rowText)]?.[column]);
    setDrafts((current) => {
      const next = {...current};
      if (editing.value === original) delete next[editing.key]; else next[editing.key] = editing.value;
      return next;
    });
    setEditing(undefined);
  }

  async function applyChanges() {
    if (!onApplyChanges) return;
    const grouped = new Map<number, Record<string, unknown>>();
    for (const [key, value] of Object.entries(drafts)) {
      const [rowText, column] = key.split("\u0000");
      const row = Number(rowText);
      grouped.set(row, {...grouped.get(row), [column]: value === "NULL" ? null : value});
    }
    const updates = [...grouped].map(([row, values]) => ({
      primaryKey: Object.fromEntries(primaryKeys.map((column) => [column.name, page!.rows[row][column.name]])),
      values,
    }));
    setApplying(true);
    try {
      await onApplyChanges(updates);
      setDrafts({});
      setEditing(undefined);
    } catch {
      // The parent displays the database error; keep drafts for correction/retry.
    } finally {
      setApplying(false);
    }
  }

  return <div className="data-view">
    {Object.keys(drafts).length > 0 && <div className="pending-changes"><span><b>{Object.keys(drafts).length}</b>セル・<b>{pendingRows}</b>行の変更が未反映です</span><button onClick={() => { setDrafts({}); setEditing(undefined); }}><RotateCcw size={13}/>破棄</button><button className="primary" disabled={applying || loading} onClick={() => void applyChanges()}><Check size={13}/>{applying ? "反映中…" : "変更を適用"}</button></div>}
    <div className="grid-wrap">
      <table className="data-grid"><thead><tr><th className="row-number">#</th>{page.columns.map((column) => {
          const meta = columns.find((item) => item.name === column);
          const foreignKey = meta?.foreignKey;
          return <th key={column} className={foreignKey ? "foreign-key-column" : ""}><div className="column-heading"><span>{column}</span><span className="column-badges">{meta?.primaryKey && <b className="key-badge primary-key">PK</b>}{foreignKey && <b className="key-badge foreign-key" title={`${foreignKey.schema}.${foreignKey.table}.${foreignKey.column}`}><KeyRound size={9}/>FK → {foreignKey.table}.{foreignKey.column}</b>}</span></div><small>{meta?.dataType}</small></th>;
        })}</tr></thead>
        <tbody>{page.rows.map((row, index) => <tr key={index}><td className="row-number">{offset + index + 1}</td>{page.columns.map((column) => {
          const meta = columns.find((item) => item.name === column);
          const key = cellKey(index, column);
          const pending = key in drafts;
          const isEditing = editing?.key === key;
          const classes = [row[column] === null && !pending ? "null-cell" : "", meta?.foreignKey ? "foreign-key-cell" : "", pending ? "pending-cell" : "", isEditing ? "editing-cell" : ""].filter(Boolean).join(" ");
          return <td key={column} className={classes} onDoubleClick={() => editable && setEditing({key, value: drafts[key] ?? display(row[column])})} onContextMenu={(event) => { event.preventDefault(); onQuickFilter(column, row[column]); }} title={editable ? "ダブルクリックで編集・右クリックで絞り込み（NULLと入力するとNULLを設定）" : primaryKeys.length === 0 && columns.length ? "主キーがないため編集できません" : "右クリックでこの値に絞り込み"}>{isEditing ? <input autoFocus value={editing?.value ?? ""} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setEditing({key, value: event.target.value})} onBlur={finishEditing} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setEditing(undefined); }}/> : (pending ? drafts[key] : display(row[column]))}</td>;
        })}</tr>)}</tbody>
      </table>
      {page.rows.length === 0 && <div className="no-rows">該当する行がありません</div>}
      <div className="sql-preview"><span>SQL</span><code>{page.sqlPreview}</code><button onClick={() => navigator.clipboard.writeText(page.sqlPreview)}><Copy size={13}/></button>{(onPrevious || onNext) && <div className="pager"><button disabled={loading || offset === 0} onClick={onPrevious}>前へ</button><span>{offset + 1}–{offset + page.rows.length}</span><button disabled={loading || !page.hasMore} onClick={onNext}>次へ</button></div>}</div>
    </div>
  </div>;
}
