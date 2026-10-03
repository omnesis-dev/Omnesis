// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { nestProvenanceLines, provenanceLines } from "../lib/search-provenance.js";
import { docHref, sourceLabel, sourceIcon } from "../lib/format.js";

const COPY_REFERENCE_LIMIT = 5;

/** Present additional evidence as facts, relative to the visible search result. */
export function SearchProvenance({ provenance, documents = {}, panelId, resultDocumentId }) {
  if (!provenance) return null;
  const copies = (provenance.copies || []).filter((copy) => copy.documentId !== resultDocumentId);
  const current = (provenance.copies || []).find((copy) => copy.documentId === resultDocumentId);
  const physicalLocation = current && (current.deviceName || current.path);
  const byId = new Map();
  const ids = new Set([
    ...(provenance.copies || []).map((copy) => copy.documentId),
    ...(provenance.paths || []).flatMap((path) => path.documentIds || []),
  ]);
  for (const id of ids) {
    const doc = documents[id];
    byId.set(id, { documentId: id, title: doc?.title, sourceId: doc?.source_id });
  }
  for (const copy of provenance.copies || []) byId.set(copy.documentId, { ...byId.get(copy.documentId), ...copy });
  // The visible result is "This document", never a same-named copy to fold away.
  const lines = provenanceLines(provenance, (id) => id === resultDocumentId ? undefined : byId.get(id)?.title);
  if (!copies.length && !lines.length && !physicalLocation) return null;
  const reference = (id) => id === resultDocumentId
    ? "This document" : html`<${GraphDocumentLink} document=${byId.get(id) || { documentId: id }} />`;
  const renderLine = (line) => html`
    <li class="search-provenance-connection" data-depth=${line.depth}>${line.parts.map((part) => part.documentId
      ? html`${reference(part.documentId)}${part.more ? ` (and ${part.more} more with this name)` : ""}`
      : part.text)}${line.children.length > 0 && html`<ul class="search-provenance-branches">${line.children.map(renderLine)}</ul>`}</li>
  `;
  const copyLocation = (copy) => (copy.deviceName || copy.path) && html` (${copy.deviceName ? `on ${copy.deviceName}` : "at"}${copy.deviceName && copy.path ? " at" : ""}${copy.path ? ` ${copy.path}` : ""})`;
  return html`
    <section id=${panelId} class="search-provenance" aria-label="Related information">
      <ul class="search-provenance-facts">
        ${physicalLocation && html`<li class="search-provenance-current-location">This document is ${current.deviceName ? `on ${current.deviceName}` : "stored"}${current.path ? ` at ${current.path}` : ""}.</li>`}
        ${copies.length > 0 && html`
          <li class="search-provenance-copies">The same text appears in ${provenance.stopReasons?.includes("copies") ? "at least " : ""}${copies.length} other ${copies.length === 1 ? "document" : "documents"}: ${copies.slice(0, COPY_REFERENCE_LIMIT).map((copy, index) => html`${index ? ", " : ""}<${GraphDocumentLink} document=${byId.get(copy.documentId)} />${copyLocation(copy)}`)}${copies.length > COPY_REFERENCE_LIMIT ? `, and ${copies.length - COPY_REFERENCE_LIMIT} more` : ""}.</li>
        `}
        ${nestProvenanceLines(lines).map(renderLine)}
      </ul>
    </section>
  `;
}

/** Icon and title share one portal link; the icon stays vertically centered. */
function GraphDocumentLink({ document }) {
  return html`<a class="search-graph-document" href=${docHref(document)} title=${sourceLabel(document.sourceId)}><span class="search-graph-document-icon" aria-hidden="true">${sourceIcon(document.sourceId, { size: 14 })}</span><span class="search-graph-document-title">${document.title || "Untitled document"}</span></a>`;
}
