// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ProviderCredentialsSpec } from "@omnesis/core";

/**
 * Discord bot-token credentials spec.
 *
 * Discord exposes message history only to bots: an ordinary user account may
 * not be automated, and OAuth2 grants no scope that reads messages. So the
 * operator creates their own application, gives it a bot, and invites that
 * bot to the servers to index. The pasted bot token IS the per-account
 * credential; the account id is the bot user's id.
 *
 * `authFlow()` validates the token against `GET /users/@me` and stores it
 * under `<configDir>/discord/<botUserId>/credentials.json`.
 */
export const discordCredentialsSpec: ProviderCredentialsSpec = {
  fileKey: "discord",
  required: true,
  perAccount: true,
  fields: [
    {
      name: "token",
      label: "Discord bot token",
      placeholder: "MTIz…Abc.Xy12Zw.…",
      secret: true,
      pattern: "^[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{20,}$",
      patternHint:
        "A bot token has three dot-separated parts, copied from the Bot page of your application.",
    },
  ],
  wizard: {
    intro:
      "Discord lets only a bot read message history, so Omnesis indexes your servers " +
      "through a bot you create and invite. Set it up once in the Developer Portal and " +
      "paste its token on the next screen.",
    why:
      "The bot reads the channels it can see through Discord's official API using its " +
      "own token — it stays on this machine and is never shared. Omnesis indexes only " +
      "servers the bot is a member of and channels it may view, so the invite and the " +
      "channel permissions you grant decide what gets indexed.",
    estMinutes: 5,
    steps: [
      {
        kind: "open-url",
        title: "Create an application with a bot",
        body:
          "Click **New Application**, name it (for example _Omnesis_), open **Bot** in the " +
          "sidebar and click **Reset Token**. Copy the token — Discord shows it only once.",
        url: "https://discord.com/developers/applications",
      },
      {
        kind: "instruction",
        title: "Enable the Message Content intent",
        body:
          "Still on the **Bot** page, under **Privileged Gateway Intents**, turn on " +
          "**Message Content Intent** and save. Without it Discord blanks every message " +
          "body the bot fetches. An app visible to fewer than 10,000 users may enable it " +
          "without review; past that Discord requires an intent review.",
      },
      {
        kind: "instruction",
        title: "Invite the bot to your servers",
        body:
          "Nothing to do in the portal: once the token is in, Omnesis builds the invite " +
          "link itself, asking only for **View Channels** and **Read Message History**. " +
          "It shows that link the first time it syncs and finds the bot in no server. " +
          "Open it and add the bot to each server you want indexed — you need Manage " +
          "Server on it. To keep a channel private, deny the bot View Channel there.",
      },
    ],
  },
};
