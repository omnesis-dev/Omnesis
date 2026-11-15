// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The gateway's own Tailscale device, as the owner manages it from Settings →
// Tailscale. Every route exists only when the gateway runs with
// OMNESIS_TAILSCALE_EMBED_ENABLED=1, which `/status` advertises as
// `tailscaleEmbed: true`; the portal calls none of them otherwise.

import { apiFetch } from "../api.js";

/**
 * One admin call. Rejects with an Error whose `serverMessage` is the gateway's
 * own sentence — for a refused field, the field's message rather than the
 * generic "Validation failed" — and whose `status` and `code` are the
 * response's.
 */
async function tailscaleRequest(method, path, { body, signal } = {}) {
  const response = await apiFetch(`/admin/tailscale${path}`, {
    method,
    cache: "no-store",
    ...(signal ? { signal } : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    let envelope = null;
    try {
      envelope = await response.json();
    } catch {
      // A body that is not JSON keeps the generic message.
    }
    const error = new Error(`Tailscale settings request failed (${response.status}).`);
    error.status = response.status;
    if (typeof envelope?.code === "string") error.code = envelope.code;
    const field = Array.isArray(envelope?.detail) ? envelope.detail.find((d) => typeof d?.message === "string") : null;
    const message = field?.message ?? (typeof envelope?.error === "string" ? envelope.error : null);
    if (message) error.serverMessage = message;
    throw error;
  }
  return response.json();
}

export const getTailscale = (signal) => tailscaleRequest("GET", "", { signal });
export const setTailscaleEnabled = (enabled, signal) =>
  tailscaleRequest("POST", "/enable", { body: { enabled }, signal });
export const tailscaleSignIn = (signal) => tailscaleRequest("POST", "/sign-in", { signal });
export const tailscaleSignOut = (signal) => tailscaleRequest("POST", "/sign-out", { signal });
export const updateTailscaleSettings = (patch, signal) =>
  tailscaleRequest("PATCH", "/settings", { body: patch, signal });
export const tailscaleJoinRequests = (signal) => tailscaleRequest("GET", "/join-requests", { signal });
export const decideTailscaleJoin = (id, approve, signal) =>
  tailscaleRequest("POST", `/join-requests/${encodeURIComponent(id)}/decision`, {
    body: { approve },
    signal,
  });

/** The admin console pages an owner is sent to; Tailscale's own, not the gateway's. */
export const TAILSCALE_ADMIN = {
  machines: "https://login.tailscale.com/admin/machines",
  dns: "https://login.tailscale.com/admin/dns",
};

/** An https link the page may open, or null for anything else the helper reported. */
export function tailscaleHttpsUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
