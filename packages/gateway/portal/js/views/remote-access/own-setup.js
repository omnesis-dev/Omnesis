// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The two ways in the owner runs themselves, each its own option in step 2 of
// the Connectivity setup and its own page behind the summary. Tailscale already
// on this computer: the gateway reads the local Tailscale daemon and can run
// the serve or funnel command the docs give, or names the exact command when
// it is not allowed to. The owner's own domain or reverse proxy: the gateway
// checks that the name resolves, that its certificate is valid and that it
// answers as this gateway, then saves it as `gateway.publicBaseUrl`, which the
// gateway uses as soon as it is saved.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { patchAdminConfig } from "../../api.js";
import { ConfirmModal } from "../../components/confirm-modal.js";
import { CopyBlock } from "../../components/copy-button.js";
import {
  checkPublicAddress,
  getHostTailscale,
  getRemoteAccess,
  publishHostTailscale,
  unpublishHostTailscale,
} from "../../lib/remote-access-api.js";
import { AddressLink } from "./manage.js";
import { PortCaveat } from "./mcp.js";

/** A failure in the words a person can act on: a passkey step's own, the gateway's, or `fallback`. */
function problem(cause, fallback) {
  return (cause?.stepUp === true && cause.message) || cause?.serverMessage || fallback;
}

/**
 * Saves `url` as the gateway's public address, or removes it with null; either
 * applies at once. Reads the remote-access settings again so the page shows
 * it. Resolves to an error message, or "" once saved.
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

/** Where Tailscale is installed from, for a computer that does not have it yet. */
export const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";

export function InstallTailscale() {
  return html`<a href=${TAILSCALE_DOWNLOAD} target="_blank" rel="noopener noreferrer">Install Tailscale</a>`;
}

/**
 * Tailscale already on this computer, read once: null while it is read, and
 * `{ state: "unreadable" }` when the gateway could not say. Step 2 and the
 * summary show or grey out its option from this.
 */
export function useHostTailscale() {
  const [host, setHost] = useState(null);
  useEffect(() => {
    let live = true;
    getHostTailscale().then(
      (value) => live && setHost(value),
      () => live && setHost({ state: "unreadable" }),
    );
    return () => {
      live = false;
    };
  }, []);
  return host;
}

/** The ports Tailscale Funnel accepts, in the order the gateway tries them. */
const FUNNEL_PORTS = [443, 8443, 10000];

/**
 * The gateway on a port other than 443: until it is served there, why (the Funnel
 * ports before it are other apps'), and always what that means for agents.
 */
function PortNote({ host }) {
  const taken = host.servesGateway ? [] : FUNNEL_PORTS.filter((port) => port < host.port);
  return html`<p class="remote-access-muted">
    ${taken.length > 0 &&
    html`Another app already uses <code>https://${host.dnsName}</code> on ${taken.length > 1 ? "ports" : "port"}${" "}
      ${taken.join(" and ")}, so this gateway uses port ${host.port}.${" "}`}
    <${PortCaveat} url=${host.url} />
  </p>`;
}

/**
 * Whether what Tailscale on this computer does differs from what the owner asked for:
 * served, and public or not, when `wanted`; not served otherwise. The setup cannot
 * continue while it does.
 */
function hostPending(host, wanted, wantPublic) {
  if (!wanted) return host?.state === "available" && host.servesGateway;
  if (host?.state !== "available") return true;
  return !host.servesGateway || wantPublic !== host.publicGateway;
}

/**
 * Tailscale already on this computer serving the gateway. With `wanted`, the owner sets
 * it up, on the tailnet and optionally the Internet, and changes that later; without, the
 * owner unticked it in the setup, and it offers to stop serving the gateway. `offerStop`
 * offers that too while it is wanted, on its own page. Each change runs the Tailscale
 * command, or names it when the gateway may not run it, with a check under it. Setting
 * it up publicly makes its address the gateway's public address, which agents sign in
 * through; stopping it removes that address again. `onState` hears what Tailscale does,
 * whether it still differs from what the owner asked for, and a failure to change the
 * public address, which the setup keeps on screen; it is a state setter, and on unmount
 * the panel withdraws its verdict, so a panel shown again counts as pending until it
 * has read Tailscale.
 */
export function HostTailscale({ remote, setRemote, wanted = true, offerStop = false, onState }) {
  const [host, setHost] = useState(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState("");
  // Whether the owner wants the gateway on the Internet; it follows what Tailscale does
  // until the owner changes it.
  const [wantPublic, setWantPublic] = useState(false);
  // The last change that Tailscale refused: `{ reason, command }`, until a check finds it done.
  const [refused, setRefused] = useState(null);
  // What the last check found, when it was not yet what the owner asked for.
  const [notYet, setNotYet] = useState("");
  const [confirmingStop, setConfirmingStop] = useState(false);
  const configured = remote.publicBaseUrl?.configured ?? null;
  const ownAddress = !remote.publicBaseUrl?.setByEnvironment;

  useEffect(() => {
    if (host) onState?.({ host, pending: hostPending(host, wanted, wantPublic), error });
  }, [host, wanted, wantPublic, error]);
  useEffect(() => () => onState?.((last) => last && { ...last, pending: undefined, error: "" }), []);

  /**
   * Once Tailscale does what the owner asked, the public address follows, judged
   * against the settings as they are now: a public address on this computer becomes
   * the gateway's, and the one it served before is removed once it serves nothing. An
   * address taken off the Internet stays: devices and agents on the tailnet still sign
   * in through it. Resolves to an error message, or "".
   */
  const settleAddress = async (found, served) => {
    if (found.state !== "available") return "";
    const now = await getRemoteAccess();
    setRemote(now);
    if (now.publicBaseUrl?.setByEnvironment) return "";
    const current = now.publicBaseUrl?.configured ?? null;
    const target = found.publicGateway
      ? found.url
      : !found.servesGateway && served && current === served
        ? null
        : undefined;
    if (target === undefined || target === current) return "";
    return savePublicAddress(target, setRemote);
  };

  const read = async (why = "read") => {
    setWorking(why);
    setError("");
    setNotYet("");
    try {
      const before = host;
      const found = await getHostTailscale();
      if (why !== "check" || found.state !== "available" || found.blocked) {
        setHost(found);
        if (why === "read") setWantPublic(found.publicGateway === true);
        return;
      }
      const missing = !wanted
        ? found.servesGateway && "Tailscale on this computer still serves this gateway."
        : !found.servesGateway
          ? "Tailscale on this computer isn't serving this gateway yet."
          : wantPublic && !found.publicGateway
            ? "This gateway isn't reachable from the Internet yet."
            : !wantPublic && found.publicGateway && "This gateway is still reachable from the Internet.";
      if (missing) {
        setHost(found);
        return setNotYet(`${missing} Run the command above, then check again.`);
      }
      // The address settles before the panel shows the result, which can close it.
      setError(await settleAddress(found, before?.servesGateway ? before.url : null));
      setRefused(null);
      setHost(found);
    } catch (cause) {
      setError(problem(cause, "Couldn't look for Tailscale on this computer. Try again."));
    } finally {
      setWorking("");
    }
  };
  useEffect(() => void read(), []);

  /** Run a change, then read what Tailscale does now; a refusal shows its command. */
  const change = async (why, run, fallback) => {
    setWorking(why);
    setError("");
    setNotYet("");
    setRefused(null);
    try {
      const before = host;
      const result = await run();
      const found = await getHostTailscale();
      if (result.ok) {
        // The address settles before the panel shows the result, which can close it.
        setError(await settleAddress(found, before?.servesGateway ? before.url : null));
        setWantPublic(found.publicGateway === true);
      } else setRefused(result);
      setHost(found);
    } catch (cause) {
      setError(problem(cause, fallback));
    } finally {
      setWorking("");
    }
  };
  const publish = () =>
    change("publish", () => publishHostTailscale(wantPublic), "Couldn't set up Tailscale on this computer. Try again.");
  const stop = () => {
    setConfirmingStop(false);
    return change("stop", () => unpublishHostTailscale(), "Couldn't stop Tailscale on this computer serving this gateway. Try again.");
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
  if (host.state !== "available")
    return html`<p class="remote-access-muted">
        ${host.reason}${host.state === "missing" && html`${" "}<${InstallTailscale} />`}
      </p>
      <div class="remote-access-buttons">
        <button type="button" class="btn-secondary" disabled=${Boolean(working)} onClick=${() => read("check")}>
          ${working === "check" ? "Checking…" : "Check again"}
        </button>
      </div>`;
  const busy = Boolean(working);
  // Public now, and the owner unticked it: the press takes the gateway off the Internet.
  const leaving = wanted && host.publicGateway && !wantPublic;
  const stopButton = html`<button
    type="button"
    class=${wanted ? "btn-secondary" : "btn-primary"}
    disabled=${busy}
    onClick=${() => setConfirmingStop(true)}
  >
    ${working === "stop" ? "Stopping…" : "Stop serving this gateway"}
  </button>`;
  return html`<p class="remote-access-muted">
      Found: this computer is on your Tailscale network as <code>${host.dnsName}</code>.
    </p>
    ${!wanted
      ? host.servesGateway
        ? html`<p class="remote-access-muted" role="status">
              Tailscale on this computer still serves this gateway at <${AddressLink} url=${host.url} />${host.publicGateway
                ? ", on your Tailscale network and to the Internet."
                : ", on your Tailscale network."}
              Stop serving it, or tick the option again.
            </p>
            <div class="remote-access-buttons">${stopButton}</div>`
        : null
      : html`${host.servesGateway
            ? html`<p class="remote-access-ok" role="status">
                <span aria-hidden="true">✓ </span>Serving this gateway at <${AddressLink} url=${host.url} />,
                ${host.publicGateway ? " on your Tailscale network and to the Internet." : " to your Tailscale devices only."}
              </p>`
            : host.blocked
              ? html`<p class="remote-access-muted" role="status">${host.blocked}</p>`
              : html`<p class="remote-access-muted">
                  Omnesis runs the Tailscale command for you when you press Set it up for me: it serves this
                  gateway on your Tailscale network, and on the Internet too if you tick it.
                </p>`}
          ${typeof host.port === "number" && host.port !== 443 && html`<${PortNote} host=${host} />`}
          ${!host.blocked &&
          html`<label class="remote-access-check">
            <input type="checkbox" checked=${wantPublic} disabled=${busy} onChange=${(event) => setWantPublic(event.currentTarget.checked)} />
            <span>Also reachable from the Internet (Tailscale Funnel)</span>
          </label>`}
          ${leaving &&
          html`<p class="remote-access-muted">
            ChatGPT, Claude and other agents that connect from the Internet will no longer reach this gateway. Your devices on
            your Tailscale network still will.
          </p>`}
          ${host.blocked
            ? html`<div class="remote-access-buttons">
                <button type="button" class="btn-secondary" disabled=${busy} onClick=${() => read("check")}>
                  ${working === "check" ? "Checking…" : "Check again"}
                </button>
              </div>`
            : (!host.servesGateway || wantPublic !== host.publicGateway || (offerStop && host.servesGateway)) &&
              html`<div class="remote-access-buttons">
                ${(!host.servesGateway || wantPublic !== host.publicGateway) &&
                html`<button type="button" class="btn-primary" disabled=${busy} onClick=${publish}>
                  ${leaving
                    ? working === "publish"
                      ? "Taking it off…"
                      : "Take it off the Internet"
                    : working === "publish"
                      ? "Setting it up…"
                      : "Set it up for me"}
                </button>`}
                ${offerStop && host.servesGateway && stopButton}
              </div>`}`}
    ${refused &&
    html`<div class="remote-access-command">
      <p class="remote-access-problem" role="alert">${refused.reason}</p>
      ${refused.command &&
      html`<${CopyBlock} text=${refused.command} title="Copy command" />
        <div class="remote-access-buttons">
          <button type="button" class="btn-secondary" disabled=${busy} onClick=${() => read("check")}>
            ${working === "check" ? "Checking…" : "I've run it, check it"}
          </button>
        </div>`}
    </div>`}
    ${notYet && html`<p class="remote-access-muted" role="status">${notYet}</p>`}
    ${wanted &&
    host.publicGateway &&
    !leaving &&
    configured !== host.url &&
    ownAddress &&
    html`<p class="remote-access-muted">
        Agents sign in to this gateway's MCP server through its public address, which is
        ${configured ? html` <code>${configured}</code>` : " not set yet"}.
      </p>
      <div class="remote-access-buttons">
        <button type="button" class="btn-secondary" disabled=${busy} onClick=${adoptPublic}>
          ${working === "save" ? "Saving…" : html`Use ${host.url} as this gateway's public address`}
        </button>
      </div>`}
    ${error && html`<p class="remote-access-problem" role="alert">${error}</p>`}
    <${ConfirmModal}
      open=${confirmingStop}
      title="Stop serving this gateway?"
      body=${`Tailscale on this computer stops serving ${host.url}. Your devices and agents that use it lose access${configured === host.url ? ", and it is no longer this gateway's public address" : ""}. You can set it up again here.`}
      confirmLabel="Stop serving"
      destructive
      onConfirm=${stop}
      onCancel=${() => setConfirmingStop(false)}
    />`;
}

const STEP_NAMES = { resolves: "Name", certificate: "Certificate", answers: "This gateway" };

/** Whose address a public address that is not the owner's own domain is. */
const WAY_ADDRESSES = {
  relay: "the Omnesis relay's address",
  tailnet: "the address of this gateway's own Tailscale device",
  host: "the address of Tailscale on this computer",
};

export function OwnAddress({ remote, setRemote, url, onUrl }) {
  const way = remote.publicBaseUrl?.way ?? null;
  const configured = (!way && remote.publicBaseUrl?.configured) || "";
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
  if (remote.publicBaseUrl?.setByEnvironment)
    return html`<${SetByEnvironment} address=${remote.publicBaseUrl.configured} />`;
  return html`${way &&
    html`<p class="remote-access-muted">
        This gateway's public address is <${AddressLink} url=${remote.publicBaseUrl.configured} />,${" "}
        ${WAY_ADDRESSES[way] ?? "another way in's address"}. Save your own domain here to make it
        the public address instead.
      </p>`}
    <form class="remote-access-address" onSubmit=${check}>
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
