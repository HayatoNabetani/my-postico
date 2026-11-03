import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, Maximize, Minus, Network, Plus, RefreshCw, Shield, X } from "lucide-react";
import * as api from "../lib/api";
import { diagramDrawio, diagramMermaid, diagramPng, diagramSvg, layoutDiagram, relatedTables, selectDiagram, tableId, type DiagramFormat } from "../lib/diagram";
import type { SchemaDiagram, SchemaInfo } from "../types";
import "./er-diagram.css";

interface Props {
  profileId: string;
  connectionName: string;
  schemas: SchemaInfo[];
  initialSchema: string;
  initialTable?: string;
  onClose: () => void;
}

export function ErDiagram({profileId, connectionName, schemas, initialSchema, initialTable, onClose}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{x: number; y: number; left: number; top: number} | undefined>(undefined);
  const [schema, setSchema] = useState(initialSchema);
  const [data, setData] = useState<SchemaDiagram>();
  const [selected, setSelected] = useState(new Set<string>());
  const [search, setSearch] = useState("");
  const [keysOnly, setKeysOnly] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [format, setFormat] = useState<DiagramFormat>("png");
  const initialFocus = useRef(initialTable);
  const hasFit = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setData(undefined); setError(""); setMessage(""); hasFit.current = false;
    api.getSchemaDiagram(profileId, schema).then((diagram) => {
      if (cancelled) return;
      setData(diagram);
      const focus = initialFocus.current;
      setSelected(focus ? relatedTables(diagram, tableId(schema, focus)) : new Set(diagram.tables.filter((table) => !table.external).map((table) => tableId(table.schema, table.name))));
      initialFocus.current = undefined;
    }).catch((reason) => { if (!cancelled) setError(String(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [profileId, schema, refresh]);

  const visible = useMemo(() => data ? selectDiagram(data, selected) : {tables: [], foreignKeys: []}, [data, selected]);
  const layout = useMemo(() => layoutDiagram(visible, keysOnly), [visible, keysOnly]);
  const title = `${connectionName} / ${schema} · ER図`;
  const svg = useMemo(() => diagramSvg(layout, title), [layout, title]);
  const tables = data?.tables.filter((table) => !table.external) ?? [];
  const listedTables = tables.filter((table) => table.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const enabled = !loading && Boolean(visible.tables.length) && !exporting;

  function fit() {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setZoom(Math.max(0.1, Math.min(1, (viewport.clientWidth - 32) / layout.width, (viewport.clientHeight - 32) / layout.height)));
    viewport.scrollTo(0, 0);
  }

  useEffect(() => {
    if (loading || hasFit.current || !visible.tables.length) return;
    hasFit.current = true;
    fit();
  }, [loading, layout]);

  async function save() {
    setExporting(true); setError(""); setMessage("");
    try {
      const contents = format === "png" ? await diagramPng(svg, layout.width, layout.height) : format === "svg" ? svg : format === "mmd" ? diagramMermaid(layout) : diagramDrawio(layout, title);
      const name = `${connectionName}-${schema}-ER`.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim() || "ER";
      const path = await api.exportDiagram(`${name}.${format}`, format, contents);
      setMessage(`保存しました: ${path}`);
    } catch (reason) { setError(String(reason)); }
    finally { setExporting(false); }
  }

  async function copyMermaid() {
    try { await navigator.clipboard.writeText(diagramMermaid(layout)); setMessage("Mermaidをコピーしました"); setError(""); }
    catch (reason) { setError(`コピーに失敗しました: ${String(reason)}`); }
  }

  return <dialog ref={dialogRef} className="er-dialog" aria-labelledby="er-title" onKeyDown={(event) => event.stopPropagation()} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header className="er-header"><div><Network size={20}/><h2 id="er-title">ER図</h2><span>{connectionName}</span><span className="er-readonly"><Shield size={12}/>読み取り専用</span></div><button autoFocus aria-label="ER図を閉じる" title="閉じる（Esc）" onClick={onClose}><X size={18}/></button></header>
    <div className="er-toolbar">
      <label>{schemas.length > 1 ? "スキーマ / DB" : "スキーマ"}<select aria-label="ER図のスキーマ" value={schema} onChange={(event) => { setSchema(event.target.value); setSearch(""); }} disabled={exporting}>{schemas.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
      <button disabled={loading || exporting} title="DB構造を再取得" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={14}/>再取得</button>
      <label className="er-keys"><input type="checkbox" checked={keysOnly} onChange={(event) => setKeysOnly(event.target.checked)}/>キーのみ表示</label>
      <div className="er-export"><button disabled={!enabled} onClick={() => void copyMermaid()}><Copy size={14}/>Mermaidコピー</button><select aria-label="ER図の出力形式" value={format} onChange={(event) => setFormat(event.target.value as DiagramFormat)} disabled={exporting}><option value="png">PNG画像</option><option value="svg">SVG画像</option><option value="mmd">Mermaid (.mmd)</option><option value="drawio">draw.io (.drawio)</option></select><button className="er-primary" disabled={!enabled} onClick={() => void save()}><Download size={14}/>{exporting ? "保存中…" : "出力"}</button></div>
    </div>
    <div className="er-body"><aside className="er-sidebar"><div className="er-table-heading"><strong>テーブル</strong><span>{tables.filter((table) => selected.has(tableId(table.schema, table.name))).length} / {tables.length}</span></div><input className="er-search" type="search" aria-label="ER図のテーブル検索" placeholder="テーブルを検索" value={search} onChange={(event) => setSearch(event.target.value)}/><div className="er-selection"><button disabled={!data || loading} onClick={() => setSelected(new Set(tables.map((table) => tableId(table.schema, table.name))))}>すべて選択</button><button disabled={loading} onClick={() => setSelected(new Set())}>解除</button></div><div className="er-table-list">{listedTables.map((table) => {
      const id = tableId(table.schema, table.name);
      return <div className="er-table-row" key={id}><label title={table.name}><input type="checkbox" checked={selected.has(id)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(id); else next.delete(id); return next; })}/><span>{table.name}</span></label><button title={`${table.name}と直接関連するテーブルだけ表示`} aria-label={`${table.name}の関連テーブルを表示`} onClick={() => { setSelected(relatedTables(data!, id)); hasFit.current = false; }}><Network size={13}/></button></div>;
    })}{!loading && !listedTables.length && <p className="er-hint">{tables.length ? "一致するテーブルはありません" : "テーブルはありません"}</p>}</div><p className="er-hint">検索は選択リストを絞り込みます。<br/>図と出力の対象はチェックで選択。<br/>右のアイコンで関連テーブルを表示。</p></aside>
      <section className="er-canvas-section" aria-label="ER図の表示"><div className="er-canvas" ref={viewportRef} tabIndex={0} aria-label="ER図。スクロールまたはドラッグで移動" onPointerDown={(event) => { if (event.button !== 0) return; const element = event.currentTarget; panRef.current = {x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop}; element.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { const pan = panRef.current; if (pan) { event.currentTarget.scrollLeft = pan.left - event.clientX + pan.x; event.currentTarget.scrollTop = pan.top - event.clientY + pan.y; } }} onPointerUp={() => { panRef.current = undefined; }} onLostPointerCapture={() => { panRef.current = undefined; }}>
        {loading ? <div className="er-empty" role="status">DB構造を取得中…</div> : visible.tables.length ? <div className="er-svg-size" style={{width: layout.width * zoom, height: layout.height * zoom}}><div style={{width: layout.width, height: layout.height, transform: `scale(${zoom})`, transformOrigin: "top left"}} dangerouslySetInnerHTML={{__html: svg}}/></div> : <div className="er-empty">{error ? "ER図を取得できませんでした。再取得をお試しください。" : tables.length ? "表示するテーブルを選択してください" : "このスキーマには表示できるテーブルがありません"}</div>}
      </div><div className="er-zoom"><button aria-label="ER図を縮小" disabled={!enabled || zoom <= 0.1} onClick={() => setZoom((value) => Math.max(0.1, value / 1.25))}><Minus size={15}/></button><button title="100%で表示" disabled={!enabled} onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button><button aria-label="ER図を拡大" disabled={!enabled || zoom >= 2} onClick={() => setZoom((value) => Math.min(2, value * 1.25))}><Plus size={15}/></button><button title="全体に合わせる" aria-label="ER図の全体に合わせる" disabled={!enabled} onClick={fit}><Maximize size={15}/></button></div></section>
    </div>
    <footer className="er-footer"><span>{visible.tables.length}テーブル · {visible.foreignKeys.length}外部キー</span><span>PK: 主キー / FK: 外部キー / *: NOT NULL / 矢印: 参照先 / 破線枠: 外部参照</span><span>PNG・SVGは現在の表示内容を出力</span></footer>
    {(error || message) && <div className={`er-message ${error ? "er-error" : ""}`} role={error ? "alert" : "status"}>{error || message}</div>}
  </dialog>;
}
