// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Settings → Connectivity: what is on and what is not, one line each with a
// tick or a dash — the account, every way in from away from home, and the
// answer for new devices. Each line opens its own page to set it up or manage
// it, the order and the answer for new devices change in place, and the
// guided setup can be walked from here at will.

import { html } from "htm/preact";
import { relayInviteOnly } from "../../lib/cloud-relay-api.js";
import { relayPhase, relayEstablished } from "../relay.js";
import { tailscalePhase } from "../tailscale.js";
import { DevicesChoice, devicePolicies } from "./devices-step.js";
import { FirstChoice } from "./connection-step.js";
import { ACCOUNT_PAGE, AddressLink, HOST_TAILSCALE_PAGE, MCP_PAGE, OWN_ADDRESS_PAGE, RELAY_PAGE, TAILSCALE_PAGE } from "./manage.js";
import { MCP_ADDRESS_LABELS, REACH_DETAILS, mcpRows } from "./mcp.js";
import { useHostTailscale } from "./own-setup.js";
import { accountState, listSentence } from "./model.js";

/** The account line: `[mark, title, detail]` by what step 1 shows. */
const ACCOUNT_ITEMS = {
  loading: ["off", "Your Omnesis account", "Loading…"],
  unavailable: ["off", "Omnesis accounts", "Not available on this installation."],
  none: ["off", "No Omnesis account", "Devices pair with a code from Settings, Devices."],
  waiting: ["warn", "Waiting for you to sign in", "Continue in the sign-in tab."],
  registering: ["warn", "Registering this gateway…", "This usually takes less than a minute."],
  linking: ["warn", "Connecting to your Omnesis account…", "Almost done."],
  failed: ["warn", "Couldn't connect to your Omnesis account", "Nothing on this gateway changed."],
  linked: ["on", "Linked to your Omnesis account", "Your apps find this gateway by signing in."],
  enrolled: ["warn", "Registered with the Omnesis relay, linked to no account", "Link it to find this gateway when you sign in."],
};

/** The Tailscale device's line while it is on but not connected. */
const TAILSCALE_PENDING = {
  "needs-sign-in": "Waiting for you to sign in to Tailscale.",
  "needs-approval": "Waiting for approval in your Tailscale admin console.",
  starting: "Starting…",
};

const MARKS = { on: "✓", off: "–", warn: "!" };

/**
 * One line of the summary: a tick when it is on, a dash when it is off, a bang
 * when it needs you, and `action`, the way to manage that one thing.
 */
function Item({ mark, title, detail = null, action = null }) {
  return html`<li class=${`remote-access-item is-${mark}`}>
    <span class="remote-access-mark" aria-hidden="true">${MARKS[mark]}</span>
    <span class="remote-access-item-text">
      <span class="remote-access-item-title">${title}</span>
      ${detail && html`<span class="remote-access-item-detail">${detail}</span>`}
    </span>
    ${action}
  </li>`;
}

/** The quiet link on one line that opens that thing's own page: "Manage" when it is on, "Set up" when not. */
function ItemManage({ href, label, on = true, onManage }) {
  return html`<button type="button" class="remote-access-item-action" aria-label=${label} onClick=${() => onManage(href)}>
    ${on ? "Manage" : "Set up"}
  </button>`;
}

function Row({ title, children, action }) {
  return html`<div class="remote-access-row">
    <div class="remote-access-row-text">
      <h4>${title}</h4>
      ${children}
    </div>
    ${action}
  </div>`;
}

export function Summary({ remote, setRemote, relay, tailscale, headingRef, onStart, onManage }) {
  const host = useHostTailscale();
  const relayStatus = relay?.status;
  const relayPhaseNow = relayPhase(relayStatus);
  const relayReady = relayEstablished(relayPhaseNow);
  const relayOn = relayReady && relayStatus.enabled === true;
  const tailscaleState = tailscale?.state;
  const tailscaleOn = tailscaleState?.enabled === true;
  const tailscaleNow = tailscalePhase(tailscaleState);
  // A public address that is the relay's or a Tailscale name is shown on that way's row.
  const ownAddress = remote.publicBaseUrl?.way ? null : remote.publicBaseUrl?.configured;
  const hostServes = host?.state === "available" && host.servesGateway;
  const policies = devicePolicies(relay, tailscale);
  const applies = policies.relayLinked || policies.tailscaleOn;
  const accountNow = accountState(relayStatus);
  const [accountMark, accountTitle, plainDetail] = ACCOUNT_ITEMS[accountNow];
  // Before any account, the line says up front that creating one needs an invite.
  const accountDetail =
    accountNow === "none" && relayInviteOnly(relayStatus)
      ? `Private, invite only: creating an account needs an invite link. ${plainDetail}`
      : plainDetail;
  const google = !relayStatus?.account?.linked && relayStatus?.google?.linked;
  const mcp = mcpRows(remote);
  const mcpOn = mcp.filter((row) => row.reach !== "off");
  // The device's own address is on the Tailscale network only; its public address carries MCP alone.
  const tailscalePublic = tailscaleState?.public?.state === "on";
  const accountOn = accountMark === "on" || accountState(relayStatus) === "enrolled";
  const anything = accountOn || tailscaleOn || relayOn || hostServes || Boolean(ownAddress);
  const joinWays = [policies.relayLinked && "devices signing in with your account", policies.tailscaleOn && "devices on your Tailscale network"].filter(Boolean);

  return html`<div class="remote-access-summary">
    <div class="access-wizard-copy">
      <h3 ref=${headingRef} tabIndex="-1">Connectivity</h3>
      <p>What is on, and how your devices reach this gateway when they are away from home.</p>
    </div>
    ${relay &&
    html`<${Row} title="Omnesis account">
      <ul class="remote-access-items">
        <${Item}
          mark=${accountMark}
          title=${accountMark === "on" && google ? "Linked with Google" : accountTitle}
          detail=${accountDetail}
          action=${accountState(relayStatus) !== "unavailable" &&
          html`<${ItemManage} href=${ACCOUNT_PAGE} label="Omnesis account" on=${accountOn} onManage=${onManage} />`}
        />
      </ul>
    <//>`}
    <${Row} title="Remote connectivity">
      <ul class="remote-access-items">
        ${tailscale &&
        html`<${Item}
          mark=${!tailscaleOn ? "off" : tailscaleNow === "connected" ? "on" : "warn"}
          title="This gateway's own Tailscale device"
          detail=${!tailscaleOn
            ? "Off."
            : tailscaleNow === "connected"
              ? html`${tailscaleState.node?.dnsName
                  ? html`<${AddressLink} url=${`https://${tailscaleState.node.dnsName}`} />${tailscaleState.certificate?.source === "tailscale" ? ", with a trusted certificate" : ""}`
                  : tailscaleState.deviceName}${tailscalePublic
                  ? ", on your Tailscale network. Only its MCP server is public on the Internet."
                  : ", on your Tailscale network only. Not public on the Internet."}`
              : (TAILSCALE_PENDING[tailscaleNow] ?? "Needs attention on its page.")}
          action=${html`<${ItemManage} href=${TAILSCALE_PAGE} label="This gateway's own Tailscale device" on=${tailscaleOn} onManage=${onManage} />`}
        />`}
        ${relay &&
        html`<${Item}
          mark=${!relayOn ? "off" : relayPhaseNow === "connected" ? "on" : "warn"}
          title="Omnesis relay"
          detail=${!relayReady
            ? "Needs an Omnesis account."
            : !relayOn
              ? "Off."
              : relayPhaseNow === "connected"
                ? relayStatus.hostname
                  ? html`<${AddressLink} url=${`https://${relayStatus.hostname}`} />. Works from any network, nothing to install.`
                  : "Connected. Works from any network, nothing to install."
                : "Reconnecting…"}
          action=${html`<${ItemManage} href=${RELAY_PAGE} label="Omnesis relay" on=${relayOn} onManage=${onManage} />`}
        />`}
        ${host?.state !== "unsupported" &&
        html`<${Item}
          mark=${hostServes ? "on" : "off"}
          title="Tailscale on this computer"
          detail=${hostServes
            ? html`<${AddressLink} url=${host.url} />${host.publicGateway
                ? ", public on the Internet."
                : host.publicMcp
                  ? ", on your Tailscale network. Only its MCP server is public on the Internet."
                  : ", on your Tailscale network only. Not public on the Internet."}`
            : !host
              ? "Checking…"
              : host.state === "available"
                ? "Not serving this gateway."
                : host.state === "missing"
                  ? "Not installed on this computer."
                  : host.state === "stopped"
                    ? "Installed, but not running or not signed in."
                    : "Couldn't check."}
          action=${html`<${ItemManage} href=${HOST_TAILSCALE_PAGE} label="Tailscale on this computer" on=${hostServes} onManage=${onManage} />`}
        />`}
        <${Item}
          mark=${ownAddress ? "on" : "off"}
          title="Your own domain or reverse proxy"
          detail=${ownAddress ? html`<${AddressLink} url=${ownAddress} />.` : "None."}
          action=${html`<${ItemManage} href=${OWN_ADDRESS_PAGE} label="Your own domain" on=${Boolean(ownAddress)} onManage=${onManage} />`}
        />
        <${Item}
          mark=${mcpOn.length > 0 ? "on" : "off"}
          title="MCP server"
          detail=${mcp.length === 0
            ? "On this computer and your home network only, until an address away from home is set up."
            : mcpOn.length > 0
              ? `On ${listSentence(
                  mcpOn.map((row) => {
                    const label = MCP_ADDRESS_LABELS[row.id] ?? row.id;
                    return REACH_DETAILS[row.reach] && row.id !== "relay" ? `${label} (${REACH_DETAILS[row.reach]})` : label;
                  }),
                )}.`
              : "Off on every address away from home."}
          action=${html`<${ItemManage} href=${MCP_PAGE} label="MCP server" on=${mcpOn.length > 0} onManage=${onManage} />`}
        />
      </ul>
      ${tailscaleOn && relayOn && html`<${FirstChoice} remote=${remote} setRemote=${setRemote} />`}
    <//>
    ${(relay || tailscale) &&
    html`<${Row} title="New devices">
      ${applies
        ? html`<p class="remote-access-row-hint">
              One answer for ${joinWays.join(" and ")}. A pairing code from Settings, Devices always works too.
            </p>
            <${DevicesChoice} relay=${relay} tailscale=${tailscale} name="remote-access-summary-policy" />`
        : html`<ul class="remote-access-items">
            <${Item} mark="off" title="Only with a pairing code" detail="From Settings, Devices." />
          </ul>`}
    <//>`}
    <div class="remote-access-buttons">
      <button type="button" class="btn-secondary" onClick=${() => onStart(anything ? "review" : "setup")}>
        ${anything ? "Run the setup again" : "Set up step by step"}
      </button>
    </div>
  </div>`;
}
