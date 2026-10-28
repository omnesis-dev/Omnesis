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
import { COINBASE_FILE_KEY, resolveKeyAccount } from "./provider.js";
import type { BrokeredCredentials } from "@omnesis/core";
import type { ProviderBrokerSpec } from "@omnesis/source-sdk";
import type { CoinbaseSigningKey, CoinbaseTransportOptions } from "./client.js";

/** The CDP key the broker holds, read as the Basic login it is stored as. */
export async function brokeredSigningKey(
  credentials: BrokeredCredentials,
  opts: { fresh?: boolean } = {},
): Promise<CoinbaseSigningKey> {
  const { credential } = await credentials.get(
    DEFAULT_BROKER_PURPOSE,
    opts.fresh ? { forceRefresh: true } : {},
  );
  if (credential.type !== "basic") {
    throw new BrokerCredentialError(
      "unsupported",
      "The broker's Coinbase connection holds a token, not a CDP key; store the key in a " +
        "private-api-basic integration with the key name as username and the private key as password",
    );
  }
  return { keyId: credential.username.trim(), privateKeyPem: credential.password };
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
    return { accountId: String(accountId) };
  },
};
