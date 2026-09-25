// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The server-rendered pages a person sees while a client connects: the
 * consent page with its code and QR while the request is pending, the same
 * page once the request has been decided, and the two terminal pages a
 * browser can land on afterwards.
 */

import type { Context } from "hono";
import type { AuthorizationRequestPublic } from "../../access/types.js";

/** The headers every consent page carries: it renders nothing but itself. */
export function applyConsentHeaders(c: Context, nonce: string): void {
  c.header(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'self' 'nonce-${nonce}'; font-src 'self'; script-src 'self' 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
  );
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
}

/**
 * The shell shared by every consent page: one stylesheet, one card, so the
 * page a person sees when the request is gone is recognisably the same page
 * they scanned into.
 */
function consentDocument(input: {
  title: string;
  nonce: string;
  main: string;
  script?: string;
}): string {
  const importMap = `<script type="importmap" nonce="${input.nonce}">{"imports":{"preact":"/portal/vendor/preact.js","preact/hooks":"/portal/vendor/preact-hooks.js","htm/preact":"/portal/vendor/htm-preact.js","qrcode":"/portal/vendor/qrcode.js"}}</script>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title><link rel="stylesheet" href="/portal/css/style.css">${input.script ? importMap : ""}<style nonce="${input.nonce}">
    :root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#15233d;background:#f5f1e9}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f5f1e9;color:#15233d}.card{width:min(720px,100%);background:#fffdfa;color:#15233d;border:1px solid #d8d2c7;border-radius:24px;padding:30px;box-shadow:0 22px 60px #15233d18}.eyebrow{font:800 12px ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:#1768cf}h1{color:#15233d;font-size:30px;line-height:1.1;margin:10px 0}p{color:#60708a;line-height:1.55}.facts{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:20px 0}.fact{padding:12px;border-radius:12px;background:#edf3fb;color:#15233d;font-size:13px;overflow-wrap:anywhere}.fact b{display:block;margin-bottom:4px;color:#15233d}.code{display:grid;gap:13px;text-align:center;padding:22px;border-radius:16px;background:#edf3fb;color:#455875}.authorization-qr{display:grid;justify-items:center;gap:8px}.authorization-qr canvas{display:block;width:min(200px,100%);height:auto;border-radius:8px;background:#fff}.user-code-row{display:flex;align-items:center;justify-content:center;gap:10px}.code strong{font:900 32px ui-monospace,monospace;letter-spacing:.12em;color:#15233d}.copy-code{display:grid;width:42px;height:42px;padding:0;place-items:center;border:1px solid #c8d0dc;border-radius:10px;background:#fff;color:#455875;cursor:pointer}.copy-code svg{width:18px;height:18px}.copy-code-done{display:none}.copy-code.is-copied .copy-code-idle{display:none}.copy-code.is-copied .copy-code-done{display:block}.state{display:grid;gap:6px;text-align:center;padding:22px;border-radius:16px;background:#edf3fb;color:#455875}.state strong{font-size:20px;color:#15233d}#status{color:#60708a}@media(max-width:520px){body{padding:12px}.facts{grid-template-columns:1fr}.card{padding:22px}.user-code-row{align-items:stretch;flex-direction:column}.copy-code{align-self:center}}
  </style></head><body>${input.main}${input.script ? `<script type="module" src="${input.script}"></script>` : ""}</body></html>`;
}

/**
 * The block that replaces the code and QR once a request has left `pending`,
 * so a person who reloads the page after deciding sees the outcome, never a
 * code that no longer does anything. The consent controller renders the same
 * states in place when its poll sees the change.
 */
function renderConsentStateBlock(
  status: AuthorizationRequestPublic["status"],
  clientName: string,
): string {
  const state =
    status === "approved"
      ? { title: "Approved", detail: `${escapeHtml(clientName)} can finish connecting.` }
      : status === "denied"
        ? { title: "Denied", detail: "Nothing was shared." }
        : status === "expired"
          ? { title: "Expired", detail: "This authorization request expired." }
          : { title: "Done", detail: "You can close this page." };
  return `<div class="state" data-authorization-state="${status}" role="status"><strong>${state.title}</strong><span>${state.detail}</span></div>`;
}

export function renderConsentPage(input: {
  handle: string;
  request: AuthorizationRequestPublic;
  nonce: string;
}): string {
  const request = input.request;
  const approval = `<div class="code" data-authorization-approval><span>Scan with Omnesis on iPhone or Android</span><div class="authorization-qr"><canvas data-authorization-qr role="img" aria-label="Scan to authorize in the Omnesis mobile app">Open Omnesis and enter the authorization code shown below.</canvas><span data-authorization-qr-error role="status" hidden>QR unavailable. Enter the code instead.</span></div><span>Or open an authenticated Omnesis Portal or mobile app and enter this code:</span><div class="user-code-row"><strong data-user-code>${escapeHtml(request.userCode)}</strong><button type="button" class="copy-code" data-copy-user-code aria-label="Copy authorization code"><svg class="copy-code-idle" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><svg class="copy-code-done" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg></button></div><span>Omnesis then walks you through three steps: choose what this client may do, choose its data and privacy, then review and allow.</span></div>`;
  const pending = request.status === "pending";
  const outcome = pending ? approval : renderConsentStateBlock(request.status, request.clientName);
  const status = pending
    ? `This request expires at ${escapeHtml(new Date(request.expiresAt).toLocaleString())}. You can approve it from <a href="/portal/settings/access/connect">Portal Settings → Access → Connect an agent</a>.`
    : "";
  const main = `<main class="card" id="oauth-consent-root" data-handle="${escapeHtml(input.handle)}" data-client-name="${escapeHtml(request.clientName)}" data-status="${request.status}" data-completes-in-client="${request.requiresAnswer ? "true" : "false"}"><div class="eyebrow">Omnesis access request</div><h1>${escapeHtml(request.clientName)} wants to connect</h1><p><strong>${escapeHtml(request.clientName)}</strong> is a client-reported name. Verify the destinations below before approving. This temporary authorization page is not paired as a device.</p><div class="facts"><div class="fact"><b>MCP resource</b>${escapeHtml(request.resource)}</div><div class="fact"><b>Redirects to</b>${escapeHtml(request.redirectOrigin)}</div></div><div data-authorization-outcome>${outcome}</div><p id="status">${status}</p></main>`;
  return consentDocument({
    title: `Authorize ${request.clientName}`,
    nonce: input.nonce,
    main,
    script: "/portal/js/oauth-consent-controller.js",
  });
}

/**
 * The page for a link whose request the gateway no longer holds.
 *
 * Expired and already-decided requests both leave nothing to look up, so the
 * page names both without claiming to know which; the one thing it can say
 * for certain is that this link will not work again and where a new code
 * comes from.
 */
export function renderConsentGonePage(input: { nonce: string }): string {
  const main = `<main class="card"><div class="eyebrow">Omnesis access request</div><h1>This request is no longer available</h1><p>Authorization requests last ten minutes, and each is decided once. This one has either expired or already been approved or denied, so the link and its code will not work again.</p><p>To connect this client, start the connection again from the client itself &mdash; it will show a fresh code &mdash; and approve that one from Omnesis on your phone or from <a href="/portal/settings/access/connect">Portal Settings &rarr; Access &rarr; Connect an agent</a>.</p></main>`;
  return consentDocument({ title: "Authorization request unavailable", nonce: input.nonce, main });
}

/**
 * The page for a completion the client won: it polled the same request and
 * collected its code first, so the browser has nothing left to deliver.
 */
export function renderConsentFinishedPage(input: { nonce: string }): string {
  const main = `<main class="card"><div class="eyebrow">Omnesis access request</div><h1>The client has already finished connecting</h1><p>You can close this window.</p></main>`;
  return consentDocument({ title: "Connection finished", nonce: input.nonce, main });
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[character]!,
  );
}
