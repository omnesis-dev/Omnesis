// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a route shows while it is still reading.
 *
 * A line of grey text on a dark page is indistinguishable from a page that has
 * given up — the reader has no way to tell "still working" from "nothing came
 * back", and a slow read looks like a broken one. A moving thing says the
 * difference without a word, so every route that waits on the gateway shows
 * this rather than a sentence.
 *
 * The label is still written out beside it: the spinner says something is
 * happening, the label says what.
 */

import { html } from "htm/preact";

export function Loading({ label = "Loading…" }) {
  return html`<p class="privacy-loading" role="status">
    <span class="spinner" aria-hidden="true"></span>${label}
  </p>`;
}
