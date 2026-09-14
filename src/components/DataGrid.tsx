import { Copy, FilterX } from "lucide-react";
import type { QueryPage } from "../types";

interface Props {
  page?: QueryPage;
  loading: boolean;
  offset?: number;
  onPrevious?: () => void;
  onNext?: () => void;
  onQuickFilter: (column: string, value: unknown) => void;
}

function display(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function DataGrid({ page, loading, offset = 0, onPrevious, onNext, onQuickFilter }: Props) {
  if (loading && !page) return <div className="empty-state"><div className="spinner"/><p>データを取得しています</p></div>;
  if (!page) return <div className="empty-state"><FilterX size={36}/><p>左側からテーブルを選択してください</p></div>;
  return <div className="grid-wrap">
    <table className="data-grid"><thead><tr><th className="row-number">#</th>{page.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
      <tbody>{page.rows.map((row, index) => <tr key={index}><td className="row-number">{index + 1}</td>{page.columns.map((column) => <td key={column} className={row[column] === null ? "null-cell" : ""} onContextMenu={(e) => { e.preventDefault(); onQuickFilter(column, row[column]); }} title="右クリックでこの値に絞り込み">{display(row[column])}</td>)}</tr>)}</tbody>
    </table>
    {page.rows.length === 0 && <div className="no-rows">該当する行がありません</div>}
    <div className="sql-preview"><span>SQL</span><code>{page.sqlPreview}</code><button onClick={() => navigator.clipboard.writeText(page.sqlPreview)}><Copy size={13}/></button>{(onPrevious || onNext) && <div className="pager"><button disabled={loading || offset === 0} onClick={onPrevious}>前へ</button><span>{offset + 1}–{offset + page.rows.length}</span><button disabled={loading || !page.hasMore} onClick={onNext}>次へ</button></div>}</div>
  </div>;
}
