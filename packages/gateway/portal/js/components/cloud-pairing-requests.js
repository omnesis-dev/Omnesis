// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  askBeforeEveryNewDevice,
  cloudPairingConfig,
  cloudPairingRequests,
  decideCloudPairing,
} from "../lib/cloud-pairing-api.js";
import { waitingCloudPairingRequests } from "../lib/cloud-pairing-waiting.js";
import { useVisiblePoll } from "../lib/use-visible-poll.js";
import {
  approveWithPasskey,
  onGatewayOrigin,
  passkeysSupported,
} from "../lib/gateway-passkey.js";

// What each kind of device is called on the card.
const KIND_LABELS = {
  ios: "iOS app",
  android: "Android app",
  collector: "Collector",
  cli: "CLI",
  portal: "Browser",
};
const SIGN_IN_LABELS = { google: "signed in with Google", passkey: "signed in with a passkey" };

/** "22:41": when the device asked, in this browser's own clock format. */
function askedAt(createdAt) {
  if (typeof createdAt !== "number") return undefined;
  return new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** A six-digit code in two groups of three; any other code exactly as the gateway sent it. */
function Code({ code }) {
  const digits = /^(\d{3}) ?(\d{3})$/.exec(code);
  return html`<code class="cloud-pairing-code"
    >${digits
      ? html`<span>${digits[1]}</span> <span>${digits[2]}</span>`
      : code}</code
  >`;
}

/**
 * One device waiting for the owner's yes, asked as a question about that device: the code it
 * shows, compared here. `passkey`: this page is on the gateway's own origin and the gateway says
 * a confirmed passkey can approve (`passkeyApproval`), so an app's request can also be approved
 * with it. `stepUpRequired`: approving from this session asks for the passkey first, so the button
 * says so. Neither changes what approving does.
 *
 * Remembering the sign-in is offered as the gateway allows (`canTrustSignIn`). It starts ticked
 * only on the first confirmation for the account the gateway was linked with
 * (`rememberByDefault`), and it can't be ticked for another Google account than that one
 * (`otherGoogleAccount`). The Google address shown is the one Google verified in the token the
 * gateway checked, never one the relay or the device named.
 */
export function CloudPairingRequest({
  request,
  onDecision,
  onDenied = () => {},
  passkey = false,
  stepUpRequired = false,
  focused = false,
  approve = approveWithPasskey,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const latest = useRef(request);
  latest.current = request;
  const deciding = useRef(false);
  const active = useRef(true);
  const card = useRef(null);
  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  useEffect(() => {
    if (focused) card.current?.scrollIntoView?.({ block: "center" });
  }, [focused]);
  // null until the owner touches it, so the gateway's suggestion can still follow the request.
  const [choice, setChoice] = useState(null);
  const otherAccount = request.otherGoogleAccount === true;
  const remember = otherAccount ? false : (choice ?? request.rememberByDefault === true);
  const pending = request.status === "pending";
  const expired = request.expiresAt <= Date.now();

  async function decide(accept, withPasskey = false) {
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
      const trustSignIn = request.canTrustSignIn && accept ? remember : undefined;
      if (withPasskey)
        await approve({
          requestId: request.requestId,
          ...(trustSignIn === undefined ? {} : { trustSignIn }),
        });
      else
        await decideCloudPairing(
          request.requestId,
          accept,
          trustSignIn,
          ...(accept && stepUpRequired ? [{ stepUpAnnounced: true }] : []),
        );
      if (!accept) onDenied(request);
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
  const locked = busy || approving;
  const google = request.signIn === "google";
  const email = google ? request.signInEmail : undefined;
  const meta = [
    KIND_LABELS[request.kind] ?? request.kind,
    SIGN_IN_LABELS[request.signIn],
    email,
    askedAt(request.createdAt),
  ].filter(Boolean);
  return html`<article
    class=${`cloud-pairing-request${focused ? " cloud-pairing-focused" : ""}`}
    id=${`cloud-pairing-request-${request.requestId}`}
    ref=${card}
    aria-label=${`${request.name} wants to connect`}
  >
    <h3>${request.name} wants to connect</h3>
    <p class="devices-muted">${meta.join(" · ")}</p>
    ${
      waiting &&
      html`
        ${
          request.revokedDevice &&
          html`<p class="cloud-pairing-revoked">
            You removed this device before. Approve only if it's back in your hands.
          </p>`
        }
        <p class="cloud-pairing-question">Does ${request.name} show this code?</p>
        <${Code} code=${request.verificationCode} />
        ${
          otherAccount &&
          html`<p class="cloud-pairing-revoked cloud-pairing-other-account">
            This isn't the Google account you connected with.
          </p>`
        }
        ${
          request.canTrustSignIn &&
          html`<label class="cloud-pairing-trust">
            <input
              type="checkbox"
              checked=${remember}
              disabled=${locked || otherAccount}
              onChange=${(event) => setChoice(event.target.checked)}
            />
            <span
              >${google ? "Remember this Google account" : "Remember this passkey"}
              ${email && html`<strong class="cloud-pairing-email">${email}</strong>`}
              <small
                >${
                  google
                    ? "Next time you sign in with it in the Omnesis app, your device connects without asking."
                    : "Next time you add a device with this passkey, it connects without asking."
                }</small
              >
            </span>
          </label>`
        }
        <div class="cloud-pairing-actions">
          <button class="btn-primary" disabled=${locked} onClick=${() => decide(true)}>
            ${locked ? "Updating…" : stepUpRequired ? "Yes, approve with passkey" : "Yes, approve"}
          </button>
          ${
            passkey &&
            !stepUpRequired &&
            request.kind !== "portal" &&
            html`<button class="btn-secondary" disabled=${locked} onClick=${() => decide(true, true)}>
              Approve with passkey
            </button>`
          }
          <button class="btn-secondary" disabled=${locked} onClick=${() => decide(false)}>
            No, deny
          </button>
        </div>
      `
    }
    ${error && html`<p class="devices-banner error" role="alert">${error}</p>`}
  </article>`;
}

/**
 * After a deny, what it may mean and the one stricter step to take. "Always ask me" only makes
 * the gateway stricter, so it needs no passkey.
 */
export function CloudPairingDenied({ denied, onClose, ask = askBeforeEveryNewDevice }) {
  const [state, setState] = useState("idle");
  const [error, setError] = useState(null);
  const run = async () => {
    setState("busy");
    setError(null);
    try {
      await ask();
      setState("done");
    } catch (failure) {
      setError(failure.message);
      setState("idle");
    }
  };
  return html`<div class="cloud-pairing-denied" role="status">
    <p>
      <strong>Denied.</strong>
      ${
        denied.signIn === "google"
          ? " If you didn't try to connect a device, someone may know your Google password."
          : " If you didn't try to connect a device, someone may be signed in to your Omnesis account."
      }
    </p>
    ${
      state === "done"
        ? html`<p>New devices will now always wait for your OK.</p>`
        : html`<div class="cloud-pairing-actions">
            <button class="btn-secondary" disabled=${state === "busy"} onClick=${run}>
              Make new devices always ask me
            </button>
            <button class="btn-secondary" onClick=${onClose}>Done</button>
          </div>`
    }
    ${error && html`<p class="devices-banner error" role="alert">${error}</p>`}
  </div>`;
}

/** `?request=<id>` on the Devices page opens that request, as a notification links to it. */
function requestedId() {
  return new URLSearchParams(globalThis.location?.search ?? "").get("request");
}

/**
 * The waiting sign-in requests, as cards for the Devices page's "Waiting for your OK" section,
 * which also lists other kinds of waiting devices and owns the title; `onCount` hears how many
 * of these wait. The public configuration endpoint exists only when optional Google pairing is
 * enabled.
 */
export function CloudPairingRequests({ focusRequestId = requestedId(), onCount } = {}) {
  const [enabled, setEnabled] = useState(false);
  const [passkey, setPasskey] = useState(false);
  const [stepUpRequired, setStepUpRequired] = useState(false);
  const [requests, setRequests] = useState([]);
  const [denied, setDenied] = useState(null);
  const [error, setError] = useState(null);
  const refresh = async () => {
    try {
      const response = await cloudPairingRequests();
      setRequests(waitingCloudPairingRequests(response.items));
      setStepUpRequired(response.stepUpRequired === true);
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
        // Only when a passkey confirmed here can approve: an absent answer means it can't.
        setPasskey(
          config.passkeyApproval === true &&
            onGatewayOrigin(config.gatewayPasskey?.origin) &&
            passkeysSupported(),
        );
        refresh();
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  useVisiblePoll(refresh, 3000, { enabled });
  // A request leaves as soon as it is approved, denied or out of time, also between two reads.
  // The one a notification opened comes first.
  const waiting = waitingCloudPairingRequests(requests).sort(
    (a, b) => Number(b.requestId === focusRequestId) - Number(a.requestId === focusRequestId),
  );
  const count = enabled ? waiting.length : 0;
  useEffect(() => onCount?.(count), [count]);
  // Nothing waiting is the normal case, so the section stays out of the way.
  if (!enabled || (waiting.length === 0 && !error && !denied)) return null;
  return html`
    ${error && html`<p class="devices-banner error" role="alert">${error}</p>`}
    ${denied && html`<${CloudPairingDenied} denied=${denied} onClose=${() => setDenied(null)} />`}
    ${waiting.map(
      (request) =>
        html`<${CloudPairingRequest}
          key=${`${request.requestId}:${request.verificationCode}`}
          request=${request}
          passkey=${passkey}
          stepUpRequired=${stepUpRequired}
          focused=${request.requestId === focusRequestId}
          onDenied=${(value) => setDenied({ signIn: value.signIn })}
          onDecision=${refresh}
        />`,
    )}
  `;
}
