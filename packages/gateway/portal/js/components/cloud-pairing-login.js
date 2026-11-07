// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { login } from "../api.js";
import { cloudPairingConfig } from "../lib/cloud-pairing-api.js";
import { portalDeviceName } from "../lib/storage.js";
import { cloudPairingVerificationCode, GOOGLE_PAIRING_STORAGE_KEY, googleAuthorizationUrl,
  newCloudPairing, restoreCloudPairing } from "../lib/cloud-pairing.js";
import { useVisiblePoll } from "../lib/use-visible-poll.js";

export function CloudPairingLogin() {
  const [config, setConfig] = useState(null);
  const [request, setRequest] = useState(null);
  const [code, setCode] = useState("");
  const [result, setResult] = useState(null);
  const [compared, setCompared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const attempt = useRef({ controller: new AbortController(), polling: false });
  function invalidate() {
    attempt.current.controller.abort();
    attempt.current = { controller: new AbortController(), polling: false };
  }
  useEffect(() => {
    let active = true;
    cloudPairingConfig().then(async (value) => {
      if (!active || !value?.webSignIn || (value.webOrigin && new URL(window.location.href).origin !== value.webOrigin)) return;
      setConfig(value);
      const url = new URL(window.location.href);
      const id = url.searchParams.get("googlePairing");
      if (!id) return;
      url.searchParams.delete("googlePairing");
      window.history.replaceState(null, "", url);
      const pending = restoreCloudPairing(sessionStorage, id);
      if (!pending) {
        sessionStorage.removeItem(GOOGLE_PAIRING_STORAGE_KEY);
        setError("Google sign-in expired or was cancelled. Please try again.");
        return;
      }
      const restoring = attempt.current;
      const verificationCode = await cloudPairingVerificationCode(pending, pending.gatewayFingerprint);
      if (!active || restoring !== attempt.current) return;
      setCode(verificationCode);
      setRequest(pending);
    }).catch(() => {});
    return () => { active = false; invalidate(); };
  }, []);

  async function start() {
    if (busy) return;
    invalidate();
    const current = attempt.current;
    setBusy(true); setError(null);
    try {
      const pending = newCloudPairing(portalDeviceName(), config.gatewayFingerprint);
      const response = await fetch("/devices/google/authorize", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: pending.requestId, name: pending.name, secret: pending.secret }),
        signal: AbortSignal.any([current.controller.signal, AbortSignal.timeout(15_000)]) });
      if (!response.ok) throw new Error("Couldn't start Google sign-in. Please try again.");
      const value = await response.json();
      if (current !== attempt.current) return;
      const destination = googleAuthorizationUrl(value.authorizationUrl, config.authorizationRelayOrigin);
      sessionStorage.setItem(GOOGLE_PAIRING_STORAGE_KEY, JSON.stringify(pending));
      window.location.assign(destination);
    } catch (failure) { if (current === attempt.current) { setError(failure.message); setBusy(false); } }
  }

  async function poll() {
    if (!request || result?.status === "denied" || result?.status === "approved") return;
    if (request.expiresAt <= Date.now()) {
      setError("This pairing request expired. Start Google sign-in again.");
      cancel(); return;
    }
    const current = attempt.current;
    if (current.polling) return;
    current.polling = true;
    try {
      const response = await fetch("/devices/google/poll", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: request.requestId, secret: request.secret }),
        signal: AbortSignal.any([current.controller.signal, AbortSignal.timeout(15_000)]) });
      if (!response.ok) throw new Error("Couldn't check pairing approval. Please try again.");
      const value = await response.json();
      if (current !== attempt.current) return;
      if (value.verificationCode !== code || !["pending", "approved", "denied"].includes(value.status) ||
        !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now())
        throw new Error("The gateway or pairing request changed. Cancel and start again.");
      if (value.status === "approved" && (typeof value.pairingCode !== "string" || !value.pairingCode))
        throw new Error("The pairing approval was incomplete. Cancel and start again.");
      setResult(value); setError(null);
    } catch (failure) { if (current === attempt.current) setError(failure.message); }
    finally { current.polling = false; }
  }
  useEffect(() => { if (request && code) poll(); }, [request, code]);
  useVisiblePoll(poll, 3000);

  function cancel() {
    invalidate();
    sessionStorage.removeItem(GOOGLE_PAIRING_STORAGE_KEY);
    setRequest(null); setResult(null); setCode(""); setCompared(false);
  }
  async function pair() {
    if (busy || !compared || result?.status !== "approved" || request.expiresAt <= Date.now() ||
      result.expiresAt <= Date.now()) return;
    setBusy(true); setError(null);
    try {
      const response = await login(result.pairingCode);
      if (!response.ok) throw new Error("Couldn't pair this browser. Start a new pairing request.");
      sessionStorage.removeItem(GOOGLE_PAIRING_STORAGE_KEY);
      window.location.reload();
    } catch (failure) { setError(failure.message); setBusy(false); }
  }
  if (!config) return null;
  return html`<section class="cloud-pairing-login" aria-label="Google sign-in">
    ${!request ? html`
      <button type="button" class="login-button google-sign-in-button" disabled=${busy} onClick=${start}>
        <img src="/portal/img/google-sign-in-mark.png" width="20" height="20" alt="" aria-hidden="true" />
        <span>${busy ? "Opening Google…" : "Continue with Google"}</span>
      </button>
      <p class="login-hint">Optional. Your gateway still needs to approve this browser.</p>
    ` : html`
      <h2>Confirm this browser</h2>
      <p>Open Settings → Devices in the gateway's local portal, or use its trusted terminal. Compare every group of this code before approving.</p>
      <code class="cloud-pairing-code">${code}</code>
      <label class="cloud-pairing-compare">
        <input type="checkbox" checked=${compared} disabled=${busy}
          onChange=${(event) => setCompared(event.target.checked)} />
        I compared the code on my trusted device and it matches.
      </label>
      <p aria-live="polite">${result?.status === "approved" ? "Approved by your gateway." :
        result?.status === "denied" ? "Your gateway denied this request." : "Waiting for gateway approval…"}</p>
      <p class="login-hint">This browser trusts the HTTPS certificate for this address. The domain administrator remains part of that trust.</p>
      <button type="button" class="login-button" disabled=${busy || !compared || result?.status !== "approved"}
        onClick=${pair}>${busy ? "Pairing…" : "Pair this browser"}</button>
      <button type="button" class="btn-secondary" disabled=${busy} onClick=${cancel}>Cancel</button>
    `}
    ${error && html`<p class="login-error" role="alert">${error}</p>`}
  </section>`;
}
