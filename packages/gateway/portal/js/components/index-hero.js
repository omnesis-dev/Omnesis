// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Indexer hero banner — health/state pill, totals, embedding model.
// Shared between the (now-removed) standalone Index page's history and
// the Sources view, where it sits above the per-source table.

import { html } from "htm/preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { IndexerWarmingCard } from "./indexer-warming-card.js";

function fmtNumber(n) {
  if (n == null) return "—";
  return n.toLocaleString();
}

function fmtDateShort(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(2);
  return `${mm}/${dd}/${yy}`;
}

function fmtTimeAgo(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return fmtDateShort(iso);
}

function fmtBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * What the "on disk" stat shows: the gateway's whole footprint with its
 * per-store breakdown, or — from a gateway that predates `diskUsage`, or
 * before its first measurement lands — the main database size alone, with no
 * breakdown to offer. Null when neither is known.
 */
export function diskUsageReadout(summary) {
  const usage = summary?.diskUsage;
  if (usage && typeof usage.totalBytes === "number") {
    const stores = Array.isArray(usage.stores)
      ? usage.stores.filter((s) => s && typeof s.bytes === "number" && s.bytes > 0)
      : [];
    return { totalBytes: usage.totalBytes, stores };
  }
  if (typeof summary?.dbSizeBytes === "number") {
    return { totalBytes: summary.dbSizeBytes, stores: [] };
  }
  return null;
}

// Hover or keyboard focus opens the breakdown; Escape closes a focus-opened one.
export function DiskUsageStat({ readout }) {
  const popoverId = useId();
  if (!readout) return null;
  if (readout.stores.length === 0) {
    return html`
      <span class="overview-stat">
        <strong>${fmtBytes(readout.totalBytes)}</strong> on disk
      </span>
    `;
  }
  return html`
    <span
      class="overview-stat overview-disk"
      tabindex="0"
      aria-describedby=${popoverId}
      onKeyDown=${(e) => e.key === "Escape" && e.currentTarget.blur()}
    >
      <strong>${fmtBytes(readout.totalBytes)}</strong> on disk
      <span class="overview-disk-popover" id=${popoverId} role="tooltip">
        ${readout.stores.map((store) => html`
          <span class="overview-disk-row" key=${store.id}>
            <span class="overview-disk-label">${store.label}</span>
            <span class="overview-disk-value">${fmtBytes(store.bytes)}</span>
            <span class="overview-disk-bar">
              <span style=${`width: ${readout.totalBytes > 0 ? Math.max(1, (store.bytes / readout.totalBytes) * 100) : 0}%`}></span>
            </span>
          </span>
        `)}
        <span class="overview-disk-row overview-disk-total">
          <span class="overview-disk-label">Total</span>
          <span class="overview-disk-value">${fmtBytes(readout.totalBytes)}</span>
        </span>
      </span>
    </span>
  `;
}

// ---------------------------------------------------------------------------
// ETA estimation — moving-window rate calculation
// ---------------------------------------------------------------------------

const ETA_WINDOW_MS = 5 * 60_000;
const ETA_MAX_SAMPLES = 200;

function fmtDuration(ms) {
  if (ms <= 0) return "< 1m";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "< 1m";
  if (mins < 60) return `~${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) {
    return remMins > 0 ? `~${hours}h ${remMins}m` : `~${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `~${days}d ${remHours}h` : `~${days}d`;
}

function useIndexerEta(totalIndexed, totalDocs) {
  const samplesRef = useRef([]);
  const lastRateRef = useRef(null);

  useEffect(() => {
    if (totalIndexed == null || totalDocs == null) return;
    if (totalIndexed >= totalDocs) {
      samplesRef.current = [];
      lastRateRef.current = null;
      return;
    }
    const now = Date.now();
    const samples = samplesRef.current;
    const last = samples.length > 0 ? samples[samples.length - 1] : null;
    if (!last || last.indexed !== totalIndexed || now - last.ts > 1000) {
      samples.push({ ts: now, indexed: totalIndexed });
    }
    const cutoff = now - ETA_WINDOW_MS;
    while (samples.length > 0 && samples[0].ts < cutoff) samples.shift();
    while (samples.length > ETA_MAX_SAMPLES) samples.shift();
  }, [totalIndexed, totalDocs]);

  if (totalIndexed == null || totalDocs == null || totalIndexed >= totalDocs) return null;

  const samples = samplesRef.current;
  if (samples.length < 2) return "estimating…";

  const oldest = samples[0];
  const newest = samples[samples.length - 1];
  const elapsed = newest.ts - oldest.ts;
  if (elapsed < 4000) return "estimating…";

  const progress = newest.indexed - oldest.indexed;
  if (progress <= 0) {
    if (lastRateRef.current) {
      const remaining = totalDocs - newest.indexed;
      return fmtDuration(remaining / lastRateRef.current);
    }
    return "estimating…";
  }

  const rate = progress / elapsed;
  lastRateRef.current = rate;
  const remaining = totalDocs - newest.indexed;
  return fmtDuration(remaining / rate);
}

/**
 * Compact overview card for the Sources page. Folds indexer health + source
 * fleet stats into a single dense strip:
 *
 *   [● UP TO DATE · 100%]   23 sources · 8 syncing · 265k docs · 418k chunks · 2.8 GB
 *                           Last indexed 5m ago · Embedding model: …
 *
 * If the embedder is missing, falls back to the same `IndexerWarmingCard`
 * the Search page uses, so the user gets one consistent banner with a
 * link to the Models tab.
 */
export function OverviewBar({ stats, summary }) {
  if (!stats) return null;
  const state = stats.state ?? (stats.enabled ? "running" : "disabled");
  if (state === "model-missing") {
    const modelPath = stats.model?.path
      ?? `${stats.model?.modelsDir ?? "~/.config/omnesis/models"}/${stats.model?.name ?? "nomic-embed-text-v1.5.Q8_0.gguf"}`;
    const readiness = {
      indexer: { status: "disabled", reason: `Embedding model not found at ${modelPath}` },
    };
    return html`<${IndexerWarmingCard} readiness=${readiness} />`;
  }

  if (state === "spawning") {
    return html`
      <div class="overview-bar tone-partial">
        <div class="overview-pill">
          <span class="overview-pill-dot"></span>
          <span class="overview-pill-text">STARTING</span>
        </div>
        <div class="overview-stats">
          <span class="overview-stat overview-stat-muted">
            Indexer worker is loading the embedding model…
          </span>
        </div>
      </div>
    `;
  }

  const totalIndexed = stats.totalIndexed ?? 0;
  const totalIndexErrors = stats.totalIndexErrors ?? 0;
  const totalDocs = stats.totalGatewayDocs ?? summary?.totalDocs ?? 0;
  const totalChunks = stats.totalChunks ?? 0;
  // A document is "done" once the indexer has reached a terminal state for it:
  // indexed, or terminally errored (e.g. an un-embeddable chunk). Fold the
  // errored docs into the completion count so the bar reaches 100% once the
  // indexer has caught up, instead of stalling a hair under it forever on the
  // handful it can never embed (their failures stay visible on the sources
  // page). Floor (not round) so a genuine backlog — e.g. 121 fresh docs out of
  // 265k — must NOT advertise as up-to-date until truly caught up.
  const indexedOrErrored = totalIndexed + totalIndexErrors;
  const pct = totalDocs > 0
    ? Math.min(100, Math.floor((indexedOrErrored / totalDocs) * 100))
    : 100;
  const isComplete = totalDocs === 0 || indexedOrErrored >= totalDocs;

  const tone = state === "disabled" ? "off" : isComplete ? "ok" : "partial";
  const pillText = state === "disabled"
    ? "INDEXER OFF"
    : isComplete ? "UP TO DATE" : "INDEXING";

  // Prefer the gateway's server-computed ETA: it tracks a rolling
  // docs/sec rate across the worker's lifetime, so it's available on the
  // first /index/stats response after a page load with no warm-up. The
  // client-side hook stays wired as a graceful fallback for an older
  // gateway that doesn't send `etaSeconds` — hooks must run every render,
  // so we always call it and just prefer the server value when present.
  const clientEta = useIndexerEta(indexedOrErrored, totalDocs);
  const serverEtaSeconds = stats.etaSeconds;
  const eta =
    typeof serverEtaSeconds === "number"
      ? fmtDuration(serverEtaSeconds * 1000)
      : !isComplete
        ? clientEta
        : null;

  return html`
    <div class="overview-bar tone-${tone}">
      <div class="overview-pill">
        <span class="overview-pill-dot"></span>
        <span class="overview-pill-text">${pillText}</span>
        ${state !== "disabled" && html`<span class="overview-pill-pct">${pct}%</span>`}
        ${eta && !isComplete && html`<span class="overview-pill-eta">ETA ${eta}</span>`}
      </div>
      <div class="overview-stats">
        <span class="overview-stat">
          <strong>${fmtNumber(summary?.totalSources)}</strong> sources
        </span>
        ${summary?.syncing > 0 && html`
          <span class="overview-stat overview-stat-syncing">
            <span class="overview-stat-dot"></span><strong>${summary.syncing}</strong> syncing
          </span>
        `}
        ${summary?.errors > 0 && html`
          <span class="overview-stat overview-stat-error">
            <strong>${summary.errors}</strong> ${summary.errors === 1 ? "error" : "errors"}
          </span>
        `}
        <span class="overview-stat">
          <strong>${fmtNumber(totalDocs)}</strong> docs${indexedOrErrored < totalDocs ? html` <span class="overview-stat-sub">(${fmtNumber(totalIndexed)} indexed)</span>` : ""}
        </span>
        <span class="overview-stat">
          <strong>${fmtNumber(totalChunks)}</strong> chunks
        </span>
        ${stats.totalDegraded > 0 && html`
          <span
            class="overview-stat overview-stat-muted"
            title="Documents indexed with some chunks truncated to fit the embedder's token window or dropped because they were unembeddable"
          >
            <strong>${fmtNumber(stats.totalDegraded)}</strong> degraded${(stats.totalTruncatedChunks > 0 || stats.totalDroppedChunks > 0) ? html` <span class="overview-stat-sub">(${fmtNumber(stats.totalTruncatedChunks)} truncated, ${fmtNumber(stats.totalDroppedChunks)} dropped)</span>` : ""}
          </span>
        `}
        <${DiskUsageStat} readout=${diskUsageReadout(summary)} />
        <span class="overview-stat overview-stat-muted">
          last indexed <strong>${fmtTimeAgo(stats.watermark)}</strong>
        </span>
      </div>
      ${stats.model && html`
        <div class="overview-model">
          <span class="overview-model-label">Embedding model</span>
          <code class="overview-model-path">${stats.model.name}</code>
        </div>
      `}
    </div>
  `;
}

export function PctBar({ pct }) {
  const p = Math.max(0, Math.min(100, pct));
  const tone = p >= 100 ? "ok" : p > 0 ? "partial" : "zero";
  return html`
    <div class="index-pctbar ${tone}">
      <div class="index-pctbar-fill" style=${`width: ${p}%`}></div>
      <span class="index-pctbar-label">${Math.round(p)}%</span>
    </div>
  `;
}

/**
 * Status two-readout: turn the gateway's neutral
 * `indexVersions: { active, building }` payload into the migration readout the
 * `MigrationBar` renders. This is rendering, NOT inference — the gateway already
 * decided which generation is active (complete, serving) and which is building;
 * we only pick the framing from whether an active generation exists:
 *
 *   - active present  → a graceful double-buffered swap. Search stays live on
 *     the active model; the build is a separate upgrade-in-flight.
 *   - active null     → a first build or a hard cutover with no complete index;
 *     the build IS the search readiness, so the framing is "limited until done".
 *
 * Returns null when no rebuild is in flight (nothing to surface). All numbers
 * are clamped defensively so a malformed/older payload (NaN, Infinity, a
 * negative or >100 percent, docsTotal 0) can never render NaN% or a broken bar.
 */
export function migrationReadout(versions) {
  const building = versions?.building;
  if (!building || typeof building !== "object") return null;
  const active = versions.active ?? null;
  const num = (v) => (Number.isFinite(v) ? v : 0);
  const docsBuilt = Math.max(0, num(building.docsBuilt));
  const docsTotal = Math.max(0, num(building.docsTotal));
  const percent = Math.max(0, Math.min(100, num(building.percent)));
  const model = building.embedModel || "the new model";
  if (active) {
    const activeModel = active.embedModel || "the current model";
    return {
      kind: "migration",
      label: "Migrating",
      verb: "Migrating to",
      model,
      activeModel,
      percent,
      docsBuilt,
      docsTotal,
      note: `Search stays live on ${activeModel} — switches automatically when ready`,
    };
  }
  return {
    kind: "build",
    label: "Building",
    verb: "Building",
    model,
    activeModel: null,
    percent,
    docsBuilt,
    docsTotal,
    note: "Semantic search limited until the build completes",
  };
}

/**
 * Separate, clearly-labeled background-progress element for a graceful embedder
 * swap. Renders BELOW the OverviewBar and per-source bars, which
 * keep reporting the ACTIVE generation as complete/serving — this element never
 * repoints those at the half-built new index. It reads as an upgrade-in-flight,
 * not a loss of the existing index. Renders nothing when no rebuild is running.
 */
export function MigrationBar({ versions }) {
  const r = migrationReadout(versions);
  if (!r) return null;
  const showDocs = r.docsTotal > 0;
  return html`
    <div class="index-migration-bar ${r.kind}">
      <div class="index-migration-head">
        <span class="index-migration-pill">
          <span class="index-migration-dot"></span>
          <span class="index-migration-label">${r.label.toUpperCase()}</span>
        </span>
        <span class="index-migration-detail">
          ${r.verb} <code class="index-migration-model">${r.model}</code>
        </span>
        <span class="index-migration-figures">
          <span class="index-migration-pct">${r.percent}%</span>
          ${showDocs && html`<span class="index-migration-count">${fmtNumber(r.docsBuilt)} / ${fmtNumber(r.docsTotal)} docs</span>`}
        </span>
      </div>
      <div class="index-migration-track">
        <div class="index-migration-fill" style=${`width: ${r.percent}%`}></div>
      </div>
      <div class="index-migration-note">${r.note}</div>
    </div>
  `;
}
