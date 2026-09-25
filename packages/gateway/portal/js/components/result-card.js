// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { navigate } from "../lib/router.js";
import { timeAgo, formatScore, sourceIcon, sourceLabel, docTypeLabel, docHref, isExternalDocHref } from "../lib/format.js";
import { FileTypeIcon, fileTypeKind, fileTypeLabel } from "../lib/file-type-icons.js";
import { ScoreDetails } from "./score-details.js";
import { PeopleBubbles } from "./people-bubbles.js";

// Document types that represent a concrete file blob (vs. an email,
// conversation, event, …). For these we replace the generic
// "Attachment" / "File" doc-type label with a colored file-type icon
// + format pill ("PDF", "XLSX", …) so a list of mixed attachments is
// scannable at a glance.
const FILE_LIKE_DOC_TYPES = new Set(["attachment", "file"]);

export function ResultCard({ result, verbose, onClick, peopleSummary }) {
  const docType = result.documentType || "";
  const snippet = result.chunkText || "";
  const truncatedSnippet = snippet.length > 300 ? snippet.slice(0, 300) + "..." : snippet;

  // File-like docs get a colored file-type icon + format pill. Prefer
  // the server-provided mimeType (hydrated onto search results from the
  // document metadata) and fall back to the filename extension for
  // sources that publish no mimeType.
  const fileLike = FILE_LIKE_DOC_TYPES.has(docType);
  const fileKind = fileLike
    ? fileTypeKind({ mimeType: result.mimeType, filename: result.title })
    : null;

  const href = docHref(result);
  const external = isExternalDocHref(result);

  // Anchor-based navigation: the result card's role is "link", not
  // "button" — wrapping it in a real `<a>` restores keyboard focus +
  // Cmd-click + screen-reader semantics for free. For external source
  // URLs (Gmail web view, Drive file, Notion page, …) we open in a new
  // tab so the user can flip back to their search; for sources without
  // an external URL we fall back to the in-app doc viewer via SPA
  // navigation.
  function handleClick(e) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    if (external) {
      // Let the browser handle the link (target="_blank" below).
      if (onClick) onClick();
      return;
    }
    e.preventDefault();
    if (onClick) onClick();
    navigate(href);
  }

  return html`
    <a class="result-card" data-type=${docType} href=${href}
       target=${external ? "_blank" : undefined} rel=${external ? "noopener" : undefined}
       onClick=${handleClick}>
      <div class="result-title">${result.title || "Untitled"}</div>
      <div class="result-meta">
        <span>${sourceIcon(result.sourceId)} ${sourceLabel(result.sourceId)}</span>
        ${docType && html`
          ${fileLike && fileKind
            ? html`<span class="file-type-pill"><${FileTypeIcon} mimeType=${result.mimeType} filename=${result.title} size=${14} /> ${fileTypeLabel({ mimeType: result.mimeType, filename: result.title })}</span>`
            : html`<span>${docTypeLabel(docType)}</span>`
          }
        `}
        ${result.author && html`<span>${result.author}</span>`}
        <span>${timeAgo(result.sourceCreatedAt)}</span>
        <span class="result-score">${formatScore(result.score)}</span>
        ${result.refCount > 0 && html`<span class="ref-badge">${result.refCount} refs</span>`}
        ${peopleSummary && peopleSummary.people?.length > 0 && html`
          <${PeopleBubbles} people=${peopleSummary.people} totalCount=${peopleSummary.total} maxVisible=${4} />
        `}
      </div>
      <div class="result-snippet">${truncatedSnippet}</div>
      ${verbose && result.scoreBreakdown && html`<${ScoreDetails} breakdown=${result.scoreBreakdown} />`}
    </a>
  `;
}
