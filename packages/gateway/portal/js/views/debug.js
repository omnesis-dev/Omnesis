// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Debug view — every internal-state surface of the gateway, as tabs:
//   - Data: the table catalog across both stores, with schema, sample
//     rows and ingest activity (views/data.js).
//   - SQL: the read-only query editor for either store (views/sql.js).
//   - Graph: the document-graph walker (views/graph.js).
//   - Metrics: /admin/metrics + /admin/scheduler-metrics (writer queue,
//     per-route latency, scheduler SLA + per-task stats). Built to
//     validate the writer-queue fairness work.
//   - Background Jobs: /admin/background-jobs — every long-running
//     loop in the gateway (indexer cycle, link / people backfills,
//     stats refreshes, token usage flush, …) with progress and state.
//   - Cognition: the cognitive-state inspector (experimental only).
//   - Watch: one watch's definition drawn as the graph the Watch
//     runtime evaluates (experimental only).
//   - Doctor: /admin/doctor — the gateway's self-diagnosis, the same
//     report `omnesis doctor` prints.
//
// The Metrics and Background Jobs tabs are implemented in this file; the rest
// are imported views. The tab set and its order live in lib/debug-tabs.js,
// shared with the router — which also resolves the alternate paths three of
// these tabs answer to (see DEBUG_TAB_ALIASES in lib/router.js).

import { html } from "htm/preact";
import { useEffect, useState, useRef } from "preact/hooks";
import { TabBar } from "../components/tab-bar.js";
import {
  getBackgroundJobs,
  getMetrics,
  getProcessVitals,
  getSchedulerMetrics,
} from "../api.js";
import { useVisiblePoll } from "../lib/use-visible-poll.js";
import { formatDurationShort, isBacklogLate } from "../lib/format.js";
import { replaceRoute } from "../lib/router.js";
import { debugTabs, DEFAULT_DEBUG_TAB } from "../lib/debug-tabs.js";
import { lazy } from "../lib/lazy.js";
import { GraphView } from "./graph.js";
import { CognitionView } from "./cognition.js";
import { DoctorTab } from "./doctor.js";
import { WatchDebugTab } from "./watch-debug.js";

// The two table/query tabs load on first open rather than with the page. Both
// reach the SQL editor module and its CodeMirror dependency (~480 KB of vendor
// JS), and the SQL tab additionally pulls sql-formatter (~290 KB) — none of
// which a visit to Metrics or Doctor has any use for.
const DataView = lazy(() => import("./data.js").then((m) => m.DataView));
const SqlView = lazy(() => import("./sql.js").then((m) => m.SqlView));

const WINDOW_OPTIONS = [
  { label: "1 min", seconds: 60 },
  { label: "5 min", seconds: 300 },
  { label: "15 min", seconds: 900 },
  { label: "1 hour", seconds: 3600 },
];

const REFRESH_OPTIONS = [
  { label: "1s", ms: 1000 },
  { label: "2s", ms: 2000 },
  { label: "5s", ms: 5000 },
  { label: "off", ms: 0 },
];

function fmtMs(n) {
  if (n == null || Number.isNaN(n)) return "—";
  if (n < 1) return "0";
  if (n < 10) return n.toFixed(1);
  return Math.round(n).toLocaleString();
}

function callerColor(kind) {
  switch (kind) {
    case "cli": return "#5eead4";
    case "portal": return "#a78bfa";
    case "ios": return "#f472b6";
    case "android": return "#4ade80";
    case "browser": return "#fb923c";
    case "collector": return "#94a3b8";
    default: return "#6b7280";
  }
}

// Map scheduler priority → existing callerColor palette so the pills on
// this page share a vocabulary with the writer-queue byOp panel.
function priorityColor(priority) {
  if (priority === "user") return callerColor("cli");
  if (priority === "realtime") return callerColor("collector");
  return "#fbbf24"; // background — amber
}

// Color the user-SLA gauges relative to budgetMs: green ≤ budget,
// yellow 1–2× budget, red > 2× budget. Mirrors the brief's "p99 must
// stay under budget" guidance.
function slaColor(value, budget) {
  if (value == null || Number.isNaN(value) || budget <= 0) return "var(--text-secondary)";
  if (value <= budget) return "var(--success)";
  if (value <= 2 * budget) return "var(--warning)";
  return "var(--danger)";
}

function Sparkline({ samples, peak }) {
  // Inline SVG sparkline. samples: [{ts, depth}].
  if (!samples || samples.length === 0) {
    return html`<div class="metrics-sparkline-empty">no data</div>`;
  }
  const w = 480;
  const h = 64;
  const padX = 4;
  const padY = 4;
  const usableW = w - padX * 2;
  const usableH = h - padY * 2;
  const maxDepth = Math.max(1, peak);
  const minTs = samples[0].ts;
  const maxTs = samples[samples.length - 1].ts;
  const tsSpan = Math.max(1, maxTs - minTs);
  const points = samples.map((s) => {
    const x = padX + ((s.ts - minTs) / tsSpan) * usableW;
    const y = padY + (1 - s.depth / maxDepth) * usableH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const last = samples[samples.length - 1];
  const lastX = padX + usableW;
  const lastY = padY + (1 - last.depth / maxDepth) * usableH;
  return html`
    <svg aria-hidden="true" class="metrics-sparkline" width=${w} height=${h} viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <polyline points=${points} fill="none" stroke="var(--accent)" stroke-width="1.5" />
      <circle cx=${lastX.toFixed(1)} cy=${lastY.toFixed(1)} r="2.5" fill="var(--accent)" />
    </svg>
  `;
}

export function DebugView({
  tab,
  graphParams,
  dataParams,
  sqlParams,
  experimental,
  developer = false,
  cognitionTab,
  cognitionId,
  watchDebugId,
  watchDebugSeq,
} = {}) {
  const tabs = debugTabs(experimental);
  const validTabs = new Set(tabs.map((t) => t.key));
  // The URL is the single source of truth for which tab is open — no mirrored
  // local state to drift out of sync. That means a link into a specific tab
  // (the Data tab's "Open in SQL", the sidebar's Debug item, a bookmark)
  // lands where it points, and a deep link to Cognition resolves the moment
  // `experimental` arrives instead of stranding on the default tab.
  const activeTab = validTabs.has(tab) ? tab : DEFAULT_DEBUG_TAB;

  // Mirror the chosen tab into the path so a refresh lands on the same place.
  // `replaceRoute` (replaceState + re-parse) keeps tab toggles out of the back
  // stack — matching the Settings page — while still re-deriving the route, so a
  // tab's URL-carried state resets to its defaults on a fresh visit. The Graph
  // tab's query params are then owned by the GraphView itself, which re-mirrors
  // them via replaceUrl once a walk runs.
  const switchTab = (next) => {
    // Re-selecting the tab the URL already names is a no-op: re-deriving the
    // route would wipe whatever state that tab carries in the query string
    // (the selected table, a graph walk, the statement in the editor). Keyed
    // on the route rather than on `activeTab`, so a click still repairs the
    // address bar when the two disagree — a Cognition path on a gateway whose
    // experimental flag has not arrived shows the default tab until it does.
    if (next === tab) return;
    replaceRoute(`/portal/debug/${next}`);
  };

  return html`
    <div class="debug-view">
      <div class="debug-header" style="align-items:flex-start;">
        <div>
          <h1 class="debug-title">Debug</h1>
          <p class="debug-sub">
            Internal-state inspector for the gateway. Switch tabs to
            browse the stored tables, query them in SQL, walk the
            document graph, view scheduler metrics and route-level
            timings, watch every background loop in the process, or run
            the health check.
          </p>
        </div>
      </div>
      <${TabBar}
        style="margin-bottom:16px;"
        active=${activeTab}
        onSelect=${switchTab}
        tabs=${tabs}
      />
      ${activeTab === "data" && html`<${DataView}
        store=${dataParams?.store ?? null}
        table=${dataParams?.table ?? null}
      />`}
      ${activeTab === "sql" && html`<${SqlView}
        initialStore=${sqlParams?.store ?? null}
        initialSql=${sqlParams?.sql ?? null}
      />`}
      ${activeTab === "metrics" && html`<${MetricsTab} />`}
      ${activeTab === "background-jobs" && html`<${BackgroundJobsTab} />`}
      ${activeTab === "doctor" && html`<${DoctorTab} />`}
      ${activeTab === "cognition" && experimental && html`<${CognitionView}
        subTab=${cognitionTab}
        selectedId=${cognitionId}
        developer=${developer}
      />`}
      ${activeTab === "watch" && experimental && html`<${WatchDebugTab}
        watchId=${watchDebugId ?? null}
        seq=${watchDebugSeq ?? null}
      />`}
      ${activeTab === "graph" && html`<${GraphView}
        initialDocumentId=${graphParams?.documentId ?? ""}
        initialDepth=${graphParams?.depth}
        initialFanoutCap=${graphParams?.fanoutCap}
        initialCollapse=${graphParams?.collapse}
        initialShowMentions=${graphParams?.showMentions}
        initialHideAttachmentPeople=${graphParams?.hideAttachmentPeople}
      />`}
    </div>
  `;
}

function elColor(ms) {
  if (ms == null) return "var(--text-secondary)";
  if (ms <= 10) return "var(--success)";
  if (ms <= 50) return "var(--warning)";
  return "var(--danger)";
}

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function fmtBytes(bytes) {
  if (bytes == null) return "—";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function ProcessHealthSection({ vitals }) {
  const el = vitals.eventLoop?.current;
  const cpu = vitals.cpu?.current;
  const mem = vitals.memory?.current;
  const gc = vitals.gc;

  return html`
    <section class="debug-section">
      <h2 class="debug-section-title">Process health</h2>
      <p class="debug-section-sub">
        Event loop delay, CPU usage, memory, and GC pauses. High event
        loop delay means the main thread is CPU-blocked.
      </p>
      <div class="debug-queue-cards">
        <div class="debug-card">
          <div class="debug-card-label">Event loop p99</div>
          <div class="debug-card-value" style=${`color:${elColor(el?.p99Ms)}`}>
            ${el ? fmtMs(el.p99Ms) + "ms" : "—"}
          </div>
        </div>
        <div class="debug-card">
          <div class="debug-card-label">CPU (of 1 core)</div>
          <div class="debug-card-value">
            ${cpu ? fmtPct(cpu.totalPct) : "—"}
          </div>
        </div>
        <div class="debug-card">
          <div class="debug-card-label">RSS</div>
          <div class="debug-card-value">${mem ? fmtBytes(mem.rssBytes) : "—"}</div>
        </div>
        <div class="debug-card">
          <div class="debug-card-label">GC pauses (window)</div>
          <div class="debug-card-value">
            ${gc ? `${gc.windowCount}` : "—"}
            ${gc && gc.windowTotalMs > 0 ? html`<span style="color:var(--text-secondary);font-size:14px;"> · ${fmtMs(gc.windowTotalMs)}ms</span>` : ""}
          </div>
        </div>
        <div class="debug-card debug-card-spark">
          <div class="debug-card-label">CPU% over window</div>
          <${Sparkline}
            samples=${(vitals.cpu?.samples ?? []).map((s) => ({ ts: s.ts, depth: s.totalPct * 100 }))}
            peak=${(vitals.cpu?.peakTotalPct ?? 0) * 100}
          />
        </div>
      </div>
      <div class="debug-queue-cards" style="margin-top:12px;">
        <div class="debug-card">
          <div class="debug-card-label">Heap used / total</div>
          <div class="debug-card-value" style="font-size:18px;">
            ${mem ? `${fmtBytes(mem.heapUsedBytes)} / ${fmtBytes(mem.heapTotalBytes)}` : "—"}
          </div>
        </div>
        <div class="debug-card">
          <div class="debug-card-label">CPU peak (window)</div>
          <div class="debug-card-value">${fmtPct(vitals.cpu?.peakTotalPct)}</div>
        </div>
        <div class="debug-card">
          <div class="debug-card-label">CPU mean (window)</div>
          <div class="debug-card-value">${fmtPct(vitals.cpu?.meanTotalPct)}</div>
        </div>
        <div class="debug-card debug-card-spark">
          <div class="debug-card-label">Event loop p99 over window</div>
          <${Sparkline}
            samples=${(vitals.eventLoop?.samples ?? []).map((s) => ({ ts: s.ts, depth: s.p99Ms }))}
            peak=${Math.max(1, ...(vitals.eventLoop?.samples ?? []).map((s) => s.p99Ms))}
          />
        </div>
      </div>
    </section>
  `;
}

function MetricsTab() {
  const [data, setData] = useState(null);
  const [scheduler, setScheduler] = useState(null);
  const [vitals, setVitals] = useState(null);
  const [error, setError] = useState(null);
  const [windowSec, setWindowSec] = useState(300);
  const [refreshMs, setRefreshMs] = useState(2000);
  const [loadedOnce, setLoadedOnce] = useState(false);

  async function load() {
    const [metricsRes, schedRes, vitalsRes] = await Promise.allSettled([
      getMetrics(windowSec),
      getSchedulerMetrics(windowSec),
      getProcessVitals(windowSec),
    ]);
    if (metricsRes.status === "fulfilled") {
      setData(metricsRes.value);
      setError(null);
      setLoadedOnce(true);
    } else {
      setError(metricsRes.reason?.message ?? String(metricsRes.reason));
    }
    if (schedRes.status === "fulfilled") {
      setScheduler(schedRes.value);
    } else {
      setScheduler(null);
    }
    if (vitalsRes.status === "fulfilled") {
      setVitals(vitalsRes.value);
    } else {
      setVitals(null);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowSec]);
  useVisiblePoll(load, refreshMs, { enabled: refreshMs > 0 });

  return html`
    <div>
      <div class="debug-header">
        <div>
          <p class="debug-sub">
            In-memory snapshot of <code>/admin/metrics</code>. Use this to
            validate the gateway-fairness work — user-initiated routes
            (cli / portal / ios) should keep <code>wq</code>
            (writer-queue wait) low even while the writer is busy with
            collector ingest + background reconciles.
          </p>
        </div>
        <div class="debug-controls">
          <label class="debug-control">
            Window
            <select value=${windowSec} onChange=${(e) => setWindowSec(Number(e.target.value))}>
              ${WINDOW_OPTIONS.map((o) => html`<option value=${o.seconds}>${o.label}</option>`)}
            </select>
          </label>
          <label class="debug-control">
            Refresh
            <select value=${refreshMs} onChange=${(e) => setRefreshMs(Number(e.target.value))}>
              ${REFRESH_OPTIONS.map((o) => html`<option value=${o.ms}>${o.label}</option>`)}
            </select>
          </label>
          <button class="debug-refresh" onClick=${load}>Refresh now</button>
        </div>
      </div>

      ${error && html`<div class="debug-error">⚠️ ${error}</div>`}
      ${!data && !loadedOnce && html`<div class="debug-loading">Loading…</div>`}
      ${vitals && html`<${ProcessHealthSection} vitals=${vitals} />`}

      ${data && html`
        <section class="debug-section">
          <h2 class="debug-section-title">Writer-worker queue</h2>
          <div class="debug-queue-cards">
            <div class="debug-card">
              <div class="debug-card-label">Current depth</div>
              <div class="debug-card-value">${data.writerQueue.currentDepth}</div>
            </div>
            <div class="debug-card">
              <div class="debug-card-label">Peak (window)</div>
              <div class="debug-card-value">${data.writerQueue.peakDepth}</div>
            </div>
            <div class="debug-card">
              <div class="debug-card-label">Mean (window)</div>
              <div class="debug-card-value">${data.writerQueue.meanDepth.toFixed(1)}</div>
            </div>
            <div class="debug-card debug-card-spark">
              <div class="debug-card-label">Depth over window</div>
              <${Sparkline} samples=${data.writerQueue.samples} peak=${data.writerQueue.peakDepth} />
            </div>
          </div>
          ${data.writerQueue.byOp && data.writerQueue.byOp.length > 0 && html`
            <div class="debug-byop">
              <div class="debug-byop-title">
                Pending by op (current snapshot)
                <span class="debug-byop-hint">— what's filling the queue right now</span>
              </div>
              <table class="debug-byop-table">
                <thead>
                  <tr>
                    <th>Op</th>
                    <th>Priority</th>
                    <th class="num">Count</th>
                  </tr>
                </thead>
                <tbody>
                  ${data.writerQueue.byOp.slice(0, 12).map((row) => html`
                    <tr>
                      <td><code>${row.op}</code></td>
                      <td>
                        <span class="debug-pill" style=${`background:${priorityColor(row.priority)}25; color:${priorityColor(row.priority)}`}>
                          ${row.priority}
                        </span>
                      </td>
                      <td class="num">${row.count}</td>
                    </tr>
                  `)}
                </tbody>
              </table>
            </div>
          `}
        </section>

        <section class="debug-section">
          <h2 class="debug-section-title">Per-route latency (sorted by p95 total)</h2>
          <p class="debug-section-sub">
            <strong>total</strong> = wall-clock end-to-end ·
            <strong>wq</strong> = writer-queue wait sum ·
            <strong>wx</strong> = writer-exec sum ·
            <strong>calls</strong> = writer-proxy calls / req
          </p>
          ${data.routes.length === 0
            ? html`<div class="debug-empty">No requests recorded in this window.</div>`
            : html`
              <table class="debug-table">
                <thead>
                  <tr>
                    <th>Route</th>
                    <th>Caller</th>
                    <th class="num">N</th>
                    <th class="num">total p50</th>
                    <th class="num">total p95</th>
                    <th class="num">total p99</th>
                    <th class="num">wq p95</th>
                    <th class="num">wx p95</th>
                    <th class="num">calls/req</th>
                    <th class="num">5xx</th>
                  </tr>
                </thead>
                <tbody>
                  ${data.routes.map((r) => html`
                    <tr>
                      <td><code>${r.route}</code></td>
                      <td>
                        <span class="debug-pill" style=${`background:${callerColor(r.callerKind)}25; color:${callerColor(r.callerKind)}`}>
                          ${r.callerKind}
                        </span>
                      </td>
                      <td class="num">${r.count}</td>
                      <td class="num">${fmtMs(r.totalP50)}</td>
                      <td class="num">${fmtMs(r.totalP95)}</td>
                      <td class="num">${fmtMs(r.totalP99)}</td>
                      <td class="num">${fmtMs(r.writerQueueP95)}</td>
                      <td class="num">${fmtMs(r.writerExecP95)}</td>
                      <td class="num">${r.meanWriterCalls.toFixed(2)}</td>
                      <td class="num ${r.errorCount > 0 ? "debug-err" : ""}">${r.errorCount}</td>
                    </tr>
                  `)}
                </tbody>
              </table>
            `}
        </section>

        <${SchedulerPanels} snapshot=${scheduler} />

        <div class="debug-footer">Generated ${new Date(data.generatedAt).toLocaleTimeString()} · window ${data.windowSeconds}s</div>
      `}
    </div>
  `;
}

function SchedulerPanels({ snapshot }) {
  if (!snapshot) {
    return html`
      <section class="debug-section">
        <h2 class="debug-section-title">Scheduler</h2>
        <div class="debug-empty">Scheduler snapshot unavailable.</div>
      </section>
    `;
  }
  const { userSla, perRunner, perTask } = snapshot;
  return html`
    <section class="debug-section">
      <h2 class="debug-section-title">Scheduler · user-priority SLA</h2>
      <p class="debug-section-sub">
        Latency of every <strong>user</strong>-priority task that ran in
        the window, end-to-end. Budget is <code>${userSla.budgetMs}ms</code>;
        gauges turn yellow above 1× and red above 2×. Violations =
        executions that exceeded budget.
      </p>
      ${userSla.count === 0
        ? html`<div class="debug-empty">No user-priority traffic in window.</div>`
        : html`
          <div class="debug-queue-cards">
            ${[
              { label: "p50", value: userSla.p50 },
              { label: "p95", value: userSla.p95 },
              { label: "p99", value: userSla.p99 },
              { label: "p999", value: userSla.p999 },
            ].map((g) => html`
              <div class="debug-card">
                <div class="debug-card-label">${g.label} (budget ${userSla.budgetMs}ms)</div>
                <div class="debug-card-value" style=${`color:${slaColor(g.value, userSla.budgetMs)}`}>
                  ${fmtMs(g.value)}
                </div>
              </div>
            `)}
            <div class="debug-card">
              <div class="debug-card-label">Violations / N</div>
              <div class="debug-card-value">
                <span style=${`color:${userSla.violations > 0 ? "#fca5a5" : "var(--text-primary)"}`}>${userSla.violations}</span>
                <span style="color:var(--text-secondary); font-size:14px;"> / ${userSla.count}</span>
              </div>
            </div>
          </div>
        `}
    </section>

    <section class="debug-section">
      <h2 class="debug-section-title">Scheduler · per-runner queue health</h2>
      <p class="debug-section-sub">
        Live queue depth + max head-of-queue age per priority. Rows where any
        age exceeds <strong>5000ms</strong> are highlighted — that's the
        starvation signal we're watching for.
      </p>
      ${perRunner.length === 0
        ? html`<div class="debug-empty">No runners registered.</div>`
        : html`
          <table class="debug-table">
            <thead>
              <tr>
                <th>Runner</th>
                <th class="num">Util%</th>
                <th class="num">In-flight</th>
                <th>Queue depth (user / realtime / background)</th>
                <th>Queue age max ms (user / realtime / background)</th>
              </tr>
            </thead>
            <tbody>
              ${perRunner.map((r) => {
                const ages = r.queueAgeMaxByPriority;
                const starved = (ages.user ?? 0) > 5000 || (ages.realtime ?? 0) > 5000 || (ages.background ?? 0) > 5000;
                const depths = r.queueDepthByPriority;
                return html`
                  <tr style=${starved ? "background: rgba(252, 165, 165, 0.08);" : ""}>
                    <td><code>${r.runner}</code></td>
                    <td class="num">${r.utilization != null ? fmtPct(r.utilization) : "—"}</td>
                    <td class="num">${r.inFlight}</td>
                    <td>
                      ${["user", "realtime", "background"].map((p) => html`
                        <span class="debug-pill" style=${`background:${priorityColor(p)}25; color:${priorityColor(p)}; margin-right:4px;`}>
                          ${p[0]}:${depths[p] ?? 0}
                        </span>
                      `)}
                    </td>
                    <td>
                      ${["user", "realtime", "background"].map((p) => {
                        const age = ages[p] ?? 0;
                        const hot = age > 5000;
                        return html`
                          <span class="debug-pill" style=${`background:${priorityColor(p)}25; color:${hot ? "#fca5a5" : priorityColor(p)}; margin-right:4px;`}>
                            ${p[0]}:${fmtMs(age)}
                          </span>
                        `;
                      })}
                    </td>
                  </tr>
                `;
              })}
            </tbody>
          </table>
        `}
    </section>

    <section class="debug-section">
      <h2 class="debug-section-title">Scheduler · top tasks by p99 exec</h2>
      <p class="debug-section-sub">
        Top 15 tasks by p99 exec time. <strong>slow</strong> = executions
        exceeding the task's <code>latencyBudgetMs</code>; <strong>yields</strong>
        signal cooperative preemption (informational); <strong>err</strong>
        = throws. Priority is resolved per execution, so a task that ran at
        more than one shows a pill per priority with its count. Every count
        covers the task's last 500 executions at most, so a hot task's row
        describes its most recent runs rather than the whole window.
      </p>
      ${perTask.length === 0
        ? html`<div class="debug-empty">No task executions recorded in this window.</div>`
        : html`
          <table class="debug-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Runner</th>
                <th>Priority</th>
                <th class="num">N</th>
                <th class="num">p50</th>
                <th class="num">p95</th>
                <th class="num">p99</th>
                <th class="num">max</th>
                <th class="num">CPU%</th>
                <th class="num">slow</th>
                <th class="num">yields</th>
                <th class="num">err</th>
              </tr>
            </thead>
            <tbody>
              ${perTask.slice(0, 15).map((t) => {
                // One pill per priority the task ran at. A task that ran at a
                // single priority shows its name alone — N already carries
                // the count — while a split row labels each pill with its share.
                const ran = ["user", "realtime", "background"].filter((p) => (t.countByPriority[p] ?? 0) > 0);
                return html`
                <tr>
                  <td><code>${t.name}</code></td>
                  <td><code>${t.runner}</code></td>
                  <td>
                    ${ran.map((p) => html`
                      <span class="debug-pill" style=${`background:${priorityColor(p)}25; color:${priorityColor(p)}; margin-right:4px;`}>
                        ${ran.length > 1 ? `${p}:${t.countByPriority[p]}` : p}
                      </span>
                    `)}
                  </td>
                  <td class="num">${t.count}</td>
                  <td class="num">${fmtMs(t.p50)}</td>
                  <td class="num">${fmtMs(t.p95)}</td>
                  <td class="num">${fmtMs(t.p99)}</td>
                  <td class="num">${fmtMs(t.max)}</td>
                  <td class="num">${t.cpuUtilization != null ? fmtPct(t.cpuUtilization) : "—"}</td>
                  <td class="num ${t.slowOpCount > 0 ? "debug-err" : ""}">${t.slowOpCount}</td>
                  <td class="num">${t.yieldCount}</td>
                  <td class="num ${t.errorCount > 0 ? "debug-err" : ""}">${t.errorCount}</td>
                </tr>
              `;
              })}
            </tbody>
          </table>
        `}
    </section>
  `;
}

// ── Background Jobs tab ──────────────────────────────────────────────

const JOB_STATE_COLOR = {
  running: "#86efac",
  idle: "#94a3b8",
  disabled: "#6b7280",
  erroring: "#fca5a5",
  unknown: "#fde68a",
};

const CATEGORY_ORDER = [
  "indexer",
  "graph",
  "people",
  "stats",
  "auth",
  "search",
  "watches",
  // Every Cognition Steward job reports this category. Absent from this list
  // they still render, but sorted into the unknown-category tail rather than
  // in a deliberate position among their neighbours.
  "briefs",
  "infra",
];

function fmtRelativeMs(ts) {
  if (!ts) return "—";
  const ageMs = Date.now() - ts;
  if (ageMs < 0) return "now";
  if (ageMs < 1000) return "<1s ago";
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s ago`;
  if (ageMs < 3600_000) return `${Math.round(ageMs / 60_000)}m ago`;
  return `${Math.round(ageMs / 3600_000)}h ago`;
}

function fmtCadence(c) {
  if (!c) return "—";
  switch (c.mode) {
    case "periodic":
      return `every ${fmtDurationMs(c.intervalMs)}`;
    case "drip":
      return `${fmtDurationMs(c.activeMs)} active · ${fmtDurationMs(c.idleMs)} idle`;
    case "wake-driven":
      return `wake-driven (${c.debounceMs}ms debounce)`;
    case "continuous":
      return c.nominalIntervalMs
        ? `continuous (~${fmtDurationMs(c.nominalIntervalMs)})`
        : "continuous";
    case "on-demand":
      return "on-demand";
    default:
      return "—";
  }
}

function fmtDurationMs(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3600_000)}h`;
}

function BackgroundJobsTab() {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);
  const [refreshMs, setRefreshMs] = useState(2000);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [, setTick] = useState(0);

  async function load() {
    try {
      const data = await getBackgroundJobs();
      setSnapshot(data);
      setError(null);
      setLoadedOnce(true);
    } catch (err) {
      const message = err?.message ?? String(err);
      const reqId = err?.requestId ? ` [id=${String(err.requestId).slice(0, 8)}]` : "";
      setError(`${message}${reqId}`);
    }
  }

  useEffect(() => {
    load();
  }, []);
  useVisiblePoll(load, refreshMs, { enabled: refreshMs > 0 });

  // Independent re-render tick so the "last tick X seconds ago" labels
  // stay accurate even when the snapshot itself didn't move. This is
  // an animation tick (not a network poll), so it stays a raw
  // setInterval — useVisiblePoll would only complicate it.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => (n + 1) % 1_000_000), 1000);
    return () => clearInterval(t);
  }, []);

  const grouped = groupByCategory(snapshot?.jobs ?? []);

  return html`
    <div>
      <div class="debug-header">
        <div>
          <p class="debug-sub">
            Every long-running loop in the gateway, surfaced from
            <code>/admin/background-jobs</code>. Trackers maintain their
            counters in-memory so this view is free to poll. State pills:
            <span class="debug-pill" style=${pillStyle("running")}>running</span>
            <span class="debug-pill" style=${pillStyle("idle")}>idle</span>
            <span class="debug-pill" style=${pillStyle("erroring")}>erroring</span>
            <span class="debug-pill" style=${pillStyle("unknown")}>unknown</span>
            <span class="debug-pill" style=${pillStyle("disabled")}>disabled</span>
          </p>
        </div>
        <div class="debug-controls">
          <label class="debug-control">
            Refresh
            <select value=${refreshMs} onChange=${(e) => setRefreshMs(Number(e.target.value))}>
              ${REFRESH_OPTIONS.map((o) => html`<option value=${o.ms}>${o.label}</option>`)}
            </select>
          </label>
          <button class="debug-refresh" onClick=${load}>Refresh now</button>
        </div>
      </div>
      ${error && html`<div class="debug-error">⚠️ ${error}</div>`}
      ${!snapshot && !loadedOnce && html`<div class="debug-loading">Loading…</div>`}
      ${snapshot && grouped.length === 0 && html`
        <div class="debug-empty">No background jobs registered.</div>
      `}
      ${grouped.map(([category, jobs]) => html`
        <section class="debug-section">
          <h2 class="debug-section-title">${category}</h2>
          <table class="debug-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>State</th>
                <th>Cadence</th>
                <th>Progress</th>
                <th class="num">Last tick</th>
                <th class="num">Avg ms</th>
                <th class="num">P99 ms</th>
                <th class="num">Ticks/h</th>
                <th class="num">Errors</th>
              </tr>
            </thead>
            <tbody>
              ${jobs.map((j) => html`<${JobRow} job=${j} />`)}
            </tbody>
          </table>
        </section>
      `)}
      ${snapshot && html`
        <div class="debug-footer">
          Generated ${new Date(snapshot.generatedAt).toLocaleTimeString()}
          · ${snapshot.jobs.length} jobs
        </div>
      `}
    </div>
  `;
}

function pillStyle(state) {
  const c = JOB_STATE_COLOR[state] ?? "#94a3b8";
  return `background:${c}25; color:${c}`;
}

function groupByCategory(jobs) {
  const map = new Map();
  for (const j of jobs) {
    const cat = j.category ?? "infra";
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(j);
  }
  // Sort each group by id for stability so cards don't shuffle
  // between refreshes.
  for (const arr of map.values()) {
    arr.sort((a, b) => a.id.localeCompare(b.id));
  }
  return CATEGORY_ORDER
    .filter((c) => map.has(c))
    .map((c) => [c, map.get(c)])
    .concat([...map.entries()].filter(([c]) => !CATEGORY_ORDER.includes(c)));
}

function JobRow({ job }) {
  const obs = job.observation;
  const state = obs.state;
  const errorBg = obs.lastError ? "rgba(252, 165, 165, 0.06)" : "";
  return html`
    <tr style=${errorBg ? `background:${errorBg};` : ""}>
      <td>
        <div><code>${job.id}</code></div>
        <div style="font-size:11px; color:var(--text-secondary); margin-top:2px;" title=${job.description}>
          ${job.displayName}
        </div>
      </td>
      <td>
        <span class="debug-pill" style=${pillStyle(state)}>
          ${state}${obs.inFlight && state !== "running" ? " · in flight" : ""}
        </span>
      </td>
      <td style="font-size:12px; color:var(--text-secondary);">
        ${fmtCadence(job.cadence)}
      </td>
      <td>
        <${ProgressCell} progress=${obs.progress} inFlight=${obs.inFlight} />
      </td>
      <td class="num" style="color:var(--text-secondary);">
        ${fmtRelativeMs(obs.lastTickAt)}
      </td>
      <td class="num">${fmtMs(obs.avgTickMs)}</td>
      <td class="num">${fmtMs(obs.p99TickMs)}</td>
      <td class="num">${obs.ticksLastHour}</td>
      <td class="num ${obs.lastError ? "debug-err" : ""}" title=${obs.lastError?.message ?? ""}>
        ${obs.lastError ? "!" : "0"}
      </td>
    </tr>
  `;
}

// A backlog's head-of-queue age. `remaining` says how much is outstanding;
// this says how late it is. When the job also reports the latency it is held
// to (`pendingSlaMs`), a breach is highlighted — the threshold comes from the
// server so this display can never disagree with the setting being enforced.
function OldestPending({ oldestPendingMs, pendingSlaMs }) {
  if (typeof oldestPendingMs !== "number") return null;
  const late = isBacklogLate(oldestPendingMs, pendingSlaMs);
  return html`
    <span
      class=${late ? "debug-err" : ""}
      title=${late
        ? `The oldest item in this backlog has waited longer than the ${formatDurationShort(pendingSlaMs)} this job is held to — work depending on it is proceeding without it.`
        : "Age of the oldest item still waiting at the head of this backlog."}
      style="font-size:11px; margin-left:6px; ${late
        ? "font-weight:600;"
        : "color:var(--text-secondary);"}"
      >oldest ${formatDurationShort(oldestPendingMs)}${late ? " ⚠" : ""}</span
    >
  `;
}

function ProgressCell({ progress, inFlight }) {
  if (!progress) return html`<span style="color:var(--text-tertiary, var(--text-secondary));">—</span>`;
  if (progress.kind === "queue") {
    const rate = progress.rateLastMin;
    const empty = progress.remaining === 0 && progress.processedSinceBoot === 0;
    const caughtUp = progress.remaining === 0 && progress.processedSinceBoot > 0;
    if (empty) {
      // Tick happened but nothing to do AND no historical work.
      // The state pill ("idle") already conveys "loop alive";
      // showing "0 remaining · 0.00/s rate" just adds noise.
      return html`<span style="color:var(--text-secondary); font-style:italic; opacity:0.6;">no backlog</span>`;
    }
    if (caughtUp) {
      // Drip caught up: hide the noisy "0 remaining · 0.00/s rate"
      // line. Lead with a positive "caught up" pill, keep
      // processedSinceBoot for context.
      return html`
        <div>
          <span style=${pillStyle("idle")} class="debug-pill">caught up</span>
        </div>
        <div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">
          ${progress.processedSinceBoot.toLocaleString()} processed since boot
        </div>
      `;
    }
    return html`
      <div>
        <strong>${progress.remaining.toLocaleString()}</strong>
        <span style="color:var(--text-secondary); font-size:12px;"> remaining</span>
        ${OldestPending({
          oldestPendingMs: progress.oldestPendingMs,
          pendingSlaMs: progress.pendingSlaMs,
        })}
      </div>
      <div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">
        ${progress.processedSinceBoot.toLocaleString()} processed · ${rate.toFixed(2)}/s rate
      </div>
    `;
  }
  if (progress.kind === "watermark") {
    return html`
      <div style="font-size:12px;">
        <code>${progress.cursor || "—"}</code>
      </div>
      ${progress.lagDocs != null && html`
        <div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">
          lag ${progress.lagDocs.toLocaleString()} docs
          ${progress.lagSec != null ? ` · ${progress.lagSec}s` : ""}
        </div>
      `}
    `;
  }
  if (progress.kind === "scan") {
    const pct = Math.round(progress.coverage * 100);
    const neverSwept = progress.lastSweepCompletedAt == null;
    // First-run case: state pill says "running" but coverage is 0 and
    // no prior sweep info exists — without special-casing, the row
    // reads as "running ... no sweep yet" which is contradictory.
    // Lead with "first sweep in progress" so the user knows the
    // sweep is happening *right now*.
    if (inFlight && neverSwept) {
      return html`
        <div>
          <strong style="color:var(--accent);">first sweep in progress</strong>
        </div>
        <div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">
          coverage will jump to 100% on completion
        </div>
      `;
    }
    return html`
      <div>
        <strong>${pct}%</strong>
        <span style="color:var(--text-secondary); font-size:12px;"> coverage</span>
      </div>
      <div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">
        ${neverSwept
          ? "no sweep yet"
          : html`last sweep ${fmtRelativeMs(progress.lastSweepCompletedAt)}${
              progress.itemsAffectedLastSweep != null
                ? ` · ${progress.itemsAffectedLastSweep.toLocaleString()} affected`
                : ""
            }`}
      </div>
    `;
  }
  // stateless
  return html`<span style="color:var(--text-secondary); font-style:italic; opacity:0.6;">—</span>`;
}
