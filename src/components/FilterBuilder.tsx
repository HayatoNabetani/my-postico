import { useEffect, useRef } from "react";
import { Brackets, ChevronDown, Copy, Filter, Plus, Save, Trash2, X } from "lucide-react";
import type { ColumnInfo, FilterCondition, FilterGroup, FilterOperator, SavedFilter } from "../types";

const operators: Array<[FilterOperator, string]> = [
  ["eq", "等しい"], ["neq", "等しくない"], ["contains", "含む"], ["notContains", "含まない"],
  ["startsWith", "で始まる"], ["endsWith", "で終わる"], ["gt", ">"], ["gte", "≥"], ["lt", "<"], ["lte", "≤"],
  ["between", "範囲"], ["in", "いずれか"], ["notIn", "いずれでもない"], ["isNull", "NULL"], ["isNotNull", "NULLではない"],
];
const noValue = new Set<FilterOperator>(["isNull", "isNotNull"]);

function choicesFor(columnName: string, columns: ColumnInfo[]) {
  const type = columns.find((column) => column.name === columnName)?.dataType ?? "text";
  const nullChecks: FilterOperator[] = ["isNull", "isNotNull"];
  let allowed: FilterOperator[];
  if (type === "boolean") allowed = ["eq", "neq", ...nullChecks];
  else if (/int|numeric|decimal|real|double|date|time/.test(type)) allowed = ["eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "notIn", ...nullChecks];
  else if (type === "json" || type === "jsonb") allowed = ["eq", "neq", "contains", ...nullChecks];
  else allowed = ["eq", "neq", "contains", "notContains", "startsWith", "endsWith", "like", "ilike", "in", "notIn", ...nullChecks];
  return operators.filter(([operator]) => allowed.includes(operator));
}

export const newCondition = (column = ""): FilterCondition => ({ id: crypto.randomUUID(), kind: "condition", column, operator: "eq", value: "", enabled: true });
export const emptyFilter = (): FilterGroup => ({ id: crypto.randomUUID(), kind: "group", conjunction: "and", enabled: true, children: [] });

interface Props {
  root: FilterGroup;
  columns: ColumnInfo[];
  saved: SavedFilter[];
  loading: boolean;
  focusRequest?: number;
  onChange: (value: FilterGroup) => void;
  onApply: () => void;
  onClear: () => void;
  onSave: () => void;
  onLoad: (filter: SavedFilter) => void;
  onDeleteSaved: (id: string) => void;
}

function updateCondition(root: FilterGroup, id: string, patch: Partial<FilterCondition>): FilterGroup {
  return { ...root, children: root.children.map((item) => item.kind === "condition" ? (item.id === id ? {...item, ...patch} : item) : updateCondition(item, id, patch)) };
}
function removeNode(root: FilterGroup, id: string): FilterGroup {
  return { ...root, children: root.children.filter((item) => item.id !== id).map((item) => item.kind === "group" ? removeNode(item, id) : item) };
}
function updateGroup(root: FilterGroup, id: string, transform: (group: FilterGroup) => FilterGroup): FilterGroup {
  if (root.id === id) return transform(root);
  return { ...root, children: root.children.map((item) => item.kind === "group" ? updateGroup(item, id, transform) : item) };
}

export function FilterBuilder(props: Props) {
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!props.focusRequest) return;
    const focusFirstField = () => {
      const field = panelRef.current?.querySelector<HTMLInputElement>(".condition-row input:not([type=checkbox])")
        ?? panelRef.current?.querySelector<HTMLSelectElement>(".condition-row select");
      field?.focus();
      if (field instanceof HTMLInputElement) field.select();
    };
    if (props.root.children.length === 0) {
      props.onChange({...props.root, children: [newCondition(props.columns[0]?.name)]});
      requestAnimationFrame(() => requestAnimationFrame(focusFirstField));
    } else {
      focusFirstField();
    }
  }, [props.focusRequest]);

  const renderGroup = (group: FilterGroup, depth = 0): React.ReactNode => <div className={`filter-group depth-${Math.min(depth, 2)}`} key={group.id}>
    <div className="group-rail">
      <button className="conjunction" onClick={() => props.onChange(updateGroup(props.root, group.id, (g) => ({...g, conjunction: g.conjunction === "and" ? "or" : "and"})))}>{group.conjunction.toUpperCase()} <ChevronDown size={12}/></button>
      {depth > 0 && <button className="mini-icon" onClick={() => props.onChange(removeNode(props.root, group.id))}><X size={13}/></button>}
    </div>
    <div className="conditions">
      {group.children.map((node) => node.kind === "group" ? renderGroup(node, depth + 1) : <div className="condition-row" key={node.id}>
        <input className="condition-enabled" type="checkbox" checked={node.enabled} onChange={(e) => props.onChange(updateCondition(props.root, node.id, {enabled: e.target.checked}))}/>
        <select value={node.column} onChange={(e) => props.onChange(updateCondition(props.root, node.id, {column: e.target.value, operator: "eq"}))}><option value="">カラムを選択</option>{props.columns.map((column) => <option key={column.name}>{column.name}</option>)}</select>
        <select value={node.operator} onChange={(e) => props.onChange(updateCondition(props.root, node.id, {operator: e.target.value as FilterOperator}))}>{choicesFor(node.column, props.columns).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
        {!noValue.has(node.operator) && <input value={node.value ?? ""} placeholder={node.operator === "in" || node.operator === "notIn" ? "値1, 値2, …" : "値"} onChange={(e) => props.onChange(updateCondition(props.root, node.id, {value: e.target.value, values: e.target.value.split(",").map(v => v.trim()).filter(Boolean)}))}/>} 
        {node.operator === "between" && <input value={node.secondValue ?? ""} placeholder="上限" onChange={(e) => props.onChange(updateCondition(props.root, node.id, {secondValue: e.target.value}))}/>} 
        <button className="mini-icon" title="複製" onClick={() => props.onChange(updateGroup(props.root, group.id, (g) => ({...g, children: [...g.children, {...node, id: crypto.randomUUID()}]})))}><Copy size={14}/></button>
        <button className="mini-icon danger" title="削除" onClick={() => props.onChange(removeNode(props.root, node.id))}><Trash2 size={14}/></button>
      </div>)}
      <div className="add-actions">
        <button onClick={() => props.onChange(updateGroup(props.root, group.id, (g) => ({...g, children: [...g.children, newCondition(props.columns[0]?.name)]})))}><Plus size={14}/>条件</button>
        <button onClick={() => props.onChange(updateGroup(props.root, group.id, (g) => ({...g, children: [...g.children, {...emptyFilter(), children: [newCondition(props.columns[0]?.name)]}]})))}><Brackets size={14}/>グループ</button>
      </div>
    </div>
  </div>;

  return <section className="filter-panel" ref={panelRef}>
    <header className="filter-header"><div><Filter size={16}/><strong>Filter</strong><kbd>⌘F</kbd><span className="count-badge">{props.root.children.length}</span></div><div className="filter-tools">
      {props.saved.length > 0 && <select defaultValue="" onChange={(e) => { const match = props.saved.find((item) => item.id === e.target.value); if (match) props.onLoad(match); }}><option value="">保存済みフィルター</option>{props.saved.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
      <button onClick={props.onSave}><Save size={14}/>保存</button><button onClick={props.onClear}>クリア</button><button className="primary compact" disabled={props.loading} onClick={props.onApply}>{props.loading ? "適用中…" : "適用"}</button>
    </div></header>
    {renderGroup(props.root)}
    {props.saved.length > 0 && <div className="saved-chips">{props.saved.map((item) => <span key={item.id}>{item.name}<button title="保存済みフィルターを削除" onClick={() => props.onDeleteSaved(item.id)}><X size={11}/></button></span>)}</div>}
  </section>;
}
