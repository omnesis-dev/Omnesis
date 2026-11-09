// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { bindingOrigin } from "./gateway-binding.js";
import { RelayError } from "./tunnels.js";
import { NativeAccountOperations } from "./native-account-operations.js";
import type { AccountAuthentication } from "./account-authentication.js";
import type { OmnesisAccounts } from "./omnesis-accounts.js";
import type { Passkeys } from "./passkeys.js";
import type { RelaySessions } from "./identity.js";

/** Public native clients receive only nonce-bound discovery authority, never account-management cookies. */
export class NativeAccountAuthentication {
  private readonly origin: string;
  private readonly operations: NativeAccountOperations;
  constructor(
    private readonly options: {
      origin: string;
      accounts: OmnesisAccounts;
      sessions: RelaySessions;
      googleAuthentication: AccountAuthentication;
      passkeys: Passkeys;
      operations?: NativeAccountOperations;
    },
  ) {
    this.origin = bindingOrigin(options.origin).origin;
    this.operations = options.operations ?? new NativeAccountOperations();
  }

  start(input: unknown) {
    return this.operations.start(input);
  }
  async passkeyOptions(id: string, ticket: string) {
    const binding = this.operations.binding(id, ticket),
      commitment = this.operations.commitment(id, ticket);
    return {
      ...(await this.options.passkeys.beginAuthentication(binding, commitment)),
      salt: commitment.salt,
      issuedAt: commitment.issuedAt,
    };
  }
  async google(id: string, ticket: string, verifier: string, idToken: string) {
    return this.operations.complete(id, ticket, verifier, async (context) => {
      const account = await this.options.googleAuthentication.googleAccount(
        idToken,
        context.googleNonce,
      );
      context.current();
      return this.issue(account, context.intent.nonce, context.expiresAt);
    });
  }
  async passkey(
    id: string,
    ticket: string,
    verifier: string,
    ceremonyId: string,
    credential: unknown,
  ) {
    const binding = this.operations.binding(id, ticket);
    return this.operations.complete(id, ticket, verifier, async (context) => {
      const account = await this.options.passkeys.finishAuthentication(
        ceremonyId,
        binding,
        credential,
      );
      context.current();
      return {
        ...(await this.issue(account, context.intent.nonce, context.expiresAt)),
        credentialPublicKey: account.credentialPublicKey,
        credentialId: account.credentialId,
      };
    });
  }
  async authenticate(discoveryToken: string) {
    let result;
    try {
      result = await this.options.sessions.verifyAccountDiscovery(discoveryToken, this.origin);
    } catch {
      throw new RelayError(401, "Account discovery sign-in required");
    }
    if (this.options.accounts.sessionVersion(result.accountId) !== result.version)
      throw new RelayError(401, "Account changed; sign in again");
    return result;
  }
  cancel(id: string, ticket: string): void {
    this.operations.cancel(id, ticket);
  }
  close(): void {
    this.operations.close();
  }

  private async issue(
    account: { accountId: string; version: number },
    nonce: string,
    expiresAt: number,
  ) {
    if (this.options.accounts.sessionVersion(account.accountId) !== account.version)
      throw new RelayError(401, "Account changed; sign in again");
    return this.options.sessions.issueAccountDiscovery(
      account,
      nonce,
      this.origin,
      Math.min(Math.floor(expiresAt / 1000), Math.floor(Date.now() / 1000) + 300),
    );
  }
}
