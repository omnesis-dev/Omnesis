// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Settings → Remote access: the guided setup's own state and the checks for a
// way in the owner runs themselves. Every route exists only when the gateway
// runs with the cloud relay or its own Tailscale device on (`cloudRelay` or
// `tailscaleEmbed` on `/status`); the host's Tailscale routes only with the
// latter. The portal calls none of them otherwise. The account, the relay and
// the gateway's Tailscale device keep their own routes (cloud-relay-api.js,
// tailscale-api.js).

import { adminJsonRequest } from "./admin-request.js";

const remoteAccessRequest = adminJsonRequest("/admin/remote-access", "Remote access");

/**
 * `{ setupCompletedAt, first, features, publicBaseUrl: { configured, setByEnvironment } }`:
 * `configured` is the public address in use now, or null.
 */
export const getRemoteAccess = (signal) => remoteAccessRequest("GET", "", { signal });

/** `{ setupCompleted?, first? }`; answers with the same shape as `getRemoteAccess`. */
export const updateRemoteAccess = (patch, signal) =>
  remoteAccessRequest("PATCH", "", { body: patch, signal });

/**
 * Checks an https address the owner publishes the gateway at:
 * `{ url, ok, steps: [{ id: "resolves" | "certificate" | "answers", ok, detail }] }`, stopping at
 * the first step that fails.
 */
export const checkPublicAddress = (url, signal) =>
  remoteAccessRequest("POST", "/check-address", { body: { url }, signal });

/**
 * Tailscale already on this computer: `{ state: "unavailable", reason }` or
 * `{ state: "available", dnsName, url, servesGateway, publicGateway }`.
 */
export const getHostTailscale = (signal) => remoteAccessRequest("GET", "/host-tailscale", { signal });

/**
 * Serves the gateway on the tailnet, and with `isPublic` to the Internet too:
 * `{ ok: true, url }`, or `{ ok: false, reason, command }` naming the command the owner runs.
 */
export const publishHostTailscale = (isPublic, signal) =>
  remoteAccessRequest("POST", "/host-tailscale/publish", { body: { public: isPublic }, signal });
