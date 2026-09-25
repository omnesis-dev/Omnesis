// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useState, useEffect } from "preact/hooks";
import {
  getDocument,
  getDocumentInboundRefs,
  getDocumentOutboundRefs,
  getDocumentPeople,
  getDocumentAttachments,
  getDocumentNearDupes,
  getDocumentDates,
  getDocumentAnnotations,
  deleteDocument,
} from "../api.js";
import { deleteConfirmCopy } from "../lib/document-delete.js";
import { NOTES_SOURCE_ID, manageNotesHref, notesDayForDocument } from "../lib/notes.js";
import { renderMarkdown } from "../lib/markdown.js";
import { sourceIcon, sourceLabel, timeAgo, isOpenableExternalUrl } from "../lib/format.js";
import { FileTypeIcon, fileTypeKind, fileTypeLabel } from "../lib/file-type-icons.js";
import { MetadataPanel } from "../components/metadata-panel.js";
import { GraphTimelinePanel } from "../components/graph-card.js";
import { ConfirmModal } from "../components/confirm-modal.js";
import { navigate } from "../lib/router.js";
import { useCursorPage } from "../lib/use-cursor-page.js";

const FILE_LIKE_DOC_TYPES = new Set(["attachment", "file"]);

function CopyButton({ value, label }) {
  const [copied, setCopied] = useState(false);
  const onClick = async (e) => {
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* no-op */ }
  };
  return html`
    <button
      class=${`doc-toolbar-btn ${copied ? "doc-toolbar-btn-copied" : ""}`}
      onClick=${onClick}
      title=${`Copy ${label}`}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="5" y="5" width="9" height="9" rx="1.5"/>
        <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/>
      </svg>
      ${copied ? "Copied" : `Copy ${label}`}
    </button>
  `;
}

function OpenInSourceButton({ url }) {
  return html`
    <a class="doc-toolbar-btn" href=${url} target="_blank" rel="noopener" title="Open in source">
      <svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 2h5v5"/>
        <path d="M14 2L7 9"/>
        <path d="M12 9.5V13a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 2 13V6a1.5 1.5 0 0 1 1.5-1.5H7"/>
      </svg>
      Open in source
    </a>
  `;
}

function DeleteButton({ onClick, busy }) {
  return html`
    <button class="doc-toolbar-btn danger" onClick=${onClick} disabled=${busy} title="Delete this document from the corpus">
      <svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2.5 4h11"/>
        <path d="M5.5 4V2.5A1 1 0 0 1 6.5 1.5h3a1 1 0 0 1 1 1V4"/>
        <path d="M4 4l.7 9a1.5 1.5 0 0 0 1.5 1.4h3.6a1.5 1.5 0 0 0 1.5-1.4L13 4"/>
        <path d="M6.5 7v4.5M9.5 7v4.5"/>
      </svg>
      ${busy ? "Deleting…" : "Delete"}
    </button>
  `;
}

export function DocumentView({ id, experimental = false }) {
  const [doc, setDoc] = useState(null);
  const [resolvedPeople, setResolvedPeople] = useState(null);
  const [attachmentChildren, setAttachmentChildren] = useState([]);
  const [extractedDates, setExtractedDates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const inboundPage = useCursorPage({
    resetKey: `document-inbound:${id}`,
    pageSize: 25,
    loadPage: ({ limit, cursor }) => getDocumentInboundRefs(id, { limit, cursor }),
    itemKey: (ref) => `${ref.sourceDocId}:${ref.linkType ?? ""}:${ref.rawTarget ?? ""}`,
  });
  const outboundPage = useCursorPage({
    resetKey: `document-outbound:${id}`,
    pageSize: 25,
    loadPage: ({ limit, cursor }) => getDocumentOutboundRefs(id, { limit, cursor }),
    itemKey: (ref) =>
      `${ref.targetDocId ?? ""}:${ref.linkType ?? ""}:${ref.rawTarget ?? ""}`,
  });
  const nearDupPage = useCursorPage({
    resetKey: `document-near-dupes:${id}`,
    pageSize: 20,
    loadPage: ({ limit, cursor }) => getDocumentNearDupes(id, { limit, cursor }),
    selectItems: (payload) => payload.edges ?? [],
    selectCursor: (payload) => payload.nextCursor ?? null,
    itemKey: (edge) => edge.otherDocId,
  });
  const annotationPage = useCursorPage({
    resetKey: `document-annotations:${id}`,
    pageSize: 20,
    loadPage: ({ limit, cursor }) =>
      getDocumentAnnotations(id, { limit, cursor, includeDependents: false }),
    selectItems: (payload) => payload.annotations ?? [],
  });

  useEffect(() => {
    setLoading(true);
    setError(null);

    Promise.all([
      getDocument(id),
      getDocumentPeople(id),
      getDocumentAttachments(id),
      // Omnesis-enriched extracted dates remain experimental;
      // skip the requests entirely when experimental mode is off.
      experimental ? getDocumentDates(id) : Promise.resolve({ dates: [] }),
    ])
      .then(([docData, peopleData, attData, datesData]) => {
        setDoc(docData);
        setResolvedPeople(peopleData?.people ?? []);
        setAttachmentChildren(attData?.attachments ?? []);
        setExtractedDates(datesData?.dates ?? []);
      })
      .catch((err) => {
        const reqId = err?.requestId ? ` [id=${String(err.requestId).slice(0, 8)}]` : "";
        setError(`${err.message}${reqId}`);
      })
      .finally(() => setLoading(false));
  }, [id, experimental]);

  if (loading) return html`<div class="loading"><span class="spinner"></span> Loading document...</div>`;
  if (error) return html`<div class="empty-state"><h2>Error</h2><p>${error}</p></div>`;
  if (!doc) return html`<div class="empty-state"><h2>Document not found</h2></div>`;

  let meta = doc.metadata;
  if (typeof meta === "string") {
    try { meta = JSON.parse(meta); } catch { meta = {}; }
  }
  meta = meta || {};

  const contentHtml = renderMarkdown(doc.content || "");

  function goBack(e) {
    e.preventDefault();
    if (history.length > 1) {
      history.back();
    } else {
      navigate("/portal/");
    }
  }

  // Generated Notes day documents are read-only: no delete offer, a
  // Manage-notes link to that day instead. Everything else keeps the
  // copy/for-good choice. The link is Notes-specific, so it keys on the
  // source id rather than the generic `internal` flag — a future
  // internal sibling keeps no action (the gateway refuses its deletion
  // as a backstop) instead of a link to the wrong surface.
  const isInternal = doc?.internal === true;
  const isNotesDoc = doc?.source_id === NOTES_SOURCE_ID;
  const manageDay = isNotesDoc ? notesDayForDocument(doc) : null;
  const manageHref = isNotesDoc ? manageNotesHref(manageDay) : null;
  const deleteCopy = deleteConfirmCopy({ deleting });

  async function confirmDelete(keepCopy) {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteDocument(doc.id, { keepCopy });
      setShowDelete(false);
      // The doc no longer exists, so don't `history.back()` into it \u2014 land
      // on the source's recent list (where most deletes originate).
      navigate(`/portal/sources/${encodeURIComponent(doc.source_id)}/recent`);
    } catch (err) {
      const reqId = err?.requestId ? ` [id=${String(err.requestId).slice(0, 8)}]` : "";
      setDeleteError(`${err.message}${reqId}`);
      setShowDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  return html`
    <div>
      <div class="doc-toolbar">
        <a class="doc-back" href="/portal/" onClick=${goBack}>\u2190 Back</a>
        <div class="doc-toolbar-actions">
          ${isOpenableExternalUrl(meta.sourceUrl) && html`<${OpenInSourceButton} url=${meta.sourceUrl} />`}
          <${CopyButton} value=${doc.id} label="ID" />
          ${manageHref
            ? html`<a
                class="doc-toolbar-btn"
                href=${manageHref}
                title="Manage this day's original notes on Tell Omnesis"
                onClick=${(e) => { e.preventDefault(); navigate(manageHref); }}
              >Manage notes</a>`
            : (!isInternal
              ? html`<${DeleteButton} onClick=${() => setShowDelete(true)} busy=${deleting} />`
              : null)}
        </div>
      </div>
      ${deleteError && html`<div class="source-row-error" style="margin-bottom:12px;"><code>${deleteError}</code></div>`}
      <h1 class="doc-title">${doc.title || "Untitled"}</h1>
      <div class="doc-source-badge">
        <span class="doc-source-pill">
          ${sourceIcon(doc.source_id)}
          <span>${sourceLabel(doc.source_id)}</span>
        </span>
        ${meta.documentType && html`
          <span class="doc-source-sep">·</span>
          ${FILE_LIKE_DOC_TYPES.has(meta.documentType) && fileTypeKind({ mimeType: meta.extra?.mimeType, filename: doc.title })
            ? html`<span class="file-type-pill">
                <${FileTypeIcon} mimeType=${meta.extra?.mimeType} filename=${doc.title} size=${14} />
                ${fileTypeLabel({ mimeType: meta.extra?.mimeType, filename: doc.title })}
              </span>`
            : html`<span>${meta.documentType}</span>`
          }
        `}
        ${doc.source_created_at && html`
          <span class="doc-source-sep">·</span>
          <span>${timeAgo(doc.source_created_at)}</span>
        `}
      </div>
      <div class="doc-layout">
        <div class="doc-content" dangerouslySetInnerHTML=${{ __html: contentHtml }}></div>
        <div class="doc-side-rail">
          <${MetadataPanel}
            document=${doc}
            extractedDates=${extractedDates}
            annotations=${annotationPage.items}
            annotationPage=${annotationPage}
          />
          <${GraphTimelinePanel}
            key=${id}
            refs=${{
              inbound: inboundPage.items,
              outbound: outboundPage.items,
            }}
            resolvedPeople=${resolvedPeople}
            attachmentInfos=${meta.extra?.attachments}
            attachmentChildren=${attachmentChildren}
            nearDupes=${nearDupPage.items}
            documentId=${id}
            inboundPage=${inboundPage}
            outboundPage=${outboundPage}
            nearDupPage=${nearDupPage}
          />
        </div>
      </div>
      ${!manageHref && html`<${ConfirmModal}
        open=${showDelete}
        title="Delete this document?"
        body=${deleteCopy.body}
        confirmLabel=${deleteCopy.confirmLabel}
        destructive
        confirmDisabled=${deleting}
        cancelDisabled=${deleting}
        secondaryLabel=${deleteCopy.secondaryLabel}
        secondaryDestructive
        onConfirm=${() => confirmDelete(false)}
        onSecondary=${deleteCopy.secondaryLabel ? () => confirmDelete(true) : undefined}
        onCancel=${() => setShowDelete(false)}
      />`}
    </div>
  `;
}
