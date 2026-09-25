// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The authorization requests waiting on the owner, at the top of the Access
// page: a client that has asked to connect and not yet been answered is the
// one thing on the page with a clock on it, so it comes before the inventory.
// Each entry opens the request's own review page, where the owner configures
// the connection before approving it, or denies it.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";

import { navigate } from "../../lib/router.js";
import { expiresInLabel } from "./shared.js";

function authorizationReviewPath(id) {
  return `/portal/settings/access/authorizations/${encodeURIComponent(id)}`;
}

/**
 * @param {object} props
 * @param {Array<{ id: string, clientName: string, expiresAt: number }>} props.requests
 *   the overview's pending requests, newest first as the gateway lists them.
 */
export function PendingRequests({ requests }) {
  // The remaining time is what the owner acts on, and it runs out in minutes;
  // half a minute is fine-grained enough for a label counted in whole minutes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);

  // A request that lapsed since the overview answered is no longer waiting on
  // anyone; the next refresh drops it and the strip does not offer it meanwhile.
  const waiting = requests.filter((request) => request.expiresAt > now);
  if (waiting.length === 0) return null;

  return html`<section class="access-pending" aria-labelledby="access-pending-title">
    <h3 id="access-pending-title">
      ${waiting.length === 1 ? "1 access request waiting" : `${waiting.length} access requests waiting`}
    </h3>
    <ul class="access-pending-list">
      ${waiting.map((request) => html`<li key=${request.id} class="access-pending-item">
        <span class="access-pending-client"><strong>${request.clientName}</strong> wants to connect</span>
        <span class="access-pending-expiry">${expiresInLabel(request.expiresAt, now)}</span>
        <button
          type="button"
          class="btn-primary access-pending-review"
          onClick=${() => navigate(authorizationReviewPath(request.id))}
        >Configure & Approve</button>
      </li>`)}
    </ul>
  </section>`;
}
