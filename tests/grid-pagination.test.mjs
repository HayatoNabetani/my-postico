import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/grid.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext}}).outputText;
const {SQL_RESULT_PAGE_SIZE, pageRowIndices, sortRowIndices} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("cached SQL results beyond 10,000 rows can be traversed without omissions or duplicates", () => {
  const rows = Array.from({length: 10_003}, (_, id) => ({id}));
  const indices = sortRowIndices(rows, []);
  const visited = [];
  for (let offset = 0; offset < rows.length; offset += SQL_RESULT_PAGE_SIZE) {
    visited.push(...pageRowIndices(indices, offset, SQL_RESULT_PAGE_SIZE));
  }
  assert.deepEqual(visited, indices);
  assert.deepEqual(pageRowIndices(indices, 10_000, SQL_RESULT_PAGE_SIZE), [10_000, 10_001, 10_002]);
  assert.deepEqual(pageRowIndices(indices, 0, SQL_RESULT_PAGE_SIZE), visited.slice(0, SQL_RESULT_PAGE_SIZE));
  assert.equal(rows.length, 10_003);
});

test("SQL sorting covers the whole cached result before pagination", () => {
  const rows = Array.from({length: 10_003}, (_, id) => ({id}));
  const indices = sortRowIndices(rows, [{column: "id", direction: "desc", nulls: "last"}]);
  const first = pageRowIndices(indices, 0, SQL_RESULT_PAGE_SIZE);
  const second = pageRowIndices(indices, SQL_RESULT_PAGE_SIZE, SQL_RESULT_PAGE_SIZE);
  assert.equal(rows[first[0]].id, 10_002);
  assert.equal(rows[second[0]].id, 9502);
  assert.equal(indices.length, rows.length);
});

test("table results remain server-paginated even at nonzero offsets", () => {
  const indices = [0, 1, 2];
  assert.deepEqual(pageRowIndices(indices, 100), indices);
});

test("empty SQL results and an exact full final page have no phantom rows", () => {
  assert.deepEqual(pageRowIndices([], 0, SQL_RESULT_PAGE_SIZE), []);
  const indices = Array.from({length: SQL_RESULT_PAGE_SIZE * 2}, (_, id) => id);
  assert.equal(pageRowIndices(indices, SQL_RESULT_PAGE_SIZE, SQL_RESULT_PAGE_SIZE).length, SQL_RESULT_PAGE_SIZE);
  assert.deepEqual(pageRowIndices(indices, indices.length, SQL_RESULT_PAGE_SIZE), []);
});

test("MySQL decimal and unsigned bigint result strings sort without rounding", () => {
  const values = ["18446744073709551615", "0.1", "-2", "12345678901234567890.1234567891", "0.01", "-10", "12345678901234567890.1234567890", "18446744073709551614", "0.000", "-0"];
  const rows = values.map((value) => ({value}));
  const indices = sortRowIndices(rows, [{column:"value", direction:"asc", nulls:"last"}]);
  assert.deepEqual(indices.map((index) => rows[index].value), ["-10", "-2", "0.000", "-0", "0.01", "0.1", "12345678901234567890.1234567890", "12345678901234567890.1234567891", "18446744073709551614", "18446744073709551615"]);
});
