// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineProvider, readConnectionState } from "@omnesis/source-sdk";
import { DiscordClient } from "./client.js";
import { discordCredentialsSpec } from "./credentials-spec.js";
import { discordIcon } from "./icons.js";
import {
  authFlow as discordAuthFlow,
  cleanupCredentials as discordCleanupCredentials,
  discoverAccounts,
  hasCredentials,
  loadToken,
} from "./provider.js";
import { DiscordSource } from "./source.js";
import { discordStateSpec } from "./state.js";
import { validateDiscordCursor } from "./types.js";
import type { DocumentEventProfile } from "@omnesis/source-sdk";
import type { DiscordContext } from "./types.js";

export { DiscordClient } from "./client.js";
export { discordCredentialsSpec } from "./credentials-spec.js";
export { DiscordSource } from "./source.js";
export { discordStateSpec } from "./state.js";
export { normalizeChannelDay, renderMessage, discordLid } from "./normalizer.js";
export type { DiscordContext, DiscordCursor, ChannelRef, DiscordMessage } from "./types.js";

const SNOWFLAKE_LIST = /^\s*\d{15,22}(\s*,\s*\d{15,22})*\s*$/;
const SNOWFLAKE = /^\d{15,22}$/;

/** Comma-separated Discord ids from a param value; undefined when blank. */
export function parseIdList(value: unknown): string[] | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

const DISCORD_PARAMS = [
  {
    name: "guilds",
    label:
      "Servers to index (comma-separated server IDs). Leave empty to index every server the " +
      "bot has been invited to. Copy a server ID from Discord with Developer Mode on: " +
      "right-click the server → Copy Server ID.",
    type: "string" as const,
    required: false,
    placeholder: "123456789012345678, 234567890123456789",
    validate: (value: string) =>
      value.trim() === "" || SNOWFLAKE_LIST.test(value)
        ? null
        : "Use numeric server IDs separated by commas.",
  },
  {
    name: "selfUserId",
    label:
      "Your Discord user ID, so your own messages count as yours in the people graph. " +
      "Right-click your name → Copy User ID (Developer Mode).",
    type: "string" as const,
    required: false,
    placeholder: "123456789012345678",
    validate: (value: string) =>
      value.trim() === "" || SNOWFLAKE.test(value.trim()) ? null : "Use your numeric user ID.",
  },
];

/**
 * One conversation document per channel per UTC day.
 *
 * Deliberately undeclared: `extra.guildId` / `extra.channelId` (opaque ids
 * nobody spells), `extra.date` (the document's own day), `sourceUrl`.
 */
export const discordDocumentProfile: DocumentEventProfile = {
  documentTypes: ["conversation"],
  personRoles: ["participant", "mentioned"],
  metadataFields: [
    {
      path: "extra.guildName",
      type: "string",
      description: "Name of the Discord server the channel belongs to.",
    },
    {
      path: "extra.channelName",
      type: "string",
      description: "Name of the channel, thread, or forum post, without the leading #.",
    },
    {
      path: "extra.channelKind",
      type: "string",
      description:
        "What kind of place the conversation happened in: a regular text channel, an announcement channel, a thread opened under a channel, or a post in a forum channel.",
      allowedValues: ["text", "announcement", "thread", "forum-post"],
      valueAliases: {
        text: ["text channel", "channel"],
        announcement: ["announcements", "news channel"],
        thread: ["threads"],
        "forum-post": ["forum", "forum thread", "post"],
      },
    },
    {
      path: "extra.parentChannelName",
      type: "string",
      description:
        "For a thread or forum post, the channel it was opened in. Absent on a top-level channel.",
    },
    {
      path: "extra.participants",
      type: "string-array",
      identifiesPeople: true,
      description:
        "Display name of every person who posted in the channel that day; bots and webhooks are not listed.",
    },
    {
      path: "extra.messageCount",
      type: "number",
      description: "Messages posted that day, excluding system notices.",
    },
  ],
};

export default defineProvider<DiscordContext>({
  provider: { id: "discord", name: "Discord" },
  authType: "api-key",
  experimental: true,
  credentials: discordCredentialsSpec,

  discover(ctx) {
    return Promise.resolve(discoverAccounts(ctx?.configDir).map(String));
  },

  async authFlow(params, callbacks, ctx) {
    return String(await discordAuthFlow(params, callbacks, ctx));
  },

  async cleanupCredentials(accountId: string, ctx) {
    await discordCleanupCredentials(accountId, ctx?.configDir);
  },

  async createContext({ accountId, dataCutoff, host }) {
    const configDir = host?.configDir;
    const client = new DiscordClient(await loadToken(accountId, configDir));
    return { client, accountId, dataCutoff, configDir };
  },

  credentialState(ctx) {
    // Answered from storage alone. A probe here could only add false
    // negatives: an outage or a rate limit would park the source in
    // needs-auth and prompt a re-authentication that cannot resolve it. A
    // genuinely revoked token surfaces as SyncError("auth") from the sync.
    // Never having been connected is a different state from a credential
    // that went away, because the remedy differs — connect, versus
    // authenticate again.
    return readConnectionState(async () => {
      if (!hasCredentials(String(ctx.accountId), ctx.configDir)) {
        return { status: "never-connected" };
      }
      await loadToken(String(ctx.accountId), ctx.configDir);
      return { status: "connected" };
    });
  },

  async disposeContext() {
    // Stateless HTTP client — nothing to clean up.
  },

  sources: [
    {
      id: "discord",
      name: "Discord",
      description:
        "Messages from the Discord servers your bot is in — each channel's day as one searchable conversation, threads and forum posts included",
      unitName: "conversations",
      icon: discordIcon,
      contract: {
        // The host resolves the stored cursor against this before `sync`
        // runs, so a value from a build that could not read it never
        // reaches `sync`.
        state: discordStateSpec,
      },
      documentEventProfile: discordDocumentProfile,
      defaultSyncInterval: "10m",
      params: DISCORD_PARAMS,
      create({ sourceId, providerId, dataCutoff, sourceConfig }, ctx) {
        const cfg = sourceConfig as Record<string, unknown> | undefined;
        const params = (cfg?.params ?? {}) as Record<string, unknown>;
        const selfUserId = parseIdList(params.selfUserId ?? cfg?.selfUserId)?.[0];
        const source = new DiscordSource({
          client: ctx.client,
          providerId,
          sourceId,
          dataCutoff,
          guildIds: parseIdList(params.guilds ?? cfg?.guilds),
          selfUserId,
        });
        return Promise.resolve({
          // Only the instance icon reaches the gateway's sync_state row.
          icon: discordIcon,
          sync: (cursor, opts) => source.sync(validateDiscordCursor(cursor), opts),
        });
      },
    },
  ],
});
