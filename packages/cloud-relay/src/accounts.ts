// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { openSync, closeSync, fchmodSync, chmodSync, existsSync } from "node:fs";
import Database from "better-sqlite3";
import { z } from "zod";
import { OmnesisAccounts } from "./omnesis-accounts.js";
import { RelayError } from "./tunnels.js";
import { bindingOrigin, certificateFingerprint, type GatewayBinding } from "./gateway-binding.js";

import { keyBindingOwnerAccount } from "./gateway-key-auth.js";
import { hostedGatewayLabel } from "./hosted-name.js";
import type { RecoveryReceipt } from "./recovery-contract.js";

export const gatewayIdSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

/**
 * What a hosted name keeps of a gateway whose registration was removed: enough for that same
 * gateway to ask for its address again, and nothing that says which gateway it was.
 */
const releasedGateway = (gatewayId: string) =>
  `sha256:${createHash("sha256").update(`omnesis-released-gateway:${gatewayId}`).digest("hex")}`;

/** Gateway ownership stays independent; one Google identity may discover several gateway owners. */
export class RelayAccounts {
  private readonly db: Database.Database;
  readonly identities: OmnesisAccounts;

  constructor(
    path: string,
    private readonly maxAccounts = 100,
  ) {
    if (!Number.isSafeInteger(maxAccounts) || maxAccounts <= 0)
      throw new Error("Account limit must be a positive integer");
    if (path !== ":memory:") {
      const descriptor = openSync(path, "a", 0o600);
      try {
        fchmodSync(descriptor, 0o600);
      } finally {
        closeSync(descriptor);
      }
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600);
      }
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.identities = new OmnesisAccounts(this.db, maxAccounts);
    this.db.exec(`CREATE TABLE IF NOT EXISTS relay_accounts (
      account_id TEXT PRIMARY KEY,
      gateway_id TEXT UNIQUE
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS relay_gateway_bindings (
      account_id TEXT PRIMARY KEY,
      hostname TEXT UNIQUE NOT NULL,
      binding TEXT NOT NULL
    )`);
    // Never deleted: a hosted name its gateway stopped using must not pass to a ground id. Once
    // its gateway's registration is removed the row keeps a digest of the id in place of the id.
    this.db.exec(`CREATE TABLE IF NOT EXISTS relay_hosted_names (
      hostname TEXT PRIMARY KEY,
      gateway_id TEXT NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS relay_identity_aliases (
      identity_account_id TEXT NOT NULL,
      routing_account_id TEXT NOT NULL UNIQUE,
      link_seal TEXT,
      PRIMARY KEY(identity_account_id, routing_account_id)
    )`);
    this.migrateGoogleLinks();
    const bindingColumns = this.db.pragma("table_info(relay_gateway_bindings)") as {
      name: string;
    }[];
    if (!bindingColumns.some((column) => column.name === "display_name"))
      this.db.exec("ALTER TABLE relay_gateway_bindings ADD COLUMN display_name TEXT");
    this.db.exec(`CREATE TABLE IF NOT EXISTS relay_gateway_recovery (
      account_id TEXT PRIMARY KEY,
      receipt TEXT NOT NULL
    )`);
  }

  registerAccount(id: string): void {
    if (this.googleGatewayLinks(id).length > 0) return;
    if (this.db.prepare("SELECT 1 FROM relay_accounts WHERE account_id = ?").get(id)) return;
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM relay_accounts").get() as {
      count: number;
    };
    if (count.count >= this.maxAccounts) throw new RelayError(503, "Account capacity reached");
    this.db.prepare("INSERT OR IGNORE INTO relay_accounts(account_id) VALUES (?)").run(id);
  }

  bindGateway(account: string, gateway: string): boolean {
    const canonical = gatewayIdSchema.parse(gateway);
    const result = this.db
      .prepare(
        `UPDATE relay_accounts SET gateway_id = ?
      WHERE account_id = ? AND (gateway_id IS NULL OR lower(gateway_id) = ?)
      AND NOT EXISTS (SELECT 1 FROM relay_accounts WHERE lower(gateway_id) = ? AND account_id != ?)`,
      )
      .run(canonical, account, canonical, canonical, account);
    return result.changes === 1;
  }

  snapshot(): {
    accounts: number;
    maxAccounts: number;
    gatewayBindings: number;
    googleLinks: number;
  } {
    const count = (
      table: "relay_accounts" | "relay_gateway_bindings" | "relay_identity_aliases",
    ): number =>
      (this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    return {
      accounts: count("relay_accounts"),
      maxAccounts: this.maxAccounts,
      gatewayBindings: count("relay_gateway_bindings"),
      googleLinks: count("relay_identity_aliases"),
    };
  }

  close(): void {
    this.db.close();
  }

  /** False when the name is bound or reserved for a gateway with another id. */
  hostnameAvailable(hostname: string, gateway: string): boolean {
    const canonical = gatewayIdSchema.parse(gateway);
    const reserved = this.db
      .prepare("SELECT gateway_id FROM relay_hosted_names WHERE hostname = ?")
      .get(hostname) as { gateway_id: string } | undefined;
    const owner = this.accountForHostname(hostname);
    return (
      (reserved === undefined ||
        [canonical, releasedGateway(canonical)].includes(reserved.gateway_id)) &&
      (owner === undefined ||
        gatewayIdSchema.parse(this.gatewayBinding(owner)!.gatewayId) === canonical)
    );
  }

  /**
   * The single grant of a routing name. A hosted name is derived from a short hash, so another
   * id deriving it earns nothing: the name stays with the first gateway bound to it.
   */
  registerBinding(account: string, binding: GatewayBinding): void {
    this.db.transaction(() => {
      const hostname = bindingOrigin(binding.publicOrigin).hostname;
      const owner = this.accountForHostname(hostname);
      if (
        (owner !== undefined && owner !== account) ||
        !this.hostnameAvailable(hostname, binding.gatewayId)
      )
        throw new RelayError(409, "Hostname already registered");
      if (!this.bindGateway(account, binding.gatewayId))
        throw new RelayError(409, "Gateway binding conflict");
      if (hostname.startsWith(`${hostedGatewayLabel(binding.gatewayId)}.`))
        this.db
          .prepare(
            `INSERT INTO relay_hosted_names(hostname, gateway_id) VALUES (?, ?)
            ON CONFLICT(hostname) DO UPDATE SET gateway_id=excluded.gateway_id`,
          )
          .run(hostname, gatewayIdSchema.parse(binding.gatewayId));
      this.db
        .prepare(
          `INSERT INTO relay_gateway_bindings(account_id, hostname, binding) VALUES (?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET hostname=excluded.hostname, binding=excluded.binding`,
        )
        .run(account, hostname, JSON.stringify(binding));
    })();
  }

  private migrateGoogleLinks(): void {
    const columns = this.db.pragma("table_info(relay_identity_aliases)") as {
      name: string;
      pk: number;
    }[];
    if (columns.find((column) => column.name === "routing_account_id")!.pk === 2) return;
    this.db.transaction(() => {
      this.db.exec(`ALTER TABLE relay_identity_aliases RENAME TO relay_identity_aliases_single;
        CREATE TABLE relay_identity_aliases (
          identity_account_id TEXT NOT NULL,
          routing_account_id TEXT NOT NULL UNIQUE,
          link_seal TEXT,
          PRIMARY KEY(identity_account_id, routing_account_id)
        );
        INSERT INTO relay_identity_aliases(identity_account_id, routing_account_id)
          SELECT identity_account_id, routing_account_id FROM relay_identity_aliases_single;
        DROP TABLE relay_identity_aliases_single;`);
    })();
  }

  googleGatewayLinks(identityAccount: string): { ownerAccount: string; seal?: string }[] {
    const rows = this.db
      .prepare(
        `SELECT routing_account_id, link_seal FROM relay_identity_aliases
      WHERE identity_account_id = ? ORDER BY routing_account_id`,
      )
      .all(identityAccount) as { routing_account_id: string; link_seal: string | null }[];
    return rows.map((row) => ({
      ownerAccount: row.routing_account_id,
      ...(row.link_seal === null ? {} : { seal: row.link_seal }),
    }));
  }

  gatewayAccounts(identityAccount: string): string[] {
    const owners = this.googleGatewayLinks(identityAccount).map((link) => link.ownerAccount);
    if (
      this.db
        .prepare("SELECT 1 FROM relay_gateway_bindings WHERE account_id = ?")
        .get(identityAccount)
    )
      owners.push(identityAccount);
    return [...new Set(owners)].sort();
  }

  resolveAccount(identityAccount: string): string {
    const owners = this.gatewayAccounts(identityAccount);
    // An identity with multiple choices must never be silently routed to an arbitrary gateway.
    return owners.length === 1 ? owners[0]! : identityAccount;
  }

  /** Fresh Google authorization attaches another gateway without changing its cryptographic owner. */
  linkGoogleAccount(googleAccount: string, ownerAccount: string, seal?: string): void {
    this.db.transaction(() => {
      if (googleAccount === ownerAccount || this.googleGatewayLinks(ownerAccount).length > 0)
        throw new RelayError(409, "Identity alias conflict");
      const other = this.googleAccountForOwner(ownerAccount);
      const binding = this.gatewayBinding(ownerAccount);
      const google = this.db
        .prepare("SELECT gateway_id FROM relay_accounts WHERE account_id = ?")
        .get(googleAccount) as { gateway_id: string | null } | undefined;
      const ownBinding = this.gatewayBinding(googleAccount);
      if (
        (other !== undefined && other !== googleAccount) ||
        !binding ||
        keyBindingOwnerAccount(binding) !== ownerAccount ||
        (google?.gateway_id && !ownBinding) ||
        (ownBinding !== undefined && keyBindingOwnerAccount(ownBinding) !== undefined)
      )
        throw new RelayError(409, "Identity alias conflicts with an existing gateway");
      this.db
        .prepare("DELETE FROM relay_accounts WHERE account_id = ? AND gateway_id IS NULL")
        .run(googleAccount);
      this.db
        .prepare(
          `INSERT INTO relay_identity_aliases(identity_account_id, routing_account_id, link_seal)
        VALUES (?, ?, ?) ON CONFLICT(identity_account_id, routing_account_id)
        DO UPDATE SET link_seal=excluded.link_seal`,
        )
        .run(googleAccount, ownerAccount, seal ?? null);
    })();
  }

  gatewayDisplayName(account: string): string | undefined {
    const row = this.db
      .prepare("SELECT display_name FROM relay_gateway_bindings WHERE account_id = ?")
      .get(account) as { display_name: string | null } | undefined;
    return row?.display_name ?? undefined;
  }

  setGatewayDisplayName(account: string, value: string): void {
    const name = z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[^\u0000-\u001f\u007f]+$/)
      .parse(value);
    const result = this.db
      .prepare("UPDATE relay_gateway_bindings SET display_name = ? WHERE account_id = ?")
      .run(name, account);
    if (result.changes !== 1) throw new RelayError(404, "Gateway not registered");
  }

  googleGatewayLinkForOwner(
    ownerAccount: string,
  ): { googleAccount: string; seal?: string } | undefined {
    const row = this.db
      .prepare(
        "SELECT identity_account_id, link_seal FROM relay_identity_aliases WHERE routing_account_id = ?",
      )
      .get(ownerAccount) as { identity_account_id: string; link_seal: string | null } | undefined;
    return row === undefined
      ? undefined
      : {
          googleAccount: row.identity_account_id,
          ...(row.link_seal === null ? {} : { seal: row.link_seal }),
        };
  }

  googleAccountForOwner(ownerAccount: string): string | undefined {
    return this.googleGatewayLinkForOwner(ownerAccount)?.googleAccount;
  }

  unlinkGoogleAccount(googleAccount: string, ownerAccount: string): boolean {
    return (
      this.db
        .prepare(
          "DELETE FROM relay_identity_aliases WHERE identity_account_id = ? AND routing_account_id = ?",
        )
        .run(googleAccount, ownerAccount).changes === 1
    );
  }

  ownerForGateway(gatewayId: string): string | undefined {
    const row = this.db
      .prepare("SELECT account_id FROM relay_accounts WHERE lower(gateway_id) = ?")
      .get(gatewayIdSchema.parse(gatewayId)) as { account_id: string } | undefined;
    return row?.account_id;
  }

  private exactLegacyOwner(account: string, binding: GatewayBinding): boolean {
    const existing = this.gatewayBinding(account);
    return (
      existing !== undefined &&
      keyBindingOwnerAccount(existing) === undefined &&
      gatewayIdSchema.parse(existing.gatewayId) === gatewayIdSchema.parse(binding.gatewayId) &&
      bindingOrigin(existing.publicOrigin).origin === bindingOrigin(binding.publicOrigin).origin &&
      certificateFingerprint(existing.certificate) ===
        certificateFingerprint(binding.certificate) &&
      this.resolveAccount(account) === account
    );
  }

  /** Only an existing owner or an exact TLS-proven legacy gateway bypasses first-enrollment invitations. */
  keyEnrollmentExempt(account: string, binding: GatewayBinding): boolean {
    const owner = this.ownerForGateway(binding.gatewayId);
    return owner === account || (owner !== undefined && this.exactLegacyOwner(owner, binding));
  }

  /** Account creation, binding replacement and one-time legacy transfer commit or roll back together. */
  registerKeyBinding(
    account: string,
    binding: GatewayBinding,
    allowNew: boolean,
    receipt?: RecoveryReceipt,
  ): { migratedAccountId?: string } {
    return this.db.transaction(() => {
      if (keyBindingOwnerAccount(binding) !== account)
        throw new RelayError(403, "Invalid gateway owner identity");
      const owner = this.ownerForGateway(binding.gatewayId);
      if (owner !== undefined && owner !== account) {
        if (!this.exactLegacyOwner(owner, binding))
          throw new RelayError(409, "Gateway already has another owner identity");
        this.db.prepare("DELETE FROM relay_gateway_bindings WHERE account_id = ?").run(owner);
        this.db.prepare("DELETE FROM relay_accounts WHERE account_id = ?").run(owner);
        this.db.prepare("DELETE FROM relay_gateway_recovery WHERE account_id = ?").run(owner);
        this.registerAccount(account);
        this.registerBinding(account, binding);
        if (receipt !== undefined) this.saveRecoveryReceipt(account, receipt);
        this.linkGoogleAccount(owner, account);
        return { migratedAccountId: owner };
      }
      if (owner === undefined && !allowNew)
        throw new RelayError(403, "A gateway enrollment invitation is required");
      this.registerAccount(account);
      this.registerBinding(account, binding);
      if (receipt !== undefined) this.saveRecoveryReceipt(account, receipt);
      return {};
    })();
  }

  private saveRecoveryReceipt(account: string, receipt: RecoveryReceipt): void {
    this.db
      .prepare(
        `INSERT INTO relay_gateway_recovery(account_id, receipt) VALUES (?, ?)
      ON CONFLICT(account_id) DO UPDATE SET receipt=excluded.receipt`,
      )
      .run(account, JSON.stringify(receipt));
  }

  /** Receipt rows are untrusted until independently verified against the current policy and binding. */
  gatewayRecoveryReceipt(account: string): unknown {
    const row = this.db
      .prepare(
        `SELECT receipt FROM relay_gateway_recovery
      WHERE account_id = ? AND length(receipt) <= 65536`,
      )
      .get(account) as { receipt: unknown } | undefined;
    return typeof row?.receipt === "string" ? JSON.parse(row.receipt) : undefined;
  }

  /** Whether this routing account still has a row here. A deleted gateway's session finds none. */
  registered(account: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM relay_accounts WHERE account_id = ?").get(account) !==
      undefined
    );
  }

  /**
   * Deletes an Omnesis account and the registration of every gateway connected to it, together or
   * not at all. Returns the routing accounts that no longer exist; the caller ends their tunnels
   * and DNS challenge leases.
   */
  deleteAccount(account: string, expectedVersion?: number): string[] {
    return this.db.transaction(() => {
      const { owners, identities } = this.identities.delete(account, expectedVersion);
      const removed = [...new Set([...owners, ...identities])];
      for (const id of removed) this.removeRegistration(id);
      return removed;
    })();
  }

  /**
   * Takes one gateway out of its account and drops its registration, at its owner's request. The
   * account stays, with its other gateways.
   */
  deleteGateway(owner: string): void {
    this.db.transaction(() => {
      this.identities.unlinkGatewayOwner(owner);
      this.removeRegistration(owner);
    })();
  }

  /**
   * A hosted name stops routing and stays held for the gateway it was granted to, by a digest of
   * its id: the label is short enough to be ground, and that gateway's devices still know it.
   */
  private removeRegistration(account: string): void {
    const gateway = this.db
      .prepare("SELECT lower(gateway_id) AS id FROM relay_accounts WHERE account_id = ?")
      .get(account) as { id: string | null } | undefined;
    if (gateway?.id)
      this.db
        .prepare("UPDATE relay_hosted_names SET gateway_id = ? WHERE gateway_id = ?")
        .run(releasedGateway(gateway.id), gateway.id);
    for (const table of ["relay_gateway_bindings", "relay_gateway_recovery", "relay_accounts"])
      this.db.prepare(`DELETE FROM ${table} WHERE account_id = ?`).run(account);
    this.db
      .prepare(
        "DELETE FROM relay_identity_aliases WHERE identity_account_id = ? OR routing_account_id = ?",
      )
      .run(account, account);
  }

  accountForHostname(hostname: string): string | undefined {
    const row = this.db
      .prepare("SELECT account_id FROM relay_gateway_bindings WHERE hostname = ?")
      .get(hostname) as { account_id: string } | undefined;
    return row?.account_id;
  }

  gatewayBinding(account: string): GatewayBinding | undefined {
    const row = this.db
      .prepare("SELECT binding FROM relay_gateway_bindings WHERE account_id = ?")
      .get(account) as { binding: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.binding) as GatewayBinding);
  }
}
