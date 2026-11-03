use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseEngine {
    #[default]
    Postgres,
    Mysql,
    Mariadb,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    #[serde(default)]
    pub engine: DatabaseEngine,
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub ssl_mode: String,
    pub environment: String,
    pub read_only: bool,
    pub ssh: SshConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub private_key_path: String,
    pub trusted_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSecrets {
    pub db_password: Option<String>,
    pub ssh_password: Option<String>,
    pub key_passphrase: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo { pub name: String }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo { pub schema: String, pub name: String, pub kind: String }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionInfo {
    pub schema: String,
    pub name: String,
    pub arguments: String,
    pub return_type: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyInfo {
    pub schema: String,
    pub table: String,
    pub column: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    pub foreign_key: Option<ForeignKeyInfo>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FilterNode {
    Condition {
        column: String,
        operator: String,
        value: Option<String>,
        second_value: Option<String>,
        values: Option<Vec<String>>,
        enabled: bool,
    },
    Group {
        conjunction: String,
        children: Vec<FilterNode>,
        enabled: bool,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryPage {
    pub columns: Vec<String>,
    pub rows: Vec<serde_json::Map<String, serde_json::Value>>,
    pub has_more: bool,
    pub sql_preview: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortRule {
    pub column: String,
    pub direction: String,
    pub nulls: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRowUpdate {
    pub primary_key: serde_json::Map<String, serde_json::Value>,
    pub values: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableChanges {
    pub updates: Vec<TableRowUpdate>,
    pub inserts: Vec<serde_json::Map<String, serde_json::Value>>,
    pub deletes: Vec<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableChangeResult {
    pub inserted: u64,
    pub updated: u64,
    pub deleted: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn existing_profiles_default_to_postgres_without_losing_settings() {
        let old = serde_json::json!({"id":"existing-id", "name":"Production", "host":"db.internal", "port":5432, "database":"app", "username":"app", "sslMode":"verifyFull", "environment":"Production", "readOnly":true, "ssh":{"enabled":true,"host":"bastion","port":22,"username":"app","authMethod":"agent","privateKeyPath":"","trustedFingerprint":"SHA256:existing"}});
        let mut profile: ConnectionProfile = serde_json::from_value(old).unwrap();
        assert_eq!(profile.engine, DatabaseEngine::Postgres);
        assert_eq!(profile.id, "existing-id");
        assert_eq!(profile.ssl_mode, "verifyFull");
        assert_eq!(profile.ssh.trusted_fingerprint.as_deref(), Some("SHA256:existing"));
        for engine in [DatabaseEngine::Postgres, DatabaseEngine::Mysql, DatabaseEngine::Mariadb] {
            profile.engine = engine;
            let restored: ConnectionProfile = serde_json::from_value(serde_json::to_value(&profile).unwrap()).unwrap();
            assert_eq!(restored.engine, engine);
        }
    }
}
