// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  cloudPairingConfig,
  cloudPairingRequests,
  decideCloudPairing,
} from "../lib/cloud-pairing-api.js";
import { waitingCloudPairingRequests } from "../lib/cloud-pairing-waiting.js";
import { useVisiblePoll } from "../lib/use-visible-poll.js";

export function CloudPairingRequest({ request, onDecision }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const latest = useRef(request);
  latest.current = request;
  const deciding = useRef(false);
  const active = useRef(true);
  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  const [trust, setTrust] = useState(false);
  const pending = request.status === "pending";
  const expired = request.expiresAt <= Date.now();

  async function decide(approve) {
    if (
      deciding.current ||
      !active.current ||
      latest.current !== request ||
      request.expiresAt <= Date.now() ||
      !pending
    )
      return;
    deciding.current = true;
    setBusy(true);
    setError(null);
    try {
      await decideCloudPairing(
        request.requestId,
        approve,
        request.canTrustSignIn && approve ? trust : undefined,
      );
      await onDecision();
    } catch (failure) {
      setError(failure.message);
    } finally {
      deciding.current = false;
      setBusy(false);
    }
  }

  const approving = request.status === "approving";
  const waiting = (pending || approving) && !expired;
  return html`<article class="cloud-pairing-request" aria-label=${`Pair ${request.name}`}>
    <h3>${request.name}</h3>
    <p class="devices-muted">
      ${[KIND_LABELS[request.kind] ?? request.kind, SIGN_IN_LABELS[request.signIn]]
        .filter(Boolean)
        .join(" · ")}
    </p>
    ${
      waiting &&
      html`
        <p>
          A device signed in to your Omnesis account and is waiting for your approval to pair to this
          gateway. Approve if the code below matches the code shown on the device.
        </p>
        ${
          request.revokedDevice &&
          html`<p class="cloud-pairing-revoked">
            You revoked this device earlier. Approve only if it is back in your hands.
          </p>`
        }
        <code class="cloud-pairing-code">${request.verificationCode}</code>
        ${
          request.canTrustSignIn &&
          html`<label class="cloud-pairing-trust">
            <input
              type="checkbox"
              checked=${trust}
              disabled=${busy || approving}
              onChange=${(event) => setTrust(event.target.checked)}
            />
            <span
              >Trust this sign-in from now on
              <small
                >${`Devices that sign in with this ${request.signIn === "passkey" ? "passkey" : "Google account"} can join without waiting, if your gateway is set to join automatically.`}</small
              >
            </span>
          </label>`
        }
        <div class="cloud-pairing-actions">
          <button class="btn-primary" disabled=${busy || approving} onClick=${() => decide(true)}>
            ${busy || approving ? "Updating…" : "Approve"}
          </button>
          <button class="btn-secondary" disabled=${busy || approving} onClick=${() => decide(false)}>
            Deny
          </button>
        </div>
      `
    }
    ${error && html`<p class="devices-banner error" role="alert">${error}</p>`}
  </article>`;
}

// The same words the device list uses for each kind.
const KIND_LABELS = {
  ios: "iOS app",
  android: "Android app",
  collector: "Collector",
  cli: "CLI",
  portal: "Portal",
};
const SIGN_IN_LABELS = { google: "Google", passkey: "Passkey" };
/** The public configuration endpoint exists only when optional Google pairing is enabled. */
export function CloudPairingRequests() {
  const [enabled, setEnabled] = useState(false);
  const [requests, setRequests] = useState([]);
  const [error, setError] = useState(null);
  const refresh = async () => {
    try {
      const response = await cloudPairingRequests();
      setRequests(waitingCloudPairingRequests(response.items));
      setError(null);
    } catch (failure) {
      setError(failure.message);
    }
  };
  useEffect(() => {
    let active = true;
    cloudPairingConfig()
      .then((config) => {
        if (!active || !config) return;
        setEnabled(true);
        refresh();
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  useVisiblePoll(refresh, 3000, { enabled });
  // A request leaves as soon as it is approved, denied or out of time, also between two reads.
  const waiting = waitingCloudPairingRequests(requests);
  // Nothing waiting is the normal case, so the section stays out of the way.
  if (!enabled || (waiting.length === 0 && !error)) return null;
  return html`<section class="cloud-pairing-requests" aria-label="Devices waiting for approval">
    <h2 class="devices-group-title">Waiting for approval</h2>
    ${error && html`<p class="devices-banner error" role="alert">${error}</p>`}
    ${waiting.map(
      (request) =>
        html`<${CloudPairingRequest}
          key=${`${request.requestId}:${request.verificationCode}`}
          request=${request}
          onDecision=${refresh}
        />`,
    )}
  </section>`;
}
