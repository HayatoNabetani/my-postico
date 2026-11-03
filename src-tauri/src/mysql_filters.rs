//! MySQL/MariaDB SQL generation. Values always travel as bound parameters.
use crate::models::{ColumnInfo, FilterNode, SortRule};
use mysql_async::Value;
use std::collections::{HashMap, HashSet};

pub struct CompiledFilter {
    pub sql: String,
    pub params: Vec<Value>,
    pub preview: String,
}

pub fn quote_identifier(value: &str) -> String {
    format!("`{}`", value.replace('`', "``"))
}

// Hex literals are independent of NO_BACKSLASH_ESCAPES and safe to copy/run.
pub fn literal(value: &str) -> String {
    if value.is_empty() {
        return "''".into();
    }
    format!(
        "CONVERT(X'{}' USING utf8mb4)",
        value
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

pub fn is_binary(data_type: &str) -> bool {
    let base = data_type.split(['(', ' ']).next().unwrap_or("");
    matches!(
        base,
        "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" | "bit"
    )
}

pub fn bound_value(value: &str, data_type: &str) -> Result<Value, String> {
    let base = data_type.split(['(', ' ']).next().unwrap_or("");
    if matches!(
        base,
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "year"
    ) {
        let value = if base == "tinyint" {
            match value.to_ascii_lowercase().as_str() {
                "true" => "1",
                "false" => "0",
                _ => value,
            }
        } else {
            value
        };
        return if data_type.contains("unsigned") || base == "year" {
            value
                .parse::<u64>()
                .map(Value::UInt)
                .map_err(|_| format!("{data_type}には符号なし整数を入力してください"))
        } else {
            value
                .parse::<i64>()
                .map(Value::Int)
                .map_err(|_| format!("{data_type}には整数を入力してください"))
        };
    }
    if matches!(base, "float" | "double" | "real") {
        return value
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite())
            .map(Value::Double)
            .ok_or_else(|| format!("{data_type}には数値を入力してください"));
    }
    if is_binary(data_type) {
        if let Some(hex) = value.strip_prefix("0x") {
            if hex.len() % 2 != 0 || !hex.is_ascii() {
                return Err("バイナリ値は0xに続く偶数桁の16進数で入力してください".into());
            }
            let bytes = (0..hex.len())
                .step_by(2)
                .map(|index| u8::from_str_radix(&hex[index..index + 2], 16))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| "バイナリ値に不正な16進数があります")?;
            return Ok(Value::Bytes(bytes));
        }
    }
    Ok(Value::Bytes(value.as_bytes().to_vec()))
}

fn placeholder(data_type: &str) -> String {
    // Comparing a DECIMAL column with a string can otherwise coerce both to
    // DOUBLE on MariaDB, losing digits in filters and composite primary keys.
    if let Some(spec) = data_type
        .strip_prefix("decimal(")
        .or_else(|| data_type.strip_prefix("numeric("))
    {
        if let Some((precision, scale)) =
            spec.split(')').next().and_then(|spec| spec.split_once(','))
        {
            if let (Ok(precision), Ok(scale)) = (precision.parse::<u8>(), scale.parse::<u8>()) {
                if precision > 0 && precision <= 65 && scale <= precision {
                    return format!("CAST(? AS DECIMAL({precision},{scale}))");
                }
            }
        }
    }
    "?".into()
}

pub fn typed_placeholder(data_type: &str) -> String {
    placeholder(data_type)
}

pub fn compile(root: &FilterNode, columns: &[ColumnInfo]) -> Result<CompiledFilter, String> {
    let lookup = columns
        .iter()
        .map(|column| (column.name.as_str(), column))
        .collect::<HashMap<_, _>>();
    let mut params = Vec::new();
    let result =
        compile_node(root, &lookup, &mut params)?.unwrap_or_else(|| ("TRUE".into(), "TRUE".into()));
    Ok(CompiledFilter {
        sql: result.0,
        preview: result.1,
        params,
    })
}

fn compile_node(
    node: &FilterNode,
    columns: &HashMap<&str, &ColumnInfo>,
    params: &mut Vec<Value>,
) -> Result<Option<(String, String)>, String> {
    match node {
        FilterNode::Group {
            conjunction,
            children,
            enabled,
        } => {
            if !enabled {
                return Ok(None);
            }
            let joiner = match conjunction.as_str() {
                "and" => " AND ",
                "or" => " OR ",
                _ => return Err("不正なフィルター結合方法です".into()),
            };
            let parts = children
                .iter()
                .map(|child| compile_node(child, columns, params))
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();
            if parts.is_empty() {
                return Ok(None);
            }
            Ok(Some((
                format!(
                    "({})",
                    parts
                        .iter()
                        .map(|part| part.0.as_str())
                        .collect::<Vec<_>>()
                        .join(joiner)
                ),
                format!(
                    "({})",
                    parts
                        .iter()
                        .map(|part| part.1.as_str())
                        .collect::<Vec<_>>()
                        .join(joiner)
                ),
            )))
        }
        FilterNode::Condition {
            column,
            operator,
            value,
            second_value,
            values,
            enabled,
        } => {
            if !enabled || column.is_empty() {
                return Ok(None);
            }
            let meta = columns
                .get(column.as_str())
                .ok_or_else(|| format!("カラム「{column}」は現在のテーブルに存在しません"))?;
            let identifier = quote_identifier(column);
            let unary = match operator.as_str() {
                "isNull" => Some("IS NULL"),
                "isNotNull" => Some("IS NOT NULL"),
                _ => None,
            };
            if let Some(unary) = unary {
                let sql = format!("{identifier} {unary}");
                return Ok(Some((sql.clone(), sql)));
            }
            if matches!(operator.as_str(), "in" | "notIn" | "between") {
                let items = if operator == "between" {
                    vec![
                        value
                            .as_deref()
                            .filter(|v| !v.is_empty())
                            .ok_or("範囲の下限を入力してください")?,
                        second_value
                            .as_deref()
                            .filter(|v| !v.is_empty())
                            .ok_or("範囲の上限を入力してください")?,
                    ]
                } else {
                    values
                        .as_ref()
                        .filter(|v| !v.is_empty())
                        .ok_or("フィルター値を1つ以上入力してください")?
                        .iter()
                        .map(String::as_str)
                        .collect()
                };
                let mut previews = Vec::new();
                for item in &items {
                    params.push(bound_value(item, &meta.data_type)?);
                    previews.push(value_literal(item, &meta.data_type));
                }
                return Ok(Some(if operator == "between" {
                    (
                        format!(
                            "{identifier} BETWEEN {} AND {}",
                            placeholder(&meta.data_type),
                            placeholder(&meta.data_type)
                        ),
                        format!("{identifier} BETWEEN {} AND {}", previews[0], previews[1]),
                    )
                } else {
                    let keyword = if operator == "in" { "IN" } else { "NOT IN" };
                    (
                        format!(
                            "{identifier} {keyword} ({})",
                            vec![placeholder(&meta.data_type); items.len()].join(", ")
                        ),
                        format!("{identifier} {keyword} ({})", previews.join(", ")),
                    )
                }));
            }
            let raw = value
                .as_deref()
                .filter(|v| !v.is_empty())
                .ok_or("フィルター値を入力してください")?;
            let pattern = matches!(
                operator.as_str(),
                "contains" | "notContains" | "startsWith" | "endsWith" | "like" | "ilike"
            );
            let comparison = match operator.as_str() {
                "eq" => "=",
                "neq" => "<>",
                "gt" => ">",
                "gte" => ">=",
                "lt" => "<",
                "lte" => "<=",
                "contains" | "startsWith" | "endsWith" | "like" | "ilike" => "LIKE",
                "notContains" => "NOT LIKE",
                _ => return Err(format!("未対応の演算子です: {operator}")),
            };
            if pattern {
                let escaped = raw.replace('!', "!!").replace('%', "!%").replace('_', "!_");
                let value = match operator.as_str() {
                    "contains" | "notContains" => format!("%{escaped}%"),
                    "startsWith" => format!("{escaped}%"),
                    "endsWith" => format!("%{escaped}"),
                    _ => raw.into(),
                };
                params.push(Value::Bytes(value.as_bytes().to_vec()));
                // Match the existing case-insensitive quick-filter behavior,
                // independently of a column's case-sensitive collation.
                let insensitive = operator != "like";
                let expression = if insensitive {
                    format!("LOWER(CONVERT({identifier} USING utf8mb4)) COLLATE utf8mb4_bin")
                } else {
                    format!("CONVERT({identifier} USING utf8mb4) COLLATE utf8mb4_bin")
                };
                let placeholder = if insensitive {
                    "LOWER(CONVERT(? USING utf8mb4)) COLLATE utf8mb4_bin"
                } else {
                    "CONVERT(? USING utf8mb4) COLLATE utf8mb4_bin"
                };
                let preview = if insensitive {
                    format!("LOWER({}) COLLATE utf8mb4_bin", literal(&value))
                } else {
                    format!("{} COLLATE utf8mb4_bin", literal(&value))
                };
                Ok(Some((
                    format!("{expression} {comparison} {placeholder} ESCAPE '!'"),
                    format!("{expression} {comparison} {preview} ESCAPE '!'"),
                )))
            } else {
                params.push(bound_value(raw, &meta.data_type)?);
                Ok(Some((
                    format!("{identifier} {comparison} {}", placeholder(&meta.data_type)),
                    format!(
                        "{identifier} {comparison} {}",
                        value_literal(raw, &meta.data_type)
                    ),
                )))
            }
        }
    }
}

fn value_literal(value: &str, data_type: &str) -> String {
    match bound_value(value, data_type) {
        Ok(Value::Int(n)) => return n.to_string(),
        Ok(Value::UInt(n)) => return n.to_string(),
        Ok(Value::Double(n)) => return n.to_string(),
        _ => {}
    }
    if is_binary(data_type) && value.starts_with("0x") {
        format!("X'{}'", &value[2..])
    } else if placeholder(data_type) != "?" {
        placeholder(data_type).replace('?', &literal(value))
    } else {
        literal(value)
    }
}

pub fn compile_order(columns: &[ColumnInfo], sorts: &[SortRule]) -> Result<String, String> {
    let available = columns
        .iter()
        .map(|column| column.name.as_str())
        .collect::<HashSet<_>>();
    let mut selected = HashSet::new();
    let mut parts = Vec::new();
    for sort in sorts {
        if !available.contains(sort.column.as_str()) {
            return Err(format!(
                "ソート対象のカラム「{}」は現在のテーブルに存在しません",
                sort.column
            ));
        }
        if !selected.insert(sort.column.as_str()) {
            return Err(format!(
                "カラム「{}」が複数回ソートに指定されています",
                sort.column
            ));
        }
        let direction = match sort.direction.as_str() {
            "asc" => "ASC",
            "desc" => "DESC",
            _ => return Err("不正なソート方向です".into()),
        };
        let null_direction = match sort.nulls.as_str() {
            "first" => "DESC",
            "last" => "ASC",
            _ => return Err("不正なNULLの並び順です".into()),
        };
        let name = quote_identifier(&sort.column);
        parts.push(format!("({name} IS NULL) {null_direction}"));
        parts.push(format!("{name} {direction}"));
    }
    for column in columns
        .iter()
        .filter(|column| column.primary_key && !selected.contains(column.name.as_str()))
    {
        parts.push(format!("{} ASC", quote_identifier(&column.name)));
    }
    // MySQL has no visible ctid. A keyless table can only use its columns;
    // identical rows cannot be ordered uniquely, and are not editable by key.
    if parts.is_empty() {
        parts.extend(
            columns
                .iter()
                .filter(|column| !is_binary(&column.data_type))
                .map(|column| format!("{} ASC", quote_identifier(&column.name))),
        );
    }
    Ok(if parts.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", parts.join(", "))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_binary_and_unknown_columns() {
        for value in ["0x0", "0xzz", "0x日本語"] {
            assert!(bound_value(value, "varbinary(32)").is_err());
        }
        assert_eq!(
            bound_value("0x00ff", "blob").unwrap(),
            Value::Bytes(vec![0, 255])
        );
        assert_eq!(quote_identifier("a`b"), "`a``b`");
        let root = FilterNode::Condition {
            column: "missing".into(),
            operator: "eq".into(),
            value: Some("x".into()),
            second_value: None,
            values: None,
            enabled: true,
        };
        assert!(compile(&root, &[]).is_err());
    }
}
