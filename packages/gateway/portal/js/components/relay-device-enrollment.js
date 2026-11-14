// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Devices-view addition for the optional cloud relay: how a device joined.
// Rendered only when the gateway runs with OMNESIS_CLOUD_RELAY_ENABLED=1.

import { html } from "htm/preact";

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

/**
 * The trusted sign-in a device joined with, or null when that was not recorded
 * (a device paired with a code, or one that joined before it was). `id` is the
 * id `omnesis cloud trusted-sign-ins` lists.
 */
export function deviceSignIn(enrollment) {
  if (!enrollment || typeof enrollment !== "object") return null;
  const { signIn, signInId } = enrollment;
  if ((signIn !== "google" && signIn !== "passkey") || typeof signInId !== "string" || !signInId)
    return null;
  return { type: signIn, id: signInId, label: signIn === "passkey" ? "passkey" : "Google account" };
}

/** The device details line naming the sign-in a device joined with. */
export function DeviceSignIn({ enrollment }) {
  const signIn = deviceSignIn(enrollment);
  if (!signIn) return null;
  return html`<div class="devices-card-meta devices-card-sign-in">
    <span>Joined by signing in with a ${signIn.label}</span>
    <code class="devices-card-id" title="The id omnesis cloud trusted-sign-ins lists">${signIn.id}</code>
  </div>`;
}

/**
 * The revoke dialog's optional second step: also stop trusting the sign-in the
 * device joined with. Unticked by default; `choice.stopTrusting` carries it.
 */
export function StopTrustingSignIn({ signIn, choice }) {
  return html`<label class="cloud-pairing-trust">
    <input type="checkbox" onChange=${(event) => (choice.stopTrusting = event.target.checked)} />
    <span
      >Also stop trusting the ${signIn.label} it signed in with
      <small
        >${`New devices that sign in with this ${signIn.label} will wait for your approval. Other devices that joined with it stay paired.`}</small
      >
    </span>
  </label>`;
}
