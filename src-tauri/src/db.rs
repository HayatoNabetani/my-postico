use crate::{filters, models::{ColumnInfo, ConnectionProfile, FilterNode, ForeignKeyInfo, QueryPage, SchemaInfo, TableInfo}, ssh::SshTunnel, store};
use native_tls::TlsConnector;
use postgres::{Client, Config, NoTls, config::SslMode, types::ToSql};
use postgres_native_tls::MakeTlsConnector;
use serde_json::Value;
use std::error::Error;

pub struct ConnectedDb {
    pub client: Client,
    pub _tunnel: Option<SshTunnel>,
    pub read_only: bool,
}

const TABLE_PAGE_SIZE: u32 = 100;

fn quote_identifier(value: &str) -> String { format!("\"{}\"", value.replace('"', "\"\"")) }

fn error_message(error: &(dyn Error + 'static)) -> String {
    let mut messages = vec![error.to_string()];
    let mut source = error.source();
    while let Some(cause) = source {
        let message = cause.to_string();
        if !messages.contains(&message) { messages.push(message); }
        source = cause.source();
    }
    messages.join(": ")
}

pub fn connect(profile: &ConnectionProfile) -> Result<ConnectedDb, String> {
    let tunnel = if profile.ssh.enabled { Some(SshTunnel::start(profile)?) } else { None };
    let mut config = Config::new();
    config.host(&profile.host).port(tunnel.as_ref().map(SshTunnel::local_port).unwrap_or(profile.port)).dbname(&profile.database).user(&profile.username).connect_timeout(std::time::Duration::from_secs(12));
    if tunnel.is_some() { config.hostaddr(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)); }
    config.ssl_mode(match profile.ssl_mode.as_str() { "disable" => SslMode::Disable, "require" | "verifyFull" => SslMode::Require, _ => SslMode::Prefer });
    if let Some(password) = store::get_secret(&profile.id, "db-password") { config.password(password); }
    let mut client = if profile.ssl_mode == "disable" {
        config.connect(NoTls).map_err(|e| format!("PostgreSQL接続エラー: {}", error_message(&e)))?
    } else {
        let mut builder = TlsConnector::builder();
        // libpq's `require` encrypts the connection but only `verify-full`
        // validates the certificate chain and server name. Keep the UI modes
        // compatible with those semantics, especially for private RDS CAs.
        if profile.ssl_mode != "verifyFull" {
            builder.danger_accept_invalid_certs(true);
            builder.danger_accept_invalid_hostnames(true);
        }
        let connector = builder.build().map_err(|e| format!("TLS設定エラー: {}", error_message(&e)))?;
        config.connect(MakeTlsConnector::new(connector)).map_err(|e| format!("PostgreSQL SSL接続エラー: {}", error_message(&e)))?
    };
    if profile.read_only { client.batch_execute("SET default_transaction_read_only = on").map_err(|e| e.to_string())?; }
    Ok(ConnectedDb { client, _tunnel: tunnel, read_only: profile.read_only })
}

pub fn schemas(client: &mut Client) -> Result<Vec<SchemaInfo>, String> {
    client.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg\\_%' AND schema_name <> 'information_schema' ORDER BY schema_name", &[])
        .map_err(|e| e.to_string()).map(|rows| rows.into_iter().map(|row| SchemaInfo { name: row.get(0) }).collect())
}

pub fn tables(client: &mut Client, schema: &str) -> Result<Vec<TableInfo>, String> {
    client.query("SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name", &[&schema])
        .map_err(|e| e.to_string()).map(|rows| rows.into_iter().map(|row| {
            let kind: String = row.get(2);
            TableInfo { schema: row.get(0), name: row.get(1), kind: if kind == "VIEW" { "view".into() } else { "table".into() } }
        }).collect())
}

pub fn columns(client: &mut Client, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let sql = r#"
      SELECT c.column_name, c.data_type, c.is_nullable = 'YES',
        EXISTS (
          SELECT 1 FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
          WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = c.table_schema
            AND tc.table_name = c.table_name AND kcu.column_name = c.column_name
        ), fk.foreign_schema, fk.foreign_table, fk.foreign_column
      FROM information_schema.columns c
      LEFT JOIN LATERAL (
        SELECT ref_ns.nspname AS foreign_schema,
               ref_rel.relname AS foreign_table,
               ref_att.attname AS foreign_column
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class src_rel ON src_rel.oid = con.conrelid
        JOIN pg_catalog.pg_namespace src_ns ON src_ns.oid = src_rel.relnamespace
        JOIN LATERAL generate_subscripts(con.conkey, 1) AS key_pos(position) ON TRUE
        JOIN pg_catalog.pg_attribute src_att
          ON src_att.attrelid = con.conrelid
         AND src_att.attnum = con.conkey[key_pos.position]
        JOIN pg_catalog.pg_class ref_rel ON ref_rel.oid = con.confrelid
        JOIN pg_catalog.pg_namespace ref_ns ON ref_ns.oid = ref_rel.relnamespace
        JOIN pg_catalog.pg_attribute ref_att
          ON ref_att.attrelid = con.confrelid
         AND ref_att.attnum = con.confkey[key_pos.position]
        WHERE con.contype = 'f'
          AND src_ns.nspname = c.table_schema
          AND src_rel.relname = c.table_name
          AND src_att.attname = c.column_name
        ORDER BY ref_ns.nspname, ref_rel.relname, ref_att.attname
        LIMIT 1
      ) fk ON TRUE
      WHERE c.table_schema = $1 AND c.table_name = $2
      ORDER BY c.ordinal_position
    "#;
    client.query(sql, &[&schema, &table]).map_err(|e| e.to_string()).map(|rows| rows.into_iter().map(|row| ColumnInfo {
        name: row.get(0), data_type: row.get(1), nullable: row.get(2), primary_key: row.get(3),
        foreign_key: match (row.get::<_, Option<String>>(4), row.get::<_, Option<String>>(5), row.get::<_, Option<String>>(6)) {
            (Some(schema), Some(table), Some(column)) => Some(ForeignKeyInfo { schema, table, column }),
            _ => None,
        },
    }).collect())
}

pub fn query_table(client: &mut Client, schema: &str, table: &str, filter: &FilterNode, offset: u32) -> Result<QueryPage, String> {
    let columns = columns(client, schema, table)?;
    let compiled = filters::compile(filter, &columns)?;
    let order = columns.iter().filter(|c| c.primary_key).map(|c| quote_identifier(&c.name)).collect::<Vec<_>>();
    let order_sql = if order.is_empty() { "ctid".into() } else { order.join(", ") };
    let qualified = format!("{}.{}", quote_identifier(schema), quote_identifier(table));
    // Fetch one extra row to determine whether a next page exists. This avoids
    // an expensive COUNT(*) while keeping the visible page capped at 100 rows.
    let sql = format!("SELECT to_jsonb(__mp_row) FROM (SELECT * FROM {qualified} WHERE {} ORDER BY {order_sql} LIMIT {} OFFSET {offset}) __mp_row", compiled.sql, TABLE_PAGE_SIZE + 1);
    let refs: Vec<&(dyn ToSql + Sync)> = compiled.params.iter().map(|value| value as &(dyn ToSql + Sync)).collect();
    let mut rows = client.query(&sql, &refs).map_err(|e| format!("フィルター実行エラー: {e}"))?.into_iter().map(|row| row.get::<_, Value>(0).as_object().cloned().unwrap_or_default()).collect::<Vec<_>>();
    let has_more = rows.len() > TABLE_PAGE_SIZE as usize;
    if has_more { rows.pop(); }
    Ok(QueryPage { columns: columns.into_iter().map(|c| c.name).collect(), rows, has_more, sql_preview: format!("SELECT * FROM {qualified} WHERE {} ORDER BY {order_sql} LIMIT {TABLE_PAGE_SIZE} OFFSET {offset}", compiled.sql) })
}

pub fn execute_sql(client: &mut Client, sql: &str, read_only: bool) -> Result<QueryPage, String> {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    if trimmed.is_empty() { return Err("SQLを入力してください".into()); }
    let first = trimmed.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
    if !matches!(first.as_str(), "select" | "with" | "values") {
        return Err(if read_only { "読み取り専用接続では書き込みSQLを実行できません".into() } else { "現在のMVPではSQLエディタからの書き込みを無効化しています".into() });
    }
    let wrapped = format!("SELECT to_jsonb(__mp_sql) FROM ({trimmed}) __mp_sql LIMIT 501");
    let mut objects = client.query(&wrapped, &[]).map_err(|e| format!("SQL実行エラー: {e}"))?.into_iter().map(|row| row.get::<_, Value>(0).as_object().cloned().unwrap_or_default()).collect::<Vec<_>>();
    let has_more = objects.len() > 500; if has_more { objects.pop(); }
    let column_names = objects.first().map(|item| item.keys().cloned().collect()).unwrap_or_default();
    Ok(QueryPage { columns: column_names, rows: objects, has_more, sql_preview: trimmed.into() })
}
