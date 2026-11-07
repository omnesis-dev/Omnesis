// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { cloudPairingConfig, cloudPairingRequests, decideCloudPairing } from "../lib/cloud-pairing-api.js";
import { useVisiblePoll } from "../lib/use-visible-poll.js";

export function CloudPairingRequest({ request, onDecision }) {
  const [compared, setCompared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pending = request.status === "pending";
  const expired = request.expiresAt <= Date.now();

  async function decide(approve) {
    if (busy || expired || !pending || (approve && !compared)) return;
    setBusy(true);
    setError(null);
    try {
      await decideCloudPairing(request.requestId, approve);
      setCompared(false);
      await onDecision();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return html`<article class="cloud-pairing-request" aria-label=${`Pair ${request.name}`}>
    <h3>${request.name}</h3>
    <p class="devices-muted">${request.kind} · ${expired ? "Expired" : request.status}</p>
    ${pending && !expired && html`
      <p>Compare this code with the one on the device you are pairing. Only approve if every group matches.</p>
      <code class="cloud-pairing-code">${request.verificationCode}</code>
      <label class="cloud-pairing-compare">
        <input type="checkbox" checked=${compared} disabled=${busy}
          onChange=${(event) => setCompared(event.target.checked)} />
        I compared the code on the requesting device and it matches.
      </label>
      <p>${request.kind === "collector"
        ? "Approval lets this collector read your data and upload documents. "
        : "Approval lets this device read your data and manage gateway settings. "}
        Google sign-in alone does not grant access.</p>
      <div class="cloud-pairing-actions">
        <button class="btn-primary" disabled=${busy || !compared} onClick=${() => decide(true)}>
          ${busy ? "Updating…" : "Approve device"}
        </button>
        <button class="btn-secondary" disabled=${busy} onClick=${() => decide(false)}>Deny</button>
      </div>
    `}
    ${error && html`<p class="devices-banner error" role="alert">${error}</p>`}
  </article>`;
}

/** The public configuration endpoint exists only when optional Google pairing is enabled. */
export function CloudPairingRequests() {
  const [enabled, setEnabled] = useState(false);
  const [requests, setRequests] = useState([]);
  const [error, setError] = useState(null);
  const refresh = async () => {
    try {
      const response = await cloudPairingRequests();
      setRequests(response.items);
      setError(null);
    } catch (failure) { setError(failure.message); }
  };
  useEffect(() => {
    let active = true;
    cloudPairingConfig().then((config) => {
      if (!active || !config) return;
      setEnabled(true);
      refresh();
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  useVisiblePoll(refresh, 3000, { enabled });
  if (!enabled) return null;
  return html`<section class="cloud-pairing-requests" aria-label="Google device pairing">
    <h2 class="devices-group-title">Google device pairing</h2>
    <p>Requests from devices signed in to your Google account still need your approval here.</p>
    ${error && html`<p class="devices-banner error" role="alert">${error}</p>`}
    ${requests.length === 0 && html`<p class="devices-muted">No device pairing requests.</p>`}
    ${requests.map((request) => html`<${CloudPairingRequest} key=${`${request.requestId}:${request.verificationCode}`}
      request=${request} onDecision=${refresh} />`)}
  </section>`;
}
