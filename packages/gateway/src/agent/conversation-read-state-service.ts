// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The gateway's answer to "does this conversation hold something the operator
 * has not seen".
 *
 * Two facts make up that answer and they have different lifetimes. Whether
 * unseen agent content has landed is durable — it must survive a restart, and
 * every surface must get the same answer, which is why it lives in SQLite
 * (`conversation-read-state.ts`). Whether the operator is looking at the
 * conversation *right now* is not durable at all: it belongs to a client that
 * is currently rendering it, and a gateway that restarts has no business
 * believing anyone is still watching. So it is held in memory here, as a
 * per-conversation expiry.
 *
 * Clients mark a conversation seen when they render it and unmark it when
 * they stop; the expiry is the backstop for the client that never gets to say
 * goodbye (killed app, closed laptop). A stale "still viewing" would swallow
 * the dot the operator was supposed to get, so the window is short and
 * refreshed by each mark rather than assumed.
 */

import { CONFIG_DEFAULTS } from "@omnesis/config";
import { parseDuration } from "@omnesis/core";
import { isConversationUnread, readUnreadConversationIds } from "./conversation-read-state.js";
import type { OmnesisConfig } from "@omnesis/config";
import type { WriteGate } from "../write-gate.js";
import type Database from "better-sqlite3";

/**
 * Default window in which a "the operator is looking at this" mark is believed
 * without being refreshed. Long enough that a client rendering a quiet
 * conversation is not repeatedly re-marking, short enough that a client which
 * died mid-view stops suppressing the operator's dot within a couple of
 * minutes. Overridable through `agent.conversationViewingTtl`.
 */
export const DEFAULT_VIEWING_TTL_MS = parseDuration(CONFIG_DEFAULTS.agent.conversationViewingTtl);

/**
 * The viewing window in force, from config or the default. One resolver so the
 * value the service enforces and the value `/status` advertises to clients
 * cannot disagree.
 */
export function resolveViewingTtlMs(config: OmnesisConfig | undefined): number {
  const configured = config?.agent?.conversationViewingTtl;
  return (configured ? parseDuration(configured) : undefined) ?? DEFAULT_VIEWING_TTL_MS;
}

/**
 * The seam `AgentService` and the conversation routes use, so neither has to
 * know whether read state is a table, a file, or nothing at all. A gateway
 * built without one simply has no unread state.
 */
export interface ConversationReadStatePort {
  /**
   * Agent-authored content landed in a conversation. Content that arrives
   * while the operator is watching has been seen on arrival; everything else
   * opens (or extends) an unread episode.
   *
   * Resolves to whether the operator should be told. True at most once per
   * episode — the first arrival that finds the conversation read — and never
   * for content the producer declares already announced.
   */
  agentContentArrived(
    conversationId: string,
    opts?: AgentContentArrival,
  ): Promise<{ notify: boolean }>;
  /**
   * The operator has the conversation open on screen. Ends any unread
   * episode. `viewing` distinguishes "I am rendering it now" (hold it open)
   * from "I have stopped rendering it" (the operator moved on).
   */
  markSeen(conversationId: string, opts: { viewing: boolean }): Promise<void>;
  /**
   * Content produced during the next bounded window is being presented on a
   * transient surface (for example, an Apple Watch waiting for its reply).
   * Unlike {@link markSeen}, this does not clear an older unread episode: the
   * transient surface shows only the answer it requested, not the transcript.
   */
  expectContentViewed(conversationId: string, messageId: string, durationMs: number): void;
  /** Release a transient presentation when its accepted turn settles without content. */
  finishExpectedContent(conversationId: string, messageId: string): void;
  /** The unread subset of the given conversations, in one read. */
  unreadAmong(conversationIds: readonly string[]): Set<string>;
  /** Forget read state for conversations that no longer exist. */
  forget(conversationIds: readonly string[]): Promise<void>;
  /** How long an unrefreshed viewing mark is believed, for clients to pace by. */
  viewingTtlMs(): number;
}

/**
 * What the caller knows about a piece of arriving agent content beyond the
 * conversation it landed in.
 */
export interface AgentContentArrival {
  /** The assistant message whose content just settled. */
  messageId?: string;
  /**
   * The producer of this content has already told the operator about it, so
   * this system must not tell them again. It still counts as unread: the
   * conversation shows its dot, it simply does not ring twice.
   *
   * The case this exists for is a watch firing, which pushes its own
   * notification and then has the agent open a thread about the same event.
   * The declaration is made by whoever creates the thread — it is never
   * inferred here from a conversation's shape, because an inference would
   * silently start or stop covering cases as those shapes change.
   */
  notificationSatisfied?: boolean;
}

/** A listed conversation, told apart by whether it holds something unseen. */
export interface ListedConversationReadState {
  unread: boolean;
}

/**
 * Stamp a conversation page with each row's unread flag.
 *
 * The whole page is answered in one query rather than a lookup per row: the
 * list is the surface that draws the dots, and it should not pay a round trip
 * per conversation to find out which ones need them. A gateway with no read
 * state answers "none of them", which is what a client that has never been
 * told otherwise already assumes.
 */
export function annotateUnread<T extends { id: string }>(
  page: { conversations: T[]; nextCursor: string | null },
  readState: Pick<ConversationReadStatePort, "unreadAmong"> | undefined,
): { conversations: Array<T & ListedConversationReadState>; nextCursor: string | null } {
  const unread = readState?.unreadAmong(page.conversations.map((c) => c.id)) ?? new Set<string>();
  return {
    conversations: page.conversations.map((c) => ({ ...c, unread: unread.has(c.id) })),
    nextCursor: page.nextCursor,
  };
}

/**
 * The write-gate methods this service needs. Narrowed so a caller can see at a
 * glance which writes it performs, and so the signatures cannot drift from the
 * gate's.
 */
export type ConversationReadStateWriter = Pick<
  WriteGate,
  "markConversationSeen" | "recordConversationAgentContent" | "forgetConversationReadState"
>;

export interface ConversationReadStateServiceOptions {
  /**
   * Read handle. The gateway's main thread holds this open-readonly, which is
   * why every mutation below goes through {@link ConversationReadStateWriter}
   * instead of touching it.
   */
  db: Database.Database;
  writer: ConversationReadStateWriter;
  /** Injected for tests; defaults to wall-clock ms. */
  now?: () => number;
  /**
   * Read fresh on each use, so a live config edit takes effect without a
   * restart — this service is built once and outlives every agent swap.
   * Defaults to {@link DEFAULT_VIEWING_TTL_MS}.
   */
  viewingTtlMs?: () => number;
}

export class ConversationReadStateService implements ConversationReadStatePort {
  private readonly db: Database.Database;
  private readonly writer: ConversationReadStateWriter;
  private readonly now: () => number;
  private readonly ttlMs: () => number;
  /** conversation id → epoch ms after which the viewing mark is stale. */
  private readonly viewingUntil = new Map<string, number>();
  /** Bounded non-transcript presentations, keyed to the accepted assistant message. */
  private readonly expectedViewingUntil = new Map<string, number>();

  constructor(opts: ConversationReadStateServiceOptions) {
    this.db = opts.db;
    this.writer = opts.writer;
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.viewingTtlMs ?? (() => DEFAULT_VIEWING_TTL_MS);
  }

  async agentContentArrived(
    conversationId: string,
    opts: AgentContentArrival = {},
  ): Promise<{ notify: boolean }> {
    const now = this.now();
    // Content that lands under the operator's eyes has been seen as it
    // arrived, so it opens no episode — and there is nothing to clear either,
    // because a conversation being watched is already read. Nor is there
    // anything to notify them about: they are reading it.
    if (this.isViewingAt(conversationId, now, opts.messageId)) return { notify: false };
    const { openedEpisode } = await this.writer.recordConversationAgentContent(conversationId, now);
    return { notify: openedEpisode && opts.notificationSatisfied !== true };
  }

  async markSeen(conversationId: string, opts: { viewing: boolean }): Promise<void> {
    const now = this.now();
    const alreadyViewing = this.isViewingAt(conversationId, now);
    if (opts.viewing) this.viewingUntil.set(conversationId, now + this.ttlMs());
    else this.viewingUntil.delete(conversationId);
    // A client showing a conversation re-marks it every so often to keep its
    // lease alive. Once the lease is already held and the conversation has
    // nothing unread, the durable half of that mark provably changes nothing —
    // and every write op preempts whatever background work the writer is
    // running, so a periodic no-op is not free. Extend the lease in memory and
    // skip the round trip.
    if (alreadyViewing && !isConversationUnread(this.db, conversationId)) return;
    await this.writer.markConversationSeen(conversationId);
  }

  expectContentViewed(conversationId: string, messageId: string, durationMs: number): void {
    const until = this.now() + durationMs;
    this.expectedViewingUntil.set(this.expectedViewingKey(conversationId, messageId), until);
  }

  finishExpectedContent(conversationId: string, messageId: string): void {
    this.expectedViewingUntil.delete(this.expectedViewingKey(conversationId, messageId));
  }

  unreadAmong(conversationIds: readonly string[]): Set<string> {
    return readUnreadConversationIds(this.db, conversationIds);
  }

  async forget(conversationIds: readonly string[]): Promise<void> {
    for (const id of conversationIds) {
      this.viewingUntil.delete(id);
      const prefix = `${id}\u0000`;
      for (const key of this.expectedViewingUntil.keys()) {
        if (key.startsWith(prefix)) this.expectedViewingUntil.delete(key);
      }
    }
    await this.writer.forgetConversationReadState(conversationIds);
  }

  viewingTtlMs(): number {
    return this.ttlMs();
  }

  /** Whether the operator is believed to be looking at this right now. */
  isViewing(conversationId: string): boolean {
    return this.isViewingAt(conversationId, this.now());
  }

  private isViewingAt(conversationId: string, now: number, messageId?: string): boolean {
    const visualUntil = this.viewingUntil.get(conversationId);
    if (visualUntil !== undefined && visualUntil <= now) this.viewingUntil.delete(conversationId);
    const expectedKey = messageId && this.expectedViewingKey(conversationId, messageId);
    const expectedUntil = expectedKey ? this.expectedViewingUntil.get(expectedKey) : undefined;
    if (expectedKey && expectedUntil !== undefined) {
      // A promise belongs to one accepted turn. Consume it even after expiry,
      // so it can never suppress a later answer in the same conversation.
      this.expectedViewingUntil.delete(expectedKey);
    }
    if ((visualUntil ?? 0) > now || (expectedUntil ?? 0) > now) return true;
    // Expired marks are dropped on sight rather than swept. The map is bounded
    // in practice because a client withdraws its own mark when it stops
    // rendering; an entry left by a client that vanished costs one map slot
    // until the next question about that conversation.
    return false;
  }

  private expectedViewingKey(conversationId: string, messageId: string): string {
    return `${conversationId}\u0000${messageId}`;
  }
}
