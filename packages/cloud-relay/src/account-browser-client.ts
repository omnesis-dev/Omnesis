// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  sign,
  X509Certificate,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { createLocalJWKSet, decodeJwt } from "jose";
import { z } from "zod";
import { cloudRelayEnabled } from "@omnesis/core";
import {
  ACCOUNT_BROWSER_PATH,
  ACCOUNT_BROWSER_PROTOCOL,
  ACCOUNT_CREDENTIALS_EVIDENCE,
  accountBrowserStarted,
  accountBrowserRedeemed,
  accountBrowserRedemption,
  accountBrowserTranscript,
  type AccountBrowserOwner,
  type AccountBrowserPurpose,
} from "./account-browser-contract.js";
import {
  AccountEnrollmentVerifier,
  AccountGatewayLinkVerifier,
} from "./account-enrollment-proof.js";
import {
  passkeyCountersignatureSchema,
  signInProofSchema,
  type PasskeyCountersignature,
  type SignInProof,
} from "./device-enrollment.js";
import { bindingOrigin } from "./gateway-binding.js";
import {
  gatewayBrowserCallback,
  type GatewayBrowserCallbackOrigins,
} from "./gateway-browser-callback.js";
import {
  publicGatewayCertificateFile,
  publicGatewayPrivateKeyFile,
  publicGatewayOrigin,
} from "./gateway-certificate.js";
import { gatewayKeyAccount } from "./gateway-key-auth.js";
import { readOrCreateGatewayOwnerKey, registerGatewayKey } from "./gateway-key-client.js";
import { readBoundedJson } from "./google-credentials.js";
import { tlsSpkiFingerprint } from "./pinned-key.js";
import { installationRelayUrl } from "./installation-relay.js";

export const accountPublicKeys = z
  .object({
    keys: z
      .array(
        z
          .object({
            kty: z.literal("OKP"),
            crv: z.literal("Ed25519"),
            x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
            kid: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
            alg: z.literal("EdDSA"),
            use: z.literal("sig"),
          })
          .strict(),
      )
      .min(1)
      .max(4)
      .refine((keys) => new Set(keys.map((key) => key.kid)).size === keys.length),
  })
  .strict();

export interface AccountBrowserPending {
  operationId: string;
  purpose: AccountBrowserPurpose;
  authorizeUrl: string;
  nonce: string;
  browserState: string;
  callbackUrl: string;
  issuedAt: number;
  expiresAt: number;
  redemptionSecret: string;
  relayOrigin: string;
  owner: AccountBrowserOwner;
}
export interface AccountBrowserPort {
  available(): boolean;
  authorizationOrigin(): string | undefined;
  refresh(signal?: AbortSignal): Promise<void>;
  callbackUrl(requestOrigin: string, purpose: AccountBrowserPurpose): Promise<string>;
  begin(input: {
    purpose: AccountBrowserPurpose;
    nonce: string;
    callbackUrl: string;
    browserState: string;
    signal?: AbortSignal;
  }): Promise<AccountBrowserPending>;
  redeem(
    pending: AccountBrowserPending,
    result: string,
    signal?: AbortSignal,
  ): Promise<{
    identityToken: string;
    identity: { issuer: string; subject: string; expiresAt: number };
    signInProof?: SignInProof;
    credentialPublicKey?: string;
  }>;
  cancel(): void;
  unlink(signal?: AbortSignal): Promise<void>;
  credentials?(signal?: AbortSignal): Promise<
    | {
        google: string[];
        passkeys: Array<{
          id: string;
          publicKey: string;
          endorsement?: SignInProof;
          countersignature?: PasskeyCountersignature;
        }>;
      }
    | undefined
  >;
  verifyEnrollment(
    token: string,
    nonce?: string,
  ): Promise<{
    issuer: string;
    subject: string;
    expiresAt: number;
  }>;
}

/**
 * An account holds at most 16 sign-ins. A passkey id can take 1365 characters and an RSA key
 * about 400, and each passkey entry repeats its endorser's id and key, so a full account's
 * listing outgrows the 64 KiB other relay answers are held to.
 */
const MAX_CREDENTIALS_LISTING_BYTES = 262_144;
/**
 * The account's sign-ins as the relay lists them. Fields this version does not know are dropped,
 * not refused, so the relay can add one without cutting off gateways that predate it.
 */
export const accountCredentialsListing = z.object({
  accountId: z.string(),
  google: z.array(z.string().max(128)).max(64),
  passkeys: z
    .array(
      z.object({
        id: z.string().max(2048),
        publicKey: z.string().max(4096),
        endorsement: signInProofSchema.optional(),
        countersignature: passkeyCountersignatureSchema.optional(),
      }),
    )
    .max(64),
});

/** The account service coordinates identity; gateway owner keys authorize handoffs and gateway approval still governs data access. */
export class ManagedAccountBrowser implements AccountBrowserPort {
  private abort = new AbortController();
  private readyOrigin?: string;
  private refreshAt = 0;
  constructor(
    private readonly options: {
      env(): NodeJS.ProcessEnv;
      accountId?(): string | undefined;
      callbackOrigins?(): GatewayBrowserCallbackOrigins;
      fetch?: typeof fetch;
      register?: typeof registerGatewayKey;
    },
  ) {}

  cancel(): void {
    this.abort.abort();
    this.abort = new AbortController();
    this.readyOrigin = undefined;
    this.refreshAt = 0;
  }
  authorizationOrigin(): string | undefined {
    return installationRelayUrl(this.options.env());
  }
  available(): boolean {
    const env = this.options.env();
    return (
      cloudRelayEnabled(env) &&
      this.readyOrigin !== undefined &&
      // Probe expiry controls network refresh, not whether an idle gateway offers
      // sign-in. Each handoff refreshes first and enrollment verifies fresh keys.
      installationRelayUrl(env) === this.readyOrigin &&
      Boolean(env.OMNESIS_CLOUD_RELAY_GATEWAY_ID)
    );
  }
  async refresh(signal?: AbortSignal): Promise<void> {
    const env = this.environment();
    if (!cloudRelayEnabled(env) || !env.OMNESIS_CLOUD_RELAY_GATEWAY_ID) {
      this.readyOrigin = undefined;
      return;
    }
    const origin = this.origin(env);
    if (this.readyOrigin === origin && Date.now() < this.refreshAt) return;
    const combined = this.signal(signal);
    const response = await this.request(
      origin,
      "/_relay/v3/account-keys",
      undefined,
      undefined,
      combined,
    );
    if (response.status === 404 || response.status === 503) {
      await response.body?.cancel();
      this.readyOrigin = undefined;
      return;
    }
    if (!response.ok) throw new Error("Account sign-in is unavailable");
    accountPublicKeys.parse(await readBoundedJson(response));
    combined.throwIfAborted();
    this.assertEnvironment(env);
    this.readyOrigin = origin;
    this.refreshAt = Date.now() + 60_000;
  }

  async callbackUrl(requestOrigin: string, purpose: AccountBrowserPurpose): Promise<string> {
    const env = this.environment();
    const origins = this.options.callbackOrigins?.() ?? {
      origins: [env.OMNESIS_PUBLIC_BASE_URL, env.OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN],
      port: Number(env.OMNESIS_GATEWAY_PORT ?? 7600),
      certificates: env.OMNESIS_TLS_CERT
        ? [new X509Certificate(await readFile(env.OMNESIS_TLS_CERT))]
        : [],
    };
    return gatewayBrowserCallback(
      requestOrigin,
      purpose === "owner-link"
        ? "/admin/cloud-relay/account/callback"
        : "/devices/account/callback",
      origins,
    );
  }

  async begin(input: Parameters<AccountBrowserPort["begin"]>[0]): Promise<AccountBrowserPending> {
    const signal = this.signal(input.signal),
      env = this.environment();
    await this.refresh(signal);
    if (!this.available()) throw new Error("Account sign-in is unavailable");
    this.assertEnvironment(env);
    const origin = this.origin(env),
      session = await this.session(env, signal);
    const material = await this.owner(env);
    if (material.context.ownerAccountId !== session.accountId)
      throw new Error("Gateway owner session changed");
    const issuedAt = Math.floor(Date.now() / 1000),
      redemptionSecret = randomBytes(32).toString("base64url");
    const unsigned = {
      protocol: ACCOUNT_BROWSER_PROTOCOL,
      operationId: randomUUID(),
      purpose: input.purpose,
      nonce: input.nonce,
      callbackUrl: input.callbackUrl,
      browserState: input.browserState,
      redemptionSha256: createHash("sha256").update(redemptionSecret).digest("hex"),
      issuedAt,
      expiresAt: Math.min(issuedAt + 300, session.expiresAt),
    };
    const ownerSignature = sign(
      null,
      accountBrowserTranscript(origin, material.context, unsigned),
      material.key,
    ).toString("base64url");
    signal.throwIfAborted();
    this.assertEnvironment(env);
    const response = await this.request(
      origin,
      ACCOUNT_BROWSER_PATH + "/start",
      { ...unsigned, ownerSignature },
      session.token,
      signal,
    );
    if (!response.ok) throw new Error("Account handoff was refused");
    const value = accountBrowserStarted.parse(await readBoundedJson(response)),
      authorize = new URL(value.authorizeUrl);
    if (
      value.operationId !== unsigned.operationId ||
      value.expiresAt !== unsigned.expiresAt ||
      authorize.origin !== origin ||
      authorize.pathname !== ACCOUNT_BROWSER_PATH + "/begin" ||
      authorize.username ||
      authorize.password ||
      authorize.hash ||
      authorize.searchParams.size !== 2 ||
      authorize.searchParams.get("operationId") !== unsigned.operationId ||
      !/^[A-Za-z0-9_-]{43}$/.test(authorize.searchParams.get("ticket") ?? "")
    )
      throw new Error("Account handoff destination was refused");
    signal.throwIfAborted();
    this.assertEnvironment(env);
    return {
      ...value,
      purpose: input.purpose,
      nonce: input.nonce,
      callbackUrl: input.callbackUrl,
      browserState: input.browserState,
      issuedAt,
      redemptionSecret,
      relayOrigin: origin,
      owner: material.context,
    };
  }

  async redeem(pending: AccountBrowserPending, result: string, callerSignal?: AbortSignal) {
    const redemption = accountBrowserRedemption.parse({
      operationId: pending.operationId,
      result,
      redemptionSecret: pending.redemptionSecret,
    });
    const signal = this.signal(callerSignal),
      env = this.environment(),
      origin = this.origin(env);
    if (origin !== pending.relayOrigin || !cloudRelayEnabled(env))
      throw new Error("Account handoff service changed");
    this.assertFresh(pending);
    const session = await this.session(env, signal),
      material = await this.owner(env);
    if (
      JSON.stringify(material.context) !== JSON.stringify(pending.owner) ||
      session.accountId !== material.context.ownerAccountId
    )
      throw new Error("Gateway identity changed during account sign-in");
    signal.throwIfAborted();
    this.assertEnvironment(env);
    const response = await this.request(
      origin,
      ACCOUNT_BROWSER_PATH + "/redeem",
      redemption,
      session.token,
      signal,
    );
    if (!response.ok) throw new Error("Account handoff was refused");
    const value = accountBrowserRedeemed.parse(await readBoundedJson(response));
    const keysResponse = await this.request(
      origin,
      "/_relay/v3/account-keys",
      undefined,
      undefined,
      signal,
    );
    if (!keysResponse.ok) throw new Error("Account verification is unavailable");
    const keys = createLocalJWKSet(accountPublicKeys.parse(await readBoundedJson(keysResponse)));
    const verifier =
      pending.purpose === "owner-link"
        ? new AccountGatewayLinkVerifier(
            origin,
            keys,
            pending.owner.gatewayId,
            pending.owner.ownerAccountId,
          )
        : new AccountEnrollmentVerifier(
            origin,
            keys,
            pending.owner.gatewayId,
            pending.owner.ownerAccountId,
            z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .parse(this.options.accountId?.()),
          );
    const identity = await verifier.verify(value.identityToken, pending.nonce);
    if (identity.subject !== value.accountId) throw new Error("Account handoff identity changed");
    // The role verifier requires an integer iat before returning an identity.
    const issuedAt = decodeJwt(value.identityToken).iat!;
    if (issuedAt < pending.issuedAt - 30 || identity.expiresAt > pending.expiresAt)
      throw new Error("Account proof is outside this handoff lifetime");
    signal.throwIfAborted();
    this.assertEnvironment(env);
    this.assertFresh(pending);
    return {
      identityToken: value.identityToken,
      identity,
      signInProof: value.signInProof,
      ...(value.credentialPublicKey ? { credentialPublicKey: value.credentialPublicKey } : {}),
    };
  }

  /**
   * The account's current sign-ins, with the evidence each passkey carries. A gateway drops pins
   * the account no longer lists and pins only what that evidence proves to it.
   */
  async credentials(callerSignal?: AbortSignal) {
    const signal = this.signal(callerSignal),
      env = this.environment();
    if (!cloudRelayEnabled(env)) return undefined;
    const session = await this.session(env, signal);
    signal.throwIfAborted();
    const response = await this.request(
      this.origin(env),
      ACCOUNT_BROWSER_PATH + "/credentials",
      undefined,
      session.token,
      signal,
      { [ACCOUNT_CREDENTIALS_EVIDENCE.header]: ACCOUNT_CREDENTIALS_EVIDENCE.countersignatures },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    return accountCredentialsListing.parse(
      await readBoundedJson(response, MAX_CREDENTIALS_LISTING_BYTES),
    );
  }

  async unlink(callerSignal?: AbortSignal): Promise<void> {
    const signal = this.signal(callerSignal),
      env = this.environment();
    if (!cloudRelayEnabled(env)) throw new Error("Account sign-in is unavailable");
    const session = await this.session(env, signal);
    signal.throwIfAborted();
    this.assertEnvironment(env);
    const response = await this.request(
      this.origin(env),
      ACCOUNT_BROWSER_PATH + "/unlink",
      {},
      session.token,
      signal,
    );
    if (!response.ok) throw new Error("Account unlink was refused");
    z.object({ ok: z.literal(true) })
      .strict()
      .parse(await readBoundedJson(response));
    signal.throwIfAborted();
    this.assertEnvironment(env);
  }

  async verifyEnrollment(token: string, nonce?: string) {
    const env = this.environment(),
      signal = this.signal(),
      origin = this.origin(env);
    if (!cloudRelayEnabled(env)) throw new Error("Account sign-in is unavailable");
    const material = await this.owner(env),
      account = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(this.options.accountId?.());
    const response = await this.request(
      origin,
      "/_relay/v3/account-keys",
      undefined,
      undefined,
      signal,
    );
    if (!response.ok) throw new Error("Account verification is unavailable");
    const keys = createLocalJWKSet(accountPublicKeys.parse(await readBoundedJson(response)));
    const identity = await new AccountEnrollmentVerifier(
      origin,
      keys,
      material.context.gatewayId,
      material.context.ownerAccountId,
      account,
    ).verify(token, nonce);
    signal.throwIfAborted();
    this.assertEnvironment(env);
    if (this.options.accountId?.() !== account) throw new Error("Gateway account changed");
    return identity;
  }

  private environment(): NodeJS.ProcessEnv {
    return { ...this.options.env() };
  }
  private origin(env: NodeJS.ProcessEnv): string {
    return bindingOrigin(installationRelayUrl(env)!).origin;
  }
  private signal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
  }
  private assertEnvironment(previous: NodeJS.ProcessEnv): void {
    const current = this.environment();
    if (
      !cloudRelayEnabled(current) ||
      this.origin(current) !== this.origin(previous) ||
      current.OMNESIS_CLOUD_RELAY_GATEWAY_ID !== previous.OMNESIS_CLOUD_RELAY_GATEWAY_ID ||
      publicGatewayOrigin(current) !== publicGatewayOrigin(previous)
    )
      throw new Error("Account handoff configuration changed");
  }
  private assertFresh(pending: AccountBrowserPending): void {
    if (pending.expiresAt <= Math.floor(Date.now() / 1000))
      throw new Error("Account sign-in expired");
  }
  private async owner(env: NodeJS.ProcessEnv) {
    const key = await readOrCreateGatewayOwnerKey(
      env.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE ?? `${env.OMNESIS_CLOUD_RELAY_SESSION_FILE}.owner-key`,
      false,
    );
    const ownerPublicKey = createPublicKey(key).export({ format: "pem", type: "spki" }).toString();
    return {
      key,
      context: {
        ownerAccountId: gatewayKeyAccount({
          gatewayId: env.OMNESIS_CLOUD_RELAY_GATEWAY_ID!,
          ownerPublicKey,
        }),
        gatewayId: env.OMNESIS_CLOUD_RELAY_GATEWAY_ID!,
        publicOrigin: publicGatewayOrigin(env),
        tlsSpkiFingerprint: tlsSpkiFingerprint(await readFile(publicGatewayCertificateFile(env))),
        ownerPublicKey,
      },
    };
  }
  private session(env: NodeJS.ProcessEnv, signal: AbortSignal) {
    return (this.options.register ?? registerGatewayKey)({
      relayUrl: this.origin(env),
      gatewayId: env.OMNESIS_CLOUD_RELAY_GATEWAY_ID!,
      sessionFile: env.OMNESIS_CLOUD_RELAY_SESSION_FILE!,
      ownerKeyFile: env.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE,
      enrollmentTokenFile: env.OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE,
      recoveryReceiptFile: env.OMNESIS_CLOUD_RELAY_RECOVERY_RECEIPT_FILE,
      publicOrigin: publicGatewayOrigin(env),
      certificateFile: publicGatewayCertificateFile(env),
      privateKeyFile: publicGatewayPrivateKeyFile(env),
      fetch: this.options.fetch,
      signal,
    });
  }
  private request(
    origin: string,
    path: string,
    body: unknown,
    token: string | undefined,
    signal: AbortSignal,
    headers: Record<string, string> = {},
  ) {
    signal.throwIfAborted();
    return (this.options.fetch ?? fetch)(new URL(path, origin), {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
}
