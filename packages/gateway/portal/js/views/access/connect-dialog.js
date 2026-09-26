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
import { useState } from "preact/hooks";

import { lookupAccessAuthorization, pairDevice } from "../../api.js";
import { CopyIconButton } from "../../components/copy-button.js";
import { Modal } from "../../components/modal.js";
import { navigate } from "../../lib/router.js";
import { authorizationStatusNotice } from "./authorization.js";
import {
  PUBLISH_DOCS,
  agentSetups,
  harnessAddresses,
  isPrivateAddress,
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

/**
 * What a managed integration's machine needs before its commands: the address
 * it pairs against, when the gateway accepts more than one, and a pairing code
 * minted here so the commands carry it.
 */
function HarnessPairing({ addresses, addressIdx, setAddressIdx, pairing, onPair }) {
  const expires = pairing.code
    ? new Date(pairing.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
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
            ${address.servedByGateway
              ? "direct to the gateway (recommended)"
              : "public address through a proxy, for machines outside your network"}
          </option>`,
        )}
      </select>
      <small>Use the direct address when that machine is on your network. The command can then check the gateway's certificate.</small>
    </label>`}
    ${pairing.code
      ? html`<p>Pairing code <code>${pairing.code}</code> is in the commands below. It works once and expires at ${expires}.</p>`
      : html`<div class="access-agent-pair-action">
          <button type="button" class="btn-secondary" onClick=${onPair} disabled=${pairing.busy}>
            ${pairing.busy ? "Creating…" : "Create a pairing code"}
          </button>
          <span>The command asks for one. Create it here and it is filled in.</span>
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
  const [pairing, setPairing] = useState({ code: null, expiresAt: null, busy: false, error: "" });
  const addresses = harnessAddresses(oauth);
  const harnessAddress = addresses[Math.min(addressIdx, addresses.length - 1)];
  const agents = agentSetups(oauth, { harnessAddress, pairingCode: pairing.code ?? undefined });
  const selected = agents.find((agent) => agent.id === selectedId) ?? null;

  async function createPairingCode() {
    setPairing((current) => ({ ...current, busy: true, error: "" }));
    try {
      const result = await pairDevice({ kind: "agent" });
      setPairing({ code: result.pairingCode, expiresAt: result.expiresAt, busy: false, error: "" });
    } catch (failure) {
      setPairing({
        code: null,
        expiresAt: null,
        busy: false,
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
          html`<span class="access-agent-warning" role="img" aria-label="Cannot reach this address" title="Cannot reach this address">${WARNING_GLYPH}</span>`}
          <span class="backend-opt-title">${agent.name}</span>
        </button>`,
      )}
    </div>
    ${selected &&
    html`<div class="access-agent-steps" id="access-agent-steps" data-agent=${selected.id}>
      ${selected.needsPublicAddress && html`<${PublicAddressNotice} agent=${selected} resource=${oauth.resource} />`}
      ${selected.pairs &&
      html`<${HarnessPairing}
        addresses=${addresses}
        addressIdx=${addressIdx}
        setAddressIdx=${setAddressIdx}
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
        caption="Paste it into ChatGPT, Claude, Codex, or another OAuth-capable client."
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
