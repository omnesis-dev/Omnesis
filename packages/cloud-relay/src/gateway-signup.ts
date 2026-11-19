// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { createLogger } from "@omnesis/core";
import { z } from "zod";
import { bindingOrigin } from "./gateway-binding.js";
import { gatewayKeyAccount } from "./gateway-key-auth.js";
import {
  OperationProof,
  type AccountOperationBroker,
  type ProofEvidence,
} from "./operation-proof.js";
import { RelayError } from "./tunnels.js";
import { LaunchTaken, launchCookie, type LaunchView } from "./browser-launch.js";
import { signInProofNonce } from "./device-enrollment.js";
import { CONNECT_PAGE_PATH, type ConnectCodes } from "./connect-codes.js";
import {
  GATEWAY_SIGNUP_PATH,
  GATEWAY_SIGNUP_PROTOCOL,
  gatewaySignupInviteCheck,
  gatewaySignupRedemption,
  gatewaySignupStart,
  gatewaySignupTranscript,
  type GatewaySignupAccess,
  type GatewaySignupDenialReason,
  type GatewaySignupIntent,
  type GatewaySignupInviteStatus,
} from "./gateway-signup-contract.js";
import { NoAccount, type AccountAdmission } from "./account-admission.js";
import { InviteRefused, type InviteVerifier, type VerifiedInvite } from "./invites.js";
import type { AccountBrowserAccount } from "./account-browser-broker.js";
import type { AccountBrowserOwner } from "./account-browser-contract.js";
import type { AccountEnrollmentAuthority } from "./account-enrollment-proof.js";
import type { RelaySessions } from "./identity.js";

const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const digest = (value: string) => createHash("sha256").update(value).digest();
/** Registration may need a certificate first; this is how long the gateway has to call `link`. */
const LINK_WINDOW_SECONDS = 900;
const COOKIE_PREFIX = "__Host-omnesis-signup-";
const log = createLogger("cloud-relay:signup");

/**
 * Who may create an account here. `closed` keeps sign-up shut; `invite` creates one account per
 * unused invite the operator signed; `open` lets anyone. Wherever sign-up is open, an account that
 * already exists may connect another gateway without an invite.
 */
export const signupPolicySchema = z.enum(["closed", "invite", "open"]);
export interface SignupConfiguration {
  policy: z.infer<typeof signupPolicySchema>;
  /** Checks invites under `invite`. */
  invites?: InviteVerifier;
}

/** Stopping one sign-in, with its record already kept on the operation for the page to show. */
export class SignupDenied extends RelayError {
  constructor() {
    super(403, "This relay is not accepting this account");
  }
}

/** What a Google sign-in brings to the policy: the account it already has, if any. */
export interface GoogleSignupIdentity {
  account?: string;
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
  /** The invite the gateway brought, checked when the sign-up started. */
  invite?: VerifiedInvite;
  denied?: {
    reason: GatewaySignupDenialReason;
    /** Refused because creating an account here needs an invite this sign-up did not bring. */
    inviteRequired?: true;
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
  readonly origin: string;
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
      inviteRedeemed(inviteId: string): boolean;
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

  /** `closed` keeps every signup route closed, so a relay opts in to this surface explicitly. */
  enabled(): boolean {
    return this.options.configuration.policy !== "closed";
  }

  /** What a gateway shows before anyone signs in: whether a new account needs an invite. */
  access(): GatewaySignupAccess | undefined {
    return this.options.configuration.policy === "invite" ? { inviteOnly: true } : undefined;
  }

  /** Whether this invite could create an account now. Checking it uses nothing up. */
  checkInvite(input: unknown): GatewaySignupInviteStatus {
    this.assertOpen();
    const parsed = gatewaySignupInviteCheck.safeParse(input);
    if (!parsed.success) throw new RelayError(400, "Invalid invite check");
    try {
      return { status: "valid", expiresAt: this.verifiedInvite(parsed.data.invite).expiresAt };
    } catch (error) {
      if (!(error instanceof InviteRefused)) throw error;
      return {
        status:
          error.reason === "invite-used"
            ? "used"
            : error.reason === "invite-expired"
              ? "expired"
              : "invalid",
      };
    }
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
      const { ownerSignature: _signature, intent: _intent, invite: _invite, ...unsigned } = request;
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
    // A bad invite is refused before anyone is sent to sign in, with the reason as its code.
    const invite =
      request.invite !== undefined && this.options.configuration.policy === "invite"
        ? this.verifiedInvite(request.invite)
        : undefined;
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
      ...(invite ? { invite } : {}),
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

  /** What opening the link shows. Read only: a link scanner's fetch must change nothing (F43). */
  peekLaunch(id: string, ticket: string, cookieHeader: string): LaunchView {
    const operation = this.ticketed(id, ticket);
    if (this.holds(id, operation, cookieHeader))
      return { state: "here", location: this.location(id) };
    // Once a browser holds it, every other one is told so, whatever stage it reached.
    return operation.phase === "created" ? { state: "open" } : { state: "taken" };
  }

  /** The Continue press on the link's page. */
  launch(id: string, ticket: string, cookieHeader: string) {
    return this.bind(id, this.ticketed(id, ticket), cookieHeader);
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
      canCreate: this.creationAllowed(operation),
      ...(operation.denied ? { denied: { ...operation.denied } } : {}),
    };
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
  }

  /** Runs after Google verifies the token and before any account exists for it. */
  authorizeGoogle(
    id: string,
    cookieHeader: string,
    google: GoogleSignupIdentity,
  ): AccountAdmission {
    const operation = this.active(id, cookieHeader);
    if (!google.account) {
      if (operation.intent !== "create") throw new NoAccount();
      if (!this.creationAllowed(operation)) {
        operation.denied = { reason: "not-allowed", ...this.inviteRequired() };
        throw new SignupDenied();
      }
    }
    return this.admission(id, cookieHeader, operation);
  }

  /** A new passkey account, when this sign-up may create one. */
  creationAdmission(id: string, cookieHeader: string): AccountAdmission | undefined {
    const operation = this.browser(id, cookieHeader);
    return this.creationAllowed(operation) &&
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
      if (!this.options.hasCapacity(operation.ownerAccountId)) {
        operation.denied = { reason: "capacity" };
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

  private creationAllowed(operation: Operation): boolean {
    const { policy } = this.options.configuration;
    return (
      policy === "open" ||
      (policy === "invite" &&
        operation.invite !== undefined &&
        !this.options.inviteRedeemed(operation.invite.id))
    );
  }
  private inviteRequired(): { inviteRequired?: true } {
    return this.options.configuration.policy === "invite" ? { inviteRequired: true } : {};
  }
  /** Checked against the invite keys, then against the invites already used here. */
  private verifiedInvite(input: string): VerifiedInvite {
    const { invites } = this.options.configuration;
    if (!invites) throw new InviteRefused("invite-invalid");
    const invite = invites.verify(input);
    if (this.options.inviteRedeemed(invite.id)) throw new InviteRefused("invite-used");
    return invite;
  }
  private admission(id: string, cookieHeader: string, operation: Operation): AccountAdmission {
    return {
      gatewayId: operation.gatewayId,
      ownerAccountId: operation.ownerAccountId,
      ...(operation.invite ? { invite: operation.invite } : {}),
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
    if (operation.code !== code) throw new RelayError(403, "Gateway signup launch refused");
    return this.bind(id, operation, cookieHeader);
  }
  private ticketed(id: string, ticket: string): Operation {
    const operation = this.current(id);
    if (!opaque.safeParse(ticket).success || !timingSafeEqual(operation.ticketHash, digest(ticket)))
      throw new RelayError(403, "Gateway signup launch refused");
    return operation;
  }
  /**
   * The first browser to open the link or enter the code keeps the sign-up, and only it may open
   * either again. Another browser is refused rather than taking it over: the link is a bearer
   * secret, and link scanners and anyone it was forwarded to would otherwise own the sign-up (F43).
   * Opening it somewhere else means starting over from the gateway.
   */
  private bind(id: string, operation: Operation, cookieHeader: string) {
    if (this.holds(id, operation, cookieHeader)) return { location: this.location(id) };
    if (operation.phase !== "created") throw new LaunchTaken();
    if (cookieHeader.split(";").filter((part) => part.trim().startsWith(COOKIE_PREFIX)).length >= 8)
      throw new RelayError(429, "Too many gateway signup requests");
    const browser = randomBytes(32).toString("base64url");
    operation.browserHash = digest(browser);
    operation.phase = "launched";
    return {
      location: this.location(id),
      cookie: this.cookie(
        id,
        browser,
        Math.max(1, operation.request.expiresAt - Math.floor(Date.now() / 1000)),
      ),
    };
  }
  private holds(id: string, operation: Operation, cookieHeader: string): boolean {
    const value = launchCookie(cookieHeader, COOKIE_PREFIX + id);
    return (
      value !== undefined &&
      opaque.safeParse(value).success &&
      operation.browserHash !== undefined &&
      timingSafeEqual(operation.browserHash, digest(value))
    );
  }
  private location(id: string): string {
    return `/_relay/account?signup=${id}`;
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
