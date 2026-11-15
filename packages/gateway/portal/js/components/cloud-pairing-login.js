// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { login } from "../api.js";
import { accountAuthorizationUrl } from "../lib/cloud-relay-api.js";
import { cloudPairingConfig } from "../lib/cloud-pairing-api.js";
import { portalDeviceName, setPortalDeviceName } from "../lib/storage.js";
import {
  cloudPairingCodeCommitment,
  cloudPairingVerificationCode,
  enrollmentSignatureTranscript,
  GOOGLE_PAIRING_STORAGE_KEY,
  googleAuthorizationUrl,
  newCloudPairing,
  restoreCloudPairing,
  signEnrollment,
} from "../lib/cloud-pairing.js";
import { adoptDeviceKey, loadDeviceKey } from "../lib/device-key-store.js";
import { parseAccountSignIn, takeAccountSignIn } from "../lib/cloud-pairing-handoff.js";
import { useVisiblePoll } from "../lib/use-visible-poll.js";
import {
  approveWithPasskey,
  gatewayPasskeyProof,
  onGatewayOrigin,
  PASSKEY_CHECK_FAILED,
  PASSKEY_OTHER_ACCOUNT,
  passkeysSupported,
} from "../lib/gateway-passkey.js";

/** Whether this gateway lets a browser with a device key join by sign-in alone. */
const automaticEnrollment = (config) =>
  Boolean(
    config.accountSignIn &&
    config.automaticEnrollment &&
    /^[a-f0-9]{64}$/.test(config.gatewaySpkiFingerprint ?? ""),
  );

/**
 * Whether this page can sign in with a passkey on the gateway's own origin: the gateway has one,
 * this page is on it, and the browser can keep a device key and make a passkey assertion.
 */
const gatewayPasskeyHere = (config) =>
  automaticEnrollment(config) &&
  onGatewayOrigin(config.gatewayPasskey?.origin) &&
  passkeysSupported();

/** Every sentence the sign-in options and the waiting screen say, in one place. */
export const LOGIN_COPY = {
  title: "Sign in to your gateway",
  passkey: "Continue with Face ID",
  google: "Continue with Google",
  waitingForPasskey: "Waiting for Face ID…",
  opening: "Opening sign-in…",
  openingGoogle: "Opening Google…",
  // Said under Google: a browser's Google sign-in always waits for a person.
  googleHint: "You'll approve this browser on your phone.",
  waitingTitle: "Waiting for your OK",
  waitingBody: "Approve this browser on a device you already use.",
  codeHint: "Make sure your phone shows this code.",
  expiresIn: (left) => `Expires in ${left}`,
  approved: "Approved. Opening your gateway…",
  approvedCompare: "Approved by your gateway.",
  denied: "Your gateway denied this request.",
  approveHere: "Approve with Face ID here",
  pair: "Codes match, pair this device",
  pairing: "Pairing…",
  cancel: "Cancel",
};
const NOT_RECOGNISED = PASSKEY_CHECK_FAILED;
const CHANGED = "The gateway or pairing request changed. Start again.";
const TOO_MANY_WAITING =
  "Too many devices are waiting for approval. Answer one on a device you already use, then try again.";
function changed() {
  return Object.assign(new Error(CHANGED), { changed: true });
}

/** A one-use gateway challenge for this browser's request. */
async function requestChallenge(signal) {
  const response = await fetch("/devices/account/challenge", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal,
  });
  if (!response.ok) throw new Error("Couldn't finish signing in. Start again.");
  return response.json();
}

/** `onReady` is told once this sign-in is on offer here, so the page can lead with it. */
export function CloudPairingLogin({ onReady } = {}) {
  const [config, setConfig] = useState(null);
  const [request, setRequest] = useState(null);
  const [code, setCode] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [joining, setJoining] = useState(false);
  // The clock the waiting screen counts down with.
  const [now, setNow] = useState(() => Date.now());
  const attempt = useRef({ controller: new AbortController(), polling: false });
  function invalidate() {
    attempt.current.controller.abort();
    attempt.current = { controller: new AbortController(), polling: false };
  }
  useEffect(() => {
    let active = true;
    cloudPairingConfig()
      .then(async (value) => {
        if (!active) return;
        // Taken even when it cannot be used here, so it is never left waiting.
        const handed = takeAccountSignIn();
        if (
          !value?.webSignIn ||
          (value.webOrigin && new URL(window.location.href).origin !== value.webOrigin)
        )
          return;
        setConfig(value);
        // Only Omnesis account sign-in leads the page; the older Google pairing doesn't.
        if (value.accountSignIn) onReady?.();
        if (handed && automaticEnrollment(value)) {
          await adopt(handed, value, attempt.current);
          return;
        }
        const url = new URL(window.location.href);
        const id = url.searchParams.get("googlePairing");
        if (!id) return;
        url.searchParams.delete("googlePairing");
        window.history.replaceState(null, "", url);
        const pending = restoreCloudPairing(sessionStorage, id);
        if (!pending) {
          sessionStorage.removeItem(GOOGLE_PAIRING_STORAGE_KEY);
          setError("Sign-in expired or was cancelled. Please try again.");
          return;
        }
        if (pending.devicePublicKey) {
          await join(pending, attempt.current);
          return;
        }
        // The gateway started this request itself when sign-in returned. Its first answer
        // brings the nonce the code is made from, so no code is shown before that.
        setRequest(pending);
      })
      .catch(() => {});
    return () => {
      active = false;
      invalidate();
    };
  }, []);

  /**
   * A sign-in made on the Omnesis account page arrives with the device key and
   * request it was bound to, so this browser joins without signing in again.
   */
  async function adopt(encoded, value, current) {
    const handed = parseAccountSignIn(encoded);
    if (!handed || !/^[a-f0-9]{64}$/.test(value.gatewayFingerprint ?? "")) {
      setError("Couldn't finish signing in. Start again.");
      return;
    }
    const pending = {
      requestId: handed.requestId,
      name: handed.name,
      secret: handed.secret,
      gatewayFingerprint: value.gatewayFingerprint,
      expiresAt: Date.now() + 600_000,
      devicePublicKey: handed.devicePublicKey,
      gatewaySpkiFingerprint: value.gatewaySpkiFingerprint,
    };
    await join(pending, current, handed);
  }

  /**
   * Automatic enrollment: after the sign-in redirect, prove this browser's key
   * to this gateway. A trusted sign-in joins at once; anything else becomes the
   * usual held request with a comparison code. A sign-in handed over by the
   * account page brings its own key, attestation and proof.
   */
  async function join(pending, current, handed, passkey) {
    setJoining(true);
    setError(null);
    const signal = () => AbortSignal.any([current.controller.signal, AbortSignal.timeout(15_000)]);
    try {
      // An abandoned attempt aborts its signal, so each later request stops by itself.
      const key = handed
        ? await adoptDeviceKey(handed.privateKey, handed.devicePublicKey)
        : await loadDeviceKey();
      if (!key || key.publicKey !== pending.devicePublicKey)
        throw new Error("This browser's sign-in key changed. Start again.");
      // A passkey sign-in on this page already holds the challenge its assertion answers.
      const { challenge } = passkey ?? (await requestChallenge(signal()));
      if (typeof challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(challenge))
        throw new Error("Couldn't finish signing in. Start again.");
      const transcript = await enrollmentSignatureTranscript({
        requestId: pending.requestId,
        kind: "portal",
        name: pending.name,
        gatewaySpkiFingerprint: pending.gatewaySpkiFingerprint,
        challenge,
        devicePublicKey: pending.devicePublicKey,
      });
      const signature = await signEnrollment(key.privateKey, transcript);
      const response = await fetch("/devices/account/request", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: pending.requestId,
          kind: "portal",
          name: pending.name,
          secret: pending.secret,
          deviceKey: { publicKey: pending.devicePublicKey, challenge, signature },
          ...(handed ? { identityToken: handed.identityToken, proof: handed.proof } : {}),
          ...(passkey ? { proof: passkey.proof } : {}),
        }),
        signal: signal(),
      });
      if (response.status === 429) throw new Error(TOO_MANY_WAITING);
      if (passkey && response.status === 401) {
        // The gateway read the account's passkeys and this isn't one of them: most likely an
        // older account's, which the browser still offers.
        const refusal = await response.json().catch(() => null);
        throw new Error(
          refusal?.code === "PASSKEY_NOT_ON_ACCOUNT" ? PASSKEY_OTHER_ACCOUNT : NOT_RECOGNISED,
        );
      }
      if (!response.ok) throw new Error("Couldn't finish signing in. Start again.");
      const value = await response.json();
      if (current !== attempt.current) return;
      // The challenge fixed the gateway's nonce before it saw this browser's secret. A nonce
      // that does not match it, or a code that differs from the one worked out here, is refused.
      let verificationCode;
      try {
        if ((await cloudPairingCodeCommitment(value.codeNonce)) !== challenge) throw new Error();
        verificationCode = await cloudPairingVerificationCode(
          pending,
          pending.gatewayFingerprint,
          value.codeNonce,
        );
      } catch {
        throw new Error(CHANGED);
      }
      if (current !== attempt.current) return;
      if (
        value.verificationCode !== verificationCode ||
        !Number.isFinite(value.expiresAt) ||
        value.expiresAt <= Date.now()
      )
        throw new Error(CHANGED);
      // The gateway now knows this browser by the handed-over name, so later logins use it too.
      if (handed) setPortalDeviceName(pending.name);
      if (
        value.status === "approved" &&
        typeof value.pairingCode === "string" &&
        value.pairingCode
      ) {
        // The gateway's own checks admitted this browser; there is nothing for a person to compare.
        const signedIn = await login(value.pairingCode);
        if (!signedIn.ok) throw new Error("Couldn't sign this browser in. Start again.");
        sessionStorage.removeItem(GOOGLE_PAIRING_STORAGE_KEY);
        window.location.reload();
        return;
      }
      if (value.status !== "pending")
        throw new Error("Your gateway didn't accept this sign-in. Start again.");
      setJoining(false);
      setCode(verificationCode);
      setRequest({ ...pending, codeNonce: value.codeNonce });
    } catch (failure) {
      if (current !== attempt.current) return;
      sessionStorage.removeItem(GOOGLE_PAIRING_STORAGE_KEY);
      setJoining(false);
      setError(failure.message);
    }
  }

  /**
   * Signs in with a passkey here, on the gateway's own page: the gateway issues the challenge for
   * this browser's request, and the assertion goes back with the request itself. The relay takes
   * no part in it.
   */
  async function passkeySignIn() {
    if (busy) return;
    invalidate();
    const current = attempt.current;
    setBusy(true);
    setError(null);
    try {
      const key = await loadDeviceKey();
      const pending = newCloudPairing(portalDeviceName(), config.gatewayFingerprint, {
        devicePublicKey: key.publicKey,
        gatewaySpkiFingerprint: config.gatewaySpkiFingerprint,
      });
      const response = await fetch("/devices/account/passkey/options", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: pending.requestId,
          kind: "portal",
          name: pending.name,
          secret: pending.secret,
          devicePublicKey: pending.devicePublicKey,
        }),
        signal: AbortSignal.any([current.controller.signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) throw new Error("Couldn't start sign-in. Please try again.");
      const ceremony = await response.json();
      const proof = await gatewayPasskeyProof(ceremony, { signal: current.controller.signal });
      if (current !== attempt.current) return;
      setBusy(false);
      await join(pending, current, undefined, { challenge: ceremony.challenge, proof });
    } catch (failure) {
      if (current === attempt.current) {
        setError(failure.message);
        setBusy(false);
      }
    }
  }

  /** `method` is the button pressed, so the account page offers only that sign-in. */
  async function start(method) {
    if (busy) return;
    invalidate();
    const current = attempt.current;
    setBusy(true);
    setError(null);
    try {
      // A browser that can keep a device key may join without a comparison.
      const key = automaticEnrollment(config) ? await loadDeviceKey() : null;
      const pending = newCloudPairing(
        portalDeviceName(),
        config.gatewayFingerprint,
        key
          ? {
              devicePublicKey: key.publicKey,
              gatewaySpkiFingerprint: config.gatewaySpkiFingerprint,
            }
          : undefined,
      );
      const response = await fetch(
        config.accountSignIn ? "/devices/account/authorize" : "/devices/google/authorize",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId: pending.requestId,
            name: pending.name,
            secret: pending.secret,
            ...(pending.devicePublicKey ? { devicePublicKey: pending.devicePublicKey } : {}),
          }),
          signal: AbortSignal.any([current.controller.signal, AbortSignal.timeout(15_000)]),
        },
      );
      if (!response.ok) throw new Error("Couldn't start sign-in. Please try again.");
      const value = await response.json();
      if (current !== attempt.current) return;
      const destination = config.accountSignIn
        ? accountAuthorizationUrl(value.authorizationUrl, config.authorizationRelayOrigin, method)
        : googleAuthorizationUrl(value.authorizationUrl, config.authorizationRelayOrigin);
      sessionStorage.setItem(GOOGLE_PAIRING_STORAGE_KEY, JSON.stringify(pending));
      window.location.assign(destination);
    } catch (failure) {
      if (current === attempt.current) {
        setError(failure.message);
        setBusy(false);
      }
    }
  }

  async function poll() {
    if (!request || result?.status === "denied" || result?.status === "approved") return;
    if (request.expiresAt <= Date.now()) {
      setError("This pairing request expired. Sign in again.");
      cancel();
      return;
    }
    const current = attempt.current;
    if (current.polling) return;
    current.polling = true;
    try {
      const response = await fetch(
        config.accountSignIn ? "/devices/account/poll" : "/devices/google/poll",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: request.requestId, secret: request.secret }),
          signal: AbortSignal.any([current.controller.signal, AbortSignal.timeout(15_000)]),
        },
      );
      if (!response.ok) throw new Error("Couldn't check pairing approval. Please try again.");
      const value = await response.json();
      if (current !== attempt.current) return;
      let shown = code;
      if (request.codeNonce) {
        // The nonce never changes once a code is on screen.
        if (value.codeNonce !== request.codeNonce) throw changed();
      } else {
        try {
          shown = await cloudPairingVerificationCode(
            request,
            request.gatewayFingerprint,
            value.codeNonce,
          );
        } catch {
          throw changed();
        }
        if (current !== attempt.current) return;
      }
      if (
        value.verificationCode !== shown ||
        !["pending", "approved", "denied"].includes(value.status) ||
        !Number.isFinite(value.expiresAt) ||
        value.expiresAt <= Date.now()
      )
        throw changed();
      if (
        value.status === "approved" &&
        (typeof value.pairingCode !== "string" || !value.pairingCode)
      )
        throw new Error("The pairing approval was incomplete. Cancel and start again.");
      if (!request.codeNonce) {
        setCode(shown);
        setRequest({ ...request, codeNonce: value.codeNonce });
      }
      setResult(value);
      setError(null);
    } catch (failure) {
      if (current !== attempt.current) return;
      // A reply that does not add up ends the attempt, and its code leaves the screen.
      if (failure.changed) cancel();
      setError(failure.message);
    } finally {
      current.polling = false;
    }
  }
  useEffect(() => {
    if (request) poll();
  }, [request]);
  useVisiblePoll(poll, 3000);

  function cancel() {
    invalidate();
    sessionStorage.removeItem(GOOGLE_PAIRING_STORAGE_KEY);
    setRequest(null);
    setResult(null);
    setCode("");
  }
  /**
   * Approves this browser's own held request with the owner's passkey, here on the gateway's
   * page. The browser signs for its request too, so only the browser that asked can do this.
   */
  async function approveHere() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const key = await loadDeviceKey();
      if (!key || key.publicKey !== request.devicePublicKey)
        throw new Error("This browser's sign-in key changed. Start again.");
      await approveWithPasskey({ requestId: request.requestId, deviceKey: key.privateKey });
      setBusy(false);
      await poll();
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }
  // A browser with its own device key continues by itself once approved: it already checked the
  // gateway's code and nonce against its own, and the person compared the code where they
  // approved. The older keyless pairing keeps its explicit button.
  useEffect(() => {
    if (request?.devicePublicKey && result?.status === "approved") pair();
  }, [result]);
  useEffect(() => {
    if (!request) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [request]);

  async function pair() {
    if (
      busy ||
      result?.status !== "approved" ||
      request.expiresAt <= Date.now() ||
      result.expiresAt <= Date.now()
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const response = await login(result.pairingCode);
      if (!response.ok) throw new Error("Couldn't pair this browser. Start a new pairing request.");
      sessionStorage.removeItem(GOOGLE_PAIRING_STORAGE_KEY);
      window.location.reload();
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }
  if (!config) return null;
  // Without account sign-in this is the older Google-only pairing.
  const signInLabel = config.accountSignIn ? "Omnesis account sign-in" : "Google sign-in";
  if (joining)
    return html`<section class="cloud-pairing-login" aria-label=${signInLabel}>
      <h2>Signing you in…</h2>
      <p class="login-hint" role="status">Checking this browser with your gateway.</p>
    </section>`;
  if (request && !code)
    return html`<section class="cloud-pairing-login" aria-label=${signInLabel}>
      <h2>Signing you in…</h2>
      <p class="login-hint" role="status">Checking this browser with your gateway.</p>
      ${error && html`<p class="login-error" role="alert">${error}</p>`}
      <button type="button" class="btn-secondary" onClick=${cancel}>Cancel</button>
    </section>`;
  // A passkey button only for an account that has one; on the gateway's own page it signs in here.
  const passkeyHere = gatewayPasskeyHere(config);
  const passkey = config.accountSignIn && config.accountPasskey === true;
  const expiresAt = result?.expiresAt ?? request?.expiresAt ?? 0;
  const left = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const countdown = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  const keyed = Boolean(request?.devicePublicKey);
  return html`<section class="cloud-pairing-login" aria-label=${signInLabel}>
    ${
      !request
        ? html`
            ${config.accountSignIn && html`<h2>${LOGIN_COPY.title}</h2>`}
            ${
              passkey &&
              html`<button
                type="button"
                class="login-button"
                disabled=${busy}
                onClick=${passkeyHere ? passkeySignIn : () => start("passkey")}
              >
                ${busy ? (passkeyHere ? LOGIN_COPY.waitingForPasskey : LOGIN_COPY.opening) : LOGIN_COPY.passkey}
              </button>`
            }
            <button
              type="button"
              class="login-button google-sign-in-button"
              disabled=${busy}
              onClick=${() => start("google")}
            >
              <img
                src="/portal/img/google-sign-in-mark.png"
                width="20"
                height="20"
                alt=""
                aria-hidden="true"
              />
              <span
                >${busy ? (config.accountSignIn ? LOGIN_COPY.opening : LOGIN_COPY.openingGoogle) : LOGIN_COPY.google}</span
              >
            </button>
            <p class="login-hint">${LOGIN_COPY.googleHint}</p>
          `
        : html`
            <h2>${LOGIN_COPY.waitingTitle}</h2>
            <p>${LOGIN_COPY.waitingBody}</p>
            <code class="cloud-pairing-code">${code}</code>
            <p class="login-hint">${LOGIN_COPY.codeHint}</p>
            <p aria-live="polite">
              ${
                result?.status === "approved"
                  ? keyed
                    ? LOGIN_COPY.approved
                    : LOGIN_COPY.approvedCompare
                  : result?.status === "denied"
                    ? LOGIN_COPY.denied
                    : LOGIN_COPY.expiresIn(countdown)
              }
            </p>
            ${
              passkeyHere &&
              config.passkeyApproval === true &&
              keyed &&
              result?.status !== "approved" &&
              result?.status !== "denied" &&
              html`<button
                type="button"
                class="login-button"
                disabled=${busy}
                onClick=${approveHere}
              >
                ${busy ? LOGIN_COPY.waitingForPasskey : LOGIN_COPY.approveHere}
              </button>`
            }
            ${
              !keyed &&
              html`<button
                type="button"
                class="login-button"
                disabled=${busy || result?.status !== "approved"}
                onClick=${pair}
              >
                ${busy ? LOGIN_COPY.pairing : LOGIN_COPY.pair}
              </button>`
            }
            <button type="button" class="btn-secondary" disabled=${busy} onClick=${cancel}>
              ${LOGIN_COPY.cancel}
            </button>
          `
    }
    ${error && html`<p class="login-error" role="alert">${error}</p>`}
  </section>`;
}
