// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { RelayError } from "./tunnels.js";

/**
 * A verified sign-in that no Omnesis account uses. Accounts are created only when the person
 * chose to create one while connecting a gateway, never as a side effect of signing in.
 */
export class NoAccount extends RelayError {
  constructor() {
    super(403, "There is no Omnesis account for this sign-in");
  }
}

/** Signup consumes one stable gateway's allocation; it grants neither discovery association nor data access. */
export interface AccountAdmission {
  gatewayId: string;
  ownerAccountId: string;
  assertCurrent(): void;
}
export type PasskeyRegistrationAuthorization =
  | { kind: "gateway-owner"; admission: AccountAdmission }
  | { kind: "account-session"; sessionId: string };
