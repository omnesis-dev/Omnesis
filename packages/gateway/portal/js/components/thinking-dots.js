// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";

/** Decorative progress dots; the surrounding text names the active work. */
export function ThinkingDots() {
  return html`<span class="agent-typing privacy-progress-dots" aria-hidden="true"><span></span><span></span><span></span></span>`;
}
