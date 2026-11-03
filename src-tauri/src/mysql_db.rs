//! MySQL and MariaDB backend. Driver I/O runs on Tauri's runtime while the
//! synchronous command boundary remains on spawn_blocking, like PostgreSQL.
use crate::{
    models::*,
    mysql_filters::{self, quote_identifier},
    ssh::SshTunnel,
    store,
};
use mysql_async::consts::ColumnType;
use mysql_async::{
    prelude::*, Column, Conn, DriverError, Opts, OptsBuilder, Params, Row, SslOpts, TxOpts,
    Value as MyValue,
};
use serde_json::{Map, Value};
use std::{collections::HashMap, time::Duration};

pub struct ConnectedDb {
    pub client: Conn,
    pub _tunnel: Option<SshTunnel>,
    pub read_only: bool,
    pub broken: bool,
    options: Opts,
}

#[derive(Clone)]
pub struct QueryCancel {
    options: Opts,
    connection_id: u32,
}

impl QueryCancel {
    pub fn cancel(&self) -> Result<(), String> {
        tauri::async_runtime::block_on(async {
            let mut conn =
                tokio::time::timeout(Duration::from_secs(12), Conn::new(self.options.clone()))
                    .await
                    .map_err(|_| "キャンセル用接続がタイムアウトしました")?
                    .map_err(|e| error("キャンセル用接続エラー", e))?;
            let result = conn
                .query_drop(format!("KILL QUERY {}", self.connection_id))
                .await
                .map_err(|e| error("SQLキャンセルエラー", e));
            let _ = conn.disconnect().await;
            result
        })
    }
}

impl ConnectedDb {
    pub fn cancel_request(&self) -> QueryCancel {
        QueryCancel {
            options: self.options.clone(),
            connection_id: self.client.id(),
        }
    }
    pub fn keep_alive(&mut self) -> Result<(), String> {
        let result = tauri::async_runtime::block_on(self.client.ping());
        if result.is_err() {
            self.broken = true;
        }
        result.map_err(|e| error("接続確認エラー", e))
    }
}

fn error(context: &str, error: mysql_async::Error) -> String {
    if let mysql_async::Error::Server(ref server) = error {
        format!(
            "{context}: {}\nSQLSTATE: {}\nMySQL error: {}",
            server.message, server.state, server.code
        )
    } else if error.is_fatal() {
        format!("{context}: MySQL transport error: {error}")
    } else {
        format!("{context}: {error}")
    }
}

fn options(
    profile: &ConnectionProfile,
    port: u16,
    tunneled: bool,
    password: Option<String>,
) -> Opts {
    let mut builder = OptsBuilder::default()
        .ip_or_hostname(profile.host.clone())
        .tcp_port(port)
        .user(Some(profile.username.clone()))
        .pass(password)
        .db_name((!profile.database.trim().is_empty()).then(|| profile.database.clone()))
        .prefer_socket(false)
        .tcp_keepalive(Some(Duration::from_secs(30)))
        .client_found_rows(true);
    // Preserve the real TLS name even though TCP travels through loopback.
    if tunneled {
        builder = builder.resolved_ips(Some(vec![std::net::IpAddr::V4(
            std::net::Ipv4Addr::LOCALHOST,
        )]));
    }
    if profile.ssl_mode != "disable" {
        builder = builder.ssl_opts(Some(
            SslOpts::default()
                .with_danger_accept_invalid_certs(profile.ssl_mode != "verifyFull")
                .with_danger_skip_domain_validation(profile.ssl_mode != "verifyFull"),
        ));
    }
    builder.into()
}

async fn open(options: Opts, prefer: bool) -> Result<(Conn, Opts), String> {
    let connect = |opts| async move {
        tokio::time::timeout(Duration::from_secs(12), Conn::new(opts))
            .await
            .map_err(|_| "MySQL接続がタイムアウトしました".to_owned())?
            .map_err(|e| error("MySQL接続エラー", e))
    };
    // Prefer falls back only when the server explicitly lacks TLS support.
    // Authentication and TLS handshake failures must not cause a downgrade.
    match tokio::time::timeout(Duration::from_secs(12), Conn::new(options.clone())).await {
        Ok(Ok(conn)) => Ok((conn, options)),
        Ok(Err(mysql_async::Error::Driver(DriverError::NoClientSslFlagFromServer))) if prefer => {
            let plain: Opts = OptsBuilder::from_opts(options).ssl_opts(None).into();
            connect(plain.clone()).await.map(|conn| (conn, plain))
        }
        Ok(Err(e)) => Err(error("MySQL接続エラー", e)),
        Err(_) => Err("MySQL接続がタイムアウトしました".into()),
    }
}

pub fn connect(profile: &ConnectionProfile) -> Result<ConnectedDb, String> {
    let tunnel = if profile.ssh.enabled {
        Some(SshTunnel::start(profile)?)
    } else {
        None
    };
    let opts = options(
        profile,
        tunnel
            .as_ref()
            .map(SshTunnel::local_port)
            .unwrap_or(profile.port),
        tunnel.is_some(),
        store::get_secret(&profile.id, "db-password"),
    );
    let (mut client, options) =
        tauri::async_runtime::block_on(open(opts, profile.ssl_mode == "prefer"))?;
    tauri::async_runtime::block_on(async {
        client
            .query_drop("SET NAMES utf8mb4")
            .await
            .map_err(|e| error("文字コード設定エラー", e))?;
        if profile.read_only {
            client
                .query_drop("SET SESSION TRANSACTION READ ONLY")
                .await
                .map_err(|e| error("読み取り専用設定エラー", e))?;
        }
        Ok::<_, String>(())
    })?;
    Ok(ConnectedDb {
        client,
        _tunnel: tunnel,
        read_only: profile.read_only,
        broken: false,
        options,
    })
}

fn qualified(schema: &str, name: &str) -> String {
    format!("{}.{}", quote_identifier(schema), quote_identifier(name))
}

pub fn schemas(client: &mut Conn) -> Result<Vec<SchemaInfo>, String> {
    tauri::async_runtime::block_on(async {
        let names: Vec<String> = client.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') ORDER BY schema_name").await.map_err(|e| error("データベース一覧取得エラー", e))?;
        Ok(names.into_iter().map(|name| SchemaInfo { name }).collect())
    })
}

pub fn tables(client: &mut Conn, schema: &str) -> Result<Vec<TableInfo>, String> {
    tauri::async_runtime::block_on(async {
        let rows: Vec<(String, String, String)> = client.exec("SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema = ? AND table_type IN ('BASE TABLE', 'VIEW', 'SYSTEM VERSIONED') ORDER BY table_name", (schema,)).await.map_err(|e| error("テーブル一覧取得エラー", e))?;
        Ok(rows
            .into_iter()
            .map(|(schema, name, kind)| TableInfo {
                schema,
                name,
                kind: if kind == "VIEW" { "view" } else { "table" }.into(),
            })
            .collect())
    })
}

pub fn functions(client: &mut Conn, schema: &str) -> Result<Vec<FunctionInfo>, String> {
    tauri::async_runtime::block_on(async {
        let rows: Vec<(String, String, String)> = client.exec("SELECT routine_name, routine_type, COALESCE(dtd_identifier, '') FROM information_schema.routines WHERE routine_schema = ? ORDER BY routine_name, routine_type", (schema,)).await.map_err(|e| error("関数一覧取得エラー", e))?;
        let parameters: Vec<(String, String, Option<String>, Option<String>, String)> = client.exec("SELECT specific_name, routine_type, parameter_mode, parameter_name, dtd_identifier FROM information_schema.parameters WHERE specific_schema = ? AND ordinal_position > 0 ORDER BY specific_name, routine_type, ordinal_position", (schema,)).await.map_err(|e| error("関数引数取得エラー", e))?;
        let mut args = HashMap::<(String, String), Vec<String>>::new();
        for (name, kind, mode, parameter, data_type) in parameters {
            args.entry((name, kind)).or_default().push(format!(
                "{}{} {}",
                mode.map(|mode| format!("{mode} ")).unwrap_or_default(),
                quote_identifier(&parameter.unwrap_or_default()),
                data_type
            ));
        }
        Ok(rows
            .into_iter()
            .map(|(name, kind, return_type)| {
                let arguments = args
                    .remove(&(name.clone(), kind.clone()))
                    .unwrap_or_default()
                    .join(", ");
                FunctionInfo {
                    schema: schema.into(),
                    name,
                    arguments,
                    return_type,
                    kind: kind.to_ascii_lowercase(),
                }
            })
            .collect())
    })
}

pub fn function_ddl(
    client: &mut Conn,
    schema: &str,
    name: &str,
    _arguments: &str,
) -> Result<String, String> {
    tauri::async_runtime::block_on(async {
        let kind: Option<String> = client.exec_first("SELECT routine_type FROM information_schema.routines WHERE routine_schema = ? AND routine_name = ?", (schema, name)).await.map_err(|e| error("関数情報取得エラー", e))?;
        let kind = match kind.as_deref() {
            Some("FUNCTION") => "FUNCTION",
            Some("PROCEDURE") => "PROCEDURE",
            _ => return Err("関数またはプロシージャが見つかりません".into()),
        };
        show_create(
            client,
            &format!("SHOW CREATE {kind} {}", qualified(schema, name)),
        )
        .await
    })
}

async fn show_create(client: &mut Conn, sql: &str) -> Result<String, String> {
    let row: Row = client
        .query_first(sql)
        .await
        .map_err(|e| error("DDL取得エラー", e))?
        .ok_or("オブジェクトが見つかりません")?;
    let index = row
        .columns_ref()
        .iter()
        .position(|column| column.name_str().starts_with("Create "))
        .ok_or("DDLを取得できませんでした")?;
    let ddl: Option<String> = row.get(index).ok_or("DDLを取得できませんでした")?;
    ddl.map(|ddl| format!("{};", ddl.trim_end_matches(';')))
        .ok_or_else(|| "DDLの取得権限がありません".into())
}

pub fn table_ddl(client: &mut Conn, schema: &str, table: &str) -> Result<String, String> {
    tauri::async_runtime::block_on(show_create(
        client,
        &format!("SHOW CREATE TABLE {}", qualified(schema, table)),
    ))
}

async fn columns_async(
    client: &mut Conn,
    schema: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    let rows: Vec<(String, String, String, String)> = client.exec("SELECT column_name, column_type, is_nullable, column_key FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position", (schema, table)).await.map_err(|e| error("カラム取得エラー", e))?;
    let foreign_rows: Vec<(String, String, String, String)> = client.exec("SELECT column_name, referenced_table_schema, referenced_table_name, referenced_column_name FROM information_schema.key_column_usage WHERE table_schema = ? AND table_name = ? AND referenced_table_name IS NOT NULL ORDER BY constraint_name, ordinal_position", (schema, table)).await.map_err(|e| error("外部キー取得エラー", e))?;
    let mut foreign_keys = HashMap::new();
    for (column, schema, table, referenced) in foreign_rows {
        foreign_keys.entry(column).or_insert(ForeignKeyInfo {
            schema,
            table,
            column: referenced,
        });
    }
    Ok(rows
        .into_iter()
        .map(|(name, data_type, nullable, key)| {
            let foreign_key = foreign_keys.remove(&name);
            ColumnInfo {
                name,
                data_type,
                nullable: nullable == "YES",
                primary_key: key == "PRI",
                foreign_key,
            }
        })
        .collect())
}

pub fn columns(client: &mut Conn, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    tauri::async_runtime::block_on(columns_async(client, schema, table))
}

// Convert driver values on the client: PostgreSQL's to_jsonb has no portable
// equivalent. Keep DECIMAL and integers beyond JS's exact range as strings.
fn json_value(value: MyValue, column: &Column) -> Value {
    use ColumnType::*;
    match value {
        MyValue::NULL => Value::Null,
        MyValue::Int(n) => {
            if n.unsigned_abs() > 9_007_199_254_740_991 {
                Value::String(n.to_string())
            } else {
                Value::from(n)
            }
        }
        MyValue::UInt(n) => {
            if n > 9_007_199_254_740_991 {
                Value::String(n.to_string())
            } else {
                Value::from(n)
            }
        }
        MyValue::Float(n) => Value::from(n),
        MyValue::Double(n) => Value::from(n),
        MyValue::Date(year, month, day, hour, minute, second, micros) => {
            let mut text = format!("{year:04}-{month:02}-{day:02}");
            if column.column_type() != MYSQL_TYPE_DATE {
                text.push_str(&format!(" {hour:02}:{minute:02}:{second:02}"));
                if micros > 0 {
                    text.push_str(&format!(".{micros:06}"));
                }
            }
            Value::String(text)
        }
        MyValue::Time(negative, days, hours, minutes, seconds, micros) => {
            let mut text = format!(
                "{}{:02}:{minutes:02}:{seconds:02}",
                if negative { "-" } else { "" },
                days * 24 + hours as u32
            );
            if micros > 0 {
                text.push_str(&format!(".{micros:06}"));
            }
            Value::String(text)
        }
        MyValue::Bytes(bytes) => {
            let kind = column.column_type();
            let binary = kind == MYSQL_TYPE_BIT
                || kind == MYSQL_TYPE_GEOMETRY
                || (column.character_set() == 63
                    && matches!(
                        kind,
                        MYSQL_TYPE_BLOB
                            | MYSQL_TYPE_TINY_BLOB
                            | MYSQL_TYPE_MEDIUM_BLOB
                            | MYSQL_TYPE_LONG_BLOB
                            | MYSQL_TYPE_STRING
                            | MYSQL_TYPE_VAR_STRING
                            | MYSQL_TYPE_VARCHAR
                    ));
            if binary {
                return Value::String(format!(
                    "0x{}",
                    bytes
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>()
                ));
            }
            let text = match String::from_utf8(bytes) {
                Ok(text) => text,
                Err(e) => {
                    return Value::String(format!(
                        "0x{}",
                        e.as_bytes()
                            .iter()
                            .map(|byte| format!("{byte:02x}"))
                            .collect::<String>()
                    ))
                }
            };
            if matches!(
                kind,
                MYSQL_TYPE_TINY
                    | MYSQL_TYPE_SHORT
                    | MYSQL_TYPE_LONG
                    | MYSQL_TYPE_LONGLONG
                    | MYSQL_TYPE_INT24
                    | MYSQL_TYPE_YEAR
            ) {
                if let Ok(n) = text.parse::<i64>() {
                    return json_value(MyValue::Int(n), column);
                }
                if let Ok(n) = text.parse::<u64>() {
                    return json_value(MyValue::UInt(n), column);
                }
            }
            if matches!(kind, MYSQL_TYPE_FLOAT | MYSQL_TYPE_DOUBLE) {
                if let Ok(n) = text.parse::<f64>() {
                    return Value::from(n);
                }
            }
            if kind == MYSQL_TYPE_JSON {
                return serde_json::from_str(&text).unwrap_or(Value::String(text));
            }
            Value::String(text)
        }
    }
}

fn page(rows: Vec<Row>, columns: &[Column], sql: &str) -> QueryPage {
    // Preserve duplicate result labels instead of losing one map entry.
    let mut names = Vec::<String>::new();
    for column in columns {
        let label = column.name_str().into_owned();
        let mut name = label.clone();
        let mut suffix = 2;
        while names.contains(&name) {
            name = format!("{label} ({suffix})");
            suffix += 1;
        }
        names.push(name);
    }
    let objects = rows
        .into_iter()
        .map(|row| {
            row.unwrap()
                .into_iter()
                .zip(columns)
                .zip(&names)
                .map(|((value, column), name)| (name.clone(), json_value(value, column)))
                .collect::<Map<_, _>>()
        })
        .collect();
    QueryPage {
        columns: names,
        rows: objects,
        has_more: false,
        sql_preview: sql.into(),
    }
}

pub fn query_table(
    client: &mut Conn,
    schema: &str,
    table: &str,
    filter: &FilterNode,
    sorts: &[SortRule],
    offset: u32,
) -> Result<QueryPage, String> {
    tauri::async_runtime::block_on(async {
        let columns = columns_async(client, schema, table).await?;
        let filter = mysql_filters::compile(filter, &columns)?;
        let order = mysql_filters::compile_order(&columns, sorts)?;
        let qualified = qualified(schema, table);
        let sql = format!(
            "SELECT * FROM {qualified} WHERE {}{order} LIMIT 101 OFFSET {offset}",
            filter.sql
        );
        let mut result = client
            .exec_iter(sql, Params::Positional(filter.params))
            .await
            .map_err(|e| error("フィルター実行エラー", e))?;
        let meta = result.columns().ok_or("カラム情報を取得できません")?;
        let mut rows: Vec<Row> = result
            .collect()
            .await
            .map_err(|e| error("結果取得エラー", e))?;
        result
            .drop_result()
            .await
            .map_err(|e| error("結果取得エラー", e))?;
        let has_more = rows.len() > 100;
        if has_more {
            rows.pop();
        }
        let mut page = page(
            rows,
            &meta,
            &format!(
                "SELECT * FROM {qualified} WHERE {}{order} LIMIT 100 OFFSET {offset}",
                filter.preview
            ),
        );
        page.has_more = has_more;
        Ok(page)
    })
}

fn editable_value(value: &Value, column: &ColumnInfo) -> Result<MyValue, String> {
    if value.is_null() {
        if !column.nullable {
            return Err(format!("カラム「{}」はNULLにできません", column.name));
        }
        return Ok(MyValue::NULL);
    }
    let text = match value {
        Value::String(value) => value.clone(),
        Value::Bool(value) => if *value { "1" } else { "0" }.into(),
        value => value.to_string(),
    };
    mysql_filters::bound_value(&text, &column.data_type)
}

pub fn apply_table_changes(
    client: &mut Conn,
    schema: &str,
    table: &str,
    changes: TableChanges,
    read_only: bool,
) -> Result<TableChangeResult, String> {
    if read_only {
        return Err("読み取り専用接続ではテーブルを編集できません".into());
    }
    tauri::async_runtime::block_on(async {
        if changes.inserts.is_empty() && changes.updates.is_empty() && changes.deletes.is_empty() {
            return Ok(TableChangeResult {
                inserted: 0,
                updated: 0,
                deleted: 0,
            });
        }
        // Rollback guarantees require a transactional table. Never silently
        // apply a partial batch to MyISAM/Aria or a view.
        let engine: Option<String> = client.exec_first("SELECT engine FROM information_schema.tables WHERE table_schema = ? AND table_name = ? AND table_type = 'BASE TABLE'", (schema, table)).await.map_err(|e| error("テーブル情報取得エラー", e))?;
        if !engine.is_some_and(|engine| engine.eq_ignore_ascii_case("InnoDB")) {
            return Err("一括編集はInnoDBの通常テーブルに対応しています。他のストレージエンジンやビューはSQLエディタを使用してください".into());
        }
        let columns = columns_async(client, schema, table).await?;
        let keys = columns
            .iter()
            .filter(|column| column.primary_key)
            .collect::<Vec<_>>();
        if keys.is_empty() && (!changes.updates.is_empty() || !changes.deletes.is_empty()) {
            return Err("主キーがないテーブルは安全に更新・削除できません".into());
        }
        let lookup = columns
            .iter()
            .map(|column| (column.name.as_str(), column))
            .collect::<HashMap<_, _>>();
        let qualified = qualified(schema, table);
        let mut transaction = client
            .start_transaction(TxOpts::default())
            .await
            .map_err(|e| error("変更トランザクションを開始できません", e))?;
        let mut counts = TableChangeResult {
            inserted: 0,
            updated: 0,
            deleted: 0,
        };
        let result: Result<(), String> = async {
            for values in changes.inserts {
                let mut names = Vec::new();
                let mut params = Vec::new();
                for (name, value) in values {
                    let column = lookup
                        .get(name.as_str())
                        .ok_or_else(|| format!("カラム「{name}」は現在のテーブルに存在しません"))?;
                    names.push(quote_identifier(&name));
                    params.push(editable_value(&value, column)?);
                }
                let sql = format!(
                    "INSERT INTO {qualified} ({}) VALUES ({})",
                    names.join(", "),
                    vec!["?"; params.len()].join(", ")
                );
                transaction
                    .exec_drop(sql, Params::Positional(params))
                    .await
                    .map_err(|e| error("行追加エラー", e))?;
                let affected = transaction.affected_rows();
                if affected != 1 {
                    return Err(format!("追加対象が1行になりませんでした（{affected}行）"));
                }
                counts.inserted += affected;
            }
            for update in changes.updates {
                if update.values.is_empty() {
                    continue;
                }
                let mut assignments = Vec::new();
                let mut params = Vec::new();
                for (name, value) in update.values {
                    let column = lookup
                        .get(name.as_str())
                        .ok_or_else(|| format!("カラム「{name}」は現在のテーブルに存在しません"))?;
                    assignments.push(format!("{} = ?", quote_identifier(&name)));
                    params.push(editable_value(&value, column)?);
                }
                let predicates = key_predicates(&keys, &update.primary_key, &mut params)?;
                transaction
                    .exec_drop(
                        format!(
                            "UPDATE {qualified} SET {} WHERE {predicates}",
                            assignments.join(", ")
                        ),
                        Params::Positional(params),
                    )
                    .await
                    .map_err(|e| error("行更新エラー", e))?;
                let affected = transaction.affected_rows();
                if affected != 1 {
                    return Err(format!(
                        "更新対象が1行に特定できませんでした（{affected}行）"
                    ));
                }
                counts.updated += affected;
            }
            for key in changes.deletes {
                let mut params = Vec::new();
                let predicates = key_predicates(&keys, &key, &mut params)?;
                transaction
                    .exec_drop(
                        format!("DELETE FROM {qualified} WHERE {predicates}"),
                        Params::Positional(params),
                    )
                    .await
                    .map_err(|e| error("行削除エラー", e))?;
                let affected = transaction.affected_rows();
                if affected != 1 {
                    return Err(format!(
                        "削除対象が1行に特定できませんでした（{affected}行）"
                    ));
                }
                counts.deleted += affected;
            }
            Ok(())
        }
        .await;
        if let Err(e) = result {
            let _ = transaction.rollback().await;
            return Err(e);
        }
        transaction
            .commit()
            .await
            .map_err(|e| error("変更を確定できません", e))?;
        Ok(counts)
    })
}

fn key_predicates(
    keys: &[&ColumnInfo],
    values: &Map<String, Value>,
    params: &mut Vec<MyValue>,
) -> Result<String, String> {
    let mut predicates = Vec::new();
    for column in keys {
        let value = values
            .get(&column.name)
            .filter(|value| !value.is_null())
            .ok_or_else(|| format!("主キー「{}」の元の値がありません", column.name))?;
        params.push(editable_value(value, column)?);
        predicates.push(format!(
            "{} = {}",
            quote_identifier(&column.name),
            mysql_filters::typed_placeholder(&column.data_type)
        ));
    }
    Ok(predicates.join(" AND "))
}

pub fn execute_sql(client: &mut Conn, sql: &str, read_only: bool) -> Result<QueryPage, String> {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    if trimmed.is_empty() {
        return Err("SQLを入力してください".into());
    }
    let first = leading_keyword(trimmed).to_ascii_lowercase();
    if read_only
        && !matches!(
            first.as_str(),
            "select" | "with" | "values" | "show" | "describe" | "desc" | "explain"
        )
    {
        return Err("読み取り専用接続では書き込みSQLを実行できません".into());
    }
    tauri::async_runtime::block_on(async {
        // Prepared execution accepts exactly one statement. Together with the
        // session's READ ONLY setting this prevents a SELECT; DDL bypass.
        if read_only {
            let result = client
                .exec_iter(trimmed, ())
                .await
                .map_err(|e| error("SQL実行エラー", e))?;
            return collect_sql_result(result, trimmed).await;
        }
        let result = client
            .query_iter(trimmed)
            .await
            .map_err(|e| error("SQL実行エラー", e))?;
        collect_sql_result(result, trimmed).await
    })
}

async fn collect_sql_result<P: Protocol>(
    mut result: mysql_async::QueryResult<'_, '_, P>,
    trimmed: &str,
) -> Result<QueryPage, String> {
    let columns = result.columns();
    let affected = result.affected_rows();
    let rows: Vec<Row> = result
        .collect()
        .await
        .map_err(|e| error("SQL結果取得エラー", e))?;
    result
        .drop_result()
        .await
        .map_err(|e| error("SQL結果取得エラー", e))?;
    if let Some(columns) = columns {
        return Ok(page(rows, &columns, trimmed));
    }
    Ok(QueryPage {
        columns: vec!["status".into(), "affected_rows".into()],
        rows: vec![Map::from_iter([
            ("status".into(), Value::String("実行しました".into())),
            ("affected_rows".into(), Value::from(affected)),
        ])],
        has_more: false,
        sql_preview: trimmed.into(),
    })
}

fn leading_keyword(sql: &str) -> &str {
    let mut rest = sql.trim_start();
    loop {
        if rest.starts_with('#')
            || (rest.starts_with("--")
                && rest.as_bytes().get(2).is_none_or(u8::is_ascii_whitespace))
        {
            rest = rest
                .find('\n')
                .map(|end| &rest[end + 1..])
                .unwrap_or("")
                .trim_start();
        } else if rest.starts_with("/*") {
            // Executable MySQL/MariaDB comments must not bypass read-only checks.
            if rest.starts_with("/*!") || rest.starts_with("/*M!") {
                return "";
            }
            rest = rest
                .find("*/")
                .map(|end| &rest[end + 2..])
                .unwrap_or("")
                .trim_start();
        } else {
            break;
        }
    }
    &rest[..rest
        .find(|c: char| !c.is_ascii_alphabetic())
        .unwrap_or(rest.len())]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn empty_filter() -> FilterNode {
        FilterNode::Group {
            conjunction: "and".into(),
            children: vec![],
            enabled: true,
        }
    }
    fn condition(column: &str, operator: &str, value: &str) -> FilterNode {
        FilterNode::Condition {
            column: column.into(),
            operator: operator.into(),
            value: Some(value.into()),
            second_value: None,
            values: None,
            enabled: true,
        }
    }
    fn changes(value: Value) -> TableChanges {
        serde_json::from_value(value).unwrap()
    }
    fn conn() -> Conn {
        let url = std::env::var("MY_POSTICO_TEST_MYSQL_URL")
            .expect("set MY_POSTICO_TEST_MYSQL_URL to a disposable MySQL/MariaDB test database");
        let opts = OptsBuilder::from_opts(Opts::from_url(&url).unwrap())
            .client_found_rows(true)
            .prefer_socket(false);
        tauri::async_runtime::block_on(Conn::new(opts)).unwrap()
    }
    fn run(client: &mut Conn, sql: &str) -> QueryPage {
        execute_sql(client, sql, false).unwrap_or_else(|e| panic!("{sql}: {e}"))
    }

    #[test]
    fn mysql_comments_cannot_hide_writes_from_read_only_checks() {
        assert_eq!(leading_keyword(" # note\n/* comment */ SELECT 1"), "SELECT");
        assert_eq!(leading_keyword("-- comment\nUPDATE t SET a=1"), "UPDATE");
        assert_eq!(leading_keyword("/*! DROP TABLE t */"), "");
        assert_eq!(leading_keyword("/*M! DROP TABLE t */"), "");
    }

    #[test]
    #[ignore = "requires MY_POSTICO_TEST_MYSQL_URL pointing to a disposable database"]
    fn mysql_and_mariadb_round_trip() {
        let mut client = conn();
        let schema = format!("postico_test_{}", uuid::Uuid::new_v4().simple());
        let q = quote_identifier(&schema);
        run(
            &mut client,
            &format!("CREATE DATABASE {q} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"),
        );
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run(
                &mut client,
                &format!("CREATE TABLE {q}.parent (id INT PRIMARY KEY) ENGINE=InnoDB"),
            );
            run(&mut client, &format!("INSERT INTO {q}.parent VALUES (1)"));
            run(&mut client, &format!("CREATE TABLE {q}.items (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, parent_id INT, name VARCHAR(255), amount DECIMAL(30,10), payload JSON, bytes VARBINARY(32), happened DATETIME(6), duration TIME(6), UNIQUE KEY uq_name(name), FOREIGN KEY(parent_id) REFERENCES {q}.parent(id)) ENGINE=InnoDB"));
            run(
                &mut client,
                &format!("CREATE VIEW {q}.item_view AS SELECT id,name FROM {q}.items"),
            );
            run(&mut client, &format!("CREATE FUNCTION {q}.sample_function(x INT) RETURNS INT DETERMINISTIC RETURN x + 1"));
            run(
                &mut client,
                &format!("CREATE PROCEDURE {q}.sample_procedure(IN x INT) SELECT x"),
            );
            assert!(schemas(&mut client)
                .unwrap()
                .iter()
                .any(|item| item.name == schema));
            let tables = tables(&mut client, &schema).unwrap();
            assert!(tables
                .iter()
                .any(|table| table.name == "item_view" && table.kind == "view"));
            let columns = columns(&mut client, &schema, "items").unwrap();
            assert!(columns[0].primary_key);
            assert_eq!(columns[1].foreign_key.as_ref().unwrap().column, "id");
            assert!(table_ddl(&mut client, &schema, "items")
                .unwrap()
                .contains("CREATE TABLE"));
            assert!(table_ddl(&mut client, &schema, "item_view")
                .unwrap()
                .contains("VIEW"));
            let routines = functions(&mut client, &schema).unwrap();
            assert_eq!(routines.len(), 2);
            assert!(routines.iter().any(|r| r.name == "sample_function"
                && r.arguments.contains("INT".to_lowercase().as_str())));
            assert!(function_ddl(&mut client, &schema, "sample_function", "")
                .unwrap()
                .contains("FUNCTION"));
            assert!(function_ddl(&mut client, &schema, "sample_procedure", "")
                .unwrap()
                .contains("PROCEDURE"));
            let insert = changes(
                json!({"inserts":[{"id":"18446744073709551615","parent_id":1,"name":"日本語😀 A%_!\\'","amount":"12345678901234567890.1234567890","payload":{"ok":true},"bytes":"0x00ff80","happened":"2026-10-23 12:34:56.123456","duration":"-123:45:56.123456"}],"updates":[],"deletes":[]}),
            );
            assert_eq!(
                apply_table_changes(&mut client, &schema, "items", insert, false)
                    .unwrap()
                    .inserted,
                1
            );
            let page = query_table(&mut client, &schema, "items", &empty_filter(), &[], 0).unwrap();
            assert_eq!(page.rows[0]["id"], "18446744073709551615");
            assert_eq!(page.rows[0]["amount"], "12345678901234567890.1234567890");
            assert_eq!(page.rows[0]["bytes"], "0x00ff80");
            assert_eq!(page.rows[0]["name"], "日本語😀 A%_!\\'");
            assert_eq!(page.rows[0]["happened"], "2026-10-23 12:34:56.123456");
            assert_eq!(page.rows[0]["duration"], "-123:45:56.123456");
            let filter = condition("name", "contains", "a%_!\\'");
            let filtered = query_table(&mut client, &schema, "items", &filter, &[], 0).unwrap();
            assert_eq!(filtered.rows.len(), 1);
            let preview = run(&mut client, &filtered.sql_preview);
            assert_eq!(preview.rows.len(), 1);
            assert!(query_table(
                &mut client,
                &schema,
                "items",
                &condition("name", "eq", "' OR 1=1 --"),
                &[],
                0
            )
            .unwrap()
            .rows
            .is_empty());
            let update = changes(
                json!({"inserts":[],"updates":[{"primaryKey":{"id":"18446744073709551615"},"values":{"name":"updated"}}],"deletes":[]}),
            );
            assert_eq!(
                apply_table_changes(&mut client, &schema, "items", update, false)
                    .unwrap()
                    .updated,
                1
            );
            // CLIENT_FOUND_ROWS keeps no-op updates from appearing to miss their row.
            let unchanged = changes(
                json!({"inserts":[],"updates":[{"primaryKey":{"id":"18446744073709551615"},"values":{"name":"updated"}}],"deletes":[]}),
            );
            assert_eq!(
                apply_table_changes(&mut client, &schema, "items", unchanged, false)
                    .unwrap()
                    .updated,
                1
            );
            let invalid = changes(
                json!({"inserts":[{"id":"2","name":"rollback-me"},{"id":"3","name":"updated"}],"updates":[],"deletes":[]}),
            );
            assert!(apply_table_changes(&mut client, &schema, "items", invalid, false).is_err());
            assert!(query_table(
                &mut client,
                &schema,
                "items",
                &condition("id", "eq", "2"),
                &[],
                0
            )
            .unwrap()
            .rows
            .is_empty());
            let deletion = changes(
                json!({"inserts":[],"updates":[],"deletes":[{"id":"18446744073709551615"}]}),
            );
            assert_eq!(
                apply_table_changes(&mut client, &schema, "items", deletion, false)
                    .unwrap()
                    .deleted,
                1
            );
            run(&mut client, &format!("CREATE TABLE {q}.many_rows(id INT PRIMARY KEY, name VARCHAR(20)) ENGINE=InnoDB"));
            let inserts = (1..=1003).map(|id| json!({"id":id,"name": if id % 2 == 0 { Value::Null } else { Value::String(format!("item-{id}")) }})).collect::<Vec<_>>();
            apply_table_changes(
                &mut client,
                &schema,
                "many_rows",
                changes(json!({"inserts":inserts,"updates":[],"deletes":[]})),
                false,
            )
            .unwrap();
            let all = run(
                &mut client,
                &format!("SELECT * FROM {q}.many_rows ORDER BY id"),
            );
            assert_eq!(all.rows.len(), 1003);
            assert!(!all.has_more);
            assert_eq!(
                run(
                    &mut client,
                    &format!(
                        "SELECT a.id FROM {q}.many_rows a CROSS JOIN {q}.many_rows b LIMIT 10003"
                    )
                )
                .rows
                .len(),
                10003
            );
            let first =
                query_table(&mut client, &schema, "many_rows", &empty_filter(), &[], 0).unwrap();
            let next =
                query_table(&mut client, &schema, "many_rows", &empty_filter(), &[], 100).unwrap();
            assert_eq!(first.rows.len(), 100);
            assert!(first.has_more);
            assert_eq!(next.rows[0]["id"], 101);
            let last = query_table(
                &mut client,
                &schema,
                "many_rows",
                &empty_filter(),
                &[],
                1000,
            )
            .unwrap();
            assert_eq!(last.rows.len(), 3);
            assert!(!last.has_more);
            let sorted = query_table(
                &mut client,
                &schema,
                "many_rows",
                &empty_filter(),
                &[SortRule {
                    column: "name".into(),
                    direction: "desc".into(),
                    nulls: "first".into(),
                }],
                0,
            )
            .unwrap();
            assert!(sorted.rows[0]["name"].is_null());
            let empty = run(
                &mut client,
                &format!("SELECT id,name FROM {q}.many_rows WHERE 1=0"),
            );
            assert!(empty.rows.is_empty());
            assert_eq!(empty.columns, ["id", "name"]);
            assert_eq!(
                run(&mut client, "SELECT 1 AS id, 2 AS id").columns,
                ["id", "id (2)"]
            );
            assert!(
                !run(&mut client, &format!("EXPLAIN SELECT * FROM {q}.many_rows"))
                    .rows
                    .is_empty()
            );
            assert!(!run(&mut client, &format!("SHOW TABLES FROM {q}"))
                .rows
                .is_empty());
            // Adjacent values outside JS and floating point precision must
            // still identify exactly one row, including composite keys.
            run(&mut client, &format!("CREATE TABLE {q}.exact_keys (id BIGINT UNSIGNED, amount DECIMAL(30,10), name VARCHAR(20), PRIMARY KEY(id,amount)) ENGINE=InnoDB"));
            apply_table_changes(&mut client, &schema, "exact_keys", changes(json!({"inserts":[
                {"id":"18446744073709551614","amount":"12345678901234567890.1234567890","name":"first"},
                {"id":"18446744073709551615","amount":"12345678901234567890.1234567891","name":"second"}
            ],"updates":[],"deletes":[]})), false).unwrap();
            let exact = query_table(
                &mut client,
                &schema,
                "exact_keys",
                &condition("amount", "eq", "12345678901234567890.1234567891"),
                &[],
                0,
            )
            .unwrap();
            assert_eq!(exact.rows.len(), 1);
            assert_eq!(exact.rows[0]["name"], "second");
            assert_eq!(run(&mut client, &exact.sql_preview).rows.len(), 1);
            let exact = query_table(
                &mut client,
                &schema,
                "exact_keys",
                &condition("id", "eq", "18446744073709551614"),
                &[],
                0,
            )
            .unwrap();
            assert_eq!(exact.rows.len(), 1);
            assert_eq!(exact.rows[0]["name"], "first");
            apply_table_changes(&mut client, &schema, "exact_keys", changes(json!({"inserts":[],"updates":[{"primaryKey":{"id":"18446744073709551615","amount":"12345678901234567890.1234567891"},"values":{"name":"changed"}}],"deletes":[]})), false).unwrap();
            assert_eq!(
                query_table(
                    &mut client,
                    &schema,
                    "exact_keys",
                    &condition("id", "eq", "18446744073709551614"),
                    &[],
                    0
                )
                .unwrap()
                .rows[0]["name"],
                "first"
            );
            // SQL mode must not change bound values or executable previews.
            run(
                &mut client,
                "SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES'",
            );
            let mode_filter = query_table(
                &mut client,
                &schema,
                "exact_keys",
                &condition("name", "contains", "change"),
                &[],
                0,
            )
            .unwrap();
            assert_eq!(mode_filter.rows.len(), 1);
            assert_eq!(run(&mut client, &mode_filter.sql_preview).rows.len(), 1);
            run(&mut client, "SET SESSION sql_mode = 'STRICT_TRANS_TABLES'");
            run(&mut client, "SET SESSION TRANSACTION READ ONLY");
            assert!(execute_sql(
                &mut client,
                &format!("SELECT * FROM {q}.many_rows LIMIT 2"),
                true
            )
            .is_ok());
            assert!(execute_sql(&mut client, &format!("SHOW TABLES FROM {q}"), true).is_ok());
            assert!(execute_sql(
                &mut client,
                &format!("SELECT 1; DROP TABLE {q}.many_rows"),
                true
            )
            .is_err());
            assert!(execute_sql(&mut client, &format!("DROP TABLE {q}.many_rows"), true).is_err());
            assert!(execute_sql(
                &mut client,
                &format!("UPDATE {q}.many_rows SET name='forbidden'"),
                true
            )
            .is_err());
            assert!(apply_table_changes(
                &mut client,
                &schema,
                "items",
                changes(json!({"inserts":[],"updates":[],"deletes":[]})),
                true
            )
            .is_err());
            run(&mut client, "SET SESSION TRANSACTION READ WRITE");
        }));
        let _ = execute_sql(&mut client, "SET SESSION TRANSACTION READ WRITE", false);
        run(&mut client, &format!("DROP DATABASE {q}"));
        if let Err(e) = result {
            std::panic::resume_unwind(e);
        }
    }

    #[test]
    #[ignore = "requires MY_POSTICO_TEST_MYSQL_URL"]
    fn mysql_tls_modes_and_tunnel_address() {
        let opts = Opts::from_url(&std::env::var("MY_POSTICO_TEST_MYSQL_URL").unwrap()).unwrap();
        let mut profile: ConnectionProfile = serde_json::from_value(json!({"engine":"mysql","id":"tls-test","name":"test","host":opts.ip_or_hostname(),"port":opts.tcp_port(),"database":opts.db_name().unwrap_or(""),"username":opts.user().unwrap_or("root"),"sslMode":"prefer","environment":"Local","readOnly":false,"ssh":{"enabled":false,"host":"","port":22,"username":"","authMethod":"agent","privateKeyPath":""}})).unwrap();
        let password = opts.pass().map(str::to_owned);
        let (_, preferred) = tauri::async_runtime::block_on(open(
            options(&profile, profile.port, false, password.clone()),
            true,
        ))
        .unwrap();
        let tls_available = preferred.ssl_opts().is_some();
        profile.ssl_mode = "require".into();
        assert_eq!(
            tauri::async_runtime::block_on(open(
                options(&profile, profile.port, false, password.clone()),
                false
            ))
            .is_ok(),
            tls_available
        );
        profile.ssl_mode = "verifyFull".into();
        // Disposable servers use an untrusted certificate or have no TLS.
        assert!(tauri::async_runtime::block_on(open(
            options(&profile, profile.port, false, password.clone()),
            false
        ))
        .is_err());
        profile.ssl_mode = if tls_available { "require" } else { "disable" }.into();
        profile.host = "postico-db-does-not-resolve.invalid".into();
        let (_, tunneled) = tauri::async_runtime::block_on(open(
            options(&profile, profile.port, true, password),
            false,
        ))
        .unwrap();
        assert_eq!(tunneled.ip_or_hostname(), profile.host);
    }

    #[test]
    #[ignore = "requires MY_POSTICO_TEST_MYSQL_URL"]
    fn mysql_query_cancellation_keeps_session_usable() {
        let mut client = conn();
        let options = Opts::from_url(&std::env::var("MY_POSTICO_TEST_MYSQL_URL").unwrap()).unwrap();
        let cancellation = QueryCancel {
            options,
            connection_id: client.id(),
        };
        let worker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            cancellation.cancel().unwrap();
        });
        let result = execute_sql(&mut client, "SELECT SLEEP(20)", false);
        worker.join().unwrap();
        // SLEEP can return 1 when interrupted instead of an error on some versions.
        assert!(
            result.is_err()
                || result.as_ref().unwrap().rows[0]
                    .values()
                    .any(|value| value == &json!(1))
        );
        assert_eq!(
            run(&mut client, "SELECT 42 AS answer").rows[0]["answer"],
            42
        );
    }
}
