// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { X509Certificate, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ManagedGoogleBrowser, type GoogleBrowserPending } from "./google-browser-client.js";
import {
  beginGoogleAuthorization,
  completeGoogleAuthorization,
  type GoogleAuthorization,
} from "./google-oauth.js";
import { googleIdentityProvider, accountId, type IdentityProvider } from "./identity.js";
import { gatewayBindingNonce, bindingOrigin } from "./gateway-binding.js";
import {
  publicGatewayCertificateFile,
  publicGatewayPrivateKeyFile,
  publicGatewayOrigin,
} from "./gateway-certificate.js";
import { registerGatewayKey } from "./gateway-key-client.js";
import { readPrivateJson, savePrivateJson } from "./google-credentials.js";
import { relayOrigin } from "./network.js";
import { CloudRelayManagementFailure } from "./management.js";
import type { GoogleBrowserCallbackOrigins } from "./google-browser-callback.js";

const cookieName = "__Secure-omnesis-gateway-google";
const callbackPath = "/admin/cloud-relay/google/callback";
const clearCookie = `${cookieName}=; Path=${callbackPath}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
export interface GatewayGoogleWebOptions {
  env(): NodeJS.ProcessEnv;
  callbackOrigins?(): GoogleBrowserCallbackOrigins;
  metadataFile: string;
  fetch?: typeof fetch;
  identity?: IdentityProvider;
  register?: typeof registerGatewayKey;
}
interface Configuration {
  clientId: string;
  secret: string;
  callback: string;
  identity: IdentityProvider;
}

/** Browser OAuth proves Google ownership of the current TLS binding; the relay still requires raw owner-key authority. */
export class GatewayGoogleWeb {
  private readonly pending = new Map<
    string,
    { authorization: GoogleAuthorization; nonce: string }
  >();
  private readonly managed: ManagedGoogleBrowser;
  private readonly managedPending = new Map<string, GoogleBrowserPending>();
  private configuration: Configuration | undefined;
  private linked = false;
  private ownerAccountId: string | undefined;
  private starting = 0;
  private mutating = false;
  private abort = new AbortController();
  private lastError: "google-unavailable" | "google-link-failed" | undefined;
  constructor(private readonly options: GatewayGoogleWebOptions) {
    this.managed = new ManagedGoogleBrowser({
      ...options,
      identity: options.identity ? () => options.identity! : undefined,
    });
  }
  async refreshManaged(signal?: AbortSignal): Promise<void> {
    if (this.configuration) return;
    try {
      await this.managed.refresh(signal);
      this.lastError = undefined;
    } catch {
      this.lastError = "google-unavailable";
    }
  }
  managedBrowser() {
    return this.managed;
  }
  async initialize(): Promise<void> {
    const env = this.options.env(),
      id = env.OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_CLIENT_ID;
    try {
      try {
        const metadata = z
          .object({
            linked: z.boolean(),
            accountId: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
          })
          .parse(await readPrivateJson(this.options.metadataFile));
        this.linked = metadata.linked;
        this.ownerAccountId = metadata.accountId;
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
          throw error;
      }
      if (
        !id ||
        !env.OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_SECRET_FILE ||
        !env.OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_CALLBACK_URL
      )
        return;
      const callback = new URL(env.OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_CALLBACK_URL);
      bindingOrigin(callback.origin);
      if (
        callback.pathname !== callbackPath ||
        callback.search ||
        callback.hash ||
        callback.username ||
        callback.password
      )
        throw new Error();
      const others = [
        env.OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID,
        env.OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID,
        env.OMNESIS_CLOUD_RELAY_GOOGLE_ANDROID_CLIENT_ID,
        env.OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID,
      ].flatMap((value) => value?.split(",").map((part) => part.trim()) ?? []);
      if (others.includes(id)) throw new Error();
      const secret = z
        .object({
          web: z.object({
            client_id: z.literal(id),
            client_secret: z.string().trim().min(1).max(8192),
            redirect_uris: z.array(z.string()).max(32),
          }),
        })
        .parse(await readPrivateJson(env.OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_SECRET_FILE));
      if (!secret.web.redirect_uris.includes(callback.href)) throw new Error();
      this.configuration = {
        clientId: id,
        secret: secret.web.client_secret,
        callback: callback.href,
        identity: this.options.identity ?? googleIdentityProvider(id),
      };
    } catch {
      this.configuration = undefined;
      this.lastError = "google-unavailable";
    }
  }
  status() {
    return {
      configured: Boolean(this.configuration || this.managed.clientId("owner-link")),
      linked: this.linked,
      canLink: Boolean(this.configuration || this.managed.clientId("owner-link")),
      canUnlink: this.linked,
      linkOrigin: this.configuration ? new URL(this.configuration.callback).origin : undefined,
      lastError: this.lastError,
    };
  }
  private async nonce(): Promise<string> {
    const env = this.options.env();
    return gatewayBindingNonce({
      gatewayId: z.string().uuid().parse(env.OMNESIS_CLOUD_RELAY_GATEWAY_ID),
      publicOrigin: publicGatewayOrigin(env),
      certificate: new X509Certificate(
        await readFile(publicGatewayCertificateFile(env)),
      ).toString(),
    });
  }
  async start(input: { requestOrigin: string }): Promise<{ authorizeUrl: string; cookie: string }> {
    const config = this.configuration;
    if (!config) return this.startManaged(input.requestOrigin);
    if (input.requestOrigin !== new URL(config.callback).origin)
      throw new CloudRelayManagementFailure(400, "google-unavailable");
    for (const [state, value] of this.pending)
      if (value.authorization.expiresAt <= Date.now()) this.pending.delete(state);
    if (this.pending.size + this.starting >= 16)
      throw new CloudRelayManagementFailure(409, "operation-in-progress");
    this.starting++;
    const signal = this.abort.signal;
    try {
      const nonce = await this.nonce();
      signal.throwIfAborted();
      const authorization = beginGoogleAuthorization({
        clientId: config.clientId,
        redirectUri: config.callback,
        nonce,
      });
      this.pending.set(authorization.state, { authorization, nonce });
      return {
        authorizeUrl: authorization.url,
        cookie: `${cookieName}=${authorization.state}; Path=${callbackPath}; HttpOnly; Secure; SameSite=Lax; Max-Age=300`,
      };
    } finally {
      this.starting--;
    }
  }

  private async startManaged(
    requestOrigin: string,
  ): Promise<{ authorizeUrl: string; cookie: string }> {
    const signal = this.abort.signal;
    await this.refreshManaged(signal);
    signal.throwIfAborted();
    if (!this.managed.clientId("owner-link"))
      throw new CloudRelayManagementFailure(400, "google-unavailable");
    for (const [state, value] of this.managedPending)
      if (value.expiresAt <= Date.now() / 1000) this.managedPending.delete(state);
    if (this.managedPending.size + this.starting >= 16)
      throw new CloudRelayManagementFailure(409, "operation-in-progress");
    this.starting++;
    try {
      const browserState = randomBytes(32).toString("base64url");
      const operation = await this.managed.begin({
        purpose: "owner-link",
        nonce: await this.nonce(),
        browserState,
        callbackUrl: await this.managed.callbackUrl(requestOrigin, "owner-link"),
        signal,
      });
      signal.throwIfAborted();
      this.managedPending.set(browserState, operation);
      return {
        authorizeUrl: operation.authorizeUrl,
        cookie: `${cookieName}=${browserState}; Path=${callbackPath}; HttpOnly; Secure; SameSite=Lax; Max-Age=300`,
      };
    } finally {
      this.starting--;
    }
  }
  private async change(signal: AbortSignal, identityToken?: string): Promise<void> {
    signal.throwIfAborted();
    const env = this.options.env();
    const session = await (this.options.register ?? registerGatewayKey)({
      relayUrl: env.OMNESIS_CLOUD_RELAY_URL!,
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
    signal.throwIfAborted();
    const response = await (this.options.fetch ?? fetch)(
      new URL("/_relay/v2/key/google-link", relayOrigin(env.OMNESIS_CLOUD_RELAY_URL!)),
      {
        method: identityToken ? "POST" : "DELETE",
        redirect: "error",
        signal,
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
        ...(identityToken ? { body: JSON.stringify({ identityToken }) } : {}),
      },
    );
    signal.throwIfAborted();
    if (response.status !== 204) throw new Error("Discovery change refused");
  }
  async callback(input: {
    url: string;
    cookie?: string;
  }): Promise<{ redirectUrl: string; cookie: string }> {
    const config = this.configuration;
    if (!config) return this.callbackManaged(input);
    if (this.mutating) throw new CloudRelayManagementFailure(409, "operation-in-progress");
    this.mutating = true;
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]);
    try {
      if (input.url.length > 16_384) throw new Error();
      const url = new URL(input.url),
        states = url.searchParams.getAll("state");
      const cookies = (input.cookie ?? "")
        .split(";")
        .map((value) => value.trim())
        .filter((value) => value.startsWith(`${cookieName}=`));
      if (
        states.length !== 1 ||
        cookies.length !== 1 ||
        cookies[0] !== `${cookieName}=${states[0]}`
      )
        throw new Error();
      const operation = this.pending.get(states[0]);
      this.pending.delete(states[0]);
      if (!operation || operation.nonce !== (await this.nonce())) throw new Error();
      signal.throwIfAborted();
      const credentials = await completeGoogleAuthorization({
        authorization: operation.authorization,
        callbackUrl: input.url,
        identity: config.identity,
        clientSecret: config.secret,
        fetch: (url, init) =>
          (this.options.fetch ?? fetch)(url, {
            ...init,
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          }),
      });
      signal.throwIfAborted();
      if (operation.nonce !== (await this.nonce())) throw new Error();
      await this.change(signal, credentials.idToken);
      signal.throwIfAborted();
      const verifiedAccount = accountId(credentials.identity);
      signal.throwIfAborted();
      await savePrivateJson(this.options.metadataFile, {
        linked: true,
        accountId: verifiedAccount,
      });
      this.linked = true;
      this.ownerAccountId = verifiedAccount;
      this.lastError = undefined;
    } catch {
      this.lastError = "google-link-failed";
    } finally {
      this.mutating = false;
    }
    return {
      redirectUrl: new URL("/portal/settings/relay", config.callback).href,
      cookie: clearCookie,
    };
  }
  private async callbackManaged(input: {
    url: string;
    cookie?: string;
  }): Promise<{ redirectUrl: string; cookie: string }> {
    if (!this.managed.clientId("owner-link"))
      throw new CloudRelayManagementFailure(503, "google-unavailable");
    if (this.mutating) throw new CloudRelayManagementFailure(409, "operation-in-progress");
    this.mutating = true;
    let destination: string | undefined;
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]);
    try {
      if (input.url.length > 16_384) throw new Error();
      const url = new URL(input.url),
        states = url.searchParams.getAll("state"),
        results = url.searchParams.getAll("brokerResult");
      const cookies = (input.cookie ?? "")
        .split(";")
        .map((value) => value.trim())
        .filter((value) => value.startsWith(`${cookieName}=`));
      if (
        states.length !== 1 ||
        results.length !== 1 ||
        cookies.length !== 1 ||
        cookies[0] !== `${cookieName}=${states[0]}`
      )
        throw new Error();
      const operation = this.managedPending.get(states[0]!);
      this.managedPending.delete(states[0]!);
      if (!operation || operation.callbackUrl !== `${url.origin}${url.pathname}`) throw new Error();
      destination = new URL("/portal/settings/relay", operation.callbackUrl).href;
      if (operation.nonce !== (await this.nonce())) throw new Error();
      const credentials = await this.managed.redeem(operation, results[0]!, signal);
      if (operation.nonce !== (await this.nonce())) throw new Error();
      await this.change(signal, credentials.idToken);
      signal.throwIfAborted();
      const verifiedAccount = accountId(credentials.identity);
      await savePrivateJson(this.options.metadataFile, {
        linked: true,
        accountId: verifiedAccount,
      });
      this.linked = true;
      this.ownerAccountId = verifiedAccount;
      this.lastError = undefined;
    } catch {
      this.lastError = "google-link-failed";
    } finally {
      this.mutating = false;
    }
    if (!destination) throw new CloudRelayManagementFailure(400, "google-link-failed");
    return { redirectUrl: destination, cookie: clearCookie };
  }
  async unlink(): Promise<void> {
    if (this.mutating) throw new CloudRelayManagementFailure(409, "operation-in-progress");
    this.mutating = true;
    this.cancel();
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]);
    try {
      await this.change(signal);
      await savePrivateJson(this.options.metadataFile, {
        linked: false,
        accountId: this.ownerAccountId,
      });
      this.linked = false;
      this.lastError = undefined;
      this.pending.clear();
    } catch {
      this.lastError = "google-link-failed";
      throw new CloudRelayManagementFailure(503, "google-link-failed");
    } finally {
      this.mutating = false;
    }
  }
  verifiedOwnerAccountId(): string | undefined {
    return this.ownerAccountId;
  }
  cancel(): void {
    this.abort.abort();
    this.managed.cancel();
    this.abort = new AbortController();
    this.pending.clear();
    this.managedPending.clear();
  }
}
