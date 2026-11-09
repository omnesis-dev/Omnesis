// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { keyBindingOwnerAccount } from "./gateway-key-auth.js";
import { RelayError } from "./tunnels.js";
import type { AccountEnrollmentAuthority } from "./account-enrollment-proof.js";
import type { GatewayDirectory } from "./gateway-directory.js";
import type { NativeAccountAuthentication } from "./native-account-authentication.js";

/** Account discovery can request enrollment at an explicitly selected gateway, never grant device permissions. */
export class AccountDiscovery {
  constructor(
    private readonly options: {
      authentication: NativeAccountAuthentication;
      directory: GatewayDirectory;
      authority?: AccountEnrollmentAuthority;
      assertCurrent(): void;
    },
  ) {}

  jwks() {
    if (!this.options.authority) throw new RelayError(503, "Account enrollment is unavailable");
    return this.options.authority.jwks();
  }

  async list(token: string, query: URLSearchParams) {
    this.options.assertCurrent();
    const account = await this.options.authentication.authenticate(token);
    return this.options.directory.list(account.accountId, query);
  }

  async select(token: string, query: URLSearchParams) {
    this.options.assertCurrent();
    const account = await this.options.authentication.authenticate(token);
    if (!query.has("gatewayId"))
      throw new RelayError(400, "Select a gateway before pairing this device");
    const binding = this.options.directory.select(account.accountId, query);
    const ownerAccountId = keyBindingOwnerAccount(binding);
    if (!ownerAccountId) throw new RelayError(409, "Gateway needs an account-enrollment update");
    if (!this.options.authority) throw new RelayError(503, "Account enrollment is unavailable");
    const identityToken = await this.options.authority.issue(
      {
        accountId: account.accountId,
        gatewayId: binding.gatewayId,
        ownerAccountId,
        nonce: account.nonce,
      },
      account.expiresAt,
    );
    return { binding, accountId: account.accountId, identityToken, expiresAt: account.expiresAt };
  }
}
