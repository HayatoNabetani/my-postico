export type Environment = "Local" | "Development" | "Staging" | "Production";
export type SshAuthMethod = "password" | "privateKey" | "agent";

export interface SshConfig {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath: string;
  trustedFingerprint?: string;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  sslMode: "disable" | "prefer" | "require" | "verifyFull";
  environment: Environment;
  readOnly: boolean;
  ssh: SshConfig;
}

export interface ProfileSecrets {
  dbPassword?: string;
  sshPassword?: string;
  keyPassphrase?: string;
}

export interface SchemaInfo { name: string }
export interface TableInfo { schema: string; name: string; kind: "table" | "view" | "materialized_view" }
export interface FunctionInfo { schema: string; name: string; arguments: string; returnType: string; kind: "function" | "procedure" }

export interface ForeignKeyInfo {
  schema: string;
  table: string;
  column: string;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  foreignKey?: ForeignKeyInfo;
}

export type FilterOperator =
  | "eq" | "neq" | "gt" | "gte" | "lt" | "lte"
  | "contains" | "notContains" | "startsWith" | "endsWith"
  | "like" | "ilike" | "isNull" | "isNotNull" | "between" | "in" | "notIn";

export interface FilterCondition {
  id: string;
  kind: "condition";
  column: string;
  operator: FilterOperator;
  value?: string;
  secondValue?: string;
  values?: string[];
  enabled: boolean;
}

export interface FilterGroup {
  id: string;
  kind: "group";
  conjunction: "and" | "or";
  children: Array<FilterGroup | FilterCondition>;
  enabled: boolean;
}

export interface QueryPage {
  columns: string[];
  rows: Record<string, unknown>[];
  hasMore: boolean;
  sqlPreview: string;
}

export type SortDirection = "asc" | "desc";
export type NullsOrder = "first" | "last";

export interface SortRule {
  column: string;
  direction: SortDirection;
  nulls: NullsOrder;
}

export interface TableRowUpdate {
  primaryKey: Record<string, unknown>;
  values: Record<string, unknown>;
}

export interface PendingTableRow {
  id: string;
  values: Record<string, string>;
}

export interface TableChanges {
  updates: TableRowUpdate[];
  inserts: Record<string, unknown>[];
  deletes: Record<string, unknown>[];
}

export interface TableChangeResult {
  inserted: number;
  updated: number;
  deleted: number;
}

export interface SavedFilter {
  id: string;
  profileId: string;
  schema: string;
  table: string;
  name: string;
  root: FilterGroup;
}

export interface SavedQuery {
  id: string;
  profileId: string;
  folderId?: string;
  name: string;
  sql: string;
  updatedAt: string;
}

export interface QueryFolder {
  id: string;
  profileId: string;
  name: string;
}
