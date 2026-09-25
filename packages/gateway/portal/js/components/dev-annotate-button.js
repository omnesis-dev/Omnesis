// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// A small inline ⚑ trigger that files a developer annotation against an
// EXPLICIT entity — used on the cognition debug page, where a dense list of
// briefs / runs / loops / temporal annotations / memory rows is under review and
// the operator wants to flag a specific one. Renders only in developer mode;
// opens the same shared composer the floating FAB uses, via
// `openDevAnnotation(target)`. `target` is `{ targetType, targetId?, label?,
// deepLink? }` and may be a value or a thunk returning one.

import { html } from "htm/preact";
import { openDevAnnotation } from "../lib/dev-annotate.js";

export function DevAnnotateButton({ target, developer = false, title = "File a developer annotation" }) {
  if (!developer) return null;

  return html`
    <button
      class="dev-annotate-inline"
      type="button"
      title=${title}
      aria-label=${title}
      onClick=${(e) => {
        e.preventDefault();
        e.stopPropagation();
        openDevAnnotation(typeof target === "function" ? target() : target);
      }}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 2v12" />
        <path d="M4 2.5h7.5l-1.5 3 1.5 3H4" />
      </svg>
    </button>
  `;
}
