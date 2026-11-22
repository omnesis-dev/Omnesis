// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// "Finish setting up": the last step of connecting this gateway to an Omnesis account, shown on
// the account page until something is confirmed here. It follows the account. With a passkey, the
// owner uses it once on this gateway's own page (`pin-passkey`); from any other address one button
// opens that page already signed in and starts the prompt there. Without one, the step offers to
// add a passkey on the account page, which then comes back here for that same last prompt. Phones
// are added from Settings → Devices.
//
// Which step is shown comes from what the relay lists, so it only decides the words: a relay that
// lies can make the step fail, never make anything confirmed.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { apiFetch } from "../api.js";
import { relayManagement, relayError, relayHttpsUrl } from "../lib/cloud-relay-api.js";
import { takeHandoffNext } from "../lib/cloud-pairing-handoff.js";
import {
  GatewayPasskeyError,
  gatewayPasskeyProof,
  onGatewayOrigin,
  PASSKEY_CHECK_FAILED,
  PASSKEY_HINT,
  PASSKEY_OTHER_ACCOUNT,
  passkeysSupported,
} from "../lib/gateway-passkey.js";

/** Every sentence the checklist says, in one place so the wording is easy to change. */
export const SETUP_COPY = {
  title: "Finish setting up",
  account: "Omnesis account",
  accountDone: "Connected",
  address: "Secure address",
  addressWaiting: "Getting a secure address… usually under a minute",
  passkeyStep: "Let your passkey add devices",
  passkeyBody:
    "Use your passkey once on your gateway's secure address. After that, a new device that signs in with it connects straight away.",
  passkeyHint: PASSKEY_HINT,
  passkeyButton: "Continue with passkey",
  passkeyWorking: "Waiting for your passkey…",
  opening: "Opening…",
  openFailed: "Couldn't open your gateway's secure address. Try again.",
  noPasskeys: "This browser can't use passkeys. Open this page in a browser that can.",
  startFailed: "Couldn't use your passkey. Try again.",
  addStep: "Add a passkey (optional)",
  addBody:
    "Once you have used a passkey here, a new device that signs in with it on this gateway's secure address joins without waiting for your OK. Adding one takes three steps: create it, confirm with a sign-in you already use, then use it once here.",
  addButton: "Add a passkey",
  addWaiting:
    "Finish adding the passkey on the Omnesis account page that opened, then come back to this page.",
  addingStep: "Adding a passkey · step 3 of 3",
  addingBody:
    "Use your new passkey once on your gateway's secure address. After that, a new device that signs in with it connects straight away.",
  notNow: "Not now",
  reminder: "New devices wait for your OK until you finish setup.",
  finish: "Finish setup",
};

/** Asks the page opened by a handoff to start the passkey prompt as soon as it loads. */
export const CONFIRM_ON_LOAD = "confirm-passkey";
/** Set in this browser while a passkey this step started adding waits for its last prompt here. */
const ADDING_KEY = "omnesis.relay.adding-passkey";

/** Whether this browser started adding a passkey from the setup step and hasn't finished. */
export function addingPasskey(storage = globalThis.sessionStorage) {
  try {
    return storage?.getItem(ADDING_KEY) === "1";
  } catch {
    return false;
  }
}
function rememberAdding(value, storage = globalThis.sessionStorage) {
  try {
    if (value) storage?.setItem(ADDING_KEY, "1");
    else storage?.removeItem(ADDING_KEY);
  } catch {
    // Without storage the last step reads as setup's usual passkey step.
  }
}

/**
 * Which last step setup still needs, on a gateway with a page of its own to use a passkey on:
 * `"passkey"` when the account has a passkey this gateway knows, `"add-passkey"` when it has none
 * yet and the gateway adds devices automatically. Null once anything is confirmed, under "ask me
 * first" with no passkey (every device waits by choice), and on a gateway with no page of its own
 * (a custom domain), where no passkey can be used: its devices are approved from Devices.
 */
export function accountConfirmation(enrollment) {
  if (!enrollment?.confirmOrigin || (enrollment.confirmedSignIns ?? []).length > 0) return null;
  if ((enrollment.trustedSignIns ?? []).some((signIn) => signIn.type === "passkey"))
    return "passkey";
  return enrollment.policy === "automatic" ? "add-passkey" : null;
}

/**
 * Opens the gateway's own page already signed in: the gateway hands this session a one-use link
 * (routes/portal-handoff.ts) carried in the URL fragment. Only a link to `origin` is followed.
 */
export async function openOnGateway(
  origin,
  { next, request = apiFetch, location = globalThis.location } = {},
) {
  const response = await request("/portal/api/handoff", {
    method: "POST",
    body: JSON.stringify(next ? { next } : {}),
  });
  if (!response.ok) throw new Error(SETUP_COPY.openFailed);
  const { url } = await response.json();
  const safe = relayHttpsUrl(url);
  if (!safe || new URL(safe).origin !== origin) throw new Error(SETUP_COPY.openFailed);
  location.assign(safe);
}

function Step({ done, number, title, detail, children }) {
  return html`<li class=${`relay-setup-step${done ? " relay-setup-done" : ""}`}>
    <span class="relay-setup-mark" aria-hidden="true">${done ? "✓" : number}</span>
    <div class="relay-setup-body">
      <p class="relay-row-value relay-strong">
        ${title}${detail && html`${" "}<span class="relay-setup-detail">${detail}</span>`}
      </p>
      ${children}
    </div>
  </li>`;
}

function PasskeyStep({ enrollment, ready, busy, run, request, prove, open, location, supported, adding, onDismiss }) {
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const origin = enrollment.confirmOrigin;
  const here = onGatewayOrigin(origin, location);
  const held = Boolean(working) || (Boolean(busy) && busy !== "refresh");
  const confirm = async (auto) => {
    setWorking("confirm");
    setError("");
    try {
      const ceremony = await request("passkeys/confirm/options", {});
      const proof = await prove(ceremony, { location });
      await request("passkeys/confirm", { proof });
      rememberAdding(false);
      // The page's own status refresh ends setup.
      await run();
    } catch (failure) {
      // A prompt that started by itself and was closed just leaves the button.
      if (auto && failure instanceof GatewayPasskeyError) return;
      setError(
        failure?.code === "passkey-not-on-account"
          ? PASSKEY_OTHER_ACCOUNT
          : failure?.code === "passkey-not-confirmed"
            ? PASSKEY_CHECK_FAILED
            : failure instanceof GatewayPasskeyError
              ? failure.message
              : relayError(failure?.code) || SETUP_COPY.startFailed,
      );
    } finally {
      setWorking("");
    }
  };
  // Opened by the button on another address: start the prompt straight away, once.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !here || !supported) return;
    started.current = true;
    if (takeHandoffNext() === CONFIRM_ON_LOAD) void confirm(true);
  }, [here, supported]);
  const openHere = async () => {
    setWorking("open");
    setError("");
    try {
      await open(origin, { next: CONFIRM_ON_LOAD, location });
    } catch {
      setError(SETUP_COPY.openFailed);
      setWorking("");
    }
  };
  return html`<p class="relay-hint">${adding ? SETUP_COPY.addingBody : SETUP_COPY.passkeyBody}</p>
    ${
      here && !supported
        ? html`<p class="relay-hint">${SETUP_COPY.noPasskeys}</p>`
        : html`<p class="relay-hint">${SETUP_COPY.passkeyHint}</p>
          <div class="relay-actions">
            <button
              type="button"
              class="btn-primary"
              disabled=${held || (!here && !ready)}
              onClick=${() => (here ? confirm(false) : openHere())}
            >
              ${
                working === "confirm"
                  ? SETUP_COPY.passkeyWorking
                  : working === "open"
                    ? SETUP_COPY.opening
                    : SETUP_COPY.passkeyButton
              }
            </button>
            <button type="button" class="relay-quiet" onClick=${onDismiss}>${SETUP_COPY.notNow}</button>
          </div>`
    }
    ${error && html`<p role="alert" class="relay-notice">${error}</p>`}`;
}

/**
 * No passkey yet: one button opens the account page, which adds a passkey in two steps and sends
 * the person back here for the third. This page notices the new passkey when it is shown again.
 */
function AddPasskeyStep({ serviceUrl, onDismiss }) {
  const [started, setStarted] = useState(false);
  const service = relayHttpsUrl(serviceUrl);
  const href = service && `${new URL("/_relay/account", service).href}?add=passkey`;
  return html`<p class="relay-hint">${SETUP_COPY.addBody}</p>
    <div class="relay-actions">
      ${
        href &&
        html`<a
          class="btn-primary relay-button-link"
          href=${href}
          target="_blank"
          rel="noopener noreferrer"
          onClick=${() => {
            rememberAdding(true);
            setStarted(true);
          }}
          >${SETUP_COPY.addButton}</a
        >`
      }
      <button type="button" class="relay-quiet" onClick=${onDismiss}>${SETUP_COPY.notNow}</button>
    </div>
    ${started && html`<p class="relay-hint" role="status">${SETUP_COPY.addWaiting}</p>`}`;
}

/**
 * The setup checklist. `ready` says the secure address has its certificate, so the gateway's own
 * page can be opened.
 */
export function FinishSetup({
  enrollment,
  ready,
  serviceUrl,
  busy,
  run,
  onDismiss,
  request = relayManagement,
  prove = gatewayPasskeyProof,
  open = openOnGateway,
  location = globalThis.location,
  supported = passkeysSupported(),
}) {
  const kind = accountConfirmation(enrollment);
  if (!kind) return null;
  const adding = kind === "passkey" && addingPasskey();
  const host = new URL(enrollment.confirmOrigin).host;
  return html`<section class="relay-setup" aria-labelledby="relay-setup-title">
    <h2 class="relay-headline" id="relay-setup-title">${SETUP_COPY.title}</h2>
    <ol class="relay-setup-steps">
      <${Step} done=${true} number="1" title=${SETUP_COPY.account} detail=${SETUP_COPY.accountDone} />
      <${Step}
        done=${ready}
        number="2"
        title=${SETUP_COPY.address}
        detail=${ready ? host : SETUP_COPY.addressWaiting}
      />
      <${Step}
        number="3"
        title=${
          kind === "passkey"
            ? adding
              ? SETUP_COPY.addingStep
              : SETUP_COPY.passkeyStep
            : SETUP_COPY.addStep
        }
      >
        ${
          kind === "passkey"
            ? html`<${PasskeyStep}
                enrollment=${enrollment}
                ready=${ready}
                busy=${busy}
                run=${run}
                request=${request}
                prove=${prove}
                open=${open}
                location=${location}
                supported=${supported}
                adding=${adding}
                onDismiss=${onDismiss}
              />`
            : html`<${AddPasskeyStep} serviceUrl=${serviceUrl} onDismiss=${onDismiss} />`
        }
      <//>
    </ol>
  </section>`;
}

/** What New devices says while setup waits: one amber line and the way back to it. */
export function SetupReminder({ onFinish }) {
  return html`<p class="relay-notice relay-setup-reminder" role="status">
    ${SETUP_COPY.reminder}${" "}
    <button type="button" class="relay-quiet" onClick=${onFinish}>${SETUP_COPY.finish}</button>
  </p>`;
}
