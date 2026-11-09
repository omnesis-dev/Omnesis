// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { accountId, type IdentityProvider, type RelaySessions } from "./identity.js";
import { bindingOrigin } from "./gateway-binding.js";
import { RelayError } from "./tunnels.js";
import { NoAccount, type AccountAdmission } from "./account-admission.js";
import type { OmnesisAccounts } from "./omnesis-accounts.js";

/** Decided after Google verifies the token, for callers whose policy depends on who signed in. */
export type GoogleAdmission =
  | AccountAdmission
  | ((google: { subjectDigest: string; account?: string }) => Promise<AccountAdmission>);

/** Credential changes require a recent proof of account ownership. */
export function accountCredentialsRequireSignIn(authTime: number): boolean {
  return authTime < Math.floor(Date.now() / 1000) - 300;
}

/** Account authentication never grants device permissions or operates a gateway tunnel. */
export class AccountAuthentication {
  private closed = false;
  constructor(
    private readonly origin: string,
    private readonly accounts: OmnesisAccounts,
    private readonly sessions: RelaySessions,
    private readonly google?: IdentityProvider,
    private readonly onGoogleSignIn?: (
      account: string,
      legacyIdentities: readonly string[],
    ) => void,
    private readonly legacyAdmission?: (
      identities: readonly string[],
    ) => AccountAdmission | undefined,
  ) {
    this.origin = bindingOrigin(origin).origin;
  }

  async authenticate(token: string, fresh = false) {
    this.assertOpen();
    let session;
    try {
      session = await this.sessions.verifyAccountSession(token, this.origin);
    } catch {
      throw new RelayError(
        401,
        fresh ? "Sign in again to manage account credentials" : "Omnesis account sign-in required",
      );
    }
    this.assertOpen();
    if (
      !this.accounts.activeSession(session.accountId, session.version, session.sessionId) ||
      (fresh && accountCredentialsRequireSignIn(session.authTime))
    )
      throw new RelayError(
        401,
        fresh ? "Sign in again to manage account credentials" : "Omnesis account sign-in required",
      );
    return session;
  }

  async googleSignIn(
    token: string,
    nonce: string,
    linkSession?: string,
    admission?: GoogleAdmission,
  ) {
    return this.issueSession(
      await this.googleAccount(token, nonce, linkSession, admission),
      "google",
    );
  }

  /** Native discovery verifies identity without creating an account-management session. */
  async googleAccount(
    token: string,
    nonce: string,
    linkSession?: string,
    admission?: GoogleAdmission,
  ) {
    this.assertOpen();
    if (!this.google) throw new RelayError(503, "Google sign-in is not configured");
    const linking =
      linkSession === undefined ? undefined : await this.authenticate(linkSession, true);
    const identity = await this.google.verify(token, nonce);
    this.assertOpen();
    if (
      !["https://accounts.google.com", "accounts.google.com"].includes(identity.issuer) ||
      identity.expiresAt <= Math.floor(Date.now() / 1000)
    )
      throw new RelayError(400, "Google account proof refused");
    const normalized = { ...identity, issuer: "https://accounts.google.com" };
    const digest = accountId(normalized);
    const legacy = [digest, accountId({ ...identity, issuer: "accounts.google.com" })];
    let account: string;
    if (linking) {
      // Provider verification may suspend while another request revokes this session.
      await this.authenticate(linkSession!, true);
      this.accounts.linkFederated(linking.accountId, "google", digest, linking.version);
      account = linking.accountId;
    } else {
      const existing = this.accounts.federatedAccount("google", digest);
      const decided =
        typeof admission === "function"
          ? await admission({ subjectDigest: digest, account: existing })
          : admission;
      this.assertOpen();
      if (existing) account = existing;
      else {
        const authority = decided ?? this.legacyAdmission?.(legacy);
        if (!authority) throw new NoAccount();
        account = this.accounts.signInFederated("google", digest, authority);
      }
    }
    this.accounts.bindGoogleAliases(digest, legacy);
    this.onGoogleSignIn?.(account, legacy);
    return { accountId: account, version: this.accounts.sessionVersion(account)! };
  }

  async issuePasskeySession(account: { accountId: string; version: number }) {
    this.assertOpen();
    if (this.accounts.sessionVersion(account.accountId) !== account.version)
      throw new RelayError(401, "Account changed; sign in again");
    return this.issueSession(account, "passkey");
  }
  async logout(token: string): Promise<void> {
    try {
      const session = await this.authenticate(token);
      this.accounts.revokeSession(session.accountId, session.sessionId);
    } catch (error) {
      if (!(error instanceof RelayError && error.status === 401)) throw error;
    }
  }

  private async issueSession(
    account: { accountId: string; version: number },
    method: "google" | "passkey",
  ) {
    this.assertOpen();
    const session = await this.sessions.issueAccountSession(account, method, this.origin);
    this.assertOpen();
    this.accounts.registerSession(
      session.accountId,
      session.version,
      session.sessionId,
      session.expiresAt,
    );
    return session;
  }
  close(): void {
    this.closed = true;
  }
  private assertOpen(): void {
    if (this.closed) throw new RelayError(503, "Account sign-in is unavailable");
  }
}
