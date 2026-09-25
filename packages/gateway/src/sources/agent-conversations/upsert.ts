// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Agent-conversation day upserter. Projects one (harness, channel, chat, day)
 * bucket of the `agent_messages` ledger into a single corpus document and keeps
 * it current as pushed turns arrive.
 *
 * The projection reuses the SAME shared renderer (`renderConversationDay` from
 * `@omnesis/core`) that the collector-hosted reader sources use — this is the
 * whole point of the push path: a plugin transport (raw messages → this
 * projector) produces documents byte-identical to a reader transport, so the
 * transport can change without re-embedding a document or breaking an upsert
 * key. Because a Hermes plugin is Python and cannot run the TS renderer,
 * server-side projection is the only way a plugin stays in lockstep.
 *
 * Per-bucket debouncing (KeyedDebouncedRunner, key = bucket key) coalesces a
 * burst of pushed turns into one write; writes go through DocumentService.ingest
 * (so `document.upserted` fires and the indexer wakes).
 */

import { conversationExternalId, renderConversationDay, createLogger } from "@omnesis/core";
import { ProviderId, SourceId } from "@omnesis/types";
import { KeyedDebouncedRunner } from "../../keyed-debounced-runner.js";
import { harnessDisplayName, providerIdFor, sourceIdFor } from "./meta.js";
import type { ConversationChat, ConversationMessage } from "@omnesis/core";
import type { DocumentInput } from "@omnesis/types";

import type { AgentMessageRow, Bucket } from "./storage.js";

const log = createLogger("gateway:agent-conversations").child("upsert");

/** Default per-bucket debounce window. */
export const DEFAULT_DEBOUNCE_MS = 3_000;

// Unit separator (0x1F) — cannot appear in a harness/channel/chat/day value.
const SEP = "\u001f";

/** Encode a bucket into an opaque debounce key (unit-separated, never parsed by SQL). */
export function bucketKey(b: Bucket): string {
  return [b.harness, b.channel, b.chatId, b.day].join(SEP);
}

export function parseBucketKey(key: string): Bucket {
  const [harness, channel, chatId, day] = key.split(SEP);
  return { harness, channel, chatId, day };
}

export interface AgentConversationsUpserterDeps {
  /** Reads a bucket's turns at flush time (freshest ledger state). */
  listBucket: (b: Bucket) => AgentMessageRow[] | Promise<AgentMessageRow[]>;
  /** Document write path — DocumentService.ingest in production. */
  ingest: (docs: DocumentInput[]) => Promise<unknown>;
  /** Drops a bucket's projected document when it has no turns left. */
  deleteDayDoc: (providerId: string, sourceId: string, externalId: string) => Promise<void>;
  debounceMs?: number;
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
}

export class AgentConversationsUpserter {
  private readonly deps: AgentConversationsUpserterDeps;
  private readonly runner: KeyedDebouncedRunner;

  constructor(deps: AgentConversationsUpserterDeps) {
    this.deps = deps;
    this.runner = new KeyedDebouncedRunner({
      debounceMs: deps.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      scheduler: deps.scheduler,
      run: (key) => this.runUpsert(key),
      onError: (key, err) => {
        log.warn(`upsert failed for ${key}: ${(err as Error).message ?? err}`);
      },
    });
  }

  enqueue(b: Bucket): void {
    this.runner.enqueue(bucketKey(b));
  }

  flushAll(): Promise<void> {
    return this.runner.flushAll();
  }

  dispose(): void {
    this.runner.dispose();
  }

  private async runUpsert(key: string): Promise<void> {
    const bucket = parseBucketKey(key);
    const rows = await this.deps.listBucket(bucket);
    const providerId = providerIdFor(bucket.harness);
    const sourceId = sourceIdFor(bucket.harness);
    const chat: ConversationChat = resolveChat(bucket, rows);
    const externalId = conversationExternalId(chat, bucket.day);
    if (rows.length === 0) {
      // Every turn of the bucket was removed — drop the projected document.
      await this.deps.deleteDayDoc(providerId, sourceId, externalId);
      return;
    }
    await this.deps.ingest([buildDocument(bucket, chat, rows)]);
  }
}

/** Resolve the chat display identity from the freshest non-null row metadata. */
function resolveChat(bucket: Bucket, rows: readonly AgentMessageRow[]): ConversationChat {
  let chatName: string | undefined;
  let chatType: string | undefined;
  for (const r of rows) {
    if (r.chatName) chatName = r.chatName;
    if (r.chatType) chatType = r.chatType;
  }
  return { platform: bucket.channel, chatId: bucket.chatId, chatName, chatType };
}

/** Build the day document from a non-empty bucket via the shared renderer. */
export function buildDocument(
  bucket: Bucket,
  chat: ConversationChat,
  rows: readonly AgentMessageRow[],
): DocumentInput {
  const messages: ConversationMessage[] = rows.map((r) => ({
    role: r.role,
    text: r.text,
    atMs: new Date(r.occurredAt).getTime(),
  }));
  return renderConversationDay({
    chat,
    dayKey: bucket.day,
    messages,
    providerId: ProviderId(providerIdFor(bucket.harness)),
    sourceId: SourceId(sourceIdFor(bucket.harness)),
    agentName: harnessDisplayName(bucket.harness),
    harnessId: bucket.harness,
  });
}
