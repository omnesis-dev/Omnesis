// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The head of a page opened from the Access list — an access level being
// created or edited, a connection being approved — and the way back from it.

import { html } from "htm/preact";

/** The way back from a detail page: to the Access list, or to the page named by `to`. */
export function BackButton({ to = "access", disabled = false, onClick }) {
  return html`<button type="button" class="doc-back access-page-back" disabled=${disabled} onClick=${onClick}>
    ← Back to ${to}
  </button>`;
}

/**
 * The way back, what kind of page this is (`eyebrow`) and its title, which
 * takes focus through `headingRef` when the page opens. `children` follow the
 * title inside the header.
 */
export function PageHeader({
  eyebrow,
  title,
  titleId,
  busy,
  onClose,
  headingRef,
  backTo = "access",
  children = null,
}) {
  return html`<header class="access-page-header">
    <${BackButton} to=${backTo} disabled=${busy} onClick=${onClose} />
    <div>
      <span class="access-eyebrow">${eyebrow}</span>
      <h2 id=${titleId} ref=${headingRef} tabindex="-1">${title}</h2>
    </div>
    ${children}
  </header>`;
}
