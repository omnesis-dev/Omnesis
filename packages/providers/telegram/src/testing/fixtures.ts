// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Invented people and helpers the Telegram tests share. Every name, number and
 * id here is fictional: phone numbers sit in NANP's 555-0100–0199 fiction range
 * (inside a real area code, so they normalise to E.164), user ids are made up,
 * and handles are `*_example`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProviderCredentials } from "@omnesis/core";
import { fakeProviderHost } from "@omnesis/source-sdk/testing";
import { ProviderId, SourceId } from "@omnesis/types";
import { TELEGRAM_FILE_KEY } from "../credentials-spec.js";
import { TelegramMessagesSource, type TelegramMessagesSourceOptions } from "../messages.js";
import { TelegramProvider } from "../provider.js";
import { writeSessionRecord } from "../session-store.js";
import { SimulatedTelegram, type SimulatedCorpus } from "./simulated-telegram.js";
import type { ChatKind, MessageBox, TgChat, TgMessage, TgUser } from "../client/types.js";
import type { TelegramSyncCursor } from "../types.js";
import type { DocumentInput } from "@omnesis/types";
import type {
  AskableChallenge,
  AuthAnswer,
  AuthChallengeKind,
  AuthSession,
  ShowableChallenge,
  SyncResult,
} from "@omnesis/source-sdk";

export const SELF: TgUser = {
  id: 5550100101,
  firstName: "Maya",
  lastName: "Reeves",
  username: "maya_example",
  phone: "12025550101",
  isBot: false,
  isDeleted: false,
  isSelf: true,
};

export const OTHER_ACCOUNT: TgUser = {
  id: 5550100102,
  firstName: "Jamie",
  lastName: "Lopez",
  username: "jamie_example",
  phone: "12025550102",
  isBot: false,
  isDeleted: false,
  isSelf: true,
};

export const APP_CREDENTIALS = {
  api_id: "1234567",
  api_hash: "0123456789abcdef0123456789abcdef",
};

export function tempConfigDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `omnesis-telegram-${label}-`));
}

export async function writeAppCredentials(configDir: string): Promise<void> {
  await writeProviderCredentials(TELEGRAM_FILE_KEY, APP_CREDENTIALS, configDir);
}

export interface ScriptedSession {
  session: AuthSession;
  shown: ShowableChallenge[];
  asked: AskableChallenge[];
}

/**
 * An `AuthSession` whose `ask` answers the two-step password challenge from
 * `passwords`, in order.
 */
export function scriptedSession(
  configDir: string,
  opts: { accountId?: string; passwords?: string[]; renders?: AuthChallengeKind[] } = {},
): ScriptedSession {
  const shown: ShowableChallenge[] = [];
  const asked: AskableChallenge[] = [];
  const passwords = [...(opts.passwords ?? [])];
  const renders = new Set(opts.renders ?? ["qr", "wait", "fields"]);
  const session: AuthSession = {
    reason: opts.accountId ? "reauthenticate" : "connect",
    flowId: "flow-telegram-test",
    ...(opts.accountId ? { accountId: opts.accountId } : {}),
    supplied: {},
    host: fakeProviderHost({
      configDir,
      stateDir: join(configDir, "telegram"),
      now: () => new Date(),
    }),
    canShow: (kind) => renders.has(kind),
    show: (challenge) => void shown.push(challenge),
    ask: <C extends AskableChallenge>(challenge: C) => {
      asked.push(challenge);
      return Promise.resolve({ password: passwords.shift() ?? "" } as unknown as AuthAnswer<C>);
    },
  };
  return { session, shown, asked };
}

/** Wait until `predicate` holds, polling on the event loop. */
export async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ── A small invented corpus for the sync tests ─────────────────────────

export const JAMIE: TgUser = {
  id: 5550100103,
  firstName: "Jamie",
  lastName: "Lopez",
  username: "jamie_lopez_example",
  phone: "12025550103",
  isBot: false,
  isDeleted: false,
  isSelf: false,
};

export const DAVID: TgUser = {
  id: 5550100104,
  firstName: "David",
  lastName: "Lin",
  isBot: false,
  isDeleted: false,
  isSelf: false,
};

export const HELPER_BOT: TgUser = {
  id: 5550100105,
  firstName: "Stellar Sound Bot",
  username: "stellar_sound_bot",
  isBot: true,
  isDeleted: false,
  isSelf: false,
};

/** 2026-03-10T09:00:00Z, the corpus's first morning. */
export const T0 = Date.parse("2026-03-10T09:00:00.000Z") / 1000;

export function privateChatWith(user: TgUser, extra: Partial<TgChat> = {}): TgChat {
  return {
    id: user.id,
    kind: "private",
    title: [user.firstName, user.lastName].filter(Boolean).join(" "),
    ...(user.username ? { username: user.username } : {}),
    isArchived: false,
    topMessageId: 0,
    isForum: false,
    ...extra,
  };
}

export function chatOf(
  id: number,
  kind: ChatKind,
  title: string,
  extra: Partial<TgChat> = {},
): TgChat {
  return {
    id,
    kind,
    title,
    isArchived: false,
    topMessageId: 0,
    isForum: kind === "forum",
    ...extra,
  };
}

/** A message in `chat`, in the box its kind implies. */
export function messageIn(
  chat: TgChat,
  id: number,
  date: number,
  text: string,
  extra: Partial<TgMessage> = {},
): TgMessage {
  const box: MessageBox =
    chat.kind === "supergroup" || chat.kind === "forum" || chat.kind === "channel"
      ? `channel:${chat.id}`
      : "common";
  return { chatId: chat.id, id, box, date, outgoing: false, text, ...extra };
}

/** `count` messages from `sender`, one a minute from `start`, ids from `firstId`. */
export function messageRun(
  chat: TgChat,
  sender: TgUser,
  firstId: number,
  count: number,
  start: number,
  step = 60,
): TgMessage[] {
  return Array.from({ length: count }, (_, i) =>
    messageIn(
      chat,
      firstId + i,
      start + i * step,
      `Note ${firstId + i} about the Q4 budget review`,
      {
        senderId: sender.id,
        senderName: [sender.firstName, sender.lastName].filter(Boolean).join(" "),
        outgoing: sender.isSelf,
      },
    ),
  );
}

export interface SyncRig {
  sim: SimulatedTelegram;
  provider: TelegramProvider;
  source: TelegramMessagesSource;
  configDir: string;
  stateDir: string;
  /** Build another source over the same provider (a config change). */
  remake(options?: Partial<TelegramMessagesSourceOptions>): TelegramMessagesSource;
  /** Close the provider and reopen it over the same directories (a restart). */
  restart(options?: Partial<TelegramMessagesSourceOptions>): Promise<void>;
  dispose(): Promise<void>;
}

/** No pacing: tests that are not about pacing do not wait a second per request. */
const instantClock = {
  now: () => Date.now(),
  sleep: () => Promise.resolve(),
};

/**
 * A connected provider and source over a simulated server holding `corpus`.
 * The account is {@link SELF}.
 */
export async function syncRig(
  corpus: Omit<SimulatedCorpus, "self">,
  options: Partial<TelegramMessagesSourceOptions> = {},
): Promise<SyncRig> {
  const configDir = tempConfigDir("sync");
  const stateDir = join(configDir, "telegram", String(SELF.id));
  await writeAppCredentials(configDir);
  const sim = new SimulatedTelegram({ self: SELF, ...corpus });
  await writeSessionRecord(
    {
      session: sim.issueSession(SELF.id),
      userId: String(SELF.id),
      apiId: APP_CREDENTIALS.api_id,
      connectedAt: "2026-03-10T08:00:00.000Z",
    },
    configDir,
  );
  const make = (provider: TelegramProvider, extra: Partial<TelegramMessagesSourceOptions> = {}) =>
    new TelegramMessagesSource(provider, {
      sourceId: SourceId(`telegram-messages:${SELF.id}`),
      providerId: ProviderId(`telegram:${SELF.id}`),
      policy: { includeChannels: false, excludedChats: [] },
      clock: instantClock,
      takeout: false,
      ...options,
      ...extra,
    });
  const openProvider = async (): Promise<TelegramProvider> => {
    const provider = await TelegramProvider.open({
      accountId: String(SELF.id),
      configDir,
      stateDir,
      factory: sim.factory,
    });
    await provider.ready();
    return provider;
  };
  const rig: SyncRig = {
    sim,
    provider: await openProvider(),
    source: undefined as unknown as TelegramMessagesSource,
    configDir,
    stateDir,
    remake(extra) {
      rig.source = make(rig.provider, extra);
      return rig.source;
    },
    async restart(extra) {
      await rig.provider.dispose();
      rig.provider = await openProvider();
      rig.source = make(rig.provider, extra);
    },
    async dispose() {
      await rig.provider.dispose();
      rmSync(configDir, { recursive: true, force: true });
    },
  };
  rig.source = make(rig.provider);
  return rig;
}

/** Sync until the source stops asking for more, carrying the cursor; every page is returned. */
export async function syncAll(
  source: TelegramMessagesSource,
  cursor: TelegramSyncCursor | null,
  maxPages = 50,
): Promise<{ pages: SyncResult<TelegramSyncCursor>[]; cursor: TelegramSyncCursor }> {
  const pages: SyncResult<TelegramSyncCursor>[] = [];
  let current = cursor;
  for (let i = 0; i < maxPages; i++) {
    const page = await source.sync(current);
    pages.push(page);
    current = page.cursor;
    if (!page.hasMore) return { pages, cursor: page.cursor };
  }
  throw new Error(`Sync did not settle in ${maxPages} pages`);
}

/** The last version of every document a run of pages emitted, by external id. */
export function latestDocs(
  pages: readonly SyncResult<TelegramSyncCursor>[],
): Map<string, DocumentInput> {
  const out = new Map<string, DocumentInput>();
  for (const page of pages) {
    for (const id of page.deletedExternalIds) out.delete(id);
    for (const doc of page.documents) out.set(doc.externalId, doc);
  }
  return out;
}
