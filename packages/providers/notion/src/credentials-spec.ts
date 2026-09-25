// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ProviderCredentialsSpec } from "@omnesis/core";

/**
 * Notion OAuth credentials spec.
 *
 * `required: true`: Notion now follows the same user-provided-OAuth
 * pattern Google and Strava use. Pre-fix the provider shipped a
 * hardcoded `secret_…` literal split + base64-encoded to defeat
 * scanner regexes; that worked but left the maintainer with no way
 * to rotate the secret without re-shipping the binary, and any
 * scanner that catches up to the obfuscation lights the repo up
 * again. Aligning with Google/Strava removes the literal entirely
 * and cleans the OSS-launch blocker (#314).
 *
 * The wizard walks the user through registering their own Notion
 * public integration and pasting the resulting OAuth client ID +
 * secret. The collector stores them at
 * `<configDir>/notion-credentials.json` (mode 0600).
 */
export const notionCredentialsSpec: ProviderCredentialsSpec = {
  fileKey: "notion",
  required: true,
  fields: [
    {
      name: "client_id",
      label: "OAuth client ID",
      placeholder: "uuid-style integration ID",
    },
    {
      name: "client_secret",
      label: "OAuth client secret",
      placeholder: "secret_...",
      secret: true,
    },
  ],
  wizard: {
    intro:
      "Notion needs OAuth credentials. Register a public integration " +
      "with Notion and paste the resulting client ID and secret.",
    why:
      "Notion's API requires every OAuth integration to have a real client_id " +
      "and client_secret — the same shape Google and Strava use, where each " +
      "install brings its own credentials.",
    estMinutes: 3,
    steps: [
      {
        kind: "open-url",
        title: "Create a Notion integration",
        body:
          "Open the Notion integrations page and click **+ New integration**. " +
          "Pick **Public** integration type — Omnesis uses OAuth, not internal " +
          "integration tokens.",
        url: "https://www.notion.so/profile/integrations",
      },
      {
        kind: "instruction",
        title: "Configure the integration",
        body:
          "Add a name + workspace, then under **OAuth Domain & URIs**, add:\n" +
          "  • Redirect URI: `http://localhost:3002/oauth2callback`\n\n" +
          "Set the **Capabilities** scopes to read content, read user info " +
          "(without email is fine).",
      },
      {
        kind: "instruction",
        title: "Copy the OAuth client ID and secret",
        body:
          "On the integration's **Configuration** tab, find the **OAuth client ID** " +
          "and **OAuth client secret**. Paste them on the next screen.",
      },
    ],
  },
};
