// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The authorization requests waiting on the owner, at the top of the Access
// page: a client that has asked to connect and not yet been answered is the
// one thing on the page with a clock on it, so it comes before the inventory.
// Each entry opens the request's own review page, where the owner configures
// the connection before approving it, or denies it.

import { html } from "htm/preact";

import { WaitingStrip } from "../../components/waiting-strip.js";
import { navigate } from "../../lib/router.js";
import { expiresInLabel, useExpiryClock } from "./shared.js";

function authorizationReviewPath(id) {
  return `/portal/settings/access/authorizations/${encodeURIComponent(id)}`;
}

/**
 * @param {object} props
 * @param {Array<{ id: string, clientName: string, expiresAt: number }>} props.requests
 *   the overview's pending requests, newest first as the gateway lists them.
 */
export function PendingRequests({ requests }) {
  // The remaining time is what the owner acts on, and it runs out in minutes.
  const now = useExpiryClock();

  // A request that lapsed since the overview answered is no longer waiting on
  // anyone; the next refresh drops it and the strip does not offer it meanwhile.
  const waiting = requests.filter((request) => request.expiresAt > now);
  if (waiting.length === 0) return null;

  return html`<${WaitingStrip}
    titleId="access-pending-title"
    title=${waiting.length === 1 ? "1 access request waiting" : `${waiting.length} access requests waiting`}
    items=${waiting.map((request) => ({
      key: request.id,
      text: html`<strong>${request.clientName}</strong> wants to connect`,
      meta: expiresInLabel(request.expiresAt, now),
      actionLabel: "Configure & Approve",
      onAction: () => navigate(authorizationReviewPath(request.id)),
    }))}
  />`;
}
