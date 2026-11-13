// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { z } from "zod";
import { bindingOrigin } from "./gateway-binding.js";
import {
  OperationProof,
  type AccountOperationBroker,
  type ProofEvidence,
} from "./operation-proof.js";
import { RelayError } from "./tunnels.js";
import {
  ACCOUNT_BROWSER_PATH,
  ACCOUNT_BROWSER_PROTOCOL,
  accountBrowserCallback,
  accountBrowserStart,
  accountBrowserRedemption,
  accountBrowserTranscript,
  type AccountBrowserOwner,
  type AccountBrowserRequest,
} from "./account-browser-contract.js";
import type { AccountAdmission } from "./account-admission.js";
import type { AccountEnrollmentAuthority } from "./account-enrollment-proof.js";

export interface AccountBrowserAccount {
  accountId: string;
  version: number;
  sessionId: string;
}
interface Operation {
  owner: AccountBrowserOwner;
  request: AccountBrowserRequest;
  ticketHash: Buffer;
  browserHash?: Buffer;
  proof: OperationProof;
  phase: "created" | "launched" | "verifying" | "completed";
  /** Linking signs in to an account; creating one instead is the person's explicit choice. */
  intent: "create" | "existing";
  result?: { hash: Buffer; identityToken: string; account: AccountBrowserAccount };
}
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const digest = (value: string) => createHash("sha256").update(value).digest();
const secret = () => randomBytes(32).toString("base64url");

/** Gateway owner signatures and explicit account consent bind a one-time identity handoff. */
export class AccountBrowserBroker implements AccountOperationBroker {
  private readonly operations = new Map<string, Operation>();
  private readonly origin: string;
  private closed = false;
  constructor(
    private readonly options: {
      origin: string;
      authority: AccountEnrollmentAuthority;
      currentOwner(owner: string): AccountBrowserOwner | undefined;
      assertAccount(account: AccountBrowserAccount): void;
      linkedAccount(owner: string): string | undefined;
      linkAccount(account: string, owner: string): void;
      unlinkAccount(owner: string): void;
      accountCredentials(account: string): {
        google: string[];
        passkeys: { id: string; publicKey: string; countersignature?: unknown }[];
      };
      maxOperations?: number;
      maxPerOwner?: number;
    },
  ) {
    this.origin = bindingOrigin(options.origin).origin;
    this.maxOperations = options.maxOperations ?? 1024;
    this.maxPerOwner = options.maxPerOwner ?? 8;
    for (const limit of [this.maxOperations, this.maxPerOwner])
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096)
        throw new Error("Invalid account browser limits");
  }
  private readonly maxOperations: number;
  private readonly maxPerOwner: number;

  start(owner: AccountBrowserOwner & { sessionExpiresAt: number }, input: unknown) {
    this.prune();
    if (this.closed) throw new RelayError(503, "Account browser is unavailable");
    const parsed = accountBrowserStart.safeParse(input);
    if (!parsed.success) throw new RelayError(400, "Invalid account browser request");
    const request = parsed.data,
      now = Math.floor(Date.now() / 1000);
    if (owner.sessionExpiresAt <= now) throw new RelayError(401, "Gateway owner session expired");
    if (
      request.issuedAt > now + 30 ||
      request.expiresAt <= now ||
      request.expiresAt > owner.sessionExpiresAt
    )
      throw new RelayError(410, "Account browser request expired");
    if (this.operations.has(request.operationId))
      throw new RelayError(409, "Account browser request already exists");
    if (
      this.operations.size >= this.maxOperations ||
      [...this.operations.values()].filter(
        (operation) => operation.owner.ownerAccountId === owner.ownerAccountId,
      ).length >= this.maxPerOwner
    )
      throw new RelayError(429, "Account browser capacity reached");
    const { sessionExpiresAt: _expiresAt, ...context } = owner;
    this.assertOwner(context);
    try {
      const key = createPublicKey(owner.ownerPublicKey),
        signature = Buffer.from(request.ownerSignature, "base64url");
      const { ownerSignature: _signature, ...unsigned } = request;
      if (
        key.asymmetricKeyType !== "ed25519" ||
        signature.toString("base64url") !== request.ownerSignature ||
        !verify(null, accountBrowserTranscript(this.origin, context, unsigned), key, signature)
      )
        throw new Error();
    } catch {
      throw new RelayError(403, "Gateway owner signature required");
    }
    const ticket = secret();
    this.operations.set(request.operationId, {
      owner: context,
      request,
      ticketHash: digest(ticket),
      proof: new OperationProof(request.nonce),
      phase: "created",
      intent: "existing",
    });
    const authorizeUrl = new URL(ACCOUNT_BROWSER_PATH + "/begin", this.origin);
    authorizeUrl.search = new URLSearchParams({
      operationId: request.operationId,
      ticket,
    }).toString();
    return {
      protocol: ACCOUNT_BROWSER_PROTOCOL,
      operationId: request.operationId,
      authorizeUrl: authorizeUrl.href,
      expiresAt: request.expiresAt,
    };
  }

  launch(id: string, ticket: string) {
    const operation = this.current(id);
    // The link may be opened again until somebody signs in; each launch drops the previous browser.
    if (
      !(
        operation.phase === "created" ||
        (operation.phase === "launched" && operation.proof.needed())
      ) ||
      !opaque.safeParse(ticket).success ||
      !timingSafeEqual(operation.ticketHash, digest(ticket))
    )
      throw new RelayError(403, "Account browser launch refused");
    const browser = secret();
    operation.browserHash = digest(browser);
    operation.phase = "launched";
    return { location: `/_relay/account?operation=${id}`, cookie: this.cookie(operation, browser) };
  }

  describe(id: string, cookieHeader: string) {
    const operation = this.browser(id, cookieHeader);
    return {
      purpose: operation.request.purpose,
      hostname: new URL(operation.owner.publicOrigin).hostname,
      expiresAt: operation.request.expiresAt,
      needsProof: operation.proof.needed(),
      ...(operation.request.purpose === "owner-link" ? { intent: operation.intent } : {}),
    };
  }
  setIntent(id: string, cookieHeader: string, intent: "create" | "existing"): void {
    const operation = this.signingIn(id, cookieHeader);
    if (operation.request.purpose !== "owner-link")
      throw new RelayError(400, "Nothing here can create an account");
    operation.intent = intent;
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

  async confirm(id: string, cookieHeader: string, accountInput: AccountBrowserAccount) {
    const account = { ...accountInput };
    const operation = this.browser(id, cookieHeader);
    if (operation.phase !== "launched")
      throw new RelayError(409, "Account browser confirmation is already in progress");
    operation.proof.assertFrom(account.accountId);
    this.options.assertAccount(account);
    this.assertAssociation(operation, account);
    operation.phase = "verifying";
    try {
      const scope = {
        accountId: account.accountId,
        gatewayId: operation.owner.gatewayId,
        ownerAccountId: operation.owner.ownerAccountId,
        nonce: operation.request.nonce,
      };
      const expiresAt = Math.min(operation.request.expiresAt, Math.floor(Date.now() / 1000) + 300);
      const identityToken = await (operation.request.purpose === "owner-link"
        ? this.options.authority.issueGatewayLink(scope, expiresAt)
        : this.options.authority.issue(scope, expiresAt));
      if (this.current(id) !== operation)
        throw new RelayError(410, "Account browser request was replaced");
      this.options.assertAccount(account);
      this.assertAssociation(operation, account);
      if (operation.request.purpose === "owner-link")
        this.options.linkAccount(account.accountId, operation.owner.ownerAccountId);
      const result = secret();
      operation.result = { hash: digest(result), identityToken, account: { ...account } };
      operation.phase = "completed";
      const callback = accountBrowserCallback(
        operation.request.callbackUrl,
        operation.request.purpose,
      );
      callback.search = new URLSearchParams({
        operationId: id,
        result,
        state: operation.request.browserState,
      }).toString();
      return { location: callback.href, cookie: this.cookie(operation, "", true) };
    } catch (error) {
      if (this.operations.get(id) === operation) operation.phase = "launched";
      throw error;
    }
  }

  redeem(owner: AccountBrowserOwner, input: unknown) {
    const parsed = accountBrowserRedemption.safeParse(input);
    if (!parsed.success) throw new RelayError(400, "Invalid account redemption");
    const value = parsed.data,
      operation = this.current(value.operationId);
    if (
      operation.phase !== "completed" ||
      !operation.result ||
      !this.sameOwner(owner, operation.owner) ||
      !timingSafeEqual(operation.result.hash, digest(value.result)) ||
      operation.request.redemptionSha256 !== digest(value.redemptionSecret).toString("hex")
    )
      throw new RelayError(403, "Account redemption refused");
    this.options.assertAccount(operation.result.account);
    this.assertAssociation(operation, operation.result.account);
    this.operations.delete(value.operationId);
    return {
      identityToken: operation.result.identityToken,
      accountId: operation.result.account.accountId,
      ...operation.proof.take(),
    };
  }

  /**
   * The account's current sign-ins; what a gateway checks its pinned sign-ins against. Passkeys'
   * countersignatures go only to a gateway that asked for them (`ACCOUNT_CREDENTIALS_EVIDENCE`):
   * a gateway from before them parses this listing strictly and would refuse the whole of it.
   */
  credentials(owner: AccountBrowserOwner, options: { countersignatures?: boolean } = {}) {
    if (this.closed) throw new RelayError(503, "Account browser is unavailable");
    this.assertOwner(owner);
    const accountId = this.options.linkedAccount(owner.ownerAccountId);
    if (!accountId) throw new RelayError(404, "This gateway is not linked to an account");
    const { google, passkeys } = this.options.accountCredentials(accountId);
    return {
      accountId,
      google,
      passkeys: options.countersignatures
        ? passkeys
        : passkeys.map(({ countersignature: _, ...passkey }) => passkey),
    };
  }

  cancel(owner: AccountBrowserOwner, id: string): void {
    const operation = this.current(id);
    if (!this.sameOwner(owner, operation.owner))
      throw new RelayError(403, "Account cancellation refused");
    this.operations.delete(id);
  }
  close(): void {
    this.closed = true;
    this.operations.clear();
  }
  signupAdmission(id: string, cookieHeader: string): AccountAdmission | undefined {
    const operation = this.browser(id, cookieHeader);
    if (operation.request.purpose !== "owner-link" || operation.intent !== "create")
      return undefined;
    const assertCurrent = () => {
      const current = this.browser(id, cookieHeader);
      if (
        current !== operation ||
        current.phase !== "launched" ||
        this.options.linkedAccount(operation.owner.ownerAccountId) !== undefined
      )
        throw new RelayError(403, "Use an existing account or restart gateway setup");
      this.assertOwner(operation.owner);
    };
    if (this.options.linkedAccount(operation.owner.ownerAccountId) !== undefined) return undefined;
    assertCurrent();
    return {
      gatewayId: operation.owner.gatewayId,
      ownerAccountId: operation.owner.ownerAccountId,
      assertCurrent,
    };
  }
  unlink(owner: AccountBrowserOwner): void {
    if (this.closed) throw new RelayError(503, "Account browser is unavailable");
    this.assertOwner(owner);
    this.options.unlinkAccount(owner.ownerAccountId);
    for (const [id, operation] of this.operations)
      if (operation.owner.ownerAccountId === owner.ownerAccountId) this.operations.delete(id);
  }

  private signingIn(id: string, cookieHeader: string): Operation {
    const operation = this.browser(id, cookieHeader);
    if (operation.phase !== "launched")
      throw new RelayError(409, "Account browser request is no longer waiting for a sign-in");
    return operation;
  }
  private assertAssociation(operation: Operation, account: AccountBrowserAccount): void {
    const linked = this.options.linkedAccount(operation.owner.ownerAccountId);
    if (
      operation.request.purpose === "device-enrollment"
        ? linked !== account.accountId
        : linked !== undefined && linked !== account.accountId
    )
      throw new RelayError(403, "This gateway is linked to another Omnesis account");
  }
  private assertOwner(owner: AccountBrowserOwner): void {
    const current = this.options.currentOwner(owner.ownerAccountId);
    if (!current || !this.sameOwner(current, owner))
      throw new RelayError(403, "Gateway account authorization changed");
  }
  private sameOwner(a: AccountBrowserOwner, b: AccountBrowserOwner): boolean {
    return (
      a.ownerAccountId === b.ownerAccountId &&
      a.gatewayId === b.gatewayId &&
      a.publicOrigin === b.publicOrigin &&
      a.tlsSpkiFingerprint === b.tlsSpkiFingerprint &&
      a.ownerPublicKey === b.ownerPublicKey
    );
  }
  private current(id: string): Operation {
    this.prune();
    const operation = this.operations.get(id);
    if (this.closed || !operation)
      throw new RelayError(410, "Account browser request expired or was cancelled");
    this.assertOwner(operation.owner);
    return operation;
  }
  private browser(id: string, cookieHeader: string): Operation {
    const operation = this.current(id),
      prefix = `__Host-omnesis-account-operation-${id}=`;
    const values = cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith(prefix))
      .map((part) => part.slice(prefix.length));
    if (
      values.length !== 1 ||
      !opaque.safeParse(values[0]).success ||
      !operation.browserHash ||
      !timingSafeEqual(operation.browserHash, digest(values[0]!))
    )
      throw new RelayError(403, "Account browser binding required");
    return operation;
  }
  private cookie(operation: Operation, value: string, clear = false): string {
    return `__Host-omnesis-account-operation-${operation.request.operationId}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${clear ? 0 : Math.max(1, operation.request.expiresAt - Math.floor(Date.now() / 1000))}`;
  }
  private prune(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [id, operation] of this.operations)
      if (operation.request.expiresAt <= now) this.operations.delete(id);
  }
}
