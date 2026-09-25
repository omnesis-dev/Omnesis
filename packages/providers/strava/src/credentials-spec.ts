// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ProviderCredentialsSpec } from "@omnesis/core";

/**
 * Strava OAuth credentials spec.
 *
 * Required: each Omnesis user creates their own Strava API app. We don't
 * ship a bundled client because Strava caps shared OAuth apps at exactly
 * **one connected athlete** — the second user to install Omnesis literally
 * cannot connect to a shared client.
 */
export const stravaCredentialsSpec: ProviderCredentialsSpec = {
  fileKey: "strava",
  required: true,
  fields: [
    {
      name: "client_id",
      label: "Client ID",
      placeholder: "226848",
      pattern: "^[0-9]+$",
      patternHint: "Strava client IDs are numeric",
    },
    {
      name: "client_secret",
      label: "Client secret",
      placeholder: "32-character hex string",
      secret: true,
      pattern: "^[a-fA-F0-9]{32,}$",
      patternHint: "Strava client secrets are 40-character hex strings",
    },
  ],
  wizard: {
    intro: "Strava needs OAuth credentials from your own Strava API app.",
    why:
      "Strava's shared API apps are capped at one connected athlete — the second " +
      "user to install Omnesis can't connect at all if we ship a bundled client. " +
      "So every install registers its own. Two minutes.",
    estMinutes: 2,
    steps: [
      {
        kind: "open-url",
        title: "Create your Strava API app",
        body:
          "Open the Strava API settings page and click **Create & Manage Your App**. " +
          "You may need to log in if you aren't already.",
        url: "https://www.strava.com/settings/api",
      },
      {
        kind: "instruction",
        title: "Fill in the form",
        body:
          "Application Name: anything (e.g. `Omnesis`).\n" +
          "Category: pick anything (e.g. `Other`).\n" +
          "Website: any URL (e.g. `https://omnesis.dev`).\n" +
          "**Authorization Callback Domain: `localhost`** — this one matters. " +
          "No scheme, no port, no path. Just `localhost`.\n\n" +
          "Tick the agreement and click **Create**.",
      },
      {
        kind: "instruction",
        title: "Copy the client ID and secret",
        body:
          "After creating the app, Strava shows your **Client ID** (numeric) and " +
          "**Client Secret** (long hex string). Click **Show** next to the secret. " +
          "Paste both on the next screen.",
      },
    ],
  },
};
