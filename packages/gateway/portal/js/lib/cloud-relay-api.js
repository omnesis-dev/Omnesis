// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { apiFetch } from "../api.js";

/**
 * One relay management call. No operation reads status; an operation is a POST
 * unless a method is named (the enrollment policy is a PUT).
 */
export async function relayManagement(operation, input, signal, method = "POST") {
  const response = await apiFetch(`/admin/cloud-relay${operation ? `/${operation}` : ""}`, {
    cache: "no-store",
    signal,
    ...(operation ? { method, body: JSON.stringify(input) } : {}),
  });
  if (!response.ok) {
    let body;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const error = new Error("Couldn't update your Omnesis account settings. Check your connection and try again.");
    if (body && Object.hasOwn(ERRORS, body.code)) error.code = body.code;
    throw error;
  }
  return response.json();
}

/** The gateway's version, or "" when it cannot be read. Never throws. */
export async function gatewayVersion() {
  try {
    const response = await apiFetch("/health", { cache: "no-store" });
    const version = response.ok ? (await response.json()).version : "";
    return typeof version === "string" && /^[\w.+-]{1,40}$/.test(version) ? version : "";
  } catch {
    return "";
  }
}

// This gateway watches public certificate logs for a certificate it did not ask for.
const CT_LATER =
  "The check for unexpected certificates could not finish. It runs again by itself. Nothing else is affected.";
const CT_BROKEN =
  "The check for unexpected certificates is not working. Remote access keeps working. Copy the details and ask for help.";
const ERRORS = {
  "account-unavailable":
    "Omnesis account sign-in is unavailable. Direct connections and QR pairing remain available.",
  "account-link-failed":
    "Couldn't connect this gateway to your Omnesis account. Try again. Existing device access is unchanged.",
  "ct-configuration-invalid": CT_BROKEN,
  "ct-provider-unavailable": CT_LATER,
  "ct-provider-refused": CT_BROKEN,
  "ct-provider-invalid": CT_LATER,
  "ct-scan-incomplete": CT_LATER,
  "ct-journal-invalid": CT_BROKEN,
  "ct-journal-write-failed": CT_BROKEN,
  "hostname-conflict":
    "Choose a different public gateway hostname. This name is already covered by the direct/default certificate.",
  "hostname-required":
    "This relay needs a public gateway hostname. Enter its HTTPS origin in custom domain settings.",
  "ca-terms-required":
    "Accept the configured certificate authority’s terms before enabling public certificates.",
  "operation-in-progress":
    "Another change is in progress. Wait for it to finish and try again.",
  "google-unavailable":
    "Google sign-in is unavailable. Remote access and QR pairing work without it.",
  "google-link-failed": "Couldn't connect with Google. Try again. Gateway access is unchanged.",
  "relay-service-unavailable":
    "Omnesis account setup is unavailable. Ask the installation administrator to configure the relay service.",
  "relay-service-mismatch":
    "The installation service configuration does not match this gateway. Ask the installation administrator to resolve it.",
  "configuration-invalid": "Check the public gateway origin and certificate settings.",
  "relay-unreachable":
    "Omnesis Relay could not be reached. Check this gateway's internet connection. It keeps trying by itself.",
  "invitation-required": "This relay requires an invitation for this gateway ID.",
  "enrollment-refused": "This gateway couldn't register with Omnesis Relay. It keeps trying by itself. If this message stays, try connecting again.",
  "tunnel-disconnected": "Remote access was interrupted. Reconnect to try again.",
  "not-allowed":
    "This account hasn't been approved for Omnesis yet. Nothing on this gateway changed.",
  "certificate-setup-failed":
    "The certificate for this gateway's address could not be prepared. The gateway tries again by itself.",
  "certificate-renewal-failed":
    "The certificate for this gateway's address could not be renewed. The gateway tries again by itself.",
  "public-endpoint-unreachable":
    "This gateway's address does not answer from outside your home network. Check that this gateway is online. It checks again by itself.",
};
export function relayError(code) {
  return code
    ? Object.hasOwn(ERRORS, code)
      ? ERRORS[code]
      : "An operation failed. Check settings and retry."
    : "";
}
/** A calendar date such as "10 Jan 2027". Accepts ISO strings, milliseconds or Unix seconds. */
export function relayDate(value) {
  if (value === undefined || value === null || value === "") return "";
  const date = new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
    : "";
}

/** A clock time such as "16:42", for short-lived codes. Accepts milliseconds or Unix seconds. */
export function relayClock(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return new Date(value < 1e12 ? value * 1000 : value).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relayHttpsUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Where to ask for an account when the relay's accounts are invite-only, with the host to show
 * beside the link so a substituted address is visible. Null when the gateway reported nothing usable.
 */
export function relaySignupAccess(status) {
  const signup = status?.signup;
  if (!signup || signup.inviteOnly !== true) return null;
  const url = relayHttpsUrl(signup.requestAccessUrl);
  return url ? { url, host: new URL(url).host } : null;
}

/** Accept Google directly or a single-use launch on the gateway's authenticated installation service. */
export function googleAuthorizationUrl(value, installationRelayUrl) {
  const safe = relayHttpsUrl(value);
  if (!safe) throw new Error("Google authorization is unavailable.");
  const url = new URL(safe);
  if (url.origin === "https://accounts.google.com" && url.pathname === "/o/oauth2/v2/auth")
    return url.href;
  const service = relayHttpsUrl(installationRelayUrl);
  const operationIds = url.searchParams.getAll("operationId");
  const tickets = url.searchParams.getAll("ticket");
  if (
    !service ||
    url.origin !== new URL(service).origin ||
    url.pathname !== "/_relay/v2/google/browser/begin" ||
    url.hash ||
    [...url.searchParams.keys()].length !== 2 ||
    operationIds.length !== 1 ||
    tickets.length !== 1 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(operationIds[0]) ||
    !/^[A-Za-z0-9_-]{43}$/.test(tickets[0])
  )
    throw new Error("Google authorization is unavailable.");
  return url.href;
}

/** Account handoffs accept only a one-use capability at the configured account authority. */
export function accountAuthorizationUrl(value, installationRelayUrl) {
  const safe = relayHttpsUrl(value),
    service = relayHttpsUrl(installationRelayUrl);
  if (!safe || !service) throw new Error("Omnesis account sign-in is unavailable.");
  const url = new URL(safe);
  if (
    url.origin !== new URL(service).origin ||
    url.pathname !== "/_relay/v3/account-browser/begin" ||
    url.hash ||
    url.searchParams.size !== 2 ||
    url.searchParams.getAll("operationId").length !== 1 ||
    url.searchParams.getAll("ticket").length !== 1 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      url.searchParams.get("operationId"),
    ) ||
    !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("ticket"))
  )
    throw new Error("Omnesis account sign-in is unavailable.");
  return url.href;
}
