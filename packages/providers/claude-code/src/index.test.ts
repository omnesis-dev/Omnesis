// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MAX_RETAINED_SESSION_RECORDS } from "@omnesis/source-sdk/local-agent-sessions";
import { ProviderId, SourceId } from "@omnesis/types";
import source from "./index.js";

const SOURCE_ID = SourceId("claude-code:local");
const PROVIDER_ID = ProviderId("claude-code:local");

function iso(minute: number): string {
  return new Date(2026, 0, 7, 9, minute).toISOString();
}

function base(type: string, uuid: string, parentUuid: string | null) {
  return {
    type,
    uuid,
    parentUuid,
    sessionId: "claude-session-1",
    timestamp: iso(0),
    cwd: "/work/northstar-cli",
    gitBranch: "feat/parser",
    isSidechain: false,
    ...(type === "user" ? { userType: "external" } : {}),
  };
}

describe("Claude Code session source", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  test("advertises Claude's first-party icon", () => {
    expect(source.primaryCount).toBe("documents");
    expect(source.unitName).toBe("conversation days");
    expect(source.icon).toMatchObject({
      sfSymbol: "terminal.fill",
      color: "#D97757",
      bgColor: "#2A1B17",
      url: "https://claude.ai/images/claude_app_icon.png",
    });
  });

  test("declares its sessions path as member-local configuration", () => {
    expect(source.multiDevice?.mode).toBe("partitioned");
    expect(source.params?.find((param) => param.name === "sessionsPath")).toMatchObject({
      type: "path",
      scope: "member",
    });
  });

  test("supports legacy and current transcript metadata and human-origin records", async () => {
    root = mkdtempSync(join(tmpdir(), "claude-code-sessions-"));
    const metadataTypes = [
      "agent-name",
      "agent-color",
      "agent-setting",
      "artifact-autoreact-ledger",
      "artifact-comment-monitor",
      "atis-latch",
      "attribution-snapshot",
      "bridge-session",
      "content-replacement",
      "cost-state",
      "ended-by-model",
      "file-history-delta",
      "fork-context-ref",
      "frame-link",
      "history-suppression",
      "isolation-latch",
      "marble-origami-commit",
      "marble-origami-reset",
      "marble-origami-snapshot",
      "mode",
      "observer-ref",
      "permission-mode",
      "pr-link",
      "relocated",
      "failed",
      "result",
      "started",
      "summary",
      "tag",
      "worktree-state",
    ];
    const rows: Array<Record<string, unknown>> = [
      ...metadataTypes.map((type) => ({ type, sessionId: "claude-session-1" })),
      {
        type: "custom-title",
        sessionId: "claude-session-1",
        customTitle: "Current parser review",
      },
      {
        type: "ai-title",
        sessionId: "claude-session-1",
        aiTitle: "Generated parser review",
      },
      {
        ...base("user", "legacy-user", null),
        message: { role: "user", content: "Check the legacy transcript" },
      },
      {
        ...base("assistant", "legacy-answer", "legacy-user"),
        message: {
          role: "assistant",
          model: "claude-fictional",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "The legacy transcript is readable." }],
        },
      },
      {
        ...base("user", "current-user", "legacy-user"),
        origin: { kind: "human" },
        message: { role: "user", content: "Check the current transcript" },
      },
      {
        ...base("user", "current-user", "legacy-answer"),
        origin: { kind: "human" },
        slug: "current-tree",
        message: { role: "user", content: "Check the current transcript" },
      },
      {
        ...base("assistant", "current-answer", "current-user"),
        message: {
          role: "assistant",
          model: "claude-fictional",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "The current transcript is readable." }],
        },
      },
      {
        type: "last-prompt",
        sessionId: "claude-session-1",
        leafUuid: "current-answer",
      },
    ];
    writeFileSync(
      join(root, "claude-session-1.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { sessionsPath: root },
    });
    const result = await instance.sync(null);

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]!.title).toContain("Current parser review");
    expect(result.documents[0]!.title).not.toContain("Generated parser review");
    expect(result.documents[0]!.content).toContain("Check the legacy transcript");
    expect(result.documents[0]!.content).toContain("The legacy transcript is readable.");
    expect(result.documents[0]!.content).toContain("Check the current transcript");
    expect(result.documents[0]!.content).toContain("The current transcript is readable.");
    expect(result.presentExternalIds).toEqual(["cli:claude-session-1:2026-01-07"]);
  });

  test.each([false, true])(
    "replayed structural context can move directories (conflicting timestamp: %s)",
    async (conflict) => {
      root = mkdtempSync(join(tmpdir(), "claude-code-sessions-"));
      const rows = [
        {
          ...base("user", "u1", null),
          message: { role: "user", content: "Keep the structural check strict" },
        },
        { ...base("system", "structure", "u1"), cwd: "/work/first" },
        {
          ...base("system", "structure", "u1"),
          cwd: "/work/changed",
          timestamp: iso(conflict ? 1 : 0),
        },
        { type: "last-prompt", sessionId: "claude-session-1", leafUuid: "structure" },
      ];
      writeFileSync(
        join(root, "claude-session-1.jsonl"),
        `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      );

      const instance = await source.create!({
        accountId: "local",
        sourceId: SOURCE_ID,
        providerId: PROVIDER_ID,
        config: { sessionsPath: root },
      });
      const result = await instance.sync(null);

      if (conflict) {
        expect(result.documents).toEqual([]);
        expect(result.presentExternalIds).toBeUndefined();
      } else {
        expect(result.documents).toHaveLength(1);
        expect(result.presentExternalIds).toEqual([result.documents[0]!.externalId]);
        expect(result.documents[0]!.content).toContain("changed · feat/parser");
      }
    },
  );

  test.each(["role", "text", "time", "model", "sidechain", "turnOrigin", "branch"])(
    "context updates do not waive conflicting conversation %s",
    async (field) => {
      root = mkdtempSync(join(tmpdir(), "claude-code-sessions-"));
      const original = {
        ...base(field === "turnOrigin" ? "user" : "assistant", "answer", null),
        message: {
          role: field === "turnOrigin" ? "user" : "assistant",
          content: field === "turnOrigin" ? "" : "A fictional reply",
          stop_reason: "end_turn",
          model: "fictional-one",
        },
      };
      const replay = {
        ...original,
        cwd: "/work/moved",
        ...(field === "time" ? { timestamp: iso(1) } : {}),
        ...(field === "branch" ? { gitBranch: "feat/other" } : {}),
        ...(field === "sidechain" ? { isSidechain: true } : {}),
        ...(field === "role" || field === "turnOrigin"
          ? { type: "user", userType: "external", isMeta: field === "turnOrigin" }
          : {}),
        message: {
          ...original.message,
          ...(field === "text" ? { content: "A different fictional reply" } : {}),
          ...(field === "model" ? { model: "fictional-two" } : {}),
          ...(field === "role" || field === "turnOrigin" ? { role: "user" } : {}),
        },
      };
      writeFileSync(
        join(root, "conflict.jsonl"),
        `${JSON.stringify(original)}\n${JSON.stringify(replay)}\n`,
      );
      const instance = await source.create!({
        accountId: "local",
        sourceId: SOURCE_ID,
        providerId: PROVIDER_ID,
        config: { sessionsPath: root },
      });
      const result = await instance.sync(null);
      expect(result.documents).toEqual([]);
      expect(result.presentExternalIds).toBeUndefined();
    },
  );

  test("honors current last-prompt clears and cleared custom titles", async () => {
    root = mkdtempSync(join(tmpdir(), "claude-code-sessions-"));
    const filePath = join(root, "claude-session-1.jsonl");
    const rows: Array<Record<string, unknown>> = [
      {
        ...base("user", "u1", null),
        message: { role: "user", content: "Keep the current transcript state" },
      },
      { type: "ai-title", sessionId: "claude-session-1", aiTitle: "Generated session title" },
      { type: "custom-title", sessionId: "claude-session-1", customTitle: "" },
      { type: "last-prompt", sessionId: "claude-session-1", leafUuid: "u1" },
      { type: "last-prompt", sessionId: "claude-session-1", preview: true },
    ];
    writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { sessionsPath: root },
    });
    const first = await instance.sync(null);

    expect(first.documents).toHaveLength(1);
    expect(first.documents[0]!.title).toContain("Generated session title");
    expect(first.presentExternalIds).toEqual([first.documents[0]!.externalId]);

    rows.push({
      type: "last-prompt",
      sessionId: "claude-session-1",
      leafUuid: null,
      explicit: true,
    });
    writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const cleared = await instance.sync(first.cursor);

    expect(cleared.documents).toEqual([]);
    expect(cleared.presentExternalIds).toEqual([]);

    rows.push({
      ...base("user", "u1", null),
      message: { role: "user", content: "Keep the current transcript state" },
    });
    writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const replayed = await instance.sync(cleared.cursor);

    expect(replayed.documents).toEqual([]);
    expect(replayed.presentExternalIds).toEqual([]);

    rows.push(
      {
        ...base("user", "u2", null),
        timestamp: iso(5),
        message: { role: "user", content: "Continue after clearing the transcript" },
      },
      { type: "last-prompt", sessionId: "claude-session-1", preview: true },
    );
    writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const continued = await instance.sync(replayed.cursor);

    expect(continued.documents).toHaveLength(1);
    expect(continued.documents[0]!.content).toContain("Continue after clearing the transcript");
    expect(continued.documents[0]!.content).not.toContain("Keep the current transcript state");
    expect(continued.presentExternalIds).toEqual([continued.documents[0]!.externalId]);
  });

  test("does not count identical node replays against the retained-node limit", async () => {
    root = mkdtempSync(join(tmpdir(), "claude-code-sessions-"));
    const replayed = {
      ...base("user", "u1", null),
      message: { role: "user", content: "Keep one replayed prompt" },
    };
    const rows = [
      ...Array.from({ length: MAX_RETAINED_SESSION_RECORDS + 1 }, () => replayed),
      { type: "last-prompt", sessionId: "claude-session-1", leafUuid: "u1" },
    ];
    writeFileSync(
      join(root, "claude-session-1.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { sessionsPath: root },
    });
    const result = await instance.sync(null);

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]!.content.match(/Keep one replayed prompt/g)).toHaveLength(1);
  });

  test("indexes active main-chain prompts and completed answers without tool or sidechain noise", async () => {
    root = mkdtempSync(join(tmpdir(), "claude-code-sessions-"));
    const rows = [
      {
        type: "file-history-snapshot",
        sessionId: "claude-session-1",
        messageId: "snapshot-1",
        snapshot: { trackedFileBackups: {} },
      },
      {
        ...base("user", "u1", null),
        message: { role: "user", content: "Inspect parser behavior" },
      },
      {
        ...base("assistant", "a1", "u1"),
        message: {
          id: "msg-tool",
          role: "assistant",
          model: "claude-fictional",
          stop_reason: "tool_use",
          content: [
            { type: "thinking", thinking: "hidden reasoning" },
            { type: "text", text: "I will inspect files." },
            { type: "tool_use", id: "tool-1", name: "Read", input: {} },
          ],
        },
      },
      {
        ...base("user", "t1", "a1"),
        sourceToolAssistantUUID: "a1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "private output" }],
        },
      },
      {
        ...base("assistant", "a2", "t1"),
        message: {
          id: "msg-old",
          role: "assistant",
          model: "claude-fictional",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Abandoned branch answer" }],
        },
      },
      {
        ...base("user", "u2", "u1"),
        timestamp: iso(2),
        message: { role: "user", content: "Use the smaller fix" },
      },
      {
        ...base("assistant", "side1", "u2"),
        isSidechain: true,
        message: {
          id: "msg-side",
          role: "assistant",
          model: "claude-fictional",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Sidechain-only research" }],
        },
      },
      {
        ...base("assistant", "meta1", "u2"),
        isMeta: true,
        timestamp: iso(3),
        message: {
          id: "msg-meta",
          role: "assistant",
          model: "claude-fictional",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Meta assistant context" }],
        },
      },
      {
        ...base("assistant", "unmarked1", "meta1"),
        timestamp: iso(4),
        message: {
          id: "msg-unmarked",
          role: "assistant",
          model: "claude-fictional",
          stop_reason: null,
          content: [{ type: "text", text: "Unmarked assistant text" }],
        },
      },
      {
        ...base("assistant", "a3", "unmarked1"),
        timestamp: iso(5),
        message: {
          id: "msg-final",
          role: "assistant",
          model: "claude-fictional",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Smaller fix keeps parser stable." }],
        },
      },
      { type: "ai-title", sessionId: "claude-session-1", aiTitle: "Parser cleanup" },
      { type: "last-prompt", sessionId: "claude-session-1", leafUuid: "a3" },
    ];
    writeFileSync(
      join(root, "claude-session-1.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { sessionsPath: root },
    });
    const result = await instance.sync(null);

    expect(source.id).toBe("claude-code");
    expect(source.singleInstance).toBe(true);
    expect(source.contentRetention).toBe("best-effort");
    expect(instance.watchFileExtensions).toEqual([".jsonl"]);
    expect(result.documents).toHaveLength(1);

    const doc = result.documents[0]!;
    expect(doc.externalId).toBe("cli:claude-session-1:2026-01-07");
    expect(doc.title).toContain("Parser cleanup · northstar-cli");
    expect(doc.content).toContain("Inspect parser behavior");
    expect(doc.content).toContain("Use the smaller fix");
    expect(doc.content).toContain("Smaller fix keeps parser stable.");
    expect(doc.content).not.toContain("hidden reasoning");
    expect(doc.content).not.toContain("I will inspect files.");
    expect(doc.content).not.toContain("private output");
    expect(doc.content).not.toContain("Sidechain-only research");
    expect(doc.content).not.toContain("Meta assistant context");
    expect(doc.content).not.toContain("Unmarked assistant text");
    expect(doc.content).not.toContain("Abandoned branch answer");
    expect(doc.metadata.extra).toMatchObject({
      project: "northstar-cli",
      branch: "feat/parser",
      model: "claude-fictional",
      provenance: "local-session-file",
    });
  });

  test("excludes automated user events and assistant replies they trigger", async () => {
    root = mkdtempSync(join(tmpdir(), "claude-code-sessions-"));
    const rows = [
      {
        ...base("user", "u0", null),
        userType: "external",
        message: { role: "user", content: "Start the foreground change" },
      },
      {
        ...base("user", "meta-before-answer", "u0"),
        isMeta: true,
        toolUseResult: { status: "complete" },
        message: { role: "user", content: "Injected meta request" },
      },
      {
        ...base("assistant", "meta-answer", "meta-before-answer"),
        message: {
          role: "assistant",
          model: "claude-fictional",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Injected meta answer." }],
        },
      },
      {
        ...base("user", "u1", "meta-answer"),
        userType: "external",
        message: { role: "user", content: "Review the foreground change" },
      },
      {
        ...base("assistant", "a1", "u1"),
        message: {
          role: "assistant",
          model: "claude-fictional",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Foreground review complete." }],
        },
      },
      {
        ...base("user", "notification", "a1"),
        timestamp: iso(2),
        origin: { kind: "task-notification" },
        message: { role: "user", content: "Background task output is ready" },
      },
      {
        ...base("assistant", "background-answer", "notification"),
        timestamp: iso(3),
        message: {
          role: "assistant",
          model: "claude-fictional",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Private background summary." }],
        },
      },
      {
        ...base("user", "compact", "background-answer"),
        timestamp: iso(4),
        isCompactSummary: true,
        message: { role: "user", content: "Compacted hidden context" },
      },
      {
        ...base("user", "unknown-origin", "compact"),
        timestamp: iso(5),
        userType: undefined,
        message: { role: "user", content: "Unclassified automatic prompt" },
      },
      {
        ...base("assistant", "unknown-answer", "unknown-origin"),
        timestamp: iso(6),
        message: {
          role: "assistant",
          model: "claude-fictional",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Unclassified automatic answer." }],
        },
      },
      {
        ...base("user", "u2", "unknown-answer"),
        timestamp: iso(7),
        userType: "external",
        message: { role: "user", content: "Finish the foreground change" },
      },
      {
        ...base("assistant", "a2", "u2"),
        timestamp: iso(8),
        message: {
          role: "assistant",
          model: "claude-fictional",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Foreground change finished." }],
        },
      },
      { type: "last-prompt", sessionId: "claude-session-1", leafUuid: "a2" },
    ];
    writeFileSync(
      join(root, "claude-session-1.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { sessionsPath: root },
    });
    const result = await instance.sync(null);

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]!.content).toContain("Start the foreground change");
    expect(result.documents[0]!.content).toContain("Review the foreground change");
    expect(result.documents[0]!.content).toContain("Foreground review complete.");
    expect(result.documents[0]!.content).toContain("Finish the foreground change");
    expect(result.documents[0]!.content).toContain("Foreground change finished.");
    expect(result.documents[0]!.content).not.toContain("Injected meta request");
    expect(result.documents[0]!.content).not.toContain("Injected meta answer.");
    expect(result.documents[0]!.content).not.toContain("Background task output is ready");
    expect(result.documents[0]!.content).not.toContain("Private background summary.");
    expect(result.documents[0]!.content).not.toContain("Compacted hidden context");
    expect(result.documents[0]!.content).not.toContain("Unclassified automatic prompt");
    expect(result.documents[0]!.content).not.toContain("Unclassified automatic answer.");
  });

  // Each of these is session-adjacent state the parser recognises and handles
  // without reading a conversation out of it. A file holding only such records
  // never changes again, so a verdict of "unreadable" on one is permanent: the
  // root stays gapped and the conversations deleted beside it are never
  // reconciled.
  test.each([
    // A complete JSON record needs no terminal newline.
    '{"type":"started"}\n{"type":"result"}',
    '{"type":"started"}\n{"type":"failed"}\n',
    '{"type":"file-history-snapshot","messageId":"m1","snapshot":{}}',
    '{"type":"queue-operation","operation":"enqueue"}',
    '{"type":"ai-title","aiTitle":"A fictional title"}',
    '{"type":"custom-title","customTitle":"A fictional title"}',
    '{"type":"last-prompt","leafUuid":null,"explicit":true}',
  ])(
    "metadata-only files do not prevent reconciliation of removed conversations: %s",
    async (metadata) => {
      root = mkdtempSync(join(tmpdir(), "claude-code-sessions-"));
      const conversation = join(root, "conversation.jsonl");
      writeFileSync(
        conversation,
        `${JSON.stringify({
          ...base("user", "prompt", null),
          message: { role: "user", content: "Review the fictional widget" },
        })}\n`,
      );
      writeFileSync(join(root, "metadata.jsonl"), metadata);
      const instance = await source.create!({
        accountId: "local",
        sourceId: SOURCE_ID,
        providerId: PROVIDER_ID,
        config: { sessionsPath: root },
      });
      const first = await instance.sync(null);
      expect(first.documents).toHaveLength(1);
      expect(first.presentExternalIds).toEqual([first.documents[0]!.externalId]);
      expect(first.issues).toEqual([]);
      rmSync(conversation);
      const removed = await instance.sync(first.cursor);
      expect(removed.documents).toEqual([]);
      expect(removed.presentExternalIds).toEqual([]);
      expect(removed.issues).toEqual([]);
    },
  );

  test("a partial conversation after metadata preserves the same file's prior documents", async () => {
    root = mkdtempSync(join(tmpdir(), "claude-code-sessions-"));
    const filePath = join(root, "replacement.jsonl");
    writeFileSync(
      filePath,
      `${JSON.stringify({
        ...base("user", "original-prompt", null),
        message: { role: "user", content: "Keep the fictional checklist" },
      })}\n`,
    );
    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { sessionsPath: root },
    });
    const initial = await instance.sync(null);
    expect(initial.documents).toHaveLength(1);
    const identity = initial.documents[0]!.externalId;
    expect(initial.presentExternalIds).toEqual([identity]);

    writeFileSync(filePath, '{"type":"started"}\n{"type":"user",');
    const partial = await instance.sync(initial.cursor);
    expect(partial.documents).toEqual([]);
    expect(partial.presentExternalIds).toBeUndefined();
    expect(JSON.stringify(partial.cursor)).toContain(identity);

    writeFileSync(filePath, '{"type":"started"}\n{"type":"result"}');
    const completed = await instance.sync(partial.cursor);
    expect(completed.documents).toEqual([]);
    expect(completed.presentExternalIds).toEqual([]);
    expect(completed.issues).toEqual([]);
    expect(JSON.stringify(completed.cursor)).not.toContain(identity);
  });

  test.each([
    "",
    '{"type":"unrecognized-metadata"}\n',
    '{"type":"started"}\nnull\n',
    '{"type":"result"}\n{"broken":\n',
    '{"type":"started"}\n{"type":"user",',
    '{"type":"started"}\n{"type":"user","uuid":"prompt","parentUuid":null,"message":{"role":"user","content":"Unidentified prompt"}}\n',
    // Session state the parser recognises but that arrived damaged is not a
    // file it has read: recognising the type is not the same as reading it.
    '{"type":"custom-title"}\n',
    '{"type":"last-prompt","leafUuid":""}\n',
  ])("unidentified incomplete files still withhold snapshots: %s", async (content) => {
    root = mkdtempSync(join(tmpdir(), "claude-code-sessions-"));
    writeFileSync(join(root, "unidentified.jsonl"), content);
    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { sessionsPath: root },
    });
    const result = await instance.sync(null);
    expect(result.documents).toEqual([]);
    expect(result.presentExternalIds).toBeUndefined();
    expect(result.issues).not.toEqual([]);
  });

  test("withholds reconciliation after truncation or a JSON-valid malformed record", async () => {
    root = mkdtempSync(join(tmpdir(), "claude-code-sessions-"));
    const filePath = join(root, "claude-malformed.jsonl");
    const rows = [
      {
        ...base("user", "u1", null),
        message: { role: "user", content: "Keep prior prompt" },
      },
      { type: "last-prompt", sessionId: "claude-session-1", leafUuid: "u1" },
    ];
    writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { sessionsPath: root },
    });
    const first = await instance.sync(null);

    writeFileSync(filePath, "");
    const empty = await instance.sync(first.cursor);
    expect(empty.documents).toEqual([]);
    expect(empty.presentExternalIds).toBeUndefined();

    writeFileSync(filePath, "null\n");
    const invalidWithoutSession = await instance.sync(empty.cursor);
    expect(invalidWithoutSession.documents).toEqual([]);
    expect(invalidWithoutSession.presentExternalIds).toBeUndefined();

    writeFileSync(
      filePath,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n${JSON.stringify({
        ...base("user", "malformed-message", "u1"),
        message: null,
      })}\n`,
    );
    const malformed = await instance.sync(invalidWithoutSession.cursor);

    expect(malformed.documents).toEqual([]);
    expect(malformed.presentExternalIds).toBeUndefined();

    writeFileSync(
      filePath,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n${JSON.stringify({
        ...base("user", "invalid-parent", null),
        parentUuid: 42,
        message: { role: "user", content: "Invalid parent" },
      })}\n`,
    );
    const invalidParent = await instance.sync(malformed.cursor);
    expect(invalidParent.documents).toEqual([]);
    expect(invalidParent.presentExternalIds).toBeUndefined();

    writeFileSync(
      filePath,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n${JSON.stringify({
        ...base("user", "empty-parent", ""),
        message: { role: "user", content: "Empty parent" },
      })}\n`,
    );
    const emptyParent = await instance.sync(invalidParent.cursor);
    expect(emptyParent.documents).toEqual([]);
    expect(emptyParent.presentExternalIds).toBeUndefined();

    writeFileSync(
      filePath,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n${JSON.stringify({
        ...base("user", "dangling-parent", "missing-node"),
        message: { role: "user", content: "Dangling parent" },
      })}\n`,
    );
    const danglingParent = await instance.sync(emptyParent.cursor);
    expect(danglingParent.documents).toEqual([]);
    expect(danglingParent.presentExternalIds).toBeUndefined();

    writeFileSync(
      filePath,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n${JSON.stringify({
        ...base("user", "u1", null),
        message: { role: "user", content: "Duplicate id" },
      })}\n`,
    );
    const duplicateId = await instance.sync(danglingParent.cursor);
    expect(duplicateId.documents).toEqual([]);
    expect(duplicateId.presentExternalIds).toBeUndefined();

    writeFileSync(
      filePath,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n${JSON.stringify({
        ...base("user", "", "u1"),
        message: { role: "user", content: "Empty id" },
      })}\n`,
    );
    const emptyId = await instance.sync(duplicateId.cursor);
    expect(emptyId.documents).toEqual([]);
    expect(emptyId.presentExternalIds).toBeUndefined();

    writeFileSync(
      filePath,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n${JSON.stringify({
        type: "last-prompt",
        sessionId: "claude-session-1",
        leafUuid: "missing-leaf",
      })}\n`,
    );
    const missingLeaf = await instance.sync(emptyId.cursor);
    expect(missingLeaf.documents).toEqual([]);
    expect(missingLeaf.presentExternalIds).toBeUndefined();

    writeFileSync(
      filePath,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n${JSON.stringify({
        type: "last-prompt",
        sessionId: "claude-session-1",
        leafUuid: "",
      })}\n`,
    );
    const emptyLeaf = await instance.sync(missingLeaf.cursor);
    expect(emptyLeaf.documents).toEqual([]);
    expect(emptyLeaf.presentExternalIds).toBeUndefined();

    const cycleRows = [
      { ...base("progress", "cycle-a", "cycle-b") },
      { ...base("progress", "cycle-b", "cycle-a") },
    ];
    writeFileSync(
      filePath,
      `${[...rows, ...cycleRows].map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const cyclicGraph = await instance.sync(emptyLeaf.cursor);
    expect(cyclicGraph.documents).toEqual([]);
    expect(cyclicGraph.presentExternalIds).toBeUndefined();

    writeFileSync(
      filePath,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n${JSON.stringify({
        ...base("user", "invalid-content", "u1"),
        message: { role: "user", content: [null] },
      })}\n`,
    );
    const invalidContent = await instance.sync(cyclicGraph.cursor);
    expect(invalidContent.documents).toEqual([]);
    expect(invalidContent.presentExternalIds).toBeUndefined();
  });

  test("indexes appended complete records while Claude Code is writing the next JSONL line", async () => {
    root = mkdtempSync(join(tmpdir(), "claude-code-sessions-"));
    const filePath = join(root, "claude-live.jsonl");
    const initialRows = [
      {
        ...base("user", "u1", null),
        message: { role: "user", content: "Start the live session" },
      },
      {
        ...base("assistant", "a1", "u1"),
        message: {
          id: "msg-initial",
          role: "assistant",
          model: "claude-fictional",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Live session started." }],
        },
      },
      { type: "last-prompt", sessionId: "claude-session-1", leafUuid: "a1" },
    ];
    writeFileSync(filePath, `${initialRows.map((row) => JSON.stringify(row)).join("\n")}\n`);

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { sessionsPath: root },
    });
    const first = await instance.sync(null);

    const addedRows = [
      {
        ...base("user", "u2", "a1"),
        timestamp: iso(5),
        message: { role: "user", content: "Index the appended prompt" },
      },
      {
        ...base("assistant", "a2", "u2"),
        timestamp: iso(6),
        message: {
          id: "msg-appended",
          role: "assistant",
          model: "claude-fictional",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Appended prompt is indexed." }],
        },
      },
      { type: "last-prompt", sessionId: "claude-session-1", leafUuid: "a2" },
    ];
    writeFileSync(
      filePath,
      `${[...initialRows, ...addedRows].map((row) => JSON.stringify(row)).join("\n")}\n{"type":`,
    );

    const updated = await instance.sync(first.cursor);
    expect(updated.documents).toHaveLength(1);
    expect(updated.documents[0]!.content).toContain("Index the appended prompt");
    expect(updated.documents[0]!.content).toContain("Appended prompt is indexed.");
    expect(updated.presentExternalIds).toEqual([updated.documents[0]!.externalId]);
  });

  test("a long session with tens of thousands of tool nodes is read in full", async () => {
    // Every tool call and result is a node, so an ordinary long coding session
    // runs to tens of thousands of them. A cap set below that turned such a
    // session away whole: a fresh install indexed none of its days.
    root = mkdtempSync(join(tmpdir(), "claude-code-sessions-"));
    const toolNodes = 25_000;
    const rows: unknown[] = [
      {
        ...base("user", "start", null),
        timestamp: new Date(Date.UTC(2026, 0, 5, 9)).toISOString(),
        origin: { kind: "human" },
        message: { role: "user", content: "Start the long refactor" },
      },
      ...Array.from({ length: toolNodes }, (_, index) => ({
        ...base("progress", `tool-${index}`, index === 0 ? "start" : `tool-${index - 1}`),
      })),
      {
        ...base("user", "finish", `tool-${toolNodes - 1}`),
        timestamp: new Date(Date.UTC(2026, 0, 6, 9)).toISOString(),
        origin: { kind: "human" },
        message: { role: "user", content: "Wrap the refactor up" },
      },
      { type: "last-prompt", sessionId: "claude-session-1", leafUuid: "finish" },
    ];
    writeFileSync(
      join(root, "long.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { sessionsPath: root },
    });
    const result = await instance.sync(null);

    expect(result.documents.map((doc) => doc.externalId).sort()).toEqual([
      "cli:claude-session-1:2026-01-05",
      "cli:claude-session-1:2026-01-06",
    ]);
  });

  test("fails conservatively before retaining an unbounded node graph", async () => {
    root = mkdtempSync(join(tmpdir(), "claude-code-sessions-"));
    const rows = Array.from({ length: MAX_RETAINED_SESSION_RECORDS + 1 }, (_, index) => ({
      ...base("progress", `node-${index}`, index > 0 ? `node-${index - 1}` : null),
    }));
    writeFileSync(
      join(root, "bounded.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { sessionsPath: root },
    });
    const result = await instance.sync(null);

    expect(result.documents).toEqual([]);
    expect(result.presentExternalIds).toBeUndefined();
  });

  test("reports unresolved history coverage on every sync page", async () => {
    root = mkdtempSync(join(tmpdir(), "claude-code-sessions-"));
    const rows = [
      {
        ...base("user", "u1", null),
        message: { role: "user", content: "Track coverage" },
      },
    ];
    writeFileSync(
      join(root, "claude-coverage.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { sessionsPath: root },
    });
    const first = await instance.sync(null);
    expect(first.progress?.coverage).toBe("unknown");
    expect(first.progress?.detail).toBeTruthy();

    const settled = await instance.sync(first.cursor);
    expect(settled.hasMore).toBe(false);
    expect(settled.progress?.coverage).toBe("unknown");
  });
});

describe("Claude Code compaction", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function at(day: number, minute: number): string {
    return new Date(Date.UTC(2026, 0, day, 10, minute)).toISOString();
  }

  function node(type: string, uuid: string, parentUuid: string | null, timestamp: string) {
    return { ...base(type, uuid, parentUuid), timestamp };
  }

  function user(uuid: string, parentUuid: string | null, timestamp: string, text: string) {
    return {
      ...node("user", uuid, parentUuid, timestamp),
      origin: { kind: "human" },
      message: { role: "user", content: text },
    };
  }

  function assistant(uuid: string, parentUuid: string, timestamp: string, text: string) {
    return {
      ...node("assistant", uuid, parentUuid, timestamp),
      message: {
        id: `msg-${uuid}`,
        role: "assistant",
        model: "claude-fictional",
        stop_reason: "end_turn",
        content: [{ type: "text", text }],
      },
    };
  }

  /** The record Claude Code writes where it compacts: a fresh root that names what it continues. */
  function boundary(uuid: string, logicalParentUuid: string | undefined, timestamp: string) {
    return {
      ...node("system", uuid, null, timestamp),
      subtype: "compact_boundary",
      content: "Conversation compacted",
      ...(logicalParentUuid === undefined ? {} : { logicalParentUuid }),
    };
  }

  async function syncRows(rows: unknown[]) {
    const root = mkdtempSync(join(tmpdir(), "omnesis-claude-compaction-"));
    roots.push(root);
    writeFileSync(
      join(root, "claude-session-1.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { sessionsPath: root },
    });
    return instance.sync(null);
  }

  const beforeCompaction = [
    user("d1u", null, at(5, 0), "Draft the ingest plan"),
    assistant("d1a", "d1u", at(5, 1), "Plan drafted for the harbour tier."),
  ];
  const afterCompaction = [
    user("d2u", "d2b", at(6, 0), "Now review the plan"),
    assistant("d2a", "d2u", at(6, 1), "Review done; two risks noted."),
  ];

  test("a compacted session keeps the days before the compaction", async () => {
    // Claude Code starts the continuation as a new root and records what it
    // continues in `logicalParentUuid`. Stopping at the root read the session
    // as though it began at the compaction — and reported the file complete,
    // so the earlier days vanished from a fresh read with nothing to show it.
    const result = await syncRows([
      ...beforeCompaction,
      boundary("d2b", "d1a", at(6, 0)),
      ...afterCompaction,
      { type: "last-prompt", sessionId: "claude-session-1", leafUuid: "d2a" },
    ]);

    const ids = result.documents.map((doc) => doc.externalId).sort();
    expect(ids).toEqual(["cli:claude-session-1:2026-01-05", "cli:claude-session-1:2026-01-06"]);
    const dayOne = result.documents.find((doc) => doc.externalId.endsWith("2026-01-05"))!;
    expect(dayOne.content).toContain("Draft the ingest plan");
    expect(dayOne.content).toContain("Plan drafted for the harbour tier.");
  });

  test("a bridge into the continuation resumes from the tip the boundary found", async () => {
    // Claude Code can name, as the message a compaction continues from, one it
    // carries across and writes after the boundary, beneath the continuation.
    // Following that bridge loops back to the boundary; the history before the
    // compaction still ends where the conversation stood when it was written.
    const result = await syncRows([
      ...beforeCompaction,
      boundary("d2b", "d2c", at(6, 0)),
      user("d2u", "d2b", at(6, 0), "Now review the plan"),
      { ...node("attachment", "d2c", "d2u", at(5, 2)), attachment: { type: "todo_reminder" } },
      assistant("d2a", "d2c", at(6, 1), "Review done; two risks noted."),
      { type: "last-prompt", sessionId: "claude-session-1", leafUuid: "d2a" },
    ]);

    const cursor = result.cursor as { files?: Record<string, { complete?: boolean }> };
    expect(Object.values(cursor.files ?? {}).map((file) => file.complete)).toEqual([true]);
    const ids = result.documents.map((doc) => doc.externalId).sort();
    expect(ids).toEqual(["cli:claude-session-1:2026-01-05", "cli:claude-session-1:2026-01-06"]);
    const dayOne = result.documents.find((doc) => doc.externalId.endsWith("2026-01-05"))!;
    expect(dayOne.content).toContain("Draft the ingest plan");
  });

  test("a bridge to a record the file does not hold fails the file closed", async () => {
    // The pre-compaction history is gone, so the session cannot be read in
    // full. Reporting what survives as the whole session is the failure this
    // guards against.
    const result = await syncRows([
      boundary("d2b", "missing-predecessor", at(6, 0)),
      ...afterCompaction,
      { type: "last-prompt", sessionId: "claude-session-1", leafUuid: "d2a" },
    ]);

    const cursor = result.cursor as { files?: Record<string, { complete?: boolean }> };
    const files = Object.values(cursor.files ?? {});
    expect(files).toHaveLength(1);
    expect(files[0]!.complete).toBe(false);
  });

  test("only a compaction boundary may bridge chains", async () => {
    // Honouring the field anywhere would let an arbitrary record splice
    // unrelated history into a transcript.
    const notABoundary = { ...node("system", "d2b", null, at(6, 0)), logicalParentUuid: "d1a" };
    const result = await syncRows([
      ...beforeCompaction,
      notABoundary,
      ...afterCompaction,
      { type: "last-prompt", sessionId: "claude-session-1", leafUuid: "d2a" },
    ]);

    expect(result.documents.map((doc) => doc.externalId)).toEqual([
      "cli:claude-session-1:2026-01-06",
    ]);
  });
});

describe("Claude Code forked subagents", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("a fork's first message may continue from another agent's transcript", async () => {
    // A forked subagent's file starts from a message held in the file of the
    // agent it was forked from. Reading that edge as a lost record failed the
    // file closed, which paused deletion detection for every session under
    // the root, for good.
    const root = mkdtempSync(join(tmpdir(), "omnesis-claude-fork-"));
    roots.push(root);
    const sidechain = (type: string, uuid: string, parentUuid: string, content: string) => ({
      ...base(type, uuid, parentUuid),
      isSidechain: true,
      message: { role: type, content },
    });
    writeFileSync(
      join(root, "agent-fork.jsonl"),
      `${[
        sidechain("user", "f1", "message-in-parent-agent", "Continue with the review"),
        sidechain("assistant", "f2", "f1", "Review continued."),
      ]
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );
    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { sessionsPath: root },
    });

    const result = await instance.sync(null);

    const cursor = result.cursor as { files?: Record<string, { complete?: boolean }> };
    expect(Object.values(cursor.files ?? {}).map((file) => file.complete)).toEqual([true]);
  });
});
