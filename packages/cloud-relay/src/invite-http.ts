// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { installInviteUI } from "./account-browser.js";
import { bindingOrigin } from "./gateway-binding.js";
import { INVITE_PAGE_PATH } from "./invites.js";
import { RelayError } from "./tunnels.js";
import { brand } from "./relay-page.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const scriptPath = INVITE_PAGE_PATH + "/script.js";
const stylePath = INVITE_PAGE_PATH + "/style.css";
// The usual copy glyph and the check that replaces it for a moment once copied.
const copyIcons = `<svg class="icon-copy" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg><svg class="icon-copied" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>`;
const copyButton = (id: string, label: string) =>
  `<button type="button" id="${id}" class="copy" aria-label="${label}" title="${label}" data-label="${label}" hidden>${copyIcons}</button>`;
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your Omnesis invite</title><link rel="stylesheet" href="/_relay/account/style.css"><link rel="stylesheet" href="${stylePath}"><script type="module" src="${scriptPath}"></script></head><body><main>${brand}<div id="invite-missing" hidden><h1>This link has no invite in it</h1><p>An invite link ends with # followed by a long code. Ask whoever sent it to you for the whole link.</p></div><div id="invite-found"><h1>You're invited to Omnesis</h1><p id="invite-status" role="status">Checking your invite…</p><p>Omnesis accounts are invite-only for now. This invite creates one account, which connects your Omnesis gateway so your devices can reach it from anywhere.</p><h2>Use it</h2><ol><li>Open your Omnesis gateway's portal.</li><li>Go to Settings, then Connectivity, then Omnesis account.</li><li>Paste this invite there and connect.</li></ol><div class="copy-row"><p id="invite-value" class="code long"></p>${copyButton("invite-copy", "Copy invite link")}</div><p class="terminal">Or, on the computer that runs your gateway, connect from a terminal:</p><div class="copy-row"><p class="code long"><code id="invite-command"></code></p>${copyButton("command-copy", "Copy command")}</div><p id="copy-status" class="visually-hidden" role="status"></p></div></main></body></html>`;
// Only what the invite page adds to the account pages' stylesheet: the copy buttons beside the
// invite and the command, and the space before the terminal's way.
const style = `.copy-row{display:flex;align-items:flex-start;gap:.5rem;margin:0 0 .75rem}.copy-row .code{flex:1;min-width:0;margin:0;padding:.5rem .75rem;border-radius:.5rem;background:var(--soft)}button.copy{flex:none;width:2.25rem;min-height:2.25rem;margin:0;padding:0;border:1px solid var(--line);border-radius:.5rem;background:transparent;color:var(--muted)}button.copy:hover{opacity:1;color:var(--fg);border-color:var(--muted)}button.copy[hidden]{display:none}button.copy .icon-copied,button.copy.copied .icon-copy{display:none}button.copy.copied .icon-copied{display:block}button.copy.copied{color:var(--online)}.terminal{margin-top:2.5rem}.visually-hidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}`;

/** The page an invite link opens. The invite stays in the fragment, so this server never sees it. */
export class InviteHttp {
  private readonly origin: string;
  constructor(origin: string) {
    this.origin = bindingOrigin(origin).origin;
  }

  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url!, this.origin);
    if (![INVITE_PAGE_PATH, scriptPath, stylePath].includes(url.pathname)) return false;
    if (req.method !== "GET") throw new RelayError(405, "Method not allowed");
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    if (url.pathname === stylePath) {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(style);
      return true;
    }
    if (url.pathname === scriptPath) {
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
      res.end(`(${installInviteUI.toString()})();`);
      return true;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
    return true;
  }
}
