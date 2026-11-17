// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Which of the gateway's addresses away from home answer its MCP server. The
// last step of the Connectivity setup, the MCP server page behind the summary,
// and the summary's own line all read `mcpAddresses` from
// GET /admin/remote-access: one row per address, with whether MCP answers
// there and whether that way in is set up. Turning an address on asks for the
// passkey where the gateway requires it; turning one off never does. Agents on
// this computer and the home network always reach the MCP server.

import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { updateRemoteAccess } from "../../lib/remote-access-api.js";
import { BackButton, StepFrame, nextLabel } from "./step-frame.js";

/** How each address is named, in the setup's words. */
export const MCP_ADDRESS_LABELS = {
  relay: "Omnesis relay",
  tailnet: "This gateway's own Tailscale device",
  tailscalePublic: "This gateway's own Tailscale device, public on the Internet",
  host: "Tailscale on this computer",
  domain: "Your own domain or reverse proxy",
};

const ALWAYS = "Agents on this computer and on your home network can always connect.";

/** The addresses that exist right now, in the gateway's order. */
export function mcpRows(remote) {
  return (remote?.mcpAddresses ?? []).filter((row) => row.available);
}

/** The MCP endpoint at an address's origin. */
const endpoint = (url) => (url ? `${url.replace(/\/$/u, "")}/mcp` : null);

/** One tick per address away from home, changed in place. */
export function McpChoice({ remote, setRemote }) {
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  const rows = mcpRows(remote);
  const toggle = async (id, enabled) => {
    setSaving(id);
    setError("");
    try {
      setRemote(await updateRemoteAccess({ mcp: { [id]: enabled } }));
    } catch (cause) {
      setError((cause?.stepUp === true && cause.message) || cause?.serverMessage || "Couldn't change that. Try again.");
    } finally {
      setSaving("");
    }
  };
  if (rows.length === 0)
    return html`<p class="remote-access-muted">No address away from home is set up yet. ${ALWAYS}</p>`;
  return html`<fieldset class="remote-access-choices" aria-label="Addresses that answer the MCP server">
    ${rows.map((row) => {
      const on = saving === row.id ? !row.enabled : row.enabled;
      return html`<label key=${row.id} class=${`remote-access-choice${on ? " is-on" : ""}`}>
        <input
          type="checkbox"
          name="remote-access-mcp"
          value=${row.id}
          checked=${on}
          disabled=${Boolean(saving)}
          onChange=${(event) => toggle(row.id, event.currentTarget.checked)}
        />
        <span class="remote-access-option-text">
          <strong>${MCP_ADDRESS_LABELS[row.id] ?? row.id}</strong>
          ${endpoint(row.url) && html`<small><code>${endpoint(row.url)}</code></small>`}
        </span>
      </label>`;
    })}
    <p class="remote-access-choice-detail">${ALWAYS}</p>
    ${error && html`<p class="remote-access-problem" role="alert">${error}</p>`}
  </fieldset>`;
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
