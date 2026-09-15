export function statementForExecution(source: string, selectionStart: number, selectionEnd: number): string {
  const selected = source.slice(selectionStart, selectionEnd).trim();
  if (selected) return selected;

  const separators: number[] = [];
  let state: "normal" | "single" | "double" | "lineComment" | "blockComment" | "dollar" = "normal";
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
      if (current === "/" && next === "*") { blockDepth += 1; index += 1; }
      else if (current === "*" && next === "/") { blockDepth -= 1; index += 1; if (blockDepth === 0) state = "normal"; }
      continue;
    }
    if (state === "dollar") {
      if (source.startsWith(dollarTag, index)) { index += dollarTag.length - 1; state = "normal"; }
      continue;
    }
    if (state === "single") {
      if (current === "'" && next === "'") index += 1;
      else if (current === "'" && source[index - 1] !== "\\") state = "normal";
      continue;
    }
    if (state === "double") {
      if (current === '"' && next === '"') index += 1;
      else if (current === '"') state = "normal";
      continue;
    }

    if (current === "-" && next === "-") { state = "lineComment"; index += 1; }
    else if (current === "/" && next === "*") { state = "blockComment"; blockDepth = 1; index += 1; }
    else if (current === "'") state = "single";
    else if (current === '"') state = "double";
    else if (current === "$") {
      const match = source.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (match) { dollarTag = match[0]; state = "dollar"; index += dollarTag.length - 1; }
    } else if (current === ";") separators.push(index);
  }

  const cursor = Math.max(0, Math.min(selectionStart, source.length));
  const left = [...separators].reverse().find((position) => position < cursor) ?? -1;
  const right = separators.find((position) => position >= cursor) ?? source.length;
  const current = source.slice(left + 1, right).trim();
  if (current) return current;

  const previousLeft = [...separators].reverse().find((position) => position < left) ?? -1;
  return source.slice(previousLeft + 1, left).trim();
}
