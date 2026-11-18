// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Settings → Connectivity: the guided setup's own state, the MCP server's
// switch on each address, and the checks for a way in the owner runs
// themselves. Every gateway has these routes. The account, the relay and the
// gateway's Tailscale device keep their own routes (cloud-relay-api.js,
// tailscale-api.js).

import { adminJsonRequest } from "./admin-request.js";

const remoteAccessRequest = adminJsonRequest("/admin/remote-access", "Remote access");

/**
 * `{ setupCompletedAt, first, features, publicBaseUrl: { configured, setByEnvironment, way },
 * mcpAddresses: [{ id, url, reach, choices, available, opening? }] }`: `configured` is the
 * public address in use now, or null; `reach` is where MCP answers at that address now,
 * one of `choices` ("off", "private", "public" or "on").
 */
export const getRemoteAccess = (signal) => remoteAccessRequest("GET", "", { signal });

/**
 * `{ setupCompleted?, first?, mcp?: { <id>: <reach> } }`; answers with the same shape as
 * `getRemoteAccess`, plus `mcpRefusal: { reason, command? }` when Tailscale on this computer
 * would not change Funnel for a choice.
 */
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
 * `{ state: "available", dnsName, version, url, port, servesGateway, funnel, publicGateway,
 * publicMcp, taken, blocked? }`: `publicGateway` is whether the portal and device
 * connections answer the Internet, `publicMcp` whether MCP does.
 */
export const getHostTailscale = (signal) => remoteAccessRequest("GET", "/host-tailscale", { signal });

/**
 * Serves the gateway on the tailnet, and with `isPublic` to the Internet too:
 * `{ ok: true, url }`, or `{ ok: false, reason, command }` naming the command the owner runs.
 */
export const publishHostTailscale = (isPublic, signal) =>
  remoteAccessRequest("POST", "/host-tailscale/publish", { body: { public: isPublic }, signal });

/**
 * Stops Tailscale on this computer serving the gateway, on the tailnet and the Internet:
 * `{ ok: true }`, or `{ ok: false, reason, command }` naming the command the owner runs.
 */
export const unpublishHostTailscale = (signal) =>
  remoteAccessRequest("POST", "/host-tailscale/unpublish", { body: {}, signal });
