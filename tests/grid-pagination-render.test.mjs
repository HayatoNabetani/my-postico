import assert from "node:assert/strict";
import {test} from "node:test";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {createServer} from "vite";

test("DataGrid renders cached result boundaries and keeps table paging unchanged", async () => {
  const server = await createServer({server: {middlewareMode: true, ws: false}, appType: "custom"});
  try {
    const {DataGrid} = await server.ssrLoadModule("/src/components/DataGrid.tsx");
    const rows = Array.from({length: 10_003}, (_, index) => ({id: index + 1}));
    const props = {
      layoutKey: "pagination-test",
      page: {columns: ["id"], rows, hasMore: false, sqlPreview: "SELECT id"},
      loading: false, cachedPageSize: 500,
      onPrevious() {}, onNext() {}, onQuickFilter() {},
    };
    const render = (overrides) => renderToStaticMarkup(React.createElement(DataGrid, {...props, ...overrides}));
    const first = render({offset: 0});
    assert.ok(first.includes("1–500 / 10,003件"));
    assert.match(first, /disabled="">前へ/);
    assert.doesNotMatch(first, /disabled="">次へ/);
    // Virtual spacers must cover this page only, not all cached rows.
    const heights = [...first.matchAll(/height:(\d+)px/g)].map((match) => Number(match[1]));
    assert.ok(heights.length > 0);
    assert.ok(heights.every((height) => height <= 500 * 31));

    const last = render({offset: 10_000});
    assert.ok(last.includes("10001–10003 / 10,003件"));
    assert.match(last, /disabled="">次へ/);
    assert.doesNotMatch(last, /disabled="">前へ/);
    assert.equal((last.match(/class="row-number"/g) ?? []).length, 4);
    assert.match(last, />10003<\/td>/);

    const empty = render({page: {...props.page, rows: []}, offset: 0});
    assert.ok(empty.includes("0–0 / 0件"));
    assert.match(empty, /disabled="">次へ/);

    const table = render({cachedPageSize: undefined, page: {...props.page, rows: rows.slice(100, 200), hasMore: true}, offset: 100});
    assert.ok(table.includes("101–200"));
    assert.doesNotMatch(table, /disabled="">次へ/);
  } finally {
    await server.close();
  }
});
