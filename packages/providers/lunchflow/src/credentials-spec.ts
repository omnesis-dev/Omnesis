// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ProviderCredentialsSpec } from "@omnesis/core";

/**
 * Lunch Flow API credentials.
 *
 * Lunch Flow is a bank-data aggregator: the user connects their banks once in
 * the Lunch Flow web app, then creates an "API destination" to mint a personal
 * API key. That key IS the per-connection credential — collected by the
 * wizard, stored at `~/.config/omnesis/lunchflow-credentials.json` (mode 0600),
 * and sent on every request as `x-api-key`. It stays on the machine running
 * the collector and is never shared.
 */
export const lunchflowCredentialsSpec: ProviderCredentialsSpec = {
  fileKey: "lunchflow",
  required: true,
  // The pasted key IS this account's credential, not an app credential shared
  // across accounts — so the wizard runs on every add and the value is stored
  // under the account the probe resolves, not in a provider-wide file.
  perAccount: true,
  fields: [
    {
      name: "api_key",
      label: "Lunch Flow API key",
      placeholder: "paste the key from your Lunch Flow API destination",
      secret: true,
    },
  ],
  wizard: {
    intro:
      "Lunch Flow connects Omnesis to your banks through open-banking aggregators " +
      "(GoCardless and others), covering UK, EU, and many other banks. Connect your " +
      "accounts in Lunch Flow, create an API destination, and paste its key on the next screen.",
    why:
      "Omnesis reads your accounts through Lunch Flow's API using a personal key — " +
      "read-only access that stays on this machine and is never shared.",
    estMinutes: 5,
    steps: [
      {
        kind: "open-url",
        title: "Sign in to Lunch Flow",
        url: "https://lunchflow.app",
        body: "Create a Lunch Flow account (or sign in) at lunchflow.app.",
      },
      {
        kind: "instruction",
        title: "Connect your banks",
        body:
          "In Lunch Flow, link the bank accounts you want Omnesis to index. Lunch Flow " +
          "handles the bank's open-banking consent for you; come back here once your " +
          "accounts show as connected.",
      },
      {
        kind: "open-url",
        title: "Create an API destination",
        url: "https://lunchflow.app/destinations",
        body:
          "Open **Destinations** and create an **API** destination. This generates your " +
          "personal API key and gives you interactive API docs to explore.",
      },
      {
        kind: "instruction",
        title: "Paste the API key",
        body: "Copy the API key from the destination you just created and paste it on the next screen.",
      },
    ],
  },
};
