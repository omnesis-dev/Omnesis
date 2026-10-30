// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gateway-boot wiring for the pushed agent-conversation sources. Owns the
 * side-effects: seeds each harness source's display identity, reconciles any
 * ledger buckets whose projection is stale after a crash, and exposes the
 * `ingest` runtime the `POST /agent-messages` route drives.
 *
 * Every dependency is injected (writeGate, read handle, DocumentService
 * ingest/delete) so tests swap pieces in isolation. Mirrors the omnesis-notes
 * boot wiring.
 */

import { createHash } from "node:crypto";

import { createLogger, localDayKey, type ConversationAuthor } from "@omnesis/core";

import { seedHarnessSourceMeta } from "./meta.js";
import { AgentConversationsUpserter, type AgentConversationsUpserterDeps } from "./upsert.js";
import {
  insertAgentMessage,
  listAllBuckets,
  listBucketMessages,
  type AgentMessageRow,
  type Bucket,
} from "./storage.js";
import type { DocumentInput } from "@omnesis/types";
import type Database from "better-sqlite3";
import type { WriteGate } from "../../write-gate.js";

const log = createLogger("gateway:agent-conversations");

export interface AgentConversationsBootDeps {
  writeGate: WriteGate;
  readDb: Database.Database;
  ingest: (docs: DocumentInput[]) => Promise<unknown>;
  deleteByIds: (providerId: string, sourceId: string, externalIds: string[]) => Promise<unknown>;
  debounceMs?: number;
  scheduler?: AgentConversationsUpserterDeps["scheduler"];
}

/** One pushed turn, as accepted by the ingest runtime (pre-ledger shape). */
export interface PushMessageInput {
  /** Stable idempotency key; synthesized when the plugin omits one. */
  id?: string;
  harness: string;
  channel: string;
  chatId: string;
  chatName?: string;
  chatType?: string;
  role: "user" | "assistant";
  author?: ConversationAuthor;
  text: string;
  /** ISO-8601 or epoch-ms instant the turn occurred. */
  occurredAt: string | number;
}

export interface AgentConversationsRuntime {
  /**
   * Append or enrich a batch of pushed turns to the ledger and schedule re-projection of
   * every touched bucket. Returns how many turns were inserted or gained explicit attribution (dedup by
   * id) so the caller can report accepted-vs-duplicate.
   */
  ingest(messages: PushMessageInput[]): Promise<{ accepted: number; buckets: number }>;
  flushAll(): Promise<void>;
  dispose(): void;
}

export function bootAgentConversations(
  deps: AgentConversationsBootDeps,
): AgentConversationsRuntime {
  const upserter = new AgentConversationsUpserter({
    listBucket: (b) => listBucketMessages(deps.readDb, b),
    ingest: deps.ingest,
    deleteDayDoc: async (providerId, sourceId, externalId) => {
      await deps.deleteByIds(providerId, sourceId, [externalId]);
    },
    debounceMs: deps.debounceMs,
    scheduler: deps.scheduler,
  });

  // Seed a harness's display identity the first time it has data, at most once
  // per process. Fire-and-forget (display metadata never blocks ingest), but the
  // promises are collected so `flushAll` can await them for deterministic tests
  // and clean shutdown.
  const seededHarnesses = new Set<string>();
  const seedPromises: Promise<void>[] = [];
  const seedHarness = (harness: string): void => {
    if (seededHarnesses.has(harness)) return;
    seededHarnesses.add(harness);
    seedPromises.push(
      seedHarnessSourceMeta(deps.writeGate, harness).catch((err) =>
        log.warn(`source-meta seed for ${harness} threw: ${(err as Error).message ?? err}`),
      ),
    );
  };

  // Boot reconciliation: re-project every ledger bucket so a crash inside a
  // debounce window converges, and seed the display identity of every harness
  // that already has data. Re-projecting a current bucket is a no-op upsert, so
  // the pass is idempotent. Never rejects.
  //
  // See #83 — this walks the whole ledger, so its cost grows with how long
  // the install has had a harness connected rather than with what changed.
  const reconciled = Promise.resolve()
    .then(() => {
      for (const bucket of listAllBuckets(deps.readDb)) {
        seedHarness(bucket.harness);
        upserter.enqueue(bucket);
      }
    })
    .catch((err) => log.warn(`boot reconciliation threw: ${(err as Error).message ?? err}`));

  return {
    ingest: async (messages) => {
      const touched = new Map<string, Bucket>();
      let accepted = 0;
      for (const input of messages) {
        const row = toRow(input);
        const inserted = await deps.writeGate.appendAgentMessage(row);
        if (!inserted) continue;
        accepted++;
        seedHarness(row.harness);
        const bucket: Bucket = {
          harness: row.harness,
          channel: row.channel,
          chatId: row.chatId,
          day: row.day,
        };
        touched.set(`${row.harness}/${row.channel}/${row.chatId}/${row.day}`, bucket);
      }
      for (const bucket of touched.values()) upserter.enqueue(bucket);
      if (accepted > 0) {
        log.info(
          `Ingested ${accepted}/${messages.length} pushed turns across ${touched.size} buckets`,
        );
      }
      return { accepted, buckets: touched.size };
    },
    flushAll: async () => {
      await reconciled;
      await Promise.all(seedPromises);
      await upserter.flushAll();
    },
    dispose: () => upserter.dispose(),
  };
}

/** Normalize a pushed input into a ledger row (compute day, synthesize id). */
function toRow(input: PushMessageInput): AgentMessageRow {
  const occurredMs =
    typeof input.occurredAt === "number" ? input.occurredAt : new Date(input.occurredAt).getTime();
  const occurredAt = new Date(occurredMs).toISOString();
  const text = input.text;
  const id = input.id ?? synthesizeId(input, occurredAt, text);
  return {
    id,
    harness: input.harness,
    channel: input.channel,
    chatId: input.chatId,
    chatName: input.chatName ?? null,
    chatType: input.chatType ?? null,
    day: localDayKey(occurredMs),
    role: input.role,
    ...(input.author ? { author: input.author } : {}),
    text,
    occurredAt,
    provenance: "harness-pushed",
  };
}

/** Legacy separator retained for authorless/default-author retry compatibility. */
const FIELD_SEPARATOR = "\u001f";

/**
 * Deterministic idempotency key when the plugin cannot supply a platform
 * message id: a hash over the identity + instant + content, so an at-least-once
 * re-push of the same turn dedups to the same row.
 */
function synthesizeId(input: PushMessageInput, occurredAt: string, text: string): string {
  const fields = [input.harness, input.channel, input.chatId, input.role, occurredAt, text];
  const author = input.author;
  // Preserve legacy fingerprints for explicit defaults: these add no identity.
  // Informative attribution distinguishes otherwise identical simultaneous
  // messages from different participants. A fixed tuple ignores property order.
  const defaultKind = input.role === "assistant" ? "agent" : "unknown";
  let fingerprint = fields.join(FIELD_SEPARATOR);
  if (
    author &&
    (author.kind !== defaultKind || author.id !== undefined || author.name !== undefined)
  ) {
    fingerprint = `author-v1\u0000${JSON.stringify([fields, [author.kind, author.id ?? null, author.name ?? null]])}`;
  }
  const h = createHash("sha256").update(fingerprint).digest("hex").slice(0, 32);
  return `${input.harness}:${input.channel}:${input.chatId}:${h}`;
}
