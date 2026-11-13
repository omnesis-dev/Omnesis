// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Devices-view addition for the optional cloud relay: how a device joined.
// Rendered only when the gateway runs with OMNESIS_CLOUD_RELAY_ENABLED=1.

/**
 * How a device joined, or null when it was paired with a code or QR.
 *
 * `automatic`: the device signed in to the owner's Omnesis account and the
 * gateway let it in without asking. `approved`: it signed in the same way and a
 * person approved the request on this gateway. The sign-in method (Google or
 * passkey) is not part of the label.
 */
export function deviceJoinedLabel(enrollment) {
  if (!enrollment || typeof enrollment !== "object") return null;
  if (enrollment.method === "automatic") return "Joined with Omnesis account";
  if (enrollment.method === "approved") return "Approved";
  return null;
}
