import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/diagram.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}}).outputText;
const {tableId, selectDiagram, relatedTables, layoutDiagram, diagramSvg, diagramMermaid, diagramDrawio} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const column = (name, primaryKey = false) => ({name, dataType: "integer", nullable: false, primaryKey});
const table = (name, columns = [column("id", true)], schema = "s", external = false) => ({schema, name, columns, external});
const fk = (name, sourceTable, targetTable, columns = ["parent_id"], targetColumns = ["id"], targetSchema = "s") => ({name, sourceSchema: "s", sourceTable, targetSchema, targetTable, columns, targetColumns});

test("table identity, direct neighbors, selection, and external schema targets remain distinct", () => {
  assert.notEqual(tableId("a.b", "c"), tableId("a", "b.c"));
  const data = {tables: [table("parent"), table("child"), table("other"), table("parent", [], "external", true)], foreignKeys: [fk("f1", "child", "parent"), fk("f2", "child", "parent", ["external_id"], ["id"], "external"), fk("f3", "other", "parent")]};
  assert.deepEqual([...relatedTables(data, tableId("s", "child"))].sort(), [tableId("s", "child"), tableId("s", "parent"), tableId("external", "parent")].sort());
  const selected = selectDiagram(data, new Set([tableId("s", "child")]));
  assert.equal(selected.tables.length, 2);
  assert.deepEqual(selected.foreignKeys.map((key) => key.name), ["f2"]);
  assert.deepEqual(selectDiagram(data, new Set()), {tables: [], foreignKeys: []});
  assert.deepEqual(selectDiagram(data, new Set([tableId("external", "parent")])), {tables: [], foreignKeys: []});
});

test("cyclic, self-referencing, and disconnected diagrams have finite nonoverlapping layouts", () => {
  const data = {tables: Array.from({length: 80}, (_, i) => table(`t${i}`, Array.from({length: i % 8 + 1}, (_, c) => column(`c${c}`)))), foreignKeys: [fk("cycle1", "t0", "t1"), fk("cycle2", "t1", "t0"), fk("self", "t2", "t2")]};
  const result = layoutDiagram(data);
  assert.equal(result.nodes.length, 80);
  for (const a of result.nodes) {
    assert.ok(Number.isFinite(a.x + a.y + a.width + a.height));
    assert.ok(a.x + a.width <= result.width && a.y + a.height <= result.height);
    for (const b of result.nodes) if (a !== b) assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
  }
  assert.equal(diagramSvg(result, "cycles").includes("NaN"), false);
});

test("exports preserve composite FK labels and escape SQL identifiers and markup", () => {
  const malicious = '日本語 <script>&" []|`';
  const data = {tables: [table(malicious, [column("id", true), column("parent_id"), column("tenant_id"), column("notes")]), table("parent", [column("id", true), column("tenant_id", true)])], foreignKeys: [fk('composite"<&', malicious, "parent", ["parent_id", "tenant_id"], ["id", "tenant_id"])]};
  const result = layoutDiagram(data);
  const svg = diagramSvg(result, malicious);
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /\(parent_id, tenant_id\)/);
  assert.match(svg, /\(id, tenant_id\)/);
  const mermaid = diagramMermaid(result);
  assert.match(mermaid, /^flowchart LR/);
  assert.doesNotMatch(mermaid, /<script>/);
  assert.match(mermaid, /#60;script#62;/);
  assert.equal((mermaid.match(/ -->/g) ?? []).length, 1);
  const drawio = diagramDrawio(result, malicious);
  assert.doesNotMatch(drawio, /<script>/);
  assert.match(drawio, /html=0/);
  assert.match(drawio, /&#xa;/);
  assert.match(drawio, /source="t\d+" target="t\d+"/);
  const keysOnly = layoutDiagram(data, true);
  assert.deepEqual(keysOnly.nodes.find((node) => node.table.name === malicious).columns.map((item) => item.name), ["id", "parent_id", "tenant_id"]);
  assert.ok(!diagramMermaid(keysOnly).includes("notes"));
});
