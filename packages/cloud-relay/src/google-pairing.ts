// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  approvalDeviceTranscript,
  deviceSignatureSchema,
  devicePublicKeySchema,
  deviceKeyEvidenceSchema,
  enrollmentNonce,
  enrollmentOpaque,
  enrollmentProofSchema,
  enrollmentSignatureTranscript,
  gatewayPasskeyApprovalBinding,
  gatewayPasskeyChallenge,
  gatewayPasskeySignInProofSchema,
  pairingComparisonCode,
  verifyDeviceSignature,
  type GatewayPasskeySignInProof,
  type SignInProof,
} from "./device-enrollment.js";
import { accountId, type IdentityProvider } from "./identity.js";
import { RelayError } from "./tunnels.js";
import { EnrollmentChallenges } from "./enrollment-challenges.js";
import type { TrustedSignInSource, VerifiedSignIn } from "./gateway-sign-in-proof.js";
import type { GatewayPasskeyCeremony } from "./gateway-account-link.js";

export const googlePairingRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    kind: z.enum(["ios", "android", "collector", "cli", "portal"]),
    name: z.string().trim().min(1).max(80),
    secret: z.string().regex(/^[a-f0-9]{64}$/),
    identityToken: z.string().min(1).max(16_384).optional(),
    /** The gateway challenge this request answers, when it carries no device key to name it. */
    challenge: enrollmentOpaque.optional(),
    deviceKey: deviceKeyEvidenceSchema.optional(),
    proof: enrollmentProofSchema.optional(),
    requireApproval: z.boolean().optional(),
  })
  .strict()
  .refine((value) => !(value.challenge && value.deviceKey), "A request names one challenge");
export type GooglePairingRequest = z.infer<typeof googlePairingRequestSchema>;
type RequestIdentity = Pick<GooglePairingRequest, "requestId" | "kind" | "name" | "secret">;
export type EnrollmentPolicy = "automatic" | "ask";
export interface PairingEnrollment {
  method: "automatic" | "approved";
  signIn?: "google" | "passkey";
  /** The verified sign-in's id, as the gateway's trusted sign-ins name it. */
  signInId?: string;
  devicePublicKey: string;
}

/** The gateway-local decisions behind sign-in enrollment. Nothing here is supplied by the relay. */
export interface GatewayEnrollment {
  policy(): EnrollmentPolicy;
  spkiFingerprint(): string | undefined;
  challenges: EnrollmentChallenges;
  /** Verifies a sign-in made for `device-enrollment` on `nonce`; any other purpose fails. */
  verifyProof(
    proof: SignInProof,
    nonce: string,
    credentialPublicKey?: string,
  ): Promise<VerifiedSignIn | undefined>;
  /** Whether approving may pin this sign-in. False whenever that can't be checked. */
  canTrust(signIn: VerifiedSignIn): Promise<boolean>;
  trustSignIn(signIn: VerifiedSignIn, source: TrustedSignInSource): Promise<void>;
  /**
   * A passkey assertion made on the gateway's own page for `device-enrollment`, over the request's
   * own gateway challenge and its enrollment nonce. Undefined when it does not verify.
   */
  verifyGatewayPasskey?(
    proof: GatewayPasskeySignInProof,
    challenge: string,
    nonce: string,
  ): Promise<VerifiedSignIn | undefined>;
  /**
   * Where a page runs a passkey ceremony on this gateway: the relay's host as RP ID and the
   * gateway's own origin. Undefined when the gateway has no origin of its own to vouch for.
   */
  gatewayPasskey?(): { rpId: string; origin: string } | undefined;
  /** An `approve-request` ceremony for `binding`, or undefined without an origin of its own. */
  approvalCeremony?(binding: string): GatewayPasskeyCeremony | undefined;
  /** Whether a passkey the owner confirmed here signed that ceremony. Spends its challenge. */
  verifyApproval?(proof: unknown, binding: string): Promise<boolean>;
}

/** A person approving a held request with a passkey on the gateway's own page. */
export const passkeyApprovalSchema = z
  .object({
    requestId: z.string().uuid(),
    proof: gatewayPasskeySignInProofSchema,
    trustSignIn: z.boolean().optional(),
    /** The requesting browser's own signature, required for a portal's request. */
    deviceSignature: deviceSignatureSchema.optional(),
  })
  .strict();

/** What a device sends to start a passkey sign-in on the gateway's own page. */
export const gatewayPasskeyOptionsSchema = z
  .object({
    requestId: z.string().uuid(),
    kind: z.enum(["ios", "android", "collector", "cli", "portal"]),
    name: z.string().trim().min(1).max(80),
    secret: z.string().regex(/^[a-f0-9]{64}$/),
    devicePublicKey: devicePublicKeySchema,
  })
  .strict();
const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/** A stolen routing ID token cannot be replayed without the client's private random secret. */
export function googlePairingNonce(value: RequestIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "omnesis-device-pairing-v2",
        value.requestId,
        value.kind,
        value.name,
        digest(value.secret).toString("hex"),
      ]),
    )
    .digest("base64url");
}

interface Pending {
  requestId: string;
  kind: GooglePairingRequest["kind"];
  name: string;
  secretHash: Buffer;
  verificationCode: string;
  codeNonce: string;
  gatewayFingerprint: string;
  createdAt: number;
  expiresAt: number;
  state: "verifying" | "pending" | "approving" | "approved" | "denied";
  pairingCode?: string;
  decision?: Promise<void>;
  devicePublicKey?: string;
  signIn?: VerifiedSignIn;
  /** Decided once the request is held: approving may also pin `signIn`. */
  trustable?: boolean;
  approvedByPerson?: boolean;
  /** Its device key belongs to a device the owner revoked. */
  revokedDevice?: boolean;
}
interface HeldProof {
  identityToken: string;
  proof?: SignInProof;
  credentialPublicKey?: string;
  expiresAt: number;
}
const HELD_PROOF_TTL_MS = 600_000;
const MAX_HELD_PROOFS = 32;
/**
 * How many requests may wait for a person at once. Each shows an independent six-digit code, so
 * this is how many chances a forger has that one of its own requests shows the code a person
 * is looking for: 8 in 1,000,000 for as long as a request lives.
 */
const MAX_AWAITING_APPROVAL = 8;

/** Gateway-only approval. Google identifies a request; the owner still chooses every grant. */
export class GooglePairingRequests {
  private readonly requests = new Map<string, Pending>();
  private readonly held = new Map<string, HeldProof>();
  private readonly challenges: EnrollmentChallenges;
  constructor(
    private readonly options: {
      identity: IdentityProvider;
      ownerAccountId: string;
      gatewayFingerprint: () => string;
      enrollment?: GatewayEnrollment;
      createPairing(request: {
        kind: GooglePairingRequest["kind"];
        name: string;
        expiresAt: number;
        enrollment?: PairingEnrollment;
      }): Promise<{ pairingCode: string; expiresAt: number }>;
      onPending?(request: { requestId: string; expiresAt: number }): void | Promise<void>;
      /**
       * Whether the owner revoked a device that signed in with this key. Such a request never
       * joins automatically; a person approves it again.
       */
      revokedDeviceKey?(devicePublicKey: string): boolean | Promise<boolean>;
      ttlMs?: number;
      maxPending?: number;
      maxAwaitingApproval?: number;
    },
  ) {
    this.challenges = options.enrollment?.challenges ?? new EnrollmentChallenges();
    for (const value of [
      options.ttlMs ?? 600_000,
      options.maxPending ?? 32,
      options.maxAwaitingApproval ?? MAX_AWAITING_APPROVAL,
    ])
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
        throw new Error("Invalid Google pairing limits");
    if (!/^[a-f0-9]{64}$/.test(options.ownerAccountId)) throw new Error("Invalid owner account");
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(options.gatewayFingerprint());
  }

  /** A browser's redirect delivers its sign-in before the page can sign, so the gateway keeps it briefly. */
  holdProof(requestId: string, value: Omit<HeldProof, "expiresAt">): void {
    this.prune();
    while (this.held.size >= MAX_HELD_PROOFS) this.held.delete(this.held.keys().next().value!);
    this.held.set(requestId, { ...value, expiresAt: Date.now() + HELD_PROOF_TTL_MS });
  }

  /**
   * Issues the one-use challenge every request answers. It commits this gateway to the nonce
   * behind the request's comparison code, and a device key signs it.
   */
  issueChallenge(): { challenge: string; expiresAt: number } {
    return this.challenges.issue();
  }

  /**
   * Starts a passkey sign-in on the gateway's own page for a request the device is about to send:
   * the request's one-use challenge, with the WebAuthn challenge bound to its enrollment nonce.
   * The device signs for the same challenge and sends the assertion with its request.
   */
  passkeyCeremony(input: unknown): GatewayPasskeyCeremony {
    const value = gatewayPasskeyOptionsSchema.parse(input);
    const where = this.gatewayPasskey();
    if (!where) throw new RelayError(404, "Passkey sign-in on this gateway is unavailable");
    const binding = enrollmentNonce(value);
    const issued = this.challenges.issue();
    return {
      purpose: "device-enrollment",
      ...where,
      challenge: issued.challenge,
      binding,
      webauthnChallenge: gatewayPasskeyChallenge(
        "device-enrollment",
        where.origin,
        issued.challenge,
        binding,
      ),
      expiresAt: issued.expiresAt,
    };
  }

  /** A held request as the approval page shows it: what it is, its code and how long it waits. */
  approvalView(requestId: string) {
    const row = this.waiting(requestId);
    return {
      requestId: row.requestId,
      kind: row.kind,
      name: row.name,
      verificationCode: row.verificationCode,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      ...(row.signIn ? { signIn: row.signIn.type } : {}),
      ...(row.revokedDevice ? { revokedDevice: true as const } : {}),
      // A portal's request is approved only in the browser that made it.
      deviceKeyRequired: row.kind === "portal",
    };
  }

  /** Starts approving a held request with a passkey on the gateway's own page. */
  approvalCeremony(requestId: string): GatewayPasskeyCeremony {
    const ceremony = this.options.enrollment?.approvalCeremony?.(
      this.approvalBinding(this.waiting(requestId)),
    );
    if (!ceremony) throw new RelayError(404, "Passkey approval on this gateway is unavailable");
    return ceremony;
  }

  /**
   * Approves a held request on a passkey the owner confirmed on this gateway, signed on its own
   * page for exactly this request, device key and code. A portal's request also needs the
   * requesting browser's own signature.
   */
  async approveWithPasskey(input: unknown): Promise<void> {
    const value = passkeyApprovalSchema.parse(input);
    const row = this.waiting(value.requestId);
    if (
      row.kind === "portal" &&
      !(
        row.devicePublicKey &&
        value.deviceSignature &&
        verifyDeviceSignature(
          row.devicePublicKey,
          approvalDeviceTranscript({ requestId: row.requestId, challenge: value.proof.challenge }),
          value.deviceSignature,
        )
      )
    )
      throw new RelayError(403, "Approve this request in the browser that asked to join");
    if (!(await this.options.enrollment?.verifyApproval?.(value.proof, this.approvalBinding(row))))
      throw new RelayError(403, "Passkey approval refused");
    await this.decide(row.requestId, true, {
      ...(value.trustSignIn === undefined ? {} : { trustSignIn: value.trustSignIn }),
    });
  }

  private waiting(requestId: string): Pending {
    this.prune();
    const row = this.requests.get(requestId);
    if (!row || row.state !== "pending") throw new RelayError(404, "Pairing request not found");
    return row;
  }

  private approvalBinding(row: Pending): string {
    return gatewayPasskeyApprovalBinding({
      requestId: row.requestId,
      ...(row.devicePublicKey ? { devicePublicKey: row.devicePublicKey } : {}),
      verificationCode: row.verificationCode,
    });
  }

  /** The origin and RP ID a page uses for a passkey sign-in on this gateway, when it has one. */
  gatewayPasskey(): { rpId: string; origin: string } | undefined {
    return this.options.enrollment?.gatewayPasskey?.();
  }

  /** A request a device sends. Its code nonce is the one the answered challenge committed to. */
  async start(input: unknown): Promise<ReturnType<GooglePairingRequests["poll"]>> {
    return this.begin(googlePairingRequestSchema.parse(input), false);
  }

  /**
   * A request this gateway starts for a browser returning from sign-in. The browser runs the
   * gateway's own page over a connection it verified itself, so its code only tells requests
   * apart and needs no commitment.
   */
  async startForBrowser(input: unknown): Promise<ReturnType<GooglePairingRequests["poll"]>> {
    return this.begin(googlePairingRequestSchema.parse(input), true);
  }

  private async begin(
    value: GooglePairingRequest,
    browser: boolean,
  ): Promise<ReturnType<GooglePairingRequests["poll"]>> {
    this.prune();
    const previous = this.requests.get(value.requestId);
    if (previous) {
      if (previous.kind !== value.kind || previous.name !== value.name)
        throw new RelayError(409, "Pairing request already exists");
      return this.poll(value.requestId, value.secret);
    }
    if (this.requests.size >= (this.options.maxPending ?? 32))
      throw new RelayError(429, "Too many pending pairing requests");
    // Spending the challenge is what reveals its nonce, so nothing is revealed for a request
    // that is refused, and one challenge can never produce two codes.
    const codeNonce = browser
      ? randomBytes(32).toString("base64url")
      : this.challenges.take(value.deviceKey?.challenge ?? value.challenge ?? "");
    if (!codeNonce) throw new RelayError(409, "Enrollment challenge expired; start again");
    const devicePublicKey = this.checkDeviceKey(value);
    const held = this.held.get(value.requestId);
    this.held.delete(value.requestId);
    const identityToken = value.identityToken ?? held?.identityToken;
    const proof = value.proof ?? held?.proof;
    // A passkey assertion made on the gateway's page answers this request's own challenge.
    const gatewayPasskey = proof?.type === "gateway-passkey" ? proof : undefined;
    if (
      gatewayPasskey &&
      (!devicePublicKey || gatewayPasskey.challenge !== value.deviceKey!.challenge)
    )
      throw new RelayError(403, "A gateway passkey sign-in answers its own request's challenge");
    const fingerprint = this.options.gatewayFingerprint();
    const request: Pending = {
      requestId: value.requestId,
      name: value.name,
      kind: value.kind,
      secretHash: digest(value.secret),
      createdAt: Date.now(),
      verificationCode: pairingComparisonCode({
        requestId: value.requestId,
        secret: value.secret,
        gatewayFingerprint: fingerprint,
        codeNonce,
      }),
      codeNonce,
      gatewayFingerprint: fingerprint,
      expiresAt: Date.now() + (this.options.ttlMs ?? 600_000),
      state: "verifying",
      ...(devicePublicKey ? { devicePublicKey } : {}),
    };
    this.requests.set(value.requestId, request);
    try {
      const nonce = devicePublicKey
        ? enrollmentNonce({ ...value, devicePublicKey })
        : googlePairingNonce(value);
      if (gatewayPasskey) {
        request.signIn = await this.options.enrollment!.verifyGatewayPasskey?.(
          gatewayPasskey,
          gatewayPasskey.challenge,
          nonce,
        );
        // It was made on this gateway's own page with a key the gateway chose, so nothing else
        // can stand in for it: a passkey assertion that does not verify is refused outright.
        if (!request.signIn) throw new RelayError(401, "Sign-in could not be verified");
      } else if (devicePublicKey && proof)
        // Not a gateway passkey here, so a relay-page or app sign-in.
        request.signIn = await this.options.enrollment!.verifyProof(
          proof as SignInProof,
          nonce,
          held?.credentialPublicKey,
        );
      // Revoking a device must stick: its key waits for a person, even with a trusted sign-in.
      // A check that fails counts as revoked.
      if (devicePublicKey && this.options.revokedDeviceKey)
        request.revokedDevice = await Promise.resolve()
          .then(() => this.options.revokedDeviceKey!(devicePublicKey))
          .catch(() => true);
      if (request.expiresAt <= Date.now() || this.requests.get(value.requestId) !== request)
        throw new RelayError(404, "Pairing request expired");
      if (
        !request.revokedDevice &&
        request.signIn?.trusted &&
        this.options.enrollment!.policy() === "automatic" &&
        !value.requireApproval
      ) {
        // Only here does a request join without a person, and only on the gateway's own checks.
        await this.approve(request);
        return this.poll(value.requestId, value.secret);
      }
      // A verified assertion on the gateway's own page, against a key the account lists, says at
      // least as much as the relay's attestation; anything else needs the relay's word.
      if (!gatewayPasskey) await this.admit(identityToken, nonce);
      if (request.signIn)
        request.trustable = await this.options
          .enrollment!.canTrust(request.signIn)
          .catch(() => false);
      if (request.expiresAt <= Date.now() || this.requests.get(value.requestId) !== request)
        throw new RelayError(404, "Pairing request expired");
      let awaiting = 0;
      for (const row of this.requests.values())
        if (row.state === "pending" || row.state === "approving") awaiting++;
      if (awaiting >= (this.options.maxAwaitingApproval ?? MAX_AWAITING_APPROVAL))
        throw new RelayError(429, "Too many pairing requests are waiting for approval");
      request.state = "pending";
      const result = this.poll(value.requestId, value.secret);
      // Notification delivery never grants access or invalidates an admitted request.
      try {
        void Promise.resolve(
          this.options.onPending?.({ requestId: request.requestId, expiresAt: request.expiresAt }),
        ).catch(() => undefined);
      } catch {
        /* Approval remains available through the trusted device list. */
      }
      return result;
    } catch (error) {
      if (this.requests.get(value.requestId) === request) this.requests.delete(value.requestId);
      throw error;
    }
  }

  /** A device key that fails here was meant for another gateway, so the request stops outright. */
  private checkDeviceKey(value: GooglePairingRequest): string | undefined {
    if (!value.deviceKey) return undefined;
    const enrollment = this.options.enrollment;
    if (!enrollment) throw new RelayError(404, "Sign-in enrollment is unavailable");
    const spki = enrollment.spkiFingerprint();
    if (
      !spki ||
      !verifyDeviceSignature(
        value.deviceKey.publicKey,
        enrollmentSignatureTranscript({
          requestId: value.requestId,
          kind: value.kind,
          name: value.name,
          gatewaySpkiFingerprint: spki,
          challenge: value.deviceKey.challenge,
          devicePublicKey: value.deviceKey.publicKey,
        }),
        value.deviceKey.signature,
      )
    )
      throw new RelayError(403, "Device signature does not name this gateway");
    return value.deviceKey.publicKey;
  }

  /** The relay's or Google's word that this is the owner. It admits a request for a person to review. */
  private async admit(token: string | undefined, nonce: string): Promise<void> {
    if (!token) throw new RelayError(401, "Sign-in required");
    const identity = await this.options.identity.verify(token, nonce);
    if (accountId(identity) !== this.options.ownerAccountId)
      throw new RelayError(403, "Identity does not match the gateway owner");
  }

  private async approve(row: Pending): Promise<void> {
    row.state = "approving";
    try {
      const result = await this.options.createPairing({
        kind: row.kind,
        name: row.name,
        expiresAt: row.expiresAt,
        ...(row.devicePublicKey
          ? {
              enrollment: {
                method: row.approvedByPerson ? ("approved" as const) : ("automatic" as const),
                ...(row.signIn ? { signIn: row.signIn.type, signInId: row.signIn.id } : {}),
                devicePublicKey: row.devicePublicKey,
              },
            }
          : {}),
      });
      if (row.expiresAt <= Date.now() || this.requests.get(row.requestId) !== row)
        throw new RelayError(404, "Pairing request expired");
      row.pairingCode = result.pairingCode;
      row.expiresAt = Math.min(row.expiresAt, result.expiresAt);
      row.state = "approved";
    } catch (error) {
      row.state = "pending";
      throw error;
    }
  }

  poll(
    requestId: string,
    secret: string,
  ): {
    status: "pending" | "approved" | "denied";
    verificationCode: string;
    codeNonce: string;
    expiresAt: number;
    pairingCode?: string;
  } {
    this.prune();
    const row = this.requests.get(requestId);
    if (!row || row.state === "verifying" || !timingSafeEqual(row.secretHash, digest(secret)))
      throw new RelayError(404, "Pairing request not found");
    const status = row.state === "approving" ? "pending" : row.state;
    return {
      status,
      verificationCode: row.verificationCode,
      codeNonce: row.codeNonce,
      expiresAt: row.expiresAt,
      ...(row.state === "approved" ? { pairingCode: row.pairingCode! } : {}),
    };
  }

  list(): Array<{
    requestId: string;
    kind: GooglePairingRequest["kind"];
    name: string;
    status: string;
    verificationCode: string;
    expiresAt: number;
    signIn?: "google" | "passkey";
    canTrustSignIn: boolean;
    revokedDevice?: true;
  }> {
    this.prune();
    return [...this.requests.values()]
      .filter((row) => row.state !== "verifying")
      .map((row) => ({
        requestId: row.requestId,
        kind: row.kind,
        name: row.name,
        status: row.state,
        verificationCode: row.verificationCode,
        expiresAt: row.expiresAt,
        ...(row.signIn ? { signIn: row.signIn.type } : {}),
        canTrustSignIn: row.trustable === true,
        ...(row.revokedDevice ? { revokedDevice: true as const } : {}),
      }));
  }

  async decide(
    requestId: string,
    approve: boolean,
    choices: { trustSignIn?: boolean } = {},
  ): Promise<void> {
    this.prune();
    const row = this.requests.get(requestId);
    if (!row || row.state === "verifying") throw new RelayError(404, "Pairing request not found");
    if (row.gatewayFingerprint !== this.options.gatewayFingerprint())
      throw new RelayError(409, "Gateway certificate changed; start pairing again");
    if (row.state === "approving") {
      if (!approve) throw new RelayError(409, "Pairing approval already in progress");
      return row.decision;
    }
    if (row.state !== "pending") throw new RelayError(409, "Pairing request already decided");
    if (!approve) {
      row.state = "denied";
      return;
    }
    row.approvedByPerson = true;
    row.decision = this.approve(row).then(async () => {
      if (choices.trustSignIn && row.signIn && row.trustable)
        // A sign-in made in a native app committed to a nonce the device computed itself.
        await this.options.enrollment!.trustSignIn(
          row.signIn,
          row.kind === "ios" || row.kind === "android" ? "native-app" : "approval",
        );
    });
    return row.decision;
  }

  private prune(): void {
    for (const [id, row] of this.requests)
      if (row.expiresAt <= Date.now()) this.requests.delete(id);
    for (const [id, proof] of this.held) if (proof.expiresAt <= Date.now()) this.held.delete(id);
  }
}
