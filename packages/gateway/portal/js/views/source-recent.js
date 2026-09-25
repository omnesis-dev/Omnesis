// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Recent items for a single source — portal equivalent of
// `npm run cli -- recent <sourceId>`. Reachable from the clock icon on
// /portal/sources. For document sources, shows the N newest documents and
// clicks through to the existing viewer. For pure-structured sources the
// server transparently falls back to the best-matching analytics table
// and we render it with the shared DataTable.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { navigate } from "../lib/router.js";
import { getSourceRecent, getDocumentsPeopleBulk, deleteDocument } from "../api.js";
import { deleteConfirmCopy } from "../lib/document-delete.js";
import { NOTES_SOURCE_ID, manageNotesHref, notesDayForDocument } from "../lib/notes.js";
import { sourceIcon, sourceLabel, timeAgo, docTypeLabel } from "../lib/format.js";
import { DataTable } from "../components/data-table.js";
import { PeopleBubbles } from "../components/people-bubbles.js";
import { ConfirmModal } from "../components/confirm-modal.js";
import { LoadMore } from "../components/load-more.js";
import { useCursorPage } from "../lib/use-cursor-page.js";

const DEFAULT_LIMIT = 25;

function pageMeta(payload) {
  if (!payload) return null;
  const { documents: _documents, rows: _rows, ...meta } = payload;
  return meta;
}

export function completePeopleEnrichment(documentIds, bulk) {
  return Object.fromEntries(
    documentIds.map((id) => [id, bulk?.docs?.[id] ?? []]),
  );
}

export function SourceRecentView({ sourceId }) {
  const [peopleByDoc, setPeopleByDoc] = useState({});
  // Doc pending a privacy delete (drives the confirm modal); null = none.
  const [confirmDoc, setConfirmDoc] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const page = useCursorPage({
    resetKey: sourceId,
    pageSize: DEFAULT_LIMIT,
    loadPage: ({ limit, cursor }) => getSourceRecent(sourceId, limit, cursor),
    selectItems: (payload) =>
      payload?.kind === "documents"
        ? payload.documents ?? []
        : payload?.kind === "analytics"
          ? payload.rows ?? []
          : [],
    selectMeta: pageMeta,
    mergeMeta: (previous, next) => ({ ...(previous ?? {}), ...(next ?? {}) }),
    // Analytics rows include their declared primary-key columns, so the full
    // wire row is a stable identity even for tables with composite keys.
    itemKey: (item) => item?.id ?? JSON.stringify(item),
  });
  const data =
    page.meta?.kind === "documents"
      ? { ...page.meta, documents: page.items }
      : page.meta?.kind === "analytics"
        ? { ...page.meta, rows: page.items }
        : page.meta;

  useEffect(() => {
    setPeopleByDoc({});
  }, [sourceId]);

  useEffect(() => {
    if (data?.kind !== "documents" || page.items.length === 0) return;
    const missing = page.items
      .map((doc) => doc.id)
      .filter((id) => !Object.prototype.hasOwnProperty.call(peopleByDoc, id));
    if (missing.length === 0) return;
    let cancelled = false;
    getDocumentsPeopleBulk(missing)
      .then((bulk) => {
        if (cancelled) return;
        // Mark every requested id as attempted, including rows that vanished
        // between the recent-page read and this enrichment request. Otherwise
        // a missing response key would retrigger this effect indefinitely.
        const resolved = completePeopleEnrichment(missing, bulk);
        setPeopleByDoc((previous) => ({ ...previous, ...resolved }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [data?.kind, page.items, peopleByDoc]);

  function goBack(e) {
    e.preventDefault();
    if (history.length > 1) history.back();
    else navigate("/portal/sources");
  }

  function openInSql() {
    if (!data || data.kind !== "analytics") return;
    const sql = `SELECT * FROM ${data.table} ORDER BY 1 DESC LIMIT 100`;
    const params = new URLSearchParams({ store: "duckdb", sql });
    navigate(`/portal/debug/sql?${params}`);
  }

  // Generated Notes day documents are read-only: no delete offer, a
  // Manage-notes link per row instead. Everything else keeps the
  // copy/for-good choice. The link is Notes-specific, so it keys on the
  // source id rather than the generic `internal` flag.
  const isNotesSource = sourceId === NOTES_SOURCE_ID;
  const deleteCopy = deleteConfirmCopy({ deleting });

  async function confirmDelete(keepCopy) {
    if (!confirmDoc) return;
    const target = confirmDoc;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteDocument(target.id, { keepCopy });
      setConfirmDoc(null);
      page.setItems((items) => items.filter((doc) => doc.id !== target.id));
    } catch (err) {
      const reqId = err?.requestId ? ` [id=${String(err.requestId).slice(0, 8)}]` : "";
      setDeleteError(`${err.message}${reqId}`);
      setConfirmDoc(null);
    } finally {
      setDeleting(false);
    }
  }

  return html`
    <div class="source-recent-view">
      <a class="doc-back" href="/portal/sources" onClick=${goBack}>\u2190 Sources</a>
      <div class="source-recent-header">
        <span class="source-icon-wrap">${sourceIcon(sourceId)}</span>
        <div>
          <h1 class="source-recent-title">${sourceLabel(sourceId)}</h1>
          <div class="source-recent-subtitle">
            Recent items · <code>${sourceId}</code>
          </div>
        </div>
      </div>

      ${page.loading && html`<div class="loading"><span class="spinner"></span> Loading recent items…</div>`}
      ${page.error && html`<div class="sources-banner-v2 error">${page.error.message ?? String(page.error)}</div>`}
      ${deleteError && html`<div class="sources-banner-v2 error">${deleteError}</div>`}

      ${!page.loading && !page.error && data && data.kind === "documents" && html`
        <${DocumentList}
          documents=${data.documents}
          peopleByDoc=${peopleByDoc}
          onRequestDelete=${isNotesSource ? undefined : setConfirmDoc}
          manageDayForDoc=${isNotesSource ? notesDayForDocument : undefined}
        />
      `}

      ${!page.loading && !page.error && data && data.kind === "analytics" && html`
        <section class="source-recent-section">
          <div class="source-recent-section-header">
            <div>
              <h2>Recent rows <span class="muted">(from <code>${data.table}</code>)</span></h2>
              <p class="muted">No documents for this source. Showing the newest rows from the analytics table it writes to.</p>
            </div>
            <button class="btn-primary" onClick=${openInSql}>Open in SQL</button>
          </div>
          <${DataTable} columns=${data.columns} rows=${data.rows} columnDefs=${data.columnDefs} />
        </section>
      `}

      ${!page.loading && !page.error && data && data.kind === "empty" && html`
        <div class="empty-state">
          <h2>Nothing yet</h2>
          <p class="muted">
            ${data?.internal === true
              ? html`Nothing here yet — new items will appear as they are captured.`
              : html`This source hasn\u2019t produced any documents or rows. Trigger a sync from <a href="/portal/sources" onClick=${(e) => { e.preventDefault(); navigate("/portal/sources"); }}>Sources</a> or check the collector\u2019s logs.`}
          </p>
        </div>
      `}

      ${!page.loading && !page.error && data?.kind !== "empty" && html`
        <${LoadMore}
          hasMore=${page.hasMore}
          loading=${page.loadingMore}
          error=${page.loadMoreError}
          onLoadMore=${page.loadMore}
          label=${data?.kind === "analytics" ? "Load more rows" : "Load more documents"}
        />
      `}

      ${!isNotesSource && html`<${ConfirmModal}
        open=${!!confirmDoc}
        title=${`Delete \u201c${confirmDoc?.title || "(untitled)"}\u201d?`}
        body=${deleteCopy.body}
        confirmLabel=${deleteCopy.confirmLabel}
        destructive
        confirmDisabled=${deleting}
        cancelDisabled=${deleting}
        secondaryLabel=${deleteCopy.secondaryLabel}
        secondaryDestructive
        onConfirm=${() => confirmDelete(false)}
        onSecondary=${deleteCopy.secondaryLabel ? () => confirmDelete(true) : undefined}
        onCancel=${() => setConfirmDoc(null)}
      />`}
    </div>
  `;
}

export function DocumentList({ documents, peopleByDoc, onRequestDelete, manageDayForDoc }) {
  if (!documents || documents.length === 0) {
    return html`<div class="empty-state"><p class="muted">No recent documents.</p></div>`;
  }
  return html`
    <ul class="source-recent-list">
      ${documents.map((doc) => {
        const summary = peopleByDoc?.[doc.id];
        // Generated Notes day documents are read-only: a Manage-notes
        // link to that day instead of a delete button. A null day on a
        // Notes row renders no action (never a dead delete button whose
        // handler is absent); other sources keep the delete affordance.
        const manageDay = typeof manageDayForDoc === "function" ? manageDayForDoc(doc) : null;
        const manageHref = manageDay ? manageNotesHref(manageDay) : null;
        return html`
          <li
            key=${doc.id}
            class="source-recent-item"
            onClick=${() => navigate("/portal/doc/" + encodeURIComponent(doc.id))}
          >
            <div class="source-recent-item-main">
              <span class="source-recent-item-title">${doc.title || "(untitled)"}</span>
              ${doc.contentPreview && html`<span class="source-recent-item-preview">${doc.contentPreview}</span>`}
            </div>
            <div class="source-recent-item-meta">
              ${summary && summary.people?.length > 0 && html`
                <${PeopleBubbles}
                  people=${summary.people}
                  totalCount=${summary.total}
                  maxVisible=${4}
                  parentBg="var(--bg-primary)"
                />
              `}
              ${doc.documentType && html`<span class="source-recent-item-type">${docTypeLabel(doc.documentType)}</span>`}
              ${doc.deviceId && html`
                <span class="source-recent-item-device" title=${doc.deviceId}>${doc.deviceName || doc.deviceId}</span>
              `}
              <span class="source-recent-item-time">${timeAgo(doc.sourceCreatedAt)}</span>
              ${manageHref
                ? html`<a
                    class="source-recent-item-manage"
                    href=${manageHref}
                    title="Manage this day's original notes on Tell Omnesis"
                    onClick=${(e) => { e.stopPropagation(); e.preventDefault(); navigate(manageHref); }}
                  >Manage notes</a>`
                : (typeof manageDayForDoc !== "function"
                  ? html`<button
                class="source-recent-item-delete"
                title="Delete this document from the corpus"
                aria-label="Delete document"
                onClick=${(e) => { e.stopPropagation(); e.preventDefault(); onRequestDelete?.(doc); }}
              >
                <svg aria-hidden="true" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M2.5 4h11"/>
                  <path d="M5.5 4V2.5A1 1 0 0 1 6.5 1.5h3a1 1 0 0 1 1 1V4"/>
                  <path d="M4 4l.7 9a1.5 1.5 0 0 0 1.5-1.4h3.6a1.5 1.5 0 0 0 1.5-1.4L13 4"/>
                  <path d="M6.5 7v4.5M9.5 7v4.5"/>
                </svg>
              </button>`
                  : null)}
            </div>
          </li>
        `;
      })}
    </ul>
  `;
}
