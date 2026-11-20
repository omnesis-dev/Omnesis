// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  lstatSync,
  symlinkSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import { ReplayBackend } from "@omnesis/agent";
import { FsCognitionTranscriptStore } from "../brain/transcripts.js";
import { FsConversationStore, type ConversationRecord } from "../agent/conversation-store.js";
import { BackupService } from "../http/services/BackupService.js";
import { AgentService } from "../agent/service.js";
import { HistoryCleanupService } from "./history-cleanup-service.js";
import {
  createHistoryCleanupTables,
  startHistoryCleanupJob,
  updateHistoryCleanupJob,
  cancelHistoryCleanupJob,
  readHistoryCleanupJob,
} from "./history-cleanup-store.js";
import { transcriptCleanupAdapter } from "./history-cleanup-transcripts.js";
import { backupCleanupAdapter } from "./history-cleanup-backups.js";
import type { HistoryCleanupAdapter, StoredHistoryCleanupJob } from "./history-cleanup-types.js";
const roots: string[] = [];
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(
  adapters: Partial<Record<StoredHistoryCleanupJob["target"], HistoryCleanupAdapter>>,
) {
  const root = mkdtempSync(join(tmpdir(), "history-cleanup-"));
  roots.push(root);
  const db = new Database(join(root, "jobs.db"));
  createHistoryCleanupTables(db);
  const writes = {
    startHistoryCleanupJob: async (input: Parameters<typeof startHistoryCleanupJob>[1]) =>
      startHistoryCleanupJob(db, input),
    updateHistoryCleanupJob: async (input: Parameters<typeof updateHistoryCleanupJob>[1]) =>
      updateHistoryCleanupJob(db, input),
    cancelHistoryCleanupJob: async (input: Parameters<typeof cancelHistoryCleanupJob>[1]) =>
      cancelHistoryCleanupJob(db, input),
  };
  const service = new HistoryCleanupService({ db, writes, adapters });
  closers.push(async () => {
    await service.dispose();
    db.close();
  });
  return { root, db, writes, service };
}
async function drain(service: HistoryCleanupService, id: string, max = 2000) {
  for (let n = 0; n < max; n++) {
    await service.sweep();
    const job = service.jobs().find((j) => j.id === id)!;
    if (job.state === "completed" || job.state === "cancelled" || job.state === "failed")
      return job;
  }
  throw new Error("Invented cleanup did not finish");
}
const before = "2032-01-01T00:00:00.000Z";
test("job lookup keeps old cleanup results readable without exposing durable removal authority", async () => {
  const { db, service } = fixture({});
  const first = startHistoryCleanupJob(db, { request: { target: "backups", before }, now: 1 });
  updateHistoryCleanupJob(db, {
    expectedRevision: first.revision,
    job: {
      ...first,
      state: "completed",
      updatedAt: 2,
      completedAt: 2,
      removed: 7,
      protected: 2,
      removedBytesEstimate: 420,
      protectedReasons: { newest: 2 },
    },
  });
  const publicCompleted = service.jobs()[0];
  for (let i = 0; i < 55; i++) {
    const job = startHistoryCleanupJob(db, { request: { target: "backups", before }, now: i + 3 });
    updateHistoryCleanupJob(db, {
      expectedRevision: job.revision,
      job: { ...job, state: "completed", completedAt: i + 3 },
    });
  }
  expect(service.jobs()).toHaveLength(50);
  expect(service.jobs().some((job) => job.id === first.id)).toBe(false);
  expect(service.job(first.id)).toEqual(publicCompleted);
  expect(service.job(first.id)).toMatchObject({
    keepNewest: true,
    removed: 7,
    protected: 2,
    removedBytesEstimate: 420,
    protectedReasons: { newest: 2 },
    hasPendingRemoval: false,
  });
  expect(service.job("00000000-0000-4000-8000-000000000001")).toBeNull();

  const active = startHistoryCleanupJob(db, {
    request: { target: "conversations", before },
    now: 60,
  });
  updateHistoryCleanupJob(db, {
    expectedRevision: active.revision,
    job: {
      ...active,
      state: "failed",
      cursor: "private-scan-cursor",
      pending: {
        id: "invented-item",
        identity: "private-file-identity",
        bytesEstimate: 42,
        detail: "private-resume-details",
      },
    },
  });
  const result = service.job(active.id);
  expect(result).toMatchObject({ state: "failed", hasPendingRemoval: true });
  for (const field of ["revision", "cursor", "pending", "identity", "detail"])
    expect(result).not.toHaveProperty(field);
  expect(JSON.stringify(result)).not.toContain("private-");
});

test("Brain cleanup covers more than one display page and preserves newer logs and run metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "history-brain-"));
  roots.push(root);
  const store = new FsCognitionTranscriptStore(root);
  closers.push(() => store.close());
  for (let i = 0; i < 125; i++)
    store.save({
      runId: "invented_" + i,
      attempt: 1,
      kind: "data",
      startedAt: 10,
      finishedAt: 100 + i,
      prompt: "Invented check",
      events: [],
      finalText: "Invented conclusion",
      outcome: "completed",
      usage: null,
    });
  store.save({
    runId: "newer",
    attempt: 1,
    kind: "data",
    startedAt: Date.parse(before),
    finishedAt: Date.parse(before) + 1,
    prompt: "Invented check",
    events: [],
    finalText: "Newer conclusion",
    outcome: "completed",
    usage: null,
  });
  const f = fixture({ "brain-transcripts": transcriptCleanupAdapter(store) });
  const job = await f.service.start({ target: "brain-transcripts", before });
  const done = await drain(f.service, job.id);
  expect(done).toMatchObject({ state: "completed", removed: 125 });
  expect(store.list().map((ref) => ref.runId)).toEqual(["newer"]);
  expect(done.removedBytesEstimate).toBeGreaterThan(0);
});
test("pending authority survives a crash and cancellation cannot discard its required cleanup", async () => {
  let removed = 0;
  let close = 0;
  const candidate = { id: "invented-file", identity: "invented-identity", bytesEstimate: 30 };
  const adapter: HistoryCleanupAdapter = {
    next: async () => ({ candidate, cursor: "one", scanned: 1, protectedReasons: {}, done: false }),
    remove: async () => {
      removed++;
      return { state: "removed", bytesEstimate: 30 };
    },
    close: async () => {
      close++;
    },
  };
  const f = fixture({ conversations: adapter });
  const job = await f.service.start({ target: "conversations", before });
  await f.service.sweep();
  expect(readHistoryCleanupJob(f.db, job.id)?.pending).toEqual(candidate);
  const cancelled = await f.service.cancel(job.id);
  expect(cancelled).toMatchObject({ cancelRequested: true, state: "running" });
  const reserve = vi.fn(async () => true);
  const recovered = new HistoryCleanupService({
    db: f.db,
    writes: f.writes,
    adapters: { conversations: { ...adapter, reserve } },
  });
  await recovered.initialize();
  expect(reserve).toHaveBeenCalledTimes(1);
  await recovered.sweep();
  expect(recovered.jobs()[0]).toMatchObject({
    state: "cancelled",
    removed: 1,
    removedBytesEstimate: 30,
  });
  await recovered.sweep();
  expect(removed).toBe(1);
  expect(close).toBe(1);
  await recovered.dispose();
});
function backup(root: string, name: string, startedAt: string, encrypted = false) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, encrypted ? "snapshot.db.enc" : "snapshot.db"), "Invented backup bytes");
  writeFileSync(
    join(dir, "backup-manifest.json"),
    JSON.stringify({
      version: "0.0.0",
      startedAt,
      finishedAt: startedAt,
      includeIndex: false,
      files: [
        {
          name: encrypted ? "snapshot.db.enc" : "snapshot.db",
          bytes: 21,
          ...(encrypted ? { encrypted: true } : {}),
        },
      ],
      ...(encrypted
        ? { encryption: { scheme: "omnesis.encrypted-artifact.v1", key: "install-root-key-v1" } }
        : {}),
    }),
  );
  return dir;
}
test.each([
  ["2031-01-01T00-00-00", "2031-01-01T00:00:00.000Z"],
  ["2030-01-01T00-00-00-2", "2030-01-01T00:00:00.000Z"],
])(
  "newest-backup protection rejects a stale catalog when %s completes",
  async (name, startedAt) => {
    const f = fixture({});
    const dir = join(f.root, "backups");
    mkdirSync(dir);
    mkdirSync(join(dir, ".storage-cleanup"), { mode: 0o700 });
    const previousNewest = backup(dir, "2030-01-01T00-00-00", "2030-01-01T00:00:00.000Z");
    const completing = join(dir, name);
    mkdirSync(completing);
    writeFileSync(join(completing, "snapshot.db"), "Invented backup bytes");
    const adapter = backupCleanupAdapter({
      backupsDir: dir,
      exclusive: (operation) => operation(),
    });
    const job = startHistoryCleanupJob(f.db, { request: { target: "backups", before }, now: 1 });
    const catalog = await adapter.next(job);
    expect(catalog).toMatchObject({ done: false, progressed: true, resetProtected: true });
    expect(catalog.candidate).toBeUndefined();
    const rootMtime = lstatSync(dir, { bigint: true }).mtimeNs;
    // Completing an existing archive changes its own directory, not the catalog root.
    backup(dir, name, startedAt);
    expect(lstatSync(dir, { bigint: true }).mtimeNs).toBe(rootMtime);
    const service = new HistoryCleanupService({
      db: f.db,
      writes: f.writes,
      adapters: { backups: adapter },
    });
    closers.push(() => service.dispose());
    const done = await drain(service, job.id);
    expect(existsSync(completing)).toBe(true);
    expect(existsSync(previousNewest)).toBe(true);
    expect(done).toMatchObject({
      state: "completed",
      removed: 0,
      protectedReasons: { newest: 1, changed: 1 },
    });
  },
);

test("backup cleanup preserves newest and incomplete archives, supports encrypted catalogs and explicit newest opt-out", async () => {
  const f = fixture({});
  const dir = join(f.root, "backups");
  mkdirSync(dir);
  const old = backup(dir, "2030-01-01T00-00-00", "2030-01-01T00:00:00.000Z", true);
  const newest = backup(dir, "2031-01-01T00-00-00", "2031-01-01T00:00:00.000Z");
  const partial = join(dir, "2031-06-01T00-00-00");
  mkdirSync(partial);
  writeFileSync(join(partial, "snapshot.db"), "still writing");
  const adapter = backupCleanupAdapter({ backupsDir: dir, exclusive: (operation) => operation() });
  const service = new HistoryCleanupService({
    db: f.db,
    writes: f.writes,
    adapters: { backups: adapter },
  });
  closers.push(() => service.dispose());
  const job = await service.start({ target: "backups", before });
  const done = await drain(service, job.id);
  expect(done).toMatchObject({ removed: 1, protectedReasons: { newest: 1, incomplete: 1 } });
  expect(existsSync(old)).toBe(false);
  expect(existsSync(newest)).toBe(true);
  expect(existsSync(partial)).toBe(true);
  const all = await service.start({ target: "backups", before, keepNewest: false });
  await drain(service, all.id);
  expect(existsSync(newest)).toBe(false);
  expect(existsSync(partial)).toBe(true);
});
test("backup claims resume after restart and never traverse directory links", async () => {
  const f = fixture({});
  const dir = join(f.root, "backups");
  mkdirSync(dir);
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep"), "Invented protected data");
  symlinkSync(outside, join(dir, "2030-02-01T00-00-00"), "junction");
  backup(dir, "2030-01-01T00-00-00", "2030-01-01T00:00:00.000Z");
  const adapter = backupCleanupAdapter({ backupsDir: dir, exclusive: (operation) => operation() });
  const started = startHistoryCleanupJob(f.db, {
    request: { target: "backups", before, keepNewest: false },
    now: 1,
  });
  let page;
  for (let n = 0; n < 20; n++) {
    page = await adapter.next(started);
    if (page.candidate) break;
  }
  expect(page?.candidate).toBeDefined();
  const candidate = page!.candidate!;
  const pending = updateHistoryCleanupJob(f.db, {
    expectedRevision: started.revision,
    job: { ...started, state: "running", pending: candidate },
  })!;
  mkdirSync(join(dir, ".storage-cleanup"));
  renameSync(join(dir, candidate.id), join(dir, ".storage-cleanup", started.id));
  await adapter.close?.(started.id);
  const restarted = backupCleanupAdapter({
    backupsDir: dir,
    exclusive: (operation) => operation(),
  });
  const validation = await restarted.remove(pending, candidate);
  expect(validation.state).toBe("pending");
  if (validation.state !== "pending" || !validation.candidate)
    throw new Error("Expected a durable verified claim");
  const verified = updateHistoryCleanupJob(f.db, {
    expectedRevision: pending.revision,
    job: { ...pending, pending: validation.candidate },
  })!;
  // A native recursive delete may remove the manifest before a process stops.
  unlinkSync(join(dir, ".storage-cleanup", started.id, "backup-manifest.json"));
  const resumed = backupCleanupAdapter({ backupsDir: dir, exclusive: (operation) => operation() });
  expect(await resumed.remove(verified, verified.pending!)).toMatchObject({ state: "removed" });
  expect(existsSync(join(dir, ".storage-cleanup", started.id))).toBe(false);
  expect(existsSync(join(outside, "keep"))).toBe(true);
});
function record(id: string, pinned = false): ConversationRecord {
  return {
    id,
    callerId: "device:invented",
    model: "scripted",
    backend: "scripted",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    title: "Invented thread",
    pinned,
    messages: [],
  };
}
test("conversation scan verifies a complete pass, reports pinned/permanent protection and does not cap at 100", async () => {
  const f = fixture({});
  const conversationsDir = join(f.root, "conversations");
  mkdirSync(conversationsDir, { recursive: true });
  // A restored archive may have records without a summary index. Seed those
  // files directly; publication is covered by the conversation-store tests.
  const records: ConversationRecord[] = [
    ...Array.from({ length: 125 }, (_, n) => record("invented-" + n)),
    record("pinned", true),
    {
      ...record("morning"),
      origin: { kind: "daily_brief", runId: "invented-run", briefs: [] },
    },
  ];
  for (const rec of records)
    writeFileSync(join(conversationsDir, `${rec.id}.json`), JSON.stringify(rec));
  const store = new FsConversationStore(conversationsDir);
  closers.push(() => store.close());
  const scan = store.createCleanupScanner();
  let job = startHistoryCleanupJob(f.db, { request: { target: "conversations", before }, now: 1 });
  let protectedReasons: Record<string, number> = {};
  let completed = false;
  for (let n = 0; n < 1000; n++) {
    const page = await scan.next(job);
    if (page.resetProtected) protectedReasons = {};
    for (const [reason, count] of Object.entries(page.protectedReasons))
      protectedReasons[reason] = (protectedReasons[reason] ?? 0) + count;
    if (page.candidate) {
      await store.deleteForRetention(page.candidate.id);
      job = { ...job, removed: job.removed + 1 };
    }
    if (page.done) {
      completed = true;
      break;
    }
  }
  await scan.close();
  expect(completed).toBe(true);
  expect(job.removed).toBe(125);
  expect(protectedReasons).toMatchObject({ pinned: 1, permanent: 1 });
  expect((await store.list()).map((r) => r.id).sort()).toEqual(["morning", "pinned"]);
});
test("restored mutation ownership blocks resume and pin, and an owned cleanup does not block itself", async () => {
  const f = fixture({});
  const store = new FsConversationStore(join(f.root, "conversations"));
  closers.push(() => store.close());
  await store.save(record("owned"));
  const inspections = await import("../agent/conversation-retention.js");
  const candidate = (
    await inspections.readConversationCleanupCandidates(
      [{ id: "owned", path: join(f.root, "conversations", "owned.json") }],
      Date.parse(before),
    )
  )[0]!.candidate!;
  let batches = 0;
  const service = new AgentService({
    backendFactory: () => new ReplayBackend({ fixtures: [] }),
    ports: {
      search: { search: async (input) => ({ query: input.query, durationMs: 0, results: [] }) },
      document: { fetch: async () => null },
    },
    systemPrompt: "Invented test",
    broadcastEvent: () => {},
    store,
    onConversationRetained: async () => ++batches > 1,
  });
  closers.push(() => service.dispose());
  expect(service.reserveHistoryCleanup("owned")).toBe(true);
  await expect(
    service.createSession("device:invented", { resumeFromId: "owned" }),
  ).rejects.toMatchObject({ code: "session_busy" });
  await expect(service.setConversationPinned("owned", true)).rejects.toMatchObject({
    code: "session_busy",
  });
  expect(await service.cleanupConversation(candidate, Date.parse(before), 10)).toEqual({
    state: "pending",
  });
  expect(await service.cleanupConversation(candidate, Date.parse(before), 10)).toEqual({
    state: "removed",
    bytesEstimate: 10,
  });
  await expect(
    service.createSession("device:invented", { resumeFromId: "owned" }),
  ).rejects.toMatchObject({ code: "session_busy" });
  service.releaseHistoryCleanup("owned");
  expect(await store.load("owned")).toBeNull();
});

test("concurrent starts map writer conflicts to 409 and never create two authorities", async () => {
  const adapter: HistoryCleanupAdapter = {
    next: async () => ({ cursor: null, scanned: 0, protectedReasons: {}, done: true }),
    remove: async () => ({ state: "protected", reason: "invalid" }),
  };
  const f = fixture({ conversations: adapter });
  const results = await Promise.allSettled([
    f.service.start({ target: "conversations", before }),
    f.service.start({ target: "conversations", before }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((r) => r.status === "rejected");
  expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({ status: 409 });
  expect(f.service.jobs()).toHaveLength(1);
});
test("cancellation winning pending publication releases an uncommitted mutation fence without deleting", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let owned = false;
  const remove = vi.fn(async () => ({ state: "removed" as const, bytesEstimate: 1 }));
  const adapter: HistoryCleanupAdapter = {
    next: async () => ({
      cursor: "next",
      scanned: 1,
      protectedReasons: {},
      done: false,
      candidate: { id: "invented", identity: "same", bytesEstimate: 1 },
    }),
    reserve: async () => {
      owned = true;
      return true;
    },
    acknowledge: async () => {
      owned = false;
    },
    remove,
  };
  const f = fixture({ conversations: adapter });
  const writes = {
    ...f.writes,
    updateHistoryCleanupJob: async (input: Parameters<typeof updateHistoryCleanupJob>[1]) => {
      if (input.job.pending) {
        entered.resolve();
        await release.promise;
      }
      return f.writes.updateHistoryCleanupJob(input);
    },
  };
  const service = new HistoryCleanupService({
    db: f.db,
    writes,
    adapters: { conversations: adapter },
  });
  closers.push(() => service.dispose());
  const job = await service.start({ target: "conversations", before });
  const step = service.sweep();
  await entered.promise;
  expect(owned).toBe(true);
  await service.cancel(job.id);
  release.resolve();
  await step;
  expect(service.jobs()[0]).toMatchObject({ state: "cancelled", removed: 0 });
  expect(owned).toBe(false);
  expect(remove).not.toHaveBeenCalled();
});

test.each([false, true])(
  "reservation follows durable authority after writer error (committed=%s)",
  async (committed) => {
    const candidate = { id: "invented-authority", identity: "original", bytesEstimate: 1 };
    let owned = false;
    const adapter: HistoryCleanupAdapter = {
      next: async () => ({
        candidate,
        cursor: "next",
        scanned: 1,
        protectedReasons: {},
        done: false,
      }),
      reserve: async () => {
        owned = true;
        return true;
      },
      acknowledge: async () => {
        owned = false;
      },
      remove: async () => ({ state: "pending" }),
    };
    const f = fixture({ conversations: adapter });
    const writes = {
      ...f.writes,
      updateHistoryCleanupJob: async (input: Parameters<typeof updateHistoryCleanupJob>[1]) => {
        if (input.job.pending && input.job.state === "running") {
          if (committed) await f.writes.updateHistoryCleanupJob(input);
          throw new Error("Invented writer reply failure");
        }
        return f.writes.updateHistoryCleanupJob(input);
      },
    };
    const service = new HistoryCleanupService({
      db: f.db,
      writes,
      adapters: { conversations: adapter },
    });
    closers.push(() => service.dispose());
    const job = await service.start({ target: "conversations", before });
    await service.sweep();
    expect(owned).toBe(committed);
    expect(!!readHistoryCleanupJob(f.db, job.id)?.pending).toBe(committed);
  },
);
test("startup refuses to expose a pending cleanup whose mutation fence cannot be restored", async () => {
  const candidate = { id: "invented-owned", identity: "original", bytesEstimate: 1 };
  const adapter: HistoryCleanupAdapter = {
    next: async () => ({
      candidate,
      cursor: "next",
      scanned: 1,
      protectedReasons: {},
      done: false,
    }),
    remove: async () => ({ state: "pending" }),
  };
  const f = fixture({ conversations: adapter });
  const job = await f.service.start({ target: "conversations", before });
  await f.service.sweep();
  expect(readHistoryCleanupJob(f.db, job.id)?.pending).not.toBeNull();
  const restored = new HistoryCleanupService({
    db: f.db,
    writes: f.writes,
    adapters: { conversations: { ...adapter, reserve: async () => false } },
  });
  closers.push(() => restored.dispose());
  await expect(restored.initialize()).rejects.toMatchObject({ status: 503 });
});

test("a failed discovery closes its scanner instead of retaining an unreachable resource", async () => {
  const close = vi.fn(async () => {});
  const f = fixture({
    conversations: {
      next: async () => {
        throw new Error("Invented enumeration failure");
      },
      remove: async () => ({ state: "pending" }),
      close,
    },
  });
  const job = await f.service.start({ target: "conversations", before });
  expect(await f.service.sweep()).toEqual({ hasMore: false, progressed: false });
  expect(f.service.jobs()[0]).toMatchObject({
    id: job.id,
    state: "failed",
    hasPendingRemoval: false,
  });
  expect(close).toHaveBeenCalledWith(job.id);
});
test("old pending jobs stay visible, seek the bounded active index and close despite more than50 recent terminals", async () => {
  const close = vi.fn(async () => {});
  const f = fixture({
    "brain-transcripts": {
      next: async () => ({ cursor: null, scanned: 0, protectedReasons: {}, done: true }),
      remove: async () => ({ state: "pending" }),
      close,
    },
  });
  const old = startHistoryCleanupJob(f.db, {
    request: { target: "brain-transcripts", before },
    now: 1,
  });
  updateHistoryCleanupJob(f.db, {
    expectedRevision: old.revision,
    job: {
      ...old,
      state: "failed",
      pending: { id: "invented", identity: "same", bytesEstimate: 1 },
    },
  });
  for (let n = 0; n < 70; n++) {
    const job = startHistoryCleanupJob(f.db, {
      request: { target: "conversations", before },
      now: n + 100,
    });
    updateHistoryCleanupJob(f.db, {
      expectedRevision: job.revision,
      job: { ...job, state: "completed" },
    });
  }
  expect(f.service.jobs()).toContainEqual(
    expect.objectContaining({ id: old.id, hasPendingRemoval: true }),
  );
  const spy = vi.spyOn(f.db, "prepare");
  await f.service.sweep();
  const sql = spy.mock.calls
    .map((args) => args[0])
    .find((sql) => sql.includes("INDEXED BY idx_storage_cleanup_active_target"))!;
  spy.mockRestore();
  const plans = f.db.prepare("EXPLAIN QUERY PLAN " + sql).all() as Array<{ detail: string }>;
  expect(plans.map((row) => row.detail).join(" ")).toMatch(
    /USING INDEX idx_storage_cleanup_active_target/,
  );
  await f.service.dispose();
  expect(close).toHaveBeenCalledWith(old.id);
});
test("progressive work can be kicked without a one-second delay per file while repeated waits cannot spin", async () => {
  const count = 250;
  const adapter: HistoryCleanupAdapter = {
    next: async (job) => {
      const n = Number(job.cursor ?? 0);
      return n === count
        ? { cursor: job.cursor, scanned: 0, protectedReasons: {}, done: true }
        : {
            candidate: { id: "invented-" + n, identity: "same", bytesEstimate: 1 },
            cursor: String(n + 1),
            scanned: 1,
            protectedReasons: {},
            done: false,
          };
    },
    remove: async () => ({ state: "removed", bytesEstimate: 1 }),
  };
  const f = fixture({ conversations: adapter });
  const job = await f.service.start({ target: "conversations", before });
  let turns = 0;
  for (; turns < 2 * count + 2; turns++) {
    const result = await f.service.sweep();
    expect(result.progressed).toBe(true);
    if (!result.hasMore) break;
  }
  expect(turns).toBe(2 * count);
  expect(f.service.jobs()[0]).toMatchObject({ id: job.id, state: "completed", removed: count });
  const waiting: HistoryCleanupAdapter = {
    ...adapter,
    next: async () => ({
      cursor: null,
      scanned: 1,
      protectedReasons: {},
      done: false,
      candidate: { id: "waiting", identity: "same", bytesEstimate: 1 },
    }),
    remove: async () => ({ state: "pending" }),
  };
  const waiter = new HistoryCleanupService({
    db: f.db,
    writes: f.writes,
    adapters: { backups: waiting },
  });
  closers.push(() => waiter.dispose());
  await waiter.start({ target: "backups", before });
  expect((await waiter.sweep()).progressed).toBe(true);
  for (let n = 0; n < 3; n++)
    expect(await waiter.sweep()).toEqual({ hasMore: true, progressed: false });
});

test("backup creation reports cleanup contention truthfully while an archive claim is in flight", async () => {
  const f = fixture({});
  const dir = join(f.root, "backups");
  mkdirSync(dir);
  backup(dir, "2030-01-01T00-00-00", "2030-01-01T00:00:00.000Z");
  const service = new BackupService({
    configDir: f.root,
    gatewayDbPath: join(f.root, "jobs.db"),
    indexDbPath: join(f.root, "absent-index.db"),
    watchDbPath: join(f.root, "absent-watch.db"),
    analyticsDbPath: join(f.root, "absent-analytics.db"),
    analyticsBackup: async () => {},
  });
  const adapter = service.createCleanupAdapter();
  const job = startHistoryCleanupJob(f.db, {
    request: { target: "backups", before, keepNewest: false },
    now: 1,
  });
  let page;
  for (let n = 0; n < 20; n++) {
    page = await adapter.next(job);
    if (page.candidate) break;
  }
  const remove = adapter.remove(job, page!.candidate!);
  expect(service.getStatus().running).toBe(false);
  expect(() => service.start()).toThrow(/backup is being removed/);
  expect(await remove).toMatchObject({ state: "pending" });
  await adapter.close?.(job.id);
});

test("shutdown closes every adapter even when one closure fails", async () => {
  const f = fixture({});
  for (const target of ["brain-transcripts", "conversations"] as const)
    startHistoryCleanupJob(f.db, { request: { target, before }, now: Date.now() });
  const failure = new Error("Invented scanner closure failure");
  const first = vi.fn(async () => {
    throw failure;
  });
  const second = vi.fn(async () => {});
  const adapter = (close: HistoryCleanupAdapter["close"]): HistoryCleanupAdapter => ({
    next: async () => ({ cursor: null, scanned: 0, protectedReasons: {}, done: true }),
    remove: async () => ({ state: "protected", reason: "active" }),
    close,
  });
  const service = new HistoryCleanupService({
    db: f.db,
    writes: f.writes,
    adapters: { "brain-transcripts": adapter(first), conversations: adapter(second) },
  });
  const shutdown = service.dispose();
  await expect(shutdown).rejects.toMatchObject({ errors: [failure] });
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
  expect(service.dispose()).toBe(shutdown);
  await expect(service.sweep()).resolves.toEqual({ hasMore: false, progressed: false });
});

test("shutdown closes acquired resources even when its database reader has failed", async () => {
  const root = mkdtempSync(join(tmpdir(), "history-cleanup-reader-failure-"));
  roots.push(root);
  const db = new Database(join(root, "jobs.db"));
  createHistoryCleanupTables(db);
  const close = vi.fn(async () => {});
  const service = new HistoryCleanupService({
    db,
    writes: {
      startHistoryCleanupJob: async (input) => startHistoryCleanupJob(db, input),
      updateHistoryCleanupJob: async (input) => updateHistoryCleanupJob(db, input),
      cancelHistoryCleanupJob: async (input) => cancelHistoryCleanupJob(db, input),
    },
    adapters: {
      backups: {
        next: async () => ({ cursor: null, scanned: 1, protectedReasons: {}, done: false }),
        remove: async () => ({ state: "pending" }),
        close,
      },
    },
  });
  const job = await service.start({ target: "backups", before });
  await service.sweep();
  db.close();
  await expect(service.dispose()).rejects.toBeInstanceOf(AggregateError);
  expect(close).toHaveBeenCalledExactlyOnceWith(job.id);
  await expect(service.sweep()).resolves.toEqual({ hasMore: false, progressed: false });
});

test("concurrent starts never close resources acquired by a newly running job", async () => {
  let reads = 0;
  let closes = 0;
  const release: Array<() => void> = [];
  const closed: string[] = [];
  const f = fixture({
    backups: {
      next: async () => {
        if (reads++ === 0) throw new Error("Invented discovery failure");
        return {
          cursor: "after-one",
          scanned: 1,
          protectedReasons: {},
          done: false,
          candidate: { id: "invented-candidate", identity: "invented-identity", bytesEstimate: 1 },
        };
      },
      remove: async () => ({ state: "pending" }),
      close: async (id) => {
        closed.push(id);
        if (closes++ === 0) throw new Error("Invented scanner closure failure");
        if (release.length < 2) await new Promise<void>((resolve) => release.push(resolve));
      },
    },
  });
  const old = await f.service.start({ target: "backups", before });
  await expect(f.service.sweep()).rejects.toThrow("Invented scanner closure failure");
  const first = f.service.start({ target: "backups", before });
  const second = f.service.start({ target: "backups", before });
  const conflict = expect(second).rejects.toThrow("already running");
  expect(release).toHaveLength(2);
  release[0]!();
  const current = await first;
  await f.service.sweep();
  expect(f.service.jobs().find((job) => job.id === current.id)).toMatchObject({
    state: "running",
    hasPendingRemoval: true,
  });
  release[1]!();
  await conflict;
  expect(closed).toEqual([old.id, old.id, old.id]);
  expect(f.service.jobs().find((job) => job.id === current.id)).toMatchObject({
    state: "running",
    hasPendingRemoval: true,
  });
});
