// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { copyFile, readFile, readdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FsConversationStore, deriveTitle, type ConversationRecord } from "./conversation-store.js";
import { originIsPermanent } from "./conversation-retention.js";
import { paginateVisibleConversationMessages } from "./service.js";

import type { ChatMessage } from "@omnesis/agent";

describe("permanent-origin retention classification", () => {
  it("keeps only the Morning brief conversation out of retention", () => {
    expect(originIsPermanent({ kind: "daily_brief", runId: "run_1", briefs: [] })).toBe(true);
    expect(originIsPermanent({ kind: "watch_firing", firingId: "f", runId: "r" })).toBe(false);
    expect(originIsPermanent({ kind: "brief", runId: "run_1" })).toBe(false);
    expect(originIsPermanent(null)).toBe(false);
    expect(originIsPermanent(["daily_brief"])).toBe(false);
  });
});

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), `omnesis-conv-${process.pid}-`));
}

describe("FsConversationStore", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs)
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    dirs = [];
  });

  function fresh(): FsConversationStore {
    const d = tmpDir();
    dirs.push(d);
    return new FsConversationStore(join(d, "conversations"));
  }

  function rec(over: Partial<ConversationRecord> = {}): ConversationRecord {
    return {
      id: "s_one",
      callerId: "token:A",
      model: "test-model",
      backend: "test",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:05.000Z",
      title: "first turn",
      pinned: false,
      messages: [
        { role: "user", parts: [{ kind: "text", text: "first turn" }] },
        { role: "assistant", parts: [{ kind: "text", text: "hi" }] },
      ],
      ...over,
    };
  }

  it("save then load round-trips a record", async () => {
    const s = fresh();
    await s.save(rec());
    const out = await s.load("s_one");
    expect(out).toBeTruthy();
    expect(out!.id).toBe("s_one");
    expect(out!.messages.length).toBe(2);
  });

  it("round-trips opaque reasoning blocks attached to a tool-use history part", async () => {
    const s = fresh();
    const details = [
      { type: "reasoning.text", text: "example trace", signature: "example-signature" },
      { type: "reasoning.encrypted", data: "example-opaque-data" },
    ];
    await s.save(
      rec({
        messages: [
          { role: "user", parts: [{ kind: "text", text: "look up example" }] },
          {
            role: "assistant",
            parts: [
              {
                kind: "tool_use",
                toolCallId: "tool-example",
                tool: "lookup",
                args: {},
                reasoningDetails: details,
              },
            ],
          },
        ],
      }),
    );
    const loaded = await s.load("s_one");
    const part = loaded?.messages[1]?.parts[0];
    expect(part?.kind === "tool_use" && part.reasoningDetails).toEqual(details);
  });

  it("round-trips a valid terminal context failure outside transcript history", async () => {
    const s = fresh();
    const terminalFailure = {
      code: "context_window_exceeded",
      message:
        "This conversation no longer fits in the selected model's context window. Start a new conversation to continue.",
      retryable: false,
      backend: "openai-compatible",
      model: "fictional-model",
      failedAt: "2026-07-29T12:00:00.000Z",
      context: {
        inputTokens: 130_000,
        contextWindowTokens: 128_000,
        measurement: "provider_reported" as const,
        limitSource: "provider" as const,
        requestIteration: 1,
      },
    };
    await s.save(rec({ terminalFailure }));

    const out = await s.load("s_one");
    expect(out?.terminalFailure).toEqual(terminalFailure);
    expect(out?.messages).toHaveLength(2);
  });

  it("round-trips a valid output-truncation marker outside transcript history", async () => {
    const s = fresh();
    const lastTurnFailure = {
      code: "output_truncated",
      message: "The model reached its output limit before completing this response.",
      retryable: false,
      backend: "openai-compatible",
      model: "fictional-model",
    };
    await s.save(rec({ lastTurnFailure }));

    const out = await s.load("s_one");
    expect(out?.lastTurnFailure).toEqual(lastTurnFailure);
    expect(out?.messages).toHaveLength(2);
  });

  it("round-trips a provider rejection so a reopened turn keeps its disposition", async () => {
    const s = fresh();
    const lastTurnFailure = {
      code: "http_api_error",
      message: "The model provider does not have the assigned model (HTTP 404).",
      retryable: true,
      backend: "openai-compatible",
      model: "fictional-model",
      provider: { status: 404, code: "NOT_FOUND", param: "model" },
    };
    await s.save(rec({ lastTurnFailure }));

    // Reading this back is what lets a reopened conversation render the same
    // styled failure the live stream rendered, rather than the marker the
    // session leaves in model-visible history.
    const out = await s.load("s_one");
    expect(out?.lastTurnFailure).toEqual(lastTurnFailure);
  });

  it("drops a lastTurnFailure that does not parse", async () => {
    const s = fresh();
    await s.save(rec({ lastTurnFailure: { code: "http_api_error" } as never }));
    expect((await s.load("s_one"))?.lastTurnFailure).toBeUndefined();
  });

  it("list returns every conversation regardless of callerId", async () => {
    const s = fresh();
    await s.save(rec({ id: "s_a", callerId: "token:A" }));
    await s.save(rec({ id: "s_b", callerId: "token:B" }));
    const list = await s.list();
    expect(list.map((c) => c.id).sort()).toEqual(["s_a", "s_b"]);
  });

  it("list sorts by updatedAt desc", async () => {
    const s = fresh();
    await s.save(rec({ id: "old", updatedAt: "2026-01-01T00:00:00.000Z" }));
    await s.save(rec({ id: "new", updatedAt: "2026-02-01T00:00:00.000Z" }));
    const list = await s.list();
    expect(list.map((c) => c.id)).toEqual(["new", "old"]);
  });

  it("list uses the summary index instead of reparsing saved transcripts", async () => {
    const d = tmpDir();
    dirs.push(d);
    const s = new FsConversationStore(join(d, "conversations"));
    await s.save(rec({ id: "indexed", title: "indexed title" }));

    const list = await s.list();
    expect(list).toEqual([
      {
        id: "indexed",
        title: "indexed title",
        model: "test-model",
        backend: "test",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:05.000Z",
        messageCount: 2,
        pinned: false,
      },
    ]);
  });

  it("rebuilds the summary index when transcript content changes but mtime is preserved", async () => {
    const d = tmpDir();
    dirs.push(d);
    const s = new FsConversationStore(join(d, "conversations"));
    await s.save(rec({ id: "indexed", title: "indexed title" }));
    const transcriptPath = join(d, "conversations", "indexed.json");
    const transcriptStat = await stat(transcriptPath);
    await writeFile(
      transcriptPath,
      JSON.stringify(
        rec({
          id: "indexed",
          title: "changed title",
          updatedAt: "2026-01-01T00:00:10.000Z",
          messages: [
            { role: "user", parts: [{ kind: "text", text: "changed title" }] },
            { role: "assistant", parts: [{ kind: "text", text: "hi" }] },
            { role: "user", parts: [{ kind: "text", text: "second turn" }] },
          ],
        }),
      ),
      "utf8",
    );
    const originalTranscriptMtime = new Date(transcriptStat.mtimeMs);
    await utimes(transcriptPath, originalTranscriptMtime, originalTranscriptMtime);

    const list = await s.list();
    expect(list).toEqual([
      expect.objectContaining({
        id: "indexed",
        title: "changed title",
        updatedAt: "2026-01-01T00:00:10.000Z",
        messageCount: 3,
      }),
    ]);
  });

  it("rebuilds the summary index when a transcript is newer than the sidecar", async () => {
    const d = tmpDir();
    dirs.push(d);
    const s = new FsConversationStore(join(d, "conversations"));
    await s.save(rec({ id: "indexed", title: "old title", updatedAt: "2026-01-01T00:00:05.000Z" }));
    const transcriptPath = join(d, "conversations", "indexed.json");
    const originalTranscriptStat = await stat(transcriptPath);
    await writeFile(
      transcriptPath,
      JSON.stringify(
        rec({
          id: "indexed",
          title: "new title",
          updatedAt: "2026-01-01T00:00:10.000Z",
          messages: [
            { role: "user", parts: [{ kind: "text", text: "new title" }] },
            { role: "assistant", parts: [{ kind: "text", text: "hi" }] },
            { role: "user", parts: [{ kind: "text", text: "second turn" }] },
          ],
        }),
      ),
      "utf8",
    );
    const newerTranscriptMtime = new Date(originalTranscriptStat.mtimeMs + 5_000);
    await utimes(transcriptPath, newerTranscriptMtime, newerTranscriptMtime);

    const list = await s.list();
    expect(list).toEqual([
      expect.objectContaining({
        id: "indexed",
        title: "new title",
        updatedAt: "2026-01-01T00:00:10.000Z",
        messageCount: 3,
      }),
    ]);
  });

  it("keeps a retired anchored thread's seed hidden from its readers", async () => {
    const d = tmpDir();
    dirs.push(d);
    mkdirSync(join(d, "conversations"), { recursive: true });
    const seed: ChatMessage[] = [
      { role: "user", parts: [{ kind: "text", text: "Background run prompt" }] },
      { role: "assistant", parts: [{ kind: "text", text: "Background run notes" }] },
    ];
    await writeFile(
      join(d, "conversations", "retired.json"),
      JSON.stringify({
        ...rec({ id: "retired" }),
        origin: { kind: "brief", runId: "run_1", seedMessageCount: seed.length },
        messages: [...seed, { role: "user", parts: [{ kind: "text", text: "A reply" }] }],
      }),
      "utf8",
    );
    const loaded = await new FsConversationStore(join(d, "conversations")).load("retired");
    expect(loaded?.originUnrecognized).toBe(true);
    expect(loaded?.unrecognizedSeedMessageCount).toBe(2);
    const page = paginateVisibleConversationMessages(
      loaded!.messages,
      loaded!.origin,
      50,
      undefined,
      loaded!.unrecognizedSeedMessageCount,
    );
    expect(page.messageCount).toBe(1);
    expect(JSON.stringify(page.messages)).not.toContain("Background run");
  });

  it("rebuilds the summary index when a transcript is missing from it", async () => {
    const d = tmpDir();
    dirs.push(d);
    const s = new FsConversationStore(join(d, "conversations"));
    await s.save(rec({ id: "indexed" }));
    await writeFile(
      join(d, "conversations", "manual.json"),
      JSON.stringify(rec({ id: "manual" })),
      "utf8",
    );

    const list = await s.list();
    expect(list.map((c) => c.id).sort()).toEqual(["indexed", "manual"]);
  });

  it("delete removes the record regardless of original callerId", async () => {
    const s = fresh();
    await s.save(rec({ callerId: "token:A" }));
    expect(await s.delete("s_one")).toBe(true);
    expect(await s.load("s_one")).toBeNull();
  });

  it("retention discovery is bounded and excludes fresh, pinned, and Morning brief records", async () => {
    const s = fresh();
    await s.save(rec({ id: "old", updatedAt: "2026-01-01T00:00:00.000Z" }));
    await s.save(
      rec({
        id: "watch-firing",
        updatedAt: "2026-01-01T00:00:00.000Z",
        origin: { kind: "watch_firing", firingId: "firing_example", runId: "run_watch" },
      }),
    );
    await s.save(rec({ id: "fresh", updatedAt: "2026-03-01T00:00:00.000Z" }));
    await s.save(rec({ id: "pinned", updatedAt: "2026-01-01T00:00:00.000Z", pinned: true }));
    await s.save(
      rec({
        id: "morning-brief",
        updatedAt: "2026-01-01T00:00:00.000Z",
        origin: { kind: "daily_brief", runId: "run_example", briefs: [] },
      }),
    );
    const page = await s.listRetentionCandidates(Date.parse("2026-02-01T00:00:00.000Z"), 10);
    expect(page.items.map((summary) => summary.id).sort()).toEqual(["old", "watch-firing"]);
    expect(page.hasMore).toBe(false);
  });

  it("rejects a candidate after a same-size in-place rewrite", async () => {
    const root = tmpDir();
    dirs.push(root);
    const conversationDir = join(root, "conversations");
    const s = new FsConversationStore(conversationDir);
    await s.save(rec({ id: "rewritten", updatedAt: "2026-01-01T00:00:00.000Z" }));
    const page = await s.listRetentionCandidates(Date.parse("2026-02-01T00:00:00.000Z"), 1);
    const candidate = page.items[0]!;
    const path = join(conversationDir, "rewritten.json");
    const before = await readFile(path, "utf8");
    const after = before.replace("2026-01-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z");
    expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
    await writeFile(path, after, "utf8");

    expect(
      await s.retentionCandidateIsCurrent(candidate, Date.parse("2026-02-01T00:00:00.000Z")),
    ).toBe(false);
  });

  it("revalidates eligibility against the current retention cutoff", async () => {
    const s = fresh();
    await s.save(rec({ id: "cutoff-changed", updatedAt: "2026-01-01T00:00:00.000Z" }));
    const page = await s.listRetentionCandidates(Date.parse("2026-02-01T00:00:00.000Z"), 1);
    expect(
      await s.retentionCandidateIsCurrent(page.items[0]!, Date.parse("2025-12-01T00:00:00.000Z")),
    ).toBe(false);
  });

  it("retention deletion leaves the list accurate without rewriting the index", async () => {
    const s = fresh();
    await s.save(rec({ id: "old" }));
    await s.save(rec({ id: "keep", updatedAt: "2026-02-01T00:00:00.000Z" }));
    const dir = (s as unknown as { dir: string }).dir;
    const indexBefore = await readFile(join(dir, ".summary-index.v4"), "utf8");
    expect(await s.deleteForRetention("old")).toBe(true);
    expect(await readFile(join(dir, ".summary-index.v4"), "utf8")).toBe(indexBefore);
    expect((await s.list()).map((summary) => summary.id)).toEqual(["keep"]);
    // A restart reads the index that still names the deleted conversation
    // and drops it because its file is gone, reading no transcript.
    const restarted = new FsConversationStore(dir);
    const reads = spyIndexReads(restarted);
    expect((await restarted.list()).map((summary) => summary.id)).toEqual(["keep"]);
    expect(reads).toEqual([]);
  });

  it("load returns null for an unknown id", async () => {
    const s = fresh();
    expect(await s.load("s_missing")).toBeNull();
  });

  it("refuses ids that would escape the directory", async () => {
    const s = fresh();
    expect(await s.load(`..${sep}etc${sep}passwd`)).toBeNull();
    expect(await s.load("../escape")).toBeNull();
    expect(await s.load("ok-id_123")).toBeNull(); // valid shape, just missing
  });

  it("setPinned toggles the flag without changing updatedAt", async () => {
    const s = fresh();
    await s.save(rec({ id: "s_pin", updatedAt: "2026-01-01T00:00:05.000Z" }));

    expect(await s.setPinned("s_pin", true)).toBe(true);
    const loaded = await s.load("s_pin");
    expect(loaded!.pinned).toBe(true);
    // Pinning is not a content edit — recency ordering must be preserved.
    expect(loaded!.updatedAt).toBe("2026-01-01T00:00:05.000Z");

    const summary = (await s.list()).find((c) => c.id === "s_pin");
    expect(summary!.pinned).toBe(true);

    expect(await s.setPinned("s_pin", false)).toBe(true);
    expect((await s.load("s_pin"))!.pinned).toBe(false);
  });

  it("setPinned returns false for an unknown id", async () => {
    const s = fresh();
    expect(await s.setPinned("s_missing", true)).toBe(false);
  });

  it("list sorts pinned conversations first, then by updatedAt desc", async () => {
    const s = fresh();
    await s.save(rec({ id: "old", updatedAt: "2026-01-01T00:00:00.000Z" }));
    await s.save(rec({ id: "newer", updatedAt: "2026-02-01T00:00:00.000Z" }));
    await s.save(rec({ id: "newest", updatedAt: "2026-03-01T00:00:00.000Z" }));
    // Pin the oldest — it must jump to the top despite being least recent.
    await s.setPinned("old", true);

    const list = await s.list();
    expect(list.map((c) => c.id)).toEqual(["old", "newest", "newer"]);
    expect(list[0].pinned).toBe(true);
  });

  it("treats a record saved without a pinned field as unpinned", async () => {
    const d = tmpDir();
    dirs.push(d);
    const s = new FsConversationStore(join(d, "conversations"));
    mkdirSync(join(d, "conversations"), { recursive: true });
    // Simulate a transcript written by a gateway predating the pin field.
    const legacy = rec({ id: "legacy" }) as Partial<ConversationRecord>;
    delete legacy.pinned;
    await writeFile(join(d, "conversations", "legacy.json"), JSON.stringify(legacy), "utf8");

    const loaded = await s.load("legacy");
    expect(loaded!.pinned).toBe(false);
    const summary = (await s.list()).find((c) => c.id === "legacy");
    expect(summary!.pinned).toBe(false);
  });
});

/**
 * Record every transcript the store reads to refresh its summary index, so a
 * test can assert which files a listing reread.
 */
function spyIndexReads(store: FsConversationStore): string[] {
  const reads: string[] = [];
  const target = store as unknown as { readForIndex(id: string): Promise<unknown> };
  const original = target.readForIndex.bind(target);
  vi.spyOn(target, "readForIndex").mockImplementation((id: string) => {
    reads.push(id);
    return original(id);
  });
  return reads;
}

describe("FsConversationStore summary index", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function dirFor(): string {
    const root = mkdtempSync(join(tmpdir(), "omnesis-conv-index-"));
    roots.push(root);
    return join(root, "conversations");
  }

  function record(id: string, over: Partial<ConversationRecord> = {}): ConversationRecord {
    return {
      id,
      callerId: "token:A",
      model: "test-model",
      backend: "test",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:05.000Z",
      title: `About ${id}`,
      pinned: false,
      messages: [
        { role: "user", parts: [{ kind: "text", text: `About ${id}` }] },
        { role: "assistant", parts: [{ kind: "text", text: "Sure." }] },
      ],
      ...over,
    };
  }

  /** The listing a store with no index computes by reading every file. */
  async function rebuiltList(dir: string) {
    const scratch = mkdtempSync(join(tmpdir(), "omnesis-conv-rebuilt-"));
    roots.push(scratch);
    for (const name of await readdir(dir)) {
      if (name.endsWith(".json")) await copyFile(join(dir, name), join(scratch, name));
    }
    return new FsConversationStore(scratch).list();
  }

  it("lists exactly what a full rebuild lists across every kind of change", async () => {
    const dir = dirFor();
    const s = new FsConversationStore(dir);
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["create", () => s.save(record("s_a", { updatedAt: "2026-01-02T00:00:00.000Z" }))],
      ["create another", () => s.save(record("s_b", { updatedAt: "2026-01-03T00:00:00.000Z" }))],
      [
        "create a Morning brief",
        () =>
          s.save(
            record("s_brief", {
              title: "Morning brief",
              pinned: true,
              origin: {
                kind: "daily_brief",
                runId: "run_1",
                briefs: [{ day: "2026-01-04", messageIndex: 1, messageId: "msg_1" }],
              },
            }),
          ),
      ],
      [
        "append a turn",
        () =>
          s.save(
            record("s_a", {
              updatedAt: "2026-01-05T00:00:00.000Z",
              messages: [
                ...record("s_a").messages,
                { role: "user", parts: [{ kind: "text", text: "And then?" }] },
              ],
            }),
          ),
      ],
      ["retitle", () => s.save(record("s_b", { title: "Quarterly budget review" }))],
      ["pin", () => s.setPinned("s_b", true)],
      ["unpin", () => s.setPinned("s_b", false)],
      ["delete", () => s.delete("s_a")],
      ["create after delete", () => s.save(record("s_c"))],
      ["retention delete", () => s.deleteForRetention("s_c")],
      [
        "hand-added file",
        () => writeFile(join(dir, "s_manual.json"), JSON.stringify(record("s_manual")), "utf8"),
      ],
      [
        "hand-edited file",
        () =>
          writeFile(
            join(dir, "s_b.json"),
            JSON.stringify(record("s_b", { title: "Edited by hand" })),
            "utf8",
          ),
      ],
      ["hand-removed file", () => unlink(join(dir, "s_manual.json"))],
      ["corrupt file", () => writeFile(join(dir, "s_broken.json"), "{not json", "utf8")],
    ];
    for (const [step, run] of steps) {
      await run();
      expect(await s.list(), step).toEqual(await rebuiltList(dir));
      // A restart over the persisted index lists the same.
      expect(await new FsConversationStore(dir).list(), step).toEqual(await rebuiltList(dir));
    }
    expect((await s.list()).map((c) => [c.id, c.title, c.pinned])).toEqual([
      ["s_brief", "Morning brief", true],
      ["s_b", "Edited by hand", false],
    ]);
  });

  it("keeps the index valid across its own writes, reading no transcript to list", async () => {
    const dir = dirFor();
    const s = new FsConversationStore(dir);
    for (let i = 0; i < 20; i++) await s.save(record(`s_${i}`));
    await s.list();
    const reads = spyIndexReads(s);

    await s.save(record("s_3", { updatedAt: "2026-02-01T00:00:00.000Z", title: "Updated" }));
    await s.save(record("s_new"));
    await s.setPinned("s_7", true);
    await s.delete("s_9");
    const listed = await s.list();

    expect(reads).toEqual([]);
    expect(listed.slice(0, 2).map((c) => [c.id, c.title])).toEqual([
      ["s_7", "About s_7"],
      ["s_3", "Updated"],
    ]);
    expect(listed).toHaveLength(20);
    // The persisted index is as current as the in-memory one.
    const restarted = new FsConversationStore(dir);
    const restartReads = spyIndexReads(restarted);
    expect(await restarted.list()).toEqual(listed);
    expect(restartReads).toEqual([]);
  });

  it("repairs a stale index by reading only the files that changed", async () => {
    const dir = dirFor();
    const s = new FsConversationStore(dir);
    for (let i = 0; i < 20; i++) await s.save(record(`s_${i}`));
    await s.list();

    // Changes this store did not make: one same-size rewrite, one new file,
    // one removed file.
    const same = await readFile(join(dir, "s_4.json"), "utf8");
    const edited = same.replace("About s_4", "Abuot s_4");
    expect(Buffer.byteLength(edited)).toBe(Buffer.byteLength(same));
    await writeFile(join(dir, "s_4.json"), edited, "utf8");
    await writeFile(join(dir, "s_extra.json"), JSON.stringify(record("s_extra")), "utf8");
    await unlink(join(dir, "s_11.json"));

    for (const store of [s, new FsConversationStore(dir)]) {
      const reads = spyIndexReads(store);
      const listed = await store.list();
      expect(reads.sort()).toEqual(store === s ? ["s_4", "s_extra"] : []);
      expect(listed).toEqual(await rebuiltList(dir));
      expect(listed.find((c) => c.id === "s_4")?.title).toBe("Abuot s_4");
      expect(listed.some((c) => c.id === "s_11")).toBe(false);
    }
  });

  it("reads a corrupt transcript once, not on every listing", async () => {
    const dir = dirFor();
    const s = new FsConversationStore(dir);
    await s.save(record("s_ok"));
    await writeFile(join(dir, "s_broken.json"), "{not json", "utf8");
    const reads = spyIndexReads(s);
    expect((await s.list()).map((c) => c.id)).toEqual(["s_ok"]);
    expect((await s.list()).map((c) => c.id)).toEqual(["s_ok"]);
    expect(reads).toEqual(["s_broken"]);
  });

  it("rereads a transcript replaced while the listing was reading it", async () => {
    const dir = dirFor();
    const s = new FsConversationStore(dir);
    await s.save(record("s_race"));
    await writeFile(
      join(dir, "s_race.json"),
      JSON.stringify(record("s_race", { title: "Second" })),
      "utf8",
    );
    const target = s as unknown as { readForIndex(id: string): Promise<unknown> };
    const original = target.readForIndex.bind(target);
    let replaced = false;
    const reads = vi.spyOn(target, "readForIndex").mockImplementation(async (id: string) => {
      // The file changes after the listing took its identity and before the
      // read, so the read sees content newer than the identity it records.
      if (!replaced) {
        replaced = true;
        await writeFile(
          join(dir, "s_race.json"),
          JSON.stringify(record("s_race", { title: "Third, a little longer" })),
          "utf8",
        );
      }
      return original(id);
    });

    expect((await s.list())[0]?.title).toBe("Third, a little longer");
    // The recorded identity predates the content, so the next listing does
    // not trust it and reads the file again.
    expect((await s.list())[0]?.title).toBe("Third, a little longer");
    expect(reads).toHaveBeenCalledTimes(2);
    expect((await s.list())[0]?.title).toBe("Third, a little longer");
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("stays consistent when saves and listings run concurrently", async () => {
    const dir = dirFor();
    const s = new FsConversationStore(dir);
    for (let i = 0; i < 10; i++) await s.save(record(`s_${i}`));
    await s.list();

    const work: Promise<unknown>[] = [];
    const observed: string[][] = [];
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 10; i++) {
        work.push(
          s.save(
            record(`s_${i}`, {
              updatedAt: new Date(Date.UTC(2026, 1, 1, round, i)).toISOString(),
              title: `Round ${round}`,
            }),
          ),
        );
      }
      work.push(s.save(record(`s_round_${round}`)));
      work.push(s.list().then((listed) => observed.push(listed.map((c) => c.id))));
    }
    await Promise.all(work);

    // Every listing saw every conversation that existed before it started.
    for (const ids of observed) {
      for (let i = 0; i < 10; i++) expect(ids).toContain(`s_${i}`);
    }
    const reads = spyIndexReads(s);
    const listed = await s.list();
    expect(reads).toEqual([]);
    expect(listed).toEqual(await rebuiltList(dir));
    expect(listed.filter((c) => c.title === "Round 4")).toHaveLength(10);
    expect(await new FsConversationStore(dir).list()).toEqual(listed);
  });

  it("serves a save to the very next listing", async () => {
    const dir = dirFor();
    const s = new FsConversationStore(dir);
    await s.save(record("s_one"));
    const [, listed] = await Promise.all([s.save(record("s_one", { title: "Renamed" })), s.list()]);
    expect(listed.map((c) => c.title)).toEqual(["Renamed"]);
  });

  it("replaces an index written by an earlier version and removes its files", async () => {
    const dir = dirFor();
    const s = new FsConversationStore(dir);
    await s.save(record("s_one"));
    // A previous format is never trusted, however it reads.
    await writeFile(
      join(dir, ".summary-index.v3"),
      JSON.stringify({ version: 3, conversations: [] }),
      "utf8",
    );
    await writeFile(join(dir, ".summary-index.deleted"), "s_one\n", "utf8");
    await writeFile(join(dir, ".summary-index.v4"), "{not json", "utf8");

    const restarted = new FsConversationStore(dir);
    const reads = spyIndexReads(restarted);
    expect((await restarted.list()).map((c) => c.id)).toEqual(["s_one"]);
    expect(reads).toEqual(["s_one"]);
    const names = await readdir(dir);
    expect(names).not.toContain(".summary-index.v3");
    expect(names).not.toContain(".summary-index.deleted");
    expect(JSON.parse(await readFile(join(dir, ".summary-index.v4"), "utf8")).version).toBe(4);
  });
});

describe("conversation origin", () => {
  const tempDirs2: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs2.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function fresh2(): FsConversationStore {
    const d = mkdtempSync(join(tmpdir(), "omnesis-convo-origin-test-"));
    tempDirs2.push(d);
    return new FsConversationStore(join(d, "conversations"));
  }
  const origin = {
    kind: "daily_brief",
    runId: "run_1",
    briefs: [
      { day: "2026-07-01", messageIndex: 0, messageId: "msg_brief_1" },
      {
        day: "2026-07-02",
        messageIndex: 2,
        messageId: "msg_brief_2",
        sentAt: "2026-07-02T06:02:40.055Z",
      },
    ],
  } as const;

  it("round-trips through save/load, the summary list, and the rebuilt index", async () => {
    const s = fresh2();
    await s.save({
      id: "s_thread",
      callerId: "token:A",
      model: "m",
      backend: "b",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:05.000Z",
      title: "Morning brief",
      pinned: false,
      origin: { ...origin, briefs: [...origin.briefs] },
      messages: [{ role: "user", parts: [{ kind: "text", text: "ctx" }] }],
    });
    expect((await s.load("s_thread"))!.origin).toEqual(origin);
    // Summaries carry ONLY the anchor — never the brief index, which
    // would otherwise ship in every list row and be re-persisted on every
    // index rewrite.
    const anchor = { kind: "daily_brief", runId: "run_1", briefs: [] };
    expect((await s.list()).find((c) => c.id === "s_thread")!.origin).toEqual(anchor);
    // A second store instance rebuilds the summary index from files —
    // the anchor must survive that path too.
    const rebuilt = new FsConversationStore((s as unknown as { dir: string }).dir);
    expect((await rebuilt.list()).find((c) => c.id === "s_thread")!.origin).toEqual(anchor);
  });

  it("a malformed origin reads as a plain conversation", async () => {
    const s = fresh2();
    const dir = (s as unknown as { dir: string }).dir;
    await s.save({
      id: "s_bad",
      callerId: "token:A",
      model: "m",
      backend: "b",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:05.000Z",
      title: "t",
      pinned: false,
      messages: [{ role: "user", parts: [{ kind: "text", text: "x" }] }],
    });
    const raw = JSON.parse(await readFile(join(dir, "s_bad.json"), "utf8")) as Record<
      string,
      unknown
    >;
    raw.origin = { kind: "unknown-kind", runId: 42 };
    await writeFile(join(dir, "s_bad.json"), JSON.stringify(raw), "utf8");
    const loaded = await s.load("s_bad");
    expect(loaded!.origin).toBeUndefined();
  });

  it("malformed brief references are dropped while the anchor survives", async () => {
    const s = fresh2();
    const dir = (s as unknown as { dir: string }).dir;
    await s.save({
      id: "s_partial",
      callerId: "token:A",
      model: "m",
      backend: "b",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:05.000Z",
      title: "t",
      pinned: false,
      origin: { kind: "daily_brief", runId: "run_1", briefs: [] },
      messages: [{ role: "user", parts: [{ kind: "text", text: "x" }] }],
    });
    const raw = JSON.parse(await readFile(join(dir, "s_partial.json"), "utf8")) as Record<
      string,
      unknown
    >;
    // Each malformed reference reads as absent — none poisons the origin.
    raw.origin = {
      kind: "daily_brief",
      runId: "run_1",
      briefs: [
        { day: "2026-07-01", messageIndex: 0, messageId: "msg_ok" },
        { day: "2026-07-02", messageIndex: -1, messageId: "msg_negative" },
        { day: 42, messageIndex: 1, messageId: "msg_bad_day" },
        { day: "2026-07-03", messageIndex: 1.5, messageId: "msg_fraction" },
        "not-a-ref",
        // A reference with a malformed send time keeps its place without one.
        { day: "2026-07-04", messageIndex: 2, messageId: "msg_bad_sent", sentAt: 7 },
      ],
    };
    await writeFile(join(dir, "s_partial.json"), JSON.stringify(raw), "utf8");
    const loaded = await s.load("s_partial");
    expect(loaded!.origin).toEqual({
      kind: "daily_brief",
      runId: "run_1",
      briefs: [
        { day: "2026-07-01", messageIndex: 0, messageId: "msg_ok" },
        { day: "2026-07-04", messageIndex: 2, messageId: "msg_bad_sent" },
      ],
    });
  });

  it("malformed watch-firing extras are dropped while the anchor survives", async () => {
    const s = fresh2();
    const dir = (s as unknown as { dir: string }).dir;
    await s.save({
      id: "s_watch",
      callerId: "token:A",
      model: "m",
      backend: "b",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:05.000Z",
      title: "t",
      pinned: false,
      messages: [{ role: "user", parts: [{ kind: "text", text: "x" }] }],
    });
    const raw = JSON.parse(await readFile(join(dir, "s_watch.json"), "utf8")) as Record<
      string,
      unknown
    >;
    // A snapshot missing its required strings and a negative seed count
    // must both read as absent — not poison the whole origin.
    raw.origin = {
      kind: "watch_firing",
      firingId: "firing_1",
      runId: "firing_1",
      watchId: "watch_1",
      watch: { name: 42 },
      seedMessageCount: -3,
    };
    await writeFile(join(dir, "s_watch.json"), JSON.stringify(raw), "utf8");
    const loaded = await s.load("s_watch");
    expect(loaded!.origin).toEqual({
      kind: "watch_firing",
      firingId: "firing_1",
      runId: "firing_1",
      watchId: "watch_1",
    });
  });
});

describe("task conversation origin", () => {
  const dirs3: string[] = [];
  afterEach(() => {
    for (const dir of dirs3.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function fresh3(): FsConversationStore {
    const d = mkdtempSync(join(tmpdir(), "omnesis-convo-task-origin-test-"));
    dirs3.push(d);
    return new FsConversationStore(join(d, "conversations"));
  }
  const base = {
    callerId: "token:A",
    model: "m",
    backend: "b",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:05.000Z",
    title: "Renew the studio lease",
    pinned: false,
    messages: [],
  };
  const origin = {
    kind: "task",
    taskId: "loop_lease",
    runId: "loop_lease",
    task: {
      title: "Renew the studio lease",
      state: "open",
      due: "2026-03-20",
      sourceCount: 3,
    },
    seedMessageCount: 0,
  } as const;

  async function loadRaw(s: FsConversationStore, id: string, rawOrigin: unknown) {
    const dir = (s as unknown as { dir: string }).dir;
    await s.save({ ...base, id });
    const raw = JSON.parse(await readFile(join(dir, `${id}.json`), "utf8")) as Record<
      string,
      unknown
    >;
    raw.origin = rawOrigin;
    await writeFile(join(dir, `${id}.json`), JSON.stringify(raw), "utf8");
    return s.load(id);
  }

  it("round-trips with its snapshot; list rows carry the anchor only", async () => {
    const s = fresh3();
    await s.save({ ...base, id: "s_task", origin: { ...origin, task: { ...origin.task } } });
    expect((await s.load("s_task"))!.origin).toEqual(origin);
    const anchor = { kind: "task", taskId: "loop_lease", runId: "loop_lease" };
    expect((await s.list()).find((c) => c.id === "s_task")!.origin).toEqual(anchor);
    const rebuilt = new FsConversationStore((s as unknown as { dir: string }).dir);
    expect((await rebuilt.list()).find((c) => c.id === "s_task")!.origin).toEqual(anchor);
  });

  it("a snapshot without its title or state is dropped while the anchor survives", async () => {
    const loaded = await loadRaw(fresh3(), "s_task_bad", {
      kind: "task",
      taskId: "loop_lease",
      runId: "loop_lease",
      task: { title: 42, state: "open" },
    });
    expect(loaded!.origin).toEqual({ kind: "task", taskId: "loop_lease", runId: "loop_lease" });
    expect(loaded!.originUnrecognized).toBeUndefined();
  });

  it("malformed optional snapshot fields read as absent", async () => {
    const loaded = await loadRaw(fresh3(), "s_task_partial", {
      ...origin,
      task: { title: "Renew the lease", state: "open", due: "next week", sourceCount: -1 },
    });
    expect(loaded!.origin).toEqual({
      ...origin,
      task: { title: "Renew the lease", state: "open", sourceCount: 0 },
    });
  });

  it("an origin without a task id is refused rather than run as a plain chat", async () => {
    const loaded = await loadRaw(fresh3(), "s_task_no_id", { kind: "task", runId: "loop_lease" });
    expect(loaded!.origin).toBeUndefined();
    expect(loaded!.originUnrecognized).toBe(true);
  });
});

describe("deriveTitle", () => {
  it("uses the first user text message, truncated", () => {
    const msgs: ChatMessage[] = [
      { role: "user", parts: [{ kind: "text", text: "how is my heart rate going?" }] },
    ];
    expect(deriveTitle(msgs)).toBe("how is my heart rate going?");
  });

  it("returns empty when there's no user text yet", () => {
    expect(deriveTitle([])).toBe("");
    expect(deriveTitle([{ role: "assistant", parts: [{ kind: "text", text: "hi" }] }])).toBe("");
  });

  it("truncates a long user message", () => {
    const long = "a".repeat(200);
    const msgs: ChatMessage[] = [{ role: "user", parts: [{ kind: "text", text: long }] }];
    const title = deriveTitle(msgs);
    expect(title.length).toBe(70);
    expect(title.endsWith("…")).toBe(true);
  });
});
