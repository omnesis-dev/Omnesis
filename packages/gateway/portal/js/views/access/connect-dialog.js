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
  CERTIFICATE_DOWNLOAD,
  PUBLISH_DOCS,
  agentSetups,
  harnessAddresses,
  reconnectableHarnessDevices,
  mainAddressCertificate,
  mainCertificatePending,
  servesUntrustedCertificate,
} from "./client-setup.js";
import { DOCS, NO_RELAY, NO_TAILSCALE } from "./public-address.js";
import {
  AGENT_LOCATIONS,
  LOCATION_LABELS,
  awayChoices,
  homeAddresses,
  initialLocation,
  locationHarnessAddress,
  locationOauth,
  machineAddress,
  machineProblem,
} from "./agent-location.js";
import { AgentIcon } from "./agent-brand.js";
import { CONNECTIVITY_PAGE, OWN_ADDRESS_PAGE } from "../remote-access/manage.js";
import { HOME_NETWORK_WARNINGS } from "../remote-access/at-home.js";
import { updateRemoteAccess } from "../../lib/remote-access-api.js";
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

/** A card's note: text parts, command names in code, links to the docs, and pages of the portal. */
function NoteText({ parts }) {
  return parts.map((part) => {
    if (typeof part === "string") return part;
    if (part.href) return html`<${ExternalLink} href=${part.href}>${part.text}<//>`;
    if (part.route)
      return html`<a
        href=${part.route}
        onClick=${(event) => {
          event.preventDefault();
          navigate(part.route);
        }}
      >${part.text}</a>`;
    return html`<code>${part.code}</code>`;
  });
}

/**
 * For an agent that only accepts a certificate from an authority it trusts,
 * where this gateway serves one it will not accept, and how to give the
 * gateway one. An agent that can be told to trust an mkcert root, but not a
 * self-signed certificate, is pointed at mkcert as well.
 */
function TrustedCertificateNotice({ agent, certificate }) {
  const kinds = agent.certificateTrust?.kinds ?? [];
  const selfSigned = certificate?.kind === "self-signed";
  const refusesSelfSigned = selfSigned && !kinds.includes("self-signed");
  const offersMkcert = selfSigned && kinds.includes("mkcert");
  return html`<div class="access-agent-public is-warning" role="alert">
    <p>
      <strong>This gateway's certificate is not publicly trusted.</strong>${" "}
      ${refusesSelfSigned
        ? `${agent.name} cannot trust a self-signed certificate, so it cannot connect to this gateway until the gateway serves another one.`
        : `${agent.needsTrustedCertificate}, so it cannot connect to this gateway with ${selfSigned ? "its self-signed certificate" : "the certificate it serves"}.`}
    </p>
    <p>
      <${ExternalLink} href=${PUBLISH_DOCS.certificates}>Give the gateway a Tailscale certificate<//>${offersMkcert ? ", " : " or "}<a
        href=${OWN_ADDRESS_PAGE}
        onClick=${(event) => {
          event.preventDefault();
          navigate(OWN_ADDRESS_PAGE);
        }}
      >use a domain of your own</a>${offersMkcert
        ? html`, or <${ExternalLink} href=${PUBLISH_DOCS.certificates}>mint an mkcert certificate<//>, which ${agent.name} trusts with one setting`
        : ""}.
    </p>
  </div>`;
}

/**
 * For an agent that only accepts a publicly trusted certificate, while the
 * address it would dial is still getting one: nothing for the owner to do but
 * wait, and the page looks again by itself.
 */
function CertificatePendingNotice({ agent }) {
  return html`<div class="access-agent-public" role="status">
    <p>
      <strong>This address is still getting its trusted certificate.</strong>${" "}
      ${agent.name} can connect once the gateway has it, usually within a minute. This page checks again by itself.
    </p>
  </div>`;
}

/**
 * The setting that makes an agent trust this gateway's certificate, to run
 * before the agent's own commands. The file is on the gateway's machine.
 */
function CertificateTrustStep({ agent }) {
  const step = agent.trustStep;
  return html`<div class="access-agent-trust">
    ${step.download
      ? html`<span class="access-agent-trust-label">${step.label}</span>
          <p>
            <a class="btn-secondary access-agent-download" href=${CERTIFICATE_DOWNLOAD} download=${step.download}>Download the certificate</a>
            ${" "}Save it in your home folder as <code>${step.download}</code> on the computer ${agent.name} runs on, then:
          </p>
          ${step.authority &&
          html`<p>
            This is the mkcert authority of this gateway's computer: a computer that trusts it also trusts every other
            certificate made with it there, so keep it to computers you own.
          </p>`}
          <${AgentCommand} agent=${agent} command=${step} />`
      : html`<${AgentCommand} agent=${agent} command=${step} labelled />`}
    <p>
      Ensure <code>${step.variable}</code> is set where ${agent.name} runs.${" "}
      <${ExternalLink} href=${PUBLISH_DOCS.trust}>Trusting the gateway's certificate<//>.
    </p>
  </div>`;
}

/**
 * For an agent on another computer at home that cannot trust the certificate
 * this gateway serves there: said before anything else, with what works
 * instead. Running the agent on this computer needs no certificate at all; an
 * address away from home has one the agent trusts.
 */
function HomeTrustNotice({ agent, certificate, onLocation, machinePlain }) {
  const kinds = agent.certificateTrust?.kinds ?? [];
  const selfSigned = certificate?.kind === "self-signed";
  return html`<div class="access-agent-public is-warning" role="alert">
    <p>
      <strong>${agent.name} can't connect over your home network.</strong>${" "}
      ${agent.certificateTrust?.gatewayComputerOnly
        ? `Its setting for trusting another certificate may replace the authorities it already trusts and cut it off from its own service, so Omnesis doesn't offer it for another computer yet.`
        : selfSigned && !kinds.includes("self-signed")
          ? `It can't trust a self-signed certificate, which is what this gateway serves there.`
          : `It trusts only a certificate from an authority it knows, and the one this gateway serves there isn't.`}
    </p>
    <p>
      ${machinePlain &&
      html`If ${agent.name} can run on the computer this gateway runs on,${" "}
        <button type="button" class="access-link-button" onClick=${() => onLocation("machine")}>choose On this computer</button>:
        that address needs no certificate.${" "}`}${selfSigned && kinds.includes("mkcert") && !agent.certificateTrust?.gatewayComputerOnly
        ? html`${machinePlain ? "Or " : ""}<${ExternalLink} href=${PUBLISH_DOCS.certificates}>give the gateway an mkcert certificate<//>, which ${agent.name} trusts with one setting.${" "}`
        : ""}Otherwise reach this gateway from away, through an address set up in${" "}
      <a
        href=${CONNECTIVITY_PAGE}
        onClick=${(event) => {
          event.preventDefault();
          navigate(CONNECTIVITY_PAGE);
        }}
      >Settings, Connectivity</a>.
    </p>
  </div>`;
}

/**
 * A notice's text: strings, a bold lead, links to the docs, and links to
 * another page of the portal.
 */
function NoticeText({ parts }) {
  return parts.map((part) => {
    if (typeof part === "string") return part;
    if (part.strong) return html`<strong>${part.strong}</strong>`;
    if (part.href) return html`<${ExternalLink} href=${part.href}>${part.text}<//>`;
    return html`<a
      href=${part.route}
      onClick=${(event) => {
        event.preventDefault();
        navigate(part.route);
      }}
    >${part.text}</a>`;
  });
}

/**
 * What the selected address means for an agent: whether it can reach it, and
 * what to do when it cannot. The wording is `hostedClientAddress`'s and
 * `localClientAddress`'s, the same for every agent in the same situation.
 */
function AddressNotice({ agent }) {
  const { notice } = agent.addressNotice;
  return html`<div class=${`access-agent-public ${notice.warning ? "is-warning" : ""}`} role=${notice.warning ? "alert" : null}>
    ${notice.paragraphs.map((parts) => html`<p><${NoticeText} parts=${parts} /></p>`)}
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
/**
 * `oauth.resource` is the address selected above the grid. Where the person
 * picks it there (`addressSelectable`), a managed integration pairs against
 * that address and offers no second choice of its own.
 */
function AgentSetupPicker({ oauth, relay, tailscale, addressSelectable, location = "away", locationHarness = null, onLocation, machinePlain = false }) {
  const [selectedId, setSelectedId] = useState(null);
  const [commandIdx, setCommandIdx] = useState(0);
  const [addressIdx, setAddressIdx] = useState(0);
  const [pairing, setPairing] = useState(EMPTY_PAIRING);
  const [devices, setDevices] = useState({ loaded: false, items: [] });
  const [target, setTarget] = useState(null);
  // Bumped whenever the choice a code would be minted for changes, so a code
  // still being minted for an earlier choice is dropped when it arrives.
  const mintGeneration = useRef(0);
  const everyAddress = location === "away" ? harnessAddresses(oauth) : locationHarness ? [locationHarness] : [];
  const selectedAddress = everyAddress.find(
    (address) => address.gatewayUrl === oauth.resource.replace(/\/mcp$/u, ""),
  );
  const addresses = addressSelectable && selectedAddress ? [selectedAddress] : everyAddress;
  const harnessAddress = addresses[Math.min(addressIdx, addresses.length - 1)];
  const agents = agentSetups(oauth, {
    harnessAddress,
    pairingCode: pairing.code ?? undefined,
    relay,
    tailscale,
    location,
  }).filter((agent) => !agent.pairs || harnessAddress);
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
    ${location !== "away" &&
    html`<p class="access-agent-elsewhere">
      ChatGPT, Claude apps and Grok bot connect from their own servers, which can't reach this address.${" "}
      <button type="button" class="access-link-button" onClick=${() => onLocation("away")}>Set them up under Somewhere else</button>.
    </p>`}
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
      ${selected.addressNotice && html`<${AddressNotice} agent=${selected} />`}
      ${selected.blocked &&
      selected.addressNotice?.usable !== false &&
      selected.needsTrustedCertificate &&
      servesUntrustedCertificate(oauth) &&
      (location === "home"
        ? html`<${HomeTrustNotice} agent=${selected} certificate=${oauth.certificate} onLocation=${onLocation} machinePlain=${machinePlain} />`
        : mainCertificatePending(oauth)
          ? html`<${CertificatePendingNotice} agent=${selected} />`
          : html`<${TrustedCertificateNotice} agent=${selected} certificate=${mainAddressCertificate(oauth)} />`)}
      ${selected.trustStep && html`<${CertificateTrustStep} agent=${selected} />`}
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
      ${caption && html`<p>${caption}</p>`}
      ${children}
    </div>
  </section>`;
}

/** The address an agent copies, picked from a list where there is more than one. */
function AddressField({ options, value, onPick, label = "MCP server address" }) {
  return html`<div class=${`access-mcp-resource${options.length > 1 ? " access-mcp-picker" : ""}`}>
    ${options.length > 1
      ? html`<select id="access-mcp-address" aria-label=${label} value=${value} onChange=${(event) => onPick(event.currentTarget.value)}>
          ${options.map(
            (option) => html`<option key=${option.resource} value=${option.resource} selected=${option.resource === value}>${option.resource}</option>`,
          )}
        </select>`
      : html`<code>${value}</code>`}
    <${CopyIconButton} text=${value} class="access-copy-button" title="Copy MCP resource" />
  </div>`;
}

/** What the address under the question is for, by where the agent runs. */
function addressCaption(location, selectable) {
  if (selectable) return "Pick the address the agent will use, then paste it into the client.";
  switch (location) {
    case "machine":
      return "Paste it into Claude Code, Codex, or another agent on this computer.";
    case "home":
      return "Paste it into Claude Code, Codex, or another agent on that computer.";
    default:
      return "Paste it into ChatGPT, Claude, Codex, or another OAuth-capable client.";
  }
}

/** Where the agent runs: three choices, side by side where there is room. */
function LocationPicker({ location, onLocation }) {
  return html`<fieldset class="access-location-picker">
    <legend>Where does the agent run?</legend>
    ${AGENT_LOCATIONS.map(
      (id) => html`<label key=${id} class=${`access-location-option${location === id ? " is-on" : ""}`}>
        <input type="radio" name="access-agent-location" value=${id} checked=${location === id} onChange=${() => onLocation(id)} />
        <span>
          <strong>${LOCATION_LABELS[id].title}</strong>
          <small>${LOCATION_LABELS[id].text}</small>
        </span>
      </label>`,
    )}
  </fieldset>`;
}

/** A note under an address: text parts, as `NoteText` reads them. */
function AddressNote({ parts, warning = false }) {
  return html`<div class=${`access-agent-public${warning ? " is-warning" : ""}`} role=${warning ? "alert" : null}>
    <p><${NoteText} parts=${parts} /></p>
  </div>`;
}

/**
 * The home network while agents there may not sign in: what allowing it
 * means, said before the owner chooses, and the switch itself. Allowing it may
 * ask for the passkey, as on the MCP server page.
 */
function AllowHomeNetwork({ onAllowed }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const allow = async () => {
    setBusy(true);
    setError("");
    try {
      await updateRemoteAccess({ mcp: { home: "on" } });
      await onAllowed();
    } catch (cause) {
      setError((cause?.stepUp === true && cause.message) || cause?.serverMessage || "Couldn't change that. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="access-home-allow">
    <p><strong>Agents on your home network can't sign in yet.</strong> Before you allow it:</p>
    <ul>
      ${HOME_NETWORK_WARNINGS.map((warning) => html`<li key=${warning}>${warning}</li>`)}
    </ul>
    <div class="access-home-allow-actions">
      <button type="button" class="btn-primary" disabled=${busy} onClick=${allow}>
        ${busy ? "Allowing…" : "Allow agents on my home network"}
      </button>
      <${ExternalLink} href=${`${DOCS}/connect#home-network`}>Home network in the docs<//>
    </div>
    ${error && html`<p class="access-error" role="alert">${error}</p>`}
  </div>`;
}

/**
 * `relay` is the gateway's relay-hosted address, from `relayPublicAddress`,
 * and `tailscale` its Tailscale device's address, from `tailscalePublicAddress`.
 * The first question is where the agent runs; the address it gets, and every
 * agent's setup below, follow from the answer (see `agent-location.js`).
 * `onRefresh` reads the overview again, after the home network is allowed.
 */
export function ConnectAgentDialog({ oauth: overviewOauth, relay = NO_RELAY, tailscale = NO_TAILSCALE, onClose, onRefresh = async () => {} }) {
  const [location, setLocation] = useState(() => initialLocation(overviewOauth, relay, tailscale));
  const [picked, setPicked] = useState({});
  const machine = machineAddress(overviewOauth);
  const home = homeAddresses(overviewOauth);
  const away = awayChoices(overviewOauth, relay, tailscale);
  const options = {
    machine: machine.resource ? [{ resource: machine.resource }] : [],
    home: home.allowed ? home.entries : [],
    // Without the relay or a Tailscale address there is one address away from home, and no choice.
    away: away.selectable ? away.options : away.initial ? [{ resource: away.initial }] : [],
  }[location];
  const fallback = location === "away" ? away.initial : (options[0]?.resource ?? null);
  const address = options.some((option) => option.resource === picked[location]) ? picked[location] : fallback;
  const oauth = address ? locationOauth(overviewOauth, location, address) : null;
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

  const problem = location === "machine" ? machineProblem(machine) : null;
  const addressBlock = (() => {
    if (location === "home" && !home.offered)
      return html`<${AddressNote}
        warning
        parts=${["This gateway listens on this computer only, so other computers can't reach it. Run the agent on this computer, or reach the gateway from away."]}
      />`;
    if (location === "home" && !home.allowed) return html`<${AllowHomeNetwork} onAllowed=${onRefresh} />`;
    if (location === "home" && options.length === 0)
      return html`<${AddressNote}
        warning
        parts=${["This gateway found no address of its own on your home network. Check that this computer is connected to it."]}
      />`;
    if (location === "away" && options.length === 0)
      return html`<${AddressNote}
        parts=${[
          "This gateway has no address away from home yet. Set one up in ",
          { route: CONNECTIVITY_PAGE, text: "Settings, Connectivity" },
          ".",
        ]}
      />`;
    if (!address) return html`<${AddressNote} warning parts=${["No address for this computer answers right now."]} />`;
    return html`<p class="access-address-caption">${addressCaption(location, options.length > 1)}</p>
      <${AddressField} options=${options} value=${address} onPick=${(value) => setPicked({ ...picked, [location]: value })} />
      ${location === "machine" &&
      (problem
        ? html`<${AddressNote} warning parts=${problem} />`
        : html`<${AddressNote} parts=${["Only programs on this computer can use this address, and it needs no certificate step."]} />`)}
      ${location === "home" &&
      html`<${AddressNote}
        parts=${[
          options.length > 1 ? "Prefer the .local name: an address in numbers can change when your router hands out a new one. " : "",
          "Anyone on your network can reach this address; a connection still needs your approval.",
        ]}
      />`}
`;
  })();

  return html`<${Modal} open title="Connect an agent" onClose=${close}>
    <div class="access-connect-dialog">
      <p class="access-explainer">MCP is how agents such as Claude Code or ChatGPT plug into this gateway. An agent connects in two steps, and you approve it.</p>
      <${ConnectStep} number="1" title="Add this MCP server to the client">
        <${LocationPicker} location=${location} onLocation=${setLocation} />
        ${addressBlock}
        ${oauth &&
        html`<${AgentSetupPicker}
          key=${location}
          oauth=${oauth}
          relay=${relay}
          tailscale=${tailscale}
          addressSelectable=${location === "away" && away.selectable}
          location=${location}
          locationHarness=${locationHarnessAddress(overviewOauth, location, address)}
          onLocation=${setLocation}
          machinePlain=${machine.plain}
        />`}
      <//>
      ${oauth &&
      html`<${ConnectStep}
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
      <//>`}
      <div class="access-request-actions">
        <button type="button" class="btn-secondary" onClick=${close}>Close</button>
      </div>
    </div>
  <//>`;
}
