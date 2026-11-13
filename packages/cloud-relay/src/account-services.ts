// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { AccountAuthentication } from "./account-authentication.js";
import { AccountWeb } from "./account-web.js";
import { AccountBrowserBroker } from "./account-browser-broker.js";
import { AccountBrowserHttp } from "./account-browser-http.js";
import { DesktopAccountBrowser } from "./desktop-account-browser.js";
import { DesktopAccountHttp } from "./desktop-account-http.js";
import { AccountDiscovery } from "./account-discovery.js";
import { AccountDiscoveryHttp } from "./account-discovery-http.js";
import { ConnectCodes } from "./connect-codes.js";
import { ConnectHttp } from "./connect-http.js";
import { GatewaySignup, type SignupConfiguration } from "./gateway-signup.js";
import { GatewaySignupHttp } from "./gateway-signup-http.js";
import { GatewayDirectory } from "./gateway-directory.js";
import { NativeAccountAuthentication } from "./native-account-authentication.js";
import { NativeAccountHttp } from "./native-account-http.js";
import { Passkeys } from "./passkeys.js";
import { PortalSignIn } from "./portal-sign-in.js";
import { RelayError } from "./tunnels.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AccountAdmission } from "./account-admission.js";
import type { AccountBrowserAccount } from "./account-browser-broker.js";
import type { AccountEnrollmentAuthority } from "./account-enrollment-proof.js";
import type { AccountBrowserOwner } from "./account-browser-contract.js";
import type { AppAssociations } from "./app-associations.js";
import type { RelayAccounts } from "./accounts.js";
import type { IdentityProvider, RelaySessions } from "./identity.js";
import type { GatewayBinding } from "./gateway-binding.js";
import type { LoginAdmission } from "./admission.js";

export interface AccountSignInConfiguration {
  associations?: AppAssociations;
  nativeGoogleIdentity?: IdentityProvider;
  enrollmentAuthority?: AccountEnrollmentAuthority;
  signup?: SignupConfiguration;
  /** Shown beside connect codes in place of this relay's own connect page address. */
  connectShortUrl?: string;
}

/** Account coordination is separate from transport ownership and gateway data authorization. */
export class AccountServices {
  private readonly authentication: AccountAuthentication;
  private readonly nativeGoogleAuthentication: AccountAuthentication;
  private readonly native: NativeAccountAuthentication;
  private readonly passkeys: Passkeys;
  private readonly web: AccountWeb;
  private readonly browser?: AccountBrowserBroker;
  private readonly browserHttp?: AccountBrowserHttp;
  private readonly nativeHttp: NativeAccountHttp;
  private readonly discoveryHttp: AccountDiscoveryHttp;
  private readonly desktop: DesktopAccountBrowser;
  private readonly desktopHttp: DesktopAccountHttp;
  private readonly portal: PortalSignIn;
  private readonly connectHttp: ConnectHttp;
  private readonly signup?: GatewaySignup;
  private readonly signupHttp?: GatewaySignupHttp;
  constructor(
    private readonly options: {
      origin: string;
      configuration: AccountSignInConfiguration;
      accounts: RelayAccounts;
      sessions: RelaySessions;
      google?: IdentityProvider;
      admission: LoginAdmission;
      gatewayAccounts(google: string): string[];
      gatewayBinding(owner: string): GatewayBinding | undefined;
      currentOwner(owner: string): AccountBrowserOwner | undefined;
      /** Removes the account and its gateways' registrations, and ends their live tunnels. */
      deleteAccount(account: string, version: number): void;
      /** Takes one gateway out of its account, with its registration and its live tunnel. */
      deleteGateway(owner: string): void;
      authenticateOwner(
        req: IncomingMessage,
      ): Promise<AccountBrowserOwner & { sessionExpiresAt: number }>;
      assertCurrent(): void;
    },
  ) {
    const accounts = options.accounts.identities;
    const linkedOwners = (account: string) =>
      accounts
        .gatewayLinks(account)
        .filter((link) =>
          options.sessions.verifyAccountGatewayLink(
            options.origin,
            account,
            link.ownerAccount,
            link.seal,
          ),
        )
        .map((link) => link.ownerAccount);
    const directory = new GatewayDirectory({
      accounts: linkedOwners,
      binding: options.gatewayBinding,
      name: (owner) => options.accounts.gatewayDisplayName(owner),
    });
    const migrate = (account: string, identities: readonly string[]) => {
      for (const identity of identities)
        for (const owner of options.gatewayAccounts(identity)) {
          const old = accounts.gatewayAccount(owner);
          if (old && old.accountId !== account) continue;
          try {
            if (options.gatewayBinding(owner))
              accounts.linkGateway(
                account,
                owner,
                options.sessions.sealAccountGatewayLink(options.origin, account, owner),
              );
          } catch (error) {
            if (!(error instanceof RelayError && error.status === 403)) throw error;
          }
        }
    };
    const legacyAdmission = (identities: readonly string[]): AccountAdmission | undefined => {
      for (const identity of identities) {
        for (const link of options.accounts.googleGatewayLinks(identity)) {
          let owner;
          try {
            owner = options.currentOwner(link.ownerAccount);
          } catch (error) {
            if (error instanceof RelayError && error.status === 403) continue;
            throw error;
          }
          if (
            !owner ||
            !accounts.canAdmitGateway(owner.gatewayId) ||
            !options.sessions.verifyGoogleLinkSeal(
              options.origin,
              identity,
              link.ownerAccount,
              link.seal,
            ) ||
            accounts.gatewayAccount(link.ownerAccount)
          )
            continue;
          const assertCurrent = () => {
            options.assertCurrent();
            const current = options.currentOwner(link.ownerAccount);
            const stored = options.accounts
              .googleGatewayLinks(identity)
              .find((value) => value.ownerAccount === link.ownerAccount);
            if (
              !current ||
              current.ownerPublicKey !== owner.ownerPublicKey ||
              current.gatewayId !== owner.gatewayId ||
              !stored ||
              !options.sessions.verifyGoogleLinkSeal(
                options.origin,
                identity,
                link.ownerAccount,
                stored.seal,
              ) ||
              accounts.gatewayAccount(link.ownerAccount)
            )
              throw new RelayError(403, "Gateway account admission changed; restart setup");
          };
          assertCurrent();
          return {
            gatewayId: owner.gatewayId,
            ownerAccountId: owner.ownerAccountId,
            assertCurrent,
          };
        }
      }
      return undefined;
    };
    this.authentication = new AccountAuthentication(
      options.origin,
      accounts,
      options.sessions,
      options.google,
      migrate,
      legacyAdmission,
    );
    this.nativeGoogleAuthentication = options.configuration.nativeGoogleIdentity
      ? new AccountAuthentication(
          options.origin,
          accounts,
          options.sessions,
          options.configuration.nativeGoogleIdentity,
          migrate,
          legacyAdmission,
        )
      : this.authentication;
    this.passkeys = new Passkeys(accounts, {
      origin: options.origin,
      androidOrigins: options.configuration.associations?.androidOrigins(),
    });
    this.native = new NativeAccountAuthentication({
      origin: options.origin,
      accounts,
      sessions: options.sessions,
      passkeys: this.passkeys,
      googleAuthentication: this.nativeGoogleAuthentication,
    });
    this.nativeHttp = new NativeAccountHttp(this.native, options.admission);
    this.discoveryHttp = new AccountDiscoveryHttp(
      new AccountDiscovery({
        authentication: this.native,
        directory,
        authority: options.configuration.enrollmentAuthority,
        assertCurrent: options.assertCurrent,
      }),
    );
    const assertAccount = (account: AccountBrowserAccount) => {
      if (!accounts.activeSession(account.accountId, account.version, account.sessionId))
        throw new RelayError(401, "Account changed; sign in again");
    };
    const codes = new ConnectCodes();
    if (options.configuration.enrollmentAuthority) {
      const linkedAccount = (owner: string) => {
        const link = accounts.gatewayAccount(owner);
        return link &&
          options.sessions.verifyAccountGatewayLink(
            options.origin,
            link.accountId,
            owner,
            link.seal,
          )
          ? link.accountId
          : undefined;
      };
      const linkAccount = (account: string, owner: string) =>
        accounts.linkGateway(
          account,
          owner,
          options.sessions.sealAccountGatewayLink(options.origin, account, owner),
          (old) =>
            !options.sessions.verifyAccountGatewayLink(
              options.origin,
              old.accountId,
              owner,
              old.seal,
            ),
        );
      this.browser = new AccountBrowserBroker({
        origin: options.origin,
        authority: options.configuration.enrollmentAuthority,
        currentOwner: (owner) => {
          options.assertCurrent();
          return options.currentOwner(owner);
        },
        assertAccount,
        linkedAccount,
        linkAccount,
        unlinkAccount: (owner) => options.deleteGateway(owner),
        accountCredentials: (account) => ({
          // These are the digests a gateway computes from a Google token: see AccountAuthentication.
          google: accounts.federatedDigests(account, "google"),
          // A gateway trusts a passkey only with the key this relay registered for it.
          passkeys: accounts.passkeyKeys(account),
        }),
      });
      this.browserHttp = new AccountBrowserHttp({
        broker: this.browser,
        admission: options.admission,
        authenticateOwner: options.authenticateOwner,
      });
      this.signup = new GatewaySignup({
        origin: options.origin,
        configuration: options.configuration.signup ?? { policy: "invitation" },
        authority: options.configuration.enrollmentAuthority,
        sessions: options.sessions,
        codes,
        connectShortUrl: options.configuration.connectShortUrl,
        gatewayOwner: (gatewayId) => options.accounts.ownerForGateway(gatewayId),
        hasCapacity: (owner) => {
          const { accounts: used, maxAccounts } = options.accounts.snapshot();
          return used < maxAccounts || options.gatewayBinding(owner) !== undefined;
        },
        hasLinkedGateway: (account) => linkedOwners(account).length > 0,
        assertAccount,
        assertCurrent: options.assertCurrent,
        linkedAccount,
        linkAccount,
        setDisplayName: (owner, name) => options.accounts.setGatewayDisplayName(owner, name),
      });
      this.signupHttp = new GatewaySignupHttp({
        signup: this.signup,
        admission: options.admission,
        authenticateOwner: options.authenticateOwner,
      });
    }
    this.desktop = new DesktopAccountBrowser({
      origin: options.origin,
      sessions: options.sessions,
      codes,
      connectShortUrl: options.configuration.connectShortUrl,
      assertCurrent: options.assertCurrent,
      assertAccount,
    });
    this.desktopHttp = new DesktopAccountHttp(this.desktop, options.admission);
    this.connectHttp = new ConnectHttp({
      origin: options.origin,
      codes,
      admission: options.admission,
    });
    this.portal = new PortalSignIn({
      directory,
      authority: options.configuration.enrollmentAuthority,
      assertCurrent: options.assertCurrent,
      assertAccount,
    });
    this.web = new AccountWeb({
      origin: options.origin,
      accounts,
      authentication: this.authentication,
      passkeys: this.passkeys,
      choices: (account) => directory.choices(account),
      deleteAccount: options.deleteAccount,
      googleAvailable: Boolean(options.google),
      admission: options.admission,
      browser: this.browser,
      desktop: this.desktop,
      signup: this.signup,
      portal: this.portal,
      signupAdmission: (id, cookie) => (id ? this.browser?.signupAdmission(id, cookie) : undefined),
    });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    return (
      Boolean(this.options.configuration.associations?.handle(req, res)) ||
      (await this.desktopHttp.handle(req, res)) ||
      (await this.connectHttp.handle(req, res)) ||
      Boolean(await this.signupHttp?.handle(req, res)) ||
      (await this.nativeHttp.handle(req, res)) ||
      (await this.discoveryHttp.handle(req, res)) ||
      Boolean(await this.browserHttp?.handle(req, res)) ||
      (await this.web.handle(req, res))
    );
  }
  googleContext(req: IncomingMessage) {
    return this.web.googleContext(req);
  }
  completeGoogle(
    token: string,
    nonce: string,
    context: string | undefined,
    request: IncomingMessage,
  ) {
    return this.web.completeGoogle(token, nonce, context, request);
  }
  googleFailure(context: string | undefined): string {
    return this.web.googleFailure(context);
  }
  /** Whether a new gateway can connect here from a sign-in alone. */
  signupOpen(): boolean {
    return this.signup?.enabled() ?? false;
  }
  close(): void {
    this.authentication.close();
    this.nativeGoogleAuthentication.close();
    this.native.close();
    this.passkeys.close();
    this.browser?.close();
    this.signup?.close();
    this.desktop.close();
    this.portal.close();
  }
}
