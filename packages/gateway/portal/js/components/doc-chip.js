// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A document, small, as a link to it.
 *
 * Wherever the portal names a document it came to through something else — a
 * researcher's reading list, the evidence behind a watch firing — it is the
 * same fact and reads the same way: the source's icon, the title, and a link
 * that lands on the document. Modifier and middle clicks fall through to the
 * browser's open-in-new-tab.
 *
 * The icon and the accent come from the source registry via `sourceId`, so a
 * new source is styled here without this file learning its name; an unknown
 * one gets a neutral border.
 */

import { html } from "htm/preact";
import { sourceTypeOf } from "../lib/source-id.js";

import { sourceIcon, sourceLabel } from "../lib/format.js";
import { navigate } from "../lib/router.js";

export function DocChip({ documentId, title, sourceId, className = "" }) {
  const href = `/portal/doc/${encodeURIComponent(documentId)}`;
  function onClick(e) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    navigate(href);
  }
  return html`
    <a
      class=${`doc-chip ${className}`.trim()}
      data-source=${sourceTypeOf(sourceId)}
      href=${href}
      onClick=${onClick}
      title=${`${title || "Untitled"} · ${sourceLabel(sourceId)}`}
    >
      <span class="doc-chip-icon">${sourceIcon(sourceId, { size: 13 })}</span>
      <span class="doc-chip-title">${title || "Untitled"}</span>
    </a>
  `;
}
