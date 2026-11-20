// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { RelayError } from "./tunnels.js";
import type { VerifiedInvite } from "./invites.js";

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
  /** The invite the account is created with; creating the account records it as used. */
  invite?: VerifiedInvite;
  /**
   * Told the new account's id once it is created with this admission, so the sign-up can say
   * whether its sign-in created the account or signed in to one that already existed.
   */
  created?(account: string): void;
  /**
   * A gateway linked with Google before Omnesis accounts existed, carried into an account; it
   * needs no invite.
   */
  carriedOver?: true;
}
export type PasskeyRegistrationAuthorization =
  | { kind: "gateway-owner"; admission: AccountAdmission }
  | { kind: "account-session"; sessionId: string };
