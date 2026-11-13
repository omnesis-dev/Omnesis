// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { CONNECT_PAGE_PATH, type ConnectCodes } from "./connect-codes.js";
import { bindingOrigin } from "./gateway-binding.js";
import {
  OperationProof,
  type AccountOperationBroker,
  type ProofEvidence,
} from "./operation-proof.js";
import { RelayError } from "./tunnels.js";
import type { AccountBrowserAccount } from "./account-browser-broker.js";
import type { RelaySessions } from "./identity.js";

const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const startSchema = z
  .object({
    nonce: opaque,
    challenge: opaque,
    kind: z.enum(["cli", "collector"]),
    name: z.string().trim().min(1).max(80),
    /** The desktop's single-use 127.0.0.1 listener (RFC 8252 §7.3), where the browser lands after confirming. */
    loopbackPort: z.number().int().min(1024).max(65535).optional(),
  })
  .strict();
const redeemSchema = z
  .object({
    operationId: z.string().uuid(),
    ticket: opaque,
    verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
    completion: opaque.optional(),
  })
  .strict();
/** How long redemption waits for the browser to reach the desktop's listener before going on without a proof. */
export const LOOPBACK_GRACE_MS = 15_000;
const digest = (value: string) => createHash("sha256").update(value).digest();
const secret = () => randomBytes(32).toString("base64url");
interface Operation {
  input: z.infer<typeof startSchema>;
  nativeHash: Buffer;
  launchHash: Buffer;
  browserHash?: Buffer;
  proof: OperationProof;
  code: string;
  actor?: AccountBrowserAccount;
  expiresAt: number;
  phase: "created" | "launched" | "approved" | "redeeming";
  /** Launched by a connect code: the browser may be on any machine, so no proof ever leaves. */
  viaCode?: boolean;
  /** Set when the browser was sent to the desktop's own listener with a completion secret. */
  completionHash?: Buffer;
  approvedAt?: number;
}

/**
 * A browser signs in for the desktop; the native PKCE holder alone receives the discovery credential.
 * The sign-in proof, which can join a device without approval, leaves only to a desktop that shows it
 * is on the machine where the sign-in finished: the browser hands it a secret over 127.0.0.1.
 */
export class DesktopAccountBrowser implements AccountOperationBroker {
  private readonly origin: string;
  private readonly operations = new Map<string, Operation>();
  private closed = false;
  constructor(
    private readonly options: {
      origin: string;
      sessions: RelaySessions;
      codes: ConnectCodes;
      connectShortUrl?: string;
      assertAccount(account: AccountBrowserAccount): void;
      assertCurrent(): void;
      maxPending?: number;
    },
  ) {
    this.origin = bindingOrigin(options.origin).origin;
    if (
      !Number.isSafeInteger(options.maxPending ?? 128) ||
      (options.maxPending ?? 128) < 1 ||
      (options.maxPending ?? 128) > 4096
    )
      throw new Error("Invalid desktop sign-in limits");
  }
  start(input: unknown) {
    this.assertOpen();
    this.prune();
    const parsed = startSchema.safeParse(input);
    if (!parsed.success) throw new RelayError(400, "Invalid desktop sign-in request");
    if (this.operations.size >= (this.options.maxPending ?? 128))
      throw new RelayError(429, "Too many desktop sign-in requests");
    const operationId = randomUUID(),
      ticket = secret(),
      launchTicket = secret(),
      expiresAt = Math.floor(Date.now() / 1000) + 300,
      code = this.options.codes.issue(expiresAt, (cookie) => this.claim(operationId, cookie));
    this.operations.set(operationId, {
      input: parsed.data,
      nativeHash: digest(ticket),
      launchHash: digest(launchTicket),
      proof: new OperationProof(parsed.data.nonce),
      code,
      expiresAt,
      phase: "created",
    });
    const authorize = new URL("/_relay/v3/desktop/begin", this.origin);
    authorize.search = new URLSearchParams({ operationId, ticket: launchTicket }).toString();
    return {
      operationId,
      ticket,
      authorizeUrl: authorize.href,
      connectUrl: new URL(CONNECT_PAGE_PATH, this.origin).href,
      ...(this.options.connectShortUrl ? { connectShortUrl: this.options.connectShortUrl } : {}),
      code,
      expiresAt,
    };
  }
  launch(id: string, ticket: string, cookieHeader: string) {
    const operation = this.current(id);
    if (
      !this.launchable(operation) ||
      !opaque.safeParse(ticket).success ||
      !timingSafeEqual(digest(ticket), operation.launchHash)
    )
      throw new RelayError(403, "Desktop browser launch refused");
    return this.bind(id, operation, cookieHeader);
  }
  private claim(id: string, cookieHeader: string) {
    const operation = this.current(id);
    if (!this.launchable(operation)) throw new RelayError(403, "Desktop browser launch refused");
    const result = this.bind(id, operation, cookieHeader);
    // Never cleared: a later launch from the link does not prove the code was not used elsewhere.
    operation.viaCode = true;
    return result;
  }
  /**
   * The link or the code may be opened again until somebody signs in: a closed tab or a second
   * device must not strand the request. Each launch binds a new browser and drops the previous one.
   */
  private launchable(operation: Operation): boolean {
    return (
      operation.phase === "created" || (operation.phase === "launched" && operation.proof.needed())
    );
  }
  private bind(id: string, operation: Operation, cookieHeader: string) {
    if (
      cookieHeader.split(";").filter((part) => part.trim().startsWith("__Host-omnesis-desktop-"))
        .length >= 8
    )
      throw new RelayError(429, "Too many desktop browser requests");
    const browser = secret();
    operation.browserHash = digest(browser);
    operation.phase = "launched";
    return { cookie: this.cookie(id, browser), location: `/_relay/account?desktop=${id}` };
  }
  describe(id: string, cookieHeader: string) {
    const operation = this.browser(id, cookieHeader);
    return {
      purpose: "desktop-discovery" as const,
      deviceName: operation.input.name,
      kind: operation.input.kind,
      code: operation.code,
      expiresAt: operation.expiresAt,
      needsProof: operation.proof.needed(),
      approvalRequired: !this.loopback(operation),
    };
  }
  proofCommitment(id: string, cookieHeader: string) {
    return this.signingIn(id, cookieHeader).proof.commitment();
  }
  googleProofNonce(id: string, cookieHeader: string) {
    return this.signingIn(id, cookieHeader).proof.googleNonce();
  }
  recordProof(id: string, cookieHeader: string, evidence: ProofEvidence): void {
    this.signingIn(id, cookieHeader).proof.record(evidence);
  }
  confirm(id: string, cookieHeader: string, actor: AccountBrowserAccount) {
    const operation = this.browser(id, cookieHeader);
    this.options.assertAccount(actor);
    if (operation.phase !== "launched")
      throw new RelayError(409, "Desktop sign-in was already approved");
    operation.proof.assertFrom(actor.accountId);
    operation.actor = { ...actor };
    operation.phase = "approved";
    operation.approvedAt = Date.now();
    const port = this.loopback(operation);
    if (port === undefined)
      return {
        cookie: this.cookie(id, ""),
        location: new URL("/_relay/v3/desktop/complete", this.origin).href,
      };
    const completion = secret();
    operation.completionHash = digest(completion);
    const location = new URL(`http://127.0.0.1:${port}/omnesis/callback`);
    location.search = new URLSearchParams({ operationId: id, completion }).toString();
    return { cookie: this.cookie(id, ""), location: location.href };
  }
  async redeem(input: unknown) {
    const value = redeemSchema.safeParse(input);
    if (!value.success) throw new RelayError(400, "Invalid desktop redemption");
    const operation = this.native(value.data.operationId, value.data.ticket);
    if (
      !timingSafeEqual(
        Buffer.from(digest(value.data.verifier).toString("base64url")),
        Buffer.from(operation.input.challenge),
      )
    )
      throw new RelayError(403, "Desktop sign-in verification refused");
    const proven =
      value.data.completion !== undefined &&
      operation.completionHash !== undefined &&
      timingSafeEqual(digest(value.data.completion), operation.completionHash);
    if (
      operation.phase === "created" ||
      operation.phase === "launched" ||
      // Give the browser a moment to reach the desktop's listener before going on without a proof.
      (operation.phase === "approved" &&
        operation.completionHash !== undefined &&
        !proven &&
        Date.now() < operation.approvedAt! + LOOPBACK_GRACE_MS)
    )
      return { status: "pending" as const, expiresAt: operation.expiresAt };
    if (operation.phase !== "approved")
      throw new RelayError(409, "Desktop redemption is in progress");
    const actor = operation.actor!;
    this.options.assertAccount(actor);
    operation.phase = "redeeming";
    try {
      const result = await this.options.sessions.issueAccountDiscovery(
        actor,
        operation.input.nonce,
        this.origin,
        operation.expiresAt,
      );
      if (
        this.operations.get(value.data.operationId) !== operation ||
        operation.expiresAt <= Math.floor(Date.now() / 1000)
      )
        throw new RelayError(403, "Desktop sign-in expired or was cancelled");
      this.assertOpen();
      this.options.assertAccount(actor);
      // Without the completion secret the sign-in may have happened anywhere, so it can only hold a request.
      return { status: "approved" as const, ...result, ...(proven ? operation.proof.take() : {}) };
    } finally {
      if (this.operations.get(value.data.operationId) === operation)
        this.operations.delete(value.data.operationId);
    }
  }
  cancel(id: string, ticket: string): void {
    this.native(id, ticket);
    this.operations.delete(id);
  }
  close(): void {
    this.closed = true;
    this.operations.clear();
  }
  private signingIn(id: string, cookieHeader: string): Operation {
    const operation = this.browser(id, cookieHeader);
    if (operation.phase !== "launched")
      throw new RelayError(409, "Desktop sign-in is no longer waiting for a sign-in");
    return operation;
  }
  /** The listener to send the browser to, unless the browser may be on another machine. */
  private loopback(operation: Operation): number | undefined {
    return operation.viaCode ? undefined : operation.input.loopbackPort;
  }
  private assertOpen(): void {
    if (this.closed) throw new RelayError(503, "Desktop sign-in is unavailable");
    this.options.assertCurrent();
  }
  private current(id: string): Operation {
    this.assertOpen();
    this.prune();
    const operation = this.operations.get(id);
    if (!operation) throw new RelayError(403, "Desktop sign-in is unavailable");
    return operation;
  }
  private native(id: string, ticket: string): Operation {
    const operation = this.current(id);
    if (!opaque.safeParse(ticket).success || !timingSafeEqual(digest(ticket), operation.nativeHash))
      throw new RelayError(403, "Desktop sign-in verification refused");
    return operation;
  }
  private browser(id: string, header: string): Operation {
    const operation = this.current(id),
      name = this.cookieName(id);
    const values = header
      .split(";")
      .map((value) => value.trim())
      .filter((value) => value.startsWith(name + "="));
    const value = values[0]?.slice(name.length + 1);
    if (
      values.length !== 1 ||
      !opaque.safeParse(value).success ||
      !operation.browserHash ||
      !timingSafeEqual(digest(value!), operation.browserHash)
    )
      throw new RelayError(403, "Desktop browser state mismatch");
    return operation;
  }
  private cookieName(id: string): string {
    return `__Host-omnesis-desktop-${id}`;
  }
  private cookie(id: string, value: string): string {
    return `${this.cookieName(id)}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${value ? 300 : 0}`;
  }
  private prune(): void {
    for (const [id, operation] of this.operations)
      if (operation.expiresAt <= Math.floor(Date.now() / 1000)) this.operations.delete(id);
  }
}
