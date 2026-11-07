// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { openSync, closeSync, fchmodSync, chmodSync, existsSync } from "node:fs";
import Database from "better-sqlite3";
import { z } from "zod";
import { RelayError } from "./tunnels.js";
import { bindingOrigin, certificateFingerprint, type GatewayBinding } from "./gateway-binding.js";

import { keyBindingOwnerAccount } from "./gateway-key-auth.js";
import type { RecoveryReceipt } from "./recovery-contract.js";

export const gatewayIdSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

/** Durable one-gateway-per-account binding; sessions and live tunnels stay in memory. */
export class RelayAccounts {
  private readonly db: Database.Database;

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
    this.db.exec(`CREATE TABLE IF NOT EXISTS relay_accounts (
      account_id TEXT PRIMARY KEY,
      gateway_id TEXT UNIQUE
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS relay_gateway_bindings (
      account_id TEXT PRIMARY KEY,
      hostname TEXT UNIQUE NOT NULL,
      binding TEXT NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS relay_identity_aliases (
      identity_account_id TEXT PRIMARY KEY,
      routing_account_id TEXT UNIQUE NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS relay_gateway_recovery (
      account_id TEXT PRIMARY KEY,
      receipt TEXT NOT NULL
    )`);
  }

  registerAccount(id: string): void {
    if (this.resolveAccount(id) !== id) return;
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

  registerBinding(account: string, binding: GatewayBinding): void {
    this.db.transaction(() => {
      const hostname = bindingOrigin(binding.publicOrigin).hostname;
      const owner = this.accountForHostname(hostname);
      if (owner !== undefined && owner !== account)
        throw new RelayError(409, "Hostname already registered");
      if (!this.bindGateway(account, binding.gatewayId))
        throw new RelayError(409, "Gateway binding conflict");
      this.db
        .prepare(
          `INSERT INTO relay_gateway_bindings(account_id, hostname, binding) VALUES (?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET hostname=excluded.hostname, binding=excluded.binding`,
        )
        .run(account, hostname, JSON.stringify(binding));
    })();
  }

  resolveAccount(identityAccount: string): string {
    const row = this.db
      .prepare(
        "SELECT routing_account_id FROM relay_identity_aliases WHERE identity_account_id = ?",
      )
      .get(identityAccount) as { routing_account_id: string } | undefined;
    return row?.routing_account_id ?? identityAccount;
  }

  /** A Google identity can discover one key-owned gateway; it never replaces that gateway's owner key. */
  linkGoogleAccount(googleAccount: string, ownerAccount: string): void {
    this.db.transaction(() => {
      if (googleAccount === ownerAccount || this.resolveAccount(ownerAccount) !== ownerAccount)
        throw new RelayError(409, "Identity alias conflict");
      const prior = this.resolveAccount(googleAccount);
      if (prior !== googleAccount) {
        if (prior === ownerAccount) return;
        throw new RelayError(409, "Google identity is linked to another gateway");
      }
      const other = this.db
        .prepare(
          "SELECT identity_account_id FROM relay_identity_aliases WHERE routing_account_id = ?",
        )
        .get(ownerAccount);
      const binding = this.gatewayBinding(ownerAccount);
      const google = this.db
        .prepare("SELECT gateway_id FROM relay_accounts WHERE account_id = ?")
        .get(googleAccount) as { gateway_id: string | null } | undefined;
      if (
        other ||
        !binding ||
        keyBindingOwnerAccount(binding) !== ownerAccount ||
        google?.gateway_id ||
        this.gatewayBinding(googleAccount)
      )
        throw new RelayError(409, "Identity alias conflicts with an existing gateway");
      this.db
        .prepare("DELETE FROM relay_accounts WHERE account_id = ? AND gateway_id IS NULL")
        .run(googleAccount);
      this.db
        .prepare(
          "INSERT INTO relay_identity_aliases(identity_account_id, routing_account_id) VALUES (?, ?)",
        )
        .run(googleAccount, ownerAccount);
    })();
  }

  googleAccountForOwner(ownerAccount: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT identity_account_id FROM relay_identity_aliases WHERE routing_account_id = ?",
      )
      .get(ownerAccount) as { identity_account_id: string } | undefined;
    return row?.identity_account_id;
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

  private ownerForGateway(gatewayId: string): string | undefined {
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
