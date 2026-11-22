// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  passkeyCountersignatureSchema,
  type PasskeyCountersignature,
} from "../src/device-enrollment.js";
import type { OmnesisAccounts } from "../src/omnesis-accounts.js";
import type Database from "better-sqlite3";

/**
 * Stores a countersignature beside a passkey the way a relay from before confirmations did, when
 * the account page asked a new passkey to sign for the account's other sign-ins. The relay no
 * longer stores new ones, but keeps, lists and removes those it holds.
 */
export function storeCountersignature(
  accounts: OmnesisAccounts,
  credentialId: string,
  countersignature: PasskeyCountersignature,
): void {
  (accounts as unknown as { db: Database.Database }).db
    .prepare("INSERT OR REPLACE INTO omnesis_passkey_countersignatures VALUES (?,?)")
    .run(credentialId, JSON.stringify(passkeyCountersignatureSchema.parse(countersignature)));
}
