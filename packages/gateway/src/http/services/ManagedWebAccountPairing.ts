// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  enrollmentNonce,
  googlePairingNonce,
  type GooglePairingRequests,
  type AccountBrowserPort,
  type AccountBrowserPending,
} from "@omnesis/cloud-relay";
import { webGooglePairingRequest } from "./WebGooglePairing.js";

/** Account sign-in requests enrollment; the gateway's trusted-device decision remains mandatory. */
export class ManagedWebAccountPairing {
  private readonly pending = new Map<
    string,
    { request: ReturnType<typeof webGooglePairingRequest.parse>; operation: AccountBrowserPending }
  >();
  private readonly abort = new AbortController();
  private starting = 0;
  constructor(
    private readonly options: { broker: AccountBrowserPort; pairing: GooglePairingRequests },
  ) {}
  async begin(input: unknown, requestOrigin: string) {
    const request = webGooglePairingRequest.parse(input);
    for (const [state, entry] of this.pending)
      if (entry.operation.expiresAt <= Date.now() / 1000) this.pending.delete(state);
    if (this.pending.size + this.starting >= 32)
      throw new Error("Too many account sign-in requests");
    this.starting++;
    try {
      const browserState = randomBytes(32).toString("base64url");
      const operation = await this.options.broker.begin({
        purpose: "device-enrollment",
        nonce: request.devicePublicKey
          ? enrollmentNonce({
              ...request,
              kind: "portal",
              devicePublicKey: request.devicePublicKey,
            })
          : googlePairingNonce({ ...request, kind: "portal" }),
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
      results = url.searchParams.getAll("result"),
      ids = url.searchParams.getAll("operationId");
    if (
      url.searchParams.size !== 3 ||
      states.length !== 1 ||
      results.length !== 1 ||
      ids.length !== 1 ||
      !/^[A-Za-z0-9_-]{43}$/.test(browserState) ||
      !/^[A-Za-z0-9_-]{43}$/.test(results[0]!) ||
      states[0]!.length !== browserState.length ||
      !timingSafeEqual(Buffer.from(states[0]!), Buffer.from(browserState)) ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error("Account sign-in browser state mismatch");
    const entry = this.pending.get(browserState);
    this.pending.delete(browserState);
    if (
      !entry ||
      entry.operation.operationId !== ids[0] ||
      entry.operation.callbackUrl !== url.origin + url.pathname ||
      entry.operation.expiresAt <= Date.now() / 1000
    )
      throw new Error("Account sign-in expired or was already used");
    const credentials = await this.options.broker.redeem(
      entry.operation,
      results[0]!,
      this.abort.signal,
    );
    this.abort.signal.throwIfAborted();
    // A browser with a device key signs after this redirect, so its sign-in waits for it.
    if (entry.request.devicePublicKey) {
      this.options.pairing.holdProof(entry.request.requestId, {
        identityToken: credentials.identityToken,
        ...(credentials.signInProof ? { proof: credentials.signInProof } : {}),
        ...(credentials.credentialPublicKey
          ? { credentialPublicKey: credentials.credentialPublicKey }
          : {}),
      });
      return entry.request.requestId;
    }
    const { devicePublicKey: _unused, ...request } = entry.request;
    await this.options.pairing.startForBrowser({
      ...request,
      kind: "portal",
      identityToken: credentials.identityToken,
    });
    this.abort.signal.throwIfAborted();
    return entry.request.requestId;
  }
  cancel(): void {
    this.abort.abort();
    this.pending.clear();
  }
}
