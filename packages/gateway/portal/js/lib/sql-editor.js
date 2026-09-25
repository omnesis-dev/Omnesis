// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// CodeMirror 6 SQL editor + a static highlight helper.
//
// `SqlEditor` is the writable component used by the SQL tab. `highlightSqlToHtml`
// runs the same SQL parser + highlight style over a string and returns HTML
// for read-only spots (starter queries on the Data tab, recent queries list).
//
// Both share one HighlightStyle so colour/styling is consistent everywhere.
// Token CSS lives in style.css under `.cm-tok-*` (also reused by static
// blocks, since the static helper emits the same class names).

import { html } from "htm/preact";
import { useEffect, useRef } from "preact/hooks";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  highlightActiveLine,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
  HighlightStyle,
} from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { sql, StandardSQL } from "@codemirror/lang-sql";
import { tags as t } from "@lezer/highlight";
import { highlightTree } from "@lezer/highlight";

const sqlHighlightStyle = HighlightStyle.define([
  { tag: t.keyword,                       class: "cm-tok-keyword" },
  { tag: [t.string, t.special(t.string)], class: "cm-tok-string" },
  { tag: t.number,                        class: "cm-tok-number" },
  { tag: t.bool,                          class: "cm-tok-atom" },
  { tag: t.null,                          class: "cm-tok-atom" },
  { tag: [t.lineComment, t.blockComment], class: "cm-tok-comment" },
  { tag: t.operator,                      class: "cm-tok-operator" },
  { tag: t.punctuation,                   class: "cm-tok-punct" },
  { tag: [t.variableName, t.propertyName], class: "cm-tok-name" },
  { tag: t.function(t.variableName),      class: "cm-tok-func" },
  { tag: t.typeName,                      class: "cm-tok-type" },
]);

// The editor chrome reads the portal's CSS custom properties directly as
// `var(--…)` values rather than resolving them to hex at mount time. CodeMirror
// emits these strings verbatim into its generated stylesheet, so a `data-theme`
// flip on <html> re-themes a live editor with no re-mount. Token syntax colours
// come from the shared `.cm-tok-*` rules in style.css (via `sqlHighlightStyle`).
function portalTheme() {
  return EditorView.theme(
    {
      "&": {
        color: "var(--text-primary)",
        backgroundColor: "var(--bg-primary)",
        height: "100%",
        fontSize: "12.5px",
      },
      ".cm-content": {
        caretColor: "var(--accent)",
        fontFamily: "var(--font-mono, ui-monospace, Menlo, monospace)",
        padding: "10px 0",
      },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        backgroundColor: "var(--cm-selection)",
      },
      ".cm-activeLine": { backgroundColor: "var(--cm-active-line)" },
      ".cm-tooltip": {
        backgroundColor: "var(--bg-secondary)",
        border: "1px solid var(--border)",
        color: "var(--text-primary)",
      },
      ".cm-panels": {
        backgroundColor: "var(--bg-secondary)",
        color: "var(--text-primary)",
        borderTop: "1px solid var(--border)",
      },
      ".cm-searchMatch": {
        backgroundColor: "var(--cm-search-match)",
        outline: "1px solid var(--cm-search-match-border)",
      },
    },
    { dark: document.documentElement.dataset.theme !== "light" },
  );
}

function makeExtensions({ onChange, readOnly, onRun, onHistoryUp, onHistoryDown }) {
  const customKeys = [
    { key: "Mod-Enter", run: () => { onRun?.(); return true; } },
  ];
  if (onHistoryUp) customKeys.push({ key: "Alt-ArrowUp", run: () => { onHistoryUp(); return true; } });
  if (onHistoryDown) customKeys.push({ key: "Alt-ArrowDown", run: () => { onHistoryDown(); return true; } });

  return [
    history(),
    drawSelection(),
    dropCursor(),
    highlightSpecialChars(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(sqlHighlightStyle),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([
      ...customKeys,
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    sql({ dialect: StandardSQL }),
    EditorState.readOnly.of(!!readOnly),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && typeof onChange === "function") {
        onChange(update.state.doc.toString());
      }
    }),
    portalTheme(),
  ];
}

/**
 * SqlEditor — a CodeMirror-backed SQL editor.
 *
 * Props:
 *   • value: string — initial / synced doc text
 *   • onChange: (text) => void — fires on every edit
 *   • onRun: () => void — Cmd/Ctrl+Enter callback
 *   • onHistoryUp / onHistoryDown: optional Alt+↑↓ callbacks
 *   • viewRef: optional ref that gets the EditorView (for imperative inserts)
 *   • autoFocus: boolean
 *   • readOnly: boolean
 */
export function SqlEditor({
  value,
  onChange,
  onRun,
  onHistoryUp,
  onHistoryDown,
  viewRef: externalRef,
  autoFocus,
  readOnly,
}) {
  const containerRef = useRef(null);
  const viewRef = useRef(null);
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);
  const onHistoryUpRef = useRef(onHistoryUp);
  const onHistoryDownRef = useRef(onHistoryDown);
  onChangeRef.current = onChange;
  onRunRef.current = onRun;
  onHistoryUpRef.current = onHistoryUp;
  onHistoryDownRef.current = onHistoryDown;

  useEffect(() => {
    if (!containerRef.current) return;
    const state = EditorState.create({
      doc: value ?? "",
      extensions: makeExtensions({
        onChange: (text) => onChangeRef.current?.(text),
        onRun: () => onRunRef.current?.(),
        onHistoryUp: onHistoryUp ? () => onHistoryUpRef.current?.() : undefined,
        onHistoryDown: onHistoryDown ? () => onHistoryDownRef.current?.() : undefined,
        readOnly,
      }),
    });
    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    if (externalRef) externalRef.current = view;
    if (autoFocus) view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
      if (externalRef) externalRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if ((value ?? "") === current) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value ?? "" },
    });
  }, [value]);

  return html`<div ref=${containerRef} class="sql-cm"></div>`;
}

// --- Static highlight helper ---

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const _staticParser = sql({ dialect: StandardSQL }).language.parser;

/**
 * Parse `code` as SQL and return an HTML string with `<span class="cm-tok-*">`
 * wrappers around each token. Plain whitespace / unrecognised text is emitted
 * as escaped text. Designed to be dropped inside a `<pre>` (whitespace is
 * preserved verbatim — no normalization).
 */
export function highlightSqlToHtml(code) {
  if (!code) return "";
  const tree = _staticParser.parse(code);
  const out = [];
  let lastPos = 0;
  highlightTree(tree, sqlHighlightStyle, (from, to, classes) => {
    if (from > lastPos) out.push(escapeHtml(code.slice(lastPos, from)));
    const cls = classes ? ` class="${escapeHtml(classes)}"` : "";
    out.push(`<span${cls}>${escapeHtml(code.slice(from, to))}</span>`);
    lastPos = to;
  });
  if (lastPos < code.length) out.push(escapeHtml(code.slice(lastPos)));
  return out.join("");
}
