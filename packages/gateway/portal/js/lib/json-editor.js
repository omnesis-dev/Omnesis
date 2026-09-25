// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Thin Preact wrapper around CodeMirror 6 configured for JSON editing.
//
// Why CodeMirror over other options:
//   • Monaco is ~2 MB gzipped — overkill for a ~100-line config.
//   • vanilla-jsoneditor duplicates our structured form (tree mode) and is
//     ~150 KB gzipped.
//   • CodeMirror 6 is tree-shakeable (~50 KB with the extensions below),
//     ships well as locally vendored ESM bundles (see
//     packages/gateway/scripts/build-portal-vendor.mjs) wired up through the
//     portal's importmap, and has first-class JSON tooling (lang-json + lint).
//
// Features wired up here:
//   • Syntax highlighting (@codemirror/lang-json)
//   • Bracket matching + closing, indentation, line numbers, folding
//   • Live JSON parse linting (red underline at the syntax-error offset)
//   • Theme matching the portal's palette via CSS vars (light + dark)
//   • History (undo/redo), search (Cmd+F), autocomplete bracket close
//
// The editor is a controlled-ish component: external `value` changes that
// differ from the current doc overwrite the editor state (e.g. reset
// button, WS config.changed refresh). Typing inside the editor fires
// `onChange` with the latest text.

import { html } from "htm/preact";
import { useEffect, useRef } from "preact/hooks";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  foldGutter,
  foldKeymap,
  indentOnInput,
  bracketMatching,
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { lintKeymap, linter, lintGutter } from "@codemirror/lint";
import { json } from "@codemirror/lang-json";

// The editor chrome reads the portal's CSS custom properties directly as
// `var(--…)` values. CodeMirror emits these strings verbatim into its generated
// stylesheet, so a `data-theme` flip on <html> re-themes a live editor with no
// re-mount. JSON token colours come from CodeMirror's `defaultHighlightStyle`,
// which is already legible on both backgrounds.
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
      },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        backgroundColor: "var(--cm-selection)",
      },
      ".cm-gutters": {
        backgroundColor: "var(--bg-secondary)",
        color: "var(--text-secondary)",
        border: "none",
        borderRight: "1px solid var(--border)",
      },
      ".cm-activeLine": { backgroundColor: "var(--cm-active-line)" },
      ".cm-activeLineGutter": { backgroundColor: "var(--cm-active-line-gutter)" },
      ".cm-foldPlaceholder": {
        backgroundColor: "var(--bg-tertiary)",
        border: "1px solid var(--border)",
        color: "var(--text-secondary)",
      },
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
      ".cm-diagnostic": { borderLeftColor: "var(--danger)" },
      ".cm-diagnostic-error": { borderLeftColor: "var(--danger)" },
    },
    { dark: document.documentElement.dataset.theme !== "light" },
  );
}

// Linter: parse as JSON, if it throws try to extract a character position
// from the native error so we underline at the exact offset. Bun / Chrome /
// Safari format these differently — we try `position N`, `at position N`,
// and fall back to line+col via the message if present.
function jsonLinter() {
  return linter((view) => {
    const doc = view.state.doc.toString();
    if (doc.trim() === "") return [];
    try {
      JSON.parse(doc);
      return [];
    } catch (err) {
      const message = err?.message ?? String(err);
      const offset = extractOffset(message, doc);
      return [{
        from: offset,
        to: Math.min(offset + 1, doc.length),
        severity: "error",
        message,
      }];
    }
  });
}

function extractOffset(message, doc) {
  const posMatch = message.match(/position\s+(\d+)/i);
  if (posMatch) {
    const pos = parseInt(posMatch[1], 10);
    if (Number.isFinite(pos)) return Math.min(pos, doc.length);
  }
  const lineColMatch = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
  if (lineColMatch) {
    const line = parseInt(lineColMatch[1], 10);
    const col = parseInt(lineColMatch[2], 10);
    const lines = doc.split("\n");
    let offset = 0;
    for (let i = 0; i < Math.min(line - 1, lines.length); i++) offset += lines[i].length + 1;
    return Math.min(offset + Math.max(0, col - 1), doc.length);
  }
  return 0;
}

// Read-only is a compartment so hosts can toggle it after mount (e.g. a
// form locking its editor while a save is in flight).
const readOnlyCompartment = new Compartment();

function makeExtensions({ onChange, readOnly, jsonMode, ariaLabel, wrap }) {
  const extensions = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...lintKeymap,
      indentWithTab,
    ]),
    readOnlyCompartment.of(EditorState.readOnly.of(!!readOnly)),
    EditorView.contentAttributes.of({ "aria-label": ariaLabel || "Text editor" }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && typeof onChange === "function") {
        onChange(update.state.doc.toString());
      }
    }),
    portalTheme(),
  ];
  if (jsonMode) extensions.splice(-2, 0, json(), jsonLinter(), lintGutter());
  // Prose wraps at the editor's edge; code keeps its lines and scrolls inside.
  if (wrap) extensions.push(EditorView.lineWrapping);
  return extensions;
}

/**
 * JsonEditor — a CodeMirror-backed code editor pre-configured for JSON.
 *
 * Props:
 *   • value: string — the text to display.
 *   • onChange: (text) => void — fires on every edit.
 *   • readOnly: boolean — disables editing (view-only); toggling it after
 *     mount reconfigures the live view, no re-mount needed.
 *   • wrap: boolean — soft-wrap long lines instead of scrolling horizontally;
 *     for prose such as Markdown, never for code.
 *
 * The editor view's doc is kept in sync with `value` only when `value`
 * differs from what's currently in the editor — otherwise typing would
 * reset the cursor on every keystroke.
 */
export function TextEditor({ value, onChange, readOnly, language = "plain", ariaLabel, wrap = false }) {
  const containerRef = useRef(null);
  const viewRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;
    const state = EditorState.create({
      doc: value ?? "",
      extensions: makeExtensions({
        onChange: (text) => onChangeRef.current?.(text),
        readOnly,
        jsonMode: language === "json",
        ariaLabel,
        wrap,
      }),
    });
    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // We want the editor to mount once. Updates to value flow through the
    // sync effect below; onChange stays fresh via its ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // readOnly toggles live through the compartment — a host locking the
  // editor during a save flight doesn't disturb doc, cursor, or undo.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(!!readOnly)),
    });
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if ((value ?? "") === current) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value ?? "" },
    });
  }, [value]);

  return html`<div ref=${containerRef} class="text-editor"></div>`;
}

export function JsonEditor(props) {
  return html`<${TextEditor} ...${props} language="json" />`;
}
