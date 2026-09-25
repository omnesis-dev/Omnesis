// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ProviderCredentialsSpec } from "@omnesis/core";

/**
 * Enable Banking application credentials.
 *
 * The user registers their own (free) Enable Banking application; the
 * browser generates the keypair at registration and downloads the private
 * key as `<application_id>.pem` — it never leaves the user's machines.
 * Omnesis signs every API request locally with that key (RS256 JWT).
 *
 * `private_key` accepts either the raw PEM content or an absolute path to
 * the downloaded file on the machine running the collector; after the
 * first successful auth flow the PEM CONTENT is re-persisted into the
 * credentials file so the original download can be deleted.
 */
export const enableBankingCredentialsSpec: ProviderCredentialsSpec = {
  fileKey: "enable-banking",
  required: true,
  fields: [
    {
      name: "application_id",
      label: "Application ID",
      placeholder: "e.g. 4e3f1c2a-…(shown on your application page)",
    },
    {
      name: "private_key",
      label: "Private key (PEM content, or absolute path to the .pem file)",
      placeholder: "/path/to/<application_id>.pem  or  -----BEGIN PRIVATE KEY-----…",
      secret: true,
    },
    {
      name: "redirect_url",
      label: "Redirect URL (must be whitelisted on the application)",
      placeholder: "{gatewayOrigin}/oauth/callback",
      default: "{gatewayOrigin}/oauth/callback",
    },
  ],
  wizard: {
    intro:
      "Enable Banking connects Omnesis to Revolut and 2,500+ other EU/UK banks " +
      "over PSD2 open banking. Register a free application at enablebanking.com " +
      "and paste its credentials on the next screen.",
    why:
      "Omnesis talks to Enable Banking with your own application — every request " +
      "is signed locally with your private key, which stays on this machine and " +
      "is never shared.",
    estMinutes: 10,
    steps: [
      {
        kind: "open-url",
        title: "Sign in to Enable Banking",
        url: "https://enablebanking.com/sign-in/",
        body:
          "Sign in with your email — Enable Banking sends a magic link and creates " +
          'the account automatically. The free tier ("restricted" applications) is ' +
          "licensed for individual non-commercial use.",
      },
      {
        kind: "open-url",
        title: "Register a Production application",
        url: "https://enablebanking.com/cp/applications",
        body:
          "Create a new application with environment **Production**. In **Redirect URLs**, " +
          "whitelist `{gatewayOrigin}/oauth/callback` — copy it exactly (recommended: the " +
          "bank redirect then lands straight in Omnesis). Note: after the bank redirects there, your " +
          "browser may warn about the gateway's self-signed certificate — click through " +
          "it; the code still reaches Omnesis. You can also whitelist any other HTTPS URL " +
          "you control and copy the `?code=` value from the address bar manually. " +
          "Registering downloads the private key as `<application_id>.pem` — keep it.",
      },
      {
        kind: "instruction",
        title: "Activate by linking accounts",
        body:
          "In the Control Panel, open your application and click **Activate by linking " +
          "accounts**, then authorize your bank (e.g. Revolut — approve in the bank's " +
          "app). Restricted applications can only fetch data from accounts linked this " +
          "way; afterwards the application should show **Restricted** and **Active**.",
      },
      {
        kind: "instruction",
        title: "Paste the application credentials",
        body:
          "On the next screen paste the **Application ID**, the **private key** — either " +
          "the absolute path to the downloaded `.pem` file on the machine running the " +
          "collector, or the PEM content itself — and the **redirect URL** you whitelisted.",
      },
    ],
  },
};
