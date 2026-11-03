import type { DatabaseEngine } from "../types";

export function statementForExecution(source: string, selectionStart: number, selectionEnd: number, engine: DatabaseEngine = "postgres"): string {
  const selected = source.slice(selectionStart, selectionEnd).trim();
  if (selected) return selected;

  const separators: number[] = [];
  let state: "normal" | "single" | "double" | "backtick" | "lineComment" | "blockComment" | "dollar" = "normal";
  const mysql = engine !== "postgres";
  let blockDepth = 0;
  let dollarTag = "";

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (state === "lineComment") {
      if (current === "\n") state = "normal";
      continue;
    }
    if (state === "blockComment") {
      if (!mysql && current === "/" && next === "*") { blockDepth += 1; index += 1; }
      else if (current === "*" && next === "/") { blockDepth -= 1; index += 1; if (blockDepth === 0) state = "normal"; }
      continue;
    }
    if (state === "dollar") {
      if (source.startsWith(dollarTag, index)) { index += dollarTag.length - 1; state = "normal"; }
      continue;
    }
    if (state === "single") {
      if (current === "\\" && mysql) { index += 1; continue; }
      if (current === "'" && next === "'") index += 1;
      else if (current === "'" && (mysql || source[index - 1] !== "\\")) state = "normal";
      continue;
    }
    if (state === "double") {
      if (current === "\\" && mysql) { index += 1; continue; }
      if (current === '"' && next === '"') index += 1;
      else if (current === '"') state = "normal";
      continue;
    }
    if (state === "backtick") {
      if (current === "`" && next === "`") index += 1;
      else if (current === "`") state = "normal";
      continue;
    }

    if (current === "-" && next === "-" && (!mysql || !source[index + 2] || /\s/.test(source[index + 2]))) { state = "lineComment"; index += 1; }
    else if (current === "#" && mysql) state = "lineComment";
    else if (current === "/" && next === "*") { state = "blockComment"; blockDepth = 1; index += 1; }
    else if (current === "'") state = "single";
    else if (current === '"') state = "double";
    else if (current === "`" && mysql) state = "backtick";
    else if (current === "$" && !mysql) {
      const match = source.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (match) { dollarTag = match[0]; state = "dollar"; index += dollarTag.length - 1; }
    } else if (current === ";") separators.push(index);
  }

  let cursor = Math.max(0, Math.min(selectionStart, source.length));
  // A caret after the terminator (or its trailing spaces/comment) still
  // belongs to the statement ending on that line, not the following one.
  const lineStart = source.lastIndexOf("\n", cursor - 1) + 1;
  const terminator = [...separators].reverse().find((position) => position < cursor);
  if (terminator !== undefined && terminator >= lineStart && /^[\t \r]*(?:--[^\n]*)?$/.test(source.slice(terminator + 1, cursor))) {
    cursor = terminator;
  }
  const left = [...separators].reverse().find((position) => position < cursor) ?? -1;
  const right = separators.find((position) => position >= cursor) ?? source.length;
  const current = source.slice(left + 1, right).trim();
  if (current) return current;

  const previousLeft = [...separators].reverse().find((position) => position < left) ?? -1;
  return source.slice(previousLeft + 1, left).trim();
}
