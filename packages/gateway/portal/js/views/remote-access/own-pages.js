// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The pages behind Settings → Connectivity for the two ways in the owner runs
// themselves — Tailscale already on this computer, and their own domain or
// reverse proxy — and for the MCP server. Each shows the same panel as its
// step of the setup, so any of them can be set up or changed from the summary
// without walking the setup.

import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { useRemoteAccess } from "../remote-access.js";
import { MCP_BLURB, McpChoice } from "./mcp.js";
import { HostTailscale, OwnAddress } from "./own-setup.js";

function Page({ title, blurb, children }) {
  const { remote, setRemote, error, load } = useRemoteAccess();
  return html`<section class="remote-access-view remote-access-page" aria-label=${title}>
    <div class="access-wizard-copy">
      <h3>${title}</h3>
      <p>${blurb}</p>
    </div>
    ${error &&
    html`<div class="remote-access-load-error" role="alert">
      <span>${error}</span>
      <button type="button" class="btn-secondary" onClick=${load}>Try again</button>
    </div>`}
    ${!remote && !error && html`<p class="remote-access-loading" role="status">Loading…</p>`}
    ${remote && html`<div class="remote-access-page-body">${children(remote, setRemote)}</div>`}
  </section>`;
}

export function HostTailscaleView() {
  return html`<${Page}
    title="Tailscale on this computer"
    blurb="Serve this gateway from the Tailscale app already on this computer, on your Tailscale network or publicly."
  >
    ${(remote, setRemote) => html`<${HostTailscale} remote=${remote} setRemote=${setRemote} offerStop />`}
  <//>`;
}

export function OwnAddressView() {
  const [url, setUrl] = useState("");
  return html`<${Page}
    title="Your own domain or reverse proxy"
    blurb="An https address you run in front of this gateway. Omnesis checks that it works before saving it."
  >
    ${(remote, setRemote) => html`<${OwnAddress} remote=${remote} setRemote=${setRemote} url=${url} onUrl=${setUrl} />`}
  <//>`;
}

export function McpView() {
  return html`<${Page}
    title="MCP server"
    blurb=${MCP_BLURB}
  >
    ${(remote, setRemote) => html`<${McpChoice} remote=${remote} setRemote=${setRemote} />`}
  <//>`;
}
