// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  passkeyCountersignatureSchema,
  signInDigest,
  signInProofSchema,
  type PasskeyCountersignature,
  type SignInProof,
} from "./device-enrollment.js";
import { ACCOUNT_SESSION_SECONDS } from "./identity.js";
import { RelayError } from "./tunnels.js";
import type { AccountAdmission } from "./account-admission.js";
import type Database from "better-sqlite3";
import type { WebAuthnCredential, CredentialDeviceType } from "@simplewebauthn/server";

const accountIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const providerSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const labelSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const MAX_CREDENTIALS = 16;
/** What a new account agreed to. There are no account terms yet; name the version once there are. */
export const ACCOUNT_TERMS_VERSION = "none";

export interface StoredPasskey {
  accountId: string;
  credential: WebAuthnCredential;
  deviceType: CredentialDeviceType;
  backedUp: boolean;
  revision: number;
}
export interface PasskeyRegistration {
  credential: WebAuthnCredential;
  deviceType: CredentialDeviceType;
  backedUp: boolean;
  label: string;
}

/** Account IDs are random and permanent. Provider identities and public passkeys are replaceable credentials. */
export class OmnesisAccounts {
  constructor(
    private readonly db: Database.Database,
    private readonly maxAccounts = 100,
  ) {
    if (!Number.isSafeInteger(maxAccounts) || maxAccounts <= 0)
      throw new Error("Invalid account capacity");
    db.exec(`CREATE TABLE IF NOT EXISTS omnesis_accounts (
      account_id TEXT PRIMARY KEY, session_version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS omnesis_federated_credentials (
      provider TEXT NOT NULL, subject_digest TEXT NOT NULL, account_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY(provider, subject_digest)
    );
    CREATE TABLE IF NOT EXISTS omnesis_passkeys (
      credential_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, public_key BLOB NOT NULL,
      counter INTEGER NOT NULL, transports TEXT NOT NULL, device_type TEXT NOT NULL,
      backed_up INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      label TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS omnesis_account_sessions (
      session_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, session_version INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS omnesis_sessions_account ON omnesis_account_sessions(account_id);
    CREATE INDEX IF NOT EXISTS omnesis_sessions_expiry ON omnesis_account_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS omnesis_google_aliases (legacy_digest TEXT PRIMARY KEY, subject_digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS omnesis_gateway_links (
      account_id TEXT NOT NULL, owner_account_id TEXT NOT NULL UNIQUE, link_seal TEXT NOT NULL,
      PRIMARY KEY(account_id, owner_account_id)
    );
    CREATE TABLE IF NOT EXISTS omnesis_account_admissions (
      gateway_id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL, account_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS omnesis_federated_account ON omnesis_federated_credentials(account_id);
    CREATE TABLE IF NOT EXISTS omnesis_account_consents (
      account_id TEXT PRIMARY KEY, terms_version TEXT NOT NULL, accepted_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS omnesis_passkey_endorsements (
      credential_id TEXT PRIMARY KEY, proof TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS omnesis_passkey_countersignatures (
      credential_id TEXT PRIMARY KEY, countersignature TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS omnesis_passkeys_account ON omnesis_passkeys(account_id);`);
  }

  /** Aggregate operator counters never expose account identifiers or credential material. */
  snapshot(): {
    identityAccounts: number;
    identityPasskeys: number;
    identityFederatedCredentials: number;
    identityGatewayLinks: number;
    identityActiveSessions: number;
  } {
    return this.db
      .prepare(
        `SELECT
      (SELECT count(*) FROM omnesis_accounts) AS identityAccounts,
      (SELECT count(*) FROM omnesis_passkeys) AS identityPasskeys,
      (SELECT count(*) FROM omnesis_federated_credentials) AS identityFederatedCredentials,
      (SELECT count(*) FROM omnesis_gateway_links) AS identityGatewayLinks,
      (SELECT count(*) FROM omnesis_account_sessions s JOIN omnesis_accounts a ON a.account_id=s.account_id
        WHERE s.expires_at>? AND s.session_version=a.session_version) AS identityActiveSessions
    `,
      )
      .get(Math.floor(Date.now() / 1000)) as ReturnType<OmnesisAccounts["snapshot"]>;
  }

  static newId(): string {
    return randomBytes(32).toString("hex");
  }

  sessionVersion(account: string): number | undefined {
    const row = this.db
      .prepare("SELECT session_version FROM omnesis_accounts WHERE account_id = ?")
      .get(account) as { session_version: number } | undefined;
    return row?.session_version;
  }

  federatedAccount(provider: string, subjectDigest: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT account_id FROM omnesis_federated_credentials WHERE provider = ? AND subject_digest = ?",
      )
      .get(providerSchema.parse(provider), accountIdSchema.parse(subjectDigest)) as
      { account_id: string } | undefined;
    return row?.account_id;
  }

  /** The caller must verify the provider proof before invoking sign-in or linking. Email is never an account key. */
  signInFederated(provider: string, subjectDigest: string, admission?: AccountAdmission): string {
    return this.db.transaction(() => {
      const existing = this.federatedAccount(provider, subjectDigest);
      if (existing !== undefined) return existing;
      const account = OmnesisAccounts.newId();
      this.create(account, admission);
      this.linkFederated(account, provider, subjectDigest);
      return account;
    })();
  }

  linkFederated(
    account: string,
    provider: string,
    subjectDigest: string,
    expectedVersion?: number,
  ): void {
    this.db.transaction(() => {
      this.requireAccount(account);
      this.requireVersion(account, expectedVersion);
      providerSchema.parse(provider);
      accountIdSchema.parse(subjectDigest);
      const owner = this.federatedAccount(provider, subjectDigest);
      if (owner === account) return;
      if (owner !== undefined)
        throw new RelayError(409, "Credential belongs to another Omnesis account");
      this.admitCredential(account);
      this.db
        .prepare("INSERT INTO omnesis_federated_credentials VALUES (?,?,?,?)")
        .run(provider, subjectDigest, account, Date.now());
    })();
  }

  /** New accounts are committed only after a successful verified registration ceremony. */
  registerPasskey(
    account: string,
    input: PasskeyRegistration,
    newAccount: boolean,
    expectedVersion?: number,
    admission?: AccountAdmission,
    /** The sign-in that vouched for this passkey, kept for gateways to verify themselves. */
    endorsement?: SignInProof,
    /** This passkey's own signature over the account's other sign-ins, likewise. */
    countersignature?: PasskeyCountersignature,
  ): void {
    this.db.transaction(() => {
      if (newAccount) this.create(account, admission);
      else this.requireAccount(account);
      this.requireVersion(account, expectedVersion);
      this.admitCredential(account);
      const label = labelSchema.parse(input.label);
      if (
        !/^[A-Za-z0-9_-]{1,2048}$/.test(input.credential.id) ||
        input.credential.publicKey.length < 1 ||
        input.credential.publicKey.length > 4096 ||
        !Number.isSafeInteger(input.credential.counter) ||
        input.credential.counter < 0 ||
        !["singleDevice", "multiDevice"].includes(input.deviceType) ||
        (input.deviceType === "singleDevice" && input.backedUp)
      )
        throw new RelayError(400, "Invalid public passkey credential");
      if (this.passkey(input.credential.id) !== undefined)
        throw new RelayError(409, "Passkey is already registered");
      this.db
        .prepare(
          "INSERT INTO omnesis_passkeys (credential_id,account_id,public_key,counter,transports,device_type,backed_up,label,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(
          input.credential.id,
          account,
          Buffer.from(input.credential.publicKey),
          input.credential.counter,
          JSON.stringify(input.credential.transports ?? []),
          input.deviceType,
          Number(input.backedUp),
          label,
          Date.now(),
        );
      if (endorsement)
        this.db
          .prepare("INSERT OR REPLACE INTO omnesis_passkey_endorsements VALUES (?,?)")
          .run(input.credential.id, JSON.stringify(signInProofSchema.parse(endorsement)));
      if (countersignature && this.namesOnlyCurrent(account, countersignature, input.credential.id))
        this.db
          .prepare("INSERT OR REPLACE INTO omnesis_passkey_countersignatures VALUES (?,?)")
          .run(
            input.credential.id,
            JSON.stringify(passkeyCountersignatureSchema.parse(countersignature)),
          );
    })();
  }

  passkey(id: string): StoredPasskey | undefined {
    const row = this.db
      .prepare("SELECT * FROM omnesis_passkeys WHERE credential_id = ?")
      .get(id) as
      | {
          account_id: string;
          public_key: Buffer;
          counter: number;
          transports: string;
          device_type: CredentialDeviceType;
          backed_up: number;
          revision: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      accountId: row.account_id,
      credential: {
        id,
        publicKey: new Uint8Array(row.public_key),
        counter: row.counter,
        transports: JSON.parse(row.transports) as WebAuthnCredential["transports"],
      },
      deviceType: row.device_type,
      backedUp: row.backed_up === 1,
      revision: row.revision,
    };
  }

  /** Revision CAS prevents revoked credentials and concurrent stale verifications, including synced zero counters. */
  recordAuthentication(
    stored: StoredPasskey,
    counter: number,
    deviceType: CredentialDeviceType,
    backedUp: boolean,
  ): void {
    if (
      !Number.isSafeInteger(counter) ||
      counter < 0 ||
      counter < stored.credential.counter ||
      deviceType !== stored.deviceType ||
      (deviceType === "singleDevice" && backedUp)
    )
      throw new RelayError(403, "Passkey authentication refused");
    const changed = this.db
      .prepare(
        "UPDATE omnesis_passkeys SET counter=?, backed_up=?, last_used_at=?, revision=revision+1 WHERE credential_id=? AND account_id=? AND revision=? AND EXISTS (SELECT 1 FROM omnesis_accounts WHERE account_id=?)",
      )
      .run(
        counter,
        Number(backedUp),
        Date.now(),
        stored.credential.id,
        stored.accountId,
        stored.revision,
        stored.accountId,
      ).changes;
    if (changed !== 1) throw new RelayError(403, "Passkey changed; sign in again");
  }

  list(account: string): {
    federated: { provider: string; createdAt: number }[];
    passkeys: {
      id: string;
      label: string;
      deviceType: CredentialDeviceType;
      backedUp: boolean;
      createdAt: number;
      lastUsedAt: number | null;
    }[];
  } {
    this.requireAccount(account);
    const federated = this.db
      .prepare(
        "SELECT provider,created_at AS createdAt FROM omnesis_federated_credentials WHERE account_id=? ORDER BY created_at,provider",
      )
      .all(account) as { provider: string; createdAt: number }[];
    const keys = this.db
      .prepare(
        "SELECT credential_id AS id,label,device_type AS deviceType,backed_up AS backedUp,created_at AS createdAt,last_used_at AS lastUsedAt FROM omnesis_passkeys WHERE account_id=? ORDER BY created_at,credential_id",
      )
      .all(account) as {
      id: string;
      label: string;
      deviceType: CredentialDeviceType;
      backedUp: number;
      createdAt: number;
      lastUsedAt: number | null;
    }[];
    return { federated, passkeys: keys.map((key) => ({ ...key, backedUp: key.backedUp === 1 })) };
  }

  federatedDigests(account: string, provider: string): string[] {
    this.requireAccount(account);
    return (
      this.db
        .prepare(
          "SELECT subject_digest FROM omnesis_federated_credentials WHERE account_id=? AND provider=? ORDER BY subject_digest",
        )
        .all(account, provider) as { subject_digest: string }[]
    ).map((row) => row.subject_digest);
  }

  /**
   * Each passkey's id and public key: what a gateway pins and checks a pin against. A passkey
   * added to an existing account also carries the sign-in that vouched for it, and its own
   * countersignature of the sign-ins the account had then.
   */
  passkeyKeys(account: string): {
    id: string;
    publicKey: string;
    endorsement?: SignInProof;
    countersignature?: PasskeyCountersignature;
  }[] {
    this.requireAccount(account);
    return (
      this.db
        .prepare(
          "SELECT p.credential_id AS id, p.public_key, e.proof, c.countersignature FROM omnesis_passkeys AS p LEFT JOIN omnesis_passkey_endorsements AS e USING(credential_id) LEFT JOIN omnesis_passkey_countersignatures AS c USING(credential_id) WHERE p.account_id=? ORDER BY p.created_at,p.credential_id",
        )
        .all(account) as {
        id: string;
        public_key: Buffer;
        proof: string | null;
        countersignature: string | null;
      }[]
    ).map((row) => ({
      id: row.id,
      publicKey: row.public_key.toString("base64url"),
      ...(row.proof ? { endorsement: signInProofSchema.parse(JSON.parse(row.proof)) } : {}),
      ...(row.countersignature
        ? {
            countersignature: passkeyCountersignatureSchema.parse(JSON.parse(row.countersignature)),
          }
        : {}),
    }));
  }

  /** Verified Google issuer variants share one credential without exposing additional sign-in methods. */
  bindGoogleAliases(digest: string, legacyDigests: readonly string[]): void {
    accountIdSchema.parse(digest);
    if (this.federatedAccount("google", digest) === undefined)
      throw new RelayError(404, "Google credential not linked");
    this.db.transaction(() => {
      for (const legacy of legacyDigests) {
        accountIdSchema.parse(legacy);
        const row = this.db
          .prepare("SELECT subject_digest FROM omnesis_google_aliases WHERE legacy_digest=?")
          .get(legacy) as { subject_digest: string } | undefined;
        if (row !== undefined && row.subject_digest !== digest)
          throw new RelayError(409, "Google identity alias conflicts");
        this.db
          .prepare("INSERT OR IGNORE INTO omnesis_google_aliases VALUES (?,?)")
          .run(legacy, digest);
      }
    })();
  }

  legacyGoogleAccount(legacyDigest: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT credentials.account_id FROM omnesis_google_aliases AS aliases JOIN omnesis_federated_credentials AS credentials ON credentials.provider='google' AND credentials.subject_digest=aliases.subject_digest WHERE aliases.legacy_digest=?",
      )
      .get(legacyDigest) as { account_id: string } | undefined;
    return row?.account_id;
  }

  gatewayLinks(account: string): { ownerAccount: string; seal: string }[] {
    this.requireAccount(account);
    return this.db
      .prepare(
        "SELECT owner_account_id AS ownerAccount,link_seal AS seal FROM omnesis_gateway_links WHERE account_id=? ORDER BY owner_account_id",
      )
      .all(account) as { ownerAccount: string; seal: string }[];
  }

  gatewayAccount(owner: string): { accountId: string; seal: string } | undefined {
    return this.db
      .prepare(
        "SELECT account_id AS accountId,link_seal AS seal FROM omnesis_gateway_links WHERE owner_account_id=?",
      )
      .get(owner) as { accountId: string; seal: string } | undefined;
  }

  linkGateway(
    account: string,
    owner: string,
    seal: string,
    replaceUntrusted?: (existing: { accountId: string; seal: string }) => boolean,
  ): void {
    this.db.transaction(() => {
      this.requireAccount(account);
      accountIdSchema.parse(owner);
      if (!/^[A-Za-z0-9_-]{43}$/.test(seal))
        throw new RelayError(400, "Invalid gateway association");
      const existing = this.gatewayAccount(owner);
      if (existing !== undefined && existing.accountId !== account && !replaceUntrusted?.(existing))
        throw new RelayError(409, "Gateway is linked to another Omnesis account");
      this.db
        .prepare(
          "INSERT INTO omnesis_gateway_links VALUES (?,?,?) ON CONFLICT(owner_account_id) DO UPDATE SET account_id=excluded.account_id,link_seal=excluded.link_seal",
        )
        .run(account, owner, seal);
    })();
  }

  unlinkGateway(account: string, owner: string): void {
    this.requireAccount(account);
    this.db
      .prepare("DELETE FROM omnesis_gateway_links WHERE account_id=? AND owner_account_id=?")
      .run(account, owner);
  }

  registerSession(account: string, version: number, sessionId: string, expiresAt: number): void {
    this.db.transaction(() => {
      this.requireAccount(account);
      this.requireVersion(account, version);
      z.string().uuid().parse(sessionId);
      const now = Math.floor(Date.now() / 1000);
      if (
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= now ||
        expiresAt > now + ACCOUNT_SESSION_SECONDS
      )
        throw new RelayError(400, "Invalid account session expiry");
      this.db.prepare("DELETE FROM omnesis_account_sessions WHERE expires_at<=?").run(now);
      const old = this.db
        .prepare(
          "SELECT session_id FROM omnesis_account_sessions WHERE account_id=? ORDER BY created_at DESC,session_id DESC LIMIT -1 OFFSET 31",
        )
        .all(account) as { session_id: string }[];
      for (const row of old)
        this.db
          .prepare("DELETE FROM omnesis_account_sessions WHERE session_id=?")
          .run(row.session_id);
      this.db
        .prepare("INSERT INTO omnesis_account_sessions VALUES (?,?,?,?,?)")
        .run(sessionId, account, version, expiresAt, Date.now());
    })();
  }

  /** The authenticated gateway owner can remove its discovery association independently of account credentials. */
  unlinkGatewayOwner(owner: string): void {
    accountIdSchema.parse(owner);
    this.db.prepare("DELETE FROM omnesis_gateway_links WHERE owner_account_id=?").run(owner);
  }

  /**
   * Deletes an account with every way to sign in to it, its sessions and its gateway links.
   * Returns the gateway owners that were linked to it and each identity its federated sign-ins
   * were known by, so the routing tables can drop what they hold for them in the same transaction.
   */
  delete(account: string, expectedVersion?: number): { owners: string[]; identities: string[] } {
    return this.db.transaction(() => {
      this.requireAccount(account);
      this.requireVersion(account, expectedVersion);
      const owners = this.gatewayLinks(account).map((link) => link.ownerAccount);
      const identities = new Set<string>();
      const digests = this.db
        .prepare("SELECT subject_digest FROM omnesis_federated_credentials WHERE account_id=?")
        .all(account) as { subject_digest: string }[];
      for (const { subject_digest: digest } of digests) {
        identities.add(digest);
        const aliases = this.db
          .prepare("SELECT legacy_digest FROM omnesis_google_aliases WHERE subject_digest=?")
          .all(digest) as { legacy_digest: string }[];
        for (const alias of aliases) identities.add(alias.legacy_digest);
        this.db.prepare("DELETE FROM omnesis_google_aliases WHERE subject_digest=?").run(digest);
      }
      // A gateway that goes with the account leaves no link or allocation behind, whoever held it.
      for (const owner of new Set([...owners, ...identities]))
        for (const table of ["omnesis_gateway_links", "omnesis_account_admissions"])
          this.db.prepare(`DELETE FROM ${table} WHERE owner_account_id=?`).run(owner);
      this.discard(account);
      return { owners, identities: [...identities] };
    })();
  }

  activeSession(account: string, version: number, sessionId: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM omnesis_account_sessions AS sessions JOIN omnesis_accounts AS accounts USING(account_id) WHERE sessions.account_id=? AND sessions.session_id=? AND sessions.session_version=? AND accounts.session_version=? AND sessions.expires_at>?",
        )
        .get(account, sessionId, version, version, Math.floor(Date.now() / 1000)) !== undefined
    );
  }

  revokeSession(account: string, sessionId: string): void {
    this.db
      .prepare("DELETE FROM omnesis_account_sessions WHERE account_id=? AND session_id=?")
      .run(account, sessionId);
  }

  removePasskey(
    account: string,
    id: string,
    providers: readonly string[],
    expectedVersion?: number,
  ): void {
    this.remove(account, providers, expectedVersion, () => {
      const key = this.db
        .prepare("SELECT public_key FROM omnesis_passkeys WHERE account_id=? AND credential_id=?")
        .get(account, id) as { public_key: Buffer } | undefined;
      const removed = this.db
        .prepare("DELETE FROM omnesis_passkeys WHERE account_id=? AND credential_id=?")
        .run(account, id).changes;
      if (key)
        this.forgetCountersignaturesNaming(
          account,
          signInDigest({ type: "passkey", id, publicKey: key.public_key.toString("base64url") }),
        );
      // A removal that matched nothing throws below, which rolls this back too.
      this.db.prepare("DELETE FROM omnesis_passkey_endorsements WHERE credential_id=?").run(id);
      this.db
        .prepare("DELETE FROM omnesis_passkey_countersignatures WHERE credential_id=?")
        .run(id);
      return removed;
    });
  }

  unlinkFederated(
    account: string,
    provider: string,
    subjectDigest: string,
    providers: readonly string[],
    expectedVersion?: number,
  ): void {
    this.remove(account, providers, expectedVersion, () => {
      if (provider === "google")
        this.forgetCountersignaturesNaming(
          account,
          signInDigest({ type: "google", id: subjectDigest }),
        );
      return this.db
        .prepare(
          "DELETE FROM omnesis_federated_credentials WHERE account_id=? AND provider=? AND subject_digest=?",
        )
        .run(account, provider, subjectDigest).changes;
    });
  }

  /**
   * Whether every sign-in a countersignature names is still on the account. One was signed for
   * the account as it stood when the passkey was created; a sign-in removed before the passkey
   * is stored must not be named by evidence stored after the removal, so the countersignature is
   * dropped and the passkey is stored with its endorsement only.
   */
  private namesOnlyCurrent(
    account: string,
    countersignature: PasskeyCountersignature,
    except: string,
  ): boolean {
    const current = new Set([
      ...this.federatedDigests(account, "google").map((id) => signInDigest({ type: "google", id })),
      ...this.passkeyKeys(account)
        .filter(({ id }) => id !== except)
        .map(({ id, publicKey }) => signInDigest({ type: "passkey", id, publicKey })),
    ]);
    return countersignature.signIns.every((name) => current.has(name));
  }

  /**
   * A countersignature that names a removed sign-in would let a relay compromised later list that
   * sign-in again and have a gateway that never saw the removal trust it, so it goes with the
   * sign-in. The passkeys that made it keep their other trust; one signature can't be edited.
   */
  private forgetCountersignaturesNaming(account: string, name: string): void {
    const rows = this.db
      .prepare(
        "SELECT c.credential_id AS id, c.countersignature FROM omnesis_passkey_countersignatures AS c JOIN omnesis_passkeys AS p USING(credential_id) WHERE p.account_id=?",
      )
      .all(account) as { id: string; countersignature: string }[];
    for (const row of rows)
      if (
        passkeyCountersignatureSchema.parse(JSON.parse(row.countersignature)).signIns.includes(name)
      )
        this.db
          .prepare("DELETE FROM omnesis_passkey_countersignatures WHERE credential_id=?")
          .run(row.id);
  }

  private remove(
    account: string,
    providers: readonly string[],
    expectedVersion: number | undefined,
    remove: () => number,
  ): void {
    this.db.transaction(() => {
      this.requireAccount(account);
      this.requireVersion(account, expectedVersion);
      const enabled = z.array(providerSchema).max(16).parse(providers);
      if (remove() !== 1) throw new RelayError(404, "Credential not found on this account");
      const usable = (
        this.db
          .prepare(
            "SELECT (SELECT count(*) FROM omnesis_passkeys WHERE account_id=?) + (SELECT count(*) FROM omnesis_federated_credentials WHERE account_id=? AND provider IN (SELECT value FROM json_each(?))) AS count",
          )
          .get(account, account, JSON.stringify(enabled)) as { count: number }
      ).count;
      if (usable === 0) throw new RelayError(409, "Keep at least one sign-in credential");
      this.db
        .prepare("UPDATE omnesis_accounts SET session_version=session_version+1 WHERE account_id=?")
        .run(account);
    })();
  }

  /**
   * One gateway holds one account it created. It may create another only once it is no longer
   * connected to that account, which is what a person who starts over with a different sign-in
   * has done.
   */
  canAdmitGateway(gatewayId: string): boolean {
    const previous = this.admitted(gatewayId);
    return (
      previous === undefined ||
      this.db
        .prepare("SELECT 1 FROM omnesis_gateway_links WHERE account_id=? AND owner_account_id=?")
        .get(previous.account, previous.owner) === undefined
    );
  }
  private admitted(gatewayId: string): { account: string; owner: string } | undefined {
    z.string().uuid().parse(gatewayId);
    return this.db
      .prepare(
        "SELECT account_id AS account, owner_account_id AS owner FROM omnesis_account_admissions WHERE gateway_id=?",
      )
      .get(gatewayId) as { account: string; owner: string } | undefined;
  }
  private hasGateway(account: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM omnesis_gateway_links WHERE account_id=?").get(account) !==
      undefined
    );
  }
  /** Removes an account nothing uses any more, with every way to sign in to it. */
  private discard(account: string): void {
    for (const table of [
      "omnesis_passkey_endorsements WHERE credential_id IN (SELECT credential_id FROM omnesis_passkeys WHERE account_id=?)",
      "omnesis_passkey_countersignatures WHERE credential_id IN (SELECT credential_id FROM omnesis_passkeys WHERE account_id=?)",
      "omnesis_passkeys WHERE account_id=?",
      "omnesis_federated_credentials WHERE account_id=?",
      "omnesis_account_sessions WHERE account_id=?",
      "omnesis_account_consents WHERE account_id=?",
      "omnesis_account_admissions WHERE account_id=?",
      "omnesis_accounts WHERE account_id=?",
    ])
      this.db.prepare(`DELETE FROM ${table}`).run(account);
  }

  private create(account: string, admission?: AccountAdmission): void {
    if (admission) {
      admission.assertCurrent();
      accountIdSchema.parse(admission.ownerAccountId);
      if (!this.canAdmitGateway(admission.gatewayId))
        throw new RelayError(
          403,
          "This gateway already allocated an account; sign in to the existing account",
        );
      // This gateway left the account it created earlier. That account stays if another gateway
      // still uses it; otherwise nothing can reach it any more and it makes way for this one.
      const previous = this.admitted(admission.gatewayId)?.account;
      if (previous !== undefined && !this.hasGateway(previous)) this.discard(previous);
    }
    accountIdSchema.parse(account);
    if (
      (this.db.prepare("SELECT count(*) AS count FROM omnesis_accounts").get() as { count: number })
        .count >= this.maxAccounts
    )
      throw new RelayError(503, "Account capacity reached");
    if (this.sessionVersion(account) !== undefined)
      throw new RelayError(409, "Account already exists");
    this.db
      .prepare("INSERT INTO omnesis_accounts (account_id,created_at) VALUES (?,?)")
      .run(account, Date.now());
    // Every account is created by an explicit choice, so there is always a moment of consent.
    this.db
      .prepare("INSERT OR REPLACE INTO omnesis_account_consents VALUES (?,?,?)")
      .run(account, ACCOUNT_TERMS_VERSION, Date.now());
    if (admission)
      this.db
        .prepare("INSERT OR REPLACE INTO omnesis_account_admissions VALUES (?,?,?)")
        .run(admission.gatewayId, admission.ownerAccountId, account);
  }

  private requireVersion(account: string, expected?: number): void {
    if (expected !== undefined && this.sessionVersion(account) !== expected)
      throw new RelayError(401, "Account changed; sign in again");
  }

  private requireAccount(account: string): void {
    accountIdSchema.parse(account);
    if (this.sessionVersion(account) === undefined)
      throw new RelayError(401, "Omnesis account sign-in required");
  }

  private credentialCount(account: string): number {
    return (
      this.db
        .prepare(
          "SELECT (SELECT count(*) FROM omnesis_passkeys WHERE account_id=?) + (SELECT count(*) FROM omnesis_federated_credentials WHERE account_id=?) AS count",
        )
        .get(account, account) as { count: number }
    ).count;
  }

  private admitCredential(account: string): void {
    if (this.credentialCount(account) >= MAX_CREDENTIALS)
      throw new RelayError(409, "Account credential limit reached");
  }
}
