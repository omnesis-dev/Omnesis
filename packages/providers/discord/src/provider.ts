// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import {
  clearProviderAccountCredentials,
  createLogger,
  CredentialPersistError,
  hasProviderAccountCredentials,
  listProviderAccountIds,
  loadOrAdoptProviderAccountCredentials,
  MissingCredentialsError,
  writeProviderAccountCredentials,
} from "@omnesis/core";
import { AccountId } from "@omnesis/types";
import { DiscordClient } from "./client.js";
import type { AuthFlowCallbacks, SourceLifecycleContext } from "@omnesis/source-sdk";

const log = createLogger("provider:discord");

const DISCORD_FILE_KEY = "discord";

/** Load one account's stored bot token. */
export async function loadToken(accountId: string, configDir?: string): Promise<string> {
  const fields = await loadOrAdoptProviderAccountCredentials(
    DISCORD_FILE_KEY,
    accountId,
    configDir,
  );
  if (!fields?.token) throw new MissingCredentialsError(DISCORD_FILE_KEY, "Discord");
  return fields.token;
}

/** Whether this account's token is on disk. Offline — no network probe. */
export function hasCredentials(accountId: string, configDir?: string): boolean {
  return hasProviderAccountCredentials(DISCORD_FILE_KEY, accountId, configDir);
}

/**
 * Validate a pasted bot token against `GET /users/@me`, take the bot user's
 * id as the account, and store the token under it. Nothing is written until
 * the probe succeeds, so a bad token leaves no trace.
 */
export async function authFlow(
  _params?: Record<string, string>,
  callbacks?: AuthFlowCallbacks,
  ctx?: SourceLifecycleContext,
): Promise<AccountId> {
  const configDir = ctx?.configDir;
  const reauthAccountId = callbacks?.accountId;
  const token =
    callbacks?.credentials?.token ??
    (reauthAccountId
      ? (await loadOrAdoptProviderAccountCredentials(DISCORD_FILE_KEY, reauthAccountId, configDir))
          ?.token
      : undefined);
  if (!token) throw new MissingCredentialsError(DISCORD_FILE_KEY, "Discord");

  const client = new DiscordClient(token);
  const me = await client.getMe();
  if (!me.bot) {
    throw new Error(
      "This token belongs to a user account, not a bot. Discord forbids automating user " +
        "accounts; create an application in the Developer Portal and paste its bot token.",
    );
  }
  if (reauthAccountId && reauthAccountId !== me.id) {
    throw new Error(
      `This token belongs to bot ${me.username} (${me.id}), not to the bot this source was ` +
        `added with (${reauthAccountId}). Add it as a separate source instead.`,
    );
  }
  const accountId = AccountId(me.id);

  try {
    await writeProviderAccountCredentials(
      DISCORD_FILE_KEY,
      String(accountId),
      { token },
      configDir,
    );
  } catch (err) {
    throw new CredentialPersistError(DISCORD_FILE_KEY, String(accountId), err);
  }
  log.info(
    `Authenticated with Discord as bot ${me.username} (account ${accountId}, token ${fingerprint(token)})`,
  );
  // The bot is useless until it is in a server, and the invite link is the
  // one thing the operator cannot look up. Logged on the way past; the first
  // sync repeats it as a remediation if no server was joined.
  try {
    log.info(`Invite this bot to a server: ${await client.inviteUrl()}`);
  } catch (err) {
    log.warn(`Could not build the bot's invite link: ${(err as Error).message}`);
  }
  return accountId;
}

/** Non-reversible token fingerprint for log lines. */
function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

/** Resolve configured accounts offline — never hits the network. */
export function discoverAccounts(configDir?: string): AccountId[] {
  return listProviderAccountIds(DISCORD_FILE_KEY, configDir).map((id) => AccountId(id));
}

export async function cleanupCredentials(accountId: string, configDir?: string): Promise<void> {
  await clearProviderAccountCredentials(DISCORD_FILE_KEY, accountId, configDir);
  log.info(`Cleaned up Discord credentials for account ${accountId}`);
}
