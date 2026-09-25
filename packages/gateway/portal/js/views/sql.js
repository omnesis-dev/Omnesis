// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// SQL view — the SQL tab of the Debug page. A two-store editor (SQLite,
// DuckDB) with schema sidebar, query history, saved queries, CSV/JSON
// export, and deep-link entry from the Data tab.
//
// The store is a `Segmented` toggle rather than a tab bar: the page's tab
// bar already belongs to the Debug view, and a second row of tabs directly
// under it would read as a nesting rather than as a choice of store.
//
// `/analytics/sql` runs against a read-only DuckDB sandbox: ATTACH and
// file-system table-functions (`read_csv_auto`, `read_blob`, `read_text`)
// are blocked at the engine level, so cross-store queries that span
// DuckDB and SQLite are no longer reachable from this surface. Use the
// SQLite mode for document-store queries.
//
// History + saved queries live in localStorage; keyed per store so the
// user's SQLite history doesn't pollute their DuckDB history.

import { html } from "htm/preact";
import { useState, useEffect, useRef, useMemo } from "preact/hooks";
import { format } from "sql-formatter";
import {
  querySqlite,
  queryDuckdb,
  getSqliteCatalog,
  getAnalyticsCatalog,
} from "../api.js";
import { DataTable } from "../components/data-table.js";
import { Segmented } from "../components/segmented.js";
import {
  SchemaRail,
  SchemaRailItem,
  SchemaRailEmpty,
} from "../components/schema-rail.js";
import { SqlEditor, highlightSqlToHtml } from "../lib/sql-editor.js";
import { PromptModal } from "../components/confirm-modal.js";
import { STORAGE_PREFIXES } from "../lib/storage.js";

const PLACEHOLDERS = {
  sqlite: "SELECT * FROM documents ORDER BY source_updated_at DESC LIMIT 10",
  // Catalog peek — every analytics table is registered here, so this
  // is a sensible "what's around?" starter that doesn't depend on
  // any specific source being installed.
  duckdb: "SELECT table_name, display_name, record_count FROM _analytics_catalog",
};

const MODE_LABELS = {
  sqlite: "SQLite",
  duckdb: "DuckDB",
};

// sql-formatter doesn't ship a DuckDB dialect; PostgreSQL is the closest
// supported grammar (DuckDB's SQL surface is largely Postgres-compatible).
const FORMATTER_DIALECT = {
  sqlite: "sqlite",
  duckdb: "postgresql",
};

// Pretty-print SQL for the given mode. Returns the input unchanged on a parse
// error so a malformed/in-progress query never blanks the editor.
function formatSql(sql, mode) {
  try {
    return format(sql, { language: FORMATTER_DIALECT[mode] ?? "sqlite" });
  } catch {
    return sql;
  }
}

// Both keys use the dotted "omnesis." family — the shared prefix is
// imported from storage.js so the logout-time wipe stays comprehensive.
const HISTORY_KEY = `${STORAGE_PREFIXES[1]}sql.history`;
const SAVED_KEY = `${STORAGE_PREFIXES[1]}sql.saved`;
const HISTORY_MAX = 50;

function readStore(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* localStorage may be full/disabled; non-fatal */
  }
}

function loadHistory(mode) {
  const all = readStore(HISTORY_KEY);
  return Array.isArray(all[mode]) ? all[mode] : [];
}

function appendHistory(mode, sql) {
  const all = readStore(HISTORY_KEY);
  const list = Array.isArray(all[mode]) ? all[mode] : [];
  const trimmed = sql.trim();
  if (!trimmed) return list;
  const filtered = list.filter((q) => q !== trimmed);
  const next = [trimmed, ...filtered].slice(0, HISTORY_MAX);
  writeStore(HISTORY_KEY, { ...all, [mode]: next });
  return next;
}

function loadSaved(mode) {
  const all = readStore(SAVED_KEY);
  return Array.isArray(all[mode]) ? all[mode] : [];
}

function addSaved(mode, entry) {
  const all = readStore(SAVED_KEY);
  const list = Array.isArray(all[mode]) ? all[mode] : [];
  const next = [entry, ...list];
  writeStore(SAVED_KEY, { ...all, [mode]: next });
  return next;
}

function removeSaved(mode, id) {
  const all = readStore(SAVED_KEY);
  const list = Array.isArray(all[mode]) ? all[mode] : [];
  const next = list.filter((e) => e.id !== id);
  writeStore(SAVED_KEY, { ...all, [mode]: next });
  return next;
}

// --- Export helpers ---

function cellToCsv(value) {
  if (value === null || value === undefined) return "";
  const str = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function resultToCsv(columns, rows) {
  const lines = [columns.map(cellToCsv).join(",")];
  for (const row of rows) lines.push(row.map(cellToCsv).join(","));
  return lines.join("\n");
}

function resultToJson(columns, rows) {
  return JSON.stringify(
    rows.map((row) => {
      const obj = {};
      columns.forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    }),
    null,
    2,
  );
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- Schema sidebar ---

function SchemaSidebar({ mode, sqliteTables, analyticsTables, onInsert }) {
  const [expanded, setExpanded] = useState(null);

  function toggle(store, name) {
    const key = `${store}:${name}`;
    setExpanded(expanded === key ? null : key);
  }

  const activeStore = mode === "duckdb" ? "duckdb" : "sqlite";
  const activeTables = activeStore === "duckdb" ? analyticsTables : sqliteTables;

  return html`
    <${SchemaRail} title="Schema">
      ${activeTables.length === 0
        ? html`<${SchemaRailEmpty}>No tables</${SchemaRailEmpty}>`
        : activeTables.map((t) => {
            const key = `${activeStore}:${t.tableName}`;
            const isOpen = expanded === key;
            const insertBtn = html`
              <span
                class="schema-rail-insert"
                onClick=${(e) => { e.stopPropagation(); onInsert(t.tableName); }}
              >+</span>
            `;
            return html`
              <${SchemaRailItem}
                key=${key}
                onClick=${() => toggle(activeStore, t.tableName)}
                leadIcon=${isOpen ? "▾" : "▸"}
                name=${t.tableName}
                rowEnd=${insertBtn}
                title=${t.description}
              >
                ${isOpen && html`
                  <ul class="schema-rail-cols">
                    ${t.columns.map((c) => html`
                      <li key=${c.name} onClick=${() => onInsert(c.name)} title=${c.description || c.type}>
                        <code>${c.name}</code>
                        <span class="schema-rail-type">${c.type}</span>
                      </li>
                    `)}
                  </ul>
                `}
              </${SchemaRailItem}>
            `;
          })}
    </${SchemaRail}>
  `;
}

// --- Saved queries + history panels ---

function QueryLibrary({ mode, history, saved, onLoad, onSave, onDelete, currentSql }) {
  const [expanded, setExpanded] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);

  function handleSave() {
    setShowSaveDialog(true);
  }

  function handleSaveConfirm(label) {
    setShowSaveDialog(false);
    onSave({ id: String(Date.now()), label, sql: currentSql });
  }

  return html`
    <div class="sql-library">
      <button class="sql-library-toggle" onClick=${() => setExpanded(!expanded)}>
        ${expanded ? "▾" : "▸"} History & saved
        <span class="muted">(${history.length} recent · ${saved.length} saved)</span>
      </button>
      <${PromptModal}
        open=${showSaveDialog}
        title="Save query"
        body=${`Give this ${MODE_LABELS[mode]} query a label so you can find it later.`}
        placeholder="e.g. Recent gmail by sender"
        confirmLabel="Save"
        onCancel=${() => setShowSaveDialog(false)}
        onSubmit=${handleSaveConfirm}
      />
      ${expanded && html`
        <div class="sql-library-panels">
          <div class="sql-library-col">
            <div class="sql-library-head">
              <strong>Saved</strong>
              <button class="btn-tiny" onClick=${handleSave} disabled=${!currentSql.trim()}>Save current</button>
            </div>
            ${saved.length === 0
              ? html`<div class="muted sql-library-empty">No saved queries for ${MODE_LABELS[mode]}</div>`
              : html`<ul class="sql-library-list">
                  ${saved.map((s) => html`
                    <li key=${s.id}>
                      <button class="sql-library-item" onClick=${() => onLoad(s.sql)} title=${s.sql}>
                        ${s.label}
                      </button>
                      <button class="btn-tiny danger" onClick=${() => onDelete(s.id)}>✕</button>
                    </li>
                  `)}
                </ul>`
            }
          </div>
          <div class="sql-library-col">
            <div class="sql-library-head"><strong>Recent</strong></div>
            ${history.length === 0
              ? html`<div class="muted sql-library-empty">Run a query to build history</div>`
              : html`<ul class="sql-library-list">
                  ${history.slice(0, 15).map((q, i) => {
                    const oneLine = q.replace(/\s+/g, " ").trim();
                    const display = oneLine.length > 110 ? oneLine.slice(0, 110) + "…" : oneLine;
                    return html`
                      <li key=${i}>
                        <button class="sql-library-item" onClick=${() => onLoad(q)} title=${q}>
                          <pre class="sql-static" dangerouslySetInnerHTML=${{ __html: highlightSqlToHtml(display) }}></pre>
                        </button>
                      </li>
                    `;
                  })}
                </ul>`
            }
          </div>
        </div>
      `}
    </div>
  `;
}

// --- Main view ---

export function SqlView({ initialStore = null, initialSql = null } = {}) {
  // Store + statement arrive as props parsed from `?store=duckdb&sql=…`, so a
  // deep link from the Data tab or the Graph tab opens on the right store with
  // the query already in the editor.
  const initialMode =
    initialStore === "duckdb" || initialStore === "sqlite" ? initialStore : "sqlite";

  const [mode, setMode] = useState(initialMode);
  // A deep-linked `?sql=` is auto-formatted once on load (but never auto-run).
  // Lazy initializer — the formatter parse must not re-run on every keystroke.
  const [sql, setSql] = useState(() =>
    initialSql ? formatSql(initialSql, initialMode) : PLACEHOLDERS[initialMode],
  );
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const [history, setHistory] = useState(() => loadHistory(initialMode));
  const [saved, setSaved] = useState(() => loadSaved(initialMode));

  const [sqliteCatalog, setSqliteCatalog] = useState([]);
  const [analyticsCatalog, setAnalyticsCatalog] = useState([]);

  const editorViewRef = useRef(null);
  const historyIndexRef = useRef(-1);

  // Load catalogs once for the schema sidebar
  useEffect(() => {
    (async () => {
      try {
        const [s, a] = await Promise.all([getSqliteCatalog(), getAnalyticsCatalog()]);
        setSqliteCatalog(s.tables || []);
        setAnalyticsCatalog(a.tables || []);
      } catch {
        /* sidebar gracefully degrades */
      }
    })();
  }, []);

  // Editor mounts focused via the SqlEditor `autoFocus` prop.

  // When we switch modes, replace placeholder unless the user already edited
  useEffect(() => {
    setHistory(loadHistory(mode));
    setSaved(loadSaved(mode));
    historyIndexRef.current = -1;
    if (!result && !error && Object.values(PLACEHOLDERS).includes(sql)) {
      setSql(PLACEHOLDERS[mode]);
    }
  }, [mode]);

  async function runQuery() {
    const trimmed = sql.trim();
    if (!trimmed) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const fn = mode === "sqlite" ? querySqlite : queryDuckdb;
      const data = await fn(trimmed);
      setResult(data);
      setHistory(appendHistory(mode, trimmed));
      historyIndexRef.current = -1;
    } catch (err) {
      // Append the gateway's X-Request-Id (first 8 chars) so the
      // user can correlate a SQL failure with a server log line.
      const reqId = err?.requestId ? ` [id=${String(err.requestId).slice(0, 8)}]` : "";
      setError(`${err.message}${reqId}`);
    } finally {
      setLoading(false);
    }
  }

  function cycleHistory(direction) {
    if (history.length === 0) return;
    let idx = historyIndexRef.current;
    idx = direction === "up" ? Math.min(idx + 1, history.length - 1) : Math.max(idx - 1, -1);
    historyIndexRef.current = idx;
    setSql(idx === -1 ? PLACEHOLDERS[mode] : history[idx]);
  }

  function switchMode(newMode) {
    setMode(newMode);
    setResult(null);
    setError(null);
  }

  function insertAtCursor(text) {
    const view = editorViewRef.current;
    if (!view) { setSql(sql + text); return; }
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
    });
    view.focus();
  }

  const exportAvailable = result && result.rows && result.rows.length > 0;

  return html`
    <div class="sql-view">
      <div class="sql-layout">
        <${SchemaSidebar}
          mode=${mode}
          sqliteTables=${sqliteCatalog}
          analyticsTables=${analyticsCatalog}
          onInsert=${insertAtCursor}
        />

        <div class="sql-main">
          <div class="segmented-row sql-store-toggle">
            <span class="segmented-row-label">Store</span>
            <${Segmented}
              options=${["sqlite", "duckdb"].map((m) => ({ value: m, label: MODE_LABELS[m] }))}
              value=${mode}
              onChange=${switchMode}
            />
          </div>

          <div class="sql-editor">
            <${SqlEditor}
              value=${sql}
              onChange=${setSql}
              onRun=${runQuery}
              onHistoryUp=${() => cycleHistory("up")}
              onHistoryDown=${() => cycleHistory("down")}
              viewRef=${editorViewRef}
              autoFocus
            />
            <div class="sql-actions">
              <div class="sql-action-buttons">
                <button
                  class="sql-format-btn"
                  onClick=${() => setSql(formatSql(sql, mode))}
                  disabled=${!sql.trim()}
                  title="Pretty-print the query"
                >Format</button>
                <button class="sql-run-btn" onClick=${runQuery} disabled=${loading}>
                  ${loading ? "Running…" : "Run"}
                </button>
              </div>
              <span class="sql-hint">
                <kbd>${navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}</kbd>+<kbd>Enter</kbd> run ·
                <kbd>⌥</kbd>+<kbd>↑↓</kbd> history
              </span>
            </div>
          </div>

          <${QueryLibrary}
            mode=${mode}
            history=${history}
            saved=${saved}
            currentSql=${sql}
            onLoad=${(q) => setSql(q)}
            onSave=${(entry) => setSaved(addSaved(mode, entry))}
            onDelete=${(id) => setSaved(removeSaved(mode, id))}
          />

          ${error && html`<div class="sql-error">${error}</div>`}

          ${result && html`
            <div class="sql-results">
              <div class="sql-results-footer">
                <span>
                  ${result.rowCount} row${result.rowCount !== 1 ? "s" : ""} in ${result.timing}ms
                  ${result.truncated && html`
                    <span class="sql-truncated-tag" title="Server-side row cap of ${result.rowCap} hit. Add a tighter LIMIT or WHERE clause to see the rest.">
                      · truncated at ${result.rowCap}
                    </span>
                  `}
                </span>
                <div class="sql-export">
                  <button class="btn-tiny" disabled=${!exportAvailable} onClick=${() => download(`omnesis-${mode}-${Date.now()}.csv`, resultToCsv(result.columns, result.rows), "text/csv")}>CSV</button>
                  <button class="btn-tiny" disabled=${!exportAvailable} onClick=${() => download(`omnesis-${mode}-${Date.now()}.json`, resultToJson(result.columns, result.rows), "application/json")}>JSON</button>
                </div>
              </div>
              <${DataTable} columns=${result.columns} rows=${result.rows} />
            </div>
          `}
        </div>
      </div>
    </div>
  `;
}
