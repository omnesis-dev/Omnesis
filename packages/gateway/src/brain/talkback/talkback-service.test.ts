// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createLogger } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import {
  createBrief,
  getBrief,
  restampBriefThreadConversation,
  setBriefThreadConversation,
} from "../storage/briefs.js";
import { FsCognitionTranscriptStore } from "../transcripts.js";
import {
  createBriefTalkback,
  BriefNotFoundError,
  TalkbackUnavailableError,
  type TalkbackAgentPort,
} from "./talkback-service.js";
import type Database from "better-sqlite3";
import type { CreateAnchoredThreadInput } from "../../agent/service.js";

type Db = Database.Database;

const log = createLogger("test").child("talkback");
const NOW = Date.parse("2026-07-02T10:00:00.000Z");

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function seedBrief(db: Db, id: string, runId: string): void {
  createBrief(
    db,
    {
      id,
      createdByRun: runId,
      kind: "loop",
      title: "Return the borrowed projector",
      description: "You told Jamie you'd return it this week.",
      confidence: 0.8,
      urgency: 0.5,
    },
    NOW,
  );
}

describe("createBriefTalkback.openThread", () => {
  let path: string;
  let db: Db;
  let transcriptsDir: string;
  let transcripts: FsCognitionTranscriptStore;
  let created: Array<{ callerId: string; input: CreateAnchoredThreadInput }>;
  let deleted: string[];
  let agent: TalkbackAgentPort | null;

  let existingConversations: Set<string>;
  const fakeAgent = (): TalkbackAgentPort => ({
    // eslint-disable-next-line @typescript-eslint/require-await
    async createAnchoredThread(callerId, input) {
      created.push({ callerId, input });
      const id = `s_thread_${created.length}`;
      existingConversations.add(id);
      return id;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async deleteConversation(id) {
      deleted.push(id);
      existingConversations.delete(id);
      return true;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async conversationExists(id) {
      return existingConversations.has(id);
    },
  });

  const realWriteGate = () => ({
    // eslint-disable-next-line @typescript-eslint/require-await
    setBriefThreadConversation: async (id: string, conversationId: string, now: number) =>
      setBriefThreadConversation(db, id, conversationId, now),
    // eslint-disable-next-line @typescript-eslint/require-await
    restampBriefThreadConversation: async (
      id: string,
      deadId: string,
      conversationId: string,
      now: number,
    ) => restampBriefThreadConversation(db, id, deadId, conversationId, now),
  });

  const port = () =>
    createBriefTalkback({
      db,
      writeGate: realWriteGate(),
      transcripts,
      getAgentService: () => agent,
      clock: () => NOW,
      log,
    });

  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
    transcriptsDir = mkdtempSync(join(tmpdir(), "omnesis-talkback-test-"));
    transcripts = new FsCognitionTranscriptStore(transcriptsDir);
    created = [];
    deleted = [];
    existingConversations = new Set();
    agent = fakeAgent();
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
    rmSync(transcriptsDir, { recursive: true, force: true });
  });

  test("opens a thread seeded from the creating run's transcript and stamps the brief", async () => {
    seedBrief(db, "brief_1", "run_9");
    transcripts.save({
      runId: "run_9",
      attempt: 1,
      kind: "data",
      startedAt: NOW - 5000,
      finishedAt: NOW - 4000,
      prompt: "Loop agent run run_9 (kind: data, attempt 1).",
      events: [
        { type: "agent.text.delta", payload: { delta: "Tracking the projector loan." } },
        { type: "agent.message.end", payload: { stopReason: "end_turn" } },
      ],
      finalText: "Tracking the projector loan.",
      outcome: "completed",
      usage: null,
    });

    const out = await port().openThread("token:t1", "brief_1");
    expect(out.created).toBe(true);
    expect(out.conversationId).toBe("s_thread_1");
    expect(created).toHaveLength(1);
    expect(created[0]!.callerId).toBe("token:t1");
    expect(created[0]!.input.origin).toEqual({
      kind: "brief",
      briefId: "brief_1",
      runId: "run_9",
      // The brief's content rides along so the thread's origin snapshot can
      // outlive the brief row.
      brief: {
        title: "Return the borrowed projector",
        description: "You told Jamie you'd return it this week.",
        body: null,
      },
    });
    expect(created[0]!.input.title).toBe("Return the borrowed projector");
    // Seed = folded transcript: prompt + the assistant's words.
    expect(created[0]!.input.initialHistory).toEqual([
      {
        role: "user",
        parts: [{ kind: "text", text: "Loop agent run run_9 (kind: data, attempt 1)." }],
      },
      {
        role: "assistant",
        parts: [{ kind: "text", text: "Tracking the projector loan." }],
      },
    ]);
    expect(getBrief(db, "brief_1")!.threadConversationId).toBe("s_thread_1");
  });

  test("a user-final transcript seed is closed with an assistant message", async () => {
    seedBrief(db, "brief_1", "run_9");
    // The run died right after a tool call: the folded transcript ends on
    // a user-role tool_result and there is no closing prose.
    transcripts.save({
      runId: "run_9",
      attempt: 1,
      kind: "data",
      startedAt: NOW - 5000,
      finishedAt: NOW - 4000,
      prompt: "Loop agent run run_9 (kind: data, attempt 1).",
      events: [
        {
          type: "agent.tool.start",
          payload: { toolCallId: "tc1", tool: "brief_create", args: {} },
        },
        {
          type: "agent.tool.result",
          payload: {
            toolCallId: "tc1",
            result: { kind: "structured", resultType: "brief.created", data: {} },
          },
        },
      ],
      finalText: "",
      outcome: "failed",
      usage: null,
    });

    await port().openThread("token:t1", "brief_1");
    const seed = created[0]!.input.initialHistory;
    expect(seed.length).toBeGreaterThan(0);
    // Assistant-final, so the HTTP dangling-user-turn normalizer never
    // mints its error stub past the hidden seed prefix.
    expect(seed.at(-1)!.role).toBe("assistant");
  });

  test("a second open returns the same thread without touching the agent service", async () => {
    seedBrief(db, "brief_1", "run_9");
    const first = await port().openThread("token:t1", "brief_1");
    const second = await port().openThread("token:t2", "brief_1");
    expect(second).toEqual({ conversationId: first.conversationId, created: false });
    expect(created).toHaveLength(1);
  });

  test("a pruned transcript falls back to a brief-context seed", async () => {
    seedBrief(db, "brief_1", "run_gone");
    const out = await port().openThread("token:t1", "brief_1");
    expect(out.created).toBe(true);
    const history = created[0]!.input.initialHistory;
    expect(history).toHaveLength(2);
    const opening = history[0]!;
    expect(opening.role).toBe("user");
    const text = (opening.parts[0] as { kind: "text"; text: string }).text;
    expect(text).toContain("Return the borrowed projector");
    expect(text).toContain("no longer available");
  });

  test("losing the once-only stamp race converges on the winner and drops the orphan", async () => {
    seedBrief(db, "brief_1", "run_9");
    // Simulate the concurrent winner landing between our read and stamp.
    const racedPort = createBriefTalkback({
      db,
      writeGate: {
        ...realWriteGate(),
        // eslint-disable-next-line @typescript-eslint/require-await
        setBriefThreadConversation: async (id, conversationId, now) => {
          existingConversations.add("s_winner");
          setBriefThreadConversation(db, id, "s_winner", now);
          return setBriefThreadConversation(db, id, conversationId, now);
        },
      },
      transcripts,
      getAgentService: () => agent,
      clock: () => NOW,
      log,
    });
    const out = await racedPort.openThread("token:t1", "brief_1");
    expect(out).toEqual({ conversationId: "s_winner", created: false });
    expect(deleted).toEqual(["s_thread_1"]);
  });

  test("a deleted thread conversation is replaced instead of bricking talk-back", async () => {
    seedBrief(db, "brief_1", "run_9");
    const first = await port().openThread("token:t1", "brief_1");
    expect(first.created).toBe(true);
    // The user deletes the thread from a conversations list.
    existingConversations.delete(first.conversationId);
    const second = await port().openThread("token:t1", "brief_1");
    expect(second.created).toBe(true);
    expect(second.conversationId).not.toBe(first.conversationId);
    expect(getBrief(db, "brief_1")!.threadConversationId).toBe(second.conversationId);
    // And the replacement is reused normally afterwards.
    const third = await port().openThread("token:t1", "brief_1");
    expect(third).toEqual({ conversationId: second.conversationId, created: false });
  });

  test("the seed uses the NEWEST attempt's transcript when a run retried", async () => {
    seedBrief(db, "brief_1", "run_9");
    const base = {
      runId: "run_9",
      kind: "data",
      prompt: "Loop agent run run_9 (kind: data, attempt 1).",
      usage: null,
    } as const;
    transcripts.save({
      ...base,
      attempt: 1,
      startedAt: NOW - 9000,
      finishedAt: NOW - 8000,
      events: [{ type: "agent.error", payload: { code: "x", message: "backend died" } }],
      finalText: "",
      outcome: "failed",
    });
    transcripts.save({
      ...base,
      attempt: 2,
      startedAt: NOW - 5000,
      finishedAt: NOW - 4000,
      events: [
        { type: "agent.text.delta", payload: { delta: "Second attempt tracked it." } },
        { type: "agent.message.end", payload: { stopReason: "end_turn" } },
      ],
      finalText: "Second attempt tracked it.",
      outcome: "completed",
    });
    await port().openThread("token:t1", "brief_1");
    const history = created[0]!.input.initialHistory;
    const flat = JSON.stringify(history);
    expect(flat).toContain("Second attempt tracked it.");
  });

  test("unknown brief and disabled agent fail with typed errors", async () => {
    await expect(port().openThread("token:t1", "brief_missing")).rejects.toBeInstanceOf(
      BriefNotFoundError,
    );
    seedBrief(db, "brief_1", "run_9");
    agent = null;
    await expect(port().openThread("token:t1", "brief_1")).rejects.toBeInstanceOf(
      TalkbackUnavailableError,
    );
  });
});
