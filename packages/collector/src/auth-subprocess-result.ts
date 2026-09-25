// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { AuthFailure } from "@omnesis/source-sdk";
import { AccountId } from "@omnesis/types";

/**
 * A renewal must resolve its requested account on either auth protocol.
 * This validates the result, not credential writes: providers must check the
 * account before promoting credentials, since this boundary cannot roll back
 * upstream exchanges or provider-owned persistence.
 */
export function validateAuthAccounts(accounts: readonly string[], expected?: string): string[] {
  const ids = accounts.map((id) => String(AccountId(id)));
  if (ids.length === 0) throw new AuthFailure("unknown", "Authentication returned no account");
  if (expected !== undefined && !ids.includes(expected)) {
    throw new AuthFailure("identity-mismatch", "Authentication resolved a different account", {
      remedy: "Sign in to the account being renewed, or add a separate connection.",
    });
  }
  return ids;
}
