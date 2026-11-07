// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { apiFetch } from "../api.js";

export async function relayManagement(operation, input, signal) {
  const response = await apiFetch(`/admin/cloud-relay${operation ? `/${operation}` : ""}`, {
    cache: "no-store", signal,
    ...(operation ? { method: "POST", body: JSON.stringify(input) } : {}),
  });
  if (!response.ok) {
    let body;
    try { body = await response.json(); } catch { body = null; }
    const error = new Error("Couldn't update relay settings. Check your connection and try again.");
    if (body && Object.hasOwn(ERRORS, body.code)) error.code = body.code;
    throw error;
  }
  return response.json();
}

const ERRORS = {
  "ct-configuration-invalid": "Certificate monitoring configuration is invalid. Ask the installation administrator to check its settings.",
  "ct-provider-unavailable": "The certificate observation provider could not be reached. Previous incidents remain recorded.",
  "ct-provider-refused": "The certificate observation provider refused access. Check its dedicated account configuration.",
  "ct-provider-invalid": "The certificate observation provider returned invalid evidence. Coverage has not been marked complete.",
  "ct-scan-incomplete": "More certificate observations remain to be checked. Coverage is incomplete.",
  "ct-journal-invalid": "The local certificate incident journal could not be validated. Ask the installation administrator to inspect it.",
  "ct-journal-write-failed": "Certificate incidents could not be saved locally. Monitoring needs attention.",
  "hostname-conflict": "Choose a different public gateway hostname. This name is already covered by the direct/default certificate.",
  "hostname-required": "This relay needs a public gateway hostname. Enter its HTTPS origin in custom domain settings.",
  "ca-terms-required": "Accept the configured certificate authority’s terms before enabling public certificates.",
  "operation-in-progress": "Another relay operation is running. Wait for it to finish and try again.",
  "google-unavailable": "Google account linking is unavailable. Relay access and QR pairing remain usable without Google.",
  "google-link-failed": "Google account linking failed. Try again; gateway access is unchanged.",
  "relay-service-unavailable": "Relay setup is unavailable. Ask the installation administrator to configure the service.",
  "relay-service-mismatch": "The installation service configuration does not match this gateway. Ask the installation administrator to resolve it.",
  "configuration-invalid": "Check the public gateway origin and certificate settings.",
  "relay-unreachable": "The relay could not be reached. Check the connection, then reconnect.",
  "invitation-required": "This relay requires an invitation for this gateway ID.",
  "enrollment-refused": "Enrollment was refused. Check the invitation and relay settings.",
  "tunnel-disconnected": "The relay connection was interrupted. Reconnect to try again.",
  "certificate-setup-failed": "The public certificate could not be prepared. Check DNS and certificate settings.",
  "certificate-renewal-failed": "Certificate renewal failed. Check DNS and try renewal again.",
  "public-endpoint-unreachable": "The public endpoint could not be verified. Check DNS and the relay connection.",
};
export function relayError(code) { return code ? (Object.hasOwn(ERRORS, code) ? ERRORS[code] : "An operation failed. Check settings and retry.") : ""; }
export function relayTime(value) {
  if (!value) return "Not yet recorded";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Not yet recorded";
}

export function relayCertificateKind(kind) {
  const labels = { "self-signed": "Self-signed", "public-ca": "Public certificate authority", "local-ca": "Local certificate authority", external: "Provided certificate", unconfigured: "Not configured" };
  return Object.hasOwn(labels, kind) ? labels[kind] : "Existing certificate";
}

export function relayHttpsUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

/** Accept Google directly or a single-use launch on the gateway's authenticated installation service. */
export function googleAuthorizationUrl(value, installationRelayUrl) {
  const safe = relayHttpsUrl(value);
  if (!safe) throw new Error("Google authorization is unavailable.");
  const url = new URL(safe);
  if (url.origin === "https://accounts.google.com" && url.pathname === "/o/oauth2/v2/auth") return url.href;
  const service = relayHttpsUrl(installationRelayUrl);
  const operationIds = url.searchParams.getAll("operationId");
  const tickets = url.searchParams.getAll("ticket");
  if (!service || url.origin !== new URL(service).origin ||
      url.pathname !== "/_relay/v2/google/browser/begin" || url.hash ||
      [...url.searchParams.keys()].length !== 2 || operationIds.length !== 1 || tickets.length !== 1 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(operationIds[0]) ||
      !/^[A-Za-z0-9_-]{43}$/.test(tickets[0])) throw new Error("Google authorization is unavailable.");
  return url.href;
}

export function relayRecoveryLabel(state) {
  const labels = { missing: "Not stored", present: "Stored locally", expired: "Expired", invalid: "Invalid local artifact" };
  return Object.hasOwn(labels, state) ? labels[state] : "Unavailable";
}
export function relayMonitorLabel(state) {
  const labels = { disabled: "Off", pending: "Waiting for a local gateway key", observing: "Recent provider observations completed", incident: "Unexpected certificate key observed", stale: "Observations are incomplete or stale", unavailable: "Monitoring unavailable" };
  return Object.hasOwn(labels, state) ? labels[state] : "Monitoring status unavailable";
}
