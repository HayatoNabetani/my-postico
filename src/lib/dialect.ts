import type { DatabaseEngine } from "../types";

export const databaseLabels: Record<DatabaseEngine, string> = {postgres: "PostgreSQL", mysql: "MySQL", mariadb: "MariaDB"};
export type ObjectKind = "table" | "view" | "materialized_view" | "function" | "procedure" | "schema";

export function quoteIdentifier(value: string, engine: DatabaseEngine = "postgres"): string {
  const quote = engine === "postgres" ? '"' : "`";
  return quote + value.replaceAll(quote, quote + quote) + quote;
}

export function objectTemplate(kind: ObjectKind, schema: string, engine: DatabaseEngine = "postgres"): [string, string] {
  const name = (value: string) => `${quoteIdentifier(schema, engine)}.${quoteIdentifier(value, engine)}`;
  if (engine !== "postgres") {
    switch (kind) {
      case "table": return ["New Table", `CREATE TABLE ${name("new_table")} (\n  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP\n) ENGINE=InnoDB;`];
      case "view": return ["New View", `CREATE VIEW ${name("new_view")} AS\nSELECT 1 AS value;`];
      case "function": return ["New Function", `CREATE FUNCTION ${name("new_function")}()\nRETURNS INTEGER\nDETERMINISTIC\nRETURN 1;`];
      case "procedure": return ["New Procedure", `CREATE PROCEDURE ${name("new_procedure")}()\nSELECT 1 AS value;`];
      case "schema": return ["New Database", "CREATE DATABASE `new_database` CHARACTER SET utf8mb4;"];
      case "materialized_view": throw new Error("このDBはマテリアライズドビューに対応していません");
    }
  }
  switch (kind) {
    case "table": return ["New Table", `CREATE TABLE ${name("new_table")} (\n  "id" bigserial PRIMARY KEY,\n  "created_at" timestamptz NOT NULL DEFAULT now()\n);`];
    case "view": return ["New View", `CREATE VIEW ${name("new_view")} AS\nSELECT 1 AS "value";`];
    case "materialized_view": return ["New Materialized View", `CREATE MATERIALIZED VIEW ${name("new_materialized_view")} AS\nSELECT 1 AS "value";`];
    case "function": return ["New Function", `CREATE FUNCTION ${name("new_function")}()\nRETURNS void\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  -- 処理を記述\nEND;\n$$;`];
    case "procedure": return ["New Procedure", `CREATE PROCEDURE ${name("new_procedure")}()\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  -- 処理を記述\nEND;\n$$;`];
    case "schema": return ["New Schema", 'CREATE SCHEMA "new_schema";'];
  }
}

export function relationReferences(source: string): Array<{schema?: string; table: string; alias?: string}> {
  const identifier = '(?:`(?:``|[^`])+`|"(?:""|[^"])+"|[a-z_$][\\w$]*)';
  const pattern = new RegExp(`\\b(?:from|join)\\s+(${identifier})(?:\\s*\\.\\s*(${identifier}))?(?:\\s+(?:as\\s+)?(${identifier}))?`, "gi");
  const reserved = new Set(["where", "join", "left", "right", "full", "inner", "outer", "cross", "on", "group", "order", "limit", "offset", "union", "having", "set", "using"]);
  const unquote = (value: string) => value.startsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value.startsWith("`") ? value.slice(1, -1).replaceAll("``", "`") : value;
  return Array.from(source.matchAll(pattern)).map((match) => {
    const alias = match[3] && unquote(match[3]);
    return {schema: match[2] ? unquote(match[1]) : undefined, table: unquote(match[2] ?? match[1]), alias: alias && !reserved.has(alias.toLowerCase()) ? alias : undefined};
  });
}
