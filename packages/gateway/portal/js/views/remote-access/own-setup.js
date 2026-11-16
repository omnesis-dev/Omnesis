// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// "Use my own setup" in the Remote access setup: a way in the owner runs
// themselves. With the Tailscale feature, Tailscale already on this computer:
// the gateway reads the local Tailscale daemon and can run the serve or funnel
// command the docs give, or names the exact command when it is not allowed
// to. With either feature, the owner's own domain or reverse proxy: the
// gateway checks that the name resolves, that its certificate is valid and
// that it answers as this gateway, then saves it as `gateway.publicBaseUrl`,
// which the gateway uses as soon as it is saved.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { patchAdminConfig } from "../../api.js";
import { CopyBlock } from "../../components/copy-button.js";
import {
  checkPublicAddress,
  getHostTailscale,
  getRemoteAccess,
  publishHostTailscale,
} from "../../lib/remote-access-api.js";

/** A failure in the words a person can act on: a passkey step's own, the gateway's, or `fallback`. */
function problem(cause, fallback) {
  return (cause?.stepUp === true && cause.message) || cause?.serverMessage || fallback;
}

/**
 * Saves `url` as the gateway's public address, which applies at once, and
 * reads the remote-access settings again so the page shows it. Resolves to an
 * error message, or "" once saved.
 */
async function savePublicAddress(url, setRemote) {
  const saved = await patchAdminConfig({ gateway: { publicBaseUrl: url } });
  if (!saved.ok)
    return typeof saved.body?.error === "string" ? saved.body.error : "Couldn't save the address. Try again.";
  setRemote(await getRemoteAccess());
  return "";
}

/**
 * Said where `OMNESIS_PUBLIC_BASE_URL` sets the public address: one saved
 * here would change nothing, so nothing here offers to save one.
 */
function SetByEnvironment({ address }) {
  return html`<p class="remote-access-muted">
    This gateway's public address, <code>${address}</code>, is set by <code>OMNESIS_PUBLIC_BASE_URL</code> in its
    environment, so it can't be changed here.
  </p>`;
}

function HostTailscale({ remote, setRemote }) {
  const [host, setHost] = useState(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState("");
  const [wantPublic, setWantPublic] = useState(false);
  // The last publish: `{ ok: true, url }`, or `{ ok: false, reason, command }`.
  const [outcome, setOutcome] = useState(null);
  // A check after the owner changed something reads the gateway's settings again too:
  // a restart may have put a new public address in use.
  const read = async (why = "read") => {
    setWorking(why);
    setError("");
    try {
      setHost(await getHostTailscale());
      if (why === "check") setRemote(await getRemoteAccess());
    } catch (cause) {
      setError(problem(cause, "Couldn't look for Tailscale on this computer. Try again."));
    } finally {
      setWorking("");
    }
  };
  useEffect(() => void read(), []);
  const publish = async () => {
    setWorking("publish");
    setError("");
    setOutcome(null);
    try {
      const result = await publishHostTailscale(wantPublic);
      setOutcome(result);
      if (result.ok && wantPublic && !remote.publicBaseUrl?.setByEnvironment) {
        const failed = await savePublicAddress(result.url, setRemote);
        if (failed) setError(failed);
      }
      setHost(await getHostTailscale());
    } catch (cause) {
      setError(problem(cause, "Couldn't set up Tailscale on this computer. Try again."));
    } finally {
      setWorking("");
    }
  };
  const adoptPublic = async () => {
    setWorking("save");
    setError("");
    try {
      const failed = await savePublicAddress(host.url, setRemote);
      if (failed) setError(failed);
    } catch (cause) {
      setError(problem(cause, "Couldn't save the address. Try again."));
    } finally {
      setWorking("");
    }
  };

  if (!host)
    return html`${error
      ? html`<p class="remote-access-problem" role="alert">${error}</p>
          <button type="button" class="btn-secondary" onClick=${() => read()}>Try again</button>`
      : html`<p class="remote-access-muted" role="status">Looking for Tailscale on this computer…</p>`}`;
  if (host.state === "unavailable")
    return html`<p class="remote-access-muted">${host.reason}</p>
      <div class="remote-access-buttons">
        <button type="button" class="btn-secondary" disabled=${Boolean(working)} onClick=${() => read("check")}>
          ${working === "check" ? "Checking…" : "Check again"}
        </button>
      </div>`;
  const busy = Boolean(working);
  const configured = remote.publicBaseUrl?.configured ?? null;
  return html`<p class="remote-access-muted">
      Found: this computer is on your Tailscale network as <code>${host.dnsName}</code>.
    </p>
    ${host.servesGateway
      ? html`<p class="remote-access-ok" role="status">
          <span aria-hidden="true">✓ </span>Serving this gateway at <code>${host.url}</code>,
          ${host.publicGateway ? " on your Tailscale network and to the Internet." : " to your Tailscale devices only."}
        </p>`
      : host.blocked
        ? html`<p class="remote-access-muted" role="status">${host.blocked}</p>`
        : html`<p class="remote-access-muted">
            Omnesis can run the Tailscale command for you: serve this gateway on your Tailscale network,
            and add a public address for cloud agents if you want one.
          </p>`}
    ${!host.servesGateway &&
    typeof host.port === "number" &&
    host.port !== 443 &&
    html`<p class="remote-access-muted">
      Another app already uses <code>https://${host.dnsName}</code>, so this gateway uses port ${host.port}: <code>${host.url}</code>. ChatGPT connects only on port 443.
    </p>`}
    ${!host.publicGateway &&
    !host.blocked &&
    html`<label class="remote-access-check">
      <input type="checkbox" checked=${wantPublic} disabled=${busy} onChange=${(event) => setWantPublic(event.currentTarget.checked)} />
      <span>Also a public address for ChatGPT and Claude (Tailscale Funnel)</span>
    </label>`}
    ${(!host.servesGateway || (wantPublic && !host.publicGateway)) &&
    html`<div class="remote-access-buttons">
      ${!host.blocked &&
      html`<button type="button" class="btn-primary" disabled=${busy} onClick=${publish}>
        ${working === "publish" ? "Setting it up…" : "Set it up for me"}
      </button>`}
      <button type="button" class="btn-secondary" disabled=${busy} onClick=${() => read("check")}>
        ${working === "check" ? "Checking…" : host.blocked ? "Check again" : "I have already done it, check it"}
      </button>
    </div>`}
    ${outcome?.ok === false &&
    html`<div class="remote-access-command">
      <p class="remote-access-problem" role="alert">${outcome.reason}</p>
      ${outcome.command && html`<${CopyBlock} text=${outcome.command} title="Copy command" />`}
    </div>`}
    ${host.publicGateway &&
    configured !== host.url &&
    !remote.publicBaseUrl?.setByEnvironment &&
    html`<div class="remote-access-buttons">
      <button type="button" class="btn-secondary" disabled=${busy} onClick=${adoptPublic}>
        ${working === "save" ? "Saving…" : html`Use ${host.url} as this gateway's public address`}
      </button>
    </div>`}
    ${error && html`<p class="remote-access-problem" role="alert">${error}</p>`}`;
}

const STEP_NAMES = { resolves: "Name", certificate: "Certificate", answers: "This gateway" };

function OwnAddress({ remote, setRemote, url, onUrl }) {
  const configured = remote.publicBaseUrl?.configured ?? "";
  const value = url || configured;
  const [result, setResult] = useState(null);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const check = async (event) => {
    event.preventDefault();
    setWorking("check");
    setError("");
    setResult(null);
    try {
      setResult(await checkPublicAddress(value.trim()));
    } catch (cause) {
      setError(problem(cause, "Couldn't check that address. Try again."));
    } finally {
      setWorking("");
    }
  };
  const save = async () => {
    setWorking("save");
    setError("");
    try {
      const failed = await savePublicAddress(result.url, setRemote);
      if (failed) setError(failed);
    } catch (cause) {
      setError(problem(cause, "Couldn't save the address. Try again."));
    } finally {
      setWorking("");
    }
  };
  const busy = Boolean(working);
  if (remote.publicBaseUrl?.setByEnvironment) return html`<${SetByEnvironment} address=${configured} />`;
  return html`<form class="remote-access-address" onSubmit=${check}>
      <label for="remote-access-own-url">The address you publish this gateway at</label>
      <div class="remote-access-address-row">
        <input
          id="remote-access-own-url"
          type="url"
          inputmode="url"
          autocomplete="off"
          spellcheck="false"
          placeholder="https://omnesis.example.org"
          value=${value}
          onInput=${(event) => {
            onUrl(event.currentTarget.value);
            setResult(null);
          }}
        />
        <button type="submit" class="btn-secondary" disabled=${busy || !value.trim()}>
          ${working === "check" ? "Checking…" : "Check it"}
        </button>
      </div>
    </form>
    ${result &&
    html`<ul class="remote-access-checks" aria-label="Checks">
      ${result.steps.map(
        (step) => html`<li key=${step.id} class=${step.ok ? "is-ok" : "is-failed"}>
          <span class="remote-access-check-mark" aria-hidden="true">${step.ok ? "✓" : "✗"}</span>
          <span><strong>${STEP_NAMES[step.id] ?? step.id}</strong> ${step.detail}</span>
        </li>`,
      )}
      <li class="is-unknown">
        <span class="remote-access-check-mark" aria-hidden="true">?</span>
        <span>
          <strong>From the Internet</strong> This check runs inside your network, so it can't tell
          whether the address is reachable from outside. Try it from a phone on mobile data.
        </span>
      </li>
    </ul>`}
    ${result?.ok &&
    (result.url === configured
      ? html`<p class="remote-access-ok" role="status"><span aria-hidden="true">✓ </span>This gateway uses this address.</p>`
      : html`<div class="remote-access-buttons">
          <button type="button" class="btn-primary" disabled=${busy} onClick=${save}>
            ${working === "save" ? "Saving…" : "Use this address"}
          </button>
        </div>`)}
    ${error && html`<p class="remote-access-problem" role="alert">${error}</p>`}`;
}

/**
 * The kinds of own setup, each opened by its radio; without the Tailscale
 * feature only the owner's own address, with no choice to make.
 */
export function OwnSetup({ remote, setRemote, tailscaleEmbed, own, url, onFlow }) {
  const address = html`<${OwnAddress} remote=${remote} setRemote=${setRemote} url=${url} onUrl=${(value) => onFlow({ url: value })} />`;
  if (!tailscaleEmbed) return address;
  const choice = (value, title, text, body) => html`<div class=${`remote-access-own${own === value ? " is-on" : ""}`}>
    <label class="remote-access-option-head">
      <input type="radio" name="remote-access-own" value=${value} checked=${own === value} onChange=${() => onFlow({ own: value })} />
      <span class="remote-access-option-text"><strong>${title}</strong><small>${text}</small></span>
    </label>
    ${own === value && html`<div class="remote-access-option-body">${body}</div>`}
  </div>`;
  return html`<div class="remote-access-own-list">
    ${choice(
      "host",
      "Tailscale on this computer",
      "Serve this gateway on your Tailscale network from the Tailscale app already on this computer.",
      html`<${HostTailscale} remote=${remote} setRemote=${setRemote} />`,
    )}
    ${choice("url", "My own domain or reverse proxy", "An https address you run in front of this gateway.", address)}
  </div>`;
}
