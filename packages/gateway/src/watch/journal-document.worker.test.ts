// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-document journal lookups of the watch engine, read ahead on the real io
 * worker against a temp journal: for every document and every position in the
 * journal, the answer equals the journal store's own read. Covered
 * on a plaintext journal with unreadable rows in it, and on an encrypted
 * one, which the worker opens with the key it was started with.
 *
 * All fixture data is invented.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openEncryptedSqlite } from "../sqlite-encryption.js";
import { createDatabase } from "../db.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { IoTaskRunner } from "../scheduler/runners/io.js";
import { ioGateFromScheduler } from "../scheduler/io-ops.js";
import { WatchJournalStore, type NewJournalEvent } from "./store.js";
import {
  JOURNAL_HISTORY_DEPTH,
  PrefetchedJournalDocuments,
  type JournalHistoryReader,
} from "./journal-document.js";

const WORKER_URL = new URL("../workers/io-worker.ts", import.meta.url);
const LOADER_URL = new URL("../workers/register-tsx.mjs", import.meta.url).href;

const DOCS = [
  "d1111111-0000-4000-8000-000000000001",
  "d1111111-0000-4000-8000-000000000002",
  "d1111111-0000-4000-8000-000000000003",
];

function docEvent(docId: string, op: "created" | "updated", minute: number): NewJournalEvent {
  const when = `2026-03-01T09:${String(minute).padStart(2, "0")}:00.000Z`;
  return {
    kind: "doc.event",
    occurredAt: when,
    observedAt: when,
    payload: {
      op,
      docId,
      sourceId: "gmail",
      providerId: "google",
      documentType: "email",
      title: `Planning notes revision ${minute}`,
      semanticTime: when,
      changedFields: op === "created" ? [] : ["title"],
      contentChanged: true,
      metadata: {},
      people: [],
    },
  };
}

function indexed(docId: string, minute: number): NewJournalEvent {
  const when = `2026-03-01T09:${String(minute).padStart(2, "0")}:30.000Z`;
  return {
    kind: "doc.indexed",
    occurredAt: when,
    observedAt: when,
    payload: { docId, eventIndexedAt: when },
  };
}

/** Created, then revised, interleaved across documents with their index events. */
function history(): NewJournalEvent[] {
  const events: NewJournalEvent[] = [];
  for (let minute = 0; minute < 12; minute++) {
    const docId = DOCS[minute % DOCS.length]!;
    events.push(docEvent(docId, minute < DOCS.length ? "created" : "updated", minute));
    if (minute % 2 === 0) events.push(indexed(docId, minute));
  }
  return events;
}

let dir: string;
let gatewayDbPath: string;
let scheduler: Scheduler | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-watch-journal-worker-"));
  gatewayDbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  createDatabase(gatewayDbPath).close();
});

afterEach(async () => {
  await scheduler?.dispose();
  scheduler = null;
  rmSync(dir, { recursive: true, force: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(gatewayDbPath + suffix)) unlinkSync(gatewayDbPath + suffix);
  }
});

async function ioWithJournal(path: string, key: Buffer | null) {
  scheduler = new Scheduler({ enablePreemption: false });
  scheduler.registerRunner(
    new IoTaskRunner({
      gatewayDbPath,
      heartbeatIntervalMs: 1_000,
      heartbeatWarnGapMs: 10_000,
      workerUrl: WORKER_URL,
      workerExecArgv: ["--import", LOADER_URL],
      watchJournal: { path, ...(key ? { keyHex: key.toString("hex") } : {}) },
    }),
  );
  await scheduler.start();
  return ioGateFromScheduler(scheduler);
}

/**
 * Every document (and one never journalled) at every position in the
 * journal, answered from one read-ahead at the head, equals the store's own
 * read. Returns how many lookups the read-ahead could not answer.
 */
async function expectPrefetchMatchesStore(
  store: WatchJournalStore,
  reader: JournalHistoryReader,
  docIds: readonly string[] = [...DOCS, "d1111111-0000-4000-8000-0000000000ff"],
): Promise<{ found: number; direct: number }> {
  let found = 0;
  let direct = 0;
  const head = store.head();
  const documents = new PrefetchedJournalDocuments((docId, atSeq) => {
    direct++;
    return store.documentAt(docId, atSeq);
  });
  await documents.prefetch(
    reader,
    docIds.map((docId) => ({ docId, atSeq: head })),
  );
  for (const docId of docIds) {
    for (let atSeq = 0; atSeq <= head; atSeq++) {
      const expected = store.documentAt(docId, atSeq);
      expect(documents.lookup(docId, atSeq), `${docId} at ${atSeq}`).toStrictEqual(expected);
      if (expected) found++;
    }
  }
  return { found, direct };
}

it("answers every lookup exactly as the journal store does, past unreadable rows", async () => {
  const path = join(dir, "watch.db");
  const store = WatchJournalStore.open(path, null);
  try {
    store.commit({ events: history().slice(0, 8) });
    // A row this build cannot read and one that is not JSON at all, in the
    // middle of a document's history: both are skipped by the index guard or
    // the decoder, and the worker must skip them the same way.
    // Through the cipher build, as the gateway opens this file: a second
    // SQLite library in the process would not see the store's locks.
    const raw = openEncryptedSqlite(path);
    raw
      .prepare(
        `INSERT INTO watch_events (kind, occurred_at, observed_at, payload)
         VALUES ('doc.event', '2026-03-01T09:30:00.000Z', '2026-03-01T09:30:00.000Z', ?)`,
      )
      .run(JSON.stringify({ docId: DOCS[0], nope: true }));
    raw
      .prepare(
        `INSERT INTO watch_events (kind, occurred_at, observed_at, payload)
         VALUES ('doc.event', '2026-03-01T09:31:00.000Z', '2026-03-01T09:31:00.000Z', 'not json')`,
      )
      .run();
    raw.close();
    store.commit({ events: history().slice(8) });

    const io = await ioWithJournal(path, null);
    const { found, direct } = await expectPrefetchMatchesStore(store, (requests) =>
      io.watchDocumentHistories(requests),
    );
    expect(found).toBeGreaterThan(20);
    // Each history is short enough to be read whole, so nothing fell back.
    expect(direct).toBe(0);
  } finally {
    store.close();
  }
}, 60_000);

it("opens an encrypted journal with its own key", async () => {
  const path = join(dir, "watch.db");
  const key = randomBytes(32);
  const store = WatchJournalStore.open(path, key);
  try {
    store.commit({ events: history() });
    const io = await ioWithJournal(path, key);
    const { found } = await expectPrefetchMatchesStore(store, (requests) =>
      io.watchDocumentHistories(requests),
    );
    expect(found).toBeGreaterThan(20);
  } finally {
    store.close();
  }
}, 60_000);

it("reads a long history past the read-ahead on the calling thread, with the same answers", async () => {
  const path = join(dir, "watch.db");
  const store = WatchJournalStore.open(path, null);
  try {
    const docId = DOCS[0]!;
    store.commit({
      events: Array.from({ length: 30 }, (_, i) =>
        docEvent(docId, i === 0 ? "created" : "updated", i),
      ),
    });
    const io = await ioWithJournal(path, null);
    const { found, direct } = await expectPrefetchMatchesStore(
      store,
      (requests) => io.watchDocumentHistories(requests),
      [docId],
    );
    expect(found).toBe(30);
    // The newest JOURNAL_HISTORY_DEPTH revisions came from the worker; only
    // positions before them were read here.
    expect(direct).toBe(31 - JOURNAL_HISTORY_DEPTH);
  } finally {
    store.close();
  }
}, 60_000);

it("falls back to the calling thread when the read-ahead fails", async () => {
  const path = join(dir, "watch.db");
  const store = WatchJournalStore.open(path, null);
  try {
    store.commit({ events: history() });
    const failures: unknown[] = [];
    const documents = new PrefetchedJournalDocuments((docId, atSeq) =>
      store.documentAt(docId, atSeq),
    );
    await documents.prefetch(
      () => Promise.reject(new Error("io workers shut down")),
      [{ docId: DOCS[0]!, atSeq: store.head() }],
      (err) => failures.push(err),
    );
    expect(failures).toHaveLength(1);
    expect(documents.lookup(DOCS[0]!, store.head())).toStrictEqual(
      store.documentAt(DOCS[0]!, store.head()),
    );
  } finally {
    store.close();
  }
});

it("refuses the lookup when the worker was started without a journal", async () => {
  scheduler = new Scheduler({ enablePreemption: false });
  scheduler.registerRunner(
    new IoTaskRunner({
      gatewayDbPath,
      heartbeatIntervalMs: 1_000,
      heartbeatWarnGapMs: 10_000,
      workerUrl: WORKER_URL,
      workerExecArgv: ["--import", LOADER_URL],
    }),
  );
  await scheduler.start();
  await expect(
    ioGateFromScheduler(scheduler).watchDocumentHistories([{ docId: DOCS[0]!, atSeq: 1 }]),
  ).rejects.toThrow(/no watch journal/);
}, 60_000);
