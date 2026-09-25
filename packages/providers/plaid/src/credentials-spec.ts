// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ProviderCredentialsSpec } from "@omnesis/core";

/**
 * Plaid developer-app credentials spec.
 *
 * Plaid has no shared application for third-party tools: the operator creates
 * their own Plaid developer app, copies its `client_id` and the
 * environment-scoped `secret`, and pastes both here. This is the **operator app
 * credential** — configured once and shared across every bank connected —
 * distinct from the per-item `access_token` (the per-account credential) minted
 * when a bank is linked. It is therefore NOT `perAccount`: it is collected
 * once, and a single bad item must never wipe the credential every other item
 * depends on.
 *
 * The credential pins the Plaid `environment` (`sandbox` or `production`) — the
 * secret only authenticates against the environment it was created in — and the
 * countries whose institutions Plaid's Link page offers. The collector stores
 * all of it at `<configDir>/plaid-credentials.json` (mode 0600).
 */
export const plaidCredentialsSpec: ProviderCredentialsSpec = {
  fileKey: "plaid",
  required: true,
  fields: [
    {
      name: "client_id",
      label: "Plaid client ID",
      placeholder: "Your app's client_id from the Plaid dashboard",
    },
    {
      name: "secret",
      label: "Plaid secret",
      placeholder: "The secret for the selected environment",
      secret: true,
    },
    {
      name: "environment",
      label: "Environment",
      placeholder: "sandbox or production",
      pattern: "^(sandbox|production)$",
      patternHint: "Must be exactly 'sandbox' or 'production'.",
    },
    {
      name: "countries",
      label: "Countries",
      placeholder: "US,CA",
      default: "US,CA",
      pattern: "^\\s*[A-Za-z]{2}(\\s*,\\s*[A-Za-z]{2})*\\s*$",
      patternHint: "Comma-separated two-letter country codes, e.g. US,CA or GB.",
    },
  ],
  wizard: {
    intro:
      "Plaid needs a developer app you create yourself. The Sandbox environment is free and " +
      "uses Plaid's test banks; real banks need Production access, which Plaid grants per " +
      "team and bills per connected bank.",
    why:
      "Omnesis reads your bank balances, transactions, and investment holdings through Plaid, " +
      "using account-information access only — it can never move money. The app credential " +
      "stays on this machine and is never shared; only requests you initiate reach Plaid. " +
      "Removing a bank from Omnesis disconnects it at Plaid, which is what ends Plaid's " +
      "per-bank billing.",
    estMinutes: 10,
    steps: [
      {
        kind: "open-url",
        title: "Open the Plaid dashboard",
        body:
          "Sign up or sign in — a Plaid account is free and gives you Sandbox straight away. " +
          "Open Developers → Keys: this is where your client ID and per-environment secrets live.",
        url: "https://dashboard.plaid.com/developers/keys",
      },
      {
        kind: "instruction",
        title: "Copy the client ID and a secret",
        body:
          "Copy your **client_id**. Then copy the **secret** for the environment you intend to " +
          "use: **Sandbox** for Plaid's test banks (log in with `user_good` / `pass_good`), or " +
          "**Production** for real banks. The Sandbox secret will not work against Production " +
          "and vice-versa.",
      },
      {
        kind: "instruction",
        title: "Real banks: get Production access first",
        body:
          "Production is granted per team from the dashboard. In the US and Canada a free Trial " +
          "plan covers up to ten connected banks; elsewhere Plaid offers a capped free " +
          "evaluation and then a negotiated contract. Once a bank is connected Plaid bills it " +
          "monthly until it is disconnected — removing the bank from Omnesis does that.",
      },
      {
        kind: "instruction",
        title: "Paste the values",
        body:
          "On the next screen, paste your client ID and secret, type the environment " +
          "(`sandbox` or `production`) you copied the secret from, and list the countries " +
          "whose banks you want offered (for example `US,CA` or `GB`).",
      },
    ],
  },
};
