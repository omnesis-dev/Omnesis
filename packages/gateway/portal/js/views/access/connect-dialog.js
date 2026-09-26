// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The dialog that connects an OAuth-capable MCP client: the MCP server address
// to paste into the client, then the short code the client's authorization
// window shows once it has registered. A matching code opens that pending
// request on its own page for review.
//
// The dialog is mounted only while it is open and only where OAuth is
// configured, so `oauth` is always a live address here.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { listDevices, lookupAccessAuthorization, pairDevice } from "../../api.js";
import { CopyIconButton } from "../../components/copy-button.js";
import { Modal } from "../../components/modal.js";
import { navigate } from "../../lib/router.js";
import { authorizationStatusNotice } from "./authorization.js";
import {
  PUBLISH_DOCS,
  agentSetups,
  harnessAddresses,
  reconnectableHarnessDevices,
  isPrivateAddress,
  servesUntrustedCertificate,
  usesNonStandardPort,
} from "./client-setup.js";
import { AgentIcon } from "./agent-brand.js";
import { errorMessage } from "./shared.js";

/**
 * Why a code the gateway does hold cannot be opened for review.
 *
 * A lapsed request keeps its pending status until the gateway sweeps it — the
 * expiry is a moment, not a state — so the clock is what tells the owner their
 * code went stale, and the status only speaks for a request somebody already
 * decided.
 */
function unusableCodeReason(request, now = Date.now()) {
  if (request.expiresAt <= now) {
    return "That code expired. The client can request a new one.";
  }
  return authorizationStatusNotice(request.status);
}

/** The warning mark on an agent card that cannot reach this gateway's address. */
const WARNING_GLYPH = html`<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>`;

function ExternalLink({ href, children }) {
  return html`<a href=${href} target="_blank" rel="noopener noreferrer">${children}</a>`;
}

/** A card's note: text parts, command names in code, and links. */
function NoteText({ parts }) {
  return parts.map((part) =>
    typeof part === "string"
      ? part
      : part.href
        ? html`<${ExternalLink} href=${part.href}>${part.text}<//>`
        : html`<code>${part.code}</code>`,
  );
}

/**
 * For an agent that only accepts a publicly issued certificate, where this
 * gateway serves one it will not accept, and how to give the gateway one.
 */
function TrustedCertificateNotice({ agent }) {
  return html`<div class="access-agent-public is-warning" role="alert">
    <p>
      <strong>This gateway's certificate is not publicly trusted.</strong> ${agent.needsTrustedCertificate}, so it cannot connect to this gateway with its self-signed certificate.
    </p>
    <p>
      <${ExternalLink} href=${PUBLISH_DOCS.certificates}>Give the gateway a Tailscale certificate<//>${" or "}<${ExternalLink} href=${PUBLISH_DOCS.domain}>use a domain of your own<//>.
    </p>
  </div>`;
}

/**
 * For an agent that reaches the gateway from the Internet: whether it can
 * reach this address at all, and where the docs explain publishing it.
 */
function PublicAddressNotice({ agent, resource }) {
  const privateAddress = isPrivateAddress(resource);
  const wrongPort = !privateAddress && agent.standardPortOnly && usesNonStandardPort(resource);
  const warning = privateAddress || wrongPort;
  return html`<div class=${`access-agent-public ${warning ? "is-warning" : ""}`} role=${warning ? "alert" : null}>
    <p>
      ${privateAddress
        ? html`<strong>This address is private.</strong> ${agent.needsPublicAddress}, so it cannot reach this gateway until you publish it.`
        : wrongPort
          ? html`<strong>This address uses port ${new URL(resource).port}.</strong> ${agent.standardPortOnly}, so it cannot reach this gateway there.`
          : html`${agent.needsPublicAddress}, so the address above must be reachable from the Internet${agent.standardPortOnly ? " on port 443" : ""}.`}
    </p>
    <p>
      <${ExternalLink} href=${PUBLISH_DOCS.funnel}>Publish the gateway with Tailscale Funnel<//>${" or "}<${ExternalLink} href=${PUBLISH_DOCS.domain}>use a domain of your own<//>.
    </p>
  </div>`;
}

/** No code yet; `target` is the device a minted code reconnects, or null. */
const EMPTY_PAIRING = { code: null, expiresAt: null, target: null, busy: false, error: "" };

/** The value of the choice that pairs a machine as a device of its own. */
const ANOTHER_MACHINE = "another";

/** A device's state, as the reconnect choice describes it. */
function deviceState(device) {
  if (device.revokedAt) return "revoked";
  return device.online ? "connected now" : "offline";
}

/**
 * When this gateway already has devices of the harness: whether the code is
 * for one of them, or for another machine. A code bound to a device keeps its
 * id — and every watch bound to it — and replaces its credentials wherever the
 * command runs; an unbound one pairs a new device, unless the machine running
 * it proves it is already one of these.
 */
function ReconnectChoice({ agentName, devices, target, onTarget, disabled }) {
  return html`<fieldset class="access-agent-reconnect" disabled=${disabled}>
    <legend>${agentName} is already connected to this gateway. What is this code for?</legend>
    ${devices.map(
      (device) => html`<label key=${device.id} class="access-agent-reconnect-option">
        <input
          type="radio"
          name="access-agent-reconnect"
          value=${device.id}
          checked=${target === device.id}
          onChange=${() => onTarget(device.id)}
        />
        <span>
          <span><strong>Reconnect ${device.name}</strong> <span class="access-agent-reconnect-state">(${deviceState(device)})</span></span>
          <small>Same device, new credentials: its watches and history stay, and its old credentials stop working. Run the command on that machine, or on the machine replacing it.</small>
        </span>
      </label>`,
    )}
    <label class="access-agent-reconnect-option">
      <input
        type="radio"
        name="access-agent-reconnect"
        value=${ANOTHER_MACHINE}
        checked=${target === ANOTHER_MACHINE}
        onChange=${() => onTarget(ANOTHER_MACHINE)}
      />
      <span>
        <strong>Connect another machine</strong>
        <small>A separate agent device, for a machine that is not connected yet.</small>
      </span>
    </label>
  </fieldset>`;
}

/**
 * What a managed integration's machine needs before its commands: the address
 * it pairs against, when the gateway accepts more than one, which existing
 * device the code reconnects, when there is one, and a pairing code minted
 * here so the commands carry it.
 */
function HarnessPairing({
  agentName,
  addresses,
  addressIdx,
  setAddressIdx,
  devices,
  devicesLoaded,
  target,
  onTarget,
  pairing,
  onPair,
}) {
  const expires = pairing.code
    ? new Date(pairing.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  const choosing = devices.find((device) => device.id === target) ?? null;
  // What the minted code does is what it was minted for, not the current choice.
  const reconnects = devices.find((device) => device.id === pairing.target) ?? null;
  const chosen = devicesLoaded && (devices.length === 0 || target !== null);
  return html`<div class="access-agent-pairing">
    ${addresses.length > 1 &&
    html`<label class="form-group">
      <span>Address the agent machine connects to</span>
      <select
        id="access-agent-address"
        value=${addressIdx}
        onChange=${(event) => setAddressIdx(Number(event.currentTarget.value))}
      >
        ${addresses.map(
          (address, index) => html`<option key=${address.gatewayUrl} value=${index}>
            ${address.gatewayUrl} —${" "}
            ${address.direct
              ? "direct to the gateway (recommended)"
              : "public address through a proxy, for machines outside your network"}
          </option>`,
        )}
      </select>
      <small>Use the direct address when that machine is on your network. Wherever the address presents the gateway's own certificate, the command checks it.</small>
    </label>`}
    ${devices.length > 0 &&
    html`<${ReconnectChoice} agentName=${agentName} devices=${devices} target=${target} onTarget=${onTarget} disabled=${pairing.busy} />`}
    ${pairing.code
      ? html`<p>
          Pairing code <code>${pairing.code}</code> is in the commands below${reconnects ? html`${" "}and reconnects <strong>${reconnects.name}</strong>` : ""}. It works once and expires at ${expires}.
        </p>`
      : html`<div class="access-agent-pair-action">
          <button type="button" class="btn-secondary" onClick=${onPair} disabled=${pairing.busy || !chosen}>
            ${pairing.busy ? "Creating…" : choosing ? `Create a code for ${choosing.name}` : "Create a pairing code"}
          </button>
          <span>${!devicesLoaded ? "Checking for connected devices…" : chosen ? "The command asks for one. Create it here and it is filled in." : "Choose what the code is for first."}</span>
        </div>`}
    ${pairing.error && html`<p class="access-error" role="alert">${pairing.error}</p>`}
  </div>`;
}

/** One copyable command; `labelled` names it above the box when it is not a tab. */
function AgentCommand({ agent, command, labelled }) {
  return html`<div class="access-agent-command">
    ${labelled && html`<span>${command.label}</span>`}
    <div class="access-mcp-resource">
      <code title=${command.value}>${command.value}</code>
      <${CopyIconButton} text=${command.value} class="access-copy-button" title=${`Copy command for ${agent.name}`} />
    </div>
  </div>`;
}

/** A grid of common agents; choosing one shows only that agent's setup. */
function AgentSetupPicker({ oauth }) {
  const [selectedId, setSelectedId] = useState(null);
  const [commandIdx, setCommandIdx] = useState(0);
  const [addressIdx, setAddressIdx] = useState(0);
  const [pairing, setPairing] = useState(EMPTY_PAIRING);
  const [devices, setDevices] = useState({ loaded: false, items: [] });
  const [target, setTarget] = useState(null);
  // Bumped whenever the choice a code would be minted for changes, so a code
  // still being minted for an earlier choice is dropped when it arrives.
  const mintGeneration = useRef(0);
  const addresses = harnessAddresses(oauth);
  const harnessAddress = addresses[Math.min(addressIdx, addresses.length - 1)];
  const agents = agentSetups(oauth, { harnessAddress, pairingCode: pairing.code ?? undefined });
  const selected = agents.find((agent) => agent.id === selectedId) ?? null;
  const pairsHarness = selected?.pairs ? selected.id : null;

  // Which devices of the chosen harness a code could reconnect. The operator
  // always chooses between them and another machine: a reconnect replaces the
  // device's credentials wherever the command runs, so it is never assumed.
  // A failure to read the list leaves the ordinary pairing, which a connected
  // machine still reconnects through with its own credentials.
  useEffect(() => {
    mintGeneration.current += 1;
    setDevices({ loaded: false, items: [] });
    setTarget(null);
    setPairing(EMPTY_PAIRING);
    if (!pairsHarness) return undefined;
    let current = true;
    listDevices()
      .then(({ items }) => {
        if (current) {
          setDevices({ loaded: true, items: reconnectableHarnessDevices(items, pairsHarness) });
        }
      })
      .catch(() => {
        if (current) setDevices({ loaded: true, items: [] });
      });
    return () => {
      current = false;
    };
  }, [pairsHarness]);

  function chooseTarget(next) {
    mintGeneration.current += 1;
    setTarget(next);
    setPairing(EMPTY_PAIRING);
  }

  async function createPairingCode() {
    const generation = mintGeneration.current;
    const repairDeviceId = target && target !== ANOTHER_MACHINE ? target : null;
    setPairing((current) => ({ ...current, busy: true, error: "" }));
    try {
      const result = await pairDevice({ kind: "agent", ...(repairDeviceId ? { repairDeviceId } : {}) });
      if (generation !== mintGeneration.current) return;
      setPairing({
        code: result.pairingCode,
        expiresAt: result.expiresAt,
        target: repairDeviceId,
        busy: false,
        error: "",
      });
    } catch (failure) {
      if (generation !== mintGeneration.current) return;
      setPairing({
        ...EMPTY_PAIRING,
        error: errorMessage(failure, "The pairing code could not be created."),
      });
    }
  }

  return html`<div class="access-agent-setup">
    <p class="access-agent-setup-label">Setup for common agents</p>
    <div class="backend-opt-grid access-agent-grid">
      ${agents.map(
        (agent) => html`<button
          type="button"
          key=${agent.id}
          class="backend-opt ${agent.id === selectedId ? "is-selected" : ""}"
          data-agent=${agent.id}
          aria-pressed=${agent.id === selectedId ? "true" : "false"}
          aria-controls="access-agent-steps"
          onClick=${() => {
            setSelectedId(agent.id === selectedId ? null : agent.id);
            setCommandIdx(0);
          }}
        >
          <span class="backend-opt-icon"><${AgentIcon} icon=${agent.icon} /></span>
          ${agent.blocked &&
          html`<span class="access-agent-warning" role="img" aria-label="Cannot connect to this gateway" title="Cannot connect to this gateway">${WARNING_GLYPH}</span>`}
          <span class="backend-opt-title">${agent.name}</span>
        </button>`,
      )}
    </div>
    ${selected &&
    html`<div class="access-agent-steps" id="access-agent-steps" data-agent=${selected.id}>
      ${selected.needsPublicAddress && html`<${PublicAddressNotice} agent=${selected} resource=${oauth.resource} />`}
      ${selected.needsTrustedCertificate && servesUntrustedCertificate(oauth) && html`<${TrustedCertificateNotice} agent=${selected} />`}
      ${selected.pairs &&
      html`<${HarnessPairing}
        agentName=${selected.name}
        addresses=${addresses}
        addressIdx=${addressIdx}
        setAddressIdx=${setAddressIdx}
        devices=${devices.items}
        devicesLoaded=${devices.loaded}
        target=${target}
        onTarget=${chooseTarget}
        pairing=${pairing}
        onPair=${createPairingCode}
      />`}
      ${selected.alternatives
        ? html`<div class="access-agent-tabbed">
            <div class="access-agent-tabs" role="tablist" aria-label=${`Ways to connect ${selected.name}`}>
              ${selected.commands.map(
                (command, index) => html`<button
                  type="button"
                  role="tab"
                  key=${command.label}
                  class=${index === commandIdx ? "active" : ""}
                  aria-selected=${index === commandIdx ? "true" : "false"}
                  onClick=${() => setCommandIdx(index)}
                >
                  ${command.label}
                </button>`,
              )}
            </div>
            <${AgentCommand} agent=${selected} command=${selected.commands[commandIdx] ?? selected.commands[0]} />
          </div>`
        : selected.commands.map(
            (command) => html`<${AgentCommand} key=${command.label} agent=${selected} command=${command} labelled />`,
          )}
      ${selected.note.length > 0 && html`<p><${NoteText} parts=${selected.note} /></p>`}
      ${selected.headless &&
      html`<div class="access-agent-headless">
        <p><strong>No browser on this machine?</strong> <${NoteText} parts=${selected.headless.note} /></p>
        ${selected.headless.command &&
        html`<${AgentCommand} agent=${selected} command=${{ label: "Sign in without a browser", value: selected.headless.command }} />`}
      </div>`}
      <p class="access-agent-docs">
        <${ExternalLink} href=${selected.docs}>${selected.name} setup in the docs<//>
      </p>
    </div>`}
  </div>`;
}

function ConnectStep({ number, title, caption, children }) {
  return html`<section class="access-connect-step">
    <span aria-hidden="true">${number}</span>
    <div>
      <h3>${title}</h3>
      <p>${caption}</p>
      ${children}
    </div>
  </section>`;
}

export function ConnectAgentDialog({ oauth, onClose }) {
  const [code, setCode] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [error, setError] = useState("");

  async function lookup(event) {
    event.preventDefault();
    const normalized = code.trim().toUpperCase();
    if (!normalized) return;
    setLookingUp(true);
    setError("");
    try {
      const result = await lookupAccessAuthorization(normalized);
      const unusable = result.request.status === "pending"
        ? (result.request.expiresAt <= Date.now() ? unusableCodeReason(result.request) : null)
        : unusableCodeReason(result.request);
      if (unusable) throw new Error(unusable);
      // The request has its own page. Closing first keeps the dialog from
      // springing back over that page's decision notice when the review sends
      // the address back here.
      close();
      navigate(
        `/portal/settings/access/authorizations/${encodeURIComponent(result.request.approvalId)}`,
      );
    } catch (failure) {
      // A code the gateway does not hold is the ordinary miss on this form, so
      // it is worded here rather than by the shared helper every page reads.
      setError(
        failure?.status === 404
          ? "No pending authorization matches that code. If the client has been waiting a while, its code may have expired — ask it for a new one."
          : errorMessage(failure, failure?.message || "The authorization code could not be checked."),
      );
    } finally {
      setLookingUp(false);
    }
  }

  function close() {
    setCode("");
    setError("");
    onClose();
  }

  return html`<${Modal} open title="Connect an agent" onClose=${close}>
    <div class="access-connect-dialog">
      <p class="access-explainer">An OAuth-capable MCP client connects in two steps.</p>
      <${ConnectStep}
        number="1"
        title="Add this MCP server to the client"
        caption=${oauth.loopbackOnly
          ? "This localhost address works only for agents running on the gateway’s machine. Hosted clients cannot reach it."
          : "Paste it into ChatGPT, Claude, Codex, or another OAuth-capable client."}
      >
        <div class="access-mcp-resource">
          <code>${oauth.resource}</code>
          <${CopyIconButton}
            text=${oauth.resource}
            class="access-copy-button"
            title="Copy MCP resource"
          />
        </div>
        <${AgentSetupPicker} oauth=${oauth} />
      <//>
      <${ConnectStep}
        number="2"
        title="If the sign-in page shows a code, enter it here"
        caption="When the agent's sign-in opens in a browser already signed in to this portal, you approve it there and can skip this step. Otherwise the sign-in page shows a short code: enter it here or on your phone."
      >
        <form onSubmit=${lookup} aria-busy=${lookingUp ? "true" : "false"}>
          <label class="form-group">
            <span>Authorization code</span>
            <input
              class="access-code-input"
              autocomplete="one-time-code"
              maxlength="20"
              placeholder="ABCD-EFGH"
              value=${code}
              onInput=${(event) => setCode(event.currentTarget.value)}
              disabled=${lookingUp}
            />
          </label>
          <button type="submit" class="btn-primary" disabled=${lookingUp || !code.trim()}>${lookingUp ? "Checking…" : "Review request"}</button>
        </form>
        <p class="access-connect-status" role="status">${lookingUp ? "Checking the authorization code…" : ""}</p>
        ${error && html`<p class="access-error" role="alert">${error}</p>`}
      <//>
      <div class="access-request-actions">
        <button type="button" class="btn-secondary" onClick=${close}>Close</button>
      </div>
    </div>
  <//>`;
}
