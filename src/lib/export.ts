import type { QueryPage } from "../types";

export type ExportFormat = "csv" | "json";

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[,\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function serializeQueryPage(page: QueryPage, format: ExportFormat): string {
  if (format === "json") return JSON.stringify(page.rows, null, 2);
  return [page.columns.map(csvCell).join(","), ...page.rows.map((row) => page.columns.map((column) => csvCell(row[column])).join(","))].join("\r\n");
}

export function exportFileName(baseName: string, format: ExportFormat): string {
  const safeName = baseName.replace(/[\\/:*?"<>|]/g, "_").trim() || "query-results";
  return `${safeName}.${format}`;
}
