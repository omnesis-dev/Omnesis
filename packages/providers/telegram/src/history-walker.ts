// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The upstream half of a sync page: read Telegram, write the archive
 * (`docs/telegram-source.md` §7.2–§7.5).
 *
 * One `run()` spends a bounded budget of requests, paced at least
 * `HISTORY_MIN_INTERVAL_MS` apart (across pages too), on, in order:
 *
 * 1. **Enumeration** — the dialog list, when it is due: never read, older
 *    than `FULL_RECONCILE_INTERVAL_H`, or asked for by an account-wide gap.
 *    It records every chat (archived ones included), and queues a forward
 *    re-page for any chat whose top message is past what the archive holds.
 *    Each forum's topics are listed after it, and again when a message
 *    arrives in a topic the archive has no title for.
 * 2. **Forward re-pages** — ids above a chat's gap floor, newest first, until
 *    the floor is reached. This is what recovers messages lost in a gap,
 *    because mtcute does not report `differenceTooLong` at all.
 * 3. **The backward walk** — each chat not yet walked, most recently active
 *    first, newest page to oldest, until a short page or the data cutoff.
 *    With a takeout policy it reads through a Telegram data export session
 *    (`account.initTakeoutSession`, files excluded), which Telegram limits
 *    less tightly than interactive reads; while Telegram holds the export
 *    back for the owner's approval, or when it refuses one, the walk reads
 *    the normal way. The export is finished when the walk is.
 * 4. **Presence checks** — after a gap, the recent ids of each chat involved
 *    are asked for again: one Telegram no longer returns was deleted, and a
 *    newer edit date is an edit the gap swallowed.
 *
 * Every page commits with the checkpoint it advances, so the walk resumes at
 * any request boundary. A flood wait stops the run and is recorded; later
 * pages make no upstream call until it passes, but still drain. Only a
 * revoked session throws.
 */

import { createLogger, toErrorMessage } from "@omnesis/core";
import { extractMessage } from "./message-extractor.js";
import {
  boxOf,
  type ChatProgress,
  type HistoryPageWrite,
  type TelegramArchive,
} from "./message-store.js";
import {
  FULL_RECONCILE_INTERVAL_H,
  HISTORY_MIN_INTERVAL_MS,
  HISTORY_PAGE_SIZE,
  PRESENCE_BATCH_SIZE,
  RECONCILE_WINDOW_DAYS,
  WALK_DEADLINE_MARGIN_MS,
  WALK_REQUESTS_PER_PAGE,
} from "./limits.js";
import {
  TelegramError,
  type TakeoutScope,
  type TelegramAdapter,
  type TelegramTakeout,
  type TgChat,
  type TgDialog,
  type TgMessage,
  type TgUser,
} from "./client/types.js";
import type { StoredChat, StoredMessage } from "./types.js";

const log = createLogger("source:telegram-messages").child("walker");

/** Which chats the operator wants archived. */
export interface ChatPolicy {
  includeChannels: boolean;
  /** Marked chat ids or `@usernames`. */
  excludedChats: readonly string[];
}

/** Whether a chat is archived under `policy`. */
export function isChatIncluded(
  chat: Pick<StoredChat, "kind" | "username"> & { chatId?: number; id?: number },
  policy: ChatPolicy,
): boolean {
  if (chat.kind === "channel" && !policy.includeChannels) return false;
  const id = String(chat.chatId ?? chat.id);
  const username = chat.username?.toLowerCase();
  return !policy.excludedChats.some((entry) => {
    const e = entry.trim();
    if (e.startsWith("@")) return !!username && e.slice(1).toLowerCase() === username;
    return e === id;
  });
}

export interface WalkerClock {
  /** Epoch milliseconds. */
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const realClock: WalkerClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (ms <= 0 || signal?.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    }),
};

export interface WalkLimits {
  requestsPerPage: number;
  minIntervalMs: number;
  pageSize: number;
  deadlineMarginMs: number;
}

const DEFAULT_WALK_LIMITS: WalkLimits = {
  requestsPerPage: WALK_REQUESTS_PER_PAGE,
  minIntervalMs: HISTORY_MIN_INTERVAL_MS,
  pageSize: HISTORY_PAGE_SIZE,
  deadlineMarginMs: WALK_DEADLINE_MARGIN_MS,
};

/**
 * Why a run stopped. Only `budget` means "more work, call again now"; the
 * others either finished or cannot progress until something changes.
 */
type WalkStop = "complete" | "budget" | "deadline" | "flood" | "aborted" | "network";

export interface WalkOutcome {
  stop: WalkStop;
  requests: number;
}

/**
 * Where the open takeout session is kept: on the account's context. A
 * rebuilt context (a config change, a re-authentication) or a restart starts
 * with none and resumes the session by the id the archive keeps, so neither
 * asks Telegram for another export.
 */
export interface TakeoutHolder {
  takeout: TelegramTakeout | undefined;
}

export interface HistoryWalkerDeps {
  adapter: TelegramAdapter;
  archive: TelegramArchive;
  policy: ChatPolicy;
  /** Unix seconds; older messages are neither walked nor stored. */
  cutoffTs?: number;
  clock?: WalkerClock;
  limits?: Partial<WalkLimits>;
  /** Walk the bootstrap through a takeout session kept here; absent: never ask for one. */
  takeout?: TakeoutHolder;
}

/** The export scope a policy asks for: every chat kind it archives. */
function takeoutScopeOf(policy: ChatPolicy): TakeoutScope {
  return {
    messageUsers: true,
    messageChats: true,
    messageMegagroups: true,
    messageChannels: policy.includeChannels,
  };
}

function inScope(chat: Pick<StoredChat, "kind">, scope: TakeoutScope): boolean {
  switch (chat.kind) {
    case "private":
    case "saved":
      return scope.messageUsers;
    case "group":
      return scope.messageChats;
    case "supergroup":
    case "forum":
      return scope.messageMegagroups;
    case "channel":
      return scope.messageChannels;
  }
}

class Stop extends Error {
  constructor(readonly reason: Exclude<WalkStop, "complete">) {
    super(reason);
  }
}

/** A chat Telegram refused; the run moves on to the next one. */
class ChatRefused extends Error {}

/** The takeout session in use ended; the walk carries on without one. */
class TakeoutLost extends Error {}

/** What reads a backward page: the takeout session, or the plain client. */
type HistoryReader = Pick<TelegramTakeout, "getHistory">;

export class HistoryWalker {
  private readonly adapter: TelegramAdapter;
  private readonly archive: TelegramArchive;
  private readonly clock: WalkerClock;
  private readonly limits: WalkLimits;
  private readonly policy: ChatPolicy;
  private readonly cutoffTs: number | undefined;
  private readonly takeout: TakeoutHolder | undefined;
  private lastRequestAt = Number.NEGATIVE_INFINITY;

  constructor(deps: HistoryWalkerDeps) {
    this.takeout = deps.takeout;
    this.adapter = deps.adapter;
    this.archive = deps.archive;
    this.clock = deps.clock ?? realClock;
    this.limits = { ...DEFAULT_WALK_LIMITS, ...deps.limits };
    this.policy = deps.policy;
    this.cutoffTs = deps.cutoffTs;
  }

  /** Spend one page's budget. Throws only a revoked-session `TelegramError`. */
  async run(budget: { deadline?: number; signal?: AbortSignal } = {}): Promise<WalkOutcome> {
    const ctx = { requests: 0, budget };
    if (this.archive.floodUntil() !== undefined) return { stop: "flood", requests: 0 };
    try {
      if (this.archive.enumerationDue(FULL_RECONCILE_INTERVAL_H * 3600)) await this.enumerate(ctx);
      for (const chatId of this.archive.forumsDueForTopics()) await this.topics(ctx, chatId);
      for (const chat of this.included((c) => c.reconcileFromId !== undefined)) {
        await this.perChat(chat, () => this.forward(ctx, chat.chatId));
      }
      for (const chat of this.included(
        (c) => c.walkState === "pending" || c.walkState === "walking",
      )) {
        await this.perChat(chat, () => this.walk(ctx, chat.chatId));
      }
      for (const chat of this.included(
        (c) =>
          (c.walkState === "walking" || c.walkState === "done") &&
          c.oldestFetchedId !== undefined &&
          c.lastPresenceCheckAt === undefined,
      )) {
        await this.perChat(chat, () => this.presence(ctx, chat));
      }
      await this.finishTakeout(budget.signal);
      return { stop: "complete", requests: ctx.requests };
    } catch (err) {
      if (err instanceof Stop) return { stop: err.reason, requests: ctx.requests };
      if (err instanceof TakeoutLost) {
        // Only the backward walk reads through the export; anywhere else is a surprise.
        log.warn(`Unexpected Telegram data export error: ${err.message}`);
        return { stop: "network", requests: ctx.requests };
      }
      throw err;
    }
  }

  private included(filter: (chat: ChatProgress) => boolean): ChatProgress[] {
    return this.archive
      .listChats()
      .filter((c) => c.walkState !== "excluded" && c.walkState !== "failed" && filter(c));
  }

  private async perChat(chat: ChatProgress, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (err) {
      if (!(err instanceof ChatRefused)) throw err;
      log.warn(`Telegram refused chat ${chat.chatId}; retrying at the next full reconcile`);
      this.archive.markChatFailed(chat.chatId);
    }
  }

  private async enumerate(ctx: RunContext): Promise<void> {
    const dialogs = await this.listDialogs(ctx);
    this.archive.recordDialogs(dialogs, (chat: TgChat) => isChatIncluded(chat, this.policy));
    log.info(`Listed ${dialogs.length} Telegram dialogs`);
  }

  private async listDialogs(ctx: RunContext): Promise<TgDialog[]> {
    try {
      return await this.dialogsRequest(ctx);
    } catch (err) {
      if (!(err instanceof ChatRefused)) throw err;
      log.warn(`Listing Telegram dialogs failed: ${err.message}`);
      throw new Stop("network");
    }
  }

  private dialogsRequest(ctx: RunContext): Promise<TgDialog[]> {
    return this.request(ctx, async () => {
      const out: TgDialog[] = [];
      for await (const d of this.adapter.iterDialogs({
        archived: "keep",
        signal: ctx.budget.signal,
      })) {
        out.push(d);
      }
      return out;
    });
  }

  private async walk(ctx: RunContext, chatId: number): Promise<void> {
    for (;;) {
      const chat = this.archive.getChat(chatId);
      if (!chat || (chat.walkState !== "pending" && chat.walkState !== "walking")) return;
      const reader = await this.historyReader(ctx, chat);
      let page: { messages: TgMessage[]; users: TgUser[] };
      try {
        page = await this.request(ctx, () =>
          reader.getHistory(chatId, {
            offsetId: chat.oldestFetchedId ?? 0,
            limit: this.limits.pageSize,
            signal: ctx.budget.signal,
          }),
        );
      } catch (err) {
        if (!(err instanceof TakeoutLost)) throw err;
        log.warn(`The Telegram data export ended (${err.message}); reading history the normal way`);
        this.dropTakeout("unavailable");
        continue;
      }
      const write = this.pageWrite(page);
      const reachedCutoff =
        this.cutoffTs !== undefined && page.messages.some((m) => m.date < this.cutoffTs!);
      // mtcute drops `messageEmpty` entries, so a short page is not the end:
      // only an empty one is.
      write.done = page.messages.length === 0 || reachedCutoff;
      this.archive.commitWalkPage(chatId, write);
    }
  }

  private async forward(ctx: RunContext, chatId: number): Promise<void> {
    for (;;) {
      const chat = this.archive.getChat(chatId);
      if (!chat || chat.reconcileFromId === undefined) return;
      const page = await this.request(ctx, () =>
        this.adapter.getHistory(chatId, {
          offsetId: chat.reconcileOffsetId ?? 0,
          minId: chat.reconcileFromId,
          limit: this.limits.pageSize,
          signal: ctx.budget.signal,
        }),
      );
      const write = this.pageWrite(page);
      write.done = page.messages.length === 0;
      this.archive.commitForwardPage(chatId, write);
      if (page.messages.length > 0) {
        log.info(`Recovered ${page.messages.length} Telegram messages after a gap in ${chatId}`);
      }
    }
  }

  /** List a forum's topics. A refusal is logged and not retried until the next listing. */
  private async topics(ctx: RunContext, chatId: number): Promise<void> {
    let topics: { id: number; title: string }[];
    try {
      topics = await this.request(ctx, async () => {
        const out: { id: number; title: string }[] = [];
        for await (const t of this.adapter.iterForumTopics(chatId, {
          signal: ctx.budget.signal,
        })) {
          out.push(t);
        }
        return out;
      });
    } catch (err) {
      if (!(err instanceof ChatRefused)) throw err;
      log.warn(`Listing the topics of Telegram forum ${chatId} failed: ${err.message}`);
      topics = [];
    }
    const changed = this.archive.recordTopics(chatId, topics);
    log.info(`Listed ${topics.length} topics of Telegram forum ${chatId} (${changed} changed)`);
  }

  /**
   * What reads the next backward page of `chat`: the takeout session when
   * one is open or can be opened and covers the chat, else the plain client.
   * Opening one is a request of the page's budget. Telegram holding the
   * export back is recorded with the time to ask again; a refusal is
   * recorded as unavailable, and neither stops the walk.
   */
  private async historyReader(ctx: RunContext, chat: ChatProgress): Promise<HistoryReader> {
    const holder = this.takeout;
    if (!holder) return this.adapter;
    if (holder.takeout) return inScope(chat, holder.takeout.scope) ? holder.takeout : this.adapter;
    const { state, retryAt } = this.archive.takeoutState();
    const kept = state === "active" ? this.archive.takeoutSession() : undefined;
    if (kept) {
      // No request: the session is Telegram's, and outlives this client. One
      // Telegram stopped honouring fails its first read as `TakeoutLost`.
      holder.takeout = await this.adapter.takeout(kept.scope, { resumeId: kept.id });
      log.info("Resuming the Telegram data export session");
      return inScope(chat, kept.scope) ? holder.takeout : this.adapter;
    }
    if (state === "done" || state === "unavailable") return this.adapter;
    if (state === "delayed" && retryAt !== undefined && retryAt * 1000 > this.clock.now()) {
      return this.adapter;
    }
    const scope = takeoutScopeOf(this.policy);
    const opened = await this.request(ctx, async () => {
      try {
        return await this.adapter.takeout(
          scope,
          ctx.budget.signal ? { signal: ctx.budget.signal } : undefined,
        );
      } catch (err) {
        if (err instanceof TelegramError && err.code === "takeout") return err;
        if (err instanceof TelegramError && TAKEOUT_REFUSALS.has(err.code)) return err;
        throw err;
      }
    });
    if (opened instanceof TelegramError) {
      const seconds = opened.code === "takeout" ? opened.detail?.seconds : undefined;
      if (seconds !== undefined && seconds > 0) {
        this.archive.setTakeoutState("delayed", seconds);
        log.info(
          `Telegram holds the data export until it is approved (or ${seconds}s); walking without it`,
        );
      } else {
        this.archive.setTakeoutState("unavailable");
        log.warn(`Telegram refused a data export (${opened.message}); walking without it`);
      }
      return this.adapter;
    }
    holder.takeout = opened;
    this.archive.setTakeoutActive(opened.id, opened.scope);
    log.info("Walking Telegram history through a data export session");
    return inScope(chat, opened.scope) ? opened : this.adapter;
  }

  /** Forget the takeout session in use, recording why. */
  private dropTakeout(state: "done" | "unavailable"): void {
    if (this.takeout) this.takeout.takeout = undefined;
    this.archive.setTakeoutState(state);
  }

  /**
   * Once nothing is left to walk, end the export session and never ask for
   * another: a chat found later is walked the normal way, without notifying
   * the owner's devices of a new export. An export still held back when the
   * walk finished without it is settled the same way.
   */
  private async finishTakeout(signal: AbortSignal | undefined): Promise<void> {
    if (!this.takeout) return;
    const { pending, walking } = this.archive.walkSummary();
    if (pending + walking > 0) return;
    const session = this.takeout.takeout;
    const { state } = this.archive.takeoutState();
    if (!session && state !== "delayed" && state !== "active") return;
    this.dropTakeout("done");
    if (!session) return;
    try {
      await session.finish(true, signal ? { signal } : undefined);
      log.info("Finished the Telegram data export");
    } catch (err) {
      log.warn(`Finishing the Telegram data export failed: ${toErrorMessage(err)}`);
    }
  }

  /**
   * Ask Telegram again for the recent ids of a chat after a gap. An id it
   * answers with nothing was deleted, and a newer edit date is an edit the
   * gap swallowed. Only a conclusive answer deletes anything: one whose
   * entries do not line up with the ids asked for, or one that answers
   * nothing for a whole batch of a chat whose history no longer reads (access
   * lost, rather than everything deleted), ends the check for this chat
   * without deleting; the next reconcile asks again. A failed request deletes
   * nothing either: the batch commits only after a usable answer.
   */
  private async presence(ctx: RunContext, start: ChatProgress): Promise<void> {
    const since = Math.floor(this.clock.now() / 1000) - RECONCILE_WINDOW_DAYS * 86_400;
    const box = boxOf(start);
    const signal = ctx.budget.signal;
    const opts = signal ? { signal } : undefined;
    for (;;) {
      const chat = this.archive.getChat(start.chatId);
      if (!chat || chat.lastPresenceCheckAt !== undefined) return;
      const ids = this.archive.presenceBatch(
        chat.chatId,
        since,
        chat.presenceAfterId ?? 0,
        PRESENCE_BATCH_SIZE,
      );
      const settle = (): void =>
        this.archive.commitPresence(chat.chatId, {
          missingIds: [],
          current: [],
          users: [],
          nextAfterId: null,
        });
      if (ids.length === 0) return settle();
      const found = await this.request(ctx, () =>
        box === "common"
          ? this.adapter.getMessagesCommon(ids, opts)
          : this.adapter.getMessages(chat.chatId, ids, opts),
      );
      const aligned = found.length === ids.length && found.every((m, i) => !m || m.id === ids[i]);
      if (!aligned) {
        log.warn(
          `Presence check of Telegram chat ${chat.chatId} got an answer that does not match the ids asked; deleting nothing`,
        );
        return settle();
      }
      if (found.every((m) => !m) && !(await this.stillReadable(ctx, chat.chatId, ids))) {
        log.warn(
          `Presence check of Telegram chat ${chat.chatId} found none of ${ids.length} recent messages and the chat does not read; deleting nothing`,
        );
        return settle();
      }
      const missingIds = ids.filter((_, i) => !found[i]);
      const current = found
        .filter((m): m is TgMessage => !!m && m.chatId === chat.chatId)
        .map(extractMessage)
        .filter((m): m is StoredMessage => m !== null);
      this.archive.commitPresence(chat.chatId, {
        missingIds,
        current,
        users: [],
        nextAfterId: ids.length === PRESENCE_BATCH_SIZE ? ids[ids.length - 1]! : null,
      });
      if (missingIds.length > 0) {
        log.info(
          `Presence check found ${missingIds.length} deleted Telegram messages in ${chat.chatId}`,
        );
      }
    }
  }

  /**
   * Whether a chat's history still reads, for a presence batch that came back
   * entirely empty: its newest page holds a message, and not one of the ids
   * Telegram just called gone. A refusal means it does not.
   */
  private async stillReadable(
    ctx: RunContext,
    chatId: number,
    asked: readonly number[],
  ): Promise<boolean> {
    let page: { messages: TgMessage[] };
    try {
      page = await this.request(ctx, () =>
        this.adapter.getHistory(chatId, {
          offsetId: 0,
          limit: 1,
          ...(ctx.budget.signal ? { signal: ctx.budget.signal } : {}),
        }),
      );
    } catch (err) {
      if (err instanceof ChatRefused) return false;
      throw err;
    }
    const gone = new Set(asked);
    return page.messages.length > 0 && !page.messages.some((m) => gone.has(m.id));
  }

  /** What of a page the archive keeps: within the cutoff, through the extractor. */
  private pageWrite(page: { messages: TgMessage[]; users: TgUser[] }): HistoryPageWrite {
    const cutoff = this.cutoffTs;
    return {
      messages: page.messages
        .filter((m) => cutoff === undefined || m.date >= cutoff)
        .map(extractMessage)
        .filter((m): m is StoredMessage => m !== null),
      users: page.users,
      rawIds: page.messages.map((m) => m.id),
      done: false,
    };
  }

  /**
   * One upstream request inside the page's budget, paced from the previous
   * one. Classifies the failures: a flood wait is recorded and stops the run,
   * a network failure stops it, a refusal skips the chat, and a revoked
   * session propagates.
   */
  private async request<T>(ctx: RunContext, fn: () => Promise<T>): Promise<T> {
    const { budget } = ctx;
    if (budget.signal?.aborted) throw new Stop("aborted");
    if (ctx.requests >= this.limits.requestsPerPage) throw new Stop("budget");
    if (
      budget.deadline !== undefined &&
      budget.deadline - this.clock.now() < this.limits.deadlineMarginMs
    ) {
      throw new Stop("deadline");
    }
    const wait = this.lastRequestAt + this.limits.minIntervalMs - this.clock.now();
    if (wait > 0) await this.clock.sleep(wait, budget.signal);
    if (budget.signal?.aborted) throw new Stop("aborted");
    ctx.requests++;
    this.lastRequestAt = this.clock.now();
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof TelegramError)) {
        log.warn(`Telegram request failed: ${toErrorMessage(err)}`);
        throw new Stop("network");
      }
      switch (err.code) {
        case "revoked":
          throw err;
        case "flood-wait": {
          const seconds = err.detail?.seconds ?? 60;
          this.archive.recordFloodWait(seconds);
          log.warn(`Telegram asked to wait ${seconds}s; the walk pauses until then`);
          throw new Stop("flood");
        }
        case "network":
          throw new Stop("network");
        case "cancelled":
          throw new Stop("aborted");
        case "takeout":
          throw new TakeoutLost(err.message);
        case "forbidden":
        case "not-found":
        case "unknown":
        case "file-reference-expired":
          throw new ChatRefused(err.message);
      }
    }
  }
}

/** An export Telegram refuses outright: the walk goes on without one. */
const TAKEOUT_REFUSALS: ReadonlySet<TelegramError["code"]> = new Set([
  "forbidden",
  "not-found",
  "unknown",
]);

interface RunContext {
  requests: number;
  budget: { deadline?: number; signal?: AbortSignal };
}
