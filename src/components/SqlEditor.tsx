import { acceptCompletion, autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { indentWithTab, toggleLineComment } from "@codemirror/commands";
import { MariaSQL, MySQL, PostgreSQL, sql } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import type { DatabaseEngine } from "../types";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export interface SqlCompletionItem {
  label: string;
  type: "keyword" | "function" | "class" | "property" | "variable" | "text";
  detail?: string;
  apply?: string;
  boost?: number;
}

export interface SqlEditorHandle {
  focus: () => void;
  selection: () => {from: number; to: number};
}

export interface SqlSelection {
  from: number;
  to: number;
  fromLine: number;
  fromColumn: number;
  toLine: number;
  toColumn: number;
}

interface Props {
  engine?: DatabaseEngine;
  value: string;
  onChange: (value: string) => void;
  onRun: (from: number, to: number) => void;
  getCompletions: (text: string, position: number) => Promise<SqlCompletionItem[]>;
  onSelectionChange?: (selection?: SqlSelection) => void;
}

const sqlHighlight = HighlightStyle.define([
  {tag: [tags.keyword, tags.bool, tags.null], color: "#53b9ff", fontWeight: "650"},
  {tag: tags.string, color: "#d7d879"},
  {tag: tags.number, color: "#bd9cff"},
  {tag: [tags.lineComment, tags.blockComment], color: "#687384", fontStyle: "italic"},
  {tag: tags.function(tags.variableName), color: "#71d5b2"},
  {tag: [tags.typeName, tags.className], color: "#72c8e7"},
  {tag: [tags.variableName, tags.propertyName], color: "#d8dce4"},
  {tag: [tags.operator, tags.punctuation], color: "#9ba3af"},
]);

export const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor({engine = "postgres", value, onChange, onRun, getCompletions, onSelectionChange}, forwardedRef) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | undefined>(undefined);
  const dialectRef = useRef(new Compartment());
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);
  const completionRef = useRef(getCompletions);
  const selectionChangeRef = useRef(onSelectionChange);
  onChangeRef.current = onChange;
  onRunRef.current = onRun;
  completionRef.current = getCompletions;
  selectionChangeRef.current = onSelectionChange;

  useImperativeHandle(forwardedRef, () => ({
    focus: () => viewRef.current?.focus(),
    selection: () => {
      const main = viewRef.current?.state.selection.main;
      return {from: main?.from ?? 0, to: main?.to ?? 0};
    },
  }), []);

  useEffect(() => {
    if (!hostRef.current) return;
    const completeSql = async (context: CompletionContext): Promise<CompletionResult | null> => {
      const word = context.matchBefore(/[\w$]*/) ?? {from: context.pos, to: context.pos, text: ""};
      const afterDot = context.pos > 0 && context.state.sliceDoc(context.pos - 1, context.pos) === ".";
      if (!context.explicit && word.from === word.to && !afterDot) return null;
      const options = await completionRef.current(context.state.doc.toString(), context.pos);
      if (options.length === 0) return null;
      return {from: word.from, options, validFor: /^[\w$]*$/};
    };
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: valueRef.current,
        extensions: [
          basicSetup,
          dialectRef.current.of(sql({dialect: engine === "postgres" ? PostgreSQL : engine === "mariadb" ? MariaSQL : MySQL})),
          syntaxHighlighting(sqlHighlight),
          EditorView.theme({
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {backgroundColor: "#7657bd99 !important"},
            ".cm-content ::selection": {backgroundColor: "#7657bd99 !important"},
          }, {dark: true}),
          autocompletion({override: [completeSql], activateOnTyping: true}),
          Prec.high(keymap.of([
            {key: "Tab", run: acceptCompletion},
            indentWithTab,
            {key: "Mod-/", run: toggleLineComment},
            {key: "Mod-Enter", run: (current) => { const main = current.state.selection.main; onRunRef.current(main.from, main.to); return true; }},
          ])),
          EditorView.domEventHandlers({
            keydown: (event, current) => {
              if (!(event.metaKey || event.ctrlKey) || event.key !== "Enter" || event.isComposing) return false;
              event.preventDefault();
              event.stopPropagation();
              const main = current.state.selection.main;
              onRunRef.current(main.from, main.to);
              return true;
            },
          }),
          EditorView.contentAttributes.of({"aria-label": "SQLエディタ", spellcheck: "false", autocapitalize: "none", autocorrect: "off"}),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const next = update.state.doc.toString();
              valueRef.current = next;
              onChangeRef.current(next);
            }
            if (update.selectionSet || update.docChanged) {
              const selection = update.state.selection.main;
              if (selection.empty) selectionChangeRef.current?.(undefined);
              else {
                const from = update.state.doc.lineAt(selection.from);
                const to = update.state.doc.lineAt(selection.to);
                selectionChangeRef.current?.({
                  from: selection.from,
                  to: selection.to,
                  fromLine: from.number,
                  fromColumn: selection.from - from.from + 1,
                  toLine: to.number,
                  toColumn: selection.to - to.from + 1,
                });
              }
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = undefined; };
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({effects: dialectRef.current.reconfigure(sql({dialect: engine === "postgres" ? PostgreSQL : engine === "mariadb" ? MariaSQL : MySQL}))});
  }, [engine]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === valueRef.current) return;
    valueRef.current = value;
    view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: value}});
  }, [value]);

  return <div className="sql-editor" ref={hostRef}/>;
});
