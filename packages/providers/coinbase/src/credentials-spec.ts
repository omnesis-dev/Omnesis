// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ProviderCredentialsSpec } from "@omnesis/core";

/**
 * Coinbase CDP API-key credentials spec.
 *
 * Coinbase has no shared OAuth client for third-party tools: the user mints a
 * CDP API key restricted to **View** permission on the Coinbase Developer
 * Platform and pastes two fields — the key id (key name) and the private key.
 * The pair IS the per-account credential (the Granola api-key pattern); there
 * is no browser redirect and no localhost callback. The collector stores them
 * at `<configDir>/coinbase-credentials.json` (mode 0600) and `authFlow()`
 * validates the key against a liveness probe before the source is added.
 */
export const coinbaseCredentialsSpec: ProviderCredentialsSpec = {
  fileKey: "coinbase",
  required: true,
  // The pasted key IS the per-account credential — if a new add fails
  // validation (wrong/mis-formatted key), drop it so the next add re-shows the
  // paste wizard instead of re-validating the same bad key on a loop.
  // The pasted key IS this account's credential, not an app credential shared
  // across accounts — so the wizard runs on every add and the value is stored
  // under the account the probe resolves, not in a provider-wide file.
  perAccount: true,
  fields: [
    {
      name: "key_id",
      label: "API key name",
      placeholder: "organizations/<org-id>/apiKeys/<key-id>",
    },
    {
      name: "private_key",
      label: "Private key",
      placeholder: "Paste the full private key block from the downloaded key file",
      secret: true,
    },
  ],
  wizard: {
    intro:
      "Coinbase needs a read-only API key from the Coinbase Developer Platform. " +
      "Create one with View permission only and paste its name and private key on the next screen.",
    why:
      "Omnesis reads your Coinbase balances and trade activity through a key you create " +
      "yourself — restricted to View, so it can never trade, transfer, or withdraw. The key " +
      "stays on this machine and is never shared; only short-lived signed requests reach Coinbase.",
    estMinutes: 5,
    steps: [
      {
        kind: "open-url",
        title: "Open the Coinbase Developer Platform",
        body:
          "Sign in at the Coinbase Developer Platform and open the API keys section. " +
          "This is the same Coinbase login you use for your account.",
        url: "https://portal.cdp.coinbase.com/projects/api-keys",
      },
      {
        kind: "instruction",
        title: "Create a View-only key (recommended: ECDSA)",
        body:
          "Click **Create API key**. Under permissions, enable **View** only — leave Trade " +
          "and Transfer OFF. Choose the **ECDSA** signature algorithm when offered (Ed25519 " +
          "also works). Omnesis verifies the key is View-only and refuses it if Trade or " +
          "Transfer is enabled.",
      },
      {
        kind: "instruction",
        title: "Optionally add the transaction-history permission",
        body:
          "To also sync your deposit/withdrawal ledger (not just trades), enable the read-only " +
          "transaction-history permission as well. It is optional — without it, balances, " +
          "holdings, orders, and fills still sync; the ledger phase simply degrades gracefully.",
      },
      {
        kind: "instruction",
        title: "Copy the key name and private key",
        body:
          "After creating the key, copy its **name** (the long `organizations/.../apiKeys/...` " +
          "identifier) and the **private key** from the downloaded key file. Paste both on the " +
          "next screen. Coinbase shows the private key only once — save it somewhere safe.",
      },
    ],
  },
};
