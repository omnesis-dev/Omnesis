// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Sqlite from "better-sqlite3";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  FsCognitionTranscriptStore,
  cognitionTranscriptsDir,
  type CognitionRunTranscript,
} from "./transcripts.js";

const scanDirectories = vi.hoisted(() => ({ opened: [] as import("node:fs").Dir[] }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    opendir: async (path: string) => {
      const directory = await actual.opendir(path);
      scanDirectories.opened.push(directory);
      return directory;
    },
  };
});

function transcript(overrides: Partial<CognitionRunTranscript>): CognitionRunTranscript {
  return {
    runId: "run_1",
    attempt: 1,
    kind: "data",
    startedAt: 1000,
    finishedAt: 2000,
    prompt: "Run id: run_1",
    events: [{ type: "agent.text.delta", payload: { delta: "checking" } }],
    finalText: "checking",
    outcome: "completed",
    usage: { promptTokens: 10, completionTokens: 2 },
    ...overrides,
  };
}

const openedStores = new Set<FsCognitionTranscriptStore>();
function trackedStore(dir: string): FsCognitionTranscriptStore {
  const store = new FsCognitionTranscriptStore(dir);
  openedStores.add(store);
  return store;
}
async function closeStores(): Promise<void> {
  await Promise.all([...openedStores].map((store) => store.close()));
  openedStores.clear();
}

describe("FsCognitionTranscriptStore", () => {
  let dir: string;
  let store: FsCognitionTranscriptStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-transcripts-"));
    store = trackedStore(join(dir, "transcripts"));
  });
  afterEach(async () => {
    await closeStores();
    rmSync(dir, { recursive: true, force: true });
  });

  test("last-owner close releases partial discovery and prune scans before directory teardown", async () => {
    for (let i = 0; i < 150; i++)
      store.save(transcript({ runId: `partial_${i}`, finishedAt: i + 1 }));
    const first = scanDirectories.opened.length;
    await store.pruneBatch(1000, 1);
    const held = scanDirectories.opened.slice(first);
    expect(held).toHaveLength(2);
    const closed = store.close();
    expect(store.close()).toBe(closed);
    await closed;
    for (const directory of held)
      await expect(directory.read()).rejects.toMatchObject({ code: "ERR_DIR_CLOSED" });
    rmSync(join(dir, "transcripts"), { recursive: true });
    expect(existsSync(join(dir, "transcripts"))).toBe(false);
  });

  test("closing one facade waits for another scan and preserves its shared cursor", async () => {
    const directory = join(dir, "shared-scans");
    mkdirSync(directory);
    for (let i = 0; i < 10; i++)
      writeFileSync(
        join(directory, `${i + 1}-shared_${i}-a1.json`),
        JSON.stringify(transcript({ runId: `shared_${i}`, finishedAt: i + 1 })),
      );
    const first = trackedStore(directory),
      second = trackedStore(directory);
    type Scan = {
      advanceIndexBatch(limit: number): Promise<boolean>;
      withIndexOperation<T>(operation: () => Promise<T>): Promise<T>;
    };
    const left = first as unknown as Scan,
      right = second as unknown as Scan;
    await left.withIndexOperation(() => left.advanceIndexBatch(1));
    const cursor = scanDirectories.opened.at(-1)!;
    const realRead = (): Promise<import("node:fs").Dirent | null> => cursor.read();
    const started = Promise.withResolvers<void>(),
      proceed = Promise.withResolvers<void>();
    const spy = vi.spyOn(cursor, "read").mockImplementationOnce(async () => {
      started.resolve();
      await proceed.promise;
      return realRead();
    });
    const scan = right.withIndexOperation(() => right.advanceIndexBatch(1));
    await started.promise;
    let finished = false;
    const closing = first.close().then(() => {
      finished = true;
    });
    try {
      await Promise.resolve();
      expect(finished).toBe(false);
      proceed.resolve();
      await expect(scan).resolves.toBe(false);
      await closing;
      spy.mockRestore();
      expect((await second.listPage({ limit: 20 })).length).toBeGreaterThan(0);
      await second.close();
      await expect(cursor.read()).rejects.toMatchObject({ code: "ERR_DIR_CLOSED" });
      rmSync(directory, { recursive: true });
    } finally {
      proceed.resolve();
      spy.mockRestore();
      await scan;
      await closing;
    }
  });

  test("close drains an admitted prune through its unlink and index commit", async () => {
    store.save(transcript({ runId: "drained", finishedAt: 1 }));
    const internal = store as unknown as { unlinkTranscript(name: string): Promise<void> };
    const unlink = internal.unlinkTranscript.bind(store);
    const started = Promise.withResolvers<void>(),
      proceed = Promise.withResolvers<void>();
    const spy = vi.spyOn(internal, "unlinkTranscript").mockImplementationOnce(async (name) => {
      started.resolve();
      await proceed.promise;
      await unlink(name);
    });
    const pruning = store.pruneBatch(2, 1);
    await started.promise;
    let closed = false;
    const closing = store.close().then(() => {
      closed = true;
    });
    try {
      await Promise.resolve();
      expect(closed).toBe(false);
      await expect(store.listPage({ limit: 1 })).rejects.toThrow(/closed/);
      proceed.resolve();
      await expect(pruning).resolves.toMatchObject({ deleted: 1 });
      await closing;
      const next = trackedStore(join(dir, "transcripts"));
      expect(await next.listPage({ limit: 10 })).toEqual([]);
    } finally {
      proceed.resolve();
      spy.mockRestore();
      await pruning;
      await closing;
    }
  });

  test("save then list + load round-trips the transcript", () => {
    store.save(transcript({}));
    const refs = store.list();
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ runId: "run_1", attempt: 1, finishedAt: 2000 });
    const loaded = store.load(refs[0]!.fileName);
    expect(loaded).toEqual(transcript({}));
  });

  test("each attempt of a re-claimed run keeps its own transcript", () => {
    store.save(transcript({ attempt: 1, finishedAt: 2000, outcome: "failed" }));
    store.save(transcript({ attempt: 2, finishedAt: 3000 }));
    const refs = store.list();
    expect(refs.map((r) => r.attempt)).toEqual([1, 2]);
  });

  test("listPage walks stable newest-first pages and can narrow to one run", async () => {
    store.save(transcript({ runId: "run_a", finishedAt: 1000 }));
    store.save(transcript({ runId: "run_b", finishedAt: 2000 }));
    store.save(transcript({ runId: "run_a", attempt: 2, finishedAt: 3000 }));
    const first = await store.listPage({ limit: 2 });
    expect(first.map((ref) => `${ref.runId}/${ref.finishedAt}`)).toEqual([
      "run_a/3000",
      "run_b/2000",
    ]);
    const second = await store.listPage({
      limit: 2,
      before: {
        finishedAt: first[1]!.finishedAt,
        fileName: first[1]!.fileName,
      },
    });
    expect(second.map((ref) => ref.finishedAt)).toEqual([1000]);
    expect((await store.listForRun("run_a")).map((ref) => ref.attempt)).toEqual([2, 1]);
    expect((await store.listPage({ limit: 10, runId: "run_a" })).map((ref) => ref.attempt)).toEqual(
      [2, 1],
    );
  });

  test("list is empty (not an error) before anything was saved", () => {
    expect(store.list()).toEqual([]);
  });

  test("pruneBatch is bounded, asynchronous, and leaves fresh or unknown files", async () => {
    store.save(transcript({ runId: "run_old_1", finishedAt: 1000 }));
    store.save(transcript({ runId: "run_old_2", finishedAt: 2000 }));
    store.save(transcript({ runId: "run_new", finishedAt: 5000 }));
    writeFileSync(join(dir, "transcripts", "operator-notes.txt"), "keep me", "utf8");

    expect(await store.pruneBatch(3000, 1)).toEqual({ deleted: 1, hasMore: true });
    expect(store.list()).toHaveLength(2);
    expect(await store.pruneBatch(3000, 1)).toEqual({ deleted: 1, hasMore: true });
    expect(store.list().map((ref) => ref.runId)).toEqual(["run_new"]);
    expect(await store.pruneBatch(3000, 1)).toEqual({ deleted: 0, hasMore: false });
    expect(readdirSync(join(dir, "transcripts"))).toContain("operator-notes.txt");
  });

  test("pruneBatch resumes a bounded directory scan until exhaustion", async () => {
    const transcriptsDir = join(dir, "transcripts");
    mkdirSync(transcriptsDir, { recursive: true });
    for (let i = 0; i < 105; i += 1) {
      writeFileSync(
        join(transcriptsDir, `${5000 + i}-run_fresh_${i}-a1.json`),
        JSON.stringify(transcript({ runId: `run_fresh_${i}`, finishedAt: 5000 + i })),
        "utf8",
      );
    }
    writeFileSync(
      join(transcriptsDir, "1000-run_expired-a1.json"),
      JSON.stringify(transcript({ runId: "run_expired", finishedAt: 1000 })),
      "utf8",
    );

    let deleted = 0;
    let calls = 0;
    let hasMore = true;
    while (hasMore) {
      const result = await store.pruneBatch(3000, 1);
      deleted += result.deleted;
      hasMore = result.hasMore;
      calls += 1;
      expect(calls).toBeLessThan(10);
    }
    expect(deleted).toBe(1);
    expect(calls).toBeGreaterThan(1);
  });

  test("pruneBatch removes successful refs when a later unlink fails", async () => {
    store.save(transcript({ runId: "run_old_1", finishedAt: 1000 }));
    store.save(transcript({ runId: "run_old_2", finishedAt: 2000 }));

    const internals = store as unknown as {
      unlinkTranscript(fileName: string): Promise<void>;
    };
    const realUnlink = internals.unlinkTranscript.bind(store);
    let removedFileName: string | undefined;
    vi.spyOn(internals, "unlinkTranscript").mockImplementation(async (fileName) => {
      if (!removedFileName) {
        removedFileName = fileName;
        await realUnlink(fileName);
        return;
      }
      throw Object.assign(new Error("injected unlink failure"), { code: "EIO" });
    });

    await expect(store.pruneBatch(3000, 2)).rejects.toMatchObject({ code: "EIO" });
    expect(removedFileName).toBeDefined();
    expect((await store.listPage({ limit: 10 })).map((ref) => ref.fileName)).not.toContain(
      removedFileName,
    );
  });

  test("legacy discovery advances in bounded batches and eventually completes", async () => {
    const transcriptsDir = join(dir, "transcripts");
    mkdirSync(transcriptsDir, { recursive: true });
    for (let i = 0; i < 250; i += 1) {
      writeFileSync(
        join(transcriptsDir, `${1000 + i}-run_legacy_${i}-a1.json`),
        JSON.stringify(transcript({ runId: `run_legacy_${i}`, finishedAt: 1000 + i })),
        "utf8",
      );
    }

    const indexInternals = store as unknown as {
      advanceIndexBatch(): Promise<boolean>;
    };
    expect(await indexInternals.advanceIndexBatch()).toBe(false);
    const indexPath = join(transcriptsDir, ".transcript-index.sqlite");
    const index = new Sqlite(indexPath, { readonly: true });
    expect(
      index.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM transcript_refs").get()
        ?.count,
    ).toBeLessThanOrEqual(100);
    expect(
      index
        .prepare<[], { value: string }>(
          "SELECT value FROM transcript_index_meta WHERE key = 'scan-complete'",
        )
        .get(),
    ).toBeUndefined();
    index.close();

    const firstPage = await store.listPageWithStatus({ limit: 10 });
    expect(firstPage.indexComplete).toBe(false);

    let completed = firstPage;
    for (let attempt = 0; !completed.indexComplete && attempt < 20; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      completed = await store.listPageWithStatus({ limit: 10 });
    }
    expect(completed.indexComplete).toBe(true);
    expect(completed.items.map((ref) => ref.finishedAt)).toEqual([
      1249, 1248, 1247, 1246, 1245, 1244, 1243, 1242, 1241, 1240,
    ]);
    const completedIndex = new Sqlite(indexPath, { readonly: true });
    expect(
      completedIndex
        .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM transcript_refs")
        .get()?.count,
    ).toBe(250);
    expect(
      completedIndex
        .prepare<[], { value: string }>(
          "SELECT value FROM transcript_index_meta WHERE key = 'scan-complete'",
        )
        .get()?.value,
    ).toBe("1");
    completedIndex.close();
  });

  test("keeps one index connection open across reads and writes until closed", async () => {
    // Closing a write-ahead-logged database checkpoints it and removes its
    // log; the log staying put shows no read or write closed the index.
    const wal = join(dir, "transcripts", ".transcript-index.sqlite-wal");
    store.save(transcript({ runId: "kept-open", finishedAt: 1 }));
    expect(existsSync(wal)).toBe(true);
    await store.listPage({ limit: 5 });
    await store.pruneBatch(1, 10);
    expect(existsSync(wal)).toBe(true);
    await store.close();
    expect(existsSync(wal)).toBe(false);
    // Closing is final: the store does not quietly reopen its index.
    expect(() => store.save(transcript({ runId: "after-close", finishedAt: 3 }))).toThrow(/closed/);
    await expect(store.listPage({ limit: 5 })).rejects.toThrow(/closed/);
    expect(existsSync(wal)).toBe(false);
    // Another store on the same directory still reads what was committed.
    const reopened = trackedStore(join(dir, "transcripts"));
    expect((await reopened.listPage({ limit: 5 })).map((ref) => ref.runId)).toEqual(["kept-open"]);
    await reopened.close();
  });

  test("new transcript indexes enable incremental vacuum", async () => {
    store.save(transcript({}));
    await store.listPage({ limit: 1 });

    const index = new Sqlite(join(dir, "transcripts", ".transcript-index.sqlite"), {
      readonly: true,
    });
    expect(index.pragma("auto_vacuum", { simple: true })).toBe(2);
    index.close();
  });

  test("pruneBatch waits for another façade's in-flight legacy index build", async () => {
    const transcriptsDir = join(dir, "transcripts");
    mkdirSync(transcriptsDir, { recursive: true });
    const fileName = "1000-run_expired-a1.json";
    writeFileSync(
      join(transcriptsDir, fileName),
      JSON.stringify(transcript({ runId: "run_expired", finishedAt: 1000 })),
      "utf8",
    );

    const reader = trackedStore(transcriptsDir);
    const retention = trackedStore(transcriptsDir);
    const indexInternals = reader as unknown as {
      advanceIndexBatch(): Promise<boolean>;
    };
    const realAdvance = indexInternals.advanceIndexBatch.bind(reader);
    let announceBuild!: () => void;
    const buildStarted = new Promise<void>((resolve) => {
      announceBuild = resolve;
    });
    let releaseBuild!: () => void;
    const buildMayFinish = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    vi.spyOn(indexInternals, "advanceIndexBatch").mockImplementation(async () => {
      announceBuild();
      await buildMayFinish;
      return realAdvance();
    });

    const page = reader.listPage({ limit: 10 });
    await buildStarted;
    let pruneSettled = false;
    const prune = retention.pruneBatch(3000, 1).finally(() => {
      pruneSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(pruneSettled).toBe(false);

    releaseBuild();
    expect((await page).map((ref) => ref.fileName)).toEqual([fileName]);
    await expect(prune).resolves.toEqual({ deleted: 1, hasMore: true });
    expect(await reader.listPage({ limit: 10 })).toEqual([]);
  });

  test("loadAsync removes a stale ref after the file disappears", async () => {
    store.save(transcript({ runId: "run_stale", finishedAt: 1000 }));
    const [ref] = await store.listPage({ limit: 10 });
    rmSync(join(dir, "transcripts", ref!.fileName), { force: true });

    await expect(store.loadAsync(ref!.fileName)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.listPage({ limit: 10 })).toEqual([]);
  });

  test("startup reconciles interrupted atomic saves without trusting partial temp files", async () => {
    store.save(transcript({ runId: "run_saved", finishedAt: 1000 }));
    const [saved] = await store.listPage({ limit: 10 });
    const transcriptsDir = join(dir, "transcripts");
    const indexPath = join(transcriptsDir, ".transcript-index.sqlite");
    const index = new Sqlite(indexPath);
    index
      .prepare("UPDATE transcript_refs SET state = 'pending_save' WHERE file_name = ?")
      .run(saved!.fileName);
    index.close();

    // Crash after atomic rename but before the state commit: the complete final
    // file is authoritative and the next façade promotes the ref.
    const recovered = trackedStore(transcriptsDir);
    expect((await recovered.listPage({ limit: 10 })).map((ref) => ref.fileName)).toEqual([
      saved!.fileName,
    ]);

    // Crash before rename: only the private temp exists. It is never listed,
    // and startup removes both the pending ref and orphan temp.
    const reopened = new Sqlite(indexPath);
    reopened
      .prepare("UPDATE transcript_refs SET state = 'pending_save' WHERE file_name = ?")
      .run(saved!.fileName);
    await reopened.close();
    rmSync(join(transcriptsDir, saved!.fileName));
    writeFileSync(join(transcriptsDir, `${saved!.fileName}.pending`), '{"partial":', "utf8");
    const cleaned = trackedStore(transcriptsDir);
    expect(await cleaned.listPage({ limit: 10 })).toEqual([]);
    expect(readdirSync(transcriptsDir)).not.toContain(`${saved!.fileName}.pending`);
  });

  test("startup resolves interrupted deletes from filesystem truth", async () => {
    store.save(transcript({ runId: "run_delete", finishedAt: 1000 }));
    const [saved] = await store.listPage({ limit: 10 });
    const transcriptsDir = join(dir, "transcripts");
    const indexPath = join(transcriptsDir, ".transcript-index.sqlite");

    const beforeUnlink = new Sqlite(indexPath);
    beforeUnlink
      .prepare("UPDATE transcript_refs SET state = 'deleting' WHERE file_name = ?")
      .run(saved!.fileName);
    beforeUnlink.close();
    const restored = trackedStore(transcriptsDir);
    expect(await restored.listPage({ limit: 10 })).toHaveLength(1);

    const afterUnlink = new Sqlite(indexPath);
    afterUnlink
      .prepare("UPDATE transcript_refs SET state = 'deleting' WHERE file_name = ?")
      .run(saved!.fileName);
    afterUnlink.close();
    rmSync(join(transcriptsDir, saved!.fileName));
    const removed = trackedStore(transcriptsDir);
    expect(await removed.listPage({ limit: 10 })).toEqual([]);
  });

  test("startup settles every interrupted transition and leaves everything else as it was", async () => {
    const transcriptsDir = join(dir, "transcripts");
    for (let i = 0; i < 20; i += 1) {
      store.save(transcript({ runId: `run_kept_${i}`, finishedAt: 10_000 + i }));
    }
    const index = new Sqlite(join(transcriptsDir, ".transcript-index.sqlite"));
    const insert = index.prepare(
      `INSERT INTO transcript_refs (file_name, run_id, attempt, finished_at, state)
       VALUES (?, ?, 1, ?, ?)`,
    );
    const interrupted = (
      finishedAt: number,
      runId: string,
      state: string,
      files: { final?: boolean; temp?: boolean },
    ): string => {
      const fileName = `${finishedAt}-${runId}-a1.json`;
      insert.run(fileName, runId, finishedAt, state);
      if (files.final) {
        writeFileSync(join(transcriptsDir, fileName), JSON.stringify(transcript({ runId })));
      }
      if (files.temp) writeFileSync(join(transcriptsDir, `${fileName}.pending`), '{"partial":');
      return fileName;
    };
    // A save interrupted after its rename, before it, and with neither file.
    const renamed = interrupted(1, "run_renamed", "pending_save", { final: true });
    const beforeRename = interrupted(2, "run_before_rename", "pending_save", { temp: true });
    interrupted(3, "run_no_files", "pending_save", {});
    const bothFiles = interrupted(4, "run_both_files", "pending_save", { final: true, temp: true });
    // A delete interrupted before and after its unlink.
    const notUnlinked = interrupted(5, "run_not_unlinked", "deleting", { final: true });
    interrupted(6, "run_unlinked", "deleting", {});
    // States this build never writes, either side of `committed` in sort
    // order, as a newer build could leave them before a rollback.
    const newerKept = interrupted(7, "run_newer_kept", "superseded", { final: true });
    interrupted(8, "run_newer_gone", "superseded", {});
    interrupted(9, "run_sorts_first", "archived", {});
    // A committed ref whose file is gone is not startup's business: the
    // reader that meets the missing file removes it.
    const committedGone = interrupted(10, "run_committed_gone", "committed", {});
    index.close();
    const orphanTemp = "11-run_orphan-a1.json.pending";
    writeFileSync(join(transcriptsDir, orphanTemp), "{");

    const reopened = trackedStore(transcriptsDir);
    try {
      const after = new Sqlite(join(transcriptsDir, ".transcript-index.sqlite"), {
        readonly: true,
      });
      const rows = after
        .prepare<[], { file_name: string; state: string }>(
          "SELECT file_name, state FROM transcript_refs WHERE finished_at < 10000 ORDER BY file_name",
        )
        .all();
      const keptCommitted = after
        .prepare<[], { count: number }>(
          "SELECT COUNT(*) AS count FROM transcript_refs WHERE finished_at >= 10000 AND state = 'committed'",
        )
        .get()?.count;
      after.close();
      expect(rows).toEqual(
        [renamed, bothFiles, notUnlinked, newerKept, committedGone].sort().map((file_name) => ({
          file_name,
          state: "committed",
        })),
      );
      expect(keptCommitted).toBe(20);
      const files = readdirSync(transcriptsDir);
      expect(files.filter((name) => name.endsWith(".pending"))).toEqual([orphanTemp]);
      expect(files).not.toContain(beforeRename);
    } finally {
      await reopened.close();
    }
  });

  test("opening the store reads only the refs a crash left unsettled", async () => {
    // Every store façade settles interrupted transitions while it is built,
    // which is on the gateway's boot path. A statement that scans the ref table
    // there costs time in proportion to the whole archive, all of it on the
    // main thread before the gateway serves anyone.
    store.save(transcript({ runId: "run_committed" }));
    const statements: string[] = [];
    const real = Sqlite.prototype.prepare;
    const spy = vi.spyOn(Sqlite.prototype, "prepare").mockImplementation(function (
      this: Sqlite.Database,
      source: string,
    ) {
      statements.push(source);
      return real.call(this, source);
    });
    let reopened: FsCognitionTranscriptStore | undefined;
    try {
      reopened = trackedStore(join(dir, "transcripts"));
    } finally {
      spy.mockRestore();
    }
    await reopened.close();

    const touchingRefs = statements.filter((source) => /\btranscript_refs\b/.test(source));
    expect(touchingRefs.length).toBeGreaterThan(0);
    const index = new Sqlite(join(dir, "transcripts", ".transcript-index.sqlite"), {
      readonly: true,
    });
    try {
      for (const source of touchingRefs) {
        const parameters = (source.match(/\?/g) ?? []).map(() => null);
        const plan = index
          .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${source}`)
          .all(...parameters)
          .map((step) => step.detail);
        expect(plan.filter((detail) => /^SCAN transcript_refs\b/.test(detail))).toEqual([]);
      }
    } finally {
      index.close();
    }
  });

  test("run ids are sanitized into safe file names but preserved in the payload", () => {
    store.save(transcript({ runId: "run/../weird id" }));
    const refs = store.list();
    expect(refs).toHaveLength(1);
    expect(refs[0]!.fileName).not.toContain("/");
    expect(store.load(refs[0]!.fileName).runId).toBe("run/../weird id");
  });

  test("the optional payload round-trips (and its absence stays absent)", () => {
    store.save(transcript({ payload: { docId: "doc_a", event: "created", datumAt: 1 } }));
    store.save(transcript({ runId: "run_2", finishedAt: 3000 }));
    const [withPayload, without] = store.list();
    expect(store.load(withPayload!.fileName).payload).toEqual({
      docId: "doc_a",
      event: "created",
      datumAt: 1,
    });
    expect(store.load(without!.fileName).payload).toBeUndefined();
  });

  test("load refuses names outside the store's naming pattern (path traversal)", () => {
    writeFileSync(join(dir, "outside.json"), JSON.stringify({ secret: true }), "utf8");
    expect(() => store.load("../outside.json")).toThrow(/not a transcript file name/);
    expect(() => store.load("1-../../outside-a1.json")).toThrow(/not a transcript file name/);
  });

  test("cognitionTranscriptsDir pins the canonical path under a config dir", () => {
    expect(cognitionTranscriptsDir("/cfg")).toBe(join("/cfg", "briefs", "transcripts"));
  });
});

describe("evicting one run's transcripts", () => {
  let dir: string;
  let store: FsCognitionTranscriptStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-transcripts-evict-"));
    store = trackedStore(join(dir, "transcripts"));
  });
  afterEach(async () => {
    await closeStores();
    rmSync(dir, { recursive: true, force: true });
  });

  test("deletes every attempt of the named runs and leaves the others", async () => {
    // Targeted rather than age-based: this is for a run whose history was
    // retired deliberately, which the retention sweep has no way to express.
    store.save(transcript({ runId: "run_doomed", attempt: 1, finishedAt: 1000 }));
    store.save(transcript({ runId: "run_doomed", attempt: 2, finishedAt: 2000 }));
    store.save(transcript({ runId: "run_kept", finishedAt: 3000 }));

    expect(await store.evictRuns(["run_doomed"])).toBe(2);

    expect(store.list().map((ref) => ref.runId)).toEqual(["run_kept"]);
    // The ref index is the second store, and it must agree with the directory:
    // a file unlinked behind its back leaves a ref that resolves to ENOENT and
    // shows as a phantom attempt until something touches it.
    expect((await store.listPage({ limit: 10 })).map((ref) => ref.runId)).toEqual(["run_kept"]);
    expect(await store.listForRun("run_doomed")).toEqual([]);
  });

  test("is idempotent, so a retried eviction is not an error", async () => {
    store.save(transcript({ runId: "run_doomed" }));

    expect(await store.evictRuns(["run_doomed"])).toBe(1);
    expect(await store.evictRuns(["run_doomed"])).toBe(0);
  });

  test("finds files an upgraded archive's index has never seen", async () => {
    // An archive from before the ref index existed holds files no row points
    // at. A lookup that trusted the index would report a clean eviction over
    // files still sitting on disk.
    const transcriptsDir = join(dir, "transcripts");
    mkdirSync(transcriptsDir, { recursive: true });
    writeFileSync(
      join(transcriptsDir, "5000-run_legacy-a1.json"),
      JSON.stringify(transcript({ runId: "run_legacy", finishedAt: 5000 })),
      "utf8",
    );
    const fresh = trackedStore(transcriptsDir);

    expect(await fresh.evictRuns(["run_legacy"])).toBe(1);
    expect(readdirSync(transcriptsDir).filter((n) => n.endsWith(".json"))).toEqual([]);
  });

  test("asks the filesystem for nothing when the list is empty", async () => {
    store.save(transcript({ runId: "run_kept" }));
    expect(await store.evictRuns([])).toBe(0);
    expect(store.list()).toHaveLength(1);
  });
});
