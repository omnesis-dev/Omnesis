// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// "Confirm your passkey on this gateway": the owner uses their Omnesis account passkey once on
// this gateway's own page, so the gateway can trust it without taking the relay's word for it.
// Shown on the account page, which is where linking a gateway returns to.

import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { relayManagement, relayError } from "../lib/cloud-relay-api.js";
import {
  GatewayPasskeyError,
  gatewayPasskeyProof,
  onGatewayOrigin,
  passkeysSupported,
} from "../lib/gateway-passkey.js";

/** Whether the owner still has a passkey to confirm here: none confirmed yet, and a place to do it. */
export function passkeyConfirmationNeeded(enrollment) {
  return Boolean(
    enrollment?.confirmOrigin &&
      !(enrollment.confirmedSignIns ?? []).some((signIn) => signIn.type === "passkey"),
  );
}

export function GatewayPasskeyConfirm({
  enrollment,
  busy,
  run,
  request = relayManagement,
  prove = gatewayPasskeyProof,
  location = globalThis.location,
  supported = passkeysSupported(),
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const origin = enrollment.confirmOrigin;
  const here = onGatewayOrigin(origin, location);
  const confirm = async () => {
    setWorking(true);
    setError("");
    try {
      const ceremony = await request("passkeys/confirm/options", {});
      const proof = await prove(ceremony, { location });
      // The page's own status refresh shows the result; a refusal is said here.
      if (!(await run("passkeys/confirm", { proof })))
        setError(
          "This gateway couldn't confirm that passkey. Use the passkey of the Omnesis account this gateway is linked to.",
        );
    } catch (failure) {
      setError(
        failure instanceof GatewayPasskeyError
          ? failure.message
          : relayError(failure?.code) || "Couldn't start the passkey check. Try again.",
      );
    } finally {
      setWorking(false);
    }
  };
  return html`<div class="relay-confirm" role="group" aria-labelledby="relay-passkey-confirm-title">
    <p class="relay-row-value relay-strong" id="relay-passkey-confirm-title">
      Confirm your passkey on this gateway
    </p>
    <p class="relay-hint">
      Use your Omnesis passkey once, here on this gateway's own page. The gateway then knows the
      passkey is yours without relying on the Omnesis relay. Until you do, every new device waits
      for your approval.
    </p>
    <p class="relay-hint">
      Devices that already joined by signing in are marked “Joined with Omnesis account” in${" "}
      <a href="/portal/settings/devices">Devices</a>. Remove any you don't recognise.
    </p>
    ${
      !here
        ? html`<p class="relay-hint">
            Open this page at${" "}
            <a href=${`${origin}/portal/settings/account`}>${new URL(origin).host}</a> to confirm.
          </p>`
        : !supported
          ? html`<p class="relay-hint">This browser can't use passkeys.</p>`
          : html`<div class="relay-actions">
              <button
                type="button"
                class="btn-primary"
                disabled=${working || (Boolean(busy) && busy !== "refresh")}
                onClick=${confirm}
              >
                ${working ? "Waiting for your passkey…" : "Confirm with passkey"}
              </button>
            </div>`
    }
    ${error && html`<p role="alert" class="relay-notice">${error}</p>`}
  </div>`;
}
