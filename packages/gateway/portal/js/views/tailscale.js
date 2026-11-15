// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Settings → Tailscale: the gateway's own device on the owner's Tailscale
// network. Only rendered when the gateway runs with
// OMNESIS_TAILSCALE_EMBED_ENABLED=1, which `/status` advertises as
// `tailscaleEmbed: true`.
//
// The page is written for an owner who is not a networking expert. A pill
// says what state the device is in and one panel says what to do about it;
// below it, the public address for cloud agents, what happens when one of the
// owner's own devices asks to join, and the rarely needed controls folded
// under Advanced.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { ConfirmModal } from "../components/confirm-modal.js";
import { QrCanvas } from "../components/qr-canvas.js";
import { timeAgo } from "../lib/format.js";
import {
  TAILSCALE_ADMIN,
  decideTailscaleJoin,
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

function StatusPanel({ state, phase, busy, run }) {
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
        </p>
        <div class="tailscale-actions">
          <button
            type="button"
            class="btn-secondary"
            disabled=${disabled}
            onClick=${() => run("disable", (signal) => setTailscaleEnabled(false, signal))}
          >
            ${busy === "disable" ? "Turning off…" : "Turn off"}
          </button>
        </div>`;
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

const JOIN_CHOICES = [
  {
    value: "ask",
    title: "Ask me first (recommended)",
    text: "A collector on one of your own Tailscale devices asks to join; you approve it here or on your phone.",
  },
  {
    value: "automatic",
    title: "Join automatically",
    text: "Your own Tailscale devices join without asking. You get a notification each time.",
  },
  { value: "off", title: "Off", text: "Every device pairs with a pairing code." },
];

/** "in 9 min" until a request expires, from the gateway's own timestamp. */
export function expiresIn(iso, now = Date.now()) {
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "expired";
  if (ms < 60_000) return "expires in under a minute";
  return `expires in ${Math.ceil(ms / 60_000)} min`;
}

function JoinRequest({ request, busy, decide }) {
  const disabled = Boolean(busy) && busy !== "refresh";
  const asked = timeAgo(request.requestedAt);
  const expiry = expiresIn(request.expiresAt);
  return html`<li class="tailscale-request">
    <div class="tailscale-request-text">
      <p class="tailscale-value tailscale-strong">${request.name}</p>
      <p class="tailscale-hint">
        Collector on ${request.machine}${request.os ? ` (${request.os})` : ""} · Tailscale account
        ${" "}${request.login}
      </p>
      <p class="tailscale-hint">
        ${asked && `Asked ${asked}`}${asked && expiry ? " · " : ""}${expiry}
      </p>
    </div>
    <div class="tailscale-actions tailscale-request-actions">
      <button
        type="button"
        class="btn-primary"
        disabled=${disabled}
        aria-label=${`Approve ${request.name}`}
        onClick=${() => decide(request, true)}
      >
        ${busy === `decide:${request.id}:true` ? "Approving…" : "Approve"}
      </button>
      <button
        type="button"
        class="btn-secondary"
        disabled=${disabled}
        aria-label=${`Deny ${request.name}`}
        onClick=${() => decide(request, false)}
      >
        ${busy === `decide:${request.id}:false` ? "Denying…" : "Deny"}
      </button>
    </div>
  </li>`;
}

function JoinSection({ state, busy, run, refresh }) {
  const [pending, setPending] = useState(null);
  const [notice, setNotice] = useState("");
  const policy = pending ?? state.joinPolicy;
  const disabled = Boolean(busy) && busy !== "refresh";
  const choose = async (value) => {
    if (value === state.joinPolicy) return;
    setPending(value);
    await run("join-policy", (signal) => updateTailscaleSettings({ joinPolicy: value }, signal));
    setPending(null);
  };
  const decide = async (request, approve) => {
    setNotice("");
    let gone = false;
    const result = await run(
      `decide:${request.id}:${approve}`,
      (signal) => decideTailscaleJoin(request.id, approve, signal),
      {
        onError: (error) => {
          if (error?.status !== 404) return false;
          gone = true;
          return true;
        },
      },
    );
    if (gone) setNotice("This request expired or was already decided.");
    else if (result)
      setNotice(result.status === "approved" ? `Approved ${request.name}.` : `Denied ${request.name}.`);
    if (gone || result) await refresh();
  };
  const requests = state.joinRequests ?? [];
  return html`<section class="tailscale-section" aria-labelledby="tailscale-join-title">
    <h3 class="tailscale-section-title" id="tailscale-join-title">
      Your devices joining through Tailscale
    </h3>
    ${notice && html`<p class="tailscale-notice" role="status">${notice}</p>`}
    ${requests.length > 0 &&
    html`<div class="tailscale-requests">
      <h4 class="tailscale-subtitle">Waiting for approval</h4>
      <ul class="tailscale-request-list">
        ${requests.map(
          (request) =>
            html`<${JoinRequest} key=${request.id} request=${request} busy=${busy} decide=${decide} />`,
        )}
      </ul>
    </div>`}
    <p class="tailscale-section-text">
      What happens when a collector on one of your Tailscale devices asks to join this gateway.
    </p>
    <div class="tailscale-options" role="radiogroup" aria-labelledby="tailscale-join-title">
      ${JOIN_CHOICES.map(
        (choice) => html`<label
          key=${choice.value}
          class=${`tailscale-option ${policy === choice.value ? "tailscale-option-selected" : ""}`}
        >
          <input
            type="radio"
            name="tailscale-join-policy"
            value=${choice.value}
            checked=${policy === choice.value}
            disabled=${disabled}
            onChange=${() => choose(choice.value)}
          />
          <span>
            <span class="tailscale-option-title">${choice.title}</span>
            <span class="tailscale-option-text">${choice.text}</span>
          </span>
        </label>`,
      )}
    </div>
  </section>`;
}

/** Client-side checks that only save a round trip; the gateway's rule is the authority. */
function nameProblem(name) {
  if (!name) return "Enter a name.";
  if (name.length > 63) return "Use 63 characters or fewer.";
  return "";
}

function Advanced({ state, phase, busy, run }) {
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
  return html`<details class="tailscale-advanced">
    <summary>Advanced</summary>
    <form class="tailscale-field" onSubmit=${save}>
      <label class="tailscale-field-label" for="tailscale-device-name">Device name on Tailscale</label>
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
        Your devices see the gateway under this name, and it is part of its address. Changing it
        changes the address.
      </p>
    </form>
    ${(signedIn || state.enabled) &&
    html`<div class="tailscale-actions tailscale-advanced-actions">
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
      body="This gateway leaves your Tailscale network until you sign in again. Devices that reach it at its Tailscale address lose access meanwhile, and its public address closes."
      confirmLabel="Sign out"
      destructive
      onConfirm=${confirm}
      onCancel=${() => setConfirming("")}
    />
    <${ConfirmModal}
      open=${confirming === "disable"}
      title="Turn off Tailscale?"
      body="Devices that use this gateway's Tailscale address lose access, and its public address for cloud agents closes. Your settings are kept, so you can turn it back on later."
      confirmLabel="Turn off"
      destructive
      onConfirm=${confirm}
      onCancel=${() => setConfirming("")}
    />
  </details>`;
}

function ErrorLine({ error }) {
  if (!error) return null;
  return html`<div class="tailscale-error" role="alert">
    <span>${error.message}</span>
    <button type="button" class="btn-secondary" onClick=${() => error.retry()}>Try again</button>
  </div>`;
}

export function TailscaleView() {
  const { state, error, busy, run, refresh } = useTailscaleAdmin();
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
    html`<div class="tailscale-panel" aria-live="polite">
        <${StatusPanel} state=${state} phase=${phase} busy=${busy} run=${run} />
      </div>
      ${connected && html`<${PublicSection} state=${state} busy=${busy} run=${run} />`}
      ${connected && html`<${JoinSection} state=${state} busy=${busy} run=${run} refresh=${refresh} />`}
      <${Advanced} state=${state} phase=${phase} busy=${busy} run=${run} />`}
  </section>`;
}
