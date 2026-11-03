import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import ts from "typescript";
const load = async (name) => {
  const source = await readFile(new URL(`../src/lib/${name}.ts`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext}}).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
};
const {quoteIdentifier, objectTemplate, relationReferences} = await load("dialect");
const {statementForExecution} = await load("sql");

test("identifiers and templates follow the selected database", () => {
  assert.equal(quoteIdentifier('a"b'), '"a""b"');
  for (const engine of ["mysql", "mariadb"]) {
    assert.equal(quoteIdentifier("a`b", engine), "`a``b`");
    assert.match(objectTemplate("table", "db`name", engine)[1], /`db``name`\.`new_table`/);
    assert.match(objectTemplate("table", "db", engine)[1], /AUTO_INCREMENT/);
    assert.match(objectTemplate("procedure", "db", engine)[1], /CREATE PROCEDURE `db`/);
    assert.throws(() => objectTemplate("materialized_view", "db", engine));
  }
  assert.match(objectTemplate("function", "public")[1], /LANGUAGE plpgsql/);
  assert.match(objectTemplate("materialized_view", "public")[1], /CREATE MATERIALIZED VIEW/);
});

test("SQL statements respect MySQL backticks, hash comments, and escaped quotes", () => {
  for (const engine of ["mysql", "mariadb"]) {
    for (const expression of ["`a;b`", "`a``;b`", "'a;\\'b'", "'a\\\\'", "1 # ignored ;\n", "1 -- ignored ;\n"]) {
      const statement = `SELECT ${expression}`;
      const source = `${statement};\nSELECT 2;`;
      assert.equal(statementForExecution(source, 0, 0, engine), statement.trim(), expression);
    }
    assert.equal(statementForExecution("SELECT 1--2; SELECT 3", 0, 0, engine), "SELECT 1--2");
    assert.equal(statementForExecution("SELECT 1; SELECT 2", 0, 18, engine), "SELECT 1; SELECT 2");
  }
});

test("completion resolves quoted database, table, and alias names", () => {
  assert.deepEqual(relationReferences("SELECT * FROM `a``b`.`some table` AS `u` JOIN other o ON u.id=o.id"), [
    {schema: "a`b", table: "some table", alias: "u"}, {schema: undefined, table: "other", alias: "o"},
  ]);
  assert.deepEqual(relationReferences('SELECT * FROM "public"."users" u WHERE u.id=1'), [{schema:"public",table:"users",alias:"u"}]);
  assert.equal(relationReferences("SELECT * FROM users WHERE id=1")[0].alias, undefined);
});
