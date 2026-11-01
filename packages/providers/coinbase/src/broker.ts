// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A Coinbase portfolio whose CDP key the credential broker holds.
 *
 * Nango has no Coinbase integration for a CDP key, so the operator stores the
 * key in a generic **`private-api-basic`** integration (Nango auth mode
 * `BASIC`):
 *
 *   - `username` — the key name, `organizations/<org-id>/apiKeys/<key-id>`
 *   - `password` — the private key, the whole `BEGIN … END` PEM block
 *
 * Nango only stores the pair; nothing about it refreshes. The key is read back
 * for every request rather than once per run, so a key replaced at the broker
 * reaches a running sync, and the client signs its per-request JWT with it
 * exactly as it does with a pasted key.
 */

import { BrokerCredentialError, DEFAULT_BROKER_PURPOSE } from "@omnesis/core";
import { CoinbaseClient } from "./client.js";
import {
  COINBASE_FILE_KEY,
  deriveAccountId,
  keyPortfolioId,
  resolveKeyAccount,
} from "./provider.js";
import type {
  BrokerBinding,
  BrokerCredential,
  BrokerCredentialResult,
  BrokeredCredentials,
} from "@omnesis/core";
import type { ProviderBrokerSpec } from "@omnesis/source-sdk";
import type { CoinbaseSigningKey, CoinbaseTransportOptions } from "./client.js";

/** The binding parameter that records, at link time, the key name the account was linked with. */
export const COINBASE_KEY_NAME_PARAM = "keyName";

/** A brokered credential read as the CDP key it is stored as. */
function signingKeyOf(credential: BrokerCredential): CoinbaseSigningKey {
  if (credential.type !== "basic") {
    throw new BrokerCredentialError(
      "unsupported",
      "The broker's Coinbase connection holds a token, not a CDP key; store the key in a " +
        "private-api-basic integration with the key name as username and the private key as password",
    );
  }
  return { keyId: credential.username.trim(), privateKeyPem: credential.password };
}

/** The CDP key the broker holds, read as the Basic login it is stored as. */
export async function brokeredSigningKey(
  credentials: BrokeredCredentials,
  opts: { fresh?: boolean } = {},
): Promise<CoinbaseSigningKey> {
  const { credential } = await credentials.get(
    DEFAULT_BROKER_PURPOSE,
    opts.fresh ? { forceRefresh: true } : {},
  );
  return signingKeyOf(credential);
}

/**
 * Check each key the broker hands out still reads the linked portfolio, for
 * {@link BrokeredCredentials}' `verify` option.
 *
 * The key named at link time is recorded in the binding, and that key is
 * accepted as it stands. Any other key — one rotated or swapped at the broker,
 * or a binding linked before the name was recorded — is asked of Coinbase
 * with itself alone: it must still be View-only, and its portfolio
 * ({@link keyPortfolioId}, the rule linking uses) must derive the account id. A key that passes is kept, so
 * it is not asked about again; a failed request keeps the client's
 * classification and is not taken as a match.
 */
export function verifyCoinbaseIdentity(
  accountId: string,
  binding: () => BrokerBinding,
  transport: CoinbaseTransportOptions = {},
): (purpose: string, result: BrokerCredentialResult) => Promise<void> {
  let verified: CoinbaseSigningKey | undefined;
  return async (_purpose, { credential }) => {
    const key = signingKeyOf(credential);
    if (key.keyId === binding().params?.[COINBASE_KEY_NAME_PARAM]) return;
    if (verified?.keyId === key.keyId && verified.privateKeyPem === key.privateKeyPem) return;

    const client = new CoinbaseClient({ ...transport, ...key });
    const permissions = await client.getKeyPermissions();
    if (!permissions.can_view || permissions.can_trade || permissions.can_transfer) {
      throw new BrokerCredentialError(
        "rejected",
        `The Coinbase key the broker now holds for ${accountId} is not View-only, and Omnesis only uses a View-only key`,
      );
    }
    const portfolioId = await keyPortfolioId(client, permissions);
    if (String(deriveAccountId(portfolioId, key.keyId)) !== accountId) {
      throw new BrokerCredentialError(
        "identity-changed",
        `The Coinbase key the broker now holds is not the one ${accountId} was linked with, and Coinbase does not place it in that portfolio; link it again with \`omnesis broker link\``,
      );
    }
    verified = key;
  };
}

/** A client that asks the broker for the key before every request. */
export function brokeredCoinbaseClient(
  credentials: BrokeredCredentials,
  transport: CoinbaseTransportOptions = {},
): CoinbaseClient {
  return new CoinbaseClient({
    ...transport,
    signingKey: (opts) => brokeredSigningKey(credentials, opts),
  });
}

export const coinbaseBrokerSpec: ProviderBrokerSpec = {
  fileKey: COINBASE_FILE_KEY,
  purposes: [
    {
      id: DEFAULT_BROKER_PURPOSE,
      label: "Coinbase CDP key (Basic: username = key name, password = private key PEM)",
      brokerProviders: ["private-api-basic"],
    },
  ],
  // The paste flow names the account after the portfolio the key reads, which
  // only Coinbase can say, so linking asks it with the brokered key — and
  // refuses a key that can trade or transfer, as a paste would.
  async resolveAccount(credentials) {
    const key = await brokeredSigningKey(credentials);
    const { accountId } = await resolveKeyAccount(brokeredCoinbaseClient(credentials), key.keyId);
    return { accountId: String(accountId), params: { [COINBASE_KEY_NAME_PARAM]: key.keyId } };
  },
  verify: (accountId, binding) => verifyCoinbaseIdentity(accountId, () => binding),
};
