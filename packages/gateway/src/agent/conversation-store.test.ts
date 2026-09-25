// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FsConversationStore, deriveTitle, type ConversationRecord } from "./conversation-store.js";
import { originUsesAnchoredThreadProfile } from "./conversation-retention.js";

import type { ChatMessage } from "@omnesis/agent";

describe("anchored-thread retention classification", () => {
  it("reserves the non-expiring profile for brief threads only", () => {
    expect(originUsesAnchoredThreadProfile({ kind: "brief" })).toBe(true);
    expect(originUsesAnchoredThreadProfile({ kind: "temporal_annotation" })).toBe(false);
    expect(originUsesAnchoredThreadProfile({ kind: "time_index_entry" })).toBe(false);
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

  it("retention discovery is bounded and excludes fresh, pinned, and anchored records", async () => {
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
        id: "anchored",
        updatedAt: "2026-01-01T00:00:00.000Z",
        origin: { kind: "brief", briefId: "brief_example", runId: "run_example" },
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

  it("retention deletion journals an O(1) index tombstone and list remains accurate", async () => {
    const s = fresh();
    await s.save(rec({ id: "old" }));
    await s.save(rec({ id: "keep", updatedAt: "2026-02-01T00:00:00.000Z" }));
    expect(await s.deleteForRetention("old")).toBe(true);
    expect((await s.list()).map((summary) => summary.id)).toEqual(["keep"]);
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
    kind: "brief",
    briefId: "brief_1",
    runId: "run_1",
    brief: {
      title: "Return the borrowed projector",
      description: "The projector goes back to the AV desk this week.",
      body: "Borrowed for the demo on 2026-07-02; the AV desk closes at 17:00.",
    },
    seedMessageCount: 2,
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
      title: "Return the borrowed projector",
      pinned: false,
      origin,
      messages: [{ role: "user", parts: [{ kind: "text", text: "ctx" }] }],
    });
    expect((await s.load("s_thread"))!.origin).toEqual(origin);
    // Summaries carry ONLY the anchor — never the embedded brief
    // snapshot (its long-form body would otherwise ship in every list
    // row and be re-persisted on every index rewrite).
    const anchor = { kind: "brief", briefId: "brief_1", runId: "run_1" };
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
    raw.origin = { kind: "unknown-kind", briefId: 42 };
    await writeFile(join(dir, "s_bad.json"), JSON.stringify(raw), "utf8");
    const loaded = await s.load("s_bad");
    expect(loaded!.origin).toBeUndefined();
  });

  it("malformed snapshot extras are dropped while the anchor survives", async () => {
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
      origin: { kind: "brief", briefId: "brief_1", runId: "run_1" },
      messages: [{ role: "user", parts: [{ kind: "text", text: "x" }] }],
    });
    const raw = JSON.parse(await readFile(join(dir, "s_partial.json"), "utf8")) as Record<
      string,
      unknown
    >;
    // A snapshot missing its required strings and a negative seed count
    // must both read as absent — not poison the whole origin.
    raw.origin = {
      kind: "brief",
      briefId: "brief_1",
      runId: "run_1",
      brief: { title: 42 },
      seedMessageCount: -3,
    };
    await writeFile(join(dir, "s_partial.json"), JSON.stringify(raw), "utf8");
    const loaded = await s.load("s_partial");
    expect(loaded!.origin).toEqual({ kind: "brief", briefId: "brief_1", runId: "run_1" });
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
