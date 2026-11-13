// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { createLogger } from "@omnesis/core";
import { z } from "zod";
import { bindingOrigin } from "./gateway-binding.js";
import { gatewayKeyAccount } from "./gateway-key-auth.js";
import { readPrivateJson } from "./google-credentials.js";
import {
  OperationProof,
  type AccountOperationBroker,
  type ProofEvidence,
} from "./operation-proof.js";
import { RelayError } from "./tunnels.js";
import { signInProofNonce } from "./device-enrollment.js";
import { CONNECT_PAGE_PATH, type ConnectCodes } from "./connect-codes.js";
import {
  GATEWAY_SIGNUP_PATH,
  GATEWAY_SIGNUP_PROTOCOL,
  gatewaySignupRedemption,
  gatewaySignupStart,
  gatewaySignupTranscript,
  type GatewaySignupAccess,
  type GatewaySignupDenialReason,
  type GatewaySignupIntent,
} from "./gateway-signup-contract.js";
import { NoAccount, type AccountAdmission } from "./account-admission.js";
import type { AccountBrowserAccount } from "./account-browser-broker.js";
import type { GoogleGroupGate } from "./google-group.js";
import type { AccountBrowserOwner } from "./account-browser-contract.js";
import type { AccountEnrollmentAuthority } from "./account-enrollment-proof.js";
import type { RelaySessions } from "./identity.js";

const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const digest = (value: string) => createHash("sha256").update(value).digest();
/** Registration may need a certificate first; this is how long the gateway has to call `link`. */
const LINK_WINDOW_SECONDS = 900;
const COOKIE_PREFIX = "__Host-omnesis-signup-";
const log = createLogger("cloud-relay:signup");

export const signupPolicySchema = z.enum(["invitation", "allowlist", "open"]);
export interface SignupConfiguration {
  policy: z.infer<typeof signupPolicySchema>;
  allowlistFile?: string;
  /**
   * Under `allowlist`, a Google sign-in is also admitted when its verified email is in this group:
   * one that would create an account, or one for an account with no gateway that the allowlist
   * does not name. An account that already has a gateway, or is listed, never asks it.
   */
  googleGroup?: GoogleGroupGate;
}
const allowlistSchema = z
  .object({
    accounts: z.array(z.string().regex(/^[a-f0-9]{64}$/)).default([]),
    googleSubjects: z.array(z.string().regex(/^[a-f0-9]{64}$/)).default([]),
  })
  .strict();

/** Stopping one sign-in, with its record already kept on the operation for the page to show. */
export class SignupDenied extends RelayError {
  constructor() {
    super(403, "This relay is not accepting this account");
  }
}

/** The invitation could not be checked. Nothing is recorded, so the person may sign in again. */
export class SignupUnavailable extends RelayError {
  constructor() {
    super(503, "We couldn't check your invitation right now. Try again in a few minutes.");
  }
}

/** What a Google sign-in brings to the policy. `email` is read only when it is needed. */
export interface GoogleSignupIdentity {
  subjectDigest: string;
  account?: string;
  /** The address Google verified for this sign-in, if any. Used once and never kept. */
  email?: () => string | undefined;
}

interface Operation {
  request: z.infer<typeof gatewaySignupStart>;
  gatewayId: string;
  ownerAccountId: string;
  proof: OperationProof;
  ticketHash: Buffer;
  browserHash?: Buffer;
  code: string;
  expiresAt: number;
  phase: "created" | "launched" | "verifying" | "approved" | "redeemed" | "linking";
  /** Creating an account is the person's explicit choice; signing in never creates one. */
  intent: GatewaySignupIntent;
  googleSubject?: string;
  /** The Google subject the group admitted; approval honours it without asking Google again. */
  invited?: string;
  denied?: {
    reason: GatewaySignupDenialReason;
    googleSubject?: string;
    accountId?: string;
    /** Refused because it is not invited, so the page offers the join link. */
    inviteOnly?: true;
    /** A passkey can't show an invitation: only a Google sign-in's email can be checked. */
    googleRequired?: true;
  };
  approved?: { account: AccountBrowserAccount; enrollmentToken: string };
}

/**
 * Connecting a new gateway before it has anything on this relay. The owner key authorizes the
 * request, a fresh sign-in on this operation names the account, and only then does the operator's
 * policy decide. The gateway receives the invitation and the proof once.
 */
export class GatewaySignup implements AccountOperationBroker {
  private readonly operations = new Map<string, Operation>();
  private readonly origin: string;
  private readonly maxOperations: number;
  private readonly maxPerOwner: number;
  private closed = false;
  constructor(
    private readonly options: {
      origin: string;
      configuration: SignupConfiguration;
      authority: AccountEnrollmentAuthority;
      sessions: RelaySessions;
      codes: ConnectCodes;
      connectShortUrl?: string;
      gatewayOwner(gatewayId: string): string | undefined;
      hasCapacity(owner: string): boolean;
      hasLinkedGateway(account: string): boolean;
      assertAccount(account: AccountBrowserAccount): void;
      assertCurrent(): void;
      linkedAccount(owner: string): string | undefined;
      linkAccount(account: string, owner: string): void;
      setDisplayName(owner: string, name: string): void;
      maxOperations?: number;
      maxPerOwner?: number;
    },
  ) {
    this.origin = bindingOrigin(options.origin).origin;
    this.maxOperations = options.maxOperations ?? 256;
    this.maxPerOwner = options.maxPerOwner ?? 8;
    for (const limit of [this.maxOperations, this.maxPerOwner])
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096)
        throw new Error("Invalid gateway signup limits");
  }

  /** `invitation` keeps every signup route closed, so a relay opts in to this surface explicitly. */
  enabled(): boolean {
    return this.options.configuration.policy !== "invitation";
  }

  /**
   * What a gateway shows before anyone signs in: accounts here need approval, and where to ask
   * for it. Only an invite-only relay with a join link says anything; the link was checked when
   * the relay started.
   */
  access(): GatewaySignupAccess | undefined {
    const { policy, googleGroup } = this.options.configuration;
    return policy === "allowlist" && googleGroup?.joinUrl
      ? { inviteOnly: true, requestAccessUrl: googleGroup.joinUrl }
      : undefined;
  }

  start(input: unknown) {
    this.assertOpen();
    this.prune();
    const parsed = gatewaySignupStart.safeParse(input);
    if (!parsed.success) throw new RelayError(400, "Invalid gateway signup request");
    const request = parsed.data,
      now = Math.floor(Date.now() / 1000);
    if (request.issuedAt > now + 30 || request.expiresAt <= now)
      throw new RelayError(410, "Gateway signup request expired");
    if (this.operations.has(request.operationId))
      throw new RelayError(409, "Gateway signup request already exists");
    let ownerAccountId: string;
    try {
      const key = createPublicKey(request.ownerPublicKey),
        signature = Buffer.from(request.ownerSignature, "base64url");
      const { ownerSignature: _signature, intent: _intent, ...unsigned } = request;
      ownerAccountId = gatewayKeyAccount({
        gatewayId: request.gatewayId.toLowerCase(),
        ownerPublicKey: request.ownerPublicKey,
      });
      if (
        key.asymmetricKeyType !== "ed25519" ||
        signature.toString("base64url") !== request.ownerSignature ||
        !verify(null, gatewaySignupTranscript(this.origin, unsigned), key, signature)
      )
        throw new Error();
    } catch {
      throw new RelayError(403, "Gateway owner signature required");
    }
    const gatewayId = request.gatewayId.toLowerCase();
    this.assertOwnerFree(gatewayId, ownerAccountId);
    if (!this.options.hasCapacity(ownerAccountId))
      throw new RelayError(503, "This relay has no room for more gateways");
    if (
      this.operations.size >= this.maxOperations ||
      [...this.operations.values()].filter((value) => value.ownerAccountId === ownerAccountId)
        .length >= this.maxPerOwner
    )
      throw new RelayError(429, "Gateway signup capacity reached");
    const id = request.operationId,
      ticket = randomBytes(32).toString("base64url");
    const code: string = this.options.codes.issue(request.expiresAt, (cookie) =>
      this.claim(id, code, cookie),
    );
    this.operations.set(id, {
      request,
      gatewayId,
      ownerAccountId,
      // Whoever starts a sign-up picks its nonce, so its sign-in can only ever link a gateway.
      proof: new OperationProof(signInProofNonce("gateway-link", request.nonce)),
      ticketHash: digest(ticket),
      code,
      expiresAt: request.expiresAt,
      phase: "created",
      intent: request.intent,
    });
    const authorizeUrl = new URL(GATEWAY_SIGNUP_PATH + "/begin", this.origin);
    authorizeUrl.search = new URLSearchParams({ operationId: id, ticket }).toString();
    return {
      protocol: GATEWAY_SIGNUP_PROTOCOL,
      operationId: id,
      authorizeUrl: authorizeUrl.href,
      connectUrl: new URL(CONNECT_PAGE_PATH, this.origin).href,
      ...(this.options.connectShortUrl ? { connectShortUrl: this.options.connectShortUrl } : {}),
      code,
      expiresAt: request.expiresAt,
    };
  }

  launch(id: string, ticket: string, cookieHeader: string) {
    const operation = this.current(id);
    if (
      !this.launchable(operation) ||
      !opaque.safeParse(ticket).success ||
      !timingSafeEqual(operation.ticketHash, digest(ticket))
    )
      throw new RelayError(403, "Gateway signup launch refused");
    return this.bind(id, operation, cookieHeader);
  }

  describe(id: string, cookieHeader: string) {
    const operation = this.browser(id, cookieHeader);
    return {
      purpose: "gateway-signup" as const,
      gatewayName: operation.request.displayName ?? "Your gateway",
      code: operation.code,
      expiresAt: operation.request.expiresAt,
      needsProof: operation.proof.needed(),
      intent: operation.intent,
      ...(operation.denied ? { denied: this.deniedView(operation.denied) } : {}),
    };
  }
  /**
   * A Google sign-in here must carry its email when a group decides: who signs in, and whether
   * their account needs the invitation, is only known once Google answers.
   */
  requestsEmail(id: string, cookieHeader: string): boolean {
    this.active(id, cookieHeader);
    return this.options.configuration.googleGroup !== undefined;
  }
  setIntent(id: string, cookieHeader: string, intent: GatewaySignupIntent): void {
    this.active(id, cookieHeader).intent = intent;
  }
  proofCommitment(id: string, cookieHeader: string) {
    return this.active(id, cookieHeader).proof.commitment();
  }
  googleProofNonce(id: string, cookieHeader: string) {
    return this.active(id, cookieHeader).proof.googleNonce();
  }
  recordProof(id: string, cookieHeader: string, evidence: ProofEvidence): void {
    const operation = this.active(id, cookieHeader);
    operation.proof.record(evidence);
    if (evidence.type !== "google") operation.googleSubject = operation.invited = undefined;
  }

  /** Runs after Google verifies the token and before any account exists for it. */
  async authorizeGoogle(
    id: string,
    cookieHeader: string,
    google: GoogleSignupIdentity,
  ): Promise<AccountAdmission> {
    const operation = this.active(id, cookieHeader);
    if (!google.account && operation.intent !== "create") throw new NoAccount();
    let allowed = await this.allowed(google.subjectDigest, google.account);
    // The allowlist, and an account's linked gateway, answer first; the group is asked otherwise.
    const group = this.options.configuration.googleGroup;
    let invited = false;
    if (!allowed && group) {
      this.active(id, cookieHeader);
      invited = allowed = await this.invited(group, google.email?.());
    }
    // A restarted operation has a new browser secret, so this also refuses a replacement.
    this.active(id, cookieHeader);
    if (!allowed) {
      operation.denied = {
        reason: "not-allowed",
        googleSubject: google.subjectDigest,
        ...(group ? { inviteOnly: true as const } : {}),
      };
      throw new SignupDenied();
    }
    operation.googleSubject = google.subjectDigest;
    operation.invited = invited ? google.subjectDigest : undefined;
    return this.admission(id, cookieHeader, operation);
  }

  /** A passkey names an existing account. False means the refusal is on the operation. */
  async authorizeAccount(id: string, cookieHeader: string, accountId: string): Promise<boolean> {
    const operation = this.active(id, cookieHeader);
    const allowed = await this.allowed(undefined, accountId);
    this.active(id, cookieHeader);
    if (!allowed) operation.denied = { reason: "not-allowed", accountId, ...this.googleRequired() };
    return allowed;
  }

  /** Only `open` admits a passkey account: otherwise nothing yet identifies who is signing up. */
  creationAdmission(id: string, cookieHeader: string): AccountAdmission | undefined {
    const operation = this.browser(id, cookieHeader);
    return this.options.configuration.policy === "open" &&
      operation.intent === "create" &&
      operation.phase === "launched" &&
      !operation.denied
      ? this.admission(id, cookieHeader, operation)
      : undefined;
  }

  async confirm(id: string, cookieHeader: string, accountInput: AccountBrowserAccount) {
    const account = { ...accountInput },
      operation = this.active(id, cookieHeader);
    this.options.assertAccount(account);
    operation.proof.assertFrom(account.accountId);
    operation.phase = "verifying";
    try {
      // The operator may have edited the policy since sign-in, and each check reads it afresh. A
      // group invitation was checked moments ago for this very sign-in and is not asked again.
      const allowed =
        (operation.invited !== undefined && operation.invited === operation.googleSubject) ||
        (await this.allowed(operation.googleSubject, account.accountId));
      this.unchanged(id, operation);
      const reason: GatewaySignupDenialReason | undefined = !allowed
        ? "not-allowed"
        : !this.options.hasCapacity(operation.ownerAccountId)
          ? "capacity"
          : undefined;
      if (reason) {
        operation.denied = {
          reason,
          accountId: account.accountId,
          googleSubject: operation.googleSubject,
          // Without a Google sign-in on the operation, the group could not be asked.
          ...(reason === "not-allowed" && operation.googleSubject === undefined
            ? this.googleRequired()
            : {}),
        };
        throw new SignupDenied();
      }
      this.assertOwnerFree(operation.gatewayId, operation.ownerAccountId);
      const enrollmentToken = await this.options.sessions.issueEnrollmentInvitation(
        operation.gatewayId,
        this.origin,
      );
      this.unchanged(id, operation);
      this.options.assertAccount(account);
      operation.approved = { account, enrollmentToken };
      operation.phase = "approved";
      operation.expiresAt = Math.floor(Date.now() / 1000) + LINK_WINDOW_SECONDS;
      return {
        location: new URL(GATEWAY_SIGNUP_PATH + "/complete", this.origin).href,
        cookie: this.cookie(id, "", 0),
      };
    } catch (error) {
      if (this.operations.get(id) === operation) operation.phase = "launched";
      throw error;
    }
  }

  poll(input: unknown) {
    const operation = this.redemption(input);
    if (operation.denied) return { status: "denied" as const, reason: operation.denied.reason };
    if (operation.phase === "approved") {
      const { account, enrollmentToken } = operation.approved!;
      this.options.assertAccount(account);
      operation.phase = "redeemed";
      return {
        status: "approved" as const,
        enrollmentToken,
        accountId: account.accountId,
        ...operation.proof.take(),
      };
    }
    if (operation.phase === "redeemed" || operation.phase === "linking")
      throw new RelayError(409, "Gateway signup was already collected");
    return { status: "pending" as const, expiresAt: operation.request.expiresAt };
  }

  async link(owner: AccountBrowserOwner, input: unknown) {
    const operation = this.redemption(input),
      id = operation.request.operationId;
    if (operation.phase !== "redeemed")
      throw new RelayError(409, "Gateway signup is not ready to link");
    if (
      owner.ownerAccountId !== operation.ownerAccountId ||
      owner.gatewayId !== operation.gatewayId
    )
      throw new RelayError(403, "Gateway signup belongs to another gateway");
    const { account } = operation.approved!;
    this.assertLinkable(operation, account);
    operation.phase = "linking";
    try {
      const identityToken = await this.options.authority.issueGatewayLink({
        accountId: account.accountId,
        gatewayId: operation.gatewayId,
        ownerAccountId: operation.ownerAccountId,
        nonce: operation.request.nonce,
      });
      this.unchanged(id, operation);
      this.assertLinkable(operation, account);
      this.options.linkAccount(account.accountId, operation.ownerAccountId);
      if (operation.request.displayName)
        this.options.setDisplayName(operation.ownerAccountId, operation.request.displayName);
      this.operations.delete(id);
      return { identityToken, accountId: account.accountId };
    } catch (error) {
      if (this.operations.get(id) === operation) operation.phase = "redeemed";
      throw error;
    }
  }

  cancel(input: unknown): void {
    this.operations.delete(this.redemption(input).request.operationId);
  }
  close(): void {
    this.closed = true;
    this.operations.clear();
  }

  private async allowed(googleSubject: string | undefined, accountId: string | undefined) {
    const { policy, allowlistFile } = this.options.configuration;
    if (policy === "open") return true;
    if (accountId !== undefined && this.options.hasLinkedGateway(accountId)) return true;
    if (!allowlistFile) return false;
    try {
      const list = allowlistSchema.parse(await readPrivateJson(allowlistFile));
      return (
        (googleSubject !== undefined && list.googleSubjects.includes(googleSubject)) ||
        (accountId !== undefined && list.accounts.includes(accountId))
      );
    } catch {
      return false;
    }
  }
  /** Fails closed: an answer Google could not give refuses the sign-up, and leaves it to retry. */
  private async invited(group: GoogleGroupGate, email: string | undefined): Promise<boolean> {
    if (email === undefined) {
      log.info("A Google sign-up without a verified email was refused without asking the group");
      return false;
    }
    try {
      return await group.isMember(email);
    } catch {
      // The gate has logged why, without the address.
      throw new SignupUnavailable();
    }
  }
  private deniedView(denied: NonNullable<Operation["denied"]>) {
    const joinUrl =
      denied.inviteOnly || denied.googleRequired
        ? this.options.configuration.googleGroup?.joinUrl
        : undefined;
    return { ...denied, ...(joinUrl ? { joinUrl } : {}) };
  }
  private googleRequired(): { googleRequired?: true } {
    return this.options.configuration.googleGroup ? { googleRequired: true } : {};
  }
  private admission(id: string, cookieHeader: string, operation: Operation): AccountAdmission {
    return {
      gatewayId: operation.gatewayId,
      ownerAccountId: operation.ownerAccountId,
      assertCurrent: () => {
        this.active(id, cookieHeader);
        this.assertOwnerFree(operation.gatewayId, operation.ownerAccountId);
      },
    };
  }
  /** Cancelling and restarting the same signed request must not let a late result land on it. */
  private unchanged(id: string, operation: Operation): void {
    if (this.current(id) !== operation) throw new RelayError(410, "Gateway signup was replaced");
  }
  private assertOwnerFree(gatewayId: string, ownerAccountId: string): void {
    const owner = this.options.gatewayOwner(gatewayId);
    if (owner !== undefined && owner !== ownerAccountId)
      throw new RelayError(409, "This gateway ID belongs to another owner");
  }
  private assertLinkable(operation: Operation, account: AccountBrowserAccount): void {
    this.options.assertAccount(account);
    const linked = this.options.linkedAccount(operation.ownerAccountId);
    if (linked !== undefined && linked !== account.accountId)
      throw new RelayError(403, "This gateway is linked to another Omnesis account");
  }
  /** A restarted request has a new code, so the old one must not open its replacement. */
  private claim(id: string, code: string, cookieHeader: string) {
    const operation = this.current(id);
    if (operation.code !== code || !this.launchable(operation))
      throw new RelayError(403, "Gateway signup launch refused");
    return this.bind(id, operation, cookieHeader);
  }
  /**
   * The link or the code may be opened again until somebody signs in: a closed tab or a second
   * device must not strand the request. Each launch binds a new browser and drops the previous one.
   * Once a sign-in or a refusal is on the operation, only the browser that made it may continue.
   */
  private launchable(operation: Operation): boolean {
    return (
      operation.phase === "created" ||
      (operation.phase === "launched" &&
        operation.proof.needed() &&
        operation.googleSubject === undefined &&
        !operation.denied)
    );
  }
  private bind(id: string, operation: Operation, cookieHeader: string) {
    if (cookieHeader.split(";").filter((part) => part.trim().startsWith(COOKIE_PREFIX)).length >= 8)
      throw new RelayError(429, "Too many gateway signup requests");
    const browser = randomBytes(32).toString("base64url");
    operation.browserHash = digest(browser);
    operation.phase = "launched";
    return {
      location: `/_relay/account?signup=${id}`,
      cookie: this.cookie(
        id,
        browser,
        Math.max(1, operation.request.expiresAt - Math.floor(Date.now() / 1000)),
      ),
    };
  }
  private redemption(input: unknown): Operation {
    const parsed = gatewaySignupRedemption.safeParse(input);
    if (!parsed.success) throw new RelayError(400, "Invalid gateway signup request");
    const operation = this.current(parsed.data.operationId);
    if (
      !timingSafeEqual(
        Buffer.from(operation.request.redemptionSha256),
        Buffer.from(digest(parsed.data.redemptionSecret).toString("hex")),
      )
    )
      throw new RelayError(403, "Gateway signup redemption refused");
    return operation;
  }
  private active(id: string, cookieHeader: string): Operation {
    const operation = this.browser(id, cookieHeader);
    if (operation.phase !== "launched" || operation.denied)
      throw new RelayError(409, "Gateway signup is no longer waiting for a sign-in");
    return operation;
  }
  private browser(id: string, header: string): Operation {
    const operation = this.current(id),
      name = COOKIE_PREFIX + id + "=";
    const values = header
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith(name))
      .map((part) => part.slice(name.length));
    if (
      values.length !== 1 ||
      !opaque.safeParse(values[0]).success ||
      !operation.browserHash ||
      !timingSafeEqual(operation.browserHash, digest(values[0]!))
    )
      throw new RelayError(403, "Gateway signup browser binding required");
    return operation;
  }
  private current(id: string): Operation {
    this.assertOpen();
    this.prune();
    const operation = this.operations.get(id);
    if (!operation) throw new RelayError(410, "Gateway signup expired or was cancelled");
    return operation;
  }
  private assertOpen(): void {
    if (this.closed) throw new RelayError(503, "Gateway signup is unavailable");
    this.options.assertCurrent();
  }
  private cookie(id: string, value: string, maxAge: number): string {
    return `${COOKIE_PREFIX}${id}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
  }
  private prune(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [id, operation] of this.operations)
      if (operation.expiresAt <= now) this.operations.delete(id);
  }
}
