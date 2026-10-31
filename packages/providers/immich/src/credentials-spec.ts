// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ProviderCredentialsSpec } from "@omnesis/core";

/** The API-key permissions the source cannot sync without. */
export const REQUIRED_PERMISSIONS = ["asset.read", "album.read", "user.read"] as const;

/**
 * Immich credentials: the server's address and one user's API key.
 *
 * Both belong to the credential rather than to the source's settings: the
 * address is how the key is presented, and the key decides whose library is
 * read. Immich applies its own permissions to that user, so the source only
 * ever sees what that user can see.
 */
export const immichCredentialsSpec: ProviderCredentialsSpec = {
  fileKey: "immich",
  required: true,
  perAccount: true,
  fields: [
    {
      name: "base_url",
      label: "Immich address",
      placeholder: "http://immich.local:2283",
      pattern: "^https?://[^\\s/?#]+(?:/[^\\s?#]*)?$",
      patternHint: "The address you open Immich at, starting with http:// or https://",
    },
    {
      name: "api_key",
      label: "Immich API key",
      secret: true,
    },
  ],
  wizard: {
    intro:
      "Omnesis reads one Immich user's library through that user's API key. " +
      "It indexes dates, places, named people, albums and descriptions — never the photos themselves.",
    why:
      "The key stays on this collector in the Omnesis secret store. Immich decides what it can " +
      "see, so Omnesis only ever reads what that user can open in Immich.",
    estMinutes: 3,
    steps: [
      {
        kind: "instruction",
        title: "Create an API key in Immich",
        body:
          "Sign in to Immich as the user whose library you want to index, open **Account Settings → " +
          "API Keys** and create a key named 'Omnesis'. Grant it **asset.read**, **album.read** and " +
          "**user.read**. Nothing else is needed.",
      },
      {
        kind: "instruction",
        title: "Paste the address and the key",
        body:
          "Use the address you open Immich at in a browser, for example `http://immich.local:2283`. " +
          "Plain http is accepted for a server on your home network; the key then crosses that " +
          "network unencrypted.",
      },
    ],
  },
};
