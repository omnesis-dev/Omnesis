// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, createPublicKey, randomBytes, randomUUID, sign } from "node:crypto";
import { hostname } from "node:os";
import { createLocalJWKSet } from "jose";
import { accountPublicKeys } from "./account-browser-client.js";
import { AccountGatewayLinkVerifier } from "./account-enrollment-proof.js";
import { bindingOrigin } from "./gateway-binding.js";
import { gatewayKeyAccount } from "./gateway-key-auth.js";
import { relayOrigin } from "./network.js";
import { readOrCreateGatewayOwnerKey, type registerGatewayKey } from "./gateway-key-client.js";
import {
  GATEWAY_SIGNUP_ACCESS_PATH,
  GATEWAY_SIGNUP_INVITE_PATH,
  GATEWAY_SIGNUP_PATH,
  GATEWAY_SIGNUP_PROTOCOL,
  gatewaySignupAccess,
  gatewaySignupInviteStatus,
  gatewaySignupLinked,
  gatewaySignupPollResult,
  gatewaySignupStarted,
  gatewaySignupTranscript,
  type GatewaySignupAccess,
  type GatewaySignupIntent,
  type GatewaySignupInviteStatus,
} from "./gateway-signup-contract.js";
import { readBoundedJson } from "./google-credentials.js";
import { inviteToken, type InviteRefusal } from "./invites.js";

const inviteRefusals: readonly string[] = [
  "invite-invalid",
  "invite-expired",
  "invite-used",
] satisfies InviteRefusal[];
/** The relay refused the invite this sign-up brought, and said why. */
export class GatewaySignupInviteRefused extends Error {
  constructor(readonly reason: InviteRefusal) {
    super(`The relay refused the invite (${reason})`);
    this.name = "GatewaySignupInviteRefused";
  }
}

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
      let reason: unknown;
      if (response.status === 403 && response.headers.get("content-type") === "application/json")
        reason = await readBoundedJson(response).then(
          (value) => (value as { error?: unknown } | null)?.error,
          () => undefined,
        );
      else await response.body?.cancel();
      if (typeof reason === "string" && inviteRefusals.includes(reason))
        throw new GatewaySignupInviteRefused(reason as InviteRefusal);
      throw new Error(`Gateway signup ${path} refused (${response.status})`);
    }
    return readBoundedJson(response);
  }

  /** `invite` is what the person pasted; only its token goes to the relay. */
  async start(
    signal: AbortSignal,
    intent: GatewaySignupIntent = "existing",
    invite?: string,
  ): Promise<GatewaySignupPending> {
    const token = invite === undefined ? undefined : inviteToken(invite);
    if (invite !== undefined && token === undefined)
      throw new GatewaySignupInviteRefused("invite-invalid");
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
        { ...unsigned, ownerSignature, intent, ...(token ? { invite: token } : {}) },
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

/**
 * Whether the relay's accounts need approval, and where to ask. Public metadata, read before
 * anyone signs in. A relay that does not answer, or answers with anything unexpected, says nothing.
 */
export async function relaySignupAccess(
  relayUrl: string,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
): Promise<GatewaySignupAccess | undefined> {
  const response = await transport(new URL(GATEWAY_SIGNUP_ACCESS_PATH, relayOrigin(relayUrl)), {
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return undefined;
  }
  return gatewaySignupAccess(await readBoundedJson(response));
}

/**
 * Whether an invite could create an account on this relay now. Asked before connecting starts, so
 * a mistyped or spent invite is named at once. The relay checks the invite again when the sign-up
 * starts, and when the account is created.
 */
export async function relayInviteStatus(
  relayUrl: string,
  invite: string,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
): Promise<GatewaySignupInviteStatus> {
  const token = inviteToken(invite);
  if (!token) return { status: "invalid" };
  const response = await transport(new URL(GATEWAY_SIGNUP_INVITE_PATH, relayOrigin(relayUrl)), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invite: token }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Invite check refused (${response.status})`);
  }
  return gatewaySignupInviteStatus.parse(await readBoundedJson(response));
}
