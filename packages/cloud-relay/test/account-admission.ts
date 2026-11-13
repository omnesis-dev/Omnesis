// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import type {
  AccountAdmission,
  PasskeyRegistrationAuthorization,
} from "../src/account-admission.js";
import type { OmnesisAccounts } from "../src/omnesis-accounts.js";

/** Trusted test bootstrap only; production admission is derived from a signed gateway operation. */
export function testAccountAdmission(): AccountAdmission {
  return {
    gatewayId: randomUUID(),
    ownerAccountId: randomBytes(32).toString("hex"),
    assertCurrent() {},
  };
}
export function testPasskeyAuthorization(
  accounts: OmnesisAccounts,
  account?: { accountId: string; version: number },
): PasskeyRegistrationAuthorization {
  if (!account) return { kind: "gateway-owner", admission: testAccountAdmission() };
  const sessionId = randomUUID();
  accounts.registerSession(
    account.accountId,
    account.version,
    sessionId,
    Math.floor(Date.now() / 1000) + 300,
  );
  return { kind: "account-session", sessionId };
}
