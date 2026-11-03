//! Read catalog metadata only; no user data or DDL is executed by the diagram.
use crate::{db::ConnectedDb, models::ColumnInfo};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramTable {
    schema: String,
    name: String,
    columns: Vec<ColumnInfo>,
    external: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramForeignKey {
    name: String,
    source_schema: String,
    source_table: String,
    target_schema: String,
    target_table: String,
    columns: Vec<String>,
    target_columns: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDiagram {
    tables: Vec<DiagramTable>,
    foreign_keys: Vec<DiagramForeignKey>,
}

type ColumnRow = (String, Option<String>, String, bool, bool);
type ForeignKeyRow = (String, String, String, String, String, String, String);

fn assemble(schema: &str, columns: Vec<ColumnRow>, keys: Vec<ForeignKeyRow>) -> SchemaDiagram {
    let mut tables = BTreeMap::<(String, String), DiagramTable>::new();
    for (table, name, data_type, nullable, primary_key) in columns {
        let table = tables
            .entry((schema.into(), table.clone()))
            .or_insert_with(|| DiagramTable {
                schema: schema.into(),
                name: table,
                columns: vec![],
                external: false,
            });
        if let Some(name) = name {
            table.columns.push(ColumnInfo {
                name,
                data_type,
                nullable,
                primary_key,
                foreign_key: None,
            });
        }
    }
    let mut foreign_keys = Vec::<DiagramForeignKey>::new();
    // Catalog queries order by table, constraint, and ordinal position. Preserve
    // composite FK pairs together, including multiple FKs on the same column.
    for (name, source_schema, source_table, column, target_schema, target_table, target_column) in
        keys
    {
        if !tables.contains_key(&(source_schema.clone(), source_table.clone())) {
            continue;
        }
        tables
            .entry((target_schema.clone(), target_table.clone()))
            .or_insert_with(|| DiagramTable {
                schema: target_schema.clone(),
                name: target_table.clone(),
                columns: vec![],
                external: true,
            });
        let existing = foreign_keys.last_mut().filter(|key| {
            key.name == name
                && key.source_schema == source_schema
                && key.source_table == source_table
        });
        if let Some(key) = existing {
            key.columns.push(column);
            key.target_columns.push(target_column);
        } else {
            foreign_keys.push(DiagramForeignKey {
                name,
                source_schema,
                source_table,
                target_schema,
                target_table,
                columns: vec![column],
                target_columns: vec![target_column],
            });
        }
    }
    SchemaDiagram {
        tables: tables.into_values().collect(),
        foreign_keys,
    }
}

pub fn load(db: &mut ConnectedDb, schema: &str) -> Result<SchemaDiagram, String> {
    match db {
        ConnectedDb::Postgres(db) => load_postgres(&mut db.client, schema),
        ConnectedDb::Mysql(db) => {
            let result = load_mysql(&mut db.client, schema);
            if result
                .as_ref()
                .err()
                .is_some_and(|error| error.contains("MySQL transport error"))
            {
                db.broken = true;
            }
            result
        }
    }
}

fn load_postgres(client: &mut postgres::Client, schema: &str) -> Result<SchemaDiagram, String> {
    let columns = client.query(r#"
                SELECT c.relname::text, a.attname::text, COALESCE(pg_catalog.format_type(a.atttypid, a.atttypmod), ''),
                    COALESCE(NOT a.attnotnull, true), EXISTS (SELECT 1 FROM pg_catalog.pg_constraint pk
                        WHERE pk.conrelid = c.oid AND pk.contype = 'p' AND a.attnum = ANY(pk.conkey))
                FROM pg_catalog.pg_class c
                JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
                ORDER BY c.relname, a.attnum
            "#, &[&schema]).map_err(|e| e.to_string())?.into_iter()
                .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4))).collect();
    let keys = client.query(r#"
                SELECT fk.conname::text, sn.nspname::text, s.relname::text, sa.attname::text,
                    tn.nspname::text, t.relname::text, ta.attname::text
                FROM pg_catalog.pg_constraint fk
                JOIN pg_catalog.pg_class s ON s.oid = fk.conrelid
                JOIN pg_catalog.pg_namespace sn ON sn.oid = s.relnamespace
                JOIN pg_catalog.pg_class t ON t.oid = fk.confrelid
                JOIN pg_catalog.pg_namespace tn ON tn.oid = t.relnamespace
                JOIN LATERAL generate_subscripts(fk.conkey, 1) p(i) ON TRUE
                JOIN pg_catalog.pg_attribute sa ON sa.attrelid = s.oid AND sa.attnum = fk.conkey[p.i]
                JOIN pg_catalog.pg_attribute ta ON ta.attrelid = t.oid AND ta.attnum = fk.confkey[p.i]
                WHERE sn.nspname = $1 AND fk.contype = 'f'
                ORDER BY s.relname, fk.conname, p.i
            "#, &[&schema]).map_err(|e| e.to_string())?.into_iter()
                .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4), r.get(5), r.get(6))).collect();
    Ok(assemble(schema, columns, keys))
}

fn load_mysql(client: &mut mysql_async::Conn, schema: &str) -> Result<SchemaDiagram, String> {
    use mysql_async::prelude::Queryable;
    let result = tauri::async_runtime::block_on(async {
        let rows: Vec<(String, String, String, String, String)> = client.exec(r#"
                    SELECT c.table_name, c.column_name, c.column_type, c.is_nullable, c.column_key
                    FROM information_schema.columns c
                    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
                    WHERE c.table_schema = ? AND t.table_type IN ('BASE TABLE', 'SYSTEM VERSIONED')
                    ORDER BY c.table_name, c.ordinal_position
                "#, (schema,)).await?;
        let keys: Vec<ForeignKeyRow> = client
            .exec(
                r#"
                    SELECT constraint_name, table_schema, table_name, column_name,
                        referenced_table_schema, referenced_table_name, referenced_column_name
                    FROM information_schema.key_column_usage
                    WHERE table_schema = ? AND referenced_table_name IS NOT NULL
                    ORDER BY table_name, constraint_name, ordinal_position
                "#,
                (schema,),
            )
            .await?;
        Ok::<_, mysql_async::Error>(assemble(
            schema,
            rows.into_iter()
                .map(|(t, n, d, nullable, pk)| (t, Some(n), d, nullable == "YES", pk == "PRI"))
                .collect(),
            keys,
        ))
    });
    result.map_err(|error| {
        if error.is_fatal() {
            format!("ER図のメタデータ取得エラー: MySQL transport error: {error}")
        } else {
            format!("ER図のメタデータ取得エラー: {error}")
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check_catalog(diagram: &SchemaDiagram, schema: &str, external_schema: &str) {
        let child = diagram.tables.iter().find(|t| t.name == "child").unwrap();
        assert!(child
            .columns
            .iter()
            .any(|c| c.name == "id" && c.primary_key));
        assert!(child
            .columns
            .iter()
            .any(|c| c.name == "parent_id" && c.nullable));
        assert!(!diagram.tables.iter().any(|t| t.name == "child_view"));
        assert!(diagram
            .tables
            .iter()
            .any(|t| t.schema == external_schema && t.external));
        let key = diagram
            .foreign_keys
            .iter()
            .find(|key| key.name == "composite_fk")
            .unwrap();
        assert_eq!(key.source_schema, schema);
        assert_eq!(key.columns, ["tenant_id", "parent_id"]);
        assert_eq!(key.target_columns, ["tenant_id", "id"]);
        assert_eq!(diagram.foreign_keys.len(), 4);
        assert!(diagram
            .foreign_keys
            .iter()
            .any(|key| key.source_table == key.target_table));
    }

    fn fixture(schema: &str, external: &str, quote: char) -> String {
        let s = format!("{quote}{schema}{quote}");
        let e = format!("{quote}{external}{quote}");
        format!("CREATE TABLE {e}.parent(id integer PRIMARY KEY);
            CREATE TABLE {s}.parent(id integer PRIMARY KEY, tenant_id integer NOT NULL, UNIQUE(tenant_id,id));
            CREATE TABLE {s}.child(id integer PRIMARY KEY, tenant_id integer, parent_id integer, manager_id integer, external_id integer,
                CONSTRAINT composite_fk FOREIGN KEY(tenant_id,parent_id) REFERENCES {s}.parent(tenant_id,id),
                CONSTRAINT shared_column_fk FOREIGN KEY(parent_id) REFERENCES {s}.parent(id),
                CONSTRAINT self_fk FOREIGN KEY(manager_id) REFERENCES {s}.child(id),
                CONSTRAINT external_fk FOREIGN KEY(external_id) REFERENCES {e}.parent(id));
            CREATE VIEW {s}.child_view AS SELECT id FROM {s}.child;")
    }

    #[test]
    #[ignore = "requires MY_POSTICO_TEST_DATABASE_URL pointing to a disposable PostgreSQL database"]
    fn postgres_catalog_diagram() {
        let mut client = postgres::Client::connect(
            &std::env::var("MY_POSTICO_TEST_DATABASE_URL").unwrap(),
            postgres::NoTls,
        )
        .unwrap();
        let schema = format!("er_{}", uuid::Uuid::new_v4().simple());
        let external = format!("{schema}_ext");
        client
            .batch_execute(&format!(
                "CREATE SCHEMA {schema}; CREATE SCHEMA {external};"
            ))
            .unwrap();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client
                .batch_execute(&fixture(&schema, &external, '"'))
                .unwrap();
            client
                .batch_execute(&format!(
                    "CREATE TABLE {schema}.zero_columns(); BEGIN READ ONLY;"
                ))
                .unwrap();
            let diagram = load_postgres(&mut client, &schema).unwrap();
            check_catalog(&diagram, &schema, &external);
            assert!(diagram
                .tables
                .iter()
                .any(|t| t.name == "zero_columns" && t.columns.is_empty() && !t.external));
            assert!(load_postgres(&mut client, "' OR '1'='1")
                .unwrap()
                .tables
                .is_empty());
            client.batch_execute("COMMIT").unwrap();
        }));
        client
            .batch_execute(&format!(
                "ROLLBACK; DROP SCHEMA {schema} CASCADE; DROP SCHEMA {external} CASCADE;"
            ))
            .unwrap();
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }

    #[test]
    #[ignore = "requires MY_POSTICO_TEST_MYSQL_URL pointing to a disposable MySQL or MariaDB database"]
    fn mysql_catalog_diagram() {
        use mysql_async::prelude::Queryable;
        let opts =
            mysql_async::Opts::from_url(&std::env::var("MY_POSTICO_TEST_MYSQL_URL").unwrap())
                .unwrap();
        let mut client = tauri::async_runtime::block_on(mysql_async::Conn::new(opts)).unwrap();
        let schema = format!("er_{}", uuid::Uuid::new_v4().simple());
        let external = format!("{schema}_ext");
        let run = |client: &mut mysql_async::Conn, sql: &str| {
            tauri::async_runtime::block_on(client.query_drop(sql)).unwrap()
        };
        run(&mut client, &format!("CREATE DATABASE {schema}"));
        run(&mut client, &format!("CREATE DATABASE {external}"));
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            for sql in fixture(&schema, &external, '`')
                .split(';')
                .filter(|s| !s.trim().is_empty())
            {
                run(&mut client, sql);
            }
            run(&mut client, "START TRANSACTION READ ONLY");
            check_catalog(
                &load_mysql(&mut client, &schema).unwrap(),
                &schema,
                &external,
            );
            assert!(load_mysql(&mut client, "' OR '1'='1")
                .unwrap()
                .tables
                .is_empty());
            run(&mut client, "COMMIT");
        }));
        run(&mut client, "ROLLBACK");
        run(&mut client, &format!("DROP DATABASE {schema}"));
        run(&mut client, &format!("DROP DATABASE {external}"));
        tauri::async_runtime::block_on(client.disconnect()).unwrap();
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }

    #[test]
    fn composite_keys_multiple_constraints_and_external_targets_are_preserved() {
        let columns = vec![(
            "child".into(),
            Some("a".into()),
            "integer".into(),
            false,
            true,
        )];
        let keys = vec![
            ("fk1", "s", "child", "a", "s", "parent", "x"),
            ("fk1", "s", "child", "b", "s", "parent", "y"),
            ("fk2", "s", "child", "a", "other", "parent", "id"),
        ]
        .into_iter()
        .map(|(a, b, c, d, e, f, g)| {
            (
                a.into(),
                b.into(),
                c.into(),
                d.into(),
                e.into(),
                f.into(),
                g.into(),
            )
        })
        .collect();
        let diagram = assemble("s", columns, keys);
        assert_eq!(diagram.foreign_keys.len(), 2);
        assert_eq!(diagram.foreign_keys[0].columns, ["a", "b"]);
        assert_eq!(diagram.foreign_keys[0].target_columns, ["x", "y"]);
        assert_eq!(diagram.tables.len(), 3);
        assert_eq!(diagram.tables.iter().filter(|t| t.external).count(), 2);
    }
}
