// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// What is wrong with this gateway's Omnesis account link or remote access, in
// one box: a plain sentence per problem and the details to paste when asking
// for help. `omnesis cloud status` prints the same facts.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { relayError, relayDate } from "../lib/cloud-relay-api.js";

/** Every error code the gateway reports, with where it came from. */
function reported(status) {
  return [
    ["connect", status.connect?.error],
    ["registration", status.enrollment?.error],
    ["tunnel", status.tunnel?.lastError],
    ["certificate", status.certificate?.lastError],
    ["address", status.publicMcp?.lastError],
    ["certificate monitor", status.certificateMonitor?.lastError],
    ["service", status.serviceError],
    ["account", status.account?.lastError],
    ["google", status.google?.lastError],
  ].filter(([, code]) => typeof code === "string" && code);
}

/**
 * The sentences to show. A problem the headline already states (a failed
 * connect, a dropped connection, an unavailable service) is not repeated.
 */
export function relayProblems(status, phase) {
  const inHeadline = {
    failed: ["connect", "registration"],
    disconnected: ["tunnel"],
    unavailable: ["service"],
  }[phase];
  // With remote access off, what its tunnel, certificate and address last reported is history.
  const idle = status.enabled ? [] : ["tunnel", "certificate", "address"];
  const messages = reported(status)
    .filter(([source]) => !inHeadline?.includes(source) && !idle.includes(source))
    .map(([, code]) => relayError(code));
  const certificate = status.certificate?.state;
  if (status.enabled && certificate === "expired")
    messages.push(
      "The certificate for this gateway's address has expired, so devices away from home cannot connect. The gateway keeps trying to renew it.",
    );
  if (status.enabled && certificate === "expiring")
    messages.push(
      `The certificate for this gateway's address expires on ${relayDate(status.certificate.expiresAt) || "a date soon"}. The gateway renews it by itself. If this message stays for more than a day, ask for help.`,
    );
  if (status.incidentHold)
    messages.push(
      "A certificate for this gateway's address was issued with a key this gateway does not hold, so someone else may be able to pose as this gateway. Until you deal with it, every new device waits for your approval, whatever you chose for new devices. Don't sign in or approve anything from a link you didn't expect. Copy the details and ask for help. Once it is resolved, run omnesis cloud incidents ack on the gateway host.",
    );
  else if (status.certificateMonitor?.incidents?.length > 0)
    messages.push(
      "A certificate for this gateway's address was issued with a key this gateway does not hold. Someone else may be able to pose as this gateway. Copy the details and ask for help before you add new devices.",
    );
  return [...new Set(messages)];
}

function iso(value) {
  if (value === undefined || value === null || value === "") return "not recorded";
  const date = new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "not recorded";
}

/** One printable line: status values are data from the gateway, never layout. */
function plain(value, fallback = "unknown") {
  return typeof value === "string" && value
    ? value.replace(/[^\x20-\x7e]+/g, " ").slice(0, 300)
    : fallback;
}

/**
 * The plain-text block a person pastes to an assistant or a forum. It carries
 * public facts only: addresses, states, dates and error codes. No token, key
 * or sign-in identifier is in the status this reads, and none is added here.
 */
export function relayDiagnostics(status, { phase, version, now = new Date() } = {}) {
  const codes = reported(status).map(([source, code]) => `${plain(code)} (${source})`);
  if (status.certificate?.state === "expired") codes.push("certificate-expired (certificate)");
  if (status.certificate?.state === "expiring") codes.push("certificate-expiring (certificate)");
  const monitor = status.certificateMonitor;
  const incidents = Array.isArray(monitor?.incidents) ? monitor.incidents : [];
  if (incidents.length > 0) codes.push("unexpected-certificate (certificate monitor)");
  if (status.incidentHold) codes.push("incident-hold (new devices)");
  const direct = status.identities?.find((identity) => identity.id === "direct");
  const account = status.account;
  const address = status.publicMcp;
  const lines = [
    "Omnesis account details",
    `Time: ${now.toISOString()}`,
    `Gateway version: ${plain(version)}`,
    `Page state: ${plain(phase)}`,
    `Error codes: ${codes.join(", ") || "none"}`,
    ...(status.notice ? [`Notice: ${plain(status.notice)}`] : []),
    `Remote access: ${status.enabled ? "on" : "off"}`,
    `Address: ${plain(address?.url, "none")} (${address?.ready ? "answering" : address?.lastError ? "not answering" : "not confirmed"})`,
    `Registration: ${plain(status.enrollment?.state)}, gateway ID ${plain(status.gatewayId, "none")}`,
    `Tunnel: ${plain(status.tunnel?.state)}, last connected ${iso(status.tunnel?.lastConnectedAt)}`,
    `Public certificate: ${plain(status.certificate?.state)}, expires ${iso(status.certificate?.expiresAt)}, last renewed ${iso(status.certificate?.lastRenewedAt)}`,
    `Home certificate: ${plain(direct?.kind)}, ${plain(direct?.state ?? status.directCertificate?.state)}, expires ${iso(direct?.expiresAt ?? status.directCertificate?.expiresAt)}`,
    `Certificate monitor: ${plain(monitor?.state, "not reported")}, last checked ${iso(monitor?.lastCompletedAt)}`,
    ...incidents.map(
      (incident) =>
        `Unexpected certificate: name ${plain(incident.hostname)}, public key ${plain(incident.spkiFingerprint)}, certificate ${plain(incident.certificateFingerprint)}, issuer ${plain(incident.issuer)}, serial ${plain(incident.serial)}, valid ${iso(incident.validFrom)} to ${iso(incident.validTo)}, seen ${iso(incident.observedAt)}, log entry ${plain(incident.providerEntryId)}`,
    ),
    `Account: ${account?.linked || status.google?.linked ? "linked" : account?.pendingUnlink ? "unlinked here, account not updated yet" : "not linked"}`,
    // Only a sign-in confirmed on this gateway joins a device on its own; the others are on record.
    `New devices: ${plain(status.deviceEnrollment?.policy, "not reported")}, ${status.deviceEnrollment?.confirmedSignIns?.length ?? 0} confirmed sign-ins, ${status.deviceEnrollment?.trustedSignIns?.length ?? 0} on record`,
    ...(status.incidentHold
      ? [
          `Incident hold: since ${iso(status.incidentHold.since)}, ${Array.isArray(status.incidentHold.certificates) ? status.incidentHold.certificates.length : 0} certificates`,
        ]
      : []),
    ...(status.recovery
      ? [`Recovery receipt: ${plain(status.recovery.receipt)}, expires ${iso(status.recovery.expiresAt)}`]
      : []),
    `Relay: ${plain(status.config?.relayUrl, "none")}`,
    `Certificate provider: ${plain(status.config?.acmeDirectoryUrl, "none")}`,
  ];
  return lines.join("\n") + "\n";
}

/**
 * The box. `messages` may be empty when the headline already says what is
 * wrong: the details and the command are still offered.
 */
export function RelayProblems({ messages, details }) {
  const [state, setState] = useState("idle");
  const timer = useRef(null);
  const fallback = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (state === "failed") fallback.current?.select?.();
  }, [state]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(details);
      setState("copied");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), 2000);
    } catch {
      // No clipboard access (an insecure origin, a refused permission): show the text to select.
      setState("failed");
    }
  };
  return html`<section class="relay-problems" aria-labelledby="relay-problems-title">
    <h3 class="relay-problems-title" id="relay-problems-title">
      ${messages.length > 1 ? "Some things need your attention" : "Something needs your attention"}
    </h3>
    ${messages.map((message) => html`<p role="alert" class="relay-problem">${message}</p>`)}
    <p class="relay-hint">
      Need help? Copy the details and paste them to an assistant or a help forum. They contain no
      passwords or keys. Running <code class="relay-mono">omnesis cloud status</code> on this
      gateway prints the same details.
    </p>
    <div class="relay-actions relay-problems-actions">
      <button type="button" class="btn-secondary" onClick=${copy}>
        ${state === "copied" ? "Copied" : "Copy details"}
      </button>
      <span class="relay-hint" role="status">
        ${state === "failed" ? "Couldn't copy. Select the text below and copy it." : ""}
      </span>
    </div>
    ${
      state === "failed" &&
      html`<textarea
        ref=${fallback}
        class="relay-problems-text relay-mono"
        readonly
        rows="8"
        aria-label="Details to copy"
        value=${details}
      ></textarea>`
    }
  </section>`;
}
