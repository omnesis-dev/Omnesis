// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { passkeyProofChallenge } from "./device-enrollment.js";
import { bindingOrigin } from "./gateway-binding.js";
import { OmnesisAccounts } from "./omnesis-accounts.js";
import { PasskeyEndorsements } from "./passkey-endorsement.js";
import { RelayError } from "./tunnels.js";
import type { AccountAdmission, PasskeyRegistrationAuthorization } from "./account-admission.js";
import type { ProofCommitment } from "./operation-proof.js";

const encoded = z
  .string()
  .min(1)
  .max(65_536)
  .regex(/^[A-Za-z0-9_-]+$/);
const credentialId = encoded.max(2048);
const common = {
  id: credentialId,
  rawId: credentialId,
  type: z.literal("public-key"),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  clientExtensionResults: z.object({}).passthrough(),
};
const registrationSchema = z
  .object({
    ...common,
    response: z
      .object({
        clientDataJSON: encoded,
        attestationObject: encoded,
        transports: z.array(z.string().min(1).max(32)).max(8).optional(),
        authenticatorData: encoded.optional(),
        publicKey: encoded.optional(),
        publicKeyAlgorithm: z.number().int().optional(),
      })
      .strict(),
  })
  .strict();
const authenticationSchema = z
  .object({
    ...common,
    response: z
      .object({
        clientDataJSON: encoded,
        authenticatorData: encoded,
        signature: encoded,
        userHandle: encoded.max(128),
      })
      .strict(),
  })
  .strict();

export interface OmnesisAccountSession {
  accountId: string;
  version: number;
}
/** The signed response itself, so a caller can hand it on for the gateway to verify. */
export interface PasskeyEvidence extends OmnesisAccountSession {
  challenge: string;
  credential: unknown;
  credentialId: string;
}
/** The raw bytes of the committed value, so `options.challenge` equals the value a gateway recomputes. */
const committedChallenge = (commitment: ProofCommitment | undefined) =>
  commitment
    ? {
        challenge: Buffer.from(
          passkeyProofChallenge(commitment.salt, commitment.issuedAt, commitment.nonce),
          "base64url",
        ),
      }
    : {};
interface Ceremony {
  purpose: "registration" | "authentication" | "countersignature";
  /** For a countersignature: the parked passkey that signs. */
  endorse?: string;
  challenge: string;
  browser: string;
  expiresAt: number;
  account?: OmnesisAccountSession;
  newAccountId?: string;
  label?: string;
  authorization?: PasskeyRegistrationAuthorization;
}

/** WebAuthn verifies credential possession; device enrollment and gateway encryption remain independent. */
export class Passkeys {
  private readonly pending = new Map<string, Ceremony>();
  private closed = false;
  private readonly origin: string;
  private readonly rpID: string;
  private readonly expectedOrigins: string[];
  constructor(
    private readonly accounts: OmnesisAccounts,
    options: {
      origin: string;
      androidOrigins?: readonly string[];
      now?: () => number;
      maxPending?: number;
      ceremonyTtlMs?: number;
    },
  ) {
    const origin = bindingOrigin(options.origin);
    this.origin = origin.origin;
    this.rpID = origin.hostname;
    const android = options.androidOrigins ?? [];
    if (android.some((value) => !/^android:apk-key-hash:[A-Za-z0-9_-]{43}$/.test(value)))
      throw new Error("Invalid trusted Android passkey origin");
    this.expectedOrigins = [this.origin, ...android];
    this.now = options.now ?? Date.now;
    this.endorsements = new PasskeyEndorsements(accounts, { now: this.now });
    this.maxPending = options.maxPending ?? 128;
    this.ttl = options.ceremonyTtlMs ?? 300_000;
    if (
      !Number.isSafeInteger(this.maxPending) ||
      this.maxPending < 1 ||
      !Number.isSafeInteger(this.ttl) ||
      this.ttl < 1 ||
      this.ttl > 300_000
    )
      throw new Error("Invalid passkey ceremony limits");
  }
  private readonly now: () => number;
  private readonly maxPending: number;
  private readonly ttl: number;
  /** New passkeys for an existing account wait here for a sign-in that vouches for them. */
  readonly endorsements: PasskeyEndorsements;

  async beginRegistration(
    browser: string,
    account?: OmnesisAccountSession,
    label = "Passkey",
    authorization?: PasskeyRegistrationAuthorization,
    commitment?: ProofCommitment,
  ) {
    this.admit(browser);
    this.registrationCurrent(account, authorization);
    const accountId = account?.accountId ?? OmnesisAccounts.newId();
    const options = await generateRegistrationOptions({
      ...committedChallenge(commitment),
      rpName: "Omnesis",
      rpID: this.rpID,
      userID: Buffer.from(accountId, "hex"),
      userName: "Omnesis account",
      userDisplayName: "Omnesis account",
      attestationType: "none",
      timeout: this.ttl,
      supportedAlgorithmIDs: [-7, -257],
      excludeCredentials: account
        ? this.accounts.list(accountId).passkeys.map((key) => ({ id: key.id }))
        : [],
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
    });
    this.registrationCurrent(account, authorization);
    const ceremonyId = this.save({
      purpose: "registration",
      authorization,
      browser,
      challenge: options.challenge,
      expiresAt: this.now() + this.ttl,
      ...(account ? { account: { ...account } } : { newAccountId: accountId }),
      label,
    });
    return { ceremonyId, options };
  }

  /**
   * A new account's first passkey is stored at once. One added to an existing account is only
   * held, and `endorse` names it until a sign-in the account already has vouches for it.
   */
  async finishRegistration(
    ceremonyId: string,
    browser: string,
    response: unknown,
  ): Promise<PasskeyEvidence | { endorse: string }> {
    const pending = this.consume(ceremonyId, browser, "registration");
    try {
      const credential = registrationSchema.parse(response);
      if (credential.id !== credential.rawId) throw new Error("Credential identifier mismatch");
      const verified = await verifyRegistrationResponse({
        response: credential,
        expectedChallenge: pending.challenge,
        expectedOrigin: this.expectedOrigins,
        expectedRPID: this.rpID,
        requireUserPresence: true,
        requireUserVerification: true,
        supportedAlgorithmIDs: [-7, -257],
      });
      if (!verified.verified) throw new Error("Registration not verified");
      this.fresh(pending);
      this.registrationCurrent(pending.account, pending.authorization);
      const accountId = pending.account?.accountId ?? pending.newAccountId!;
      const info = verified.registrationInfo,
        registration = {
          credential: info.credential,
          deviceType: info.credentialDeviceType,
          backedUp: info.credentialBackedUp,
          label: pending.label!,
        };
      if (pending.account)
        return { endorse: this.endorsements.park(browser, accountId, registration) };
      // `registrationCurrent` let a new account through only with its gateway's admission.
      const { admission } = pending.authorization as { admission: AccountAdmission };
      this.accounts.registerPasskey(accountId, registration, true, undefined, admission);
      return {
        accountId,
        version: this.accounts.sessionVersion(accountId)!,
        challenge: pending.challenge,
        credential,
        credentialId: credential.id,
      };
    } catch {
      throw new RelayError(400, "Passkey registration did not complete; try again");
    }
  }

  /** `allow` narrows the browser's choice to those passkeys; without it any of the account's works. */
  async beginAuthentication(browser: string, commitment?: ProofCommitment, allow?: string[]) {
    this.admit(browser);
    const options = await generateAuthenticationOptions({
      ...committedChallenge(commitment),
      ...(allow ? { allowCredentials: allow.map((id) => ({ id })) } : {}),
      rpID: this.rpID,
      userVerification: "required",
      timeout: this.ttl,
    });
    const ceremonyId = this.save({
      purpose: "authentication",
      browser,
      challenge: options.challenge,
      expiresAt: this.now() + this.ttl,
    });
    return { ceremonyId, options };
  }

  async finishAuthentication(
    ceremonyId: string,
    browser: string,
    response: unknown,
  ): Promise<PasskeyEvidence & { credentialPublicKey: string }> {
    const pending = this.consume(ceremonyId, browser, "authentication");
    try {
      const credential = authenticationSchema.parse(response);
      if (credential.id !== credential.rawId) throw new Error("Credential identifier mismatch");
      const stored = this.accounts.passkey(credential.id);
      if (!stored) throw new Error("Passkey is not registered");
      const expectedHandle = Buffer.from(stored.accountId, "hex").toString("base64url");
      const actualHandle = credential.response.userHandle;
      if (
        actualHandle.length !== expectedHandle.length ||
        !timingSafeEqual(Buffer.from(actualHandle), Buffer.from(expectedHandle))
      )
        throw new Error("Passkey account mismatch");
      const result = await verifyAuthenticationResponse({
        response: credential,
        expectedChallenge: pending.challenge,
        expectedOrigin: this.expectedOrigins,
        expectedRPID: this.rpID,
        credential: stored.credential,
        requireUserVerification: true,
      });
      if (!result.verified) throw new Error("Authentication not verified");
      this.fresh(pending);
      const info = result.authenticationInfo;
      this.accounts.recordAuthentication(
        stored,
        info.newCounter,
        info.credentialDeviceType,
        info.credentialBackedUp,
      );
      return {
        accountId: stored.accountId,
        version: this.accounts.sessionVersion(stored.accountId)!,
        challenge: pending.challenge,
        credential,
        credentialId: credential.id,
        credentialPublicKey: Buffer.from(stored.credential.publicKey).toString("base64url"),
      };
    } catch {
      throw new RelayError(401, "Passkey sign-in did not complete; try again");
    }
  }

  /**
   * The passkey being added signs once, before it is stored, committing to the account's other
   * sign-ins. Only that passkey is offered, and its signature is checked against the key it was
   * just registered with.
   */
  async beginCountersignature(browser: string, endorse: string, cookieHeader: string) {
    this.admit(browser);
    const { credential, commitment } = this.endorsements.countersigning(endorse, cookieHeader);
    const options = await generateAuthenticationOptions({
      ...committedChallenge(commitment),
      allowCredentials: [{ id: credential.id }],
      rpID: this.rpID,
      userVerification: "required",
      timeout: this.ttl,
    });
    const ceremonyId = this.save({
      purpose: "countersignature",
      endorse,
      browser,
      challenge: options.challenge,
      expiresAt: this.now() + this.ttl,
    });
    return { ceremonyId, options };
  }

  async finishCountersignature(
    ceremonyId: string,
    browser: string,
    endorse: string,
    cookieHeader: string,
    response: unknown,
  ): Promise<void> {
    const pending = this.consume(ceremonyId, browser, "countersignature");
    if (pending.endorse !== endorse)
      throw new RelayError(400, "This signature was asked for another new passkey");
    const signing = this.endorsements.countersigning(endorse, cookieHeader);
    const parsed = authenticationSchema.safeParse(response);
    if (!parsed.success || parsed.data.id !== parsed.data.rawId)
      throw new RelayError(400, "Passkey response is malformed");
    const credential = parsed.data;
    if (credential.id !== signing.credential.id)
      throw new RelayError(400, "Use the passkey you are adding, not another one");
    const expectedHandle = Buffer.from(signing.accountId, "hex").toString("base64url");
    const actualHandle = credential.response.userHandle;
    if (
      actualHandle.length !== expectedHandle.length ||
      !timingSafeEqual(Buffer.from(actualHandle), Buffer.from(expectedHandle))
    )
      throw new RelayError(400, "That passkey belongs to another Omnesis account");
    let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      result = await verifyAuthenticationResponse({
        response: credential,
        expectedChallenge: pending.challenge,
        expectedOrigin: this.expectedOrigins,
        expectedRPID: this.rpID,
        credential: signing.credential,
        requireUserVerification: true,
      });
    } catch {
      throw new RelayError(400, "The new passkey's signature did not verify");
    }
    if (!result.verified) throw new RelayError(400, "The new passkey's signature did not verify");
    this.fresh(pending);
    this.endorsements.recordCountersignature(endorse, cookieHeader, {
      challenge: pending.challenge,
      credential,
      counter: result.authenticationInfo.newCounter,
    });
  }

  close(): void {
    this.closed = true;
    this.pending.clear();
    this.endorsements.close();
  }

  private registrationCurrent(
    account: OmnesisAccountSession | undefined,
    authority: PasskeyRegistrationAuthorization | undefined,
  ): void {
    if (account) {
      this.current(account);
      // No recent sign-in is asked for here: the passkey is stored only once a fresh one vouches for it.
      if (
        authority?.kind !== "account-session" ||
        !this.accounts.activeSession(account.accountId, account.version, authority.sessionId)
      )
        throw new RelayError(401, "Sign in again before adding a credential");
    } else {
      if (authority?.kind !== "gateway-owner")
        throw new RelayError(403, "Start account setup from your gateway");
      authority.admission.assertCurrent();
      if (!this.accounts.canAdmitGateway(authority.admission.gatewayId))
        throw new RelayError(
          403,
          "This gateway already allocated an account; sign in to the existing account",
        );
    }
  }
  private current(account: OmnesisAccountSession): void {
    if (this.accounts.sessionVersion(account.accountId) !== account.version)
      throw new RelayError(401, "Sign in again before adding a credential");
  }
  private fresh(pending: Ceremony): void {
    if (this.closed || pending.expiresAt <= this.now())
      throw new RelayError(400, "Passkey request expired");
  }
  private admit(browser: string): void {
    if (this.closed) throw new RelayError(503, "Passkey service is closed");
    if (!/^[A-Za-z0-9_-]{43}$/.test(browser)) throw new RelayError(400, "Browser binding required");
    for (const [id, pending] of this.pending)
      if (pending.expiresAt <= this.now()) this.pending.delete(id);
    if (this.pending.size >= this.maxPending)
      throw new RelayError(429, "Too many passkey requests");
  }
  private save(pending: Ceremony): string {
    this.admit(pending.browser);
    const id = randomBytes(32).toString("base64url");
    this.pending.set(id, pending);
    return id;
  }
  private consume(id: string, browser: string, purpose: Ceremony["purpose"]): Ceremony {
    const pending = this.pending.get(id);
    if (!pending || pending.browser !== browser || pending.purpose !== purpose)
      throw new RelayError(400, "Passkey request is unavailable");
    this.pending.delete(id);
    this.fresh(pending);
    return pending;
  }
}
