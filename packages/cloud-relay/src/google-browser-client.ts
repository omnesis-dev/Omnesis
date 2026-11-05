// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { X509Certificate, createHash, randomBytes, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { decodeJwt } from "jose";
import { z } from "zod";
import { tlsSpkiFingerprint } from "./pinned-key.js";
import {
  googleBrowserCallback,
  type GoogleBrowserCallbackOrigins,
} from "./google-browser-callback.js";
import { relayOrigin } from "./network.js";
import {
  publicGatewayCertificateFile,
  publicGatewayPrivateKeyFile,
  publicGatewayOrigin,
} from "./gateway-certificate.js";
import { registerGatewayKey, readOrCreateGatewayOwnerKey } from "./gateway-key-client.js";
import { readBoundedJson } from "./google-credentials.js";
import { googleIdentityProvider, type IdentityProvider, type Identity } from "./identity.js";
import {
  googleBrowserStartTranscript,
  googleBrowserConfigSchema,
  type GoogleBrowserPurpose,
} from "./google-browser-contract.js";
import { googleBrowserTrust, trustedGoogleBrowserConfiguration } from "./google-browser-trust.js";

const protocol = "omnesis-google-browser-v1" as const;
const capabilities = googleBrowserConfigSchema;
export interface GoogleBrowserPending {
  operationId: string;
  authorizeUrl: string;
  redemptionSecret: string;
  expiresAt: number;
  issuedAt: number;
  clientId: string;
  nonce: string;
  callbackUrl: string;
  browserState: string;
  purpose: GoogleBrowserPurpose;
}
export interface GoogleBrowserPort {
  clientId(purpose: GoogleBrowserPurpose): string | undefined;
  deviceIdentity():
    { clientIds: readonly string[]; authorizedParties: readonly string[] } | undefined;
  callbackUrl(requestOrigin: string, purpose: GoogleBrowserPurpose): Promise<string>;
  begin(input: {
    purpose: GoogleBrowserPurpose;
    nonce: string;
    callbackUrl: string;
    browserState: string;
    signal?: AbortSignal;
  }): Promise<GoogleBrowserPending>;
  redeem(
    pending: GoogleBrowserPending,
    result: string,
    signal?: AbortSignal,
  ): Promise<{ idToken: string; identity: Identity }>;
}

/** The installation service holds OAuth secrets. Gateways retain an independent Google signature check and their own redemption capability. */
export class ManagedGoogleBrowser implements GoogleBrowserPort {
  private abort = new AbortController();
  cancel(): void {
    this.abort.abort();
    this.abort = new AbortController();
  }
  private config: z.infer<typeof capabilities> | undefined;
  private refreshAt = 0;
  private refreshing: Promise<void> | undefined;
  constructor(
    private readonly options: {
      env(): NodeJS.ProcessEnv;
      callbackOrigins?(): GoogleBrowserCallbackOrigins;
      fetch?: typeof fetch;
      register?: typeof registerGatewayKey;
      identity?(audience: string): IdentityProvider;
    },
  ) {}
  clientId(purpose: GoogleBrowserPurpose): string | undefined {
    const config =
      this.config &&
      trustedGoogleBrowserConfiguration(this.config, googleBrowserTrust(this.options.env()));
    return purpose === "owner-link" ? config?.ownerLinkClientId : config?.deviceEnrollmentClientId;
  }
  deviceIdentity() {
    const config =
      this.config &&
      trustedGoogleBrowserConfiguration(this.config, googleBrowserTrust(this.options.env()));
    return config && config.deviceClientIds.length
      ? {
          clientIds: [...config.deviceClientIds],
          authorizedParties: [...config.deviceAuthorizedParties],
        }
      : undefined;
  }
  async callbackUrl(requestOrigin: string, purpose: GoogleBrowserPurpose): Promise<string> {
    const e = this.options.env();
    const options = this.options.callbackOrigins?.() ?? {
      origins: [e.OMNESIS_PUBLIC_BASE_URL, e.OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN],
      port: Number(e.OMNESIS_GATEWAY_PORT ?? 7600),
      certificates: e.OMNESIS_TLS_CERT
        ? [new X509Certificate(await readFile(e.OMNESIS_TLS_CERT))]
        : [],
    };
    return googleBrowserCallback(
      requestOrigin,
      purpose === "owner-link" ? "/admin/cloud-relay/google/callback" : "/devices/google/callback",
      options,
    );
  }
  async refresh(signal?: AbortSignal): Promise<void> {
    if (Date.now() < this.refreshAt) {
      if (this.config)
        trustedGoogleBrowserConfiguration(this.config, googleBrowserTrust(this.options.env()));
      return;
    }
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const e = this.options.env();
      if (!e.OMNESIS_CLOUD_RELAY_URL || !e.OMNESIS_CLOUD_RELAY_GATEWAY_ID) return;
      const trust = googleBrowserTrust(e);
      if (
        !trust.ownerLinkClientId &&
        !trust.deviceEnrollmentClientId &&
        !trust.deviceClientIds.length
      ) {
        this.config = undefined;
        return;
      }
      const response = await this.request("config", undefined, signal);
      if (response.status === 404 || response.status === 503) {
        await response.body?.cancel();
        this.config = undefined;
      } else {
        if (!response.ok) throw new Error("Managed Google sign-in is unavailable");
        const config = trustedGoogleBrowserConfiguration(await readBoundedJson(response), trust);
        signal?.throwIfAborted();
        this.config = config;
      }
      this.refreshAt = Date.now() + 60_000;
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }
  private async session(signal?: AbortSignal) {
    const e = this.options.env();
    return (this.options.register ?? registerGatewayKey)({
      relayUrl: e.OMNESIS_CLOUD_RELAY_URL!,
      gatewayId: e.OMNESIS_CLOUD_RELAY_GATEWAY_ID!,
      sessionFile: e.OMNESIS_CLOUD_RELAY_SESSION_FILE!,
      ownerKeyFile: e.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE,
      enrollmentTokenFile: e.OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE,
      recoveryReceiptFile: e.OMNESIS_CLOUD_RELAY_RECOVERY_RECEIPT_FILE,
      publicOrigin: publicGatewayOrigin(e),
      certificateFile: publicGatewayCertificateFile(e),
      privateKeyFile: publicGatewayPrivateKeyFile(e),
      fetch: this.options.fetch,
      signal,
    });
  }
  private async request(
    path: "config" | "start" | "redeem",
    body?: unknown,
    signal?: AbortSignal,
    token?: string,
  ) {
    signal?.throwIfAborted();
    return (this.options.fetch ?? fetch)(
      new URL(
        `/_relay/v2/google/browser/${path}`,
        relayOrigin(this.options.env().OMNESIS_CLOUD_RELAY_URL!),
      ),
      {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
  }
  async begin(input: Parameters<GoogleBrowserPort["begin"]>[0]): Promise<GoogleBrowserPending> {
    const signal = input.signal
      ? AbortSignal.any([input.signal, this.abort.signal])
      : this.abort.signal;
    await this.refresh(signal);
    const audience = this.clientId(input.purpose);
    if (!audience) throw new Error("Managed Google sign-in is unavailable");
    const e = this.options.env(),
      session = await this.session(signal);
    const issuedAt = Math.floor(Date.now() / 1000),
      redemptionSecret = randomBytes(32).toString("base64url");
    const unsigned = {
      protocol,
      operationId: randomUUID(),
      purpose: input.purpose,
      nonce: input.nonce,
      callbackUrl: input.callbackUrl,
      browserState: input.browserState,
      redemptionSha256: createHash("sha256").update(redemptionSecret).digest("hex"),
      issuedAt,
      expiresAt: issuedAt + 300,
    };
    const owner = await readOrCreateGatewayOwnerKey(
      e.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE ?? `${e.OMNESIS_CLOUD_RELAY_SESSION_FILE}.owner-key`,
      false,
    );
    const transcript = googleBrowserStartTranscript(
      {
        relayOrigin: relayOrigin(e.OMNESIS_CLOUD_RELAY_URL!).origin,
        accountId: session.accountId,
        gatewayId: e.OMNESIS_CLOUD_RELAY_GATEWAY_ID!,
        publicOrigin: publicGatewayOrigin(e),
        tlsSpkiFingerprint: tlsSpkiFingerprint(
          new X509Certificate(await readFile(publicGatewayCertificateFile(e))).raw,
        ),
      },
      unsigned,
    );
    const response = await this.request(
      "start",
      { ...unsigned, ownerSignature: sign(null, transcript, owner).toString("base64url") },
      signal,
      session.token,
    );
    if (!response.ok) throw new Error("Managed Google sign-in was refused");
    const value = z
      .object({
        protocol: z.literal(protocol),
        operationId: z.literal(unsigned.operationId),
        authorizeUrl: z.string().max(4096),
        expiresAt: z.literal(unsigned.expiresAt),
        clientId: z.literal(audience),
      })
      .strict()
      .parse(await readBoundedJson(response));
    const authorize = new URL(value.authorizeUrl),
      control = relayOrigin(e.OMNESIS_CLOUD_RELAY_URL!);
    if (
      authorize.origin !== control.origin ||
      authorize.pathname !== "/_relay/v2/google/browser/begin" ||
      authorize.username ||
      authorize.password ||
      authorize.hash
    )
      throw new Error("Managed Google browser destination was refused");
    signal.throwIfAborted();
    return { ...value, ...input, issuedAt, redemptionSecret, nonce: input.nonce };
  }
  async redeem(pending: GoogleBrowserPending, result: string, callerSignal?: AbortSignal) {
    const trust = googleBrowserTrust(this.options.env());
    const audience =
      pending.purpose === "owner-link" ? trust.ownerLinkClientId : trust.deviceEnrollmentClientId;
    if (!audience || audience !== pending.clientId)
      throw new Error("Managed Google audience is not trusted");
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, this.abort.signal])
      : this.abort.signal;
    if (pending.expiresAt <= Math.floor(Date.now() / 1000))
      throw new Error("Managed Google sign-in expired");
    const session = await this.session(signal);
    const response = await this.request(
      "redeem",
      { operationId: pending.operationId, result, redemptionSecret: pending.redemptionSecret },
      signal,
      session.token,
    );
    if (!response.ok) throw new Error("Managed Google sign-in was refused");
    const value = z
      .object({ idToken: z.string().min(1).max(16_384), clientId: z.literal(pending.clientId) })
      .strict()
      .parse(await readBoundedJson(response));
    const identity = await (this.options.identity ?? googleIdentityProvider)(
      pending.clientId,
    ).verify(value.idToken, pending.nonce);
    const issuedAt = decodeJwt(value.idToken).iat;
    if (typeof issuedAt !== "number" || issuedAt < pending.issuedAt - 60)
      throw new Error("Managed Google identity predates sign-in");
    signal.throwIfAborted();
    if (pending.expiresAt <= Math.floor(Date.now() / 1000))
      throw new Error("Managed Google sign-in expired");
    return { idToken: value.idToken, identity };
  }
}
