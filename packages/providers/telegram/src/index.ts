// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The experimental Telegram source: the operator's own account, archived over
 * MTProto through their own Telegram API app (`docs/telegram-source.md`).
 *
 * `buildTelegramProvider` takes the client factory, so the tests and the
 * synthetic twin run this exact definition over the simulated adapter; the
 * default export loads the mtcute adapter lazily, which keeps mtcute and its
 * native SQLite out of every process that only reads descriptors.
 */

import { join } from "node:path";
import { normalizePhone, resolveAttachmentConfig } from "@omnesis/core";
import {
  config,
  defineProvider,
  type AccountDescriptor,
  type ProviderDefinition,
} from "@omnesis/source-sdk";
import { safePathSegment } from "@omnesis/types";
import { loginFlow, removeConnectedAccount } from "./auth.js";
import { telegramCredentialsSpec } from "./credentials-spec.js";
import { telegramDocumentEventProfile } from "./document-event-profile.js";
import { HISTORY_MIN_INTERVAL_MS, WALK_REQUESTS_PER_PAGE } from "./limits.js";
import { TelegramMessagesSource } from "./messages.js";
import { telegramIcon } from "./icons.js";
import { inspectTelegramStores } from "./message-store.js";
import { TelegramProvider } from "./provider.js";
import { listSessionAccounts, readSessionRecord } from "./session-store.js";
import { telegramStateSpec } from "./state.js";
import type { AdapterFactory } from "./client/types.js";
import type { TelegramSyncCursor } from "./types.js";

export { TelegramProvider, REVOKED_REMEDIATION } from "./provider.js";
export { loginFlow } from "./auth.js";
export { telegramCredentialsSpec, loadAppCredentials } from "./credentials-spec.js";
export { TelegramArchive, inspectTelegramStores } from "./message-store.js";
export { telegramStateSpec } from "./state.js";
export { TelegramMessagesSource, type TelegramMessagesSourceOptions } from "./messages.js";
export { telegramDocumentEventProfile } from "./document-event-profile.js";
export { telegramIcon, telegramIconDataUri } from "./icons.js";
export { mapRpcError } from "./client/errors.js";
export { TelegramError, REVOCATION_REASONS } from "./client/types.js";
export type {
  AdapterFactory,
  AppCredentials,
  ChatKind,
  DeviceInfo,
  MessageBox,
  RevocationReason,
  TelegramAdapter,
  TelegramAuthAdapter,
  TelegramErrorCode,
  TgChat,
  TgDialog,
  TgMediaKind,
  TgMediaRef,
  TgMessage,
  TgUpdate,
  TgUser,
} from "./client/types.js";
export type { TelegramSyncCursor } from "./types.js";
export type { TelegramSessionRecord } from "./session-store.js";

export const TELEGRAM_PROVIDER_ID = "telegram";
export const TELEGRAM_SOURCE_ID = "telegram-messages";

/** Where an account's archive and connection cache live when no host says. */
function accountDir(configDir: string, accountId: string): string {
  return join(configDir, TELEGRAM_PROVIDER_ID, safePathSegment(accountId));
}

async function describeAccount(id: string, configDir: string): Promise<AccountDescriptor> {
  // The credential record, never the network. A record that cannot be read
  // right now still names a discoverable account.
  const record = await readSessionRecord(id, configDir).catch(() => null);
  const phone = record?.phone ? normalizePhone(`+${record.phone}`) : null;
  return {
    id,
    ...(record?.username ? { label: `@${record.username}` } : {}),
    subject: phone ? { kind: "phone", value: phone } : { kind: "opaque", value: id },
    aliases: record?.username ? [{ kind: "handle", value: record.username }] : [],
  };
}

/** The config root a lifecycle call names; every host passes one. */
function requireConfigDir(configDir: string | undefined): string {
  if (!configDir)
    throw new Error("The Telegram source needs a host that names its config directory.");
  return configDir;
}

/** A validated config number (the host has already checked its range). */
function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function buildTelegramProvider(
  loadFactory: () => Promise<AdapterFactory>,
): ProviderDefinition<TelegramProvider> {
  return defineProvider<TelegramProvider>({
    provider: { id: TELEGRAM_PROVIDER_ID, name: "Telegram" },
    authType: "qr",
    experimental: true,
    // Exclusive, because the other modes cannot work: the archive is local to
    // its host and the cursor is bound to that archive's storeId, so a
    // handoff would hand a cursor no other host can resume; and Telegram's
    // cloud already holds the authoritative copy every host would read, so a
    // replica adds nothing but a second session on the account.
    multiDevice: { mode: "exclusive" },
    credentials: telegramCredentialsSpec,
    contract: { apiVersion: 2, requires: ["state-envelope", "scoped-host", "typed-config"] },

    async discover(ctx) {
      const configDir = requireConfigDir(ctx?.configDir);
      return Promise.all(
        listSessionAccounts(configDir).map((id) => describeAccount(id, configDir)),
      );
    },

    async authenticate(session) {
      return loginFlow(session, { factory: await loadFactory() });
    },

    async cleanupCredentials(accountId, ctx) {
      const configDir = requireConfigDir(ctx?.configDir);
      await removeConnectedAccount(accountId, configDir, {
        factory: await loadFactory(),
        stateDir: accountDir(configDir, accountId),
      });
    },

    async createContext({ accountId, host }) {
      if (!host) throw new Error("The Telegram source needs a host that provides its directories.");
      return TelegramProvider.open({
        accountId,
        configDir: host.configDir,
        stateDir: host.stateDir,
        factory: await loadFactory(),
      });
    },

    async disposeContext(provider) {
      await provider.dispose();
    },

    credentialState(provider) {
      return provider.credentialState();
    },

    sources: [
      {
        id: TELEGRAM_SOURCE_ID,
        name: "Telegram Messages",
        description: "Sync your Telegram chats through your own Telegram API app (QR sign-in)",
        unitName: "messages",
        conversational: true,
        contentRetention: "complete",
        defaultSyncInterval: "15m",
        ownedWebDomains: ["web.telegram.org"],
        icon: telegramIcon,
        selfIdentity: { aliasPrefix: "telegram-user", accountPattern: "^\\d+$" },
        documentEventProfile: telegramDocumentEventProfile,
        contract: { state: telegramStateSpec, outputRevision: 1 },
        config: config.object({
          includeChannels: config.boolean({
            label: "Include broadcast channels",
            default: false,
            help: "Off by default. Leave off to archive only your chats and groups.",
          }),
          excludedChats: config.list(config.string({ label: "Chat" }), {
            label: "Excluded chats",
            default: [],
            help: "Chat IDs or @usernames to skip. Already-archived content from them is removed. Leave empty to include every chat.",
          }),
          historyRequestsPerPage: config.number({
            label: "History requests per sync page",
            default: WALK_REQUESTS_PER_PAGE,
            min: 1,
            max: 100,
            integer: true,
            advanced: true,
            help: "How many history requests one sync page makes. Lower it if Telegram asks Omnesis to slow down.",
          }),
          historyMinIntervalMs: config.number({
            label: "Delay between history requests (ms)",
            default: HISTORY_MIN_INTERVAL_MS,
            min: 250,
            max: 60_000,
            integer: true,
            advanced: true,
            help: "The least time between two history requests. Raise it if Telegram asks Omnesis to slow down.",
          }),
        }),

        create(
          { host, accountId, sourceId, providerId, config: options, dataCutoff, sourceConfig },
          provider,
        ) {
          const configDir = host?.configDir;
          const stateDir =
            host?.stateDir ?? (configDir ? accountDir(configDir, accountId) : undefined);
          const source = new TelegramMessagesSource(provider, {
            sourceId,
            providerId,
            policy: {
              includeChannels: options?.includeChannels === true,
              excludedChats: Array.isArray(options?.excludedChats)
                ? options.excludedChats.filter((c): c is string => typeof c === "string")
                : [],
            },
            ...(dataCutoff ? { dataCutoff } : {}),
            ...(host?.ingestion?.phoneRegion ? { phoneRegion: host.ingestion.phoneRegion } : {}),
            attachmentConfig: resolveAttachmentConfig(sourceConfig, { defaultEnabled: true }),
            ...(host?.transcribeAudio ? { transcribeAudio: host.transcribeAudio } : {}),
            ...(host?.extractAttachment ? { extractAttachment: host.extractAttachment } : {}),
            takeout: true,
            walkLimits: {
              requestsPerPage: positiveInt(options?.historyRequestsPerPage, WALK_REQUESTS_PER_PAGE),
              minIntervalMs: positiveInt(options?.historyMinIntervalMs, HISTORY_MIN_INTERVAL_MS),
            },
          });
          // The context closes when its last source is disposed: a rebuild
          // gives the new source a new context, so this is what closes the old one.
          const release = provider.attach();
          return Promise.resolve({
            icon: telegramIcon,
            sync: (cursor, opts) => source.sync(cursor as TelegramSyncCursor | null, opts),
            onPushEvent: (callback) => source.onPushEvent(callback),
            onResync: () => source.onResync(),
            onSourceError: (callback) => provider.onSourceError(callback),
            suspend: () => provider.suspend(),
            resume: () => provider.resume(),
            probeLocalStores: () =>
              Promise.resolve(
                stateDir && configDir ? inspectTelegramStores(stateDir, configDir) : [],
              ),
            async dispose() {
              source.dispose();
              await release();
            },
          });
        },
      },
    ],
  });
}

export default buildTelegramProvider(async () => {
  const { mtcuteAdapterFactory } = await import("./client/mtcute/adapter.js");
  return mtcuteAdapterFactory;
});
