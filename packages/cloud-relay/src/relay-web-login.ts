// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, timingSafeEqual } from "node:crypto";
import { bindingOrigin } from "./gateway-binding.js";
import {
  beginGoogleAuthorization,
  completeGoogleAuthorization,
  type GoogleAuthorization,
} from "./google-oauth.js";
import { LoginAdmission } from "./admission.js";
import { RelayError } from "./tunnels.js";
import type { IdentityProvider } from "./identity.js";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface RelayWebLoginOptions {
  clientId: string;
  clientSecret: string;
  publicOrigin: string;
  identity: IdentityProvider;
  accountBrowser: {
    /** `nonce` is set when the sign-in must commit to an operation. */
    begin(req: IncomingMessage): Promise<{ context?: string; nonce?: string }>;
    complete(
      idToken: string,
      nonce: string,
      context: string | undefined,
      request: IncomingMessage,
    ): Promise<{ cookie?: string; location: string }>;
    /** Where to resume after a failure, so a sign-in that fails doesn't lose its operation. */
    failed(context: string | undefined): string;
  };
  fetch?: typeof fetch;
}
const cookieName = "__Host-omnesis-relay-login";
/** Google's browser redirect. It only ever signs in to the account page, which does the rest. */
export class RelayWebLogin {
  private readonly pending = new Map<
    string,
    { authorization: GoogleAuthorization; context?: string }
  >();
  private readonly origin: string;
  private closed = false;
  constructor(
    private readonly options: RelayWebLoginOptions,
    private readonly admission = new LoginAdmission(),
  ) {
    this.origin = bindingOrigin(options.publicOrigin).origin;
    if (!options.clientId.trim() || !options.clientSecret.trim())
      throw new Error("Google web login requires a client identifier and backend secret");
  }

  close(): void {
    this.closed = true;
    this.pending.clear();
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = new URL(req.url!, this.origin).pathname;
    if (!["/_relay/web", "/_relay/web/start", "/_relay/web/callback"].includes(path)) return false;
    if (this.closed) throw new RelayError(503, "Account sign-in is unavailable");
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    if (path === "/_relay/web" && req.method === "GET") {
      res.writeHead(303, { location: "/_relay/account" });
      res.end();
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
        const { context, nonce } = await this.options.accountBrowser.begin(req);
        this.prune();
        if (this.pending.size >= 32) throw new RelayError(429, "Too many Google sign-in requests");
        const authorization = beginGoogleAuthorization({
          clientId: this.options.clientId,
          redirectUri: new URL("/_relay/web/callback", this.origin).href,
          nonce: nonce ?? randomBytes(32).toString("base64url"),
        });
        this.pending.set(authorization.state, { authorization, context });
        res.writeHead(303, {
          location: authorization.url,
          "set-cookie": `${cookieName}=${authorization.state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`,
        });
        res.end();
      }, req);
      return true;
    }
    if (path === "/_relay/web/callback" && req.method === "GET") {
      res.setHeader(
        "set-cookie",
        `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      );
      let context: string | undefined;
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
          const pending = this.pending.get(state);
          if (!pending) throw new Error("Google sign-in expired or was already used");
          this.pending.delete(state);
          context = pending.context;
          const authorization = pending.authorization;
          const identity = await completeGoogleAuthorization({
            authorization,
            callbackUrl: callback.href,
            identity: this.options.identity,
            clientSecret: this.options.clientSecret,
            fetch: this.options.fetch,
          });
          if (this.closed) throw new Error("Account sign-in was cancelled");
          const signedIn = await this.options.accountBrowser.complete(
            identity.idToken,
            authorization.nonce,
            pending.context,
            req,
          );
          const destination = new URL(signedIn.location, this.origin);
          if (destination.origin !== this.origin) throw new Error("Invalid account continuation");
          res.writeHead(303, {
            location: destination.href,
            "set-cookie": [
              `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
              ...(signedIn.cookie ? [signedIn.cookie] : []),
            ],
          });
          res.end();
        }, req);
      } catch {
        res.writeHead(303, { location: this.options.accountBrowser.failed(context) });
        res.end();
      }
      return true;
    }
    throw new RelayError(405, "Method not allowed");
  }

  private prune(): void {
    for (const [state, pending] of this.pending)
      if (pending.authorization.expiresAt <= Date.now()) this.pending.delete(state);
  }
}
