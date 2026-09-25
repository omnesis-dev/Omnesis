// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `AppleAccountResolver` — single responsibility: iCloud account →
 * AccountId map. Owns:
 *
 *   1. The MobileMeAccounts plist parser (plutil-first, defaults
 *      fallback). The plist is an Apple-internal binary plist; the
 *      preferred path is `plutil -convert json -o - <plist>` which
 *      gives us a structured object we can `JSON.parse`. If
 *      `plutil` is missing or the file shape changes in a future
 *      macOS, fall back to the legacy `defaults read` regex parser.
 *      A loud info log fires when both fail so users have a
 *      breadcrumb when documents end up tagged `apple:local`.
 *
 *   2. The Reminders ZACCOUNTID hex parser. Reminders stores their
 *      owning iCloud account UUID as a 16-byte BLOB on the
 *      `ZREMCDACCOUNTLISTDATA` table; converting that BLOB to the
 *      canonical UUID string is what lets us match a reminder store
 *      to one of the MobileMeAccounts UUIDs and surface the right
 *      `accountEmail` to the source.
 *
 * Pulled out of the original 653-line `AppleProvider` class.
 * Kept dependency-free so a test that needs to stub
 * the iCloud-account map can construct one without touching the
 * provider façade.
 */

import { execSync } from "node:child_process";
import { createLogger } from "@omnesis/core";
import { AccountId } from "@omnesis/types";
import type { Db } from "./db-helpers/internal.js";

const log = createLogger("provider:apple:accounts");

/** Path to the MobileMeAccounts preference plist. */
const MOBILE_ME_PLIST = `${process.env.HOME ?? "~"}/Library/Preferences/MobileMeAccounts.plist`;

/**
 * Parse MobileMeAccounts via `plutil -convert json`, the structured path.
 * Returns an empty Map on any failure so the caller can fall back to the
 * regex parser.
 */
function parseMobileMeAccountsViaPlutil(): Map<string, string> {
  const result = new Map<string, string>();
  try {
    const json = execSync(`plutil -convert json -o - "${MOBILE_ME_PLIST}" 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 5000,
    });
    const parsed = JSON.parse(json) as { Accounts?: unknown };
    if (!Array.isArray(parsed.Accounts)) return result;
    for (const entry of parsed.Accounts) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const id = typeof e.AccountID === "string" ? e.AccountID : undefined;
      const uuid = typeof e.AccountUUID === "string" ? e.AccountUUID : undefined;
      if (id && uuid) result.set(uuid.toUpperCase(), id);
    }
  } catch {
    // plutil missing, plist absent, JSON malformed — fall back.
  }
  return result;
}

/**
 * Legacy `defaults read` regex parser. Kept as a defence-in-depth fallback
 * so a future plutil hiccup doesn't completely break account attribution.
 */
function parseMobileMeAccountsViaDefaults(): Map<string, string> {
  const result = new Map<string, string>();
  try {
    const output = execSync("defaults read MobileMeAccounts Accounts 2>/dev/null", {
      encoding: "utf-8",
      timeout: 5000,
    });
    const accountBlocks = output.split(/\{/).slice(1);
    for (const block of accountBlocks) {
      const idMatch = block.match(/AccountID\s*=\s*"([^"]+)"/);
      const uuidMatch = block.match(/AccountUUID\s*=\s*"([^"]+)"/);
      if (idMatch?.[1] && uuidMatch?.[1]) {
        result.set(uuidMatch[1].toUpperCase(), idMatch[1]);
      }
    }
  } catch {
    // defaults missing or threw — caller logs the user-facing fallback.
  }
  return result;
}

export class AppleAccountResolver {
  /**
   * Parse all iCloud accounts from MobileMeAccounts.
   * Returns a map of AccountUUID → AccountID (email).
   */
  resolveAllICloudAccounts(): Map<string, string> {
    const fromPlutil = parseMobileMeAccountsViaPlutil();
    if (fromPlutil.size > 0) {
      log.debug("Resolved iCloud accounts via plutil", {
        count: fromPlutil.size,
        emails: Array.from(fromPlutil.values()),
      });
      return fromPlutil;
    }

    const fromDefaults = parseMobileMeAccountsViaDefaults();
    if (fromDefaults.size > 0) {
      log.debug("Resolved iCloud accounts via defaults fallback", {
        count: fromDefaults.size,
        emails: Array.from(fromDefaults.values()),
      });
      return fromDefaults;
    }

    log.info(
      "Could not resolve iCloud accounts from MobileMeAccounts — Apple " +
        "items will be tagged with accountId=local. " +
        "If you are signed into iCloud, check that " +
        "~/Library/Preferences/MobileMeAccounts.plist exists and that " +
        "your terminal has Full Disk Access.",
    );
    return new Map();
  }

  /**
   * Resolve the iCloud email address from macOS system preferences.
   * Returns the first (primary) account email.
   */
  resolveICloudEmail(): AccountId | undefined {
    const accounts = this.resolveAllICloudAccounts();
    if (accounts.size === 0) return undefined;
    const email = accounts.values().next().value;
    if (email) {
      log.info(`Resolved iCloud account: ${email}`);
      return AccountId(email);
    }
    return undefined;
  }

  /**
   * Extract the account UUID from a Reminders store's ZACCOUNTID blob.
   * The blob is a 16-byte UUID; we format it as a standard UUID string.
   */
  getStoreAccountUuid(db: Db): string | null {
    try {
      const row = db
        .prepare("SELECT hex(ZACCOUNTID) as uuid FROM ZREMCDACCOUNTLISTDATA LIMIT 1")
        .get() as { uuid: string } | null;

      if (!row?.uuid || row.uuid.length !== 32) return null;

      const h = row.uuid.toUpperCase();
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
    } catch {
      return null;
    }
  }
}
