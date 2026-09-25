// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ProviderCredentialsSpec } from "@omnesis/core";

/**
 * Google OAuth credentials spec.
 *
 * Required: each Omnesis user creates their own Google Cloud project + OAuth
 * client. We don't ship a bundled client because:
 *
 *   - Google caps test-mode external apps at 100 test users.
 *   - Gmail-scope verification needs a CASA security audit, which doesn't fit
 *     a free, local, privacy-first OSS tool.
 *
 * The wizard walks the user through creating the project, enabling APIs,
 * configuring the OAuth consent screen (External) and publishing it to
 * Production, and creating a Desktop-app OAuth client. Publishing to
 * Production matters: Google expires the refresh token after 7 days for
 * Testing-status apps that request sensitive scopes, which would force a
 * weekly re-auth. Production status stops that and needs no verification for
 * personal use.
 */
export const googleCredentialsSpec: ProviderCredentialsSpec = {
  fileKey: "google",
  required: true,
  fields: [
    {
      name: "client_id",
      label: "Client ID",
      placeholder: "123456789012-abc...apps.googleusercontent.com",
      pattern: "^[0-9]+-[a-z0-9]+\\.apps\\.googleusercontent\\.com$",
      patternHint: "Must look like 123456789012-xyz.apps.googleusercontent.com",
    },
    {
      name: "client_secret",
      label: "Client secret",
      placeholder: "GOCSPX-...",
      secret: true,
      pattern: "^GOCSPX-[A-Za-z0-9_-]+$",
      patternHint: "Must start with GOCSPX-",
    },
  ],
  wizard: {
    intro:
      "Gmail / Calendar / Drive / Contacts need OAuth credentials from your own Google Cloud project.",
    why:
      "Google requires per-developer verification for Gmail-scope access. " +
      "Self-hosted Omnesis can't share one OAuth client across users — the project " +
      "would hit Google's 100-test-user cap, and going past that needs a CASA audit. " +
      "So every install creates its own OAuth client. Takes about 5 minutes.",
    estMinutes: 5,
    steps: [
      {
        kind: "open-url",
        title: "Create a Google Cloud project",
        body:
          "Open the Cloud Console and create a new project (any name — e.g. `omnesis`). " +
          "If you already have a project you want to reuse, just select it.",
        url: "https://console.cloud.google.com/projectcreate",
      },
      {
        kind: "open-url",
        title: "Enable the four APIs",
        body:
          "Enable each of these APIs for the project (one click each):\n" +
          "  • Gmail API\n" +
          "  • Google Calendar API\n" +
          "  • Google Drive API\n" +
          "  • People API (for Contacts)",
        url: "https://console.cloud.google.com/apis/library",
      },
      {
        kind: "open-url",
        title: "Configure the consent screen and publish to Production",
        body:
          "Pick **External**, then **Create**. Fill in the app name (e.g. `Omnesis`) " +
          "and your email. You don't need a logo or homepage URL.\n\n" +
          "On the **Scopes** page, leave the defaults — Omnesis declares its scopes at " +
          "auth time, you don't need to register them here.\n\n" +
          "**Publish the app.** On the **Audience** page (older console: the consent " +
          "screen's **Publishing status**), click **Publish app** and confirm so the " +
          "status is **In production**. This is the important step: an app left in " +
          "**Testing** gets a refresh token that Google expires after 7 days, so every " +
          "Google source would drop to `needs-auth` about once a week. Publishing stops " +
          "that, and needs no Google verification for personal use — when you authorize, " +
          'just click through the one-time "Google hasn\'t verified this app" → ' +
          "**Advanced** → **Continue** warning.",
        url: "https://console.cloud.google.com/apis/credentials/consent",
      },
      {
        kind: "open-url",
        title: "Create the OAuth client",
        body:
          "Click **+ Create credentials → OAuth client ID**.\n\n" +
          "Application type: **Desktop app**. Name: anything.\n\n" +
          "Click **Create** — you'll get a **Client ID** and **Client secret**. " +
          "Keep that dialog open; you'll paste both on the next screen.",
        url: "https://console.cloud.google.com/apis/credentials",
      },
    ],
  },
};
