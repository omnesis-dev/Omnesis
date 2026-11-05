// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { apiFetch } from "../api.js";

export async function cloudPairingConfig() {
  const response = await fetch("/devices/google/config", { credentials: "same-origin", cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Google sign-in is unavailable. Try again later.");
  return response.json();
}

export async function cloudPairingRequests() {
  const response = await apiFetch("/admin/cloud-pairing/requests", { cache: "no-store" });
  if (!response.ok) throw new Error("Couldn't load device pairing requests.");
  return response.json();
}

export async function decideCloudPairing(requestId, approve) {
  const response = await apiFetch("/admin/cloud-pairing/decision", {
    method: "POST", body: JSON.stringify({ requestId, approve }),
  });
  if (!response.ok) throw new Error("Couldn't update this request. It may have expired; refresh and try again.");
  return response.json();
}
