// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createPublicKey, randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteFileSync, cloudRelayEnabled } from "@omnesis/core";
import { z } from "zod";
import {
  ManagedAccountBrowser,
  type AccountBrowserPending,
  type AccountBrowserPort,
} from "./account-browser-client.js";
import { bindingOrigin } from "./gateway-binding.js";
import { gatewayKeyAccount } from "./gateway-key-auth.js";
import { readOrCreateGatewayOwnerKey, type registerGatewayKey } from "./gateway-key-client.js";
import { readPrivateJson } from "./google-credentials.js";
import { installationRelayUrl } from "./installation-relay.js";
import { accountId, googleIdentityProvider, type IdentityProvider } from "./identity.js";
import { CloudRelayManagementFailure } from "./management.js";
import { EnrollmentChallenges } from "./enrollment-challenges.js";
import {
  GatewaySignInVerifier,
  confirmedSignInSchema,
  trustedSignInSchema,
  type ConfirmedSignIn,
  type SignInPin,
  type TrustedSignIn,
  type TrustedSignInSource,
  type VerifiedSignIn,
} from "./gateway-sign-in-proof.js";
import {
  googleBrowserTrust,
  OFFICIAL_ANDROID_PASSKEY_ORIGINS,
  type GoogleBrowserTrust,
} from "./google-browser-trust.js";
import { hostedGatewayOrigin } from "./hosted-name.js";
import {
  gatewayPasskeyChallenge,
  gatewayPasskeyPinBinding,
  gatewayPasskeySignInProofSchema,
  signInDigest,
  type GatewayPasskeyPurpose,
  type SignInProof,
} from "./device-enrollment.js";
import { GatewayPasskeyCeremonies } from "./gateway-passkey-ceremonies.js";
import type { EnrollmentPolicy, GatewayEnrollment } from "./google-pairing.js";
import type { GatewayBrowserCallbackOrigins } from "./gateway-browser-callback.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_TRUSTED_SIGN_INS = 32;
const MAX_CONFIRMED_SIGN_INS = 32;
/**
 * Sign-ins the owner confirmed on this gateway (`ConfirmedSignIn`). A top-level field on purpose:
 * a version that predates it drops it when it saves, so going back a version fails closed to
 * "nothing confirmed" instead of refusing the whole link, and an entry this version can't read
 * (a later version's) is dropped the same way.
 */
const confirmedSignInsSchema = z
  .array(z.unknown())
  .max(MAX_CONFIRMED_SIGN_INS)
  .default([])
  .transform((entries) =>
    entries.flatMap((entry) => {
      const parsed = confirmedSignInSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    }),
  );
const MAX_DECLINED_PASSKEYS = 256;
const MAX_WITHDRAWN_SIGN_INS = 256;
/** Certificates an incident hold names, and acknowledged ones kept so a restart doesn't raise them again. */
const MAX_INCIDENT_CERTIFICATES = 64;
/** A sign-in that arrives untrusted fetches the account's evidence at most this often. */
const SIGN_IN_SYNC_INTERVAL_MS = 2_000;
const bindingSchema = z
  .object({ relayOrigin: z.string().url(), gatewayId: z.string().uuid(), ownerAccountId: digest })
  .strict();
type Binding = z.infer<typeof bindingSchema>;
/**
 * The owner's local choices about sign-ins. Only local owner actions and this gateway's own
 * checks write them; the relay never can. Unlinking or losing the account drops the link and its
 * pins but keeps these, so linking again can't quietly undo them.
 */
const choices = {
  /** Absent means automatic. It belongs to the gateway, so it applies to any account linked next. */
  enrollmentPolicy: z.enum(["automatic", "ask"]).optional(),
  /**
   * Passkey pins the owner removed on this gateway. A vouching sign-in never pins these
   * again; only approving a device with that passkey does.
   */
  declinedPasskeys: z.array(z.string().max(2048)).max(MAX_DECLINED_PASSKEYS).default([]),
  /**
   * Google pins the owner removed on this gateway. A passkey's countersignature never pins
   * these again; only approving a device that signed in with that Google account does.
   */
  declinedGoogle: z.array(digest).max(MAX_DECLINED_PASSKEYS).default([]),
  /**
   * `signInDigest`s of sign-ins the account withdrew: pinned here, or named by a verified
   * countersignature, and then missing from the account's listing. No endorsement or
   * countersignature pins one again, whatever a relay lists later; only approving a device
   * that signed in with it does.
   */
  withdrawnSignIns: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{43}$/))
    .max(MAX_WITHDRAWN_SIGN_INS)
    .default([]),
  /**
   * Set when the certificate monitor sees a certificate for this gateway's name with a key the
   * gateway doesn't hold, as SHA-256 fingerprints of those certificates. Only the owner's
   * acknowledgement on this gateway lifts it, never anything the relay sends.
   */
  incidentHold: z
    .object({
      since: z.number().int().nonnegative(),
      certificates: z.array(digest).min(1).max(MAX_INCIDENT_CERTIFICATES),
    })
    .strict()
    .optional(),
  /** Certificates the owner acknowledged, so the monitor's journal doesn't hold for them again. */
  acknowledgedIncidents: z.array(digest).max(MAX_INCIDENT_CERTIFICATES).optional(),
};
/**
 * Not strict: fields a later version adds are dropped, so going back a version keeps the link.
 * Each pin is still strict, and a value this version can't read refuses the whole record.
 */
const recordSchema = z.discriminatedUnion("linked", [
  z.object({
    version: z.literal(1),
    linked: z.literal(true),
    binding: bindingSchema,
    accountId: digest,
    trustedSignIns: z.array(trustedSignInSchema).max(MAX_TRUSTED_SIGN_INS).default([]),
    confirmedSignIns: confirmedSignInsSchema,
    ...choices,
  }),
  z.object({
    version: z.literal(1),
    linked: z.literal(false),
    pendingUnlink: bindingSchema.optional(),
    /** The account the kept refusals name: only linking that account again restores them. */
    accountId: digest.optional(),
    /**
     * The account is gone and only the owner's choices are left: account mode is off, as on a
     * gateway that never had an account, until the gateway links again.
     */
    dormant: z.literal(true).optional(),
    ...choices,
  }),
]);
type Record = z.infer<typeof recordSchema>;
type Unlinked = Extract<Record, { linked: false }>;
const cookieName = "__Host-omnesis-gateway-account";
const clearCookie = `${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
const callbackSchema = z
  .object({
    operationId: z.string().uuid(),
    state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    result: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

/** What a page or app needs to run a passkey ceremony on this gateway (`gateway-passkey`). */
export interface GatewayPasskeyCeremony {
  purpose: GatewayPasskeyPurpose;
  /** The relay's host: every account passkey belongs to it. */
  rpId: string;
  /** This gateway's own origin, the only web origin the assertion may come from. */
  origin: string;
  /** The gateway's one-use value, sent back in the proof. */
  challenge: string;
  /** What the assertion approves. */
  binding: string;
  /** `gatewayPasskeyChallenge(purpose, origin, challenge, binding)`. */
  webauthnChallenge: string;
  expiresAt: number;
}

/** Account discovery is independent of transport ownership and existing paired-device credentials. */
export class GatewayAccountLink {
  private record?: Record;
  private activated = false;
  private bound = false;
  private mutating = false;
  private starting = 0;
  private abort = new AbortController();
  private readonly pending = new Map<string, AccountBrowserPending>();
  private readonly browser: AccountBrowserPort;
  private lastError?: "account-unavailable" | "account-link-failed";
  /**
   * The incident hold and acknowledged certificates. Kept here rather than read from the record,
   * so every save writes them whatever record it was given: no relink, unlink or forget can drop
   * them. `unreadable` means a link file exists that this version can't read; it is left alone.
   */
  private hold?: { since: number; certificates: string[] };
  private acknowledged: string[] = [];
  private unreadable = false;
  constructor(
    private readonly options: {
      env(): NodeJS.ProcessEnv;
      metadataFile: string;
      callbackOrigins?(): GatewayBrowserCallbackOrigins;
      fetch?: typeof fetch;
      register?: typeof registerGatewayKey;
      browser?: AccountBrowserPort;
      /** The public TLS key devices sign for. */
      spkiFingerprint?(): string | undefined;
      google?(): IdentityProvider | undefined;
      /** How often an untrusted sign-in may fetch the account's evidence; tests set 0. */
      signInSyncIntervalMs?: number;
      /** Test seam: production always trusts the compiled-in official Google clients. */
      googleTrust?(): GoogleBrowserTrust;
    },
  ) {
    this.browser =
      options.browser ??
      new ManagedAccountBrowser({ ...options, accountId: () => this.verifiedAccountId() });
    this.verifier = new GatewaySignInVerifier({
      google: () => (options.google ?? (() => this.googleIdentity()))(),
      relayOrigin: () => bindingOrigin(installationRelayUrl(options.env())!).origin,
      passkeyOrigins: () => [
        ...new Set([
          ...OFFICIAL_ANDROID_PASSKEY_ORIGINS,
          ...(options.env().OMNESIS_CLOUD_RELAY_PASSKEY_ANDROID_ORIGINS ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter((value) => /^android:apk-key-hash:[A-Za-z0-9_-]{43}$/.test(value)),
        ]),
      ],
      trusted: () => (this.record?.linked ? this.record.trustedSignIns : []),
      gatewayOrigin: () => this.gatewayOrigin(),
      nativeGoogleClients: () => googleBrowserTrust(this.options.googleTrust?.()).nativeClients!,
    });
  }
  private readonly verifier: GatewaySignInVerifier;
  private readonly challenges = new EnrollmentChallenges();
  private readonly ceremonies = new GatewayPasskeyCeremonies();
  private googleProvider?: { key: string; provider: IdentityProvider };

  /** Audiences come from the compiled-in registry and local static configuration. Relay discovery can never add one. */
  private googleIdentity(): IdentityProvider | undefined {
    const env = this.options.env(),
      trust = googleBrowserTrust(this.options.googleTrust?.());
    const split = (value: string | undefined) =>
      (value ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
    const audiences = [
      ...new Set([
        ...trust.deviceClientIds,
        ...split(env.OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID),
        ...split(env.OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID),
      ]),
    ];
    if (audiences.length === 0) return undefined;
    const parties = [
      ...new Set([
        ...audiences,
        ...trust.deviceAuthorizedParties,
        ...split(env.OMNESIS_CLOUD_RELAY_GOOGLE_ANDROID_CLIENT_ID),
      ]),
    ];
    const key = JSON.stringify([audiences, parties]);
    if (this.googleProvider?.key !== key)
      this.googleProvider = {
        key,
        provider: googleIdentityProvider(audiences, undefined, { authorizedParties: parties }),
      };
    return this.googleProvider.provider;
  }
  async initialize(): Promise<void> {
    try {
      const value = await readPrivateJson(this.options.metadataFile);
      this.activated = true;
      this.record = recordSchema.parse(value);
      this.hold = this.record.incidentHold;
      this.acknowledged = this.record.acknowledgedIncidents ?? [];
      if (!this.record.linked && this.record.dormant) this.activated = false;
      this.bound =
        this.record.linked && this.sameBinding(this.record.binding, await this.binding());
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        this.activated = true;
        this.bound = false;
        this.unreadable = true;
        this.lastError = "account-link-failed";
      }
    }
  }
  accountModeActivated(): boolean {
    return this.activated;
  }
  /**
   * This gateway's own origin under the relay's domain, derived from its id and the relay it was
   * installed with, never from what the relay said. Undefined when the saved public origin is
   * anything else (a custom domain, or a name the relay chose): then no passkey of the account
   * can be confirmed or used on the gateway's page.
   */
  gatewayOrigin(): string | undefined {
    // While a rogue certificate may exist for this name, its page may not be this gateway's.
    if (this.gatewayOriginAssertionsRefused()) return undefined;
    const env = this.options.env();
    return hostedGatewayOrigin({
      relayOrigin: installationRelayUrl(env),
      gatewayId: env.OMNESIS_CLOUD_RELAY_GATEWAY_ID,
      publicOrigin: env.OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN ?? env.OMNESIS_PUBLIC_BASE_URL,
    });
  }
  /** Sign-ins the owner confirmed on this gateway, for the linked account only. */
  confirmedSignIns(): readonly ConfirmedSignIn[] {
    return this.record?.linked && this.verifiedAccountId() !== undefined
      ? this.record.confirmedSignIns
      : [];
  }
  /**
   * What a page on this gateway's origin needs to run a passkey ceremony for `purpose`: the RP ID
   * (the relay's host, as for every account passkey), the gateway's one-use challenge, what the
   * assertion approves, and the WebAuthn challenge for this origin. An app on another origin (the
   * Android app) computes its own from the same parts.
   */
  private ceremony(
    purpose: GatewayPasskeyPurpose,
    origin: string,
    issued: { challenge: string; expiresAt: number },
    binding: string,
  ): GatewayPasskeyCeremony {
    return {
      purpose,
      rpId: bindingOrigin(installationRelayUrl(this.options.env())!).hostname,
      origin,
      challenge: issued.challenge,
      binding,
      webauthnChallenge: gatewayPasskeyChallenge(purpose, origin, issued.challenge, binding),
      expiresAt: issued.expiresAt,
    };
  }
  private pinBinding(record: Extract<Record, { linked: true }>): string {
    return gatewayPasskeyPinBinding({
      gatewayId: record.binding.gatewayId,
      accountId: record.accountId,
    });
  }
  /**
   * Starts confirming one of the account's passkeys on this gateway's own page. Only a gateway
   * with an origin of its own can: on any other origin, the relay could have served the page.
   */
  passkeyConfirmation(): GatewayPasskeyCeremony {
    const record = this.requireLinked(),
      origin = this.gatewayOrigin();
    if (!origin) throw new CloudRelayManagementFailure(409, "passkey-origin-unavailable");
    const binding = this.pinBinding(record);
    return this.ceremony(
      "pin-passkey",
      origin,
      this.ceremonies.issue("pin-passkey", binding),
      binding,
    );
  }
  /**
   * Confirms the passkey that signed `input` on this gateway's page as the owner's. Its key comes
   * from the account's listing: a relay that lists a key of its own for this id only makes the
   * assertion fail, since the private key stays in the owner's authenticator. Confirming is an
   * owner action, so it lifts a decline or withdrawal of that passkey.
   */
  async confirmPasskey(input: unknown): Promise<void> {
    const record = this.requireLinked(),
      binding = this.pinBinding(record);
    const parsed = gatewayPasskeySignInProofSchema.safeParse(input);
    if (!parsed.success || !this.ceremonies.take("pin-passkey", parsed.data.challenge, binding))
      throw new CloudRelayManagementFailure(409, "passkey-not-confirmed");
    const listing = await this.browser.credentials?.(this.abort.signal).catch(() => undefined);
    if (!listing || (listing.accountId !== undefined && listing.accountId !== record.accountId))
      throw new CloudRelayManagementFailure(503, "account-unavailable");
    const verified = await this.verifier.verifyGatewayPasskey(parsed.data, {
      purpose: "pin-passkey",
      challenge: parsed.data.challenge,
      binding,
      key: (id) => {
        const listed = listing.passkeys.find((value) => value.id === id);
        if (!listed) return undefined;
        const previous = record.confirmedSignIns.find(
          (value) => value.type === "passkey" && value.id === id,
        );
        return {
          publicKey: listed.publicKey,
          counter:
            previous?.type === "passkey" && previous.publicKey === listed.publicKey
              ? previous.counter
              : 0,
        };
      },
    });
    if (!verified) throw new CloudRelayManagementFailure(403, "passkey-not-confirmed");
    const current = this.requireLinked();
    const name = signInDigest({ type: "passkey", id: verified.id, publicKey: verified.publicKey });
    await this.save(
      {
        ...current,
        confirmedSignIns: [
          ...current.confirmedSignIns.filter((value) => value.id !== verified.id),
          {
            type: "passkey" as const,
            id: verified.id,
            publicKey: verified.publicKey,
            counter: verified.counter,
            at: Math.floor(Date.now() / 1000),
            via: verified.channel,
          },
        ].slice(-MAX_CONFIRMED_SIGN_INS),
        declinedPasskeys: current.declinedPasskeys.filter((id) => id !== verified.id),
        withdrawnSignIns: current.withdrawnSignIns.filter((value) => value !== name),
      },
      this.abort.signal,
      current,
    );
  }
  verifiedAccountId(): string | undefined {
    return this.bound &&
      this.record?.linked &&
      cloudRelayEnabled(this.options.env()) &&
      this.matchesEnvironment(this.record.binding)
      ? this.record.accountId
      : undefined;
  }
  managedBrowser(): AccountBrowserPort {
    return this.browser;
  }
  pairingIdentity() {
    const subject = this.verifiedAccountId();
    if (!subject || !this.record?.linked) return undefined;
    return {
      identity: {
        verify: (token: string, nonce?: string) => this.browser.verifyEnrollment(token, nonce),
      },
      ownerAccountId: accountId({
        issuer: this.record.binding.relayOrigin + "/_relay/account",
        subject,
        expiresAt: Number.MAX_SAFE_INTEGER,
      }),
      configurationKey: JSON.stringify([this.record.binding, subject]),
      enrollment: this.enrollment(),
    };
  }
  private enrollment(): GatewayEnrollment {
    return {
      policy: () => this.enrollmentPolicy(),
      spkiFingerprint: () => this.options.spkiFingerprint?.(),
      challenges: this.challenges,
      verifyProof: (proof, nonce, key) => this.verifyProof(proof, nonce, key),
      canTrust: (signIn) => this.canTrust(signIn),
      trustSignIn: (signIn, source) => this.trustSignIn(signIn, source),
    };
  }
  /**
   * A passkey added moments ago may carry a vouching sign-in this gateway has not fetched yet, and
   * a Google account or passkey the account had before this gateway's passkey was added may be
   * countersigned by it. Either way the evidence is fetched and checked before the answer.
   */
  private async verifyProof(proof: SignInProof, nonce: string, key: string | undefined) {
    const verified = await this.verifier.verify(proof, "device-enrollment", nonce, key);
    if (!verified || verified.trusted) return verified;
    await this.sync(
      this.abort.signal,
      this.options.signInSyncIntervalMs ?? SIGN_IN_SYNC_INTERVAL_MS,
    ).catch(() => undefined);
    return this.verifier.verify(proof, "device-enrollment", nonce, key);
  }
  private syncing?: Promise<void>;
  private lastSyncAt = 0;
  /**
   * One fetch at a time: a caller arriving while one runs waits for it. A sign-in may start one
   * only `minimumIntervalMs` after the last, so untrusted sign-ins can't make the gateway ask the
   * relay faster than that.
   */
  private sync(signal: AbortSignal, minimumIntervalMs = 0): Promise<void> {
    if (this.syncing) return this.syncing;
    if (Date.now() - this.lastSyncAt < minimumIntervalMs) return Promise.resolve();
    this.syncing = this.syncCredentials(signal).finally(() => {
      this.syncing = undefined;
      this.lastSyncAt = Date.now();
    });
    return this.syncing;
  }
  /**
   * A linked gateway joins trusted sign-ins automatically unless its owner chose ask or a
   * certificate incident holds it. Both are local, and an unlinked gateway joins nothing.
   */
  enrollmentPolicy(): EnrollmentPolicy {
    return !this.hold && this.record?.linked && this.record.enrollmentPolicy !== "ask"
      ? "automatic"
      : "ask";
  }
  /**
   * While someone else may hold a certificate for this gateway's name, a page on that name may
   * not be the gateway's. A `gateway-passkey` assertion made on the gateway's own origin must be
   * refused while this is true: `gatewayOrigin()` returns undefined then, which leaves only the
   * official Android app's origin, and no passkey can be confirmed on the gateway's page.
   */
  gatewayOriginAssertionsRefused(): boolean {
    return this.hold !== undefined;
  }
  incidentHold(): { since: string; certificates: string[] } | undefined {
    return this.hold
      ? {
          since: new Date(this.hold.since * 1000).toISOString(),
          certificates: [...this.hold.certificates],
        }
      : undefined;
  }
  /**
   * Holds every new device for approval: the certificate monitor saw these certificates for this
   * gateway's name with a key the gateway doesn't hold. Certificates already held or acknowledged
   * change nothing. Returns whether the hold names a certificate it didn't before. The hold
   * applies at once, and is saved even on a gateway that never had an account.
   */
  async holdForCertificateIncident(certificates: string[]): Promise<boolean> {
    const known = new Set([...(this.hold?.certificates ?? []), ...this.acknowledged]);
    const fresh = [...new Set(certificates)].filter(
      (value) => digest.safeParse(value).success && !known.has(value),
    );
    if (fresh.length === 0) return false;
    this.hold = {
      since: this.hold?.since ?? Math.floor(Date.now() / 1000),
      certificates: [...(this.hold?.certificates ?? []), ...fresh].slice(
        -MAX_INCIDENT_CERTIFICATES,
      ),
    };
    await this.saveIncidents();
    return true;
  }
  /**
   * The owner looked into the incident. Callers must make sure the request came from the owner on
   * this gateway, never through the relay.
   */
  async acknowledgeIncidentHold(): Promise<void> {
    const hold = this.hold,
      acknowledged = this.acknowledged;
    if (!hold) return;
    this.acknowledged = [
      ...acknowledged.filter((value) => !hold.certificates.includes(value)),
      ...hold.certificates,
    ].slice(-MAX_INCIDENT_CERTIFICATES);
    this.hold = undefined;
    try {
      await this.saveIncidents();
    } catch (error) {
      this.hold = hold;
      this.acknowledged = acknowledged;
      throw error;
    }
  }
  /** Writes the incident state into the current record, or a dormant one, keeping account mode. */
  private async saveIncidents(): Promise<void> {
    if (this.unreadable) return;
    const activated = this.activated;
    await this.save(
      this.record ?? {
        version: 1,
        linked: false,
        dormant: true,
        declinedPasskeys: [],
        declinedGoogle: [],
        withdrawnSignIns: [],
      },
      new AbortController().signal,
    );
    this.activated = activated;
  }
  async setEnrollmentPolicy(policy: EnrollmentPolicy): Promise<void> {
    const record = this.requireLinked();
    await this.save({ ...record, enrollmentPolicy: policy }, this.abort.signal, record);
  }
  /**
   * A Google subject is named by Google's own signature. A passkey's public key arrives with the
   * request, so a self-made key verifies too; it is trusted only when the relay lists this id with
   * this key for the linked account, and never when that list can't be read.
   */
  async canTrust(signIn: VerifiedSignIn): Promise<boolean> {
    if (signIn.trusted || this.verifiedAccountId() === undefined) return false;
    if (signIn.pin.type === "google") return true;
    const { id, publicKey } = signIn.pin;
    const current = await this.browser.credentials?.(this.abort.signal).catch(() => undefined);
    return (
      current?.passkeys.some((value) => value.id === id && value.publicKey === publicKey) ?? false
    );
  }
  async trustSignIn(signIn: VerifiedSignIn, source: TrustedSignInSource): Promise<void> {
    const record = this.requireLinked();
    // Checked again here: the relay's list may have changed since the request was held.
    if (!(await this.canTrust(signIn)))
      throw new CloudRelayManagementFailure(409, "configuration-invalid");
    await this.save(
      {
        ...record,
        trustedSignIns: [
          ...record.trustedSignIns.filter((value) => value.id !== signIn.id),
          { ...signIn.pin, source },
        ],
        declinedPasskeys: record.declinedPasskeys.filter((id) => id !== signIn.id),
        declinedGoogle: record.declinedGoogle.filter((id) => id !== signIn.id),
        withdrawnSignIns: record.withdrawnSignIns.filter(
          (value) => value !== signInDigest(signIn.pin),
        ),
      },
      this.abort.signal,
      record,
    );
  }
  /**
   * Stops trusting a sign-in and declines it. A sign-in this gateway does not trust can be declined
   * in advance by the id another gateway lists for it, so no evidence ever pins it here: a Google
   * subject digest, or a passkey id. Not knowing which, an id that could be either is declined as
   * both. Only approving a device that signed in with it lifts the decline.
   */
  async removeTrustedSignIn(id: string): Promise<void> {
    const record = this.requireLinked();
    if (!/^[A-Za-z0-9_-]{1,2048}$/.test(id))
      throw new CloudRelayManagementFailure(400, "configuration-invalid");
    const removed = record.trustedSignIns.filter((value) => value.id === id);
    const passkey = removed.length > 0 ? removed.some((value) => value.type === "passkey") : true;
    const google =
      removed.length > 0
        ? removed.some((value) => value.type === "google")
        : digest.safeParse(id).success;
    const decline = (list: string[], add: boolean) =>
      add ? [...list.filter((value) => value !== id), id].slice(-MAX_DECLINED_PASSKEYS) : list;
    await this.save(
      {
        ...record,
        trustedSignIns: record.trustedSignIns.filter((value) => value.id !== id),
        confirmedSignIns: record.confirmedSignIns.filter((value) => value.id !== id),
        declinedPasskeys: decline(record.declinedPasskeys, passkey),
        declinedGoogle: decline(record.declinedGoogle, google),
      },
      this.abort.signal,
      record,
    );
  }
  private requireLinked(): Extract<Record, { linked: true }> {
    if (!this.record?.linked || this.verifiedAccountId() === undefined)
      throw new CloudRelayManagementFailure(409, "configuration-invalid");
    return this.record;
  }
  /** The sign-in a link was made with, pinned only when it was made for linking this gateway. */
  private async pinFromLink(
    proof: SignInProof | undefined,
    nonce: string,
    credentialPublicKey: string | undefined,
  ): Promise<TrustedSignIn[]> {
    const verified =
      proof && (await this.verifier.verify(proof, "gateway-link", nonce, credentialPublicKey));
    return verified ? [{ ...verified.pin, source: "link-page" }] : [];
  }
  /**
   * A link's account, pins and remembered choices, whether the gateway is linked now or was
   * unlinked, or lost its account, since. The enrollment policy is the gateway's and carries over
   * to any account. Linking the same account again keeps what the owner declined and what the
   * account withdrew, except the sign-in the owner just linked with, as approving it would;
   * another account starts with none.
   */
  private relinked(accountId: string, trustedSignIns: TrustedSignIn[]) {
    const kept = this.kept(),
      same = kept.accountId === accountId;
    const ids = new Set(trustedSignIns.map((value) => value.id)),
      names = new Set(trustedSignIns.map((value) => signInDigest(value)));
    return {
      accountId,
      trustedSignIns,
      // A new link is confirmed afresh on this gateway's page, whichever account it names.
      confirmedSignIns: [],
      ...(kept.enrollmentPolicy ? { enrollmentPolicy: kept.enrollmentPolicy } : {}),
      declinedPasskeys: same ? kept.declinedPasskeys.filter((id) => !ids.has(id)) : [],
      declinedGoogle: same ? kept.declinedGoogle.filter((id) => !ids.has(id)) : [],
      withdrawnSignIns: same ? kept.withdrawnSignIns.filter((name) => !names.has(name)) : [],
    };
  }
  /** What an unlinked record keeps of the current one: the owner's choices, never the pins. */
  private kept(): Omit<Unlinked, "version" | "linked" | "pendingUnlink" | "dormant"> {
    const record = this.record;
    return {
      ...(record?.accountId ? { accountId: record.accountId } : {}),
      ...(record?.enrollmentPolicy ? { enrollmentPolicy: record.enrollmentPolicy } : {}),
      declinedPasskeys: record?.declinedPasskeys ?? [],
      declinedGoogle: record?.declinedGoogle ?? [],
      withdrawnSignIns: record?.withdrawnSignIns ?? [],
    };
  }
  /** Finishes a sign-in-first connection: the account proof arrived before the gateway registered. */
  async completeSignup(input: {
    accountId: string;
    nonce: string;
    proof?: SignInProof;
    credentialPublicKey?: string;
    signal: AbortSignal;
  }): Promise<void> {
    const binding = await this.binding();
    await this.save(
      {
        version: 1,
        linked: true,
        binding,
        ...this.relinked(
          digest.parse(input.accountId),
          await this.pinFromLink(input.proof, input.nonce, input.credentialPublicKey),
        ),
      },
      input.signal,
    );
    this.bound = true;
    this.lastError = undefined;
  }
  enrollmentStatus() {
    const record = this.record?.linked ? this.record : undefined;
    const confirmed = record?.confirmedSignIns ?? [];
    const confirmedNames = new Set(confirmed.map(({ type, id }) => `${type}:${id}`));
    const origin = record ? this.gatewayOrigin() : undefined;
    return {
      policy: this.enrollmentPolicy(),
      trustedSignIns: (record?.trustedSignIns ?? []).map(({ type, id, addedAt, source }) => ({
        type,
        id,
        addedAt,
        source,
        confirmed: confirmedNames.has(`${type}:${id}`),
      })),
      confirmedSignIns: confirmed.map(({ type, id, at, via }) => ({ type, id, at, via })),
      // Where the owner can confirm a passkey: only this gateway's own origin.
      ...(origin ? { confirmOrigin: origin } : {}),
    };
  }
  /**
   * A pin the account no longer lists, or a passkey pin whose key differs from the one the account
   * lists, is dropped and withdrawn. A listed sign-in is pinned only on evidence this gateway
   * verifies itself against a sign-in already pinned here: a passkey that such a sign-in vouched
   * for when it was added (`endorsed`), or a sign-in that such a passkey countersigned when it was
   * added (`countersigned`). The relay's list alone never adds trust, and a sign-in the owner
   * removed here, or the account withdrew, is never pinned this way again.
   */
  private async syncCredentials(signal: AbortSignal): Promise<void> {
    const record = this.record;
    if (
      !record?.linked ||
      !this.bound ||
      record.trustedSignIns.length + record.confirmedSignIns.length === 0
    )
      return;
    const current = await this.browser.credentials?.(signal);
    if (!current) return;
    const now = () => Math.floor(Date.now() / 1000);
    // What the account lists now, by the name a countersignature and the withdrawn set use.
    const listed = new Map<string, SignInPin>();
    for (const id of current.google)
      listed.set(signInDigest({ type: "google", id }), { type: "google", id, addedAt: 0 });
    for (const { id, publicKey } of current.passkeys)
      listed.set(signInDigest({ type: "passkey", id, publicKey }), {
        type: "passkey",
        id,
        publicKey,
        addedAt: 0,
      });
    const withdrawn = new Set(record.withdrawnSignIns);
    let trusted = record.trustedSignIns.filter((value) => {
      const name = signInDigest(value);
      if (listed.has(name)) return true;
      // Gone from the account: a relay that lists it again later can't bring it back.
      withdrawn.add(name);
      return false;
    });
    // A confirmation goes with its sign-in when the account no longer lists it. The relay can only
    // make the gateway stricter this way; confirming again takes the owner's own ceremony.
    const confirmed = record.confirmedSignIns.filter((value) => {
      const name = signInDigest(value);
      if (listed.has(name)) return true;
      withdrawn.add(name);
      return false;
    });
    let changed =
      trusted.length !== record.trustedSignIns.length ||
      confirmed.length !== record.confirmedSignIns.length;
    let added = true;
    const open = (signIn: SignInPin) =>
      trusted.length < MAX_TRUSTED_SIGN_INS &&
      !trusted.some((value) => value.id === signIn.id) &&
      !(signIn.type === "google" ? record.declinedGoogle : record.declinedPasskeys).includes(
        signIn.id,
      ) &&
      !withdrawn.has(signInDigest(signIn));
    const pin = (signIn: SignInPin, source: TrustedSignInSource) => {
      if (!open(signIn)) return;
      trusted = [...trusted, { ...signIn, addedAt: now(), source }];
      added = changed = true;
    };
    const isTrusted = (signer: { type: string; id: string }) =>
      trusted.some((value) => value.type === signer.type && value.id === signer.id);
    // Each proof is verified at most once per sync: whether it verifies depends only on its
    // signer's pin, which a sync never changes once the signer is pinned.
    const endorsed = new Map<string, boolean>();
    const countersigned = new Set<string>();
    // One newly pinned sign-in may be what vouches for or countersigns the next, so repeat until
    // nothing is added.
    while (added) {
      added = false;
      for (const passkey of current.passkeys) {
        const self: SignInPin = {
          type: "passkey",
          id: passkey.id,
          publicKey: passkey.publicKey,
          addedAt: 0,
        };
        // Keyed by id and key together, so two entries under one id can't stand in for each other.
        const name = signInDigest(self);
        const signer = passkey.endorsement && this.verifier.endorsementSigner(passkey.endorsement);
        if (passkey.endorsement && signer && open(self) && isTrusted(signer)) {
          let verified = endorsed.get(name);
          if (verified === undefined) {
            verified = await this.verifier.verifyEndorsement(passkey.endorsement, passkey, trusted);
            endorsed.set(name, verified);
          }
          if (verified) pin(self, "endorsed");
        }
        if (
          !passkey.countersignature ||
          countersigned.has(name) ||
          !trusted.some(
            (value) =>
              value.type === "passkey" &&
              value.id === passkey.id &&
              value.publicKey === passkey.publicKey,
          )
        )
          continue;
        countersigned.add(name);
        const named = await this.verifier.verifyCountersignature(
          passkey.countersignature,
          passkey,
          record.accountId,
          trusted,
        );
        for (const name of named ?? []) {
          const signIn = listed.get(name);
          // Named by the owner's passkey but no longer on the account: withdrawn for good.
          if (!signIn) {
            if (!withdrawn.has(name)) changed = true;
            withdrawn.add(name);
          } else pin(signIn, "countersigned");
        }
      }
    }
    signal.throwIfAborted();
    if (!changed && withdrawn.size === record.withdrawnSignIns.length) return;
    await this.save(
      {
        ...record,
        trustedSignIns: trusted,
        confirmedSignIns: confirmed,
        withdrawnSignIns: [...withdrawn].slice(-MAX_WITHDRAWN_SIGN_INS),
      },
      signal,
      record,
    );
  }
  status() {
    const linked = this.verifiedAccountId() !== undefined;
    return {
      activated: this.activated,
      configured: this.browser.available(),
      linked,
      canLink: this.browser.available() && !linked && !this.mutating,
      canUnlink: linked,
      pendingUnlink: Boolean(this.record && !this.record.linked && this.record.pendingUnlink),
      lastError: this.lastError,
    };
  }
  async refresh(signal?: AbortSignal): Promise<void> {
    const combined = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
    try {
      if (this.record?.linked)
        this.bound = this.sameBinding(this.record.binding, await this.binding());
      combined.throwIfAborted();
      await this.browser.refresh(combined);
      combined.throwIfAborted();
      await this.flushUnlink(combined);
      combined.throwIfAborted();
      await this.sync(combined);
      combined.throwIfAborted();
      this.lastError = undefined;
    } catch {
      if (!combined.aborted) this.lastError = "account-unavailable";
    }
  }
  async start(input: { requestOrigin: string }): Promise<{ authorizeUrl: string; cookie: string }> {
    if (this.mutating) throw new CloudRelayManagementFailure(409, "operation-in-progress");
    for (const [state, value] of this.pending)
      if (value.expiresAt <= Date.now() / 1000) this.pending.delete(state);
    if (this.pending.size + this.starting >= 8)
      throw new CloudRelayManagementFailure(409, "operation-in-progress");
    const signal = this.abort.signal;
    this.starting++;
    try {
      await this.refresh(signal);
      signal.throwIfAborted();
      if (
        !this.browser.available() ||
        (this.record && !this.record.linked && this.record.pendingUnlink)
      )
        throw new Error("Account sign-in unavailable");
      const browserState = randomBytes(32).toString("base64url");
      const value = await this.browser.begin({
        purpose: "owner-link",
        browserState,
        nonce: randomBytes(32).toString("base64url"),
        callbackUrl: await this.browser.callbackUrl(input.requestOrigin, "owner-link"),
        signal,
      });
      signal.throwIfAborted();
      this.pending.set(browserState, value);
      return {
        authorizeUrl: value.authorizeUrl,
        cookie: `${cookieName}=${browserState}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=300`,
      };
    } catch {
      this.lastError = "account-unavailable";
      throw new CloudRelayManagementFailure(503, "account-unavailable");
    } finally {
      this.starting--;
    }
  }
  async callback(input: {
    url: string;
    cookie?: string;
  }): Promise<{ redirectUrl: string; cookie: string }> {
    if (this.mutating) throw new CloudRelayManagementFailure(409, "operation-in-progress");
    this.mutating = true;
    const signal = this.abort.signal;
    let destination: string | undefined;
    try {
      if (input.url.length > 4096) throw new Error("Invalid callback");
      const url = new URL(input.url),
        fields = callbackSchema.parse(Object.fromEntries(url.searchParams));
      if (url.searchParams.size !== 3 || url.hash || url.username || url.password)
        throw new Error("Invalid callback");
      const cookies = (input.cookie ?? "")
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part.startsWith(cookieName + "="));
      if (cookies.length !== 1 || cookies[0] !== `${cookieName}=${fields.state}`)
        throw new Error("Invalid browser state");
      const pending = this.pending.get(fields.state);
      if (
        !pending ||
        pending.operationId !== fields.operationId ||
        pending.callbackUrl !== url.origin + url.pathname ||
        pending.expiresAt <= Date.now() / 1000
      )
        throw new Error("Unknown account operation");
      this.pending.delete(fields.state);
      destination = new URL("/portal/settings/account", pending.callbackUrl).href;
      const result = await this.browser.redeem(pending, fields.result, signal);
      signal.throwIfAborted();
      const binding = await this.binding();
      if (
        !this.sameBinding(binding, {
          relayOrigin: pending.relayOrigin,
          gatewayId: pending.owner.gatewayId,
          ownerAccountId: pending.owner.ownerAccountId,
        })
      )
        throw new Error("Gateway identity changed");
      await this.save(
        {
          version: 1,
          linked: true,
          binding,
          ...this.relinked(
            digest.parse(result.identity.subject),
            await this.pinFromLink(result.signInProof, pending.nonce, result.credentialPublicKey),
          ),
        },
        signal,
      );
      this.bound = true;
      this.lastError = undefined;
    } catch {
      this.lastError = "account-link-failed";
    } finally {
      this.mutating = false;
    }
    if (!destination) throw new CloudRelayManagementFailure(400, "account-link-failed");
    return { redirectUrl: destination, cookie: clearCookie };
  }
  async unlink(): Promise<void> {
    if (this.mutating) throw new CloudRelayManagementFailure(409, "operation-in-progress");
    this.mutating = true;
    this.cancel();
    const signal = this.abort.signal;
    let saved = false;
    try {
      const pendingUnlink = this.record?.linked ? this.record.binding : this.record?.pendingUnlink;
      // Save local opt-out before contacting the service, including during outages.
      await this.save(
        { version: 1, linked: false, ...(pendingUnlink ? { pendingUnlink } : {}), ...this.kept() },
        signal,
      );
      saved = true;
      this.bound = false;
      await this.flushUnlink(signal);
      this.lastError = undefined;
    } catch {
      this.lastError = "account-link-failed";
      if (!saved) throw new CloudRelayManagementFailure(503, "account-link-failed");
    } finally {
      this.mutating = false;
    }
  }
  cancel(): void {
    this.abort.abort();
    this.abort = new AbortController();
    this.browser.cancel();
    this.pending.clear();
    this.bound = false;
  }
  /**
   * The account no longer exists, so nothing is left to unlink on the relay: the link and its
   * trusted sign-ins go, as on a gateway that never had an account. The owner's choices stay
   * (`choices`): the gateway only has the relay's word that the account is gone, and linking
   * again must not quietly turn "ask" back into automatic or forget a refused sign-in.
   */
  async forget(): Promise<void> {
    this.cancel();
    const kept = this.kept();
    if (
      kept.enrollmentPolicy ||
      this.hold ||
      this.acknowledged.length > 0 ||
      kept.declinedPasskeys.length + kept.declinedGoogle.length + kept.withdrawnSignIns.length > 0
    )
      await this.save({ version: 1, linked: false, dormant: true, ...kept }, this.abort.signal);
    else {
      await rm(this.options.metadataFile, { force: true });
      this.record = undefined;
    }
    this.activated = false;
    this.lastError = undefined;
  }
  private async flushUnlink(signal: AbortSignal): Promise<void> {
    const record = this.record;
    if (!record || record.linked || !record.pendingUnlink) return;
    if (!this.sameBinding(record.pendingUnlink, await this.binding()))
      throw new Error("Account unlink identity changed");
    signal.throwIfAborted();
    await this.browser.unlink(signal);
    signal.throwIfAborted();
    if (this.record !== record) throw new Error("Account operation changed");
    await this.save({ version: 1, linked: false, ...this.kept() }, signal, record);
  }
  private async save(record: Record, signal: AbortSignal, expected?: Record): Promise<void> {
    await mkdir(dirname(this.options.metadataFile), { recursive: true, mode: 0o700 });
    signal.throwIfAborted();
    if (expected && this.record !== expected) throw new Error("Account operation changed");
    const stored: Record = {
      ...record,
      incidentHold: this.hold,
      acknowledgedIncidents: this.acknowledged.length > 0 ? this.acknowledged : undefined,
    };
    atomicWriteFileSync(
      this.options.metadataFile,
      JSON.stringify(recordSchema.parse(stored)) + "\n",
      { mode: 0o600 },
    );
    this.record = stored;
    this.unreadable = false;
    this.activated = true;
  }
  private matchesEnvironment(binding: Binding): boolean {
    const env = this.options.env();
    return (
      installationRelayUrl(env) === binding.relayOrigin &&
      env.OMNESIS_CLOUD_RELAY_GATEWAY_ID === binding.gatewayId
    );
  }
  private sameBinding(a: Binding, b: Binding): boolean {
    return (
      a.relayOrigin === b.relayOrigin &&
      a.gatewayId === b.gatewayId &&
      a.ownerAccountId === b.ownerAccountId
    );
  }
  private async binding(): Promise<Binding> {
    const env = { ...this.options.env() },
      gatewayId = z.string().uuid().parse(env.OMNESIS_CLOUD_RELAY_GATEWAY_ID);
    const key = await readOrCreateGatewayOwnerKey(
      env.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE ?? `${env.OMNESIS_CLOUD_RELAY_SESSION_FILE}.owner-key`,
      false,
    );
    const ownerPublicKey = createPublicKey(key).export({ format: "pem", type: "spki" }).toString();
    return {
      relayOrigin: bindingOrigin(installationRelayUrl(env)!).origin,
      gatewayId,
      ownerAccountId: gatewayKeyAccount({ gatewayId, ownerPublicKey }),
    };
  }
}
