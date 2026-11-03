import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/sql.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext}}).outputText;
const {statementForExecution} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const at = (sql, position) => statementForExecution(sql, position, position);

const preceding = "-- ロックの確認\nSELECT a.pid FROM pg_stat_activity a\nWHERE a.wait_event_type = 'Lock'";
const following = "-- 次のSQL\nSELECT pg_terminate_backend(4576)";
const sql = `${preceding};   \n\n${following};`;
const terminator = sql.indexOf(";");

test("the final line belongs to the preceding SQL, including after its semicolon", () => {
  for (let cursor = sql.indexOf("WHERE"); cursor <= terminator + 4; cursor++) {
    assert.equal(at(sql, cursor), preceding, `cursor ${cursor}`);
  }
});

test("a caret inside the following statement still selects that statement", () => {
  assert.equal(at(sql, sql.indexOf("pg_terminate_backend") + 5), following);
});

test("an explicit selection always wins", () => {
  const start = sql.indexOf("SELECT pg_");
  assert.equal(statementForExecution(sql, start, sql.length), "SELECT pg_terminate_backend(4576);");
});

test("trailing inline comments belong to the SQL ending on that line", () => {
  const sql = "SELECT 1;  -- first statement\nSELECT 2;";
  assert.equal(at(sql, sql.indexOf("\n")), "SELECT 1");
});

test("semicolons inside PostgreSQL quotes and nested comments do not split statements", () => {
  for (const expression of ["'a;b'", '"a;b"', "$$a;b$$", "$tag$a;b$tag$", "1 /* outer ; /* inner ; */ */", "1 -- ignored ;\n"]) {
    const statement = `SELECT ${expression}`;
    const sql = `${statement};\nSELECT 2;`;
    assert.equal(at(sql, statement.length + 1), statement.trim());
  }
});

test("multiple statements on the same line and end of document remain correct", () => {
  const sql = "SELECT 1; SELECT 2;";
  assert.equal(at(sql, sql.indexOf("2")), "SELECT 2");
  assert.equal(at(sql, sql.length), "SELECT 2");
  assert.equal(at("SELECT 1;\n\n", 11), "SELECT 1");
  assert.equal(at("", 0), "");
});
