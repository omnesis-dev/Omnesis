// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, createPublicKey, randomBytes, randomUUID, sign } from "node:crypto";
import { hostname } from "node:os";
import { createLocalJWKSet } from "jose";
import { accountPublicKeys } from "./account-browser-client.js";
import { AccountGatewayLinkVerifier } from "./account-enrollment-proof.js";
import { bindingOrigin } from "./gateway-binding.js";
import { gatewayKeyAccount } from "./gateway-key-auth.js";
import { readOrCreateGatewayOwnerKey, type registerGatewayKey } from "./gateway-key-client.js";
import {
  GATEWAY_SIGNUP_PATH,
  GATEWAY_SIGNUP_PROTOCOL,
  gatewaySignupLinked,
  gatewaySignupPollResult,
  gatewaySignupStarted,
  gatewaySignupTranscript,
  type GatewaySignupIntent,
} from "./gateway-signup-contract.js";
import { readBoundedJson } from "./google-credentials.js";

export interface GatewaySignupPending {
  operationId: string;
  redemptionSecret: string;
  nonce: string;
  expiresAt: number;
  authorizeUrl: string;
  connectUrl: string;
  /** For display only: the relay's short address for the same connect page. */
  connectShortUrl?: string;
  code: string;
}

interface Options {
  relayUrl: string;
  gatewayId: string;
  ownerKeyFile: string;
  fetch?: typeof fetch;
}

/** The gateway's half of connecting by sign-in. The owner key signs every step it starts. */
export class GatewaySignupClient {
  private readonly origin: string;
  constructor(private readonly options: Options) {
    this.origin = bindingOrigin(options.relayUrl).origin;
  }

  private async owner() {
    const key = await readOrCreateGatewayOwnerKey(this.options.ownerKeyFile, false);
    const ownerPublicKey = createPublicKey(key).export({ format: "pem", type: "spki" }).toString();
    return { key, ownerPublicKey };
  }

  private async post(path: string, body: unknown, signal: AbortSignal, token?: string) {
    const response = await (this.options.fetch ?? fetch)(new URL(path, this.origin), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Gateway signup ${path} refused (${response.status})`);
    }
    return readBoundedJson(response);
  }

  async start(
    signal: AbortSignal,
    intent: GatewaySignupIntent = "existing",
  ): Promise<GatewaySignupPending> {
    const { key, ownerPublicKey } = await this.owner();
    const redemptionSecret = randomBytes(32).toString("base64url");
    const issuedAt = Math.floor(Date.now() / 1000);
    const name = hostname()
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 80);
    const unsigned = {
      protocol: GATEWAY_SIGNUP_PROTOCOL,
      operationId: randomUUID(),
      gatewayId: this.options.gatewayId,
      ownerPublicKey,
      ...(name ? { displayName: name } : {}),
      nonce: randomBytes(32).toString("base64url"),
      redemptionSha256: createHash("sha256").update(redemptionSecret).digest("hex"),
      issuedAt,
      expiresAt: issuedAt + 300,
    };
    const ownerSignature = sign(null, gatewaySignupTranscript(this.origin, unsigned), key).toString(
      "base64url",
    );
    const started = gatewaySignupStarted.parse(
      await this.post(
        `${GATEWAY_SIGNUP_PATH}/start`,
        { ...unsigned, ownerSignature, intent },
        signal,
      ),
    );
    const authorize = new URL(started.authorizeUrl),
      connect = new URL(started.connectUrl);
    if (
      started.operationId !== unsigned.operationId ||
      authorize.origin !== this.origin ||
      connect.origin !== this.origin ||
      authorize.username ||
      authorize.password
    )
      throw new Error("Gateway signup destination was refused");
    return {
      operationId: started.operationId,
      redemptionSecret,
      nonce: unsigned.nonce,
      expiresAt: Math.min(started.expiresAt, unsigned.expiresAt),
      authorizeUrl: authorize.href,
      connectUrl: connect.href,
      ...(started.connectShortUrl ? { connectShortUrl: started.connectShortUrl } : {}),
      code: started.code,
    };
  }

  async poll(pending: GatewaySignupPending, signal: AbortSignal) {
    return gatewaySignupPollResult.parse(
      await this.post(
        `${GATEWAY_SIGNUP_PATH}/poll`,
        { operationId: pending.operationId, redemptionSecret: pending.redemptionSecret },
        signal,
      ),
    );
  }

  /** Binds the account once the gateway holds a routing session. The result is checked, not trusted. */
  async link(
    pending: GatewaySignupPending,
    register: typeof registerGatewayKey,
    sessionOptions: Parameters<typeof registerGatewayKey>[0],
  ): Promise<string> {
    const signal = sessionOptions.signal ?? AbortSignal.timeout(30_000);
    const session = await register(sessionOptions);
    const linked = gatewaySignupLinked.parse(
      await this.post(
        `${GATEWAY_SIGNUP_PATH}/link`,
        { operationId: pending.operationId, redemptionSecret: pending.redemptionSecret },
        signal,
        session.token,
      ),
    );
    const keysResponse = await (this.options.fetch ?? fetch)(
      new URL("/_relay/v3/account-keys", this.origin),
      { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) },
    );
    if (!keysResponse.ok) throw new Error("Account verification is unavailable");
    const keys = createLocalJWKSet(accountPublicKeys.parse(await readBoundedJson(keysResponse)));
    const { ownerPublicKey } = await this.owner();
    const identity = await new AccountGatewayLinkVerifier(
      this.origin,
      keys,
      this.options.gatewayId,
      gatewayKeyAccount({ gatewayId: this.options.gatewayId, ownerPublicKey }),
    ).verify(linked.identityToken, pending.nonce);
    if (identity.subject !== linked.accountId) throw new Error("Gateway signup account changed");
    return linked.accountId;
  }

  async cancel(pending: GatewaySignupPending): Promise<void> {
    await this.post(
      `${GATEWAY_SIGNUP_PATH}/cancel`,
      { operationId: pending.operationId, redemptionSecret: pending.redemptionSecret },
      AbortSignal.timeout(5000),
    ).catch(() => undefined);
  }
}
