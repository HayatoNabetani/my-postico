import type { DiagramForeignKey, DiagramTable, SchemaDiagram } from "../types";

export type DiagramFormat = "png" | "svg" | "mmd" | "drawio";
export interface DiagramNode { id: string; table: DiagramTable; x: number; y: number; width: number; height: number; columns: DiagramTable["columns"] }
export interface DiagramLayout { nodes: DiagramNode[]; edges: DiagramForeignKey[]; width: number; height: number }
export const tableId = (schema: string, name: string) => JSON.stringify([schema, name]);
const sourceId = (key: DiagramForeignKey) => tableId(key.sourceSchema, key.sourceTable);
const targetId = (key: DiagramForeignKey) => tableId(key.targetSchema, key.targetTable);
export const escapeXml = (value: string) => value.replace(/[&<>"']/g, (character) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"}[character]!));
const shorten = (text: string, length: number) => Array.from(text).length > length ? Array.from(text).slice(0, length - 1).join("") + "…" : text;
const textWidth = (text: string) => Array.from(text).reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 13 : 7.5), 0);

export function selectDiagram(diagram: SchemaDiagram, selected: Set<string>): SchemaDiagram {
  const external = new Set(diagram.tables.filter((table) => table.external).map((table) => tableId(table.schema, table.name)));
  const included = new Set([...selected].filter((id) => !external.has(id)));
  for (const key of diagram.foreignKeys) if (included.has(sourceId(key)) && external.has(targetId(key))) included.add(targetId(key));
  return {tables: diagram.tables.filter((table) => included.has(tableId(table.schema, table.name))), foreignKeys: diagram.foreignKeys.filter((key) => included.has(sourceId(key)) && included.has(targetId(key)))};
}

export function relatedTables(diagram: SchemaDiagram, id: string): Set<string> {
  const selected = new Set([id]);
  for (const key of diagram.foreignKeys) {
    if (sourceId(key) === id) selected.add(targetId(key));
    if (targetId(key) === id) selected.add(sourceId(key));
  }
  return selected;
}

/** Breadth-first relationship layers. Cycles and disconnected tables terminate,
 * and tall layers wrap into additional columns without overlapping cards. */
export function layoutDiagram(diagram: SchemaDiagram, keysOnly = false): DiagramLayout {
  const tables = [...diagram.tables].sort((a, b) => tableId(a.schema, a.name).localeCompare(tableId(b.schema, b.name)));
  const adjacency = new Map(tables.map((table) => [tableId(table.schema, table.name), new Set<string>()]));
  const referenced = new Map<string, number>();
  for (const key of diagram.foreignKeys) {
    adjacency.get(sourceId(key))?.add(targetId(key)); adjacency.get(targetId(key))?.add(sourceId(key));
    referenced.set(targetId(key), (referenced.get(targetId(key)) ?? 0) + 1);
  }
  const ranks = new Map<string, number>();
  const roots = [...adjacency.keys()].sort((a, b) => (referenced.get(b) ?? 0) - (referenced.get(a) ?? 0) || a.localeCompare(b));
  for (const root of roots) {
    if (ranks.has(root)) continue;
    ranks.set(root, 0);
    const queue = [root];
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i];
      for (const next of adjacency.get(current) ?? []) if (!ranks.has(next)) { ranks.set(next, ranks.get(current)! + 1); queue.push(next); }
    }
  }
  const nodes: DiagramNode[] = tables.map((table) => {
    const id = tableId(table.schema, table.name);
    const fkColumns = new Set(diagram.foreignKeys.filter((key) => sourceId(key) === id).flatMap((key) => key.columns));
    const columns = table.columns.filter((column) => !keysOnly || column.primaryKey || fkColumns.has(column.name));
    const width = Math.max(300, textWidth(shorten(`${table.schema}.${table.name}`, 65)) + 36, ...columns.map((column) => textWidth(shorten(column.name, 40)) + textWidth(shorten(column.dataType, 32)) + 112));
    return {id, table, columns, x: 0, y: 0, width, height: 48 + Math.max(columns.length, 1) * 24 + 12};
  });
  let x = 32;
  for (let rank = 0; rank <= Math.max(0, ...ranks.values()); rank++) {
    let y = 64; let columnWidth = 0;
    for (const node of nodes.filter((node) => ranks.get(node.id) === rank)) {
      if (y > 64 && y + node.height > 1500) { x += columnWidth + 96; y = 64; columnWidth = 0; }
      node.x = x; node.y = y; y += node.height + 48; columnWidth = Math.max(columnWidth, node.width);
    }
    x += columnWidth + 96;
  }
  return {nodes, edges: diagram.foreignKeys, width: Math.max(400, ...nodes.map((node) => node.x + node.width + 72)), height: Math.max(240, ...nodes.map((node) => node.y + node.height + 48))};
}

export function relationLabel(key: DiagramForeignKey): string {
  return `${key.name}: (${key.columns.join(", ")}) → ${key.targetSchema}.${key.targetTable} (${key.targetColumns.join(", ")})`;
}

export function diagramSvg(layout: DiagramLayout, title: string): string {
  const {nodes, width, height} = layout;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const paths = layout.edges.map((key, index) => {
    const source = byId.get(sourceId(key)), target = byId.get(targetId(key));
    if (!source || !target) return "";
    const rowY = (node: DiagramNode, column: string) => node.y + 60 + Math.max(0, node.columns.findIndex((item) => item.name === column)) * 24;
    const sy = rowY(source, key.columns[0]); const ty = rowY(target, key.targetColumns[0]);
    const self = source === target;
    const right = source.x >= target.x;
    const sameColumn = source.x === target.x;
    const sx = self || sameColumn || !right ? source.x + source.width : source.x;
    const tx = self || sameColumn || right ? target.x + target.width : target.x;
    const lane = self || source.x === target.x ? Math.max(sx, tx) + 24 + index % 4 * 8 : (sx + tx) / 2 + (index % 5 - 2) * 8;
    const endY = self && sy === ty ? ty + 18 : ty;
    return `<path d="M${sx},${sy} H${lane} V${endY} H${tx}" fill="none" stroke="#0071e3" stroke-width="1.5" marker-end="url(#fk-arrow)"><title>${escapeXml(relationLabel(key))}</title></path>`;
  }).join("");
  const cards = nodes.map((node) => {
    const foreign = new Set(layout.edges.filter((key) => sourceId(key) === node.id).flatMap((key) => key.columns));
    const heading = `${node.table.schema}.${node.table.name}`;
    const rows = node.columns.map((column, index) => {
      const y = node.y + 60 + index * 24;
      const badge = [column.primaryKey ? "PK" : "", foreign.has(column.name) ? "FK" : ""].filter(Boolean).join("/");
      return `<g><title>${escapeXml(`${column.name} · ${column.dataType} · ${column.nullable ? "NULL" : "NOT NULL"}`)}</title><text x="${node.x + 12}" y="${y}" fill="#0071e3" font-size="10">${badge}</text><text x="${node.x + 60}" y="${y}">${escapeXml(shorten(column.name, 40))}${column.nullable ? "" : " *"}</text><text x="${node.x + node.width - 12}" y="${y}" text-anchor="end" fill="#6e6e73">${escapeXml(shorten(column.dataType, 32))}</text></g>`;
    }).join("");
    return `<g><rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="8" fill="#ffffff" stroke="#c7c7cc" ${node.table.external ? 'stroke-dasharray="5 4"' : ""}/><rect x="${node.x + 1}" y="${node.y + 1}" width="${node.width - 2}" height="35" rx="8" fill="#f2f2f7"/><text x="${node.x + 12}" y="${node.y + 23}" font-weight="600"><title>${escapeXml(heading)}</title>${escapeXml(shorten(heading, 65))}</text>${rows || `<text x="${node.x + 12}" y="${node.y + 60}" fill="#6e6e73">${node.table.external ? "別スキーマ / メタデータ未取得の参照先" : "表示対象のカラムなし"}</text>`}</g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}"><title>${escapeXml(title)}</title><defs><marker id="fk-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M1,1 L7,4 L1,7" fill="none" stroke="#0071e3"/></marker></defs><rect width="100%" height="100%" fill="#f5f5f7"/><g font-family="-apple-system, BlinkMacSystemFont, 'Hiragino Sans', sans-serif" font-size="12" fill="#1d1d1f"><text x="32" y="30" font-size="14" font-weight="600">${escapeXml(shorten(title, 100))}</text>${paths}${cards}</g></svg>`;
}

// Flowchart syntax preserves arbitrary SQL identifiers and FK mappings without
// guessing one-to-one/many cardinalities from incomplete uniqueness metadata.
export function diagramMermaid(layout: DiagramLayout): string {
  const ids = new Map(layout.nodes.map((node, i) => [node.id, `t${i}`]));
  const label = (value: string) => Array.from(value).map((ch) => /[a-zA-Z0-9 _.,():/-]/.test(ch) ? ch : `#${ch.codePointAt(0)};`).join("");
  const lines = ["flowchart LR"];
  for (const node of layout.nodes) {
    const rows = [label(`${node.table.schema}.${node.table.name}${node.table.external ? " (external)" : ""}`), ...node.columns.map((column) => label(`${column.primaryKey ? "PK " : ""}${column.name}: ${column.dataType}${column.nullable ? "" : " NOT NULL"}`))];
    lines.push(`  ${ids.get(node.id)}["${rows.join("<br/>")}"]`);
  }
  for (const key of layout.edges) lines.push(`  ${ids.get(sourceId(key))} -->|"${label(relationLabel(key))}"| ${ids.get(targetId(key))}`);
  return lines.join("\n") + "\n";
}

export function diagramDrawio(layout: DiagramLayout, title: string): string {
  const ids = new Map(layout.nodes.map((node, i) => [node.id, `t${i}`]));
  const cells = layout.nodes.map((node) => {
    const fk = new Set(layout.edges.filter((key) => sourceId(key) === node.id).flatMap((key) => key.columns));
    const value = [`${node.table.schema}.${node.table.name}${node.table.external ? " (external)" : ""}`, "", ...node.columns.map((column) => `${column.primaryKey ? "PK " : ""}${fk.has(column.name) ? "FK " : ""}${column.name}: ${column.dataType}${column.nullable ? "" : " NOT NULL"}`)].join("\n");
    return `<mxCell id="${ids.get(node.id)}" value="${escapeXml(value).replace(/\n/g, "&#xa;")}" style="rounded=1;whiteSpace=wrap;html=0;align=left;verticalAlign=top;spacing=12;fontSize=12;fillColor=#ffffff;strokeColor=#c7c7cc;${node.table.external ? "dashed=1;" : ""}" vertex="1" parent="1"><mxGeometry x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" as="geometry"/></mxCell>`;
  });
  layout.edges.forEach((key, i) => cells.push(`<mxCell id="e${i}" value="${escapeXml(relationLabel(key))}" style="edgeStyle=orthogonalEdgeStyle;html=0;endArrow=open;strokeColor=#0071e3;" edge="1" parent="1" source="${ids.get(sourceId(key))}" target="${ids.get(targetId(key))}"><mxGeometry relative="1" as="geometry"/></mxCell>`));
  return `<?xml version="1.0" encoding="UTF-8"?><mxfile host="My Postico"><diagram name="${escapeXml(title)}"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join("")}</root></mxGraphModel></diagram></mxfile>`;
}

export async function diagramPng(svg: string, width: number, height: number): Promise<string> {
  const scale = Math.min(2, 8192 / width, 8192 / height, Math.sqrt(16_000_000 / (width * height)));
  if (scale < 0.5) throw new Error("PNGにするには図が大きすぎます。テーブルを絞り込むかSVGで出力してください。");
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale); canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("PNG画像を作成できません");
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve(); image.onerror = () => reject(new Error("ER図の画像変換に失敗しました"));
    // data URL is compatible with the desktop app's existing image CSP.
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const result = canvas.toDataURL("image/png");
  if (!result.startsWith("data:image/png;base64,")) throw new Error("PNG画像を作成できません。図のサイズを小さくしてください。");
  return result.split(",")[1];
}
