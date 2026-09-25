// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { timeAgo } from "../lib/format.js";
import { AnnotationList, OmnesisSparkle } from "./annotation-list.js";
import { cursorPageBoundaryState, LoadMore } from "./load-more.js";

export function MetadataPanel({
  document: doc,
  extractedDates = [],
  annotations = [],
  annotationPage = null,
}) {
  if (!doc) return null;

  let meta = doc.metadata;
  if (typeof meta === "string") {
    try { meta = JSON.parse(meta); } catch { meta = {}; }
  }
  meta = meta || {};

  const shortId = doc.id ? doc.id.slice(0, 12) : "";

  function copyId() {
    navigator.clipboard.writeText(doc.id).catch(() => {});
  }

  // Gather extra fields. Skip keys that are surfaced by dedicated side panels
  // — `attachments` has its own AttachmentsPanel, dumping the raw array here
  // would show a redundant JSON blob.
  const HIDE_EXTRA_KEYS = new Set(["attachments"]);
  const extraFields = meta.extra
    ? Object.entries(meta.extra).filter(([k]) => !HIDE_EXTRA_KEYS.has(k))
    : [];
  const annotationBoundary = cursorPageBoundaryState(annotationPage);

  return html`
    <div class="meta-panel">
      <div class="meta-panel-title">Metadata</div>

      <div class="meta-row">
        <span class="meta-key">ID</span>
        <span class="meta-value doc-id-copy" onClick=${copyId} title="Click to copy full ID">${shortId}…</span>
      </div>

      ${doc.source_id && html`
        <div class="meta-row meta-row-block">
          <span class="meta-key">Source</span>
          <span class="meta-value">${doc.source_id}</span>
        </div>
      `}

      ${doc.stream_id && html`
        <div class="meta-row meta-row-block meta-row-device">
          <span class="meta-key">Device</span>
          <span class="meta-value meta-value-text" title=${doc.stream_id}>${doc.device_name || doc.stream_id}</span>
        </div>
      `}

      ${meta.documentType && html`
        <div class="meta-row">
          <span class="meta-key">Type</span>
          <span class="meta-value meta-value-text">${meta.documentType}</span>
        </div>
      `}

      ${doc.source_created_at && html`
        <div class="meta-row">
          <span class="meta-key">Created</span>
          <span class="meta-value meta-value-text">${timeAgo(doc.source_created_at)}</span>
        </div>
      `}

      ${doc.source_updated_at && html`
        <div class="meta-row">
          <span class="meta-key">Updated</span>
          <span class="meta-value meta-value-text">${timeAgo(doc.source_updated_at)}</span>
        </div>
      `}

      ${meta.sourceUrl && html`
        <div class="meta-row meta-row-block">
          <span class="meta-key">URL</span>
          <span class="meta-value meta-value-text" title=${meta.sourceUrl}>${truncateUrl(meta.sourceUrl)}</span>
        </div>
      `}

      ${meta.relevanceScore != null && html`
        <div class="meta-row">
          <span class="meta-key">Relevance</span>
          <span class="meta-value meta-value-text">${(meta.relevanceScore * 100).toFixed(0)}%</span>
        </div>
      `}

      ${meta.tags && meta.tags.length > 0 && html`
        <div class="meta-row meta-row-block">
          <span class="meta-key">Tags</span>
          <div>${meta.tags.map((t) => html`<span class="tag-pill">${t}</span>`)}</div>
        </div>
      `}

      ${meta.people && meta.people.length > 0 && html`
        <div class="meta-row meta-row-block">
          <span class="meta-key">People</span>
          <div class="people-list">
            ${groupByRole(meta.people).map(([role, persons]) => html`
              <div class="people-role-group">
                <span class="people-role-label">${roleLabel(role)}</span>
                ${persons.map((p) => html`
                  <span class="people-person">${formatPerson(p)}</span>
                `)}
              </div>
            `)}
          </div>
        </div>
      `}

      ${extraFields.map(([k, v]) => html`
        <div class="meta-row meta-row-block">
          <span class="meta-key">${k}</span>
          <span class="meta-value">${typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
        </div>
      `)}

      ${(
        (extractedDates && extractedDates.length > 0) ||
        (annotations && annotations.length > 0) ||
        annotationBoundary.visible
      ) && html`
        <div class="meta-enriched">
          <div class="meta-enriched-title">
            ${OmnesisSparkle}
            <span>Enriched by Omnesis</span>
          </div>
          ${(extractedDates ?? []).map((d) => html`
            <div class="meta-enriched-date">
              <span class="meta-enriched-value">${formatExtractedDate(d)}</span>
              <span class="meta-enriched-phrase" title=${d.text}>“${d.text}”</span>
            </div>
          `)}
          <${AnnotationList} annotations=${annotations} store="doc" />
          <${LoadMore}
            hasMore=${annotationBoundary.hasMore}
            loading=${annotationBoundary.loading}
            error=${annotationBoundary.error}
            onLoadMore=${annotationBoundary.onLoadMore}
            label="Load more observations"
          />
        </div>
      `}
    </div>
  `;
}

const MOD_LABELS = { before: "before", after: "after", since: "since", until: "until" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Render a canonical extracted date — "YYYY", "YYYY-MM", or "YYYY-MM-DD" — at
 * its own granularity: "2026", "Aug 2026", or "Aug 4, 2026".
 */
export function formatIsoDate(v) {
  if (!v) return "";
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(v);
  if (!m) return v;
  const [, y, mo, d] = m;
  if (!mo) return y;
  const monName = MONTHS[parseInt(mo, 10) - 1] ?? mo;
  if (!d) return `${monName} ${y}`;
  return `${monName} ${parseInt(d, 10)}, ${y}`;
}

/** Human-readable resolved value for one extracted date (point or range). */
export function formatExtractedDate(d) {
  if (d.kind === "range") {
    const mod = d.mod ? MOD_LABELS[d.mod] || d.mod : null;
    if (mod && d.resolvedEnd && !d.resolvedStart) return `${mod} ${formatIsoDate(d.resolvedEnd)}`;
    if (mod && d.resolvedStart && !d.resolvedEnd) return `${mod} ${formatIsoDate(d.resolvedStart)}`;
    if (d.resolvedStart && d.resolvedEnd) {
      return `${formatIsoDate(d.resolvedStart)} – ${formatIsoDate(d.resolvedEnd)}`;
    }
    return formatIsoDate(d.resolvedStart || d.resolvedEnd);
  }
  return formatIsoDate(d.resolvedStart);
}

function groupByRole(people) {
  const map = new Map();
  for (const p of people) {
    if (!map.has(p.role)) map.set(p.role, []);
    map.get(p.role).push(p);
  }
  return Array.from(map.entries());
}

function roleLabel(role) {
  const labels = {
    sender: "Sender", author: "Author", recipient: "Recipients",
    attendee: "Attendees", participant: "Participants", owner: "Owner",
    contact: "Contact", mentioned: "Mentioned",
  };
  return labels[role] || role;
}

function formatPerson(p) {
  const parts = [];
  if (p.name) parts.push(p.name);
  if (p.emails && p.emails.length) parts.push("<" + p.emails.join(", ") + ">");
  if (p.phones && p.phones.length) parts.push(p.phones.join(", "));
  if (p.lids && p.lids.length) parts.push("lid:" + p.lids.join(", "));
  return parts.join(" ") || "(unknown)";
}

function truncateUrl(url) {
  if (url.length <= 50) return url;
  return url.slice(0, 47) + "...";
}
