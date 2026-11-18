// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The links between Settings → Connectivity and the pages behind it: the
// Omnesis account, the Omnesis relay, the gateway's own Tailscale device,
// Tailscale on this computer and the owner's own domain. Every step and the summary open the page
// for what they are about, so everything those pages do — unlinking, turning
// the relay off, trusted sign-ins, signing the device out, its name and public
// address — stays one click away wherever the owner is in the setup.

import { html } from "htm/preact";
import { navigate } from "../../lib/router.js";

export const CONNECTIVITY_PAGE = "/portal/settings/connectivity";
export const ACCOUNT_PAGE = "/portal/settings/account";
export const RELAY_PAGE = "/portal/settings/relay";
export const HOST_TAILSCALE_PAGE = "/portal/settings/host-tailscale";
export const OWN_ADDRESS_PAGE = "/portal/settings/own-address";
export const MCP_PAGE = "/portal/settings/mcp";
export const TAILSCALE_PAGE = "/portal/settings/tailscale";

/** A button to a detail page, opened without reloading the portal. */
export function ManageButton({ href, label, onManage = navigate, disabled = false }) {
  return html`<button type="button" class="btn-secondary remote-access-manage" disabled=${disabled} onClick=${() => onManage(href)}>
    ${label}
  </button>`;
}

/** A link to another portal page, opened without reloading the portal. */
export function PageLink({ href, children }) {
  return html`<a
    href=${href}
    onClick=${(event) => {
      event.preventDefault();
      navigate(href);
    }}
    >${children}</a
  >`;
}

/**
 * An address of this gateway, as a link that opens the portal there in a new
 * tab: the way to check it works, or to bookmark it.
 */
export function AddressLink({ url }) {
  const origin = url.replace(/\/$/u, "");
  return html`<a class="remote-access-address" href=${`${origin}/portal/`} target="_blank" rel="noopener noreferrer">${origin}</a>`;
}
