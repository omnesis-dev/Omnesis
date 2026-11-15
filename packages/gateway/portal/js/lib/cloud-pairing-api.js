// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { apiFetch } from "../api.js";

export async function cloudPairingConfig() {
  const response = await fetch("/devices/google/config", {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Sign-in is unavailable. Try again later.");
  return response.json();
}

export async function cloudPairingRequests() {
  const response = await apiFetch("/admin/cloud-pairing/requests", { cache: "no-store" });
  if (!response.ok) throw new Error("Couldn't load device pairing requests.");
  return response.json();
}

/** `stepUpAnnounced`: the button already said Face ID comes next, so no note before it. */
export async function decideCloudPairing(requestId, approve, trustSignIn, { stepUpAnnounced } = {}) {
  const response = await apiFetch("/admin/cloud-pairing/decision", {
    method: "POST",
    body: JSON.stringify({
      requestId,
      approve,
      ...(trustSignIn === undefined ? {} : { trustSignIn }),
    }),
    ...(stepUpAnnounced ? { stepUpAnnounced: true } : {}),
  });
  if (!response.ok) {
    throw new Error("Couldn't update this request. It may have expired; refresh and try again.");
  }
  return response.json();
}

/** "Make new devices always ask me": only makes the gateway stricter, so it asks for no Face ID. */
export async function askBeforeEveryNewDevice() {
  const response = await apiFetch("/admin/cloud-relay/enrollment", {
    method: "PUT",
    body: JSON.stringify({ policy: "ask" }),
  });
  if (!response.ok)
    throw new Error("Couldn't change this. Try again in Settings → Omnesis account.");
  return response.json();
}
