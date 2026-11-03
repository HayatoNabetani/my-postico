use crate::{filters, models::{ColumnInfo, ConnectionProfile, FilterNode, ForeignKeyInfo, FunctionInfo, QueryPage, SchemaInfo, SortRule, TableChangeResult, TableChanges, TableInfo}, ssh::SshTunnel, store};
use native_tls::TlsConnector;
use postgres::{CancelToken, Client, Config, NoTls, config::SslMode, types::ToSql};
use postgres_native_tls::MakeTlsConnector;
use serde_json::Value;
use std::collections::HashSet;
use std::error::Error;

pub struct ConnectedDb {
    pub client: Client,
    pub _tunnel: Option<SshTunnel>,
    pub read_only: bool,
    pub ssl_mode: String,
}

#[derive(Clone)]
pub struct QueryCancel {
    token: CancelToken,
    ssl_mode: String,
}

impl QueryCancel {
    pub fn cancel(&self) -> Result<(), String> {
        if self.ssl_mode == "disable" {
            self.token.cancel_query(NoTls).map_err(|error| format!("SQLキャンセルエラー: {}", error_message(&error)))
        } else {
            let mut builder = TlsConnector::builder();
            if self.ssl_mode != "verifyFull" {
                builder.danger_accept_invalid_certs(true);
                builder.danger_accept_invalid_hostnames(true);
            }
            let connector = builder.build().map_err(|error| format!("キャンセル用TLS設定エラー: {error}"))?;
            self.token.cancel_query(MakeTlsConnector::new(connector)).map_err(|error| format!("SQLキャンセルエラー: {}", error_message(&error)))
        }
    }
}

impl ConnectedDb {
    pub fn cancel_request(&self) -> QueryCancel {
        QueryCancel {token: self.client.cancel_token(), ssl_mode: self.ssl_mode.clone()}
    }
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

fn postgres_error(context: &str, error: &postgres::Error) -> String {
    let Some(database_error) = error.as_db_error() else { return format!("{context}: {}", error_message(error)); };
    let mut lines = vec![format!("{context}: {}", database_error.message()), format!("SQLSTATE: {}", database_error.code().code())];
    if let Some(detail) = database_error.detail() { lines.push(format!("詳細: {detail}")); }
    if let Some(hint) = database_error.hint() { lines.push(format!("ヒント: {hint}")); }
    lines.join("\n")
}

pub fn connect(profile: &ConnectionProfile) -> Result<ConnectedDb, String> {
    let tunnel = if profile.ssh.enabled { Some(SshTunnel::start(profile)?) } else { None };
    let mut config = Config::new();
    config.host(&profile.host)
        .port(tunnel.as_ref().map(SshTunnel::local_port).unwrap_or(profile.port))
        .dbname(&profile.database)
        .user(&profile.username)
        .connect_timeout(std::time::Duration::from_secs(12))
        .keepalives(true)
        .keepalives_idle(std::time::Duration::from_secs(30));
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
    Ok(ConnectedDb { client, _tunnel: tunnel, read_only: profile.read_only, ssl_mode: profile.ssl_mode.clone() })
}

pub fn schemas(client: &mut Client) -> Result<Vec<SchemaInfo>, String> {
    client.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg\\_%' AND schema_name <> 'information_schema' ORDER BY schema_name", &[])
        .map_err(|e| e.to_string()).map(|rows| rows.into_iter().map(|row| SchemaInfo { name: row.get(0) }).collect())
}

pub fn tables(client: &mut Client, schema: &str) -> Result<Vec<TableInfo>, String> {
    client.query("SELECT n.nspname, c.relname, CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view' ELSE 'table' END FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm') ORDER BY c.relname", &[&schema])
        .map_err(|e| e.to_string()).map(|rows| rows.into_iter().map(|row| TableInfo { schema: row.get(0), name: row.get(1), kind: row.get(2) }).collect())
}

pub fn functions(client: &mut Client, schema: &str) -> Result<Vec<FunctionInfo>, String> {
    client.query(
        "SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid), CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.prokind IN ('f', 'p') ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)",
        &[&schema],
    ).map_err(|e| e.to_string()).map(|rows| rows.into_iter().map(|row| FunctionInfo {
        schema: row.get(0), name: row.get(1), arguments: row.get(2), return_type: row.get(3), kind: row.get(4),
    }).collect())
}

pub fn function_ddl(client: &mut Client, schema: &str, name: &str, arguments: &str) -> Result<String, String> {
    client.query_opt(
        "SELECT pg_get_functiondef(p.oid) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2 AND pg_get_function_identity_arguments(p.oid) = $3",
        &[&schema, &name, &arguments],
    ).map_err(|e| e.to_string())?.map(|row| row.get(0)).ok_or_else(|| "関数またはプロシージャが見つかりません".into())
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

pub fn table_ddl(client: &mut Client, schema: &str, table: &str) -> Result<String, String> {
    let relation = client.query_one(
        "SELECT c.relkind::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2",
        &[&schema, &table],
    ).map_err(|e| postgres_error("テーブル情報取得エラー", &e))?;
    let relkind: String = relation.get(0);
    let qualified = format!("{}.{}", quote_identifier(schema), quote_identifier(table));
    if matches!(relkind.as_str(), "v" | "m") {
        let row = client.query_one("SELECT pg_get_viewdef(format('%I.%I', $1, $2)::regclass, true)", &[&schema, &table])
            .map_err(|e| postgres_error("ビューDDL取得エラー", &e))?;
        let definition: String = row.get(0);
        return Ok(format!("CREATE {}VIEW {qualified} AS\n{};", if relkind == "m" { "MATERIALIZED " } else { "" }, definition.trim_end_matches(';')));
    }

    let column_rows = client.query(r#"
        SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), a.attnotnull,
               pg_catalog.pg_get_expr(d.adbin, d.adrelid)
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
    "#, &[&schema, &table]).map_err(|e| postgres_error("カラムDDL取得エラー", &e))?;
    let mut definitions = column_rows.into_iter().map(|row| {
        let name: String = row.get(0);
        let data_type: String = row.get(1);
        let not_null: bool = row.get(2);
        let default_value: Option<String> = row.get(3);
        format!("  {} {}{}{}", quote_identifier(&name), data_type, default_value.map(|value| format!(" DEFAULT {value}")).unwrap_or_default(), if not_null { " NOT NULL" } else { "" })
    }).collect::<Vec<_>>();
    let constraints = client.query(r#"
        SELECT con.conname, pg_catalog.pg_get_constraintdef(con.oid, true)
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2
        ORDER BY CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 ELSE 3 END, con.conname
    "#, &[&schema, &table]).map_err(|e| postgres_error("制約DDL取得エラー", &e))?;
    definitions.extend(constraints.into_iter().map(|row| {
        let name: String = row.get(0);
        let definition: String = row.get(1);
        format!("  CONSTRAINT {} {definition}", quote_identifier(&name))
    }));
    let mut ddl = format!("CREATE TABLE {qualified} (\n{}\n);", definitions.join(",\n"));
    let indexes = client.query(r#"
        SELECT pg_catalog.pg_get_indexdef(i.indexrelid)
        FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con WHERE con.conindid = i.indexrelid)
        ORDER BY i.indexrelid::regclass::text
    "#, &[&schema, &table]).map_err(|e| postgres_error("インデックスDDL取得エラー", &e))?;
    for row in indexes {
        let definition: String = row.get(0);
        ddl.push_str("\n\n"); ddl.push_str(&definition); ddl.push(';');
    }
    Ok(ddl)
}

fn compile_order(columns: &[ColumnInfo], sorts: &[SortRule]) -> Result<String, String> {
    let available = columns.iter().map(|column| column.name.as_str()).collect::<HashSet<_>>();
    let mut selected = HashSet::new();
    let mut parts = Vec::new();
    for sort in sorts {
        if !available.contains(sort.column.as_str()) { return Err(format!("ソート対象のカラム「{}」は現在のテーブルに存在しません", sort.column)); }
        if !selected.insert(sort.column.as_str()) { return Err(format!("カラム「{}」が複数回ソートに指定されています", sort.column)); }
        let direction = match sort.direction.as_str() { "asc" => "ASC", "desc" => "DESC", _ => return Err("不正なソート方向です".into()) };
        let nulls = match sort.nulls.as_str() { "first" => "FIRST", "last" => "LAST", _ => return Err("不正なNULLの並び順です".into()) };
        parts.push(format!("{} {direction} NULLS {nulls}", quote_identifier(&sort.column)));
    }
    for column in columns.iter().filter(|column| column.primary_key && !selected.contains(column.name.as_str())) {
        parts.push(format!("{} ASC", quote_identifier(&column.name)));
    }
    if parts.is_empty() { parts.push("ctid".into()); }
    Ok(parts.join(", "))
}

pub fn query_table(client: &mut Client, schema: &str, table: &str, filter: &FilterNode, sorts: &[SortRule], offset: u32) -> Result<QueryPage, String> {
    let columns = columns(client, schema, table)?;
    let compiled = filters::compile(filter, &columns)?;
    let order_sql = compile_order(&columns, sorts)?;
    let qualified = format!("{}.{}", quote_identifier(schema), quote_identifier(table));
    // Fetch one extra row to determine whether a next page exists. This avoids
    // an expensive COUNT(*) while keeping the visible page capped at 100 rows.
    let sql = format!("SELECT to_jsonb(__mp_row) FROM (SELECT * FROM {qualified} WHERE {} ORDER BY {order_sql} LIMIT {} OFFSET {offset}) __mp_row", compiled.sql, TABLE_PAGE_SIZE + 1);
    let refs: Vec<&(dyn ToSql + Sync)> = compiled.params.iter().map(|value| value as &(dyn ToSql + Sync)).collect();
    let mut rows = client.query(&sql, &refs).map_err(|e| postgres_error("フィルター実行エラー", &e))?.into_iter().map(|row| row.get::<_, Value>(0).as_object().cloned().unwrap_or_default()).collect::<Vec<_>>();
    let has_more = rows.len() > TABLE_PAGE_SIZE as usize;
    if has_more { rows.pop(); }
    let preview_filter = filters::inline_parameters(&compiled.sql, &compiled.params);
    Ok(QueryPage { columns: columns.into_iter().map(|c| c.name).collect(), rows, has_more, sql_preview: format!("SELECT * FROM {qualified} WHERE {preview_filter} ORDER BY {order_sql} LIMIT {TABLE_PAGE_SIZE} OFFSET {offset}") })
}

fn editable_value(value: &Value) -> Result<String, String> {
    match value {
        Value::String(value) => Ok(value.clone()),
        Value::Number(value) => Ok(value.to_string()),
        Value::Bool(value) => Ok(value.to_string()),
        Value::Null => Err("NULL".into()),
        _ => serde_json::to_string(value).map_err(|e| e.to_string()),
    }
}

fn leading_sql_keyword(sql: &str) -> &str {
    let bytes = sql.as_bytes();
    let mut index = 0;
    loop {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() { index += 1; }
        if index + 1 < bytes.len() && bytes[index] == b'-' && bytes[index + 1] == b'-' {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' { index += 1; }
            continue;
        }
        if index + 1 < bytes.len() && bytes[index] == b'/' && bytes[index + 1] == b'*' {
            index += 2;
            let mut depth = 1;
            while index + 1 < bytes.len() && depth > 0 {
                if bytes[index] == b'/' && bytes[index + 1] == b'*' { depth += 1; index += 2; }
                else if bytes[index] == b'*' && bytes[index + 1] == b'/' { depth -= 1; index += 2; }
                else { index += 1; }
            }
            continue;
        }
        break;
    }
    let start = index;
    while index < bytes.len() && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_') { index += 1; }
    &sql[start..index]
}

fn explained_statement_keyword(sql: &str) -> Option<String> {
    sql.split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
        .filter(|token| !token.is_empty())
        .map(str::to_ascii_lowercase)
        .skip(1)
        .find(|token| matches!(token.as_str(), "select" | "with" | "values" | "insert" | "update" | "delete" | "merge"))
}

pub fn apply_table_changes(client: &mut Client, schema: &str, table: &str, changes: TableChanges, read_only: bool) -> Result<TableChangeResult, String> {
    if read_only { return Err("読み取り専用接続ではテーブルを編集できません".into()); }
    if changes.updates.is_empty() && changes.inserts.is_empty() && changes.deletes.is_empty() {
        return Ok(TableChangeResult { inserted: 0, updated: 0, deleted: 0 });
    }
    let columns = columns(client, schema, table)?;
    let primary_keys = columns.iter().filter(|column| column.primary_key).collect::<Vec<_>>();
    if primary_keys.is_empty() && (!changes.updates.is_empty() || !changes.deletes.is_empty()) {
        return Err("主キーがないテーブルは安全に更新・削除できません".into());
    }
    let column_lookup = columns.iter().map(|column| (column.name.as_str(), column)).collect::<std::collections::HashMap<_, _>>();
    let qualified = format!("{}.{}", quote_identifier(schema), quote_identifier(table));
    let mut transaction = client.transaction().map_err(|e| postgres_error("変更トランザクションを開始できません", &e))?;
    let mut inserted = 0;
    let mut updated = 0;
    let mut deleted = 0;

    for values in changes.inserts {
        let affected = if values.is_empty() {
            transaction.execute(&format!("INSERT INTO {qualified} DEFAULT VALUES"), &[])
        } else {
            let mut params = Vec::<String>::new();
            let mut names = Vec::new();
            let mut placeholders = Vec::new();
            for (name, value) in &values {
                let column = column_lookup.get(name.as_str()).ok_or_else(|| format!("カラム「{name}」は現在のテーブルに存在しません"))?;
                names.push(quote_identifier(name));
                if value.is_null() {
                    if !column.nullable { return Err(format!("カラム「{name}」はNULLにできません")); }
                    placeholders.push("NULL".into());
                } else {
                    params.push(editable_value(value)?);
                    placeholders.push(filters::typed_parameter(params.len(), &column.data_type));
                }
            }
            let sql = format!("INSERT INTO {qualified} ({}) VALUES ({})", names.join(", "), placeholders.join(", "));
            let refs = params.iter().map(|value| value as &(dyn ToSql + Sync)).collect::<Vec<_>>();
            transaction.execute(&sql, &refs)
        }.map_err(|e| postgres_error("行追加エラー", &e))?;
        if affected != 1 { return Err(format!("追加対象が1行になりませんでした（{affected}行）")); }
        inserted += affected;
    }

    for update in changes.updates {
        if update.values.is_empty() { continue; }
        let mut params = Vec::<String>::new();
        let mut assignments = Vec::new();
        for (name, value) in &update.values {
            let column = column_lookup.get(name.as_str()).ok_or_else(|| format!("カラム「{name}」は現在のテーブルに存在しません"))?;
            if value.is_null() {
                if !column.nullable { return Err(format!("カラム「{name}」はNULLにできません")); }
                assignments.push(format!("{} = NULL", quote_identifier(name)));
            } else {
                params.push(editable_value(value)?);
                assignments.push(format!("{} = {}", quote_identifier(name), filters::typed_parameter(params.len(), &column.data_type)));
            }
        }

        let mut predicates = Vec::new();
        for column in &primary_keys {
            let value = update.primary_key.get(&column.name).ok_or_else(|| format!("主キー「{}」の元の値がありません", column.name))?;
            params.push(editable_value(value).map_err(|_| format!("主キー「{}」がNULLです", column.name))?);
            predicates.push(format!("{} = {}", quote_identifier(&column.name), filters::typed_parameter(params.len(), &column.data_type)));
        }
        let sql = format!("UPDATE {qualified} SET {} WHERE {}", assignments.join(", "), predicates.join(" AND "));
        let refs = params.iter().map(|value| value as &(dyn ToSql + Sync)).collect::<Vec<_>>();
        let affected = transaction.execute(&sql, &refs).map_err(|e| postgres_error("行更新エラー", &e))?;
        if affected != 1 { return Err(format!("更新対象が1行に特定できませんでした（{affected}行）")); }
        updated += affected;
    }

    for primary_key in changes.deletes {
        let mut params = Vec::<String>::new();
        let mut predicates = Vec::new();
        for column in &primary_keys {
            let value = primary_key.get(&column.name).ok_or_else(|| format!("主キー「{}」の値がありません", column.name))?;
            params.push(editable_value(value).map_err(|_| format!("主キー「{}」がNULLです", column.name))?);
            predicates.push(format!("{} = {}", quote_identifier(&column.name), filters::typed_parameter(params.len(), &column.data_type)));
        }
        let sql = format!("DELETE FROM {qualified} WHERE {}", predicates.join(" AND "));
        let refs = params.iter().map(|value| value as &(dyn ToSql + Sync)).collect::<Vec<_>>();
        let affected = transaction.execute(&sql, &refs).map_err(|e| postgres_error("行削除エラー", &e))?;
        if affected != 1 { return Err(format!("削除対象が1行に特定できませんでした（{affected}行）")); }
        deleted += affected;
    }
    transaction.commit().map_err(|e| postgres_error("変更を確定できません", &e))?;
    Ok(TableChangeResult { inserted, updated, deleted })
}

pub fn execute_sql(client: &mut Client, sql: &str, read_only: bool) -> Result<QueryPage, String> {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    if trimmed.is_empty() { return Err("SQLを入力してください".into()); }
    let first = leading_sql_keyword(trimmed).to_ascii_lowercase();
    let explain = first == "explain";
    let allowed_explain = explain && explained_statement_keyword(trimmed).is_some_and(|keyword| matches!(keyword.as_str(), "select" | "with" | "values"));
    if !matches!(first.as_str(), "select" | "with" | "values") && !allowed_explain {
        if read_only { return Err("読み取り専用接続では書き込みSQLを実行できません".into()); }
        let affected = client.execute(trimmed, &[]).map_err(|e| postgres_error("SQL実行エラー", &e))?;
        let row = serde_json::Map::from_iter([
            ("status".into(), Value::String("実行しました".into())),
            ("affected_rows".into(), Value::from(affected)),
        ]);
        return Ok(QueryPage {columns: vec!["status".into(), "affected_rows".into()], rows: vec![row], has_more: false, sql_preview: trimmed.into()});
    }
    if explain {
        let result_rows = client.query(trimmed, &[]).map_err(|e| postgres_error("EXPLAIN実行エラー", &e))?;
        let column_name = result_rows.first().and_then(|row| row.columns().first()).map(|column| column.name().to_owned()).unwrap_or_else(|| "QUERY PLAN".into());
        let rows = result_rows.into_iter().map(|row| {
            let value = if row.columns().first().is_some_and(|column| matches!(column.type_().name(), "json" | "jsonb")) {
                row.try_get::<_, Value>(0).unwrap_or(Value::Null)
            } else {
                row.try_get::<_, String>(0).map(Value::String).unwrap_or(Value::Null)
            };
            serde_json::Map::from_iter([(column_name.clone(), value)])
        }).collect();
        return Ok(QueryPage {columns: vec![column_name], rows, has_more: false, sql_preview: trimmed.into()});
    }
    // SQL results are retained by the SQL tab and paged locally. Respect only
    // limits explicitly present in the user's statement.
    let wrapped = format!("SELECT to_jsonb(__mp_sql) FROM ({trimmed}) __mp_sql");
    let objects = client.query(&wrapped, &[]).map_err(|e| postgres_error("SQL実行エラー", &e))?.into_iter().map(|row| row.get::<_, Value>(0).as_object().cloned().unwrap_or_default()).collect::<Vec<_>>();
    let column_names = objects.first().map(|item| item.keys().cloned().collect()).unwrap_or_default();
    Ok(QueryPage { columns: column_names, rows: objects, has_more: false, sql_preview: trimmed.into() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires MY_POSTICO_TEST_DATABASE_URL pointing to a test PostgreSQL instance"]
    fn sql_results_preserve_all_rows_and_explicit_limits() {
        let url = std::env::var("MY_POSTICO_TEST_DATABASE_URL").expect("set MY_POSTICO_TEST_DATABASE_URL");
        let mut client = Client::connect(&url, postgres::NoTls).unwrap();
        let sql = "SELECT id, 'item-' || id AS manage_id FROM generate_series(1, 10003) AS id ORDER BY id";
        let result = execute_sql(&mut client, sql, true).unwrap();
        assert_eq!(result.rows.len(), 10003);
        assert_eq!(result.rows.first().unwrap()["id"], 1);
        assert_eq!(result.rows.last().unwrap()["manage_id"], "item-10003");
        assert!(!result.has_more);
        assert_eq!(result.sql_preview, sql);

        let limited = execute_sql(&mut client, &format!("{sql} LIMIT 37 OFFSET 500;"), true).unwrap();
        assert_eq!(limited.rows.len(), 37);
        assert_eq!(limited.rows.first().unwrap()["id"], 501);
        let empty = execute_sql(&mut client, "SELECT 1 AS id WHERE false", true).unwrap();
        assert!(empty.rows.is_empty());
        let plan = execute_sql(&mut client, "EXPLAIN SELECT 1", true).unwrap();
        assert!(!plan.rows.is_empty());
        assert!(!plan.has_more);
    }

    fn test_columns() -> Vec<ColumnInfo> {
        vec![
            ColumnInfo { name: "id".into(), data_type: "integer".into(), nullable: false, primary_key: true, foreign_key: None },
            ColumnInfo { name: "display name".into(), data_type: "text".into(), nullable: true, primary_key: false, foreign_key: None },
        ]
    }

    #[test]
    fn compiles_validated_sort_with_primary_key_tiebreaker() {
        let sorts = vec![SortRule { column: "display name".into(), direction: "desc".into(), nulls: "last".into() }];
        assert_eq!(compile_order(&test_columns(), &sorts).unwrap(), "\"display name\" DESC NULLS LAST, \"id\" ASC");
    }

    #[test]
    fn rejects_unknown_sort_columns() {
        let sorts = vec![SortRule { column: "missing".into(), direction: "asc".into(), nulls: "last".into() }];
        assert!(compile_order(&test_columns(), &sorts).is_err());
    }

    #[test]
    fn rejects_duplicate_sort_columns() {
        let sorts = vec![
            SortRule { column: "id".into(), direction: "asc".into(), nulls: "last".into() },
            SortRule { column: "id".into(), direction: "desc".into(), nulls: "first".into() },
        ];
        assert!(compile_order(&test_columns(), &sorts).is_err());
    }

    #[test]
    fn finds_keyword_after_sql_comments() {
        assert_eq!(leading_sql_keyword("-- selected query\n SELECT 1"), "SELECT");
        assert_eq!(leading_sql_keyword("/* outer /* nested */ comment */\nwith value as (select 1) select * from value"), "with");
    }

    #[test]
    fn finds_read_only_statement_inside_explain_options() {
        assert_eq!(explained_statement_keyword("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM users").as_deref(), Some("select"));
        assert_eq!(explained_statement_keyword("EXPLAIN ANALYZE WITH rows AS (SELECT 1) SELECT * FROM rows").as_deref(), Some("with"));
        assert_eq!(explained_statement_keyword("EXPLAIN ANALYZE DELETE FROM users").as_deref(), Some("delete"));
    }
}

#[cfg(test)]
mod multi_database_regression {
    use super::*;
    use serde_json::json;
    #[test]
    #[ignore = "requires MY_POSTICO_TEST_DATABASE_URL pointing to a disposable PostgreSQL database"]
    fn postgres_catalog_filter_and_edit_regression() {
        let url = std::env::var("MY_POSTICO_TEST_DATABASE_URL").unwrap();
        let mut client = Client::connect(&url, NoTls).unwrap();
        let schema = format!("postico_test_{}", uuid::Uuid::new_v4().simple());
        let q = quote_identifier(&schema);
        client.batch_execute(&format!("CREATE SCHEMA {q}")).unwrap();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.batch_execute(&format!("CREATE TABLE {q}.parent(id integer PRIMARY KEY); INSERT INTO {q}.parent VALUES(1); CREATE TABLE {q}.items(id integer PRIMARY KEY, parent_id integer REFERENCES {q}.parent, name text UNIQUE, amount numeric); CREATE VIEW {q}.item_view AS SELECT id,name FROM {q}.items; CREATE FUNCTION {q}.sample() RETURNS integer LANGUAGE sql AS 'SELECT 42'" )).unwrap();
            assert!(schemas(&mut client).unwrap().iter().any(|item| item.name == schema));
            assert!(tables(&mut client, &schema).unwrap().iter().any(|item| item.name == "item_view" && item.kind == "view"));
            assert!(functions(&mut client, &schema).unwrap().iter().any(|item| item.name == "sample"));
            assert!(function_ddl(&mut client, &schema, "sample", "").unwrap().contains("CREATE OR REPLACE FUNCTION"));
            assert!(table_ddl(&mut client, &schema, "items").unwrap().contains("FOREIGN KEY"));
            let meta = columns(&mut client, &schema, "items").unwrap();
            assert!(meta[0].primary_key); assert_eq!(meta[1].foreign_key.as_ref().unwrap().table, "parent");
            let changes: TableChanges = serde_json::from_value(json!({"inserts":[{"id":1,"parent_id":1,"name":"日本語😀 A%_\\'","amount":"123.45"}],"updates":[],"deletes":[]})).unwrap();
            assert_eq!(apply_table_changes(&mut client, &schema, "items", changes, false).unwrap().inserted, 1);
            let filter = FilterNode::Condition {column:"name".into(),operator:"contains".into(),value:Some("a%_\\'".into()),second_value:None,values:None,enabled:true};
            let rows = query_table(&mut client, &schema, "items", &filter, &[SortRule {column:"name".into(),direction:"desc".into(),nulls:"last".into()}], 0).unwrap();
            assert_eq!(rows.rows.len(), 1); assert_eq!(rows.rows[0]["id"], 1);
            assert_eq!(execute_sql(&mut client, &rows.sql_preview, false).unwrap().rows.len(), 1);
            let invalid: TableChanges = serde_json::from_value(json!({"inserts":[{"id":2,"name":"rollback"},{"id":3,"name":"日本語😀 A%_\\'"}],"updates":[],"deletes":[]})).unwrap();
            assert!(apply_table_changes(&mut client, &schema, "items", invalid, false).is_err());
            assert_eq!(execute_sql(&mut client, &format!("SELECT count(*) AS n FROM {q}.items"), false).unwrap().rows[0]["n"], 1);
            let update: TableChanges = serde_json::from_value(json!({"inserts":[],"updates":[{"primaryKey":{"id":1},"values":{"name":"updated"}}],"deletes":[]})).unwrap();
            assert_eq!(apply_table_changes(&mut client, &schema, "items", update, false).unwrap().updated, 1);
            let deletion: TableChanges = serde_json::from_value(json!({"inserts":[],"updates":[],"deletes":[{"id":1}]})).unwrap();
            assert_eq!(apply_table_changes(&mut client, &schema, "items", deletion, false).unwrap().deleted, 1);
            assert!(execute_sql(&mut client, &format!("DELETE FROM {q}.items"), true).is_err());
        }));
        client.batch_execute(&format!("DROP SCHEMA {q} CASCADE")).unwrap();
        if let Err(e) = result { std::panic::resume_unwind(e); }
    }
}
