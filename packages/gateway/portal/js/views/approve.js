// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// /portal/approve#<requestId>: approve a device waiting to join, with your Omnesis passkey, on this
// gateway's own page. No portal login is needed: the passkey the owner confirmed on this gateway
// is the credential, and the gateway checks it for exactly this request, device and code.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { loadDeviceKey } from "../lib/device-key-store.js";
import { approveWithPasskey, GatewayPasskeyError } from "../lib/gateway-passkey.js";

const REQUEST_ID = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const KIND_LABELS = {
  ios: "iOS app",
  android: "Android app",
  collector: "Collector",
  cli: "CLI",
  portal: "Browser",
};

/** The request id the link names, from the fragment, which never reaches a server's logs. */
export function approvalRequestId(location = globalThis.location) {
  const id = String(location?.hash ?? "").replace(/^#/, "");
  return REQUEST_ID.test(id) ? id : null;
}

export function ApproveView({
  requestId = approvalRequestId(),
  approve = approveWithPasskey,
  deviceKey = loadDeviceKey,
}) {
  const [request, setRequest] = useState(null);
  const [state, setState] = useState(requestId ? "loading" : "missing");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!requestId) return;
    let active = true;
    fetch(`/devices/account/approval/${requestId}`, { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!active) return;
        if (!response.ok) return setState("missing");
        setRequest(await response.json());
        setState("ready");
      })
      .catch(() => active && setState("missing"));
    return () => {
      active = false;
    };
  }, [requestId]);
  const confirm = async () => {
    setState("approving");
    setError("");
    try {
      let key;
      if (request.deviceKeyRequired) {
        key = (await deviceKey())?.privateKey;
        if (!key)
          throw new GatewayPasskeyError("Open this link in the browser that asked to join.");
      }
      await approve({ requestId, ...(key ? { deviceKey: key } : {}) });
      setState("approved");
    } catch (failure) {
      setError(
        failure instanceof GatewayPasskeyError ? failure.message : "Couldn't approve. Try again.",
      );
      setState("ready");
    }
  };
  return html`<div class="login-container">
    <div class="login-card approve-card">
      <h1 class="login-title">Approve a new device</h1>
      ${
        state === "missing"
          ? html`<p class="login-subtitle">
              Nothing is waiting for approval at this link. The request may have been approved,
              denied or have expired.
            </p>`
          : state === "loading"
            ? html`<p class="login-subtitle" role="status">Loading the request…</p>`
            : state === "approved"
              ? html`<p class="login-subtitle" role="status">
                  Approved. ${request.name} can finish joining now.
                </p>`
              : html`
                  <p class="login-subtitle">
                    <strong>${request.name}</strong> (${KIND_LABELS[request.kind] ?? request.kind})
                    asked to join this gateway at${" "}
                    ${new Date(request.createdAt).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}.
                  </p>
                  ${
                    request.revokedDevice &&
                    html`<p class="cloud-pairing-revoked">
                      You revoked this device earlier. Approve only if it is back in your hands.
                    </p>`
                  }
                  <code class="cloud-pairing-code">${request.verificationCode}</code>
                  <p class="login-hint">
                    Approve only if you asked for this yourself and the device shows this same
                    code. Anyone who sent you this link could be asking for their own device.
                  </p>
                  <button
                    type="button"
                    class="login-button"
                    disabled=${state === "approving"}
                    onClick=${confirm}
                  >
                    ${state === "approving" ? "Waiting for your passkey…" : "Approve with passkey"}
                  </button>
                `
      }
      ${error && html`<p class="login-error" role="alert">${error}</p>`}
    </div>
  </div>`;
}
