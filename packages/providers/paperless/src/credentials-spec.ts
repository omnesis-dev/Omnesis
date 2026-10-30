// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ProviderCredentialsSpec } from "@omnesis/core";

/**
 * Paperless-ngx connection credentials.
 *
 * Paperless-ngx is self-hosted, so a connection is two things: where the
 * instance answers and a per-user API token for it. Both are this account's
 * credential — a token is meaningless without its instance — so they are
 * stored together under the account `authenticate()` resolves, and only
 * after the instance accepted them.
 */
export const paperlessCredentialsSpec: ProviderCredentialsSpec = {
  fileKey: "paperless",
  required: true,
  perAccount: true,
  fields: [
    {
      name: "base_url",
      label: "Paperless-ngx address",
      placeholder: "http://paperless.local:8000",
      pattern: "^https?://\\S+$",
      patternHint: "The address you open Paperless-ngx at, starting with http:// or https://",
    },
    {
      name: "api_token",
      label: "API token",
      secret: true,
      // Tokens are opaque hex today; anything past "no whitespace" would
      // refuse a token a future Paperless considers valid.
      pattern: "^\\S+$",
      patternHint: "Paste the token exactly as Paperless-ngx shows it",
    },
  ],
  wizard: {
    intro:
      "Paperless-ngx needs its address and an API token for your user. " +
      "Omnesis reads documents through the Paperless-ngx REST API with that token.",
    why:
      "The token stays on this collector. It sees exactly what your Paperless-ngx user can see, " +
      "and Omnesis only reads. A token carries every permission of its user, so a user with " +
      "only the View permission on documents, tags, correspondents, document types, custom " +
      "fields and UI settings is enough. Paperless-ngx tells Omnesis who the user is through " +
      "the UI settings.",
    estMinutes: 2,
    steps: [
      {
        kind: "instruction",
        title: "Open your Paperless-ngx profile",
        body:
          "In Paperless-ngx, open the user menu in the top right and choose **My Profile**. " +
          "Under **API Auth Token**, create a token or copy the existing one.",
      },
      {
        kind: "instruction",
        title: "Enter the address and the token",
        body:
          "Use the address you open Paperless-ngx at, including any path it is served under " +
          "(for example `https://nas.example.com/paperless`). The collector must be able to reach it.",
      },
    ],
  },
};
