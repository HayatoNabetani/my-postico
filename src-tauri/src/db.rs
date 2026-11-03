//! Dispatch database operations without exposing driver types to Tauri commands.
use crate::{models::*, mysql_db, postgres_db};
use std::sync::{Arc, Mutex};

pub enum ConnectedDb {
    Postgres(postgres_db::ConnectedDb),
    Mysql(mysql_db::ConnectedDb),
}

#[derive(Clone)]
enum CancelRequest {
    Postgres(postgres_db::QueryCancel),
    Mysql(mysql_db::QueryCancel),
}

#[derive(Clone)]
pub struct QueryCancel {
    request: CancelRequest,
    active: Arc<Mutex<bool>>,
}

impl QueryCancel {
    pub fn cancel(&self) -> Result<(), String> {
        // Serialize completion with cancellation so a late request cannot kill
        // the next query that reuses this database session.
        let active = self
            .active
            .lock()
            .map_err(|_| "キャンセル状態をロックできません")?;
        if !*active {
            return Ok(());
        }
        match &self.request {
            CancelRequest::Postgres(request) => request.cancel(),
            CancelRequest::Mysql(request) => request.cancel(),
        }
    }

    pub fn finish(&self) {
        if let Ok(mut active) = self.active.lock() {
            *active = false;
        }
    }
}

impl ConnectedDb {
    pub fn is_closed(&self) -> bool {
        match self {
            Self::Postgres(db) => db.client.is_closed(),
            Self::Mysql(db) => db.broken,
        }
    }

    pub fn read_only(&self) -> bool {
        match self {
            Self::Postgres(db) => db.read_only,
            Self::Mysql(db) => db.read_only,
        }
    }

    pub fn cancel_request(&self) -> QueryCancel {
        let request = match self {
            Self::Postgres(db) => CancelRequest::Postgres(db.cancel_request()),
            Self::Mysql(db) => CancelRequest::Mysql(db.cancel_request()),
        };
        QueryCancel {
            request,
            active: Arc::new(Mutex::new(true)),
        }
    }

    pub fn keep_alive(&mut self) -> Result<(), String> {
        match self {
            Self::Postgres(db) => db
                .client
                .simple_query("SELECT 1")
                .map(|_| ())
                .map_err(|e| e.to_string()),
            Self::Mysql(db) => db.keep_alive(),
        }
    }
}

pub fn connect(profile: &ConnectionProfile) -> Result<ConnectedDb, String> {
    match profile.engine {
        DatabaseEngine::Postgres => postgres_db::connect(profile).map(ConnectedDb::Postgres),
        DatabaseEngine::Mysql | DatabaseEngine::Mariadb => {
            mysql_db::connect(profile).map(ConnectedDb::Mysql)
        }
    }
}

macro_rules! dispatch {
    ($name:ident($($arg:ident: $ty:ty),*) -> $result:ty) => {
        pub fn $name(db: &mut ConnectedDb, $($arg: $ty),*) -> Result<$result, String> {
            match db {
                ConnectedDb::Postgres(db) => postgres_db::$name(&mut db.client, $($arg),*),
                ConnectedDb::Mysql(db) => {
                    let result = mysql_db::$name(&mut db.client, $($arg),*);
                    if result.as_ref().err().is_some_and(|e| e.contains("MySQL transport error")) { db.broken = true; }
                    result
                },
            }
        }
    };
}

dispatch!(schemas() -> Vec<SchemaInfo>);
dispatch!(tables(schema: &str) -> Vec<TableInfo>);
dispatch!(functions(schema: &str) -> Vec<FunctionInfo>);
dispatch!(function_ddl(schema: &str, name: &str, arguments: &str) -> String);
dispatch!(columns(schema: &str, table: &str) -> Vec<ColumnInfo>);
dispatch!(table_ddl(schema: &str, table: &str) -> String);
dispatch!(query_table(schema: &str, table: &str, filter: &FilterNode, sorts: &[SortRule], offset: u32) -> QueryPage);

pub fn apply_table_changes(
    db: &mut ConnectedDb,
    schema: &str,
    table: &str,
    changes: TableChanges,
) -> Result<TableChangeResult, String> {
    let read_only = db.read_only();
    match db {
        ConnectedDb::Postgres(db) => {
            postgres_db::apply_table_changes(&mut db.client, schema, table, changes, read_only)
        }
        ConnectedDb::Mysql(db) => {
            let result =
                mysql_db::apply_table_changes(&mut db.client, schema, table, changes, read_only);
            if result
                .as_ref()
                .err()
                .is_some_and(|e| e.contains("MySQL transport error"))
            {
                db.broken = true;
            }
            result
        }
    }
}

pub fn execute_sql(db: &mut ConnectedDb, sql: &str) -> Result<QueryPage, String> {
    let read_only = db.read_only();
    match db {
        ConnectedDb::Postgres(db) => postgres_db::execute_sql(&mut db.client, sql, read_only),
        ConnectedDb::Mysql(db) => {
            let result = mysql_db::execute_sql(&mut db.client, sql, read_only);
            if result
                .as_ref()
                .err()
                .is_some_and(|e| e.contains("MySQL transport error"))
            {
                db.broken = true;
            }
            result
        }
    }
}
