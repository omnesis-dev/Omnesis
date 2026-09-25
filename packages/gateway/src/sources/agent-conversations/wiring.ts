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

import { createLogger, localDayKey } from "@omnesis/core";

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
  text: string;
  /** ISO-8601 or epoch-ms instant the turn occurred. */
  occurredAt: string | number;
}

export interface AgentConversationsRuntime {
  /**
   * Append a batch of pushed turns to the ledger and schedule re-projection of
   * every touched bucket. Returns how many turns were newly inserted (dedup by
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
  // See #2294 — this walks the whole ledger, so its cost grows with how long
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
    text,
    occurredAt,
    provenance: "harness-pushed",
  };
}

/**
 * Separates the hashed fields so no two different field splits can hash alike.
 * ASCII unit separator, which none of the fields can contain. Written as an
 * escape: a literal control byte would make git and grep treat this whole file
 * as binary, and its value is part of every synthesized id already stored.
 */
const FIELD_SEPARATOR = "\u001f";

/**
 * Deterministic idempotency key when the plugin cannot supply a platform
 * message id: a hash over the identity + instant + content, so an at-least-once
 * re-push of the same turn dedups to the same row.
 */
function synthesizeId(input: PushMessageInput, occurredAt: string, text: string): string {
  const h = createHash("sha256")
    .update(
      [input.harness, input.channel, input.chatId, input.role, occurredAt, text].join(
        FIELD_SEPARATOR,
      ),
    )
    .digest("hex")
    .slice(0, 32);
  return `${input.harness}:${input.channel}:${input.chatId}:${h}`;
}
