// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import {
  beginGoogleAuthorization,
  completeGoogleAuthorization,
  type GoogleAuthorization,
} from "./google-oauth.js";
import { gatewayBindingNonce } from "./gateway-binding.js";
import { RelayError } from "./tunnels.js";
import { relayOrigin } from "./network.js";
import {
  GOOGLE_BROWSER_PATH,
  GOOGLE_BROWSER_PROTOCOL,
  googleBrowserConfigSchema,
  googleBrowserStartSchema,
  googleBrowserStartTranscript,
  googleBrowserRedeemSchema,
  type GoogleBrowserStart,
  type GoogleBrowserStartContext,
  type GoogleBrowserStartResult,
} from "./google-browser-contract.js";
import type { IdentityProvider } from "./identity.js";

export interface GoogleBrowserOwner extends GoogleBrowserStartContext {
  ownerPublicKey: string;
  certificate: string;
}
export interface GoogleBrowserOAuthClient {
  clientId: string;
  clientSecret: string;
  identity: IdentityProvider;
  fetch?: typeof fetch;
}
export interface GoogleBrowserOwnerAuthorization extends GoogleBrowserOwner {
  sessionExpiresAt: number;
}
export interface GoogleBrowserBrokerOptions {
  origin: string | (() => string);
  ownerLink?: GoogleBrowserOAuthClient;
  deviceEnrollment?: GoogleBrowserOAuthClient;
  deviceClientIds?: readonly string[];
  deviceAuthorizedParties?: readonly string[];
  currentOwner(accountId: string): GoogleBrowserOwner | undefined;
  maxOperations?: number;
  maxOperationsPerOwner?: number;
}
interface Operation {
  request: GoogleBrowserStart;
  context: GoogleBrowserStartContext;
  authorization: GoogleAuthorization;
  client: GoogleBrowserOAuthClient;
  browserTicket: string;
  controller: AbortController;
  phase: "created" | "launched" | "exchanging" | "completed" | "consumed";
  result?: string;
  idToken?: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function equal(actual: string, expected: string): boolean {
  const left = Buffer.from(actual),
    right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function opaque(): string {
  return randomBytes(32).toString("base64url");
}
function contextOf(owner: GoogleBrowserOwner): GoogleBrowserStartContext {
  return {
    relayOrigin: owner.relayOrigin,
    accountId: owner.accountId,
    gatewayId: owner.gatewayId,
    publicOrigin: owner.publicOrigin,
    tlsSpkiFingerprint: owner.tlsSpkiFingerprint,
  };
}

/** Central OAuth coordinates identity; original Google proofs still require independent gateway verification. */
export class GoogleBrowserBroker {
  private readonly operations = new Map<string, Operation>();
  private readonly config;
  private readonly maxOperations: number;
  private readonly maxPerOwner: number;
  private closed = false;

  constructor(private readonly options: GoogleBrowserBrokerOptions) {
    const ids = [...new Set(options.deviceClientIds ?? [])];
    if (options.deviceEnrollment && !ids.includes(options.deviceEnrollment.clientId))
      ids.push(options.deviceEnrollment.clientId);
    const parties = [...new Set([...(options.deviceAuthorizedParties ?? []), ...ids])];
    this.config = googleBrowserConfigSchema.parse({
      protocol: GOOGLE_BROWSER_PROTOCOL,
      ...(options.ownerLink ? { ownerLinkClientId: options.ownerLink.clientId } : {}),
      ...(options.deviceEnrollment
        ? { deviceEnrollmentClientId: options.deviceEnrollment.clientId }
        : {}),
      deviceClientIds: ids,
      deviceAuthorizedParties: parties,
    });
    if (
      options.ownerLink &&
      (ids.includes(options.ownerLink.clientId) || parties.includes(options.ownerLink.clientId))
    )
      throw new Error("Gateway owner Google audience must be separate from enrollment clients");
    for (const client of [options.ownerLink, options.deviceEnrollment])
      if (client && !client.clientSecret.trim())
        throw new Error("Google broker requires an operator client secret");
    this.maxOperations = options.maxOperations ?? 1024;
    this.maxPerOwner = options.maxOperationsPerOwner ?? 8;
    for (const limit of [this.maxOperations, this.maxPerOwner])
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096)
        throw new Error("Invalid Google browser operation limits");
    if (typeof options.origin === "string") this.origin();
  }

  private origin(): string {
    return relayOrigin(
      typeof this.options.origin === "string" ? this.options.origin : this.options.origin(),
    ).origin;
  }
  configuration() {
    return {
      ...this.config,
      deviceClientIds: [...this.config.deviceClientIds],
      deviceAuthorizedParties: [...this.config.deviceAuthorizedParties],
    };
  }
  private prune(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [id, operation] of this.operations) {
      if (operation.request.expiresAt <= now) {
        operation.controller.abort();
        this.operations.delete(id);
      }
    }
  }
  private assertCurrent(operation: Operation): void {
    if (
      this.closed ||
      this.operations.get(operation.request.operationId) !== operation ||
      operation.request.expiresAt <= Date.now() / 1000
    )
      throw new RelayError(410, "Google browser operation expired");
    this.assertBinding(operation.context, operation.request);
  }
  private assertBinding(context: GoogleBrowserStartContext, request: GoogleBrowserStart): void {
    const current = this.options.currentOwner(context.accountId);
    if (!current || JSON.stringify(contextOf(current)) !== JSON.stringify(context))
      throw new RelayError(403, "Gateway Google operation authorization changed");
    if (request.purpose === "owner-link" && gatewayBindingNonce(current) !== request.nonce)
      throw new RelayError(403, "Gateway Google binding changed");
  }

  start(owner: GoogleBrowserOwnerAuthorization, input: unknown): GoogleBrowserStartResult {
    this.prune();
    if (this.closed) throw new RelayError(503, "Google browser broker is closed");
    if (owner.sessionExpiresAt <= Date.now() / 1000)
      throw new RelayError(401, "Gateway owner session expired");
    let request: GoogleBrowserStart;
    try {
      request = googleBrowserStartSchema.parse(input);
    } catch {
      throw new RelayError(400, "Invalid Google browser operation");
    }
    const client =
      request.purpose === "owner-link" ? this.options.ownerLink : this.options.deviceEnrollment;
    if (!client) throw new RelayError(503, "Google browser sign-in is not configured");
    if (this.operations.has(request.operationId))
      throw new RelayError(409, "Google browser operation already exists");
    const now = Math.floor(Date.now() / 1000);
    if (request.issuedAt > now + 30 || request.expiresAt <= now)
      throw new RelayError(410, "Google browser operation expired");
    if (
      this.operations.size >= this.maxOperations ||
      [...this.operations.values()].filter((value) => value.context.accountId === owner.accountId)
        .length >= this.maxPerOwner
    )
      throw new RelayError(429, "Google browser operation capacity reached");
    const context = contextOf(owner);
    const { ownerSignature, ...unsigned } = request;
    try {
      if (relayOrigin(context.relayOrigin).origin !== this.origin()) throw new Error();
      const key = createPublicKey(owner.ownerPublicKey),
        signature = Buffer.from(ownerSignature, "base64url");
      if (
        key.asymmetricKeyType !== "ed25519" ||
        signature.toString("base64url") !== ownerSignature ||
        !verify(null, googleBrowserStartTranscript(context, unsigned), key, signature)
      )
        throw new Error();
      if (request.purpose === "owner-link" && gatewayBindingNonce(owner) !== request.nonce)
        throw new Error();
    } catch {
      throw new RelayError(403, "Gateway owner proof required");
    }
    const authorization = beginGoogleAuthorization({
      clientId: client.clientId,
      redirectUri: new URL(GOOGLE_BROWSER_PATH + "/callback", this.origin()).href,
      nonce: request.nonce,
    });
    authorization.expiresAt = Math.min(authorization.expiresAt, request.expiresAt * 1000);
    const operation: Operation = {
      request,
      context,
      authorization,
      client,
      browserTicket: opaque(),
      controller: new AbortController(),
      phase: "created",
    };
    this.assertBinding(context, request);
    this.operations.set(request.operationId, operation);
    const authorize = new URL(GOOGLE_BROWSER_PATH + "/begin", this.origin());
    authorize.searchParams.set("operationId", request.operationId);
    authorize.searchParams.set("ticket", operation.browserTicket);
    return {
      protocol: GOOGLE_BROWSER_PROTOCOL,
      operationId: request.operationId,
      authorizeUrl: authorize.href,
      expiresAt: request.expiresAt,
      clientId: client.clientId,
    };
  }

  launch(operationId: string, ticket: string): { authorizeUrl: string; cookie: string } {
    this.prune();
    const operation = this.operations.get(operationId);
    if (!operation || operation.phase !== "created" || !equal(ticket, operation.browserTicket))
      throw new RelayError(403, "Invalid Google browser launch");
    this.assertCurrent(operation);
    operation.phase = "launched";
    operation.browserTicket = "";
    return {
      authorizeUrl: operation.authorization.url,
      cookie: this.cookie(
        operation,
        operation.authorization.state,
        Math.max(1, operation.request.expiresAt - Math.floor(Date.now() / 1000)),
      ),
    };
  }
  private cookie(operation: Operation, value: string, age: number): string {
    return `__Host-omnesis-google-browser-${operation.request.operationId}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
  }

  async callback(
    url: URL,
    cookieHeader: string,
    signal?: AbortSignal,
  ): Promise<{ redirectUrl: string; cookie: string }> {
    this.prune();
    const states = url.searchParams.getAll("state");
    const state = states.length === 1 ? states[0] : undefined;
    const operation = [...this.operations.values()].find(
      (value) => value.authorization.state === state,
    );
    if (!operation || operation.phase !== "launched")
      throw new RelayError(400, "Invalid Google browser callback");
    this.assertCurrent(operation);
    const name = `__Host-omnesis-google-browser-${operation.request.operationId}=`;
    const cookies = cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith(name));
    if (
      cookies.length !== 1 ||
      !equal(cookies[0]!.slice(name.length), operation.authorization.state)
    )
      throw new RelayError(403, "Google sign-in browser state mismatch");
    operation.phase = "exchanging";
    const combined = signal
      ? AbortSignal.any([signal, operation.controller.signal])
      : operation.controller.signal;
    try {
      const credentials = await completeGoogleAuthorization({
        authorization: operation.authorization,
        callbackUrl: url.href,
        identity: operation.client.identity,
        clientSecret: operation.client.clientSecret,
        fetch: operation.client.fetch,
        signal: combined,
      });
      this.assertCurrent(operation);
      combined.throwIfAborted();
      operation.idToken = credentials.idToken;
    } catch {
      operation.idToken = undefined;
    }
    this.assertCurrent(operation);
    combined.throwIfAborted();
    operation.phase = "completed";
    operation.result = opaque();
    const redirect = new URL(operation.request.callbackUrl);
    redirect.searchParams.set("brokerResult", operation.result);
    redirect.searchParams.set("state", operation.request.browserState);
    return { redirectUrl: redirect.href, cookie: this.cookie(operation, "", 0) };
  }

  redeem(
    owner: GoogleBrowserOwnerAuthorization,
    input: unknown,
  ): { idToken: string; clientId: string } {
    this.prune();
    if (owner.sessionExpiresAt <= Date.now() / 1000)
      throw new RelayError(401, "Gateway owner session expired");
    let body: ReturnType<typeof googleBrowserRedeemSchema.parse>;
    try {
      body = googleBrowserRedeemSchema.parse(input);
    } catch {
      throw new RelayError(400, "Invalid Google browser redemption");
    }
    const operation = this.operations.get(body.operationId);
    if (
      !operation ||
      operation.phase !== "completed" ||
      operation.context.accountId !== owner.accountId ||
      !equal(body.result, operation.result!) ||
      !equal(digest(body.redemptionSecret), operation.request.redemptionSha256)
    )
      throw new RelayError(403, "Invalid Google browser redemption");
    this.assertCurrent(operation);
    operation.phase = "consumed";
    const idToken = operation.idToken;
    operation.idToken = undefined;
    if (!idToken) throw new RelayError(400, "Google sign-in was not completed");
    return { idToken, clientId: operation.client.clientId };
  }
  close(): void {
    this.closed = true;
    for (const operation of this.operations.values()) operation.controller.abort();
    this.operations.clear();
  }
}
