// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  googlePairingNonce,
  type GooglePairingRequests,
  type GoogleBrowserPort,
  type GoogleBrowserPending,
} from "@omnesis/cloud-relay";
import { webGooglePairingRequest } from "./WebGooglePairing.js";

/** Central OAuth is convenience only: the gateway's original approval and independent comparison remain mandatory. */
export class ManagedWebGooglePairing {
  private readonly pending = new Map<
    string,
    { request: ReturnType<typeof webGooglePairingRequest.parse>; operation: GoogleBrowserPending }
  >();
  private readonly abort = new AbortController();
  private starting = 0;
  constructor(
    private readonly options: { broker: GoogleBrowserPort; pairing: GooglePairingRequests },
  ) {}
  async begin(input: unknown, requestOrigin: string) {
    const request = webGooglePairingRequest.parse(input);
    for (const [state, entry] of this.pending)
      if (entry.operation.expiresAt <= Date.now() / 1000) this.pending.delete(state);
    if (this.pending.size + this.starting >= 32)
      throw new Error("Too many Google sign-in requests");
    this.starting++;
    try {
      const browserState = randomBytes(32).toString("base64url");
      const operation = await this.options.broker.begin({
        purpose: "device-enrollment",
        nonce: googlePairingNonce({ ...request, kind: "portal" }),
        browserState,
        callbackUrl: await this.options.broker.callbackUrl(requestOrigin, "device-enrollment"),
        signal: this.abort.signal,
      });
      this.abort.signal.throwIfAborted();
      this.pending.set(browserState, { request, operation });
      return { authorizationUrl: operation.authorizeUrl, browserState };
    } finally {
      this.starting--;
    }
  }
  async complete(callbackUrl: string, browserState: string): Promise<string> {
    const url = new URL(callbackUrl),
      states = url.searchParams.getAll("state"),
      results = url.searchParams.getAll("brokerResult");
    if (
      states.length !== 1 ||
      results.length !== 1 ||
      !results[0] ||
      !browserState ||
      states[0]!.length !== browserState.length ||
      !timingSafeEqual(Buffer.from(states[0]!), Buffer.from(browserState))
    )
      throw new Error("Google sign-in browser state mismatch");
    const entry = this.pending.get(browserState);
    this.pending.delete(browserState);
    if (!entry || entry.operation.callbackUrl !== `${url.origin}${url.pathname}`)
      throw new Error("Google sign-in expired or was already used");
    const credentials = await this.options.broker.redeem(
      entry.operation,
      results[0],
      this.abort.signal,
    );
    this.abort.signal.throwIfAborted();
    // Google sign-in commits to the plain request nonce; a device key has no part in it.
    const { devicePublicKey: _unused, ...request } = entry.request;
    await this.options.pairing.startForBrowser({
      ...request,
      kind: "portal",
      identityToken: credentials.idToken,
    });
    return entry.request.requestId;
  }
  cancel(): void {
    this.abort.abort();
    this.pending.clear();
  }
}
