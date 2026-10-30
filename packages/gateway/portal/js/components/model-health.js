// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { navigate } from "../lib/router.js";

/** Shared navigation marker; diagnostic details belong on Models. */
export function WarningTriangle({ label }) {
  return html`<span class="warning-triangle" role="img" aria-label=${label} title=${label}>
    <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">
      <path d="M10 2 19 18H1Z"/><path d="M10 7v5"/><circle cx="10" cy="15" r=".8" fill="currentColor" stroke="none"/>
    </svg>
  </span>`;
}

export function ModelHealthWarnings({ overview, role = null }) {
  const capabilities = overview.capabilities ?? [];
  const warnings = (overview.inference?.health?.warnings ?? [])
    .filter((warning) => (!role || warning.role === role)
      && capabilities.some((capability) => capability.role === warning.role));
  if (!warnings.length) return null;

  return html`<section class="model-health-warnings" aria-label="Model problems">
    ${warnings.map((warning) => {
      const capability = capabilities.find((cap) => cap.role === warning.role);
      const display = overview.assignmentDisplays?.[warning.role];
      return html`<article key=${warning.role} class="model-health-warning" role="status">
        <${WarningTriangle} label="Repeated model failures" />
        <div class="model-health-warning-content">
          <h3>${capability.title}: repeated model failures</h3>
          <p>${display?.modelName ? [display.providerLabel, display.modelName].filter(Boolean).join(" · ") : warning.assignment}</p>
          <p>${warning.message}</p>
          <p class="model-health-warning-meta">At least ${warning.consecutiveFailures} consecutive failed requests.
            Last failure: <time datetime=${new Date(warning.lastFailedAt).toISOString()}>${new Date(warning.lastFailedAt).toLocaleString()}</time>.
            This warning clears after a successful request.</p>
          ${!role && html`<a href=${`/portal/settings/models/${warning.role}`}
            onClick=${(event) => { event.preventDefault(); navigate(`/portal/settings/models/${warning.role}`); }}
          >Review ${capability.title} settings →</a>`}
        </div>
      </article>`;
    })}
  </section>`;
}
