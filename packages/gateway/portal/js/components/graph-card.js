// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useState, useEffect } from "preact/hooks";
import { navigate } from "../lib/router.js";
import { getDocumentGraph } from "../api.js";
import { buildTimeline } from "../lib/graph-timeline.js";
import { TimelineColumn } from "./timeline.js";
import {
  isOpenableExternalUrl,
  sourceLabel,
  sourceIcon,
} from "../lib/format.js";
import { FileTypeIcon } from "../lib/file-type-icons.js";
import { renderResolvedPersonMini, groupPeopleByPerson } from "../lib/person-card.js";
import { cursorPageBoundaryState, LoadMore } from "./load-more.js";

// Depth + fan-out for the Timeline tab's seed walk. Mirrors the Graph
// debugger's defaults so the two views surface the same neighbourhood.
const TIMELINE_DEPTH = 10;
const TIMELINE_FANOUT = 50;

/**
 * The "Omnesis graph" panel on the document-detail page frames the
 * surrounding data as a graph: vertices (people, other documents) and
 * the edges connecting them to this doc. It is fed `resolvedPeople`,
 * `refs`, `attachmentInfos`, `attachmentChildren`, and `nearDupes` from
 * the document endpoints; nothing here mutates storage. Edges are
 * grouped by type so the type label lives once in the section header
 * rather than as a pill on every row.
 */

/**
 * Compute the per-edge-type row groups for one document. Pulled out so
 * the panel can both decide whether to render at all (totalEdges) and
 * hand the same rows to the Graph tab body without recomputing.
 */
function computeGraphRows({ refs, resolvedPeople, attachmentInfos, attachmentChildren, nearDupes }) {
  const peopleRows = (resolvedPeople && resolvedPeople.length > 0) ? groupPeopleByPerson(resolvedPeople) : [];
  const attachmentRows = buildAttachmentRows({ attachmentInfos, attachmentChildren });
  const outboundDocRows = (refs?.outbound ?? []).filter((r) => r.targetDocId);
  const inboundDocRows = refs?.inbound ?? [];
  const externalLinkRows = (refs?.outbound ?? []).filter((r) => !r.targetDocId);
  const nearDupRows = nearDupes ?? [];
  const totalEdges =
    peopleRows.length +
    attachmentRows.length +
    outboundDocRows.length +
    inboundDocRows.length +
    externalLinkRows.length +
    nearDupRows.length;
  return { peopleRows, attachmentRows, outboundDocRows, inboundDocRows, externalLinkRows, nearDupRows, totalEdges };
}

export function shouldRenderGraphPanel(totalEdges, ...pages) {
  return totalEdges > 0 || pages.some((page) => cursorPageBoundaryState(page).visible);
}

export function shouldRenderGraphPageSection(rows, page) {
  return rows.length > 0 || cursorPageBoundaryState(page).visible;
}

/**
 * Document-detail "Omnesis graph" panel. Two tabs over the same
 * neighbourhood: <b>Graph</b> (people, contained docs, references,
 * near-duplicates as grouped edge lists — the default) and
 * <b>Timeline</b> (the document-as-seed graph walk laid out
 * chronologically via the shared timeline renderer).
 *
 * Returns null when the document has no graph edges, preserving the
 * old card's hide-when-empty behaviour.
 */
export function GraphTimelinePanel(props) {
  const { documentId, inboundPage, outboundPage, nearDupPage } = props;
  const [tab, setTab] = useState("graph");
  const rows = computeGraphRows(props);
  // Cross-store `same-entity` edges (#450) come from the graph walker, not the
  // document-detail props, so fetch them separately. An activity / event /
  // transaction document may have ONLY this edge, so it counts toward the
  // panel's visible-when-non-empty decision.
  const boundRows = useBoundRows(documentId);
  const totalEdges = rows.totalEdges + boundRows.length;
  const inboundBoundary = cursorPageBoundaryState(inboundPage);
  const outboundBoundary = cursorPageBoundaryState(outboundPage);
  const nearDupBoundary = cursorPageBoundaryState(nearDupPage);
  const hasMoreEdges =
    inboundPage?.isPartial ||
    outboundPage?.isPartial ||
    nearDupPage?.isPartial ||
    inboundBoundary.visible ||
    outboundBoundary.visible ||
    nearDupBoundary.visible;

  if (!shouldRenderGraphPanel(totalEdges, inboundPage, outboundPage, nearDupPage)) return null;

  return html`
    <div class="meta-panel graph-card">
      <div class="meta-panel-title graph-card-title">
        <span>Omnesis graph</span>
        <span class="graph-card-count">
          ${totalEdges} edge${totalEdges === 1 ? "" : "s"}${hasMoreEdges ? " loaded" : ""}
        </span>
      </div>

      <div class="graph-card-tabs" role="tablist">
        ${[["graph", "Graph"], ["timeline", "Timeline"]].map(([key, label]) => html`
          <button
            key=${key}
            type="button"
            role="tab"
            aria-selected=${tab === key}
            class=${`graph-card-tab ${tab === key ? "active" : ""}`}
            onClick=${() => setTab(key)}
          >${label}</button>
        `)}
      </div>

      ${tab === "graph"
        ? html`<${GraphTabBody}
            rows=${rows}
            boundRows=${boundRows}
            documentId=${documentId}
            inboundPage=${inboundPage}
            outboundPage=${outboundPage}
            nearDupPage=${nearDupPage}
          />`
        : html`<${TimelineTabBody} documentId=${documentId} />`}
    </div>
  `;
}

/**
 * Fetch this document's cross-store `same-entity` rows (#450) from the graph
 * walker (`GET /documents/:id/graph`). One shallow hop is enough — the bound
 * analytics row is a direct neighbour. Returns [] on error / while loading so
 * the panel degrades to its document-only edges.
 */
function useBoundRows(documentId) {
  const [boundRows, setBoundRows] = useState([]);
  useEffect(() => {
    let cancelled = false;
    setBoundRows([]);
    getDocumentGraph([documentId], 1, 50)
      .then((graph) => {
        if (cancelled) return;
        setBoundRows((graph?.vertices ?? []).filter((v) => v.kind === "analytics-row"));
      })
      .catch(() => {
        if (!cancelled) setBoundRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [documentId]);
  return boundRows;
}

// ─── Graph tab: grouped edge-type sections ───────────────────────────

function GraphTabBody({
  rows,
  boundRows,
  documentId,
  inboundPage,
  outboundPage,
  nearDupPage,
}) {
  const {
    peopleRows,
    attachmentRows,
    outboundDocRows,
    inboundDocRows,
    externalLinkRows,
    nearDupRows,
  } = rows;
  const inboundBoundary = cursorPageBoundaryState(inboundPage);
  const outboundBoundary = cursorPageBoundaryState(outboundPage);
  const nearDupBoundary = cursorPageBoundaryState(nearDupPage);
  return html`
    <div class="graph-card-tab-body">
      ${boundRows && boundRows.length > 0 && html`
        <${GraphSection} label="Same entity" count=${boundRows.length} hint="this doc ↔ its analytics row">
          <div class="graph-rowset">
            ${boundRows.map((v) => html`<${BoundRowRow} vertex=${v} />`)}
          </div>
        </${GraphSection}>
      `}

      ${peopleRows.length > 0 && html`
        <${GraphSection} label="People" count=${peopleRows.length} hint="connected by role">
          <div class="pc-mini-card-list">
            ${peopleRows.map((p) => renderResolvedPersonMini(p, { role: p.role, roles: p.roles }))}
          </div>
        </${GraphSection}>
      `}

      ${attachmentRows.length > 0 && html`
        <${GraphSection} label="Contains" count=${attachmentRows.length} hint="attachments">
          <div class="graph-rowset">
            ${attachmentRows.map((row) => html`<${AttachmentRow} info=${row.info} child=${row.child} />`)}
          </div>
        </${GraphSection}>
      `}

      ${outboundDocRows.length > 0 && html`
        <${GraphSection}
          label="References"
          count=${outboundDocRows.length}
          partial=${outboundPage?.isPartial}
          hint="this doc \u2192 others"
        >
          <div class="graph-rowset">
            ${outboundDocRows.map((link) => html`<${OutboundDocRow} link=${link} />`)}
          </div>
        </${GraphSection}>
      `}

      ${shouldRenderGraphPageSection(inboundDocRows, inboundPage) && html`
        <${GraphSection}
          label="Referenced by"
          count=${inboundDocRows.length}
          partial=${inboundPage?.isPartial}
          hint="others \u2192 this doc"
        >
          <div class="graph-rowset">
            ${inboundDocRows.map((link) => html`<${InboundDocRow} link=${link} />`)}
          </div>
          <${LoadMore}
            hasMore=${inboundBoundary.hasMore}
            loading=${inboundBoundary.loading}
            error=${inboundBoundary.error}
            onLoadMore=${inboundBoundary.onLoadMore}
            label="Load more inbound references"
          />
        </${GraphSection}>
      `}

      ${shouldRenderGraphPageSection(nearDupRows, nearDupPage) && html`
        <${GraphSection}
          label="Similar"
          count=${nearDupRows.length}
          partial=${nearDupPage?.isPartial}
          hint="near-duplicates"
        >
          <div class="graph-rowset">
            ${nearDupRows.map((edge) => html`<${SimilarDocRow} edge=${edge} />`)}
          </div>
          <${LoadMore}
            hasMore=${nearDupBoundary.hasMore}
            loading=${nearDupBoundary.loading}
            error=${nearDupBoundary.error}
            onLoadMore=${nearDupBoundary.onLoadMore}
            label="Load more similar documents"
          />
        </${GraphSection}>
      `}

      ${externalLinkRows.length > 0 && html`
        <${GraphSection}
          label="External links"
          count=${externalLinkRows.length}
          partial=${outboundPage?.isPartial}
          hint="targets not in your index"
        >
          <div class="graph-rowset">
            ${externalLinkRows.map((link) => html`<${ExternalLinkRow} link=${link} />`)}
          </div>
        </${GraphSection}>
      `}
      <${LoadMore}
        hasMore=${outboundBoundary.hasMore}
        loading=${outboundBoundary.loading}
        error=${outboundBoundary.error}
        onLoadMore=${outboundBoundary.onLoadMore}
        label="Load more outbound references"
      />

      ${documentId && html`
        <a
          class="graph-card-view-link"
          href=${`/portal/debug/graph?documentId=${encodeURIComponent(documentId)}`}
          onClick=${(e) => { e.preventDefault(); navigate(`/portal/debug/graph?documentId=${encodeURIComponent(documentId)}`); }}
        >View graph →</a>
      `}
    </div>
  `;
}

// ─── Timeline tab: chronological seed walk ───────────────────────────

/**
 * Fetches the document-as-seed graph walk on first open, builds the
 * shared timeline event list from it, and hands it to the timeline
 * renderer. The walk is cached for the panel's lifetime — re-opening
 * the tab doesn't refetch. Keyed by documentId at the panel call site
 * so navigating between documents resets it.
 */
function TimelineTabBody({ documentId }) {
  const [state, setState] = useState({ status: "loading", events: null, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading", events: null, error: null });
    getDocumentGraph([documentId], TIMELINE_DEPTH, TIMELINE_FANOUT)
      .then((graph) => {
        if (cancelled) return;
        setState({ status: "ready", events: buildTimeline(graph), error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ status: "error", events: null, error: err?.message ?? String(err) });
      });
    return () => { cancelled = true; };
  }, [documentId]);

  if (state.status === "loading") {
    return html`<div class="graph-card-tab-body graph-card-timeline-msg">Loading timeline…</div>`;
  }
  if (state.status === "error") {
    return html`<div class="graph-card-tab-body graph-card-timeline-msg">Couldn't load timeline: ${state.error}</div>`;
  }
  return html`
    <div class="graph-card-tab-body graph-card-timeline">
      <${TimelineColumn} events=${state.events} />
    </div>
  `;
}

// ─── Sub-section layout ──────────────────────────────────────────────

function GraphSection({ label, count, partial = false, hint, children }) {
  return html`
    <div class="graph-section">
      <div class="graph-section-head">
        <span class="graph-section-label">${label}</span>
        <span class="graph-section-count">${count}${partial ? " loaded" : ""}</span>
        ${hint && html`<span class="graph-section-hint">${hint}</span>`}
      </div>
      ${children}
    </div>
  `;
}

// ─── Attachment rows ─────────────────────────────────────────────────

/**
 * Build one entry per attachment. We match infos to their extracted
 * child documents by filename — unique within a single email in
 * practice; on collision we just pick the first match (harmless).
 */
function buildAttachmentRows({ attachmentInfos, attachmentChildren }) {
  if (!attachmentInfos || attachmentInfos.length === 0) return [];
  const childByFilename = new Map();
  for (const child of attachmentChildren ?? []) {
    if (child.title && !childByFilename.has(child.title)) {
      childByFilename.set(child.title, child);
    }
  }
  return attachmentInfos.map((info) => ({
    info,
    child: childByFilename.get(info.filename) ?? null,
  }));
}

function AttachmentRow({ info, child }) {
  const isReferenceLink =
    !child &&
    info.reason === "reference-only" &&
    isOpenableExternalUrl(info.url);
  const linkable = child || isReferenceLink;

  const onClick = (e) => {
    if (child) {
      e.preventDefault();
      navigate("/portal/doc/" + encodeURIComponent(child.id));
    }
  };

  const href = child
    ? "/portal/doc/" + encodeURIComponent(child.id)
    : isReferenceLink
      ? info.url
      : null;
  const target = (isReferenceLink && !child) ? "_blank" : undefined;
  const rel = target === "_blank" ? "noopener" : undefined;

  const titleNode = linkable
    ? html`<a class="graph-row-title graph-row-title-link" href=${href} target=${target} rel=${rel} onClick=${onClick} title=${info.filename}>${info.filename}</a>`
    : html`<span class="graph-row-title" title=${info.filename}>${info.filename}</span>`;

  return html`
    <div class="graph-row graph-row-stacked">
      <div class="graph-row-main">
        <span class="graph-row-icon">
          <${FileTypeIcon} mimeType=${info.mimeType} filename=${info.filename} size=${16} />
        </span>
        ${titleNode}
      </div>
      <div class="graph-row-sub">
        <span>${formatSize(info.size)}</span>
        <${AttachmentStatusPill} info=${info} hasChild=${!!child} />
      </div>
    </div>
  `;
}

// ─── Outbound resolved-doc rows ──────────────────────────────────────

function OutboundDocRow({ link }) {
  const onClick = (e) => {
    e.preventDefault();
    navigate("/portal/doc/" + encodeURIComponent(link.targetDocId));
  };
  const title = link.targetTitle || link.targetDocId.slice(0, 12);
  const linkType = link.linkType || "references";
  return html`
    <a class="graph-row graph-row-stacked graph-row-link" href=${"/portal/doc/" + encodeURIComponent(link.targetDocId)} onClick=${onClick}>
      <div class="graph-row-main">
        ${link.targetSourceId && html`<span class="graph-row-icon">${sourceIcon(link.targetSourceId, { size: 16 })}</span>`}
        <span class="graph-row-title">${title}</span>
      </div>
      <div class="graph-row-sub">
        ${link.targetSourceId && html`<span>${sourceLabel(link.targetSourceId)}</span>`}
        ${linkType !== "references" && html`<span class="graph-row-edge-type">${linkType}</span>`}
      </div>
    </a>
  `;
}

// ─── Same-entity rows (cross-store doc ↔ DuckDB analytics row, #450) ──

function BoundRowRow({ vertex }) {
  const table = vertex.tableDisplayName || vertex.tableName || "analytics row";
  const row = vertex.row || {};
  // A few headline fields; skip the id/key column — it's the join key, not info.
  const fields = Object.entries(row)
    .filter(([k]) => k !== "id")
    .slice(0, 4);
  // Deep-link to the SQL editor with a query that fetches this exact row.
  // Falls back to the table browser when the vertex lacks structured key
  // columns (older graph payloads).
  const sql = boundRowSql(vertex);
  const href = sql
    ? `/portal/debug/sql?${new URLSearchParams({ store: "duckdb", sql })}`
    : "/portal/debug/data";
  const onClick = (e) => {
    e.preventDefault();
    navigate(href);
  };
  return html`
    <a
      class="graph-row graph-row-stacked graph-row-link"
      href=${href}
      onClick=${onClick}
      title=${`${vertex.tableName} · ${vertex.rowPrimaryKey ?? ""}`}
    >
      <div class="graph-row-main">
        <span class="graph-row-icon">▦</span>
        <span class="graph-row-title">${table}</span>
      </div>
      <div class="graph-row-sub">
        ${fields.map(
          ([k, val]) => html`<span class="graph-row-edge-type">${k}: ${formatCell(val)}</span>`,
        )}
      </div>
    </a>
  `;
}

// DuckDB types whose literals are written bare; everything else (VARCHAR,
// DATE, TIMESTAMP, JSON, …) is quoted as a string.
const NUMERIC_SQL_TYPES = new Set(["INTEGER", "BIGINT", "DOUBLE", "FLOAT", "BOOLEAN"]);

function sqlLiteral(value, castType) {
  const t = String(castType || "").toUpperCase();
  if (NUMERIC_SQL_TYPES.has(t) || t.startsWith("DECIMAL")) return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Build a `SELECT * … WHERE pk = …` that fetches the exact bound row, from the
// vertex's structured primary-key columns. Returns null when they're absent.
function boundRowSql(vertex) {
  const cols = vertex.rowPrimaryKeyColumns;
  if (!vertex.tableName || !Array.isArray(cols) || cols.length === 0) return null;
  const where = cols.map((c) => `${c.name} = ${sqlLiteral(c.value, c.castType)}`).join(" AND ");
  return `SELECT * FROM ${vertex.tableName} WHERE ${where}`;
}

function formatCell(val) {
  if (val === null || val === undefined) return "—";
  const s = typeof val === "string" ? val : String(val);
  return s.length > 28 ? s.slice(0, 27) + "…" : s;
}

// ─── Inbound resolved-doc rows ───────────────────────────────────────

function InboundDocRow({ link }) {
  const onClick = (e) => {
    e.preventDefault();
    navigate("/portal/doc/" + encodeURIComponent(link.sourceDocId));
  };
  const title = link.sourceTitle || link.sourceDocId.slice(0, 12);
  return html`
    <a class="graph-row graph-row-stacked graph-row-link" href=${"/portal/doc/" + encodeURIComponent(link.sourceDocId)} onClick=${onClick}>
      <div class="graph-row-main">
        <span class="graph-row-icon">${sourceIcon(link.sourceSourceId, { size: 16 })}</span>
        <span class="graph-row-title">${title}</span>
      </div>
      <div class="graph-row-sub">
        <span>${sourceLabel(link.sourceSourceId)}</span>
        ${link.linkType && link.linkType !== "references" && html`<span class="graph-row-edge-type">${link.linkType}</span>`}
      </div>
    </a>
  `;
}

// ─── Near-duplicate rows (similarity edges) ──────────────────────────

function SimilarDocRow({ edge }) {
  const onClick = (e) => {
    e.preventDefault();
    navigate("/portal/doc/" + encodeURIComponent(edge.otherDocId));
  };
  const title = edge.otherTitle || edge.otherDocId.slice(0, 12);
  const similarity = (edge.jaccard * 100).toFixed(0) + "%";
  return html`
    <a class="graph-row graph-row-stacked graph-row-link" href=${"/portal/doc/" + encodeURIComponent(edge.otherDocId)} onClick=${onClick}>
      <div class="graph-row-main">
        ${edge.otherSourceId && html`<span class="graph-row-icon">${sourceIcon(edge.otherSourceId, { size: 16 })}</span>`}
        <span class="graph-row-title">${title}</span>
      </div>
      <div class="graph-row-sub">
        ${edge.otherSourceId && html`<span>${sourceLabel(edge.otherSourceId)}</span>`}
        <span class="graph-row-edge-type" title=${`Jaccard ${edge.jaccard.toFixed(2)}, df2=${edge.pairUniqueDf2}, containment=${edge.containmentMin.toFixed(2)}`}>${similarity}</span>
      </div>
    </a>
  `;
}

// ─── External-link rows (URLs / unresolved targets) ──────────────────

function ExternalLinkRow({ link }) {
  const isUrl = !link.linkType || link.linkType === "url";
  if (isUrl && isOpenableExternalUrl(link.rawTarget)) {
    return html`
      <a class="graph-row graph-row-stacked" href=${link.rawTarget} target="_blank" rel="noopener" title=${link.rawTarget}>
        <div class="graph-row-main">
          <span class="graph-row-title graph-row-title-link">${truncateUrl(link.rawTarget, 64)}</span>
        </div>
      </a>
    `;
  }
  return html`
    <div class="graph-row graph-row-stacked" title=${link.rawTarget}>
      <div class="graph-row-main">
        <span class="graph-row-title graph-row-title-muted">${truncateUrl(link.rawTarget, 64)}</span>
      </div>
      <div class="graph-row-sub">
        <span class="graph-row-edge-type">${link.linkType || "url"}</span>
        <span>${isUrl ? "(target cannot be opened)" : "(not yet indexed)"}</span>
      </div>
    </div>
  `;
}

// ─── Shared bits ─────────────────────────────────────────────────────

function AttachmentStatusPill({ info, hasChild }) {
  if (info.extracted) {
    return html`<span class="att-status att-status-extracted">${hasChild ? "Indexed" : "Extracted"}</span>`;
  }
  const reason = info.reason || "skipped";
  return html`<span class="att-status att-status-skipped" title=${reason}>${attachmentStatusLabel(reason)}</span>`;
}

export function attachmentStatusLabel(reason) {
  const labels = {
    "type-excluded": "Type not indexed",
    "size-unknown": "Size unknown",
    "too-large": "Too large",
    "encrypted": "Encrypted",
    "no-text": "No text found",
    "extraction-failed": "Extraction failed",
    "download-failed": "Download failed",
    "reference-only": "External link",
  };
  return labels[reason] || reason;
}

function formatSize(bytes) {
  if (bytes === null || bytes === undefined) return "";
  if (bytes < 1024) return `${bytes}\u00A0B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}\u00A0KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}\u00A0MB`;
}

function truncateUrl(url, max) {
  if (!url) return "";
  if (url.length <= max) return url;
  return url.slice(0, max - 3) + "...";
}
