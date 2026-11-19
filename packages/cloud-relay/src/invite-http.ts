// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { installInviteUI } from "./account-browser.js";
import { bindingOrigin } from "./gateway-binding.js";
import { INVITE_PAGE_PATH } from "./invites.js";
import { RelayError } from "./tunnels.js";
import { brand } from "./relay-page.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const scriptPath = INVITE_PAGE_PATH + "/script.js";
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your Omnesis invite</title><link rel="stylesheet" href="/_relay/account/style.css"><script type="module" src="${scriptPath}"></script></head><body><main>${brand}<h1>You're invited to Omnesis</h1><p id="invite-status" role="status">Checking your invite…</p><p>Omnesis accounts are invite-only for now. This invite creates one account, which connects your Omnesis gateway so your devices can reach it from anywhere.</p><h2>Use it</h2><ol><li>Open your Omnesis gateway's portal.</li><li>Go to Settings, then Connectivity, then Omnesis account.</li><li>Paste this invite there and connect.</li></ol><p id="invite-value" class="code long"></p><button type="button" id="invite-copy" hidden>Copy invite</button></main></body></html>`;

/** The page an invite link opens. The invite stays in the fragment, so this server never sees it. */
export class InviteHttp {
  private readonly origin: string;
  constructor(origin: string) {
    this.origin = bindingOrigin(origin).origin;
  }

  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url!, this.origin);
    if (url.pathname !== INVITE_PAGE_PATH && url.pathname !== scriptPath) return false;
    if (req.method !== "GET") throw new RelayError(405, "Method not allowed");
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
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
