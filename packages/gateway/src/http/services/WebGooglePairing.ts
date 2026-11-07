// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { timingSafeEqual } from "node:crypto";
import {
  beginGoogleAuthorization,
  completeGoogleAuthorization,
  googlePairingNonce,
  type GoogleAuthorization,
  type GooglePairingRequests,
  type IdentityProvider,
} from "@omnesis/cloud-relay";
import { z } from "zod";

export const webGooglePairingRequest = z
  .object({
    requestId: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    secret: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type Request = z.infer<typeof webGooglePairingRequest>;

/** Browser OAuth uses a server-side code exchange; Google JavaScript never runs in the portal. */
export class WebGooglePairing {
  private readonly pending = new Map<
    string,
    { authorization: GoogleAuthorization; request: Request }
  >();
  private readonly redirectUri: string;
  constructor(
    private readonly options: {
      clientId: string;
      clientSecret: string;
      publicBaseUrl: string;
      identity: IdentityProvider;
      pairing: GooglePairingRequests;
      fetch?: typeof fetch;
    },
  ) {
    const url = new URL(options.publicBaseUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["", "/"].includes(url.pathname) ||
      !options.clientId.trim() ||
      !options.clientSecret.trim()
    )
      throw new Error("Invalid Google web sign-in configuration");
    this.redirectUri = new URL("/devices/google/callback", url).href;
  }

  begin(
    input: unknown,
    _requestOrigin?: string,
  ): { authorizationUrl: string; browserState?: string } {
    const request = webGooglePairingRequest.parse(input);
    this.prune();
    if (this.pending.size >= 32) throw new Error("Too many Google sign-in requests");
    const authorization = beginGoogleAuthorization({
      clientId: this.options.clientId,
      redirectUri: this.redirectUri,
      nonce: googlePairingNonce({ ...request, kind: "portal" }),
    });
    this.pending.set(authorization.state, { authorization, request });
    return { authorizationUrl: authorization.url };
  }

  async complete(callbackUrl: string, browserState: string): Promise<string> {
    this.prune();
    const callback = new URL(callbackUrl);
    const states = callback.searchParams.getAll("state");
    const state = Buffer.from(states.length === 1 ? states[0]! : "");
    const cookie = Buffer.from(browserState);
    if (state.length === 0 || state.length !== cookie.length || !timingSafeEqual(state, cookie))
      throw new Error("Google sign-in browser state mismatch");
    const entry = this.pending.get(states[0]!);
    if (!entry) throw new Error("Google sign-in expired or was already used");
    this.pending.delete(states[0]!);
    const credentials = await completeGoogleAuthorization({
      authorization: entry.authorization,
      callbackUrl,
      clientSecret: this.options.clientSecret,
      identity: this.options.identity,
      fetch: this.options.fetch,
    });
    await this.options.pairing.start({
      ...entry.request,
      kind: "portal",
      identityToken: credentials.idToken,
    });
    return entry.request.requestId;
  }

  private prune(): void {
    for (const [state, entry] of this.pending)
      if (entry.authorization.expiresAt <= Date.now()) this.pending.delete(state);
  }
}
