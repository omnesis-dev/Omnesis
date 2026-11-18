// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Which of the gateway's addresses away from home answer its MCP server, and
// how far. The last step of the Connectivity setup, the MCP server page behind
// the summary, and the summary's own line all read `mcpAddresses` from
// GET /admin/remote-access: one row per address, with where MCP answers there
// now, the choices that address offers and whether that way in is set up. A
// Tailscale address can keep MCP to the owner's Tailscale network or put it on
// the Internet too; the relay and the owner's own domain are on or off. Letting
// MCP answer further asks for the passkey where the gateway requires it;
// narrowing it never does. Putting MCP on the Internet through Tailscale on this
// computer runs Tailscale Funnel; when the gateway may not, the command to run
// is shown with a check under it. Agents on this computer and the home network
// always reach the MCP server.

import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { CopyBlock } from "../../components/copy-button.js";
import { getRemoteAccess, updateRemoteAccess } from "../../lib/remote-access-api.js";
import { PageLink, TAILSCALE_PAGE } from "./manage.js";
import { BackButton, StepFrame, nextLabel } from "./step-frame.js";

/** How each address is named, in the setup's words. */
export const MCP_ADDRESS_LABELS = {
  relay: "Omnesis relay",
  tailnet: "This gateway's own Tailscale device",
  host: "Tailscale on this computer",
  domain: "Your own domain or reverse proxy",
};

/** How each choice is named. */
const REACH_LABELS = {
  off: "Off",
  private: "Your Tailscale network",
  public: "Your Tailscale network and the Internet",
  on: "On",
};

/** How far MCP answers on an address, as the summary says it. */
export const REACH_DETAILS = {
  private: "your Tailscale network only",
  public: "also on the Internet",
};

const ALWAYS = "Agents on this computer and on your home network can always connect.";

/** The addresses that exist right now, in the gateway's order. */
export function mcpRows(remote) {
  return (remote?.mcpAddresses ?? []).filter((row) => row.available);
}

/** The choice's name: the relay is reachable from the Internet anyway, so it is simply on. */
const choiceLabel = (row, reach) => (row.id === "relay" && reach === "public" ? "On" : REACH_LABELS[reach]);

/** The MCP endpoint at an address's origin. */
const endpoint = (url) => (url ? `${url.replace(/\/$/u, "")}/mcp` : null);

/** Whether an address names a port, which agents that connect only on 443 cannot use. */
const hasPort = (url) => {
  try {
    return new URL(url).port !== "";
  } catch {
    return false;
  }
};

/** Said wherever an address on a port other than 443 offers MCP. */
export function PortCaveat({ url }) {
  return html`Some agents, such as ChatGPT, connect only on port 443, so <code>${endpoint(url)}</code> may not
    work with them.`;
}

/** What a choice means beyond its name, where that is not obvious. */
function ChoiceNote({ row, reach }) {
  if (reach === "public" && row.id === "host")
    return html`<small>
      Only the MCP server goes on the Internet. The portal and your devices' connections stay on your Tailscale
      network unless you make them public on the page for Tailscale on this computer.
    </small>`;
  if (reach === "public" && row.id === "tailnet")
    return html`<small>
      Only the MCP server goes on the Internet, through Tailscale Funnel.${row.opening
        ? html`${" "}Tailscale hasn't opened it yet: see what it needs on the page for${" "}
            <${PageLink} href=${TAILSCALE_PAGE}>this gateway's own Tailscale device<//>.`
        : null}
    </small>`;
  return null;
}

/** One card per address away from home, with where MCP answers there, changed in place. */
export function McpChoice({ remote, setRemote }) {
  // The choice being saved: `{ id, reach }`.
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState("");
  // What Tailscale on this computer refused to change: `{ reason, command }`.
  const [refused, setRefused] = useState(null);
  const [checking, setChecking] = useState(false);
  const rows = mcpRows(remote);
  const choose = async (id, reach) => {
    setSaving({ id, reach });
    setError("");
    setRefused(null);
    try {
      const { mcpRefusal, ...state } = await updateRemoteAccess({ mcp: { [id]: reach } });
      setRemote(state);
      if (mcpRefusal) setRefused({ ...mcpRefusal, id, reach });
    } catch (cause) {
      setError((cause?.stepUp === true && cause.message) || cause?.serverMessage || "Couldn't change that. Try again.");
    } finally {
      setSaving(null);
    }
  };
  const check = async () => {
    setChecking(true);
    setError("");
    try {
      const state = await getRemoteAccess();
      setRemote(state);
      const row = state.mcpAddresses?.find((entry) => entry.id === refused.id);
      if (row?.reach === refused.reach) setRefused(null);
      else setError("Tailscale on this computer hasn't changed yet. Run the command above, then check again.");
    } catch (cause) {
      setError(cause?.serverMessage || "Couldn't check. Try again.");
    } finally {
      setChecking(false);
    }
  };
  if (rows.length === 0)
    return html`<p class="remote-access-muted">No address away from home is set up yet. ${ALWAYS}</p>`;
  return html`<div class="remote-access-mcp">
    ${rows.map((row) => {
      const reach = saving?.id === row.id ? saving.reach : row.reach;
      return html`<fieldset key=${row.id} class=${`remote-access-mcp-row${reach === "off" ? "" : " is-on"}`}>
        <legend class="remote-access-option-text">
          <strong>${MCP_ADDRESS_LABELS[row.id] ?? row.id}</strong>
          ${endpoint(row.url) && html`<small><code>${endpoint(row.url)}</code></small>`}
        </legend>
        <div class="remote-access-choices is-compact">
          ${row.choices.map(
            (choice) => html`<label key=${choice} class=${`remote-access-choice${reach === choice ? " is-on" : ""}`}>
              <input
                type="radio"
                name=${`remote-access-mcp-${row.id}`}
                value=${choice}
                checked=${reach === choice}
                disabled=${Boolean(saving) || checking}
                onChange=${() => choose(row.id, choice)}
              />
              <span class="remote-access-option-text"><strong>${choiceLabel(row, choice)}</strong></span>
            </label>`,
          )}
        </div>
        <${ChoiceNote} row=${row} reach=${reach} />
        ${reach !== "off" &&
        hasPort(row.url) &&
        html`<small>Some agents, such as ChatGPT, connect only on port 443 and may not reach it.</small>`}
        ${refused?.id === row.id &&
        html`<div class="remote-access-command">
          <p class="remote-access-problem" role="alert">${refused.reason}</p>
          ${refused.command &&
          html`<${CopyBlock} text=${refused.command} title="Copy command" />
            <div class="remote-access-buttons">
              <button type="button" class="btn-secondary" disabled=${checking} onClick=${check}>
                ${checking ? "Checking…" : "I've run it, check it"}
              </button>
            </div>`}
        </div>`}
      </fieldset>`;
    })}
    <p class="remote-access-choice-detail">${ALWAYS}</p>
    ${error && html`<p class="remote-access-problem" role="alert">${error}</p>`}
  </div>`;
}

/** The setup's last step: where agents may reach the MCP server. */
export function McpStep({ flow, steps, headingRef, error, onStep, onNext, onCancel, onBack, last, finishing, remote, setRemote }) {
  return html`<${StepFrame}
    flow=${flow}
    steps=${steps}
    heading="Where may agents reach your MCP server?"
    blurb="Agents like ChatGPT, Claude or Codex connect to an MCP address. Choose the addresses away from home that offer it."
    headingRef=${headingRef}
    error=${error}
    onStep=${onStep}
    onCancel=${onCancel}
    actions=${html`<${BackButton} onBack=${onBack} disabled=${finishing} />
      <button type="button" class="btn-primary" disabled=${finishing} onClick=${onNext}>
        ${finishing ? "Finishing…" : nextLabel(last)}
      </button>`}
  >
    <${McpChoice} remote=${remote} setRemote=${setRemote} />
  <//>`;
}
