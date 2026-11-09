// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  keyBindingOwnerAccount,
  keyBindingOwnerPublicKey,
  type KeyRegistration,
} from "./gateway-key-auth.js";
import {
  verifyRecoveryBindingReceipt,
  verifyRecoveryReceipt,
  type TrustedRecoveryPolicy,
} from "./recovery-verifier.js";
import { RelayError } from "./tunnels.js";
import { bindingOrigin } from "./gateway-binding.js";
import type { RelayAccounts } from "./accounts.js";
import type { GatewayBinding } from "./gateway-binding.js";
import type { RecoveryReceipt } from "./recovery-contract.js";

/** Independent authority checks apply equally to live registrations and untrusted restored database rows. */
export class RelayRecovery {
  private readonly aliases = new Map<string, Set<string>>();
  constructor(
    private readonly accounts: RelayAccounts,
    readonly policy: TrustedRecoveryPolicy,
    private readonly seals?: {
      seal(google: string, owner: string): string;
      verify(google: string, owner: string, seal: string | undefined): boolean;
    },
  ) {}

  private linkedOwners(google: string): Set<string> {
    const owners = new Set(this.aliases.get(google));
    if (this.seals)
      for (const link of this.accounts.googleGatewayLinks(google))
        if (this.seals.verify(google, link.ownerAccount, link.seal)) owners.add(link.ownerAccount);
    return owners;
  }

  /** Unsealed restored rows never establish Google ownership. Key rotation invalidates old seals. */
  resolveAccount(identityAccount: string): string {
    const owners = [...this.linkedOwners(identityAccount)];
    return owners.length === 1 ? owners[0]! : identityAccount;
  }

  gatewayAccounts(identityAccount: string): string[] {
    const owners = this.linkedOwners(identityAccount);
    if (this.accounts.gatewayBinding(identityAccount) !== undefined) owners.add(identityAccount);
    return [...owners].sort();
  }

  googleAccountForOwner(owner: string): string | undefined {
    for (const [google, owners] of this.aliases) if (owners.has(owner)) return google;
    const link = this.accounts.googleGatewayLinkForOwner(owner);
    if (link !== undefined && this.seals?.verify(link.googleAccount, owner, link.seal))
      return link.googleAccount;
    return undefined;
  }

  /** Call only after fresh raw-owner authorization and independent Google identity verification. */
  linkGoogleAccount(google: string, owner: string): void {
    const other = this.googleAccountForOwner(owner);
    if (google === owner || (other !== undefined && other !== google))
      throw new RelayError(409, "Gateway is linked to another Google identity");
    if (this.seals) this.accounts.linkGoogleAccount(google, owner, this.seals.seal(google, owner));
    const owners = this.linkedOwners(google);
    owners.add(owner);
    this.aliases.set(google, owners);
  }

  unlinkGoogleAccount(owner: string): void {
    const stored = this.accounts.googleAccountForOwner(owner);
    if (stored !== undefined) this.accounts.unlinkGoogleAccount(stored, owner);
    for (const [google, owners] of this.aliases) {
      owners.delete(owner);
      if (owners.size === 0) this.aliases.delete(google);
    }
  }

  registration(input: unknown, registration: KeyRegistration): RecoveryReceipt {
    try {
      return verifyRecoveryReceipt(input, this.policy, registration);
    } catch {
      throw new RelayError(403, "An authorized current gateway recovery receipt is required");
    }
  }

  binding(account: string): GatewayBinding | undefined {
    try {
      const binding = this.accounts.gatewayBinding(account);
      if (binding === undefined) return undefined;
      const ownerPublicKey = keyBindingOwnerPublicKey(binding);
      if (ownerPublicKey === undefined || keyBindingOwnerAccount(binding) !== account)
        throw new Error("Invalid stored gateway owner");
      verifyRecoveryBindingReceipt(this.accounts.gatewayRecoveryReceipt(account), this.policy, {
        gatewayId: binding.gatewayId,
        publicOrigin: binding.publicOrigin,
        ownerPublicKey,
      });
      return binding;
    } catch {
      throw new RelayError(403, "Gateway recovery authorization refused");
    }
  }

  accountForHostname(hostname: string): string | undefined {
    try {
      const account = this.accounts.accountForHostname(hostname);
      if (account === undefined) return undefined;
      const binding = this.binding(account);
      return binding !== undefined && bindingOrigin(binding.publicOrigin).hostname === hostname
        ? account
        : undefined;
    } catch {
      return undefined;
    }
  }
}
