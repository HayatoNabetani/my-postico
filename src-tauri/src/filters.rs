use crate::models::{ColumnInfo, FilterNode};
use std::collections::HashMap;

pub struct CompiledFilter {
    pub sql: String,
    pub params: Vec<String>,
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn cast_for(data_type: &str) -> &'static str {
    match data_type {
        "smallint" => "smallint", "integer" => "integer", "bigint" => "bigint",
        "numeric" | "decimal" => "numeric", "real" => "real", "double precision" => "double precision",
        "boolean" => "boolean", "date" => "date", "timestamp without time zone" => "timestamp",
        "timestamp with time zone" => "timestamptz", "time without time zone" => "time",
        "time with time zone" => "timetz", "uuid" => "uuid", "json" => "json", "jsonb" => "jsonb",
        _ => "text",
    }
}

fn pattern_value(operator: &str, value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    match operator { "contains" | "notContains" => format!("%{escaped}%"), "startsWith" => format!("{escaped}%"), "endsWith" => format!("%{escaped}"), _ => value.to_owned() }
}

pub fn compile(root: &FilterNode, columns: &[ColumnInfo]) -> Result<CompiledFilter, String> {
    let lookup: HashMap<&str, &ColumnInfo> = columns.iter().map(|column| (column.name.as_str(), column)).collect();
    let mut params = Vec::new();
    let sql = compile_node(root, &lookup, &mut params)?.unwrap_or_else(|| "TRUE".into());
    Ok(CompiledFilter { sql, params })
}

fn compile_node(node: &FilterNode, columns: &HashMap<&str, &ColumnInfo>, params: &mut Vec<String>) -> Result<Option<String>, String> {
    match node {
        FilterNode::Group { conjunction, children, enabled } => {
            if !enabled { return Ok(None); }
            let joiner = match conjunction.as_str() { "and" => " AND ", "or" => " OR ", _ => return Err("不正なフィルター結合方法です".into()) };
            let parts = children.iter().map(|item| compile_node(item, columns, params)).collect::<Result<Vec<_>, _>>()?.into_iter().flatten().collect::<Vec<_>>();
            Ok(match parts.len() { 0 => None, 1 => parts.into_iter().next(), _ => Some(format!("({})", parts.join(joiner))) })
        }
        FilterNode::Condition { column, operator, value, second_value, values, enabled } => {
            if !enabled || column.is_empty() { return Ok(None); }
            let meta = columns.get(column.as_str()).ok_or_else(|| format!("カラム「{column}」は現在のテーブルに存在しません"))?;
            let identifier = quote_identifier(column);
            let cast = cast_for(&meta.data_type);
            let unary = match operator.as_str() { "isNull" => Some("IS NULL"), "isNotNull" => Some("IS NOT NULL"), _ => None };
            if let Some(unary) = unary { return Ok(Some(format!("{identifier} {unary}"))); }
            if operator == "between" {
                let first = value.as_deref().filter(|v| !v.is_empty()).ok_or("範囲の下限を入力してください")?;
                let second = second_value.as_deref().filter(|v| !v.is_empty()).ok_or("範囲の上限を入力してください")?;
                params.push(first.into()); let p1 = params.len(); params.push(second.into()); let p2 = params.len();
                return Ok(Some(format!("{identifier} BETWEEN ${p1}::{cast} AND ${p2}::{cast}")));
            }
            if matches!(operator.as_str(), "in" | "notIn") {
                let items = values.as_ref().filter(|v| !v.is_empty()).ok_or("フィルター値を1つ以上入力してください")?;
                let mut placeholders = Vec::new();
                for item in items { params.push(item.clone()); placeholders.push(format!("${}::{cast}", params.len())); }
                let keyword = if operator == "in" { "IN" } else { "NOT IN" };
                return Ok(Some(format!("{identifier} {keyword} ({})", placeholders.join(", "))));
            }
            let raw = value.as_deref().ok_or("フィルター値を入力してください")?;
            let comparison = match operator.as_str() {
                "eq" => "=", "neq" => "<>", "gt" => ">", "gte" => ">=", "lt" => "<", "lte" => "<=",
                "contains" | "startsWith" | "endsWith" | "ilike" => "ILIKE",
                "notContains" => "NOT ILIKE", "like" => "LIKE",
                _ => return Err(format!("未対応の演算子です: {operator}")),
            };
            let is_pattern = matches!(operator.as_str(), "contains" | "notContains" | "startsWith" | "endsWith");
            params.push(pattern_value(operator, raw));
            let placeholder = params.len();
            let expression = if is_pattern {
                format!("{identifier}::text {comparison} ${placeholder}::text ESCAPE E'\\\\'")
            } else {
                format!("{identifier} {comparison} ${placeholder}::{cast}")
            };
            Ok(Some(expression))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn columns() -> Vec<ColumnInfo> { vec![ColumnInfo { name: "name".into(), data_type: "text".into(), nullable: false, primary_key: false }] }

    #[test]
    fn compiles_parameters_without_interpolation() {
        let filter = FilterNode::Condition { column: "name".into(), operator: "contains".into(), value: Some("a%' OR true --".into()), second_value: None, values: None, enabled: true };
        let result = compile(&filter, &columns()).unwrap();
        assert!(result.sql.contains("$1"));
        assert!(!result.sql.contains("OR true"));
        assert_eq!(result.params[0], "%a\\%' OR true --%");
    }

    #[test]
    fn rejects_unknown_columns() {
        let filter = FilterNode::Condition { column: "missing".into(), operator: "eq".into(), value: Some("x".into()), second_value: None, values: None, enabled: true };
        assert!(compile(&filter, &columns()).is_err());
    }

    #[test]
    fn accepts_frontend_group_shape() {
        let json = r#"{"id":"root","kind":"group","conjunction":"or","enabled":true,"children":[{"id":"one","kind":"condition","column":"name","operator":"between","value":"a","secondValue":"z","enabled":true}]}"#;
        let filter: FilterNode = serde_json::from_str(json).unwrap();
        let result = compile(&filter, &columns()).unwrap();
        assert!(result.sql.contains("BETWEEN $1::text AND $2::text"));
        assert_eq!(result.params, ["a", "z"]);
    }
}
