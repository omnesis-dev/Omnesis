// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Shared shell for the Sources-page install promos (browser extension, iOS
// app, Android app). The card itself stays compact — a product mark, a
// title, a one-line tagline and a "Learn more" button — so the row
// reads as a quiet suggestion above the sources table. The button opens a
// modal that carries the full explanation and every link the install
// needs; each promo supplies that modal body as `children`.

import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { Modal } from "./modal.js";

/**
 * @param {object} props
 * @param {string} props.className   promo-specific class on the card (e.g. "ios-promo").
 * @param {string} props.label       accessible name of the card.
 * @param {string} props.logoUrl     same-origin product mark.
 * @param {string} [props.logoClass] extra class on the mark (e.g. theme inversion).
 * @param {string} props.title       card and modal title.
 * @param {string} props.tagline     one line under the title.
 * @param {*} props.children         the modal body.
 */
export function PromoCard({ className, label, logoUrl, logoClass = "", title, tagline, children }) {
  const [open, setOpen] = useState(false);
  return html`
    <section class="ext-promo ${className}" aria-label=${label}>
      <img
        class="ext-promo-logo ${logoClass}"
        src=${logoUrl}
        alt=""
        height="32"
        referrerpolicy="no-referrer"
      />
      <div class="ext-promo-body">
        <strong class="ext-promo-title">${title}</strong>
        <p class="ext-promo-text">${tagline}</p>
      </div>
      <button type="button" class="ext-promo-open" onClick=${() => setOpen(true)}>Learn more</button>
      <${Modal} open=${open} onClose=${() => setOpen(false)} title=${title} size="sm">
        <div class="promo-modal">${children}</div>
      </${Modal}>
    </section>
  `;
}
