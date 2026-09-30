// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";

/** Optional labels belong to the isolated gateway, rather than browser storage. */
export function TestInstanceCard({ instance }) {
  if (!instance || typeof instance !== "object" || Array.isArray(instance)) return null;
  const session = typeof instance.session === "string" ? instance.session.trim() : "";
  const purpose = typeof instance.purpose === "string" ? instance.purpose.trim() : "";
  return html`
    <section class="sidebar-test-instance" aria-label="Test gateway">
      <strong>Test gateway</strong>
      ${session ? html`<div><span class="sidebar-test-label">Session</span><span>${session}</span></div>` : null}
      ${purpose ? html`<div><span class="sidebar-test-label">Purpose</span><span>${purpose}</span></div>` : null}
    </section>
  `;
}
