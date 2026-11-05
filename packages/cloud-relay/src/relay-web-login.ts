// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, timingSafeEqual } from "node:crypto";
import { googleSignInMarkDataUrl } from "./google-sign-in-artwork.js";
import { bindingOrigin } from "./gateway-binding.js";
import {
  beginGoogleAuthorization,
  completeGoogleAuthorization,
  type GoogleAuthorization,
} from "./google-oauth.js";
import { accountId, type IdentityProvider } from "./identity.js";
import { LoginAdmission } from "./admission.js";
import { RelayError } from "./tunnels.js";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface RelayWebLoginOptions {
  clientId: string;
  clientSecret: string;
  publicOrigin: string;
  identity: IdentityProvider;
  gatewayForAccount(accountId: string): string | undefined;
  fetch?: typeof fetch;
}
const cookieName = "__Secure-omnesis-relay-login";
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Find your Omnesis gateway</title><link rel="stylesheet" href="/_relay/web/style.css"></head><body><main>
<p class="brand">OMNESIS</p><h1>Find your gateway</h1><p>Sign in to find the gateway registered to your Google account.</p>
<a class="continue" href="/_relay/web/start"><img src="${googleSignInMarkDataUrl}" width="20" height="20" alt="" aria-hidden="true">Continue with Google</a>
<p class="hint">This relay sees your Google account identifier and your gateway address. Your gateway still controls access to your data.</p>
<p class="hint">Google sign-in is optional. You can open your gateway directly or pair a device using its QR code.</p>
</main></body></html>`;
const failedPage = page.replace(
  '<a class="continue"',
  '<p role="alert">Sign-in did not complete, or no gateway is registered for this account. Please try again.</p><a class="continue"',
);
const style = `:root{font-family:system-ui,sans-serif;color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1117;color:#e6edf3}main{box-sizing:border-box;margin:24px;padding:32px;max-width:430px;background:#161b22;border:1px solid #30363d;border-radius:16px}h1{font-size:1.8rem;line-height:1.15}.brand{font-size:.85rem;letter-spacing:.12em;color:#58a6ff}p{line-height:1.6}.hint{font-size:.9rem;color:#a8b1bd}.continue img{flex:none;object-fit:contain}.continue{box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:10px;font:inherit;width:100%;padding:12px 18px;border:0;border-radius:8px;background:#fff;color:#1f1f1f;border:1px solid #747775;font-weight:500;text-align:center;text-decoration:none;margin:24px 0}.continue:focus-visible{outline:3px solid #e6edf3;outline-offset:4px}[role=alert]{padding:12px;border:1px solid #e3b341;border-radius:8px}`;

/** Discovery returns an account's HTTPS portal URL, never a gateway credential or access grant. */
export class RelayWebLogin {
  private readonly pending = new Map<string, GoogleAuthorization>();
  private readonly origin: string;
  constructor(
    private readonly options: RelayWebLoginOptions,
    private readonly admission = new LoginAdmission(),
  ) {
    this.origin = bindingOrigin(options.publicOrigin).origin;
    if (!options.clientId.trim() || !options.clientSecret.trim())
      throw new Error("Google web login requires a client identifier and backend secret");
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = new URL(req.url!, this.origin).pathname;
    if (
      ![
        "/_relay/web",
        "/_relay/web/start",
        "/_relay/web/callback",
        "/_relay/web/style.css",
      ].includes(path)
    )
      return false;
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; style-src 'self'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    if (path === "/_relay/web" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(new URL(req.url!, this.origin).searchParams.has("failed") ? failedPage : page);
      return true;
    }
    if (path === "/_relay/web/style.css" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(style);
      return true;
    }
    if (path === "/_relay/web/start" && ["GET", "POST"].includes(req.method!)) {
      if (
        req.method === "POST"
          ? req.headers.origin !== this.origin
          : req.headers["sec-fetch-site"] !== "same-origin"
      )
        throw new RelayError(403, "Same-origin sign-in required");
      req.resume();
      await this.admission.run(async () => {
        this.prune();
        if (this.pending.size >= 32) throw new RelayError(429, "Too many Google sign-in requests");
        const authorization = beginGoogleAuthorization({
          clientId: this.options.clientId,
          redirectUri: new URL("/_relay/web/callback", this.origin).href,
          nonce: randomBytes(32).toString("base64url"),
        });
        this.pending.set(authorization.state, authorization);
        res.writeHead(303, {
          location: authorization.url,
          "set-cookie": `${cookieName}=${authorization.state}; Path=/_relay/web; HttpOnly; Secure; SameSite=Lax; Max-Age=300`,
        });
        res.end();
      });
      return true;
    }
    if (path === "/_relay/web/callback" && req.method === "GET") {
      res.setHeader(
        "set-cookie",
        `${cookieName}=; Path=/_relay/web; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      );
      try {
        await this.admission.run(async () => {
          this.prune();
          const callback = new URL("/_relay/web/callback", this.origin);
          callback.search = new URL(req.url!, this.origin).search;
          const states = callback.searchParams.getAll("state");
          const cookies = (req.headers.cookie ?? "")
            .split(";")
            .map((part) => part.trim())
            .filter((part) => part.startsWith(`${cookieName}=`))
            .map((part) => part.slice(cookieName.length + 1));
          const state = states.length === 1 ? states[0]! : "";
          const cookie = cookies.length === 1 ? cookies[0]! : "";
          if (
            !state ||
            state.length !== cookie.length ||
            !timingSafeEqual(Buffer.from(state), Buffer.from(cookie))
          )
            throw new Error("Google sign-in browser state mismatch");
          const authorization = this.pending.get(state);
          if (!authorization) throw new Error("Google sign-in expired or was already used");
          this.pending.delete(state);
          const identity = await completeGoogleAuthorization({
            authorization,
            callbackUrl: callback.href,
            identity: this.options.identity,
            clientSecret: this.options.clientSecret,
            fetch: this.options.fetch,
          });
          const gateway = this.options.gatewayForAccount(accountId(identity.identity));
          if (gateway === undefined) throw new Error("No gateway registered");
          const destination = new URL("/portal/", bindingOrigin(gateway));
          res.writeHead(303, { location: destination.href });
          res.end();
        });
      } catch {
        res.writeHead(303, { location: "/_relay/web?failed=1" });
        res.end();
      }
      return true;
    }
    throw new RelayError(405, "Method not allowed");
  }

  private prune(): void {
    for (const [state, authorization] of this.pending)
      if (authorization.expiresAt <= Date.now()) this.pending.delete(state);
  }
}
