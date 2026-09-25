// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Sqlite from "better-sqlite3";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  FsCognitionTranscriptStore,
  cognitionTranscriptsDir,
  type CognitionRunTranscript,
} from "./transcripts.js";

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

describe("FsCognitionTranscriptStore", () => {
  let dir: string;
  let store: FsCognitionTranscriptStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-transcripts-"));
    store = new FsCognitionTranscriptStore(join(dir, "transcripts"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
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
        .prepare<
          [],
          { value: string }
        >("SELECT value FROM transcript_index_meta WHERE key = 'scan-complete'")
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
        .prepare<
          [],
          { value: string }
        >("SELECT value FROM transcript_index_meta WHERE key = 'scan-complete'")
        .get()?.value,
    ).toBe("1");
    completedIndex.close();
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

    const reader = new FsCognitionTranscriptStore(transcriptsDir);
    const retention = new FsCognitionTranscriptStore(transcriptsDir);
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
    const recovered = new FsCognitionTranscriptStore(transcriptsDir);
    expect((await recovered.listPage({ limit: 10 })).map((ref) => ref.fileName)).toEqual([
      saved!.fileName,
    ]);

    // Crash before rename: only the private temp exists. It is never listed,
    // and startup removes both the pending ref and orphan temp.
    const reopened = new Sqlite(indexPath);
    reopened
      .prepare("UPDATE transcript_refs SET state = 'pending_save' WHERE file_name = ?")
      .run(saved!.fileName);
    reopened.close();
    rmSync(join(transcriptsDir, saved!.fileName));
    writeFileSync(join(transcriptsDir, `${saved!.fileName}.pending`), '{"partial":', "utf8");
    const cleaned = new FsCognitionTranscriptStore(transcriptsDir);
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
    const restored = new FsCognitionTranscriptStore(transcriptsDir);
    expect(await restored.listPage({ limit: 10 })).toHaveLength(1);

    const afterUnlink = new Sqlite(indexPath);
    afterUnlink
      .prepare("UPDATE transcript_refs SET state = 'deleting' WHERE file_name = ?")
      .run(saved!.fileName);
    afterUnlink.close();
    rmSync(join(transcriptsDir, saved!.fileName));
    const removed = new FsCognitionTranscriptStore(transcriptsDir);
    expect(await removed.listPage({ limit: 10 })).toEqual([]);
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
    store = new FsCognitionTranscriptStore(join(dir, "transcripts"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
    const fresh = new FsCognitionTranscriptStore(transcriptsDir);

    expect(await fresh.evictRuns(["run_legacy"])).toBe(1);
    expect(readdirSync(transcriptsDir).filter((n) => n.endsWith(".json"))).toEqual([]);
  });

  test("asks the filesystem for nothing when the list is empty", async () => {
    store.save(transcript({ runId: "run_kept" }));
    expect(await store.evictRuns([])).toBe(0);
    expect(store.list()).toHaveLength(1);
  });
});
