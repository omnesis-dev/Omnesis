// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ProviderCredentialsSpec } from "@omnesis/core";

/**
 * Microsoft / Outlook OAuth credentials spec.
 *
 * `required: false` and `publicClient: true`: Outlook auth is PKCE on a
 * public Azure app. The `client_id` is genuinely public per the OAuth2
 * spec for native/desktop clients, so a shared Azure app registration is
 * normal practice. The wizard exists for users who would rather sign in
 * against an app registration they control than against Omnesis's.
 *
 * It does not unlock work or school accounts. Sign-in goes to the
 * `/consumers` authority, which accepts personal Microsoft accounts and
 * refuses organizational ones whatever client id is presented — so the copy
 * below must not offer an Azure registration as the way to connect one.
 */
export const outlookCredentialsSpec: ProviderCredentialsSpec = {
  fileKey: "outlook",
  required: false,
  publicClient: true,
  fields: [
    {
      name: "client_id",
      label: "Application (client) ID",
      placeholder: "uuid-style Azure app ID",
      pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
      patternHint: "Azure client IDs are UUIDs",
    },
  ],
  wizard: {
    intro:
      "Outlook ships with a registered public Azure app that works for everyone — " +
      "you only need this wizard if you would rather sign in against an Azure app " +
      "registration you control.",
    why:
      "By default, Omnesis uses a registered public Azure app. The PKCE flow doesn't " +
      "require a client secret, and the client ID is intentionally public per the " +
      "OAuth2 spec for native apps. Bring your own client ID if you would rather " +
      "the consent screen name your app registration instead of Omnesis's, or you " +
      "want to see the access in your own Azure audit logs.\n\n" +
      "These sources connect personal Microsoft accounts — Outlook.com, Hotmail, " +
      "Live. A work or school account cannot sign in, and your own Azure app does " +
      "not change that.",
    estMinutes: 4,
    steps: [
      {
        kind: "open-url",
        title: "Open Azure App registrations",
        body:
          "Sign into the Azure portal and go to **App registrations**. " +
          "Click **+ New registration**.",
        url: "https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
      },
      {
        kind: "instruction",
        title: "Register the app",
        body:
          "Name: anything (e.g. `Omnesis`).\n" +
          "Supported account types: **Personal Microsoft accounts only**. Omnesis " +
          "signs in against the consumer authority, so a multi-tenant registration " +
          "would still be refused a work or school account.\n" +
          "Redirect URI: pick **Public client/native (mobile & desktop)** and enter " +
          "`http://localhost:3001/auth/callback`.\n\n" +
          "Click **Register**.",
      },
      {
        kind: "instruction",
        title: "Configure API permissions",
        body:
          "On the app's **API permissions** page, click **+ Add a permission → " +
          "Microsoft Graph → Delegated permissions** and add `Mail.Read`, " +
          "`Files.Read`, `Calendars.Read`, and `offline_access`.\n\n" +
          "A personal account consents to these itself the first time you connect — " +
          "there is no administrator to ask.",
      },
      {
        kind: "instruction",
        title: "Copy the Application (client) ID",
        body:
          "Back on the app's **Overview** page, copy the **Application (client) ID**. " +
          "You'll paste it on the next screen. There's no client secret to copy — " +
          "PKCE doesn't use one.",
      },
    ],
  },
};
