// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Floating developer-annotation capture button. Shown only when the gateway
// reports developer mode (`OMNESIS_DEV_MODE`) on `GET /status`; a normal
// install never renders it. It is the operator → engineer data-quality
// feedback channel: one affordance on every screen that opens the shared
// composer targeting whatever entity the current route addresses (falling back
// to a free-form note tagged with the route). Notes are read back with
// `omnesis dev-annotations`, not by the Omnesis agent.

import { html } from "htm/preact";
import { deriveDevTarget } from "../lib/dev-target.js";
import { openDevAnnotation } from "../lib/dev-annotate.js";

export function DevAnnotationButton({ route, developer = false, activeConvoId = null }) {
  if (!developer) return null;

  return html`
    <button
      class="dev-annotation-fab"
      title="File a developer annotation on this view"
      aria-label="File a developer annotation"
      onClick=${() =>
        openDevAnnotation(deriveDevTarget(route, window.location.pathname, activeConvoId))}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 2v12" />
        <path d="M4 2.5h7.5l-1.5 3 1.5 3H4" />
      </svg>
    </button>
  `;
}
