// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { installConnectUI } from "./account-browser.js";
import { CONNECT_PAGE_PATH, type ConnectCodes } from "./connect-codes.js";
import { bindingOrigin } from "./gateway-binding.js";
import { readJsonBody } from "./relay-json-body.js";
import { RelayError } from "./tunnels.js";
import { brand } from "./relay-page.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LoginAdmission } from "./admission.js";

const scriptPath = CONNECT_PAGE_PATH + "/script.js";
const claimPath = "/_relay/v3/connect/claim";
const claimSchema = z.object({ code: z.string().min(1).max(32) }).strict();
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to your Omnesis account</title><link rel="stylesheet" href="/_relay/account/style.css"><script type="module" src="${scriptPath}"></script></head><body><main>${brand}<h1>Enter your code</h1><p>Type the code shown on the machine you are connecting.</p><p id="account-error" role="alert"></p><form id="connect-form"><label for="connect-code">Code</label><input id="connect-code" name="code" class="code-input" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="32" placeholder="XXXX-XXXX" required autofocus><button type="submit">Continue</button></form></main></body></html>`;

/** Trades a typed code for the same browser binding a direct launch URL would have set. */
export class ConnectHttp {
  private readonly origin: string;
  constructor(
    private readonly options: { origin: string; codes: ConnectCodes; admission: LoginAdmission },
  ) {
    this.origin = bindingOrigin(options.origin).origin;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url!, this.origin);
    if (![CONNECT_PAGE_PATH, scriptPath, claimPath].includes(url.pathname)) return false;
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    if (url.pathname !== claimPath) {
      if (req.method !== "GET") throw new RelayError(405, "Method not allowed");
      if (url.pathname === scriptPath) {
        res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
        res.end(`(${installConnectUI.toString()})();`);
        return true;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
      return true;
    }
    if (req.method !== "POST") throw new RelayError(405, "Method not allowed");
    if (url.search) throw new RelayError(400, "Connect claim does not accept query parameters");
    if (req.headers.origin !== this.origin || req.headers["sec-fetch-site"] === "cross-site")
      throw new RelayError(403, "Same-origin connect request required");
    if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json")
      throw new RelayError(415, "JSON connect request required");
    return this.options.admission
      .run(async () => {
        const input = claimSchema.safeParse(await readJsonBody(req, 1024));
        if (!input.success) throw new RelayError(400, "Invalid connect request");
        const launch = this.options.codes.claim(input.data.code, req.headers.cookie ?? "");
        res.writeHead(200, { "content-type": "application/json", "set-cookie": launch.cookie });
        res.end(JSON.stringify({ location: launch.location }));
        return true;
      }, req)
      .catch((error: unknown) => {
        req.resume();
        throw error;
      });
  }
}
