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
  private readonly aliases = new Map<string, string>();
  constructor(
    private readonly accounts: RelayAccounts,
    readonly policy: TrustedRecoveryPolicy,
  ) {}

  /** Persisted aliases cannot attest account ownership after an untrusted restore. */
  resolveAccount(identityAccount: string): string {
    return this.aliases.get(identityAccount) ?? identityAccount;
  }

  googleAccountForOwner(owner: string): string | undefined {
    return [...this.aliases].find(([, account]) => account === owner)?.[0];
  }

  /** Call only after fresh raw-owner authorization and independent Google identity verification. */
  linkGoogleAccount(google: string, owner: string): void {
    const prior = this.aliases.get(google),
      other = this.googleAccountForOwner(owner);
    if (
      google === owner ||
      (prior !== undefined && prior !== owner) ||
      (other !== undefined && other !== google)
    )
      throw new RelayError(409, "Google identity is linked to another gateway");
    this.aliases.set(google, owner);
  }

  unlinkGoogleAccount(owner: string): void {
    const stored = this.accounts.googleAccountForOwner(owner);
    if (stored !== undefined) this.accounts.unlinkGoogleAccount(stored, owner);
    for (const [google, account] of this.aliases)
      if (account === owner) this.aliases.delete(google);
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
