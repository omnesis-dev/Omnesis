// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The documents an answer cites, as the operator needs to read them on an
 * audit record: which documents, and exactly which links, left or would leave.
 *
 * Every link is printed in full as text. A link is the most identifying thing a
 * citation carries — a mail URL names a message, an app link can name a chat —
 * so the operator sees the URL itself rather than a label standing in for it.
 * Only an http(s) link is clickable, and it opens in a new tab with no opener
 * and no referrer; any other scheme is shown as plain text, because a click on
 * it would hand the URL to whichever native app claims the scheme. Nothing on
 * this list fetches anything: no favicon, no preview, no prefetch.
 *
 * Given the citations the draft carried as a baseline, the list also shows what
 * the privacy check withheld: a citation the draft had and the answer does not
 * is kept on the list and marked withheld, and a field the draft had and the
 * answer's copy lacks is printed struck through and labelled. Both come from
 * the local draft, which never left this machine.
 *
 * Every string is gateway-supplied and ultimately document-derived, so each is
 * passed as a text child and never as markup.
 */

import { html } from "htm/preact";

import { sourceLabel } from "../../lib/format.js";
import { formatPrivacyDay } from "../shared/privacy-vocabulary.js";

const WEB_LINK_RE = /^https?:\/\//i;

/** The fields the privacy check may withhold from a citation it keeps. */
const WITHHOLDABLE_FIELDS = ["title", "timestamp", "sourceUrl", "appUrl"];

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** Only well-formed citation records; a malformed entry cannot be described. */
function citationList(value) {
  return Array.isArray(value)
    ? value.filter((citation) => citation && typeof citation === "object")
    : [];
}

function citationDate(timestamp) {
  if (!present(timestamp)) return null;
  // A timestamp this page cannot parse is still what the record holds, so it
  // is shown as it arrived rather than dropped.
  return formatPrivacyDay(Date.parse(timestamp)) ?? timestamp;
}

/**
 * The list's rows: one per citation, and — against a baseline — one per
 * baseline citation the answer no longer carries, in the baseline's order.
 * A row's `withheld` names the fields the answer's copy lost.
 */
export function privacyCitationRows(citations, baseline = null) {
  const cited = citationList(citations);
  if (!Array.isArray(baseline)) {
    return cited.map((citation) => ({ citation, draft: null, removed: false, withheld: [] }));
  }
  const byDocument = new Map(cited.map((citation) => [citation.documentId, citation]));
  const rows = [];
  const placed = new Set();
  for (const draft of citationList(baseline)) {
    const kept = byDocument.get(draft.documentId);
    if (!kept) {
      rows.push({ citation: draft, draft, removed: true, withheld: [] });
      continue;
    }
    placed.add(kept);
    rows.push({
      citation: kept,
      draft,
      removed: false,
      withheld: WITHHOLDABLE_FIELDS.filter((field) => present(draft[field]) && !present(kept[field])),
    });
  }
  for (const citation of cited) {
    if (!placed.has(citation)) rows.push({ citation, draft: null, removed: false, withheld: [] });
  }
  return rows;
}

function WithheldTag() {
  return html`<span class="privacy-citation-withheld-tag">withheld</span>`;
}

function CitationUrl({ url, withheld }) {
  if (withheld) return html`<del class="privacy-citation-url">${url}</del>`;
  if (WEB_LINK_RE.test(url)) {
    return html`<a
      class="privacy-citation-url"
      href=${url}
      target="_blank"
      rel="noopener noreferrer"
    >${url}</a>`;
  }
  return html`<span class="privacy-citation-url">${url}</span>`;
}

function CitationLink({ label, field, row }) {
  const withheld = row.withheld.includes(field);
  const url = withheld ? row.draft[field] : row.citation[field];
  if (!present(url)) return null;
  return html`<div class="privacy-citation-link">
    <dt>${label}${withheld ? html` <${WithheldTag} />` : null}</dt>
    <dd><${CitationUrl} url=${url} withheld=${withheld || row.removed} /></dd>
  </div>`;
}

function CitationRow({ row }) {
  const { citation, removed } = row;
  const titleWithheld = row.withheld.includes("title");
  const dateWithheld = row.withheld.includes("timestamp");
  const title = titleWithheld ? row.draft.title : citation.title;
  const date = citationDate(dateWithheld ? row.draft.timestamp : citation.timestamp);
  return html`<li class=${`privacy-citation${removed ? " privacy-citation--withheld" : ""}`}>
    <div class="privacy-citation-head">
      ${removed
        ? html`<span class="privacy-chip privacy-chip--kept">Withheld</span>`
        : null}
      ${titleWithheld
        ? html`<del class="privacy-citation-title">${title}</del> <${WithheldTag} />`
        : html`<span class="privacy-citation-title">${present(title) ? title : "Untitled"}</span>`}
      <span class="privacy-citation-meta">
        ${sourceLabel(citation.sourceType)}
        ${date
          ? html` · ${dateWithheld ? html`<del>${date}</del> <${WithheldTag} />` : date}`
          : null}
      </span>
    </div>
    <dl class="privacy-citation-links">
      <${CitationLink} label="Link" field="sourceUrl" row=${row} />
      <${CitationLink} label="App link" field="appUrl" row=${row} />
    </dl>
  </li>`;
}

/**
 * A titled list of citations, or nothing when there is nothing to list.
 *
 * `baseline` is the draft's citations when the list should show what was
 * withheld from them; leave it out for a list that stands on its own.
 */
export function PrivacyCitationList({ citations, baseline = null, heading, note = null }) {
  const rows = privacyCitationRows(citations, baseline);
  if (rows.length === 0) return null;
  const withheld = rows.some((row) => row.removed || row.withheld.length > 0);
  return html`<div class="privacy-citations">
    <strong class="privacy-citations-heading">${heading}</strong>
    ${note ? html`<p class="privacy-card-note">${note}</p>` : null}
    ${withheld
      ? html`<p class="privacy-card-note">
          Marked withheld: in the draft, removed by the privacy check. It did not leave this machine.
        </p>`
      : null}
    <ul class="privacy-citation-list">
      ${rows.map((row, index) => html`<${CitationRow}
        key=${`${row.citation.documentId ?? "citation"}-${index}`}
        row=${row}
      />`)}
    </ul>
  </div>`;
}
