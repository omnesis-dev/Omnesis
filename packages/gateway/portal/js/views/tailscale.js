// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Settings → Tailscale: the gateway's own device on the owner's Tailscale
// network. Only rendered when the gateway runs with
// OMNESIS_TAILSCALE_EMBED_ENABLED=1, which `/status` advertises as
// `tailscaleEmbed: true`.
//
// The page is written for an owner who is not a networking expert. A pill
// says what state the device is in and one panel says what to do about it,
// with the device's name, signing out and turning off at its foot. Below it
// come the public address for cloud agents and what happens when one of the
// owner's own devices asks to join; a request that waits for the owner is
// decided on Settings → Devices, with every other device waiting for an OK.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { ConfirmModal } from "../components/confirm-modal.js";
import { QrCanvas } from "../components/qr-canvas.js";
import {
  TAILSCALE_ADMIN,
  setTailscaleEnabled,
  tailscaleHttpsUrl,
  tailscaleSignIn,
  tailscaleSignOut,
  updateTailscaleSettings,
} from "../lib/tailscale-api.js";
import { useTailscaleAdmin } from "../lib/use-tailscale-admin.js";

/** The one state the device is in, from the gateway's report. */
export function tailscalePhase(state) {
  if (!state) return "loading";
  if (!state.enabled) return "off";
  if (state.helper?.state === "unavailable") return "unavailable";
  if (state.helper?.state === "restarting") return "restarting";
  switch (state.connection) {
    case "needs-sign-in":
    case "needs-approval":
    case "connected":
    case "stopped":
      return state.connection;
    default:
      return "starting";
  }
}

const PILLS = {
  off: { label: "Off", tone: "muted" },
  starting: { label: "Starting", tone: "progress" },
  "needs-sign-in": { label: "Sign in needed", tone: "warning" },
  "needs-approval": { label: "Waiting for approval", tone: "warning" },
  connected: { label: "Connected", tone: "ok" },
  unavailable: { label: "Problem", tone: "danger" },
  restarting: { label: "Problem", tone: "danger" },
  stopped: { label: "Problem", tone: "danger" },
};

function StatusPill({ phase }) {
  const pill = PILLS[phase];
  if (!pill) return null;
  return html`<span class=${`tailscale-pill tailscale-pill-${pill.tone}`}>
    <span class="tailscale-pill-dot" aria-hidden="true"></span>${pill.label}
  </span>`;
}

/** A link styled as a button that opens outside the portal. */
function OutLink({ href, primary = false, children }) {
  return html`<a
    class=${`${primary ? "btn-primary" : "btn-secondary"} tailscale-button-link`}
    href=${href}
    target="_blank"
    rel="noopener noreferrer"
    >${children}</a
  >`;
}

/** A value to copy, in a read-only field so it can be selected when the clipboard is refused. */
function CopyField({ id, value, label }) {
  const input = useRef(null);
  const timer = useRef(null);
  const [copied, setCopied] = useState("");
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setCopied("yes");
      timer.current = setTimeout(() => setCopied(""), 1500);
    } catch {
      input.current?.focus();
      input.current?.select();
      setCopied("manual");
    }
  };
  return html`<div class="tailscale-copy">
      <input
        ref=${input}
        id=${id}
        class="tailscale-copy-input"
        type="text"
        readonly
        value=${value}
        aria-label=${label}
        onFocus=${(event) => event.currentTarget.select()}
      />
      <button type="button" class="btn-secondary tailscale-copy-button" onClick=${copy}>
        ${copied === "yes" ? "Copied" : "Copy"}
      </button>
    </div>
    ${copied === "manual" &&
    html`<p class="tailscale-hint" role="status">Selected. Press Ctrl+C (⌘C on a Mac) to copy.</p>`}`;
}

function Row({ label, children }) {
  return html`<div class="tailscale-row">
    <div class="tailscale-row-label">${label}</div>
    <div class="tailscale-row-body">${children}</div>
  </div>`;
}

function Details({ summary = "Details", text }) {
  if (!text) return null;
  return html`<details class="tailscale-details">
    <summary>${summary}</summary>
    <pre>${text}</pre>
  </details>`;
}

const CERTIFICATE_HTTPS_OFF =
  "HTTPS certificates are turned off in your Tailscale network, so the gateway uses its own certificate for now. Browsers and apps warn about it until you turn them on.";
const CERTIFICATE_NAMES_OFF =
  "Device names (MagicDNS) are turned off in your Tailscale network, so it can't give the gateway a trusted certificate. The gateway uses its own certificate for now. Turn on MagicDNS and HTTPS certificates.";

/** Something the gateway is waiting on outside this page, with a spinner so it reads as moving. */
function Waiting({ hint = false, children }) {
  return html`<p class=${`tailscale-waiting ${hint ? "tailscale-hint" : "tailscale-value"}`} role="status">
    <span class="spinner tailscale-spinner" aria-hidden="true"></span>${children}
  </p>`;
}

function Certificate({ certificate }) {
  if (!certificate) return null;
  if (certificate.source === "tailscale")
    return html`<p class="tailscale-value">
      Trusted certificate — browsers and apps connect without warnings.
    </p>`;
  switch (certificate.reason) {
    case "pending":
      return html`<${Waiting}>Getting a trusted certificate…<//>`;
    case "https-disabled":
    case "magicdns-disabled":
      return html`<p class="tailscale-value">
          ${certificate.reason === "https-disabled" ? CERTIFICATE_HTTPS_OFF : CERTIFICATE_NAMES_OFF}
        </p>
        <p class="tailscale-row-action">
          <a href=${TAILSCALE_ADMIN.dns} target="_blank" rel="noopener noreferrer"
            >Turn on HTTPS certificates</a
          >
        </p>`;
    default:
      return html`<p class="tailscale-value">
          Couldn't get a trusted certificate from Tailscale. The gateway uses its own certificate
          for now and tries again by itself.
        </p>
        <${Details} text=${certificate.error} />`;
  }
}

function Connected({ state }) {
  const owner = state.owner;
  return html`<div class="tailscale-rows">
    ${state.url &&
    html`<${Row} label="Address">
      <${CopyField} id="tailscale-address" value=${state.url} label="Gateway address on Tailscale" />
      <p class="tailscale-hint">Open it on any device signed in to your Tailscale network.</p>
      <p class="tailscale-row-action">
        <a href=${`${state.url.replace(/\/+$/u, "")}/portal/`} target="_blank" rel="noopener noreferrer"
          >Open the portal at this address</a
        >
      </p>
      <p class="tailscale-hint">
        You sign in there as you do here: being on your Tailscale network lets a device reach the
        gateway, not use it.
      </p>
    <//>`}
    ${owner &&
    html`<${Row} label="Tailscale account">
      <p class="tailscale-value">
        ${owner.displayName ?? owner.login}
        ${owner.displayName && html` <span class="tailscale-muted">${owner.login}</span>`}
      </p>
    <//>`}
    <${Row} label="Certificate"><${Certificate} certificate=${state.certificate} /><//>
  </div>`;
}

function SignIn({ state, busy, run }) {
  const url = tailscaleHttpsUrl(state.signInUrl);
  const disabled = Boolean(busy) && busy !== "refresh";
  const newLink = html`<button
    type="button"
    class="tailscale-quiet"
    disabled=${disabled}
    onClick=${() => run("sign-in", tailscaleSignIn)}
  >
    ${busy === "sign-in" ? "Getting a new link…" : "Get a new link"}
  </button>`;
  return html`<p class="tailscale-lede">Sign in to Tailscale to add this gateway to your network.</p>
    ${url
      ? html`<div class="tailscale-sign-in">
          <div class="tailscale-sign-in-main">
            <div class="tailscale-actions">
              <${OutLink} href=${url} primary>Open sign-in page<//>
              ${newLink}
            </div>
            <p class="tailscale-hint">
              This page updates by itself once you're signed in.
            </p>
          </div>
          <figure class="tailscale-qr">
            <${QrCanvas} payload=${url} width=${148} class="tailscale-qr-canvas" />
            <figcaption>Or scan with your phone</figcaption>
          </figure>
        </div>`
      : html`<${Waiting} hint>Getting a sign-in link…<//>
          <div class="tailscale-actions">${newLink}</div>`}`;
}

/** What to do about the device's state: turn it on, sign in, wait, or its address once connected. */
export function StatusPanel({ state, phase, busy, run }) {
  const disabled = Boolean(busy) && busy !== "refresh";
  switch (phase) {
    case "off":
      return html`<p class="tailscale-lede">
          Turn it on to give this gateway its own place in your Tailscale network. You sign in to
          Tailscale once; after that, your phone and laptop reach the gateway wherever they are,
          as long as Tailscale runs on them.
        </p>
        <div class="tailscale-actions">
          <button
            type="button"
            class="btn-primary"
            disabled=${disabled}
            onClick=${() => run("enable", (signal) => setTailscaleEnabled(true, signal))}
          >
            ${busy === "enable" ? "Turning on…" : "Turn on"}
          </button>
        </div>`;
    case "unavailable":
      return html`<p class="tailscale-notice" role="status">
        ${state.helper.reason ?? "Tailscale can't start on this gateway."}
      </p>`;
    case "restarting":
      return html`<p class="tailscale-lede">
          Tailscale stopped unexpectedly on this gateway. It's starting again by itself.
        </p>
        <${Details} text=${state.helper.reason} />`;
    case "starting":
      return html`<p class="tailscale-lede">
        Connecting this gateway to Tailscale. This usually takes a few seconds.
      </p>`;
    case "needs-sign-in":
      return html`<${SignIn} state=${state} busy=${busy} run=${run} />`;
    case "needs-approval":
      return html`<p class="tailscale-lede">
          Your Tailscale network requires an administrator to approve new devices. Approve
          "${state.deviceName}" in the Tailscale admin console.
        </p>
        <div class="tailscale-actions">
          <${OutLink} href=${TAILSCALE_ADMIN.machines}>Open the admin console<//>
        </div>
        <p class="tailscale-hint">This page updates by itself once it's approved.</p>`;
    case "stopped":
      return html`<p class="tailscale-lede">
          This gateway is no longer connected to your Tailscale network. Sign in again to
          reconnect it.
        </p>
        <div class="tailscale-actions">
          <button
            type="button"
            class="btn-primary"
            disabled=${disabled}
            onClick=${() => run("sign-in", tailscaleSignIn)}
          >
            ${busy === "sign-in" ? "Signing in…" : "Sign in again"}
          </button>
        </div>`;
    case "connected":
      return html`<${Connected} state=${state} />`;
    default:
      return null;
  }
}

const HTTPS_FOR_PUBLIC =
  "The public address needs HTTPS certificates, which are turned off in your Tailscale network.";

function PublicState({ state }) {
  const pub = state.public;
  if (!pub.wanted) return null;
  switch (pub.state) {
    case "on": {
      const base = tailscaleHttpsUrl(pub.url) ?? tailscaleHttpsUrl(state.url);
      if (!base) return null;
      const mcp = `${base.replace(/\/+$/u, "")}/mcp`;
      return html`<div class="tailscale-field">
        <label class="tailscale-field-label" for="tailscale-public-mcp">Address for ChatGPT and Claude</label>
        <${CopyField} id="tailscale-public-mcp" value=${mcp} label="Address for ChatGPT and Claude" />
        <p class="tailscale-hint">
          To add it, create a custom connector in ChatGPT or Claude and paste this address. You sign
          in to Omnesis the first time it connects.
        </p>
      </div>`;
    }
    case "needs-enable": {
      const enable = tailscaleHttpsUrl(pub.enableUrl);
      return html`<p class="tailscale-value">Allow public access for this gateway in Tailscale first.</p>
        <div class="tailscale-actions">
          ${enable && html`<${OutLink} href=${enable}>Allow in Tailscale<//>`}
        </div>
        <p class="tailscale-hint">This page updates by itself once it's allowed.</p>`;
    }
    case "unavailable":
      if (pub.reason === "https-disabled")
        return html`<p class="tailscale-value">${HTTPS_FOR_PUBLIC}</p>
          <p class="tailscale-row-action">
            <a href=${TAILSCALE_ADMIN.dns} target="_blank" rel="noopener noreferrer"
              >Turn on HTTPS certificates</a
            >
          </p>`;
      if (pub.reason === "not-signed-in") return html`<p class="tailscale-value">Sign in first.</p>`;
      return html`<p class="tailscale-value">
          Tailscale can't open a public address for this gateway right now.
        </p>
        <${Details} text=${pub.reason} />`;
    default:
      return html`<${Waiting} hint>Opening…<//>`;
  }
}

function PublicSection({ state, busy, run }) {
  const [pending, setPending] = useState(null);
  const wanted = pending ?? state.public.wanted;
  const disabled = Boolean(busy) && busy !== "refresh";
  const toggle = async () => {
    const next = !state.public.wanted;
    setPending(next);
    await run("public", (signal) => updateTailscaleSettings({ publicAccess: next }, signal));
    setPending(null);
  };
  return html`<section class="tailscale-section" aria-labelledby="tailscale-public-title">
    <div class="tailscale-section-head">
      <div>
        <h3 class="tailscale-section-title" id="tailscale-public-title">
          Public address for cloud agents
        </h3>
        <p class="tailscale-section-text">
          ChatGPT and Claude's cloud connectors call your gateway from the Internet. Turning this on
          opens only what they need to connect and sign in; everything else stays private to your
          Tailscale network.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        class="tailscale-switch"
        aria-checked=${wanted ? "true" : "false"}
        aria-labelledby="tailscale-public-title"
        disabled=${disabled}
        onClick=${toggle}
      >
        <span></span>
      </button>
    </div>
    <${PublicState} state=${state} />
  </section>`;
}

/** Client-side checks that only save a round trip; the gateway's rule is the authority. */
function nameProblem(name) {
  if (!name) return "Enter a name.";
  if (name.length > 63) return "Use 63 characters or fewer.";
  return "";
}

/** Whether this page was opened at the device's own Tailscale address, which signing out or turning off removes. */
export function viewedThroughDevice(state, location = globalThis.location) {
  const name = (state?.node?.dnsName ?? "").replace(/\.$/u, "").toLowerCase();
  return Boolean(name) && location?.hostname?.toLowerCase() === name;
}

/** Said before a change that removes the address this page is open at. */
const LEAVES_THIS_PAGE =
  " You are using this page at that address, so it stops loading once you confirm: to keep using the portal, open it at another of this gateway's addresses, such as its address on your home network.";

/** Turning the device off is confirmed first, in these words, wherever it is offered. */
export function turnOffConfirm(state) {
  return {
    title: "Turn off Tailscale?",
    body: `Devices that use this gateway's Tailscale address lose access, and its public address for your MCP server closes. Your settings are kept, so you can turn it back on later.${viewedThroughDevice(state) ? LEAVES_THIS_PAGE : ""}`,
    confirmLabel: "Turn off",
  };
}

/**
 * The device's own settings at the foot of the main card: its name on the
 * tailnet, and signing it out or turning it off, each confirmed first.
 */
function DeviceSettings({ state, phase, busy, run }) {
  const [draft, setDraft] = useState(state.deviceName);
  const [nameError, setNameError] = useState("");
  const [confirming, setConfirming] = useState("");
  useEffect(() => setDraft(state.deviceName), [state.deviceName]);
  const disabled = Boolean(busy) && busy !== "refresh";
  const trimmed = draft.trim();
  const save = async (event) => {
    event.preventDefault();
    const problem = nameProblem(trimmed);
    setNameError(problem);
    if (problem) return;
    await run("device-name", (signal) => updateTailscaleSettings({ deviceName: trimmed }, signal), {
      onError: (error) => {
        if (error?.status !== 400 && error?.status !== 422) return false;
        setNameError(error.serverMessage || error.message);
        return true;
      },
    });
  };
  const signedIn = phase === "connected" || phase === "needs-approval";
  const confirm = async () => {
    const which = confirming;
    setConfirming("");
    if (which === "sign-out") await run("sign-out", tailscaleSignOut);
    if (which === "disable") await run("disable", (signal) => setTailscaleEnabled(false, signal));
  };
  return html`<div class="tailscale-device">
    <form class="tailscale-row tailscale-device-name" onSubmit=${save}>
      <label class="tailscale-row-label" for="tailscale-device-name">Device name</label>
      <div class="tailscale-row-body">
      <div class="tailscale-name-row">
        <input
          id="tailscale-device-name"
          class="tailscale-input"
          type="text"
          autocomplete="off"
          spellcheck="false"
          maxlength="63"
          value=${draft}
          aria-invalid=${nameError ? "true" : "false"}
          aria-describedby="tailscale-device-name-hint"
          onInput=${(event) => {
            setDraft(event.currentTarget.value);
            setNameError("");
          }}
        />
        <button
          type="submit"
          class="btn-secondary"
          disabled=${disabled || trimmed === state.deviceName}
        >
          ${busy === "device-name" ? "Saving…" : "Save"}
        </button>
      </div>
      ${nameError && html`<p class="tailscale-field-error" role="alert">${nameError}</p>`}
      <p class="tailscale-hint" id="tailscale-device-name-hint">
        Your devices see the gateway under this name on Tailscale, and it is part of its address.
        Changing it changes the address.
      </p>
      </div>
    </form>
    ${(signedIn || state.enabled) &&
    html`<div class="tailscale-actions tailscale-device-actions">
      ${signedIn &&
      html`<button
        type="button"
        class="btn-secondary tailscale-danger"
        disabled=${disabled}
        onClick=${() => setConfirming("sign-out")}
      >
        ${busy === "sign-out" ? "Signing out…" : "Sign out of Tailscale"}
      </button>`}
      ${state.enabled &&
      html`<button
        type="button"
        class="btn-secondary tailscale-danger"
        disabled=${disabled}
        onClick=${() => setConfirming("disable")}
      >
        ${busy === "disable" ? "Turning off…" : "Turn off"}
      </button>`}
    </div>`}
    <${ConfirmModal}
      open=${confirming === "sign-out"}
      title="Sign out of Tailscale?"
      body=${`This gateway leaves your Tailscale network until you sign in again. Devices that reach it at its Tailscale address lose access meanwhile, and its public address closes.${viewedThroughDevice(state) ? LEAVES_THIS_PAGE : ""}`}
      confirmLabel="Sign out"
      destructive
      onConfirm=${confirm}
      onCancel=${() => setConfirming("")}
    />
    <${ConfirmModal}
      open=${confirming === "disable"}
      ...${turnOffConfirm(state)}
      destructive
      onConfirm=${confirm}
      onCancel=${() => setConfirming("")}
    />
  </div>`;
}

function ErrorLine({ error }) {
  if (!error) return null;
  return html`<div class="tailscale-error" role="alert">
    <span>${error.message}</span>
    <button type="button" class="btn-secondary" onClick=${() => error.retry()}>Try again</button>
  </div>`;
}

export function TailscaleView() {
  const { state, error, busy, run } = useTailscaleAdmin();
  const phase = tailscalePhase(state);
  // The public address and joining devices only mean something once the device is on the network.
  const connected = phase === "connected";
  return html`<section class="tailscale-view" aria-labelledby="tailscale-heading">
    <header class="tailscale-header">
      <div class="tailscale-title-row">
        <h2 id="tailscale-heading">Tailscale</h2>
        <${StatusPill} phase=${phase} />
      </div>
      <p>
        Reach this gateway from your own devices anywhere, through your Tailscale network. Omnesis
        joins as its own device; nothing is installed on this computer.
      </p>
    </header>
    <${ErrorLine} error=${error} />
    ${!state && !error && html`<${Waiting} hint>Loading…<//>`}
    ${state &&
    html`<div class="tailscale-panel">
        <div aria-live="polite">
          <${StatusPanel} state=${state} phase=${phase} busy=${busy} run=${run} />
        </div>
        <${DeviceSettings} state=${state} phase=${phase} busy=${busy} run=${run} />
      </div>
      ${connected && html`<${PublicSection} state=${state} busy=${busy} run=${run} />`}
      `}
  </section>`;
}
