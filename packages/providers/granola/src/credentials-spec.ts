// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ProviderCredentialsSpec } from "@omnesis/core";

/**
 * Granola API-key credentials spec.
 *
 * Granola issues a personal API key (`grn_…`) per user from the desktop app.
 * Unlike OAuth providers, the key IS the per-account credential — there's no
 * client id/secret and no browser redirect. The wizard walks the user through
 * minting a key and pasting it; the collector stores it at
 * `<configDir>/granola-credentials.json` (mode 0600). `authFlow()` then
 * validates the key against `GET /notes` and resolves the account.
 */
export const granolaCredentialsSpec: ProviderCredentialsSpec = {
  fileKey: "granola",
  required: true,
  // The pasted key IS this account's credential, not an app credential shared
  // across accounts — so the wizard runs on every add and the value is stored
  // under the account the probe resolves, not in a provider-wide file.
  perAccount: true,
  fields: [
    {
      name: "api_key",
      label: "Granola API key",
      placeholder: "grn_...",
      secret: true,
      // Every key the desktop app mints carries this prefix, so a client can
      // say "that is not a Granola key" without waiting for a probe to say it
      // more slowly. Deliberately loose past the prefix: the body is opaque
      // and a tighter shape would refuse a key Granola considers valid.
      pattern: "^grn_\\S+$",
      patternHint: "A Granola API key starts with grn_",
    },
  ],
  wizard: {
    intro:
      "Granola needs a personal API key to read your meeting notes. " +
      "Create one in the Granola desktop app and paste it on the next screen.",
    why:
      "Omnesis reads your notes through Granola's public API using a personal " +
      "API key — it stays on this machine and is never shared.",
    estMinutes: 2,
    steps: [
      {
        kind: "instruction",
        title: "Open API key settings in Granola",
        body:
          "In the Granola desktop app, open **Settings → Connectors → API keys**. " +
          "(API access requires a Granola plan that includes the public API.)",
      },
      {
        kind: "instruction",
        title: "Create and copy a new key",
        body:
          "Click **+ New API key**, give it a name like 'Omnesis', and copy the " +
          "generated key. It starts with `grn_`. Paste it on the next screen.",
      },
    ],
  },
};
