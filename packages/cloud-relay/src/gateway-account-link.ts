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
  trustedSignInSchema,
  type SignInPin,
  type TrustedSignIn,
  type TrustedSignInSource,
  type VerifiedSignIn,
} from "./gateway-sign-in-proof.js";
import { googleBrowserTrust } from "./google-browser-trust.js";
import type { EnrollmentPolicy, GatewayEnrollment } from "./google-pairing.js";
import type { SignInProof } from "./device-enrollment.js";
import type { GatewayBrowserCallbackOrigins } from "./gateway-browser-callback.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_TRUSTED_SIGN_INS = 32;
const MAX_DECLINED_PASSKEYS = 256;
const bindingSchema = z
  .object({ relayOrigin: z.string().url(), gatewayId: z.string().uuid(), ownerAccountId: digest })
  .strict();
type Binding = z.infer<typeof bindingSchema>;
const recordSchema = z.discriminatedUnion("linked", [
  z
    .object({
      version: z.literal(1),
      linked: z.literal(true),
      binding: bindingSchema,
      accountId: digest,
      /** Absent means automatic. Only local owner actions write it; the relay never can. */
      enrollmentPolicy: z.enum(["automatic", "ask"]).optional(),
      trustedSignIns: z.array(trustedSignInSchema).max(MAX_TRUSTED_SIGN_INS).default([]),
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
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      linked: z.literal(false),
      pendingUnlink: bindingSchema.optional(),
    })
    .strict(),
]);
type Record = z.infer<typeof recordSchema>;
const cookieName = "__Host-omnesis-gateway-account";
const clearCookie = `${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
const callbackSchema = z
  .object({
    operationId: z.string().uuid(),
    state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    result: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

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
    },
  ) {
    this.browser =
      options.browser ??
      new ManagedAccountBrowser({ ...options, accountId: () => this.verifiedAccountId() });
    this.verifier = new GatewaySignInVerifier({
      google: () => (options.google ?? (() => this.googleIdentity()))(),
      relayOrigin: () => bindingOrigin(installationRelayUrl(options.env())!).origin,
      passkeyOrigins: () =>
        (options.env().OMNESIS_CLOUD_RELAY_PASSKEY_ANDROID_ORIGINS ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter((value) => /^android:apk-key-hash:[A-Za-z0-9_-]{43}$/.test(value)),
      trusted: () => (this.record?.linked ? this.record.trustedSignIns : []),
    });
  }
  private readonly verifier: GatewaySignInVerifier;
  private readonly challenges = new EnrollmentChallenges();
  private googleProvider?: { key: string; provider: IdentityProvider };

  /** Audiences come from this installation's configuration. Relay discovery can never add one. */
  private googleIdentity(): IdentityProvider | undefined {
    const env = this.options.env(),
      trust = googleBrowserTrust(env);
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
      this.bound =
        this.record.linked && this.sameBinding(this.record.binding, await this.binding());
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        this.activated = true;
        this.bound = false;
        this.lastError = "account-link-failed";
      }
    }
  }
  accountModeActivated(): boolean {
    return this.activated;
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
    const verified = await this.verifier.verify(proof, nonce, key);
    if (!verified || verified.trusted) return verified;
    await this.syncCredentials(this.abort.signal).catch(() => undefined);
    return this.verifier.verify(proof, nonce, key);
  }
  /**
   * A linked gateway joins trusted sign-ins automatically unless its owner chose ask. The choice is
   * local, and an unlinked gateway joins nothing.
   */
  enrollmentPolicy(): EnrollmentPolicy {
    return this.record?.linked && this.record.enrollmentPolicy !== "ask" ? "automatic" : "ask";
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
      },
      this.abort.signal,
      record,
    );
  }
  async removeTrustedSignIn(id: string): Promise<void> {
    const record = this.requireLinked();
    if (!record.trustedSignIns.some((value) => value.id === id))
      throw new CloudRelayManagementFailure(400, "configuration-invalid");
    const removed = record.trustedSignIns.filter((value) => value.id === id);
    await this.save(
      {
        ...record,
        trustedSignIns: record.trustedSignIns.filter((value) => value.id !== id),
        declinedPasskeys: [
          ...record.declinedPasskeys,
          ...removed.filter((value) => value.type === "passkey").map((value) => value.id),
        ].slice(-MAX_DECLINED_PASSKEYS),
        declinedGoogle: [
          ...record.declinedGoogle,
          ...removed.filter((value) => value.type === "google").map((value) => value.id),
        ].slice(-MAX_DECLINED_PASSKEYS),
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
  private async pinFromLink(
    proof: SignInProof | undefined,
    nonce: string,
    credentialPublicKey: string | undefined,
  ): Promise<TrustedSignIn[]> {
    const verified = proof && (await this.verifier.verify(proof, nonce, credentialPublicKey));
    return verified ? [{ ...verified.pin, source: "link-page" }] : [];
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
        accountId: digest.parse(input.accountId),
        trustedSignIns: await this.pinFromLink(input.proof, input.nonce, input.credentialPublicKey),
        declinedPasskeys: [],
        declinedGoogle: [],
      },
      input.signal,
    );
    this.bound = true;
    this.lastError = undefined;
  }
  enrollmentStatus() {
    const record = this.record?.linked ? this.record : undefined;
    return {
      policy: this.enrollmentPolicy(),
      trustedSignIns: (record?.trustedSignIns ?? []).map(({ type, id, addedAt, source }) => ({
        type,
        id,
        addedAt,
        source,
      })),
    };
  }
  /**
   * A pin the account no longer lists, or a passkey pin whose key differs from the one the account
   * lists, is dropped. A listed sign-in is pinned only on evidence this gateway verifies itself
   * against a sign-in already pinned here: a passkey that such a sign-in vouched for when it was
   * added, or a sign-in that such a passkey countersigned when it was added. The relay's list
   * alone never adds trust, and a sign-in the owner removed here is never pinned this way again.
   */
  private async syncCredentials(signal: AbortSignal): Promise<void> {
    const record = this.record;
    if (!record?.linked || !this.bound || record.trustedSignIns.length === 0) return;
    const current = await this.browser.credentials?.(signal);
    if (!current) return;
    const listed = (passkey: { id: string; publicKey: string }) =>
      current.passkeys.some(
        (value) => value.id === passkey.id && value.publicKey === passkey.publicKey,
      );
    let trusted = record.trustedSignIns.filter((value) =>
      value.type === "google" ? current.google.includes(value.id) : listed(value),
    );
    let changed = trusted.length !== record.trustedSignIns.length;
    let added = true;
    const open = (type: SignInPin["type"], id: string) =>
      trusted.length < MAX_TRUSTED_SIGN_INS &&
      !trusted.some((value) => value.id === id) &&
      !(type === "google" ? record.declinedGoogle : record.declinedPasskeys).includes(id);
    const pin = (signIn: SignInPin) => {
      if (!open(signIn.type, signIn.id)) return;
      trusted = [...trusted, { ...signIn, source: "endorsed" }];
      added = changed = true;
    };
    const now = () => Math.floor(Date.now() / 1000);
    // Each passkey's countersignature is checked once: it depends only on that passkey's pin.
    const countersigned = new Set<string>();
    // One newly pinned sign-in may be what vouches for or countersigns the next, so repeat until
    // nothing is added.
    while (added) {
      added = false;
      for (const passkey of current.passkeys) {
        if (
          passkey.endorsement &&
          open("passkey", passkey.id) &&
          (await this.verifier.verifyEndorsement(passkey.endorsement, passkey, trusted))
        )
          pin({ type: "passkey", id: passkey.id, publicKey: passkey.publicKey, addedAt: now() });
        if (
          !passkey.countersignature ||
          countersigned.has(passkey.id) ||
          !trusted.some(
            (value) =>
              value.type === "passkey" &&
              value.id === passkey.id &&
              value.publicKey === passkey.publicKey,
          )
        )
          continue;
        countersigned.add(passkey.id);
        const named = await this.verifier.verifyCountersignature(
          passkey.countersignature,
          passkey,
          record.accountId,
          trusted,
        );
        // Only what the account still lists: a sign-in removed from it stays removed.
        for (const google of named?.google ?? [])
          if (current.google.includes(google)) pin({ type: "google", id: google, addedAt: now() });
        for (const other of named?.passkeys ?? [])
          if (listed(other)) pin({ type: "passkey", ...other, addedAt: now() });
      }
    }
    signal.throwIfAborted();
    if (changed) await this.save({ ...record, trustedSignIns: trusted }, signal, record);
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
      await this.syncCredentials(combined);
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
          accountId: digest.parse(result.identity.subject),
          trustedSignIns: await this.pinFromLink(
            result.signInProof,
            pending.nonce,
            result.credentialPublicKey,
          ),
          declinedPasskeys: [],
          declinedGoogle: [],
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
        { version: 1, linked: false, ...(pendingUnlink ? { pendingUnlink } : {}) },
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
   * The account no longer exists, so nothing is left to unlink on the relay: the link, its policy
   * and its trusted sign-ins go, as on a gateway that never had an account.
   */
  async forget(): Promise<void> {
    this.cancel();
    await rm(this.options.metadataFile, { force: true });
    this.record = undefined;
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
    await this.save({ version: 1, linked: false }, signal, record);
  }
  private async save(record: Record, signal: AbortSignal, expected?: Record): Promise<void> {
    await mkdir(dirname(this.options.metadataFile), { recursive: true, mode: 0o700 });
    signal.throwIfAborted();
    if (expected && this.record !== expected) throw new Error("Account operation changed");
    atomicWriteFileSync(
      this.options.metadataFile,
      JSON.stringify(recordSchema.parse(record)) + "\n",
      { mode: 0o600 },
    );
    this.record = record;
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
