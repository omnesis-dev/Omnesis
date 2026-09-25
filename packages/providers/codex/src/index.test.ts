// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { zstdCompressSync } from "node:zlib";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MAX_RETAINED_SESSION_RECORDS } from "@omnesis/source-sdk/local-agent-sessions";
import { ProviderId, SourceId } from "@omnesis/types";
import source from "./index.js";

const SOURCE_ID = SourceId("codex:local");
const PROVIDER_ID = ProviderId("codex:local");

function iso(minute: number): string {
  return new Date(2026, 0, 8, 9, minute).toISOString();
}

function line(type: string, minute: number, payload: Record<string, unknown>) {
  return { type, timestamp: iso(minute), payload };
}

function writeJsonl(path: string, rows: Record<string, unknown>[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

describe("Codex session source", () => {
  let codexHome: string | undefined;

  afterEach(() => {
    if (codexHome) rmSync(codexHome, { recursive: true, force: true });
    codexHome = undefined;
  });

  test("advertises the first-party Codex icon", () => {
    expect(source.primaryCount).toBe("documents");
    expect(source.unitName).toBe("conversation days");
    expect(source.icon).toMatchObject({
      sfSymbol: "terminal.fill",
      color: "#10A37F",
      bgColor: "#10251F",
      url: "https://openai.gallerycdn.vsassets.io/extensions/openai/chatgpt/26.5818.41705/1787379434402/Microsoft.VisualStudio.Services.Icons.Default",
    });
  });

  test("declares its Codex home as member-local configuration", () => {
    expect(source.multiDevice?.mode).toBe("partitioned");
    expect(source.params?.find((param) => param.name === "codexHome")).toMatchObject({
      type: "path",
      scope: "member",
    });
  });

  test("indexes active and archived root sessions without developer, commentary, or subagent noise", async () => {
    codexHome = mkdtempSync(join(tmpdir(), "codex-sessions-"));
    const activePath = join(
      codexHome,
      "sessions",
      "2026",
      "01",
      "08",
      "rollout-codex-session-1.jsonl",
    );
    writeJsonl(activePath, [
      line("session_meta", 0, {
        id: "codex-session-1",
        session_id: "codex-session-1",
        timestamp: iso(0),
        cwd: "/work/northstar-cli",
        source: "cli",
        model_provider: "openai",
        git: { branch: "feat/parser", commit_hash: "0000000" },
      }),
      line("turn_context", 0, {
        cwd: "/work/northstar-cli",
        model: "gpt-fictional",
      }),
      line("response_item", 0, {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Unpaired final output" }],
      }),
      line("event_msg", 1, {
        type: "user_message",
        message: "Inspect parser behavior",
      }),
      line("response_item", 1, {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "<environment_context>hidden</environment_context>" },
        ],
      }),
      line("response_item", 2, {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "private developer policy" }],
      }),
      line("response_item", 3, {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Unmarked assistant output" }],
      }),
      line("response_item", 4, {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "I will inspect files." }],
      }),
      line("response_item", 5, {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Parser behavior is stable." }],
      }),
    ]);

    const archivedPath = join(codexHome, "archived_sessions", "rollout-codex-archived-1.jsonl");
    writeJsonl(archivedPath, [
      line("session_meta", 5, {
        id: "codex-archived-1",
        timestamp: iso(5),
        cwd: "/work/riverside-tools",
        source: "exec",
      }),
      line("event_msg", 6, { type: "user_message", message: "Summarize the archived task" }),
      line("response_item", 7, {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Archived task is complete." }],
      }),
    ]);

    const subagentPath = join(
      codexHome,
      "sessions",
      "2026",
      "01",
      "08",
      "rollout-codex-child-1.jsonl",
    );
    writeJsonl(subagentPath, [
      line("session_meta", 8, {
        id: "codex-child-1",
        timestamp: iso(8),
        cwd: "/work/northstar-cli",
        parent_thread_id: "codex-session-1",
        source: { subagent: { thread_spawn: true } },
      }),
      line("event_msg", 9, { type: "user_message", message: "Private delegated prompt" }),
      line("response_item", 10, {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Private delegated answer" }],
      }),
    ]);

    writeJsonl(join(codexHome, "sessions", "rollout-codex-internal.jsonl"), [
      line("session_meta", 11, {
        id: "codex-internal-1",
        timestamp: iso(11),
        cwd: "/work/northstar-cli",
        source: { internal: "memory_consolidation" },
      }),
      line("event_msg", 12, { type: "user_message", message: "Private internal prompt" }),
      line("response_item", 13, {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Private internal answer" }],
      }),
    ]);

    writeJsonl(join(codexHome, "sessions", "rollout-codex-mixed-child.jsonl"), [
      line("session_meta", 14, {
        id: "codex-mixed-child",
        session_id: "codex-session-1",
        timestamp: iso(14),
        cwd: "/work/northstar-cli",
        source: "cli",
      }),
      line("event_msg", 15, { type: "user_message", message: "Private mixed child prompt" }),
      line("response_item", 16, {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Private mixed child answer" }],
      }),
    ]);

    writeJsonl(join(codexHome, "sessions", "rollout-codex-thread-source.jsonl"), [
      line("session_meta", 17, {
        id: "codex-classified-subagent-1",
        timestamp: iso(17),
        cwd: "/work/northstar-cli",
        source: "cli",
        thread_source: "subagent",
      }),
      line("event_msg", 18, { type: "user_message", message: "Private classified prompt" }),
      line("response_item", 19, {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Private classified answer" }],
      }),
    ]);

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { codexHome },
    });
    const result = await instance.sync(null);

    expect(source.id).toBe("codex");
    expect(source.singleInstance).toBe(true);
    expect(instance.watchPaths).toEqual([
      join(codexHome, "sessions"),
      join(codexHome, "archived_sessions"),
    ]);
    expect(instance.watchFileExtensions).toEqual([".jsonl", ".jsonl.gz", ".jsonl.zst"]);
    expect(result.documents).toHaveLength(2);

    const active = result.documents.find((doc) => doc.externalId.includes("codex-session-1"))!;
    expect(active.externalId).toBe("cli:codex-session-1:2026-01-08");
    expect(active.title).toContain("northstar-cli");
    expect(active.content).toContain("Inspect parser behavior");
    expect(active.content).toContain("Parser behavior is stable.");
    expect(active.content).not.toContain("environment_context");
    expect(active.content).not.toContain("private developer policy");
    expect(active.content).not.toContain("Unmarked assistant output");
    expect(active.content).not.toContain("Unpaired final output");
    expect(active.content).not.toContain("I will inspect files.");
    expect(active.content).not.toContain("Private delegated prompt");
    expect(active.content).not.toContain("Private delegated answer");
    expect(active.content).not.toContain("Private internal prompt");
    expect(active.content).not.toContain("Private internal answer");
    expect(active.content).not.toContain("Private mixed child prompt");
    expect(active.content).not.toContain("Private mixed child answer");
    expect(active.content).not.toContain("Private classified prompt");
    expect(active.content).not.toContain("Private classified answer");
    expect(active.metadata.extra).toMatchObject({
      project: "northstar-cli",
      branch: "feat/parser",
      model: "gpt-fictional",
      provenance: "local-session-file",
    });

    const archived = result.documents.find((doc) => doc.externalId.includes("codex-archived-1"))!;
    expect(archived.content).toContain("Archived task is complete.");
  });

  test("indexes explicit human forks under their shared session id", async () => {
    codexHome = mkdtempSync(join(tmpdir(), "codex-sessions-"));
    const filePath = join(codexHome, "sessions", "rollout-codex-human-fork.jsonl");
    writeJsonl(filePath, [
      line("session_meta", 0, {
        id: "codex-human-fork",
        session_id: "codex-shared-session",
        forked_from_id: "codex-root-thread",
        timestamp: iso(0),
        cwd: "/work/riverside-tools",
        source: "cli",
        thread_source: "user",
      }),
      line("event_msg", 1, { type: "user_message", message: "Continue the human fork" }),
    ]);

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { codexHome },
    });
    const result = await instance.sync(null);

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]!.externalId).toBe("cli:codex-shared-session:2026-01-08");
    expect(result.documents[0]!.content).toContain("Continue the human fork");
  });

  test("ignores valid non-user thread sources without poisoning reconciliation", async () => {
    codexHome = mkdtempSync(join(tmpdir(), "codex-sessions-"));
    const filePath = join(codexHome, "sessions", "rollout-codex-memory.jsonl");
    writeJsonl(filePath, [
      line("session_meta", 0, {
        id: "codex-memory",
        session_id: "codex-memory",
        timestamp: iso(0),
        cwd: "/work/riverside-tools",
        source: { internal: "memory_consolidation" },
        thread_source: "memory_consolidation",
      }),
      line("event_msg", 1, { type: "user_message", message: "Private memory work" }),
    ]);

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { codexHome },
    });
    const result = await instance.sync(null);

    expect(result.documents).toEqual([]);
    expect(result.presentExternalIds).toEqual([]);
  });

  test("indexes zstd-compressed archived rollouts", async () => {
    codexHome = mkdtempSync(join(tmpdir(), "codex-sessions-"));
    const filePath = join(codexHome, "archived_sessions", "rollout-codex-zstd.jsonl.zst");
    mkdirSync(join(codexHome, "sessions"), { recursive: true });
    const rows = [
      line("session_meta", 0, {
        id: "codex-zstd",
        timestamp: iso(0),
        cwd: "/work/riverside-tools",
        source: "exec",
      }),
      line("event_msg", 1, { type: "user_message", message: "Read the cold archive" }),
      line("response_item", 2, {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Cold archive is readable." }],
      }),
    ];
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(
      filePath,
      zstdCompressSync(Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)),
    );

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { codexHome },
    });
    const result = await instance.sync(null);

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]!.content).toContain("Read the cold archive");
    expect(result.documents[0]!.content).toContain("Cold archive is readable.");
  });

  test("indexes paginated ItemCompleted user messages", async () => {
    codexHome = mkdtempSync(join(tmpdir(), "codex-sessions-"));
    const filePath = join(codexHome, "sessions", "rollout-codex-paginated.jsonl");
    writeJsonl(filePath, [
      line("session_meta", 0, {
        id: "codex-paginated-session",
        session_id: "codex-paginated-session",
        timestamp: iso(0),
        cwd: "/work/riverside-tools",
        source: "cli",
      }),
      line("event_msg", 1, {
        type: "item_completed",
        item: {
          type: "UserMessage",
          id: "user-item-1",
          content: [{ type: "text", text: "Inspect paginated history" }],
        },
      }),
      line("response_item", 2, {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Paginated history is complete." }],
      }),
    ]);

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { codexHome },
    });
    const result = await instance.sync(null);

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]!.externalId).toBe("cli:codex-paginated-session:2026-01-08");
    expect(result.documents[0]!.content).toContain("Inspect paginated history");
    expect(result.documents[0]!.content).toContain("Paginated history is complete.");
  });

  test("uses only the newest immutable revision for one stable session", async () => {
    codexHome = mkdtempSync(join(tmpdir(), "codex-sessions-"));
    const olderPath = join(codexHome, "sessions", "rollout-codex-revision-old.jsonl");
    const newerPath = join(codexHome, "sessions", "rollout-codex-revision-new.jsonl");
    writeJsonl(olderPath, [
      line("session_meta", 0, {
        id: "codex-revision",
        session_id: "codex-revision",
        timestamp: iso(0),
        cwd: "/work/riverside-tools",
        source: "cli",
      }),
      {
        type: "event_msg",
        timestamp: "2026-01-07T09:00:00.000Z",
        payload: { type: "user_message", message: "Reverted older day" },
      },
    ]);
    writeJsonl(newerPath, [
      line("session_meta", 0, {
        id: "codex-revision",
        session_id: "codex-revision",
        timestamp: iso(0),
        cwd: "/work/riverside-tools",
        source: "cli",
      }),
      {
        type: "event_msg",
        timestamp: "2026-01-08T09:00:00.000Z",
        payload: { type: "user_message", message: "Current revision day" },
      },
    ]);
    utimesSync(olderPath, new Date(2026, 0, 7), new Date(2026, 0, 7));
    utimesSync(newerPath, new Date(2026, 0, 8), new Date(2026, 0, 8));

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { codexHome },
    });
    const result = await instance.sync(null);

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]!.content).toContain("Current revision day");
    expect(result.documents[0]!.content).not.toContain("Reverted older day");
    expect(result.presentExternalIds).toEqual(["cli:codex-revision:2026-01-08"]);
  });

  test("withholds reconciliation for schema-invalid known records", async () => {
    codexHome = mkdtempSync(join(tmpdir(), "codex-sessions-"));
    const filePath = join(codexHome, "sessions", "rollout-codex-invalid.jsonl");
    writeJsonl(filePath, [
      line("session_meta", 0, {
        id: "codex-invalid",
        timestamp: iso(0),
        cwd: "/work/riverside-tools",
        source: "cli",
      }),
      line("event_msg", 1, { type: "user_message", message: 42 }),
      line("response_item", 2, {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Must not become authoritative." }],
      }),
    ]);

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { codexHome },
    });
    const result = await instance.sync(null);

    expect(result.documents).toEqual([]);
    expect(result.presentExternalIds).toBeUndefined();
  });

  test("withholds reconciliation when a rollout gains malformed internal lines", async () => {
    codexHome = mkdtempSync(join(tmpdir(), "codex-sessions-"));
    const filePath = join(codexHome, "sessions", "rollout-codex-recovered.jsonl");
    const rows = [
      line("session_meta", 0, {
        id: "codex-recovered",
        timestamp: iso(0),
        cwd: "/work/riverside-tools",
        source: "cli",
      }),
      line("event_msg", 1, { type: "user_message", message: "Recover readable records" }),
      line("response_item", 2, {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Readable records survive." }],
      }),
    ];
    writeJsonl(filePath, rows);

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { codexHome },
    });
    const first = await instance.sync(null);
    expect(first.documents).toHaveLength(1);
    expect(first.presentExternalIds).toEqual([first.documents[0]!.externalId]);

    writeFileSync(
      filePath,
      `${rows[0] && JSON.stringify(rows[0])}\nnot-json\n${rows
        .slice(1)
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );
    const malformed = await instance.sync(first.cursor);

    expect(malformed.documents).toEqual([]);
    expect(malformed.presentExternalIds).toBeUndefined();
  });

  test("applies rollbacks and ingests later turns while the rollout tail is partial", async () => {
    codexHome = mkdtempSync(join(tmpdir(), "codex-sessions-"));
    const filePath = join(codexHome, "sessions", "rollout-codex-live.jsonl");
    const initialRows = [
      line("session_meta", 0, {
        id: "codex-live",
        timestamp: iso(0),
        cwd: "/work/riverside-tools",
        source: "cli",
      }),
      line("event_msg", 1, { type: "user_message", message: "Start the rollout" }),
      line("response_item", 2, {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Rollout started." }],
      }),
    ];
    writeJsonl(filePath, initialRows);

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { codexHome },
    });
    const first = await instance.sync(null);

    const addedRows = [
      line("event_msg", 3, { type: "user_message", message: "Discard this turn" }),
      line("response_item", 4, {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Discarded answer" }],
      }),
      line("event_msg", 5, { type: "thread_rolled_back", num_turns: 1 }),
      line("event_msg", 6, { type: "user_message", message: "Keep this replacement" }),
      line("response_item", 7, {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Replacement is retained." }],
      }),
    ];
    writeFileSync(
      filePath,
      `${[...initialRows, ...addedRows].map((row) => JSON.stringify(row)).join("\n")}\n{"type":`,
    );

    const updated = await instance.sync(first.cursor);
    expect(updated.documents).toHaveLength(1);
    expect(updated.documents[0]!.content).toContain("Keep this replacement");
    expect(updated.documents[0]!.content).toContain("Replacement is retained.");
    expect(updated.documents[0]!.content).not.toContain("Discard this turn");
    expect(updated.documents[0]!.content).not.toContain("Discarded answer");
  });

  test("fails conservatively before retaining an unbounded message list", async () => {
    codexHome = mkdtempSync(join(tmpdir(), "codex-sessions-"));
    const rows = [
      line("session_meta", 0, {
        id: "codex-bounded",
        timestamp: iso(0),
        cwd: "/work/example-project",
        source: "cli",
      }),
      ...Array.from({ length: MAX_RETAINED_SESSION_RECORDS + 1 }, (_, index) =>
        line("event_msg", 1, { type: "user_message", message: `Prompt ${index}` }),
      ),
    ];
    writeJsonl(join(codexHome, "sessions", "bounded.jsonl"), rows);

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { codexHome },
    });
    const result = await instance.sync(null);

    expect(result.documents).toEqual([]);
    expect(result.presentExternalIds).toBeUndefined();
  });

  test("skips a session file with no session metadata and still ingests its sibling", async () => {
    codexHome = mkdtempSync(join(tmpdir(), "codex-sessions-"));
    // No `session_meta` as the first record — parseCodexSession throws a
    // SyncError before ever assigning a session id.
    writeJsonl(join(codexHome, "sessions", "rollout-codex-no-header.jsonl"), [
      line("turn_context", 0, { cwd: "/work/example-project", model: "gpt-fictional" }),
    ]);
    writeJsonl(join(codexHome, "sessions", "rollout-codex-sibling.jsonl"), [
      line("session_meta", 0, {
        id: "codex-sibling",
        timestamp: iso(0),
        cwd: "/work/example-project",
        source: "cli",
      }),
      line("event_msg", 1, { type: "user_message", message: "Hello from the sibling session" }),
      line("response_item", 2, {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Reply from the sibling session" }],
      }),
    ]);

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { codexHome },
    });
    const result = await instance.sync(null);

    expect(result.documents).toHaveLength(1);
    expect(result.presentExternalIds).toBeUndefined();
  });

  test("reports unresolved history coverage on every sync page", async () => {
    codexHome = mkdtempSync(join(tmpdir(), "codex-sessions-"));
    writeJsonl(join(codexHome, "sessions", "rollout-codex-coverage.jsonl"), [
      line("session_meta", 0, {
        id: "codex-coverage",
        timestamp: iso(0),
        cwd: "/work/example-project",
        source: "cli",
      }),
      line("event_msg", 1, { type: "user_message", message: "Track coverage" }),
    ]);

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { codexHome },
    });
    const first = await instance.sync(null);
    expect(first.progress?.coverage).toBe("unknown");
    expect(first.progress?.detail).toBeTruthy();

    const settled = await instance.sync(first.cursor);
    expect(settled.hasMore).toBe(false);
    expect(settled.progress?.coverage).toBe("unknown");
  });
});
