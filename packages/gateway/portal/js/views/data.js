// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Data view — the Data tab of the Debug page: a table catalog browser for
// DuckDB (analytics) + SQLite (documents).
//
// Layout:
//   left rail   table list grouped by store, with row counts + ownership
//   right pane  detail for the selected table: header, schema, preview,
//               example queries, ingest sparkline, "Open in SQL" button
//
// The selected table lives in the query string
// (`/portal/debug/data?store=duckdb&table=strava_activities`), so a pick is
// bookmarkable, survives a refresh, and moves with Back / Forward.

import { html } from "htm/preact";
import { useState, useEffect, useMemo } from "preact/hooks";
import { navigate } from "../lib/router.js";
import {
  getSqliteCatalog,
  getSqliteTableInfo,
  getSqliteActivity,
  getAnalyticsCatalog,
  getAnalyticsTableInfo,
  getAnalyticsActivity,
} from "../api.js";
import { DataTable } from "../components/data-table.js";
import {
  SchemaRail,
  SchemaRailGroup,
  SchemaRailItem,
  SchemaRailEmpty,
} from "../components/schema-rail.js";
import { highlightSqlToHtml } from "../lib/sql-editor.js";

function formatCount(n) {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0) + "M";
}

function formatDate(d) {
  if (!d) return "—";
  return String(d).slice(0, 10);
}

function compareTables(a, b) {
  // Sort by row count desc, then by name
  if (b.recordCount !== a.recordCount) return b.recordCount - a.recordCount;
  return a.tableName.localeCompare(b.tableName);
}

function storePrefix(store) {
  return store === "duckdb" ? "DuckDB" : "SQLite";
}

// --- Sparkline (Phase 4) ---

function Sparkline({ points }) {
  if (!points || points.length === 0) {
    return html`<div class="sparkline-empty">No activity data</div>`;
  }
  const width = 240;
  const height = 40;
  const max = Math.max(...points.map((p) => p.count), 1);
  const step = points.length > 1 ? width / (points.length - 1) : 0;

  const pathD = points
    .map((p, i) => {
      const x = i * step;
      const y = height - (p.count / max) * (height - 4) - 2;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  const total = points.reduce((s, p) => s + p.count, 0);
  const last = points[points.length - 1];
  const peak = points.reduce((m, p) => (p.count > m.count ? p : m), points[0]);

  return html`
    <div class="sparkline">
      <svg aria-hidden="true" width=${width} height=${height} viewBox="0 0 ${width} ${height}">
        <path d=${pathD} fill="none" stroke="var(--accent)" stroke-width="1.5" />
        ${points.map((p, i) => html`
          <circle
            cx=${(i * step).toFixed(1)}
            cy=${(height - (p.count / max) * (height - 4) - 2).toFixed(1)}
            r="2"
            fill="var(--accent)"
          >
            <title>${p.day}: ${p.count}</title>
          </circle>
        `)}
      </svg>
      <div class="sparkline-stats">
        <span><strong>${total}</strong> rows in last ${points.length} active day${points.length === 1 ? "" : "s"}</span>
        <span>peak ${peak.count} on ${peak.day}</span>
        <span>latest ${last.count} on ${last.day}</span>
      </div>
    </div>
  `;
}

// --- Table list (left rail) ---

function TableList({ tables, selected, onSelect, loading }) {
  const groups = useMemo(() => {
    const byStore = { duckdb: [], sqlite: [] };
    for (const t of tables) byStore[t.store].push(t);
    byStore.duckdb.sort(compareTables);
    byStore.sqlite.sort(compareTables);
    return byStore;
  }, [tables]);

  if (loading) {
    return html`
      <${SchemaRail}>
        <div class="loading"><span class="spinner"></span> Loading tables...</div>
      </${SchemaRail}>
    `;
  }

  return html`
    <${SchemaRail}>
      ${["duckdb", "sqlite"].map((store) => html`
        <${SchemaRailGroup} key=${store} label=${storePrefix(store)} count=${groups[store].length}>
          ${groups[store].length === 0
            ? html`<${SchemaRailEmpty}>No tables yet</${SchemaRailEmpty}>`
            : groups[store].map((t) => html`
                <${SchemaRailItem}
                  key=${store + ":" + t.tableName}
                  active=${selected && selected.store === store && selected.table === t.tableName}
                  onClick=${() => onSelect(store, t.tableName)}
                  name=${t.tableName}
                  rowEnd=${formatCount(t.recordCount)}
                />
              `)}
        </${SchemaRailGroup}>
      `)}
    </${SchemaRail}>
  `;
}

// --- Detail panel ---

function SchemaTable({ columns, primaryKey }) {
  const pk = new Set(primaryKey || []);
  return html`
    <table class="schema-table">
      <thead>
        <tr><th>Column</th><th>Type</th><th>Description</th></tr>
      </thead>
      <tbody>
        ${columns.map((col) => html`
          <tr key=${col.name}>
            <td>
              <code>${col.name}</code>
              ${pk.has(col.name) ? html`<span class="schema-pk" title="Primary key">PK</span>` : null}
              ${col.nullable ? html`<span class="schema-nullable">?</span>` : null}
            </td>
            <td><span class="schema-type">${col.type}</span></td>
            <td class="schema-desc">${col.description || ""}</td>
          </tr>
        `)}
      </tbody>
    </table>
  `;
}

function DetailPanel({ store, table }) {
  const [info, setInfo] = useState(null);
  const [activity, setActivity] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setActivity(null);
    setError(null);
    const load = async () => {
      try {
        const [infoResp, actResp] = await Promise.all([
          store === "duckdb" ? getAnalyticsTableInfo(table) : getSqliteTableInfo(table),
          store === "duckdb" ? getAnalyticsActivity(table, 14) : getSqliteActivity(table, 14),
        ]);
        if (cancelled) return;
        setInfo(infoResp);
        setActivity(actResp.points || []);
      } catch (err) {
        if (!cancelled) {
          const reqId = err?.requestId ? ` [id=${String(err.requestId).slice(0, 8)}]` : "";
          setError(`${err.message}${reqId}`);
        }
      }
    };
    load();
    return () => { cancelled = true; };
  }, [store, table]);

  function openInSql(query) {
    const params = new URLSearchParams({ store, sql: query });
    navigate(`/portal/debug/sql?${params}`);
  }

  if (error) return html`<div class="data-detail error">${error}</div>`;
  if (!info) return html`<div class="data-detail loading">Loading…</div>`;

  const cat = info.catalog;

  return html`
    <section class="data-detail">
      <header class="data-detail-header">
        <div class="data-detail-title-row">
          <div>
            <h1 class="data-detail-title"><code>${cat.tableName}</code></h1>
            <div class="data-detail-subtitle">${cat.displayName}</div>
          </div>
          <div class="data-detail-actions">
            <button class="btn-primary" onClick=${() => openInSql(`SELECT * FROM ${cat.tableName} LIMIT 100`)}>
              Open in SQL
            </button>
          </div>
        </div>
        <p class="data-detail-description">${cat.description}</p>
        <dl class="data-detail-meta">
          <div><dt>Store</dt><dd>${storePrefix(store)}</dd></div>
          <div><dt>Rows</dt><dd>${cat.recordCount.toLocaleString()}</dd></div>
          <div><dt>Owner</dt><dd><code>${cat.sourceId}</code></dd></div>
          <div><dt>Earliest</dt><dd>${formatDate(cat.earliestDate)}</dd></div>
          <div><dt>Latest</dt><dd>${formatDate(cat.latestDate)}</dd></div>
          <div><dt>PK</dt><dd>${(cat.primaryKey || []).map((k) => html`<code>${k}</code>`)}</dd></div>
        </dl>
      </header>

      ${activity && activity.length > 0 && html`
        <section class="data-detail-section">
          <h2>Ingest (last 14 days)</h2>
          <${Sparkline} points=${activity} />
        </section>
      `}

      <section class="data-detail-section">
        <h2>Schema <span class="muted">(${cat.columns.length} columns)</span></h2>
        <${SchemaTable} columns=${cat.columns} primaryKey=${cat.primaryKey} />
      </section>

      ${cat.exampleQueries && cat.exampleQueries.length > 0 && html`
        <section class="data-detail-section">
          <h2>Starter queries</h2>
          <ul class="example-queries">
            ${cat.exampleQueries.map((q, i) => html`
              <li key=${i}>
                <pre class="sql-static" dangerouslySetInnerHTML=${{ __html: highlightSqlToHtml(q) }}></pre>
                <button class="btn-tiny" onClick=${() => openInSql(q)}>Run</button>
              </li>
            `)}
          </ul>
        </section>
      `}

      <section class="data-detail-section">
        <h2>Recent rows <span class="muted">(top ${info.sampleRows.length})</span></h2>
        <${DataTable} columns=${info.sampleColumns} rows=${info.sampleRows} columnDefs=${cat.columns} />
      </section>
    </section>
  `;
}

// --- Top-level view ---

export function DataView({ store, table }) {
  const [allTables, setAllTables] = useState([]);
  // Which table is showing follows the query string, so Back and Forward move
  // the pane rather than only the address bar. The fallback covers the one
  // case the URL doesn't name a table — a bare visit to the tab — where the
  // largest table is opened without pushing a history entry for a choice the
  // user didn't make.
  const [fallback, setFallback] = useState(null);
  const selected = store && table ? { store, table } : fallback;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [sqliteResp, analyticsResp] = await Promise.all([
          getSqliteCatalog(),
          getAnalyticsCatalog(),
        ]);
        if (cancelled) return;
        const tables = [
          ...sqliteResp.tables.map((t) => ({ ...t, store: "sqlite" })),
          ...analyticsResp.tables.map((t) => ({ ...t, store: "duckdb" })),
        ];
        setAllTables(tables);

        const first = [...tables].sort(compareTables)[0];
        if (first) setFallback({ store: first.store, table: first.tableName });
      } catch (err) {
        if (!cancelled) {
          const reqId = err?.requestId ? ` [id=${String(err.requestId).slice(0, 8)}]` : "";
          setError(`${err.message}${reqId}`);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  function handleSelect(nextStore, nextTable) {
    const params = new URLSearchParams({ store: nextStore, table: nextTable });
    navigate(`/portal/debug/data?${params}`);
  }

  if (error) return html`<div class="data-view"><div class="error">${error}</div></div>`;

  return html`
    <div class="data-view">
      <div class="data-layout">
        <${TableList} tables=${allTables} selected=${selected} onSelect=${handleSelect} loading=${loading} />
        ${selected
          ? html`<${DetailPanel} store=${selected.store} table=${selected.table} />`
          : loading
            ? html`<section class="data-detail loading"><span class="spinner"></span> Loading…</section>`
            : html`<section class="data-detail empty"><p class="muted">Pick a table from the list to see its schema and recent rows.</p></section>`
        }
      </div>
    </div>
  `;
}
