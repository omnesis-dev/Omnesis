// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MAX_RETAINED_SESSION_RECORDS } from "@omnesis/source-sdk/local-agent-sessions";
import { ProviderId, SourceId } from "@omnesis/types";
import source from "./index.js";

const SOURCE_ID = SourceId("pi:local");
const PROVIDER_ID = ProviderId("pi:local");

function at(hour: number): number {
  return new Date(2026, 0, 6, hour, 0).getTime();
}

function entry(
  id: string,
  parentId: string | null,
  role: "user" | "assistant" | "toolResult",
  content: Array<Record<string, unknown>>,
  stopReason?: string,
): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(at(9)).toISOString(),
    message: {
      role,
      content,
      timestamp: at(9),
      ...(role === "assistant" ? { provider: "fictional", model: "code-model", stopReason } : {}),
    },
  };
}

describe("Pi session source", () => {
  let root: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  test("advertises Pi's first-party icon", () => {
    expect(source.primaryCount).toBe("documents");
    expect(source.unitName).toBe("conversation days");
    expect(source.icon).toMatchObject({
      sfSymbol: "terminal.fill",
      color: "#FFFFFF",
      bgColor: "#09090B",
      url: "https://pi.dev/favicon.svg",
    });
  });

  test("declares partitioned device streams and a member-local sessions path", () => {
    expect(source.multiDevice).toEqual({ mode: "partitioned" });
    expect(source.params?.find((param) => param.name === "sessionsPath")?.scope).toBe("member");
  });

  test("indexes only user turns and final assistant answers on the active branch", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-sessions-"));
    const rows = [
      {
        type: "session",
        version: 3,
        id: "pi-session-1",
        timestamp: new Date(at(8)).toISOString(),
        cwd: "/work/northstar-cli",
      },
      entry("a0", null, "assistant", [{ type: "text", text: "Unpaired completed answer" }], "stop"),
      entry("u1", "a0", "user", [{ type: "text", text: "Inspect parser behavior" }]),
      entry(
        "a1",
        "u1",
        "assistant",
        [
          { type: "thinking", thinking: "hidden reasoning" },
          { type: "text", text: "I will inspect files." },
          { type: "toolCall", id: "tool-1", name: "read", arguments: {} },
        ],
        "toolUse",
      ),
      entry("t1", "a1", "toolResult", [{ type: "text", text: "private tool output" }]),
      entry("a2", "t1", "assistant", [{ type: "text", text: "Abandoned branch answer" }], "stop"),
      entry("u2", "u1", "user", [{ type: "text", text: "Use the smaller fix" }]),
      entry(
        "a3",
        "u2",
        "assistant",
        [{ type: "text", text: "Smaller fix keeps parser stable." }],
        "stop",
      ),
      {
        type: "session_info",
        id: "name1",
        parentId: "a3",
        timestamp: new Date(at(10)).toISOString(),
        name: "Parser cleanup",
      },
    ];
    writeFileSync(
      join(root, "pi-session.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { sessionsPath: root },
    });
    const result = await instance.sync(null);

    expect(source.id).toBe("pi");
    expect(source.singleInstance).toBe(true);
    expect(instance.watchFileExtensions).toEqual([".jsonl"]);
    expect(result.documents).toHaveLength(1);

    const doc = result.documents[0]!;
    expect(doc.externalId).toBe("cli:pi-session-1:2026-01-06");
    expect(doc.title).toContain("Parser cleanup · northstar-cli");
    expect(doc.content).toContain("Inspect parser behavior");
    expect(doc.content).toContain("Use the smaller fix");
    expect(doc.content).toContain("Smaller fix keeps parser stable.");
    expect(doc.content).not.toContain("hidden reasoning");
    expect(doc.content).not.toContain("Unpaired completed answer");
    expect(doc.content).not.toContain("I will inspect files.");
    expect(doc.content).not.toContain("private tool output");
    expect(doc.content).not.toContain("Abandoned branch answer");
    expect(doc.metadata.extra).toMatchObject({
      project: "northstar-cli",
      model: "fictional/code-model",
      provenance: "local-session-file",
    });
  });

  test("keeps legacy linear sessions that have no entry IDs", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-sessions-"));
    const rows = [
      {
        type: "session",
        version: 1,
        id: "pi-legacy-session",
        timestamp: new Date(at(8)).toISOString(),
        cwd: "/work/riverside-tools",
      },
      {
        type: "message",
        timestamp: new Date(at(9)).toISOString(),
        message: {
          role: "user",
          content: "Explain the migration",
          timestamp: at(9),
        },
      },
      {
        type: "message",
        timestamp: new Date(at(10)).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Migration keeps prior sessions readable." }],
          provider: "fictional",
          model: "code-model",
          stopReason: "stop",
          timestamp: at(10),
        },
      },
    ];
    writeFileSync(
      join(root, "legacy.jsonl"),
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
    expect(result.documents[0]!.content).toContain("Explain the migration");
    expect(result.documents[0]!.content).toContain("Migration keeps prior sessions readable.");
  });

  test("retries a malformed changed file without replacing its last good document", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-sessions-"));
    const filePath = join(root, "active.jsonl");
    const header = {
      type: "session",
      version: 3,
      id: "pi-incremental",
      timestamp: new Date(at(8)).toISOString(),
      cwd: "/work/riverside-tools",
    };
    const initialRows = [
      header,
      entry("u1", null, "user", [{ type: "text", text: "Start the parser check" }]),
      entry(
        "a1",
        "u1",
        "assistant",
        [{ type: "text", text: "Initial parser check passed." }],
        "stop",
      ),
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
      entry("u2", "a1", "user", [{ type: "text", text: "Check the appended turn" }]),
      entry("a2", "u2", "assistant", [{ type: "text", text: "Appended turn is indexed." }], "stop"),
    ];
    writeFileSync(
      filePath,
      `${initialRows.map((row) => JSON.stringify(row)).join("\n")}\nnot-json\n${addedRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const malformed = await instance.sync(first.cursor);
    expect(malformed.documents).toEqual([]);
    expect(malformed.presentExternalIds).toBeUndefined();

    writeFileSync(
      filePath,
      `${[...initialRows, ...addedRows].map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const repaired = await instance.sync(malformed.cursor);
    expect(repaired.documents).toHaveLength(1);
    expect(repaired.documents[0]!.content).toContain("Check the appended turn");
    expect(repaired.documents[0]!.content).toContain("Appended turn is indexed.");
  });

  test("does not index assistant replies truncated by the model limit", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-sessions-"));
    const rows = [
      {
        type: "session",
        version: 3,
        id: "pi-truncated-session",
        timestamp: new Date(at(8)).toISOString(),
        cwd: "/work/riverside-tools",
      },
      entry("u1", null, "user", [{ type: "text", text: "Produce the complete report" }]),
      entry(
        "a1",
        "u1",
        "assistant",
        [{ type: "text", text: "Truncated partial answer" }],
        "length",
      ),
      entry("a2", "a1", "assistant", [{ type: "text", text: "Unmarked assistant answer" }]),
    ];
    writeFileSync(
      join(root, "truncated.jsonl"),
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
    expect(result.documents[0]!.content).toContain("Produce the complete report");
    expect(result.documents[0]!.content).not.toContain("Truncated partial answer");
    expect(result.documents[0]!.content).not.toContain("Unmarked assistant answer");
  });

  test("withholds reconciliation after a JSON-valid malformed record", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-sessions-"));
    const filePath = join(root, "pi-malformed.jsonl");
    const rows = [
      {
        type: "session",
        version: 3,
        id: "pi-malformed-session",
        timestamp: new Date(at(8)).toISOString(),
        cwd: "/work/example-project",
      },
      entry("u1", null, "user", [{ type: "text", text: "Keep prior prompt" }]),
    ];
    writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { sessionsPath: root },
    });
    const first = await instance.sync(null);

    writeFileSync(
      filePath,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n${JSON.stringify({
        type: "message",
        id: "malformed-message",
        parentId: "u1",
        timestamp: new Date(at(9)).toISOString(),
        message: null,
      })}\n`,
    );
    const malformed = await instance.sync(first.cursor);

    expect(malformed.documents).toEqual([]);
    expect(malformed.presentExternalIds).toBeUndefined();

    writeFileSync(
      filePath,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n${JSON.stringify({
        type: "message",
        id: "invalid-parent",
        parentId: 42,
        timestamp: new Date(at(9)).toISOString(),
        message: { role: "user", content: "Invalid parent" },
      })}\n`,
    );
    const invalidParent = await instance.sync(malformed.cursor);
    expect(invalidParent.documents).toEqual([]);
    expect(invalidParent.presentExternalIds).toBeUndefined();

    writeFileSync(
      filePath,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n${JSON.stringify({
        type: "message",
        id: "empty-parent",
        parentId: "",
        timestamp: new Date(at(9)).toISOString(),
        message: { role: "user", content: "Empty parent" },
      })}\n`,
    );
    const emptyParent = await instance.sync(invalidParent.cursor);
    expect(emptyParent.documents).toEqual([]);
    expect(emptyParent.presentExternalIds).toBeUndefined();

    writeFileSync(
      filePath,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n${JSON.stringify({
        type: "message",
        id: "dangling-parent",
        parentId: "missing-node",
        timestamp: new Date(at(9)).toISOString(),
        message: { role: "user", content: "Dangling parent" },
      })}\n`,
    );
    const danglingParent = await instance.sync(emptyParent.cursor);
    expect(danglingParent.documents).toEqual([]);
    expect(danglingParent.presentExternalIds).toBeUndefined();

    writeFileSync(
      filePath,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n${JSON.stringify({
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: new Date(at(9)).toISOString(),
        message: { role: "user", content: "Duplicate id" },
      })}\n`,
    );
    const duplicateId = await instance.sync(danglingParent.cursor);
    expect(duplicateId.documents).toEqual([]);
    expect(duplicateId.presentExternalIds).toBeUndefined();

    writeFileSync(
      filePath,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n${JSON.stringify({
        type: "message",
        id: "",
        parentId: "u1",
        timestamp: new Date(at(9)).toISOString(),
        message: { role: "user", content: "Empty id" },
      })}\n`,
    );
    const emptyId = await instance.sync(duplicateId.cursor);
    expect(emptyId.documents).toEqual([]);
    expect(emptyId.presentExternalIds).toBeUndefined();

    const cycleRows = [
      {
        type: "session_info",
        id: "cycle-a",
        parentId: "cycle-b",
        timestamp: new Date(at(9)).toISOString(),
      },
      {
        type: "session_info",
        id: "cycle-b",
        parentId: "cycle-a",
        timestamp: new Date(at(9)).toISOString(),
      },
    ];
    writeFileSync(
      filePath,
      `${[...rows, ...cycleRows].map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const cyclicGraph = await instance.sync(emptyId.cursor);
    expect(cyclicGraph.documents).toEqual([]);
    expect(cyclicGraph.presentExternalIds).toBeUndefined();

    writeFileSync(
      filePath,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n${JSON.stringify({
        type: "message",
        id: "invalid-content",
        parentId: "u1",
        timestamp: new Date(at(9)).toISOString(),
        message: { role: "toolResult", content: [null] },
      })}\n`,
    );
    const invalidContent = await instance.sync(cyclicGraph.cursor);
    expect(invalidContent.documents).toEqual([]);
    expect(invalidContent.presentExternalIds).toBeUndefined();
  });

  test("honors Pi's agent-directory environment override", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-agent-"));
    const agentDir = join(root, "agent");
    const sessionsDir = join(agentDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      // The source reads its directory from the environment here; the
      // schema field is optional, so an empty config is the whole answer.
      config: {},
    });

    expect(instance.watchPaths).toEqual([sessionsDir]);
  });

  test("resolves a relative settings sessionDir like Pi does", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-agent-"));
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ sessionDir: "relative-pi-sessions" }),
    );
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      // The source reads its directory from the environment here; the
      // schema field is optional, so an empty config is the whole answer.
      config: {},
    });

    expect(instance.watchPaths).toEqual([resolve(process.cwd(), "relative-pi-sessions")]);
  });

  test("honors Pi's session-directory environment override", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-sessions-"));
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", root);

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      // The source reads its directory from the environment here; the
      // schema field is optional, so an empty config is the whole answer.
      config: {},
    });

    expect(instance.watchPaths).toEqual([root]);
  });

  test("fails conservatively before retaining an unbounded node graph", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-sessions-"));
    const rows = [
      {
        type: "session",
        version: 3,
        id: "pi-bounded-session",
        timestamp: new Date(at(8)).toISOString(),
        cwd: "/work/example-project",
      },
      ...Array.from({ length: MAX_RETAINED_SESSION_RECORDS + 1 }, (_, index) => ({
        type: "session_info",
        id: `node-${index}`,
        parentId: index > 0 ? `node-${index - 1}` : null,
        timestamp: new Date(at(9)).toISOString(),
      })),
    ];
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

  test("skips a session file with no valid header and still ingests its sibling", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-sessions-"));
    // No `session`-typed record at all — parsePiSession throws a SyncError
    // before a header is ever captured.
    writeFileSync(
      join(root, "pi-no-header.jsonl"),
      `${JSON.stringify(entry("u0", null, "user", [{ type: "text", text: "Orphan message" }]))}\n`,
    );
    const sibling = [
      {
        type: "session",
        version: 3,
        id: "pi-sibling-session",
        timestamp: new Date(at(8)).toISOString(),
        cwd: "/work/example-project",
      },
      entry("u1", null, "user", [{ type: "text", text: "Hello from the sibling session" }]),
      entry(
        "a1",
        "u1",
        "assistant",
        [{ type: "text", text: "Reply from the sibling session" }],
        "stop",
      ),
    ];
    writeFileSync(
      join(root, "pi-sibling.jsonl"),
      `${sibling.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );

    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { sessionsPath: root },
    });
    const result = await instance.sync(null);

    expect(result.documents).toHaveLength(1);
    expect(result.presentExternalIds).toBeUndefined();
  });

  test("reports unresolved history coverage on every sync page", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-sessions-"));
    const rows = [
      {
        type: "session",
        version: 3,
        id: "pi-coverage-session",
        timestamp: new Date(at(8)).toISOString(),
        cwd: "/work/example-project",
      },
      entry("u1", null, "user", [{ type: "text", text: "Track coverage" }]),
    ];
    writeFileSync(
      join(root, "pi-coverage.jsonl"),
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
