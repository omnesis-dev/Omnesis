// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import source, { excludeAntigravityPath } from "./index.js";

const SOURCE_ID = SourceId("antigravity:local");
const PROVIDER_ID = ProviderId("antigravity:local");

function iso(minute: number): string {
  return new Date(2026, 0, 8, 9, minute).toISOString();
}

function transcriptFile(home: string, convId: string, filename = "transcript_full.jsonl"): string {
  return join(home, "brain", convId, ".system_generated", "logs", filename);
}

function writeTranscript(
  home: string,
  convId: string,
  rows: Record<string, unknown>[],
  filename = "transcript_full.jsonl",
): string {
  const path = transcriptFile(home, convId, filename);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return path;
}

function seedSummariesDb(
  home: string,
  rows: Array<{
    id: string;
    title?: string;
    workspaceUris?: string[];
    parentId?: string;
    nestingDepth?: number;
  }>,
): void {
  const db = new DatabaseSync(join(home, "conversation_summaries.db"));
  try {
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id text PRIMARY KEY,
        title text NOT NULL DEFAULT "",
        workspace_uris text NOT NULL DEFAULT "[]",
        parent_conversation_id text NOT NULL DEFAULT "",
        nesting_depth integer NOT NULL DEFAULT 0
      );
      CREATE TABLE conversation_parents (
        conversation_id text PRIMARY KEY,
        parent_id text NOT NULL
      );
    `);
    const stmt = db.prepare(
      "INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, parent_conversation_id, nesting_depth) VALUES (?, ?, ?, ?, ?)",
    );
    for (const row of rows) {
      stmt.run(
        row.id,
        row.title ?? "",
        JSON.stringify(row.workspaceUris ?? []),
        row.parentId ?? "",
        row.nestingDepth ?? 0,
      );
    }
  } finally {
    db.close();
  }
}

describe("Antigravity session source", () => {
  const dirs: string[] = [];

  function tempDir(prefix = "antigravity-sessions-"): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("advertises Antigravity icon, profile, and member-local configuration", () => {
    expect(source.primaryCount).toBe("documents");
    expect(source.unitName).toBe("conversation days");
    expect(source.multiDevice?.mode).toBe("partitioned");
    expect(source.icon).toMatchObject({
      sfSymbol: "terminal.fill",
      color: "#3186FF",
      bgColor: "#142038",
    });
    expect(source.icon?.imageDataUri).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(source.params?.find((param) => param.name === "antigravityHome")).toMatchObject({
      type: "path",
      scope: "member",
    });
  });

  test("indexes root conversations with clean prompts, multi-reply turns, and summary metadata while ignoring subagents and non-transcript noise", async () => {
    const home = tempDir();
    const workspaceDir = resolve(home, "northstar-cli");
    const workspaceUri = pathToFileURL(workspaceDir).href;
    seedSummariesDb(home, [
      {
        id: "conv-root-1",
        title: "parser refactor notes",
        workspaceUris: [workspaceUri],
      },
      {
        id: "conv-subagent-1",
        title: "delegated subagent task",
        workspaceUris: [workspaceUri],
        parentId: "conv-root-1",
        nestingDepth: 1,
      },
    ]);

    writeTranscript(home, "conv-root-1", [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: iso(0),
        content:
          "<USER_REQUEST>\nInspect parser behavior\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-01-08T09:00:00Z.\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nModel changed\n</USER_SETTINGS_CHANGE>",
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: iso(1),
        model: "gemini-4-neon-high",
        thinking: "Checking files first",
        tool_calls: [{ name: "read_file", args: { Path: "/work/northstar-cli/index.ts" } }],
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: iso(2),
        content: "Raw tool output that should not be indexed",
      },
      {
        step_index: 3,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: iso(3),
        model: "gemini-4-neon-high",
        content: "First status update while background task runs.",
      },
      {
        step_index: 4,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        created_at: iso(4),
        content: "<SYSTEM_MESSAGE>Background task finished</SYSTEM_MESSAGE>",
      },
      {
        step_index: 5,
        source: "SYSTEM",
        type: "CHECKPOINT",
        status: "DONE",
        created_at: iso(5),
        content: "# Resuming from a compaction",
      },
      {
        step_index: 6,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: iso(6),
        model: "gemini-4-neon-high",
        content: "Parser behavior is stable.",
      },
    ]);

    // Compact transcript, chunked logs, and step outputs must all be skipped.
    writeTranscript(
      home,
      "conv-root-1",
      [
        {
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          created_at: iso(0),
          content: "Truncated compact duplicate",
        },
      ],
      "transcript.jsonl",
    );
    mkdirSync(join(home, "brain", "conv-root-1", ".system_generated", "logs", "chunks"), {
      recursive: true,
    });
    writeFileSync(
      join(home, "brain", "conv-root-1", ".system_generated", "logs", "chunks", "00000000.jsonl"),
      "not even valid json\n",
    );
    mkdirSync(join(home, "brain", "conv-root-1", ".system_generated", "steps", "1"), {
      recursive: true,
    });
    writeFileSync(
      join(home, "brain", "conv-root-1", ".system_generated", "steps", "1", "output.txt"),
      "tool output",
    );

    // Subagent recorded in conversation_summaries.db
    writeTranscript(home, "conv-subagent-1", [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: iso(7),
        content: "<USER_REQUEST>\nSubagent prompt\n</USER_REQUEST>",
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: iso(8),
        content: "Subagent reply",
      },
    ]);

    // Subagent with no DB entry: begins with SYSTEM_MESSAGE and has no USER_EXPLICIT input
    writeTranscript(home, "conv-subagent-no-db", [
      {
        step_index: 0,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        created_at: iso(9),
        content: "Delegated task instructions",
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: iso(10),
        content: "Delegated task completed",
      },
    ]);

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { antigravityHome: home },
    });
    const result = await instance.sync(null);

    expect(result.hasMore).toBe(false);
    expect(result.documents).toHaveLength(1);
    const doc = result.documents[0]!;
    expect(doc.metadata.documentType).toBe("conversation");
    expect(doc.metadata.tags).toEqual(["antigravity", "cli", "northstar-cli"]);
    expect(doc.metadata.extra).toMatchObject({
      agent: "Antigravity",
      channel: "cli",
      chatId: "conv-root-1",
      project: "northstar-cli",
      cwd: workspaceDir,
      model: "gemini-4-neon-high",
      messageCount: 3,
    });
    expect(doc.title).toContain("parser refactor notes");
    expect(doc.content).toContain("Inspect parser behavior");
    expect(doc.content).not.toContain("<USER_REQUEST>");
    expect(doc.content).not.toContain("<ADDITIONAL_METADATA>");
    expect(doc.content).not.toContain("Raw tool output");
    expect(doc.content).not.toContain("Resuming from a compaction");
    expect(doc.content).toContain("First status update while background task runs.");
    expect(doc.content).toContain("Parser behavior is stable.");
    expect(result.presentExternalIds).toEqual([doc.externalId]);
  });

  test("works without conversation_summaries.db and preserves unwrapped prompts", async () => {
    const home = tempDir();
    writeTranscript(home, "conv-plain-1", [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: iso(0),
        content: "Plain user message without tags",
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: iso(1),
        model: "gemini-4-carbon-high",
        content: "Plain assistant response.",
      },
    ]);

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { antigravityHome: home },
    });
    const result = await instance.sync(null);

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]!.content).toContain("Plain user message without tags");
    expect(result.documents[0]!.content).toContain("Plain assistant response.");
    expect(result.documents[0]!.metadata.extra).toMatchObject({
      chatId: "conv-plain-1",
      model: "gemini-4-carbon-high",
      cwd: null,
    });
  });

  test("probeReadAccess succeeds even when a conversation has hundreds of step output directories", async () => {
    const home = tempDir();
    writeTranscript(home, "conv-many-steps", [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: iso(0),
        content: "<USER_REQUEST>\nLong session\n</USER_REQUEST>",
      },
    ]);
    for (let i = 0; i < 300; i += 1) {
      mkdirSync(join(home, "brain", "conv-many-steps", ".system_generated", "steps", String(i)), {
        recursive: true,
      });
    }

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { antigravityHome: home },
    });
    const access = await instance.probeReadAccess!({ signal: new AbortController().signal });
    expect(access.status).toBe("readable");
  });

  test("withholds snapshot when a transcript has malformed lines while still indexing healthy siblings", async () => {
    const home = tempDir();
    const brokenPath = transcriptFile(home, "conv-broken");
    mkdirSync(join(brokenPath, ".."), { recursive: true });
    writeFileSync(brokenPath, "{broken json\n");

    writeTranscript(home, "conv-healthy", [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: iso(0),
        content: "<USER_REQUEST>\nHello\n</USER_REQUEST>",
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: iso(1),
        content: "Hi there.",
      },
    ]);

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { antigravityHome: home },
    });
    const result = await instance.sync(null);

    expect(result.documents).toHaveLength(1);
    expect(result.presentExternalIds).toBeUndefined();
  });

  test("reports unresolved history coverage on every sync page", async () => {
    const home = tempDir();
    writeTranscript(home, "conv-coverage", [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: iso(0),
        content: "<USER_REQUEST>\nTrack coverage\n</USER_REQUEST>",
      },
    ]);

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { antigravityHome: home },
    });
    const first = await instance.sync(null);
    expect(first.progress?.coverage).toBe("unknown");
    expect(first.progress?.detail).toBeTruthy();

    const settled = await instance.sync(first.cursor);
    expect(settled.hasMore).toBe(false);
    expect(settled.progress?.coverage).toBe("unknown");
  });

  test("excludeAntigravityPath allows only <conv>/.system_generated/logs/transcript_full.jsonl", () => {
    expect(excludeAntigravityPath("abc-123", true)).toBe(false);
    expect(excludeAntigravityPath(".hidden", true)).toBe(true);
    expect(excludeAntigravityPath("abc-123/.system_generated", true)).toBe(false);
    expect(excludeAntigravityPath("abc-123/scratch", true)).toBe(true);
    expect(excludeAntigravityPath("abc-123/.system_generated/logs", true)).toBe(false);
    expect(excludeAntigravityPath("abc-123/.system_generated/steps", true)).toBe(true);
    expect(excludeAntigravityPath("abc-123/.system_generated/logs/chunks", true)).toBe(true);
    expect(
      excludeAntigravityPath("abc-123/.system_generated/logs/transcript_full.jsonl", false),
    ).toBe(false);
    expect(excludeAntigravityPath("abc-123/.system_generated/logs/transcript.jsonl", false)).toBe(
      true,
    );
  });
});
