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

const NOT_RECOGNISED =
  "Your gateway didn't recognise that passkey. Use the passkey of the Omnesis account it's linked to, or sign in on the Omnesis account page.";
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

export function CloudPairingLogin() {
  const [config, setConfig] = useState(null);
  const [request, setRequest] = useState(null);
  const [code, setCode] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [joining, setJoining] = useState(false);
  // Set once the owner approved this browser's own request here: it then logs in by itself.
  const approvedHere = useRef(false);
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
      if (passkey && response.status === 401) throw new Error(NOT_RECOGNISED);
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

  async function start() {
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
      const destination = (config.accountSignIn ? accountAuthorizationUrl : googleAuthorizationUrl)(
        value.authorizationUrl,
        config.authorizationRelayOrigin,
      );
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
      approvedHere.current = true;
      setBusy(false);
      await poll();
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }
  useEffect(() => {
    if (approvedHere.current && result?.status === "approved") pair();
  }, [result]);

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
  return html`<section class="cloud-pairing-login" aria-label=${signInLabel}>
    ${
      !request
        ? html`
            ${config.accountSignIn && html`<h2>Sign in with your Omnesis account</h2>`}
            ${
              gatewayPasskeyHere(config)
                ? html`<button type="button" class="login-button" disabled=${busy} onClick=${passkeySignIn}>${busy ? "Waiting for your passkey…" : "Sign in with Passkey"}</button>
                    <button type="button" class="btn-secondary" disabled=${busy} onClick=${start}>Sign in on the Omnesis account page</button>`
                : config.accountSignIn &&
                  html`<button type="button" class="login-button" disabled=${busy} onClick=${start}>${busy ? "Opening sign-in…" : "Sign in with Passkey"}</button>`
            }
            <button
              type="button"
              class="login-button google-sign-in-button"
              disabled=${busy}
              onClick=${start}
            >
              <img
                src="/portal/img/google-sign-in-mark.png"
                width="20"
                height="20"
                alt=""
                aria-hidden="true"
              />
              <span
                >${busy ? (config.accountSignIn ? "Opening sign-in…" : "Opening Google…") : "Sign in with Google"}</span
              >
            </button>
            <p class="login-hint">
              ${
                config.automaticEnrollment
                  ? "Optional. Depending on your gateway's settings, this browser joins right away or waits for your approval."
                  : "Optional. Your gateway still needs to approve this browser."
              }
            </p>
          `
        : html`
            <h2>Confirm this browser</h2>
            <p>
              Check that this code matches the one shown on your other device, then approve it
              there.
            </p>
            <code class="cloud-pairing-code">${code}</code>
            <p aria-live="polite">
              ${
                result?.status === "approved"
                  ? "Approved by your gateway."
                  : result?.status === "denied"
                    ? "Your gateway denied this request."
                    : "Waiting for approval on a trusted device…"
              }
            </p>
            <p class="login-hint">
              No paired phone? Use the portal on your gateway computer. Requests expire after a
              short time.
            </p>
            <p class="login-hint">
              This browser trusts the HTTPS certificate for this address. The domain administrator
              remains part of that trust.
            </p>
            ${
              gatewayPasskeyHere(config) &&
              request.devicePublicKey &&
              result?.status !== "approved" &&
              result?.status !== "denied" &&
              html`<button
                type="button"
                class="login-button"
                disabled=${busy}
                onClick=${approveHere}
              >
                ${busy ? "Waiting for your passkey…" : "Approve with your passkey"}
              </button>`
            }
            <button
              type="button"
              class="login-button"
              disabled=${busy || result?.status !== "approved"}
              onClick=${pair}
            >
              ${busy ? "Pairing…" : "Codes match, pair this device"}
            </button>
            <button type="button" class="btn-secondary" disabled=${busy} onClick=${cancel}>
              Cancel
            </button>
          `
    }
    ${error && html`<p class="login-error" role="alert">${error}</p>`}
  </section>`;
}
