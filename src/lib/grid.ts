import type { SortDirection, SortRule } from "../types";

export type ListSort = SortDirection | undefined;

export const SQL_RESULT_PAGE_SIZE = 500;

export function pageRowIndices(indices: number[], offset: number, pageSize?: number): number[] {
  return pageSize === undefined ? indices : indices.slice(offset, offset + pageSize);
}

export function nextSort(direction: ListSort): ListSort {
  return direction === undefined ? "desc" : direction === "desc" ? "asc" : undefined;
}

export function sortByName<T extends { name: string }>(items: T[], direction: ListSort): T[] {
  if (!direction) return items;
  return [...items].sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }) * (direction === "asc" ? 1 : -1));
}

export function orderedColumns(columns: string[], order: string[]): string[] {
  return [...order.filter((column) => columns.includes(column)), ...columns.filter((column) => !order.includes(column))];
}

function compareNumericText(left: string, right: string): number | undefined {
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(left) || !/^[+-]?\d+(?:\.\d+)?$/.test(right)) return undefined;
  const parts = (value: string) => {
    const [whole, fraction = ""] = value.replace(/^[+-]/, "").split(".");
    const integer = whole.replace(/^0+(?=\d)/, "");
    const decimal = fraction.replace(/0+$/, "");
    return {integer, decimal, negative: value.startsWith("-") && (integer !== "0" || decimal !== "")};
  };
  const a = parts(left), b = parts(right);
  if (a.negative !== b.negative) return a.negative ? -1 : 1;
  const size = Math.max(a.decimal.length, b.decimal.length);
  const x = a.decimal.padEnd(size, "0"), y = b.decimal.padEnd(size, "0");
  const comparison = a.integer.length - b.integer.length || (a.integer < b.integer ? -1 : a.integer > b.integer ? 1 : x < y ? -1 : x > y ? 1 : 0);
  return comparison * (a.negative ? -1 : 1);
}

export function sortRowIndices(rows: Record<string, unknown>[], sorts: SortRule[]): number[] {
  const indices = rows.map((_, index) => index);
  if (!sorts.length) return indices;
  return indices.sort((a, b) => {
    for (const sort of sorts) {
      const left = rows[a][sort.column];
      const right = rows[b][sort.column];
      const leftNull = left === null || left === undefined;
      const rightNull = right === null || right === undefined;
      if (leftNull || rightNull) {
        if (leftNull && rightNull) continue;
        return (leftNull ? -1 : 1) * (sort.nulls === "first" ? 1 : -1);
      }
      const comparison = typeof left === "number" && typeof right === "number"
        ? left - right
        : typeof left === "boolean" && typeof right === "boolean"
          ? Number(left) - Number(right)
          : typeof left === "string" && typeof right === "string" && compareNumericText(left, right) !== undefined
            ? compareNumericText(left, right)!
          : String(typeof left === "object" ? JSON.stringify(left) : left).localeCompare(String(typeof right === "object" ? JSON.stringify(right) : right), "ja", { numeric: true });
      if (comparison) return comparison * (sort.direction === "asc" ? 1 : -1);
    }
    return a - b;
  });
}
