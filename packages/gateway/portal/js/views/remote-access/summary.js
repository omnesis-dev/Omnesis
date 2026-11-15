// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Settings → Remote access once the setup is done: one card per question, in
// the setup's words, with the full account and Tailscale device pages one
// click away and "Review settings" to walk the questions again.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { getHostTailscale } from "../../lib/remote-access-api.js";
import { relayPhase, relayEstablished } from "../relay.js";
import { tailscalePhase } from "../tailscale.js";
import { devicePolicies } from "./devices-step.js";
import { PublicWithoutTrustProxy } from "./own-setup.js";
import { POLICY_SUMMARY, RESTART_COMMAND, accountState, listSentence, orderSentence } from "./model.js";

/** The detail pages the summary links to. */
export const ACCOUNT_PAGE = "/portal/settings/account";
export const TAILSCALE_PAGE = "/portal/settings/tailscale";

const ACCOUNT_LINES = {
  loading: "Loading…",
  unavailable: "Not available on this installation.",
  none: "Not used.",
  waiting: "Waiting for you to sign in.",
  registering: "Registering this gateway…",
  linking: "Connecting…",
  failed: "Couldn't connect. Nothing on this gateway changed.",
  linked: "This gateway is linked to your Omnesis account.",
  enrolled: "This gateway is registered with the Omnesis relay but linked to no account.",
};

/** How the Tailscale device reads in a list of ways in. */
function tailscaleWay(state) {
  switch (tailscalePhase(state)) {
    case "connected":
      return `Tailscale (${state.node?.dnsName ?? state.deviceName})`;
    case "needs-sign-in":
      return "Tailscale (sign-in pending)";
    case "needs-approval":
      return "Tailscale (waiting for approval)";
    case "starting":
      return "Tailscale (starting)";
    default:
      return "Tailscale (needs attention)";
  }
}

/** A sentence that may start with a lower-case way in. */
const capitalized = (sentence) => sentence.charAt(0).toUpperCase() + sentence.slice(1);

/** A detail page's link, opened without reloading the portal. */
function Manage({ href, label, onManage }) {
  return html`<a
    class="remote-access-manage"
    href=${href}
    onClick=${(event) => {
      event.preventDefault();
      onManage(href);
    }}
    >${label}</a
  >`;
}

function Card({ title, children, action }) {
  return html`<div class="remote-access-card">
    <div class="remote-access-card-text">
      <h4>${title}</h4>
      ${children}
    </div>
    ${action}
  </div>`;
}

/**
 * Tailscale already on this computer, read once with the Tailscale feature, or
 * null without it or when it cannot be read.
 */
function useHostTailscale(enabled) {
  const [host, setHost] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    getHostTailscale().then(
      (value) => live && setHost(value),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [enabled]);
  return host;
}

export function Summary({ remote, relay, tailscale, headingRef, onReview, onManage }) {
  const host = useHostTailscale(Boolean(tailscale));
  const relayStatus = relay?.status;
  const relayOn = relayEstablished(relayPhase(relayStatus)) && relayStatus.enabled === true;
  const tailscaleOn = tailscale?.state?.enabled === true;
  const ownAddress = remote.publicBaseUrl?.configured;
  const hostServes = host?.state === "available" && host.servesGateway;
  const ways = [
    tailscaleOn ? tailscaleWay(tailscale.state) : null,
    relayOn ? "the Omnesis relay" : null,
    hostServes ? `Tailscale on this computer (${host.url})` : null,
    ownAddress && !(hostServes && ownAddress === host.url) ? `your own address (${ownAddress})` : null,
  ].filter(Boolean);
  const policies = devicePolicies(relay, tailscale);
  const applies = policies.relayLinked || policies.tailscaleOn;
  const devices = !applies
    ? "Only with a pairing code from Settings, Devices."
    : policies.differ
      ? "Your account and Tailscale answer differently. Review settings to choose one answer."
      : `${POLICY_SUMMARY[policies.value]}.${policies.tailscaleKeptOff ? " The Tailscale device takes only pairing codes." : ""}`;
  return html`<div class="remote-access-summary">
    <div class="access-wizard-copy">
      <h3 ref=${headingRef} tabIndex="-1">Remote access is set up</h3>
      <p>How your devices reach this gateway when they are away from home.</p>
    </div>
    ${relay &&
    html`<${Card}
      title="Your Omnesis account"
      action=${html`<${Manage} href=${ACCOUNT_PAGE} label="Manage account" onManage=${onManage} />`}
    >
      <p>${ACCOUNT_LINES[accountState(relayStatus)]}</p>
    <//>`}
    <${Card}
      title="Away from home"
      action=${tailscale && html`<${Manage} href=${TAILSCALE_PAGE} label="Manage Tailscale device" onManage=${onManage} />`}
    >
      <p>
        ${ways.length ? `${capitalized(listSentence(ways))}. ` : "Home network only. "}${orderSentence({ tailscaleOn, relayOn, first: remote.first })}
      </p>
      ${host?.publicGateway && remote.trustProxy !== true && html`<${PublicWithoutTrustProxy} />`}
      ${remote.publicBaseUrl?.restartNeeded &&
      html`<p class="remote-access-warning">Restart the gateway to use its new address: <code>${RESTART_COMMAND}</code></p>`}
    <//>
    <${Card} title="New devices"><p>${devices}</p><//>
    <div class="remote-access-buttons">
      <button type="button" class="btn-primary" onClick=${onReview}>Review settings</button>
    </div>
  </div>`;
}
