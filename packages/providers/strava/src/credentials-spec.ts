// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ProviderCredentialsSpec } from "@omnesis/core";

/**
 * Strava OAuth credentials spec.
 *
 * Required: each Omnesis user creates their own Strava API app. We don't
 * ship a bundled client because a Standard Tier app connects one athlete (its
 * owner can raise that to ten), and every athlete it connects shares its read
 * limits.
 *
 * The account that creates the app needs an active Strava subscription:
 * Strava deactivates a Standard Tier app whose owner has none, and every
 * request through it is refused until the owner subscribes and reactivates
 * it (see `StravaApplicationInactiveError`). The athletes who connect need
 * none.
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
      placeholder: "40-character hex string",
      secret: true,
      // Exactly 40, so a paste that lost its last characters is refused here
      // rather than by Strava after the whole browser round trip.
      pattern: "^[a-fA-F0-9]{40}$",
      patternHint: "Strava client secrets are 40-character hex strings",
    },
  ],
  wizard: {
    intro:
      "Strava needs OAuth credentials from your own Strava API app, created by a Strava " +
      "account with an active subscription.",
    why:
      "A new Strava API app connects one athlete (its owner can raise that to ten), and every " +
      "athlete it connects shares its read limits, so every install registers its own. " +
      "Strava deactivates an app whose owner has no active subscription; the athletes who " +
      "connect to it need none. Two minutes.",
    estMinutes: 2,
    steps: [
      {
        kind: "open-url",
        title: "Create your Strava API app",
        body:
          "Open the Strava API settings page and click **Create & Manage Your App**. " +
          "Log in with the Strava account that has the subscription: the app belongs to it.",
        url: "https://www.strava.com/settings/api",
      },
      {
        kind: "instruction",
        title: "Fill in the form",
        body:
          "Application Name: anything (e.g. `Omnesis`).\n" +
          "Category: pick anything (e.g. `Other`).\n" +
          "Website: any URL (e.g. `https://omnesis.dev`).\n" +
          "**Authorization Callback Domain** — this one matters. If your gateway has a " +
          "public address (`gateway.publicBaseUrl`), enter its host name, e.g. " +
          "`omnesis.example.com`; otherwise enter `localhost`. No scheme, no port, no path. " +
          "Strava accepts `localhost` whatever you enter here, so a sign-in without a public " +
          "address keeps working.\n\n" +
          "Tick the agreement and click **Create**.",
      },
      {
        kind: "instruction",
        title: "Copy the client ID and secret",
        body:
          "After creating the app, Strava shows your **Client ID** (numeric) and " +
          "**Client Secret** (40-character hex string). Click **Show** next to the secret. " +
          "Paste both on the next screen.",
      },
    ],
  },
};
