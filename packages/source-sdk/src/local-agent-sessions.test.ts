// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  appendFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import {
  createLocalAgentSessionDocumentEventProfile,
  createLocalAgentSessionRetentionGuard,
  AGENT_SESSION_WATCH_QUIET_MS,
  createLocalAgentSessionSource,
  MAX_RETAINED_SESSION_BYTES,
  readJsonLines,
  type LocalAgentSessionAdapter,
  type LocalAgentSessionCursor,
  type ParsedLocalAgentSession,
} from "./local-agent-sessions.js";
import { validateDocumentEventProfile } from "./structured-source.js";

const PROVIDER = ProviderId("fictional-agent:local");
const SOURCE = SourceId("fictional-agent:local");

interface FixtureLine {
  role: "user" | "assistant";
  text: string;
  atMs: number;
}

function isFixtureLine(value: unknown): value is FixtureLine {
  if (!value || typeof value !== "object") return false;
  const line = value as Record<string, unknown>;
  return (
    (line.role === "user" || line.role === "assistant") &&
    typeof line.text === "string" &&
    typeof line.atMs === "number"
  );
}

describe("createLocalAgentSessionSource", () => {
  let root: string | undefined;

  test.each([
    ['{"kind":"metadata"}', 0, false],
    ['{"kind":"metadata"}\n{"unfinished":', 0, true],
    ['{"kind":"metadata"}\n{"invalid":\n', 1, false],
  ])(
    "reports unfinished JSON separately from malformed records: %s",
    async (content, malformedLines, trailingPartial) => {
      root = mkdtempSync(join(tmpdir(), "local-agent-lines-"));
      const file = join(root, "records.jsonl");
      writeFileSync(file, content);
      const visit = vi.fn();
      expect(await readJsonLines(file, visit)).toEqual({ malformedLines, trailingPartial });
      expect(visit).toHaveBeenCalledTimes(1);
    },
  );

  test("fresh access probes session files without invoking the parser", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-access-"));
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "session.jsonl"), "not valid JSON");
    const parseSession = vi.fn<LocalAgentSessionAdapter["parseSession"]>();
    const instance = createLocalAgentSessionSource({
      sourceId: SOURCE,
      providerId: PROVIDER,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "fixture-agent",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        parseSession,
      },
    });
    expect(await instance.probeReadAccess!({ signal: new AbortController().signal })).toEqual({
      status: "readable",
    });
    expect(parseSession).not.toHaveBeenCalled();
    rmSync(root, { recursive: true });
    expect(await instance.probeReadAccess!({ signal: new AbortController().signal })).toEqual({
      status: "unavailable",
    });
    mkdirSync(root);
    expect(await instance.probeReadAccess!({ signal: new AbortController().signal })).toEqual({
      status: "readable",
    });
  });

  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  test("bounds aggregate retained fields, not only message text", () => {
    const retain = createLocalAgentSessionRetentionGuard();
    const identifierChunk = "x".repeat(Math.floor(MAX_RETAINED_SESSION_BYTES / 2) + 1);

    retain(identifierChunk);

    expect(() => retain(identifierChunk)).toThrow("retained bytes");
  });

  test("accounts keyed replacement bytes without counting replayed records twice", () => {
    const retain = createLocalAgentSessionRetentionGuard();
    const identifierChunk = "x".repeat(Math.floor(MAX_RETAINED_SESSION_BYTES / 2) + 1);

    retain.upsert("session-node", identifierChunk);
    expect(() => retain.upsert("session-node", identifierChunk)).not.toThrow();
    expect(() => retain(identifierChunk)).toThrow("retained bytes");
  });

  test("includes keyed retention-map keys in the retained-byte ceiling", () => {
    const retain = createLocalAgentSessionRetentionGuard();
    const oversizedKey = "k".repeat(MAX_RETAINED_SESSION_BYTES + 1);

    expect(() => retain.upsert(oversizedKey)).toThrow("retained bytes");
  });

  test("streams one native session into searchable local-day conversation documents", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const atMs = new Date(2026, 0, 2, 10, 30).getTime();
    writeFileSync(
      join(root, "session.jsonl"),
      [
        JSON.stringify({ role: "user", text: "Review the Northstar parser", atMs }),
        JSON.stringify({
          role: "assistant",
          text: "Parser handles the fixture.",
          atMs: atMs + 60_000,
        }),
        "",
      ].join("\n"),
    );

    const adapter: LocalAgentSessionAdapter = {
      harnessId: "fictional-agent",
      agentName: "Nova",
      roots: [{ path: root }],
      fileExtensions: [".jsonl"],
      parserVersion: 1,
      async parseSession(filePath, options): Promise<ParsedLocalAgentSession> {
        const messages: ParsedLocalAgentSession["messages"] = [];
        const read = await readJsonLines(
          filePath,
          (line) => {
            if (isFixtureLine(line)) messages.push(line);
          },
          { signal: options.signal },
        );
        return {
          id: "session-1",
          cwd: "/work/northstar-cli",
          name: "Parser review",
          branch: "feat/parser",
          model: "fictional/model",
          parentSessionId: "parent-1",
          messages,
          complete: read.malformedLines === 0,
        };
      },
    };

    const instance = createLocalAgentSessionSource({
      adapter,
      providerId: PROVIDER,
      sourceId: SOURCE,
    });
    const result = await instance.sync(null);

    expect(instance.watchPaths).toEqual([root]);
    expect(instance.watchDirectoryPaths).toEqual([root]);
    expect(instance.watchFileExtensions).toEqual([".jsonl"]);
    expect(result.hasMore).toBe(false);
    expect(result.documents).toHaveLength(1);

    const doc = result.documents[0]!;
    expect(doc.externalId).toBe("cli:session-1:2026-01-02");
    expect(doc.title).toContain("Parser review · northstar-cli");
    expect(doc.content).toContain("Review the Northstar parser");
    expect(doc.content).toContain("Parser handles the fixture.");
    expect(doc.metadata.tags).toEqual(["fictional-agent", "cli", "northstar-cli"]);
    expect(doc.metadata.sourceUrl).toBeUndefined();
    expect(doc.metadata.appUrl).toBeUndefined();
    expect(doc.metadata.extra).toMatchObject({
      agent: "Nova",
      chatId: "session-1",
      project: "northstar-cli",
      cwd: "/work/northstar-cli",
      branch: "feat/parser",
      model: "fictional/model",
      parentSessionId: "parent-1",
      provenance: "local-session-file",
      messageCount: 2,
    });
    expect(result.presentExternalIds).toEqual([doc.externalId]);
    expect(result.watermark?.guarantee).toBe("best-effort-scan");
    const serializedCursor = JSON.stringify(result.cursor);
    expect(serializedCursor).not.toContain(root);
    expect(serializedCursor).not.toContain("session.jsonl");
  });

  test("drops path-keyed legacy cursor state when the configured root is unavailable", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const missingRoot = join(root, "missing", "sessions");
    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: missingRoot }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(): Promise<ParsedLocalAgentSession> {
          throw new Error("parser must not run");
        },
      },
    });
    const legacyPath = "/private/legacy/session.jsonl";
    const legacyCursor = {
      version: 1,
      scanKey: "legacy",
      files: {
        [legacyPath]: {
          size: 1,
          mtimeMs: 1,
          externalIds: ["cli:legacy:2026-01-01"],
          complete: true,
        },
      },
    } as unknown as LocalAgentSessionCursor;

    const result = await instance.sync(legacyCursor);
    expect(result.presentExternalIds).toBeUndefined();
    expect(JSON.stringify(result.cursor)).not.toContain(legacyPath);
  });

  test("does not reread unchanged transcript files", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const atMs = new Date(2026, 0, 3, 9, 0).getTime();
    const filePath = join(root, "session.jsonl");
    writeFileSync(filePath, `${JSON.stringify({ role: "user", text: "Check the cache", atMs })}\n`);
    let parseCalls = 0;

    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(path): Promise<ParsedLocalAgentSession> {
          parseCalls += 1;
          const messages: ParsedLocalAgentSession["messages"] = [];
          await readJsonLines(path, (line) => {
            if (isFixtureLine(line)) messages.push(line);
          });
          return { id: "session-cache", messages };
        },
      },
    });

    const first = await instance.sync(null);
    const second = await instance.sync(first.cursor);

    expect(parseCalls).toBe(1);
    expect(second.documents).toEqual([]);
    expect(second.presentExternalIds).toEqual(first.presentExternalIds);
  });

  test("pages changed files and publishes reconciliation only on the final page", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const atMs = new Date(2026, 0, 4, 11, 0).getTime();
    const sessionIds = Array.from(
      { length: 11 },
      (_, index) => `session-${String(index).padStart(2, "0")}`,
    );
    for (const sessionId of sessionIds) {
      writeFileSync(
        join(root, `${sessionId}.jsonl`),
        `${JSON.stringify({ sessionId, role: "user", text: `Prompt ${sessionId}`, atMs })}\n`,
      );
    }

    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(path): Promise<ParsedLocalAgentSession> {
          let id = "";
          const messages: ParsedLocalAgentSession["messages"] = [];
          await readJsonLines(path, (value) => {
            if (!isFixtureLine(value)) return;
            const line = value as FixtureLine & { sessionId?: unknown };
            if (typeof line.sessionId === "string") id = line.sessionId;
            messages.push(line);
          });
          return { id, messages };
        },
      },
    });

    const first = await instance.sync(null);
    expect(first.hasMore).toBe(true);
    expect(first.documents).toHaveLength(10);
    expect(first.presentExternalIds).toBeUndefined();
    expect(first.progress?.phase).toBe("bootstrap");

    const second = await instance.sync(first.cursor);
    expect(second.hasMore).toBe(false);
    expect(second.progress?.phase).toBe("bootstrap");
    expect(second.documents).toHaveLength(1);
    expect(second.presentExternalIds?.sort()).toEqual(
      sessionIds.map((sessionId) => `cli:${sessionId}:2026-01-04`),
    );
  });

  test.each(["deleted", "replaced"] as const)(
    "publishes a snapshot only when no processed file vanished between pages (%s)",
    async (mutation) => {
      root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
      const atMs = new Date(2026, 0, 4, 11, 0).getTime();
      const sessionIds = Array.from(
        { length: 11 },
        (_, index) => `moving-${String(index).padStart(2, "0")}`,
      );
      for (const sessionId of sessionIds) {
        writeFileSync(
          join(root, `${sessionId}.jsonl`),
          `${JSON.stringify({ sessionId, role: "user", text: `Prompt ${sessionId}`, atMs })}\n`,
        );
      }

      const instance = createLocalAgentSessionSource({
        providerId: PROVIDER,
        sourceId: SOURCE,
        adapter: {
          harnessId: "fictional-agent",
          agentName: "Nova",
          roots: [{ path: root }],
          fileExtensions: [".jsonl"],
          parserVersion: 1,
          async parseSession(path): Promise<ParsedLocalAgentSession> {
            let id = "";
            const messages: ParsedLocalAgentSession["messages"] = [];
            await readJsonLines(path, (value) => {
              if (!isFixtureLine(value)) return;
              const line = value as FixtureLine & { sessionId?: unknown };
              if (typeof line.sessionId === "string") id = line.sessionId;
              messages.push(line);
            });
            return { id, messages };
          },
        },
      });

      const first = await instance.sync(null);
      const processedSessionId = String(first.documents[0]!.metadata.extra?.chatId);
      const processedPath = join(root, `${processedSessionId}.jsonl`);
      if (mutation === "deleted") {
        rmSync(processedPath, { force: true });
      } else {
        writeFileSync(
          processedPath,
          `${JSON.stringify({
            sessionId: "replacement-session",
            role: "user",
            text: "Replacement prompt",
            atMs,
          })}\n`,
        );
      }
      const second = await instance.sync(first.cursor);

      expect(first.hasMore).toBe(true);
      expect(second.hasMore).toBe(false);
      if (mutation === "deleted") {
        expect(second.presentExternalIds).toBeUndefined();
      } else {
        // A rewritten file still exists, so the documents already taken from
        // it stay claimed — claiming too much delays a deletion, never causes
        // one — and the next cycle reparses it.
        expect(second.presentExternalIds?.sort()).toEqual(
          sessionIds.map((sessionId) => `cli:${sessionId}:2026-01-04`),
        );
        const third = await instance.sync(second.cursor);
        expect(third.documents.map((d) => d.metadata.extra?.chatId)).toContain(
          "replacement-session",
        );
      }
    },
  );

  test("reparses a same-size replacement that preserves the prior mtime", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const filePath = join(root, "replace.jsonl");
    const replacementPath = join(root, "replacement.tmp");
    const atMs = new Date(2026, 0, 5, 10, 0).getTime();
    const fixedMtime = new Date(2026, 0, 5, 11, 0);
    const line = (text: string) => `${JSON.stringify({ role: "user", text, atMs })}\n`;
    writeFileSync(filePath, line("Original prompt"));
    utimesSync(filePath, fixedMtime, fixedMtime);

    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(path): Promise<ParsedLocalAgentSession> {
          const messages: ParsedLocalAgentSession["messages"] = [];
          await readJsonLines(path, (value) => {
            if (isFixtureLine(value)) messages.push(value);
          });
          return { id: "replace-session", messages };
        },
      },
    });

    const first = await instance.sync(null);
    writeFileSync(replacementPath, line("Replaced prompt"));
    utimesSync(replacementPath, fixedMtime, fixedMtime);
    renameSync(replacementPath, filePath);
    const second = await instance.sync(first.cursor);

    expect(second.documents).toHaveLength(1);
    expect(second.documents[0]!.content).toContain("Replaced prompt");
    expect(second.documents[0]!.content).not.toContain("Original prompt");
  });

  test("refuses a transcript replaced by a symlink after discovery", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const sessions = join(root, "sessions");
    mkdirSync(sessions);
    const filePath = join(sessions, "session.jsonl");
    const outsidePath = join(root, "outside.jsonl");
    const atMs = new Date(2026, 0, 5, 9).getTime();
    writeFileSync(filePath, `${JSON.stringify({ role: "user", text: "Safe prompt", atMs })}\n`);
    writeFileSync(
      outsidePath,
      `${JSON.stringify({ role: "user", text: "Outside-root content", atMs })}\n`,
    );

    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: sessions }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(path, options): Promise<ParsedLocalAgentSession> {
          rmSync(path, { force: true });
          symlinkSync(outsidePath, path);
          const messages: ParsedLocalAgentSession["messages"] = [];
          await readJsonLines(
            path,
            (line) => {
              if (isFixtureLine(line)) messages.push(line);
            },
            options,
          );
          return { id: "swapped-session", messages };
        },
      },
    });

    const result = await instance.sync(null);

    expect(result.documents).toEqual([]);
    expect(result.presentExternalIds).toBeUndefined();
  });

  test("ignores hard-linked transcripts from outside the configured root", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const sessions = join(root, "sessions");
    mkdirSync(sessions);
    const outsidePath = join(root, "outside.jsonl");
    const linkedPath = join(sessions, "linked.jsonl");
    const atMs = new Date(2026, 0, 5, 9).getTime();
    writeFileSync(
      outsidePath,
      `${JSON.stringify({ role: "user", text: "Outside hard-linked content", atMs })}\n`,
    );
    linkSync(outsidePath, linkedPath);
    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: sessions }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(): Promise<ParsedLocalAgentSession> {
          throw new Error("hard-linked file must not be parsed");
        },
      },
    });

    const result = await instance.sync(null);

    expect(result.documents).toEqual([]);
    expect(result.presentExternalIds).toBeUndefined();
  });

  test("refuses a regular transcript replaced after discovery", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const filePath = join(root, "session.jsonl");
    const atMs = new Date(2026, 0, 5, 9).getTime();
    writeFileSync(filePath, `${JSON.stringify({ role: "user", text: "First prompt", atMs })}\n`);

    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(path, options): Promise<ParsedLocalAgentSession> {
          writeFileSync(
            path,
            `${JSON.stringify({ role: "user", text: "Replacement prompt", atMs })}\n`,
          );
          const messages: ParsedLocalAgentSession["messages"] = [];
          await readJsonLines(
            path,
            (line) => {
              if (isFixtureLine(line)) messages.push(line);
            },
            options,
          );
          return { id: "swapped-session", messages };
        },
      },
    });

    const result = await instance.sync(null);

    expect(result.documents).toEqual([]);
    expect(result.presentExternalIds).toBeUndefined();
  });

  test("indexes complete lines while an active file has an unterminated trailing write", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const atMs = new Date(2026, 0, 5, 12, 0).getTime();
    const filePath = join(root, "active.jsonl");
    writeFileSync(
      filePath,
      `${JSON.stringify({ role: "user", text: "Keep the complete prompt", atMs })}\n{"role":`,
    );

    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(path): Promise<ParsedLocalAgentSession> {
          const messages: ParsedLocalAgentSession["messages"] = [];
          const read = await readJsonLines(path, (line) => {
            if (isFixtureLine(line)) messages.push(line);
          });
          return {
            id: "active-session",
            messages,
            complete: read.malformedLines === 0,
          };
        },
      },
    });

    const result = await instance.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]!.content).toContain("Keep the complete prompt");
    expect(result.presentExternalIds).toEqual(["cli:active-session:2026-01-05"]);
  });

  test("retains every day when one native session id exists at multiple paths", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const olderPath = join(root, "older.jsonl");
    const newerPath = join(root, "newer.jsonl");
    writeFileSync(
      olderPath,
      `${JSON.stringify({ role: "user", text: "Older copy", atMs: new Date(2026, 0, 1, 9).getTime() })}\n`,
    );
    writeFileSync(
      newerPath,
      `${JSON.stringify({ role: "user", text: "Newer copy", atMs: new Date(2026, 0, 2, 9).getTime() })}\n`,
    );
    utimesSync(olderPath, new Date(2026, 0, 1), new Date(2026, 0, 1));
    utimesSync(newerPath, new Date(2026, 0, 2), new Date(2026, 0, 2));

    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(path): Promise<ParsedLocalAgentSession> {
          const messages: ParsedLocalAgentSession["messages"] = [];
          await readJsonLines(path, (line) => {
            if (isFixtureLine(line)) messages.push(line);
          });
          return { id: "duplicated-session", messages };
        },
      },
    });

    const first = await instance.sync(null);
    const second = await instance.sync(first.cursor);

    expect(second.presentExternalIds).toEqual([
      "cli:duplicated-session:2026-01-01",
      "cli:duplicated-session:2026-01-02",
    ]);
  });

  test("re-renders an older same-day copy when the newer duplicate disappears", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const olderPath = join(root, "older.jsonl");
    const newerPath = join(root, "newer.jsonl");
    const atMs = new Date(2026, 0, 2, 9).getTime();
    writeFileSync(
      olderPath,
      `${JSON.stringify({ role: "user", text: "Older same-day copy", atMs })}\n`,
    );
    writeFileSync(
      newerPath,
      `${JSON.stringify({ role: "user", text: "Newer same-day copy", atMs })}\n`,
    );
    utimesSync(olderPath, new Date(2026, 0, 1), new Date(2026, 0, 1));
    utimesSync(newerPath, new Date(2026, 0, 2), new Date(2026, 0, 2));

    let parseCalls = 0;
    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(path): Promise<ParsedLocalAgentSession> {
          parseCalls += 1;
          const messages: ParsedLocalAgentSession["messages"] = [];
          await readJsonLines(path, (line) => {
            if (isFixtureLine(line)) messages.push(line);
          });
          return { id: "same-day-session", messages };
        },
      },
    });

    const first = await instance.sync(null);
    expect(first.documents.at(-1)!.content).toContain("Newer same-day copy");
    expect(parseCalls).toBe(2);

    const unchanged = await instance.sync(first.cursor);
    expect(unchanged.documents).toEqual([]);
    expect(parseCalls).toBe(2);
    rmSync(newerPath, { force: true });

    const fallback = await instance.sync(unchanged.cursor);
    expect(fallback.documents).toHaveLength(1);
    expect(fallback.documents[0]!.content).toContain("Older same-day copy");
    expect(parseCalls).toBe(3);
  });

  test("re-emits the newest same-day duplicate after an older copy changes", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const olderPath = join(root, "older.jsonl");
    const newerPath = join(root, "newer.jsonl");
    const atMs = new Date(2026, 0, 2, 9).getTime();
    writeFileSync(olderPath, `${JSON.stringify({ role: "user", text: "Older copy", atMs })}\n`);
    writeFileSync(
      newerPath,
      `${JSON.stringify({ role: "user", text: "Canonical newer copy", atMs })}\n`,
    );
    const olderTime = new Date(2026, 0, 1);
    const newerTime = new Date(2026, 0, 2);
    utimesSync(olderPath, olderTime, olderTime);
    utimesSync(newerPath, newerTime, newerTime);

    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(path): Promise<ParsedLocalAgentSession> {
          const messages: ParsedLocalAgentSession["messages"] = [];
          await readJsonLines(path, (line) => {
            if (isFixtureLine(line)) messages.push(line);
          });
          return { id: "same-day-session", messages };
        },
      },
    });

    const first = await instance.sync(null);
    writeFileSync(
      olderPath,
      `${JSON.stringify({ role: "user", text: "Changed older copy", atMs })}\n`,
    );
    utimesSync(olderPath, olderTime, olderTime);
    const changed = await instance.sync(first.cursor);

    expect(changed.documents).toHaveLength(1);
    expect(changed.documents[0]!.content).toContain("Canonical newer copy");
  });

  test("does not overwrite a cached newer duplicate when its refresh is malformed", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const olderPath = join(root, "older.jsonl");
    const newerPath = join(root, "newer.jsonl");
    const atMs = new Date(2026, 0, 2, 9).getTime();
    const olderTime = new Date(2026, 0, 1);
    const newerTime = new Date(2026, 0, 2);
    writeFileSync(olderPath, `${JSON.stringify({ role: "user", text: "Older copy", atMs })}\n`);
    writeFileSync(
      newerPath,
      `${JSON.stringify({ role: "user", text: "Canonical newer copy", atMs })}\n`,
    );
    utimesSync(olderPath, olderTime, olderTime);
    utimesSync(newerPath, newerTime, newerTime);
    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(path): Promise<ParsedLocalAgentSession> {
          const messages: ParsedLocalAgentSession["messages"] = [];
          let complete = true;
          await readJsonLines(path, (line) => {
            if (isFixtureLine(line)) messages.push(line);
            else complete = false;
          });
          return { id: "malformed-duplicate-session", messages, complete };
        },
      },
    });
    const first = await instance.sync(null);
    expect(first.documents[0]!.content).toContain("Canonical newer copy");

    writeFileSync(newerPath, `${JSON.stringify({ malformed: true })}\n`);
    utimesSync(newerPath, newerTime, newerTime);
    const malformed = await instance.sync(first.cursor);

    expect(malformed.documents).toEqual([]);
    expect(malformed.presentExternalIds).toBeUndefined();
  });

  test("re-emits a cached newer duplicate after an older copy appears", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const olderPath = join(root, "older.jsonl");
    const newerPath = join(root, "newer.jsonl");
    const atMs = new Date(2026, 0, 3, 9).getTime();
    writeFileSync(
      newerPath,
      `${JSON.stringify({ role: "user", text: "Canonical newer copy", atMs })}\n`,
    );
    utimesSync(newerPath, new Date(2026, 0, 2), new Date(2026, 0, 2));
    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(path): Promise<ParsedLocalAgentSession> {
          const messages: ParsedLocalAgentSession["messages"] = [];
          await readJsonLines(path, (line) => {
            if (isFixtureLine(line)) messages.push(line);
          });
          return { id: "late-duplicate-session", messages };
        },
      },
    });
    const first = await instance.sync(null);

    writeFileSync(
      olderPath,
      `${JSON.stringify({ role: "user", text: "Newly discovered older copy", atMs })}\n`,
    );
    utimesSync(olderPath, new Date(2026, 0, 1), new Date(2026, 0, 1));
    const olderPage = await instance.sync(first.cursor);
    const finalPage = await instance.sync(olderPage.cursor);

    expect(olderPage.hasMore).toBe(true);
    expect(olderPage.documents).toEqual([]);
    expect(finalPage.documents).toHaveLength(1);
    expect(finalPage.documents[0]!.content).toContain("Canonical newer copy");
    expect(finalPage.presentExternalIds).toEqual(["cli:late-duplicate-session:2026-01-03"]);
  });

  test("finishes with a newly added newer duplicate after refreshing its cached peer", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const olderPath = join(root, "older.jsonl");
    const newerPath = join(root, "newer.jsonl");
    const atMs = new Date(2026, 0, 3, 9).getTime();
    writeFileSync(
      olderPath,
      `${JSON.stringify({ role: "user", text: "Cached older copy", atMs })}\n`,
    );
    utimesSync(olderPath, new Date(2026, 0, 1), new Date(2026, 0, 1));
    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(path): Promise<ParsedLocalAgentSession> {
          const messages: ParsedLocalAgentSession["messages"] = [];
          await readJsonLines(path, (line) => {
            if (isFixtureLine(line)) messages.push(line);
          });
          return { id: "late-newer-session", messages };
        },
      },
    });
    const first = await instance.sync(null);

    writeFileSync(
      newerPath,
      `${JSON.stringify({ role: "user", text: "New canonical copy", atMs })}\n`,
    );
    utimesSync(newerPath, new Date(2026, 0, 2), new Date(2026, 0, 2));
    let page = await instance.sync(first.cursor);
    const emitted = [...page.documents];
    while (page.hasMore) {
      page = await instance.sync(page.cursor);
      emitted.push(...page.documents);
    }

    expect(emitted.at(-1)!.content).toContain("New canonical copy");
    expect(page.presentExternalIds).toEqual(["cli:late-newer-session:2026-01-03"]);
  });

  test("re-emits a cached fallback when a changed file moves to another session id", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const olderPath = join(root, "older.jsonl");
    const newerPath = join(root, "newer.jsonl");
    const atMs = new Date(2026, 0, 3, 9).getTime();
    const write = (path: string, sessionId: string, text: string): void => {
      writeFileSync(path, `${JSON.stringify({ sessionId, role: "user", text, atMs })}\n`);
    };
    write(olderPath, "original-session", "Original fallback");
    write(newerPath, "original-session", "Original winner");
    utimesSync(olderPath, new Date(2026, 0, 1), new Date(2026, 0, 1));
    utimesSync(newerPath, new Date(2026, 0, 2), new Date(2026, 0, 2));

    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(path): Promise<ParsedLocalAgentSession> {
          let sessionId = "";
          const messages: ParsedLocalAgentSession["messages"] = [];
          await readJsonLines(path, (line) => {
            if (!isFixtureLine(line)) return;
            sessionId = String((line as unknown as Record<string, unknown>).sessionId);
            messages.push(line);
          });
          return { id: sessionId, messages };
        },
      },
    });

    const first = await instance.sync(null);
    write(newerPath, "replacement-session", "Replacement session");
    const changed = await instance.sync(first.cursor);

    expect(changed.documents.map((document) => document.externalId).sort()).toEqual([
      "cli:original-session:2026-01-03",
      "cli:replacement-session:2026-01-03",
    ]);
    expect(
      changed.documents.find((document) => document.externalId.includes("original-session"))
        ?.content,
    ).toContain("Original fallback");
  });

  test("publishes an empty complete snapshot after a transcript file is deleted", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const filePath = join(root, "deleted.jsonl");
    const atMs = new Date(2026, 0, 6, 9, 0).getTime();
    writeFileSync(
      filePath,
      `${JSON.stringify({ role: "user", text: "Temporary session", atMs })}\n`,
    );
    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(path): Promise<ParsedLocalAgentSession> {
          const messages: ParsedLocalAgentSession["messages"] = [];
          await readJsonLines(path, (line) => {
            if (isFixtureLine(line)) messages.push(line);
          });
          return { id: "deleted-session", messages };
        },
      },
    });

    const first = await instance.sync(null);
    rmSync(filePath, { force: true });
    const deleted = await instance.sync(first.cursor);

    expect(first.presentExternalIds).toHaveLength(1);
    expect(deleted.documents).toEqual([]);
    expect(deleted.presentExternalIds).toEqual([]);
  });

  test("withholds reconciliation while any scanned file fails parsing", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const atMs = new Date(2026, 0, 6, 12, 0).getTime();
    writeFileSync(
      join(root, "valid.jsonl"),
      `${JSON.stringify({ role: "user", text: "Readable prompt", atMs })}\n`,
    );
    writeFileSync(join(root, "broken.jsonl"), "not-json\n");
    let brokenAttempts = 0;

    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(path): Promise<ParsedLocalAgentSession> {
          if (path.endsWith("broken.jsonl")) {
            brokenAttempts += 1;
            throw new Error("unreadable session");
          }
          const messages: ParsedLocalAgentSession["messages"] = [];
          await readJsonLines(path, (line) => {
            if (isFixtureLine(line)) messages.push(line);
          });
          return { id: "readable-session", messages };
        },
      },
    });

    const first = await instance.sync(null);
    expect(first.documents).toHaveLength(1);
    expect(first.presentExternalIds).toBeUndefined();

    const second = await instance.sync(first.cursor);
    expect(brokenAttempts).toBe(2);
    expect(second.documents).toEqual([]);
    expect(second.presentExternalIds).toBeUndefined();
  });

  test("newest policy still emits a valid changed session when a peer fails", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const changedPath = join(root, "changed.jsonl");
    const brokenPath = join(root, "broken.jsonl");
    const atMs = new Date(2026, 0, 6, 12).getTime();
    const writePrompt = (path: string, text: string): void => {
      writeFileSync(path, `${JSON.stringify({ role: "user", text, atMs })}\n`);
    };
    writePrompt(changedPath, "Original prompt");
    writePrompt(brokenPath, "Readable peer");
    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        duplicateSessionPolicy: "newest",
        async parseSession(path): Promise<ParsedLocalAgentSession> {
          const messages: ParsedLocalAgentSession["messages"] = [];
          const read = await readJsonLines(path, (line) => {
            if (isFixtureLine(line)) messages.push(line);
          });
          if (messages[0]?.text === "Break parser") throw new Error("unreadable session");
          return {
            id: path.endsWith("changed.jsonl") ? "changed-session" : "peer-session",
            messages,
            complete: read.malformedLines === 0,
          };
        },
      },
    });
    const first = await instance.sync(null);
    expect(first.presentExternalIds).toHaveLength(2);

    writePrompt(changedPath, "Updated valid prompt");
    writePrompt(brokenPath, "Break parser");
    const mixed = await instance.sync(first.cursor);

    expect(mixed.documents).toHaveLength(1);
    expect(mixed.documents[0]!.content).toContain("Updated valid prompt");
    expect(mixed.presentExternalIds).toBeUndefined();
  });

  test("builds a valid query profile for metadata emitted by every local session source", () => {
    const profile = createLocalAgentSessionDocumentEventProfile({
      harnessId: "fictional-agent",
      agentName: "Nova",
    });

    expect(() => validateDocumentEventProfile(profile, "fictional local sessions")).not.toThrow();
    expect(profile.documentTypes).toEqual(["conversation"]);
    expect(profile.personRoles).toEqual(["participant"]);
    expect(
      profile.metadataFields?.find((field) => field.path === "extra.agent")?.allowedValues,
    ).toEqual(["Nova"]);
    expect(profile.metadataFields?.map((field) => field.path)).toEqual(
      expect.arrayContaining([
        "tags",
        "extra.channel",
        "extra.chatId",
        "extra.project",
        "extra.cwd",
        "extra.branch",
        "extra.model",
        "extra.parentSessionId",
        "extra.messageCount",
      ]),
    );
  });

  test("stops iterating a wide directory at the scan-entry ceiling", async () => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let reads = 0;
    let closed = false;
    vi.doMock("node:fs", () => ({
      ...realFs,
      default: realFs,
      existsSync: () => true,
      realpathSync: (path: string) => path,
      lstatSync: () => ({ isDirectory: () => true, dev: 1, ino: 1 }),
      opendirSync: () => ({
        readSync: () => {
          reads += 1;
          return {
            name: `entry-${reads}`,
            isDirectory: () => false,
            isFile: () => false,
          };
        },
        closeSync: () => {
          closed = true;
        },
      }),
    }));
    const { createLocalAgentSessionSource: createSource } =
      await import("./local-agent-sessions.js");
    const instance = createSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: "/synthetic-wide-root" }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(): Promise<ParsedLocalAgentSession> {
          throw new Error("parser must not run");
        },
      },
    });

    const result = await instance.sync(null);
    expect(reads).toBe(100_001);
    expect(closed).toBe(true);
    expect(result.presentExternalIds).toBeUndefined();
  });

  test("abandons a nested directory replaced during traversal", async () => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let rootReads = 0;
    let childReads = 0;
    let childSwapped = false;
    let childClosed = false;
    vi.doMock("node:fs", () => ({
      ...realFs,
      default: realFs,
      existsSync: () => true,
      realpathSync: (path: string) => path,
      lstatSync: (path: string) => {
        if (path === "/synthetic-root") {
          return { isDirectory: () => true, dev: 1, ino: 1 };
        }
        if (path === "/synthetic-root/swapped-child") {
          return childSwapped
            ? { isDirectory: () => false, dev: 1, ino: 3 }
            : { isDirectory: () => true, dev: 1, ino: 2 };
        }
        return {
          isDirectory: () => false,
          isFile: () => true,
          size: 10,
          mtimeMs: 1,
          ctimeMs: 1,
          dev: 1,
          ino: 4,
        };
      },
      opendirSync: (path: string) => {
        if (path === "/synthetic-root") {
          return {
            readSync: () =>
              rootReads++ === 0
                ? {
                    name: "swapped-child",
                    isDirectory: () => true,
                    isFile: () => false,
                  }
                : null,
            closeSync: () => {},
          };
        }
        return {
          readSync: () => {
            if (childReads++ > 0) return null;
            childSwapped = true;
            return {
              name: "outside.jsonl",
              isDirectory: () => false,
              isFile: () => true,
            };
          },
          closeSync: () => {
            childClosed = true;
          },
        };
      },
    }));
    const { createLocalAgentSessionSource: createSource } =
      await import("./local-agent-sessions.js");
    let parseCalls = 0;
    const instance = createSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: "/synthetic-root" }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(): Promise<ParsedLocalAgentSession> {
          parseCalls += 1;
          return { id: "unexpected", messages: [] };
        },
      },
    });

    const result = await instance.sync(null);

    expect(childClosed).toBe(true);
    expect(parseCalls).toBe(0);
    expect(result.presentExternalIds).toBeUndefined();
  });

  test("emits only the newest immutable revision on the first paginated page", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const atMs = new Date(2026, 0, 5, 12).getTime();
    for (let index = 0; index < 11; index += 1) {
      const path = join(root, `revision-${index}.jsonl`);
      writeFileSync(path, `${JSON.stringify({ role: "user", text: `Revision ${index}`, atMs })}\n`);
      utimesSync(path, new Date(2026, 0, index + 1), new Date(2026, 0, index + 1));
    }

    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        duplicateSessionPolicy: "newest",
        async parseSession(path): Promise<ParsedLocalAgentSession> {
          const messages: ParsedLocalAgentSession["messages"] = [];
          await readJsonLines(path, (line) => {
            if (isFixtureLine(line)) messages.push(line);
          });
          return { id: "revision-session", messages };
        },
      },
    });

    const first = await instance.sync(null);
    expect(first.hasMore).toBe(true);
    expect(first.documents).toHaveLength(1);
    expect(first.documents[0]!.content).toContain("Revision 10");
    expect(first.documents[0]!.content).not.toContain("Revision 9");
  });

  test("bounds cumulative page output while rendering one large session", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    writeFileSync(join(root, "session.jsonl"), "{}\n");
    const start = new Date(2020, 0, 1, 12).getTime();
    const messages = Array.from({ length: 800 }, (_, day) => ({
      role: "user" as const,
      text: "Bound this day",
      atMs: start + day * 86_400_000,
    }));

    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(): Promise<ParsedLocalAgentSession> {
          return { id: "bounded-session", name: "n".repeat(16 * 1024), messages };
        },
      },
    });

    const result = await instance.sync(null);
    expect(result.documents).toEqual([]);
    expect(result.presentExternalIds).toBeUndefined();
  });

  test("rejects an oversized transcript before invoking its parser", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const filePath = join(root, "oversized.jsonl");
    writeFileSync(filePath, "");
    // Just past the 1 GiB cap. Sparse, so the size costs no disk.
    truncateSync(filePath, 1025 * 1024 * 1024);
    let parseCalls = 0;

    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(): Promise<ParsedLocalAgentSession> {
          parseCalls += 1;
          return { id: "oversized", messages: [] };
        },
      },
    });

    const result = await instance.sync(null);
    expect(parseCalls).toBe(0);
    expect(result.documents).toEqual([]);
    expect(result.presentExternalIds).toBeUndefined();
    expect(result.watermark).toBeUndefined();
  });

  test("rejects oversized native session ids before they enter documents or cursors", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    writeFileSync(join(root, "session.jsonl"), "{}\n");
    const oversizedId = "s".repeat(257);

    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(): Promise<ParsedLocalAgentSession> {
          return {
            id: oversizedId,
            messages: [{ role: "user", text: "Bound the cursor", atMs: Date.now() }],
          };
        },
      },
    });

    const result = await instance.sync(null);
    expect(result.documents).toEqual([]);
    expect(result.presentExternalIds).toBeUndefined();
    expect(JSON.stringify(result.cursor)).not.toContain(oversizedId);
  });

  test("an unreadable root stops deletion detection in itself, not in its sibling", async () => {
    // A harness that keeps its archive in a second root is the case this
    // exists for. The archive directory becoming unreadable — a permission
    // change, a mount that went away — used to withhold the whole account's
    // snapshot, so a session deleted from the live root stayed indexed for as
    // long as the archive stayed broken, which for a permission change is
    // until somebody notices.
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const live = join(root, "sessions");
    const archive = join(root, "archived");
    mkdirSync(live);
    mkdirSync(archive);
    writeFileSync(join(live, "a.jsonl"), "{}\n");
    writeFileSync(join(archive, "b.jsonl"), "{}\n");

    const sessionFor = (filePath: string): ParsedLocalAgentSession => ({
      id: filePath.includes("archived") ? "session-archive" : "session-live",
      messages: [
        {
          role: "user",
          text: "Where did the parser go?",
          atMs: Date.UTC(2026, 0, 2, 9, 0),
        },
      ],
      complete: true,
    });

    const makeInstance = () =>
      createLocalAgentSessionSource({
        providerId: PROVIDER,
        sourceId: SOURCE,
        adapter: {
          harnessId: "fictional-agent",
          agentName: "Nova",
          roots: [{ path: live }, { path: archive, optional: true }],
          fileExtensions: [".jsonl"],
          parserVersion: 1,
          async parseSession(filePath): Promise<ParsedLocalAgentSession> {
            return sessionFor(filePath);
          },
        },
      });

    // Healthy: both roots read, so the whole source is vouched for — the only
    // form that reaches a document stored before this source named its roots.
    const healthy = await makeInstance().sync(null);
    expect(healthy.presentExternalIds).toHaveLength(2);
    expect(healthy.presentClaims).toBeUndefined();
    expect(new Set(healthy.documents.map((d) => d.partitionKey))).toEqual(
      new Set(["sessions", "archived"]),
    );

    // The archive becomes unreadable.
    chmodSync(archive, 0o000);
    try {
      const degraded = await makeInstance().sync(null);
      expect(degraded.presentExternalIds).toBeUndefined();
      // The live root is still vouched for by name, so a session deleted there
      // is still found this cycle.
      expect(degraded.presentClaims?.map((claim) => claim.partition)).toEqual(["sessions"]);
      expect(degraded.presentClaims?.[0]?.ids).toEqual(["cli:session-live:2026-01-02"]);
    } finally {
      chmodSync(archive, 0o700);
    }
  });

  test.each([false, true])(
    "legacy deleted entries are pruned only on a complete scan (incomplete=%s)",
    async (incomplete) => {
      root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
      const live = join(root, "sessions");
      const archive = join(root, "archive");
      mkdirSync(live);
      mkdirSync(archive);
      const file = join(live, "a.jsonl");
      writeFileSync(file, "{}\n");
      const source = createLocalAgentSessionSource({
        providerId: PROVIDER,
        sourceId: SOURCE,
        adapter: {
          harnessId: "fictional-agent",
          agentName: "Nova",
          roots: [{ path: live }, { path: archive }],
          fileExtensions: [".jsonl"],
          parserVersion: 1,
          async parseSession() {
            return {
              id: "session-a",
              messages: [{ role: "user" as const, text: "Hello", atMs: Date.UTC(2026, 0, 2, 9) }],
              complete: true,
            };
          },
        },
      });
      const first = await source.sync(null);
      const legacy = JSON.parse(JSON.stringify(first.cursor)) as LocalAgentSessionCursor;
      for (const entry of Object.values(legacy.files ?? {})) delete entry.rootId;
      rmSync(file);
      if (incomplete) chmodSync(archive, 0o000);
      try {
        const next = await source.sync(legacy);
        expect(Object.keys((next.cursor as LocalAgentSessionCursor).files ?? {})).toHaveLength(
          incomplete ? 1 : 0,
        );
        if (incomplete) expect(next.presentExternalIds).toBeUndefined();
        else expect(next.presentExternalIds).toEqual([]);
      } finally {
        chmodSync(archive, 0o700);
      }
    },
  );

  test("a paged cycle over an unreadable root still claims its readable sibling", async () => {
    // The unreadable root's files stay in the cursor, so on every later page
    // they are expected and missing from the scan. That is the root's gap,
    // not a file that moved, and must not cost the readable root its claim.
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const live = join(root, "sessions");
    const archive = join(root, "archived");
    mkdirSync(live);
    mkdirSync(archive);
    writeFileSync(join(live, "a.jsonl"), "{}\n");
    writeFileSync(join(archive, "b.jsonl"), "{}\n");
    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: live }, { path: archive, optional: true }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(filePath): Promise<ParsedLocalAgentSession> {
          return {
            id: `session-${basename(filePath, ".jsonl")}`,
            messages: [{ role: "user", text: "Hello", atMs: Date.UTC(2026, 0, 2, 9, 0) }],
            complete: true,
          };
        },
      },
    });
    const first = await instance.sync(null);
    expect(first.presentExternalIds).toHaveLength(2);

    chmodSync(archive, 0o000);
    try {
      const resumed = {
        ...(first.cursor as LocalAgentSessionCursor),
        pendingFileKeys: [],
        snapshotSafe: true,
      } as LocalAgentSessionCursor;
      const second = await instance.sync(resumed);
      expect(second.presentExternalIds).toBeUndefined();
      expect(second.presentClaims?.map((claim) => claim.partition)).toEqual(["sessions"]);
      expect(second.issues?.[0]?.message).not.toContain("moved or disappeared");
    } finally {
      chmodSync(archive, 0o700);
    }
  });

  test("a file reused unchanged still records the root it came from", async () => {
    // A state written before roots were named carries none, and an untouched
    // transcript is never re-parsed — it is copied forward. If that copy does
    // not pick the root up, the file keeps no root for as long as nobody edits
    // it, and its ids are missing from the claim its root makes: a claim that
    // says the root holds less than it does is an instruction to delete the
    // difference.
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const live = join(root, "sessions");
    const archive = join(root, "archived");
    mkdirSync(live);
    mkdirSync(archive);
    writeFileSync(join(live, "a.jsonl"), "{}\n");
    writeFileSync(join(archive, "b.jsonl"), "{}\n");

    const build = () =>
      createLocalAgentSessionSource({
        providerId: PROVIDER,
        sourceId: SOURCE,
        adapter: {
          harnessId: "fictional-agent",
          agentName: "Nova",
          roots: [{ path: live }, { path: archive }],
          fileExtensions: [".jsonl"],
          parserVersion: 1,
          async parseSession(filePath): Promise<ParsedLocalAgentSession> {
            return {
              id: `session-${basename(filePath, ".jsonl")}`,
              messages: [{ role: "user", text: "Hello", atMs: Date.UTC(2026, 0, 2, 9, 0) }],
              complete: true,
            };
          },
        },
      });

    const first = await build().sync(null);
    // The cursor a build that did not name roots would have written.
    const legacy = JSON.parse(JSON.stringify(first.cursor)) as LocalAgentSessionCursor;
    for (const state of Object.values(legacy.files ?? {})) delete state.rootId;

    chmodSync(archive, 0o000);
    try {
      const second = await build().sync(legacy);
      expect(second.presentClaims?.map((claim) => claim.partition)).toEqual(["sessions"]);
      // The transcript nobody touched is still part of what its root vouches
      // for, even though this cycle did not re-read it.
      expect(second.presentClaims?.[0]?.ids).toEqual(["cli:session-a:2026-01-02"]);
    } finally {
      chmodSync(archive, 0o700);
    }
  });

  test("a root with no name is refused rather than claimed under the gateway's blank", async () => {
    // The empty string is what the gateway stores for a document naming no
    // partition, so a claim on it would sweep every document from before this
    // source named its roots.
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: root, id: "" }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(): Promise<ParsedLocalAgentSession> {
          return { id: "session-1", messages: [], complete: true };
        },
      },
    });

    await expect(instance.sync(null)).rejects.toThrow(/no name/);
  });

  test("a root the scan never reached is not claimed as empty", async () => {
    // The caps stop the walk across roots, not inside one. A root the loop
    // never opened has no failure of its own to record, so without being named
    // it would be covered — vouched for on the strength of a walk that never
    // happened — and covered holding nothing, which is an instruction to
    // delete everything in it.
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const deep = join(root, "deep");
    const later = join(root, "later");
    mkdirSync(deep);
    mkdirSync(later);
    writeFileSync(join(later, "a.jsonl"), "{}\n");

    const build = () =>
      createLocalAgentSessionSource({
        providerId: PROVIDER,
        sourceId: SOURCE,
        adapter: {
          harnessId: "fictional-agent",
          agentName: "Nova",
          roots: [{ path: deep }, { path: later }],
          fileExtensions: [".jsonl"],
          parserVersion: 1,
          async parseSession(filePath): Promise<ParsedLocalAgentSession> {
            return {
              id: `session-${basename(filePath, ".jsonl")}`,
              messages: [{ role: "user", text: "Hello", atMs: Date.UTC(2026, 0, 2, 9, 0) }],
              complete: true,
            };
          },
        },
      });

    const first = await build().sync(null);
    expect(first.presentExternalIds).toHaveLength(1);

    // Nested past the depth the scan will follow, which stops the whole walk.
    mkdirSync(join(deep, ...Array.from({ length: 70 }, (_, i) => `d${i}`)), { recursive: true });

    const second = await build().sync(first.cursor);
    expect(second.presentExternalIds).toBeUndefined();
    // `later` was never opened, so it is vouched for by nothing.
    expect(second.presentClaims).toBeUndefined();
  });

  test("a file that vanished under a paged cycle claims nothing", async () => {
    // Drift is the one thing that clears the whole-source answer and cannot be
    // attributed to a root: a file that moved is simply a key the scan no
    // longer has. Nothing this cycle enumerated can be vouched for, so the
    // claims go with the snapshot rather than being published in its place.
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const live = join(root, "sessions");
    mkdirSync(live);
    writeFileSync(join(live, "a.jsonl"), "{}\n");

    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: live }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(filePath): Promise<ParsedLocalAgentSession> {
          return {
            id: `session-${basename(filePath, ".jsonl")}`,
            messages: [{ role: "user", text: "Hello", atMs: Date.UTC(2026, 0, 2, 9, 0) }],
            complete: true,
          };
        },
      },
    });

    const first = await instance.sync(null);
    expect(first.presentExternalIds).toHaveLength(1);

    // Resume as if the previous page had left work behind, while a file the
    // stored state knows about has gone — the shape the mid-cycle drift check
    // exists to catch.
    rmSync(join(live, "a.jsonl"), { force: true });
    const resumed = {
      ...(first.cursor as LocalAgentSessionCursor),
      pendingFileKeys: [],
      snapshotSafe: true,
    } as LocalAgentSessionCursor;

    const second = await instance.sync(resumed);
    expect(second.presentExternalIds).toBeUndefined();
    expect(second.presentClaims).toBeUndefined();
    expect(second.issues?.[0]?.message).toContain("moved or disappeared");
  });

  test("a file that appears or grows under a paged cycle keeps the snapshot", async () => {
    // A tool writing a live session appends to its transcript and starts new
    // files all the time. Neither can make a stored document look deleted, so
    // neither may withhold the snapshot.
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const live = join(root, "sessions");
    mkdirSync(live);
    writeFileSync(join(live, "a.jsonl"), "{}\n");

    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: live }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(filePath): Promise<ParsedLocalAgentSession> {
          return {
            id: `session-${basename(filePath, ".jsonl")}`,
            messages: [{ role: "user", text: "Hello", atMs: Date.UTC(2026, 0, 2, 9, 0) }],
            complete: true,
          };
        },
      },
    });

    const first = await instance.sync(null);
    expect(first.presentExternalIds).toHaveLength(1);

    writeFileSync(join(live, "b.jsonl"), "{}\n");
    appendFileSync(join(live, "a.jsonl"), "{}\n");
    const resumed = {
      ...(first.cursor as LocalAgentSessionCursor),
      pendingFileKeys: [],
      snapshotSafe: true,
    } as LocalAgentSessionCursor;

    const second = await instance.sync(resumed);
    expect(second.presentExternalIds).toEqual(first.presentExternalIds);
    expect(second.issues ?? []).toEqual([]);
    const third = await instance.sync(second.cursor);
    expect(third.presentExternalIds).toHaveLength(2);
  });

  test("a page carrying a document from a gapped root claims nothing", async () => {
    // The host refuses a claiming page whose documents are not all inside its
    // claims, and refusing it there throws away every claim on the page and
    // files the source as misbehaving. A root gaps for one malformed transcript
    // while its healthy siblings on the same page are still being ingested, so
    // the source has to decline to claim rather than hand over a page the host
    // will reject.
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const live = join(root, "sessions");
    const archive = join(root, "archived");
    mkdirSync(live);
    mkdirSync(archive);
    writeFileSync(join(live, "good.jsonl"), "{}\n");
    writeFileSync(join(live, "bad.jsonl"), "{}\n");
    writeFileSync(join(archive, "b.jsonl"), "{}\n");

    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: live }, { path: archive }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(filePath): Promise<ParsedLocalAgentSession> {
          const broken = filePath.includes("bad.jsonl");
          return {
            id: `session-${basename(filePath, ".jsonl")}`,
            messages: [{ role: "user", text: "Hello", atMs: Date.UTC(2026, 0, 2, 9, 0) }],
            complete: !broken,
          };
        },
      },
    });

    const result = await instance.sync(null);

    // `sessions` is gapped by its malformed transcript, and the healthy
    // transcript beside it is on this page carrying `sessions` as its
    // partition. Claiming `archived` alone would be a page the host discards.
    expect(result.documents.some((d) => d.partitionKey === "sessions")).toBe(true);
    expect(result.presentExternalIds).toBeUndefined();
    expect(result.presentClaims).toBeUndefined();
    expect(result.issues).toEqual([expect.objectContaining({ code: "snapshot-withheld" })]);
  });

  test("a session deleted from a healthy root is dropped even while a sibling is unreadable", async () => {
    // The state carry-over used to be whole-source: any unreadable root kept
    // every root's stored files alive, so the healthy root's claim vouched for
    // a session that had been deleted from it. Partitioning the enumeration
    // without partitioning this leaves the headline case broken.
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const live = join(root, "sessions");
    const archive = join(root, "archived");
    mkdirSync(live);
    mkdirSync(archive);
    writeFileSync(join(live, "a.jsonl"), "{}\n");
    writeFileSync(join(live, "b.jsonl"), "{}\n");
    writeFileSync(join(archive, "c.jsonl"), "{}\n");

    const build = () =>
      createLocalAgentSessionSource({
        providerId: PROVIDER,
        sourceId: SOURCE,
        adapter: {
          harnessId: "fictional-agent",
          agentName: "Nova",
          roots: [{ path: live }, { path: archive }],
          fileExtensions: [".jsonl"],
          parserVersion: 1,
          async parseSession(filePath): Promise<ParsedLocalAgentSession> {
            return {
              id: `session-${basename(filePath, ".jsonl")}`,
              messages: [{ role: "user", text: "Hello", atMs: Date.UTC(2026, 0, 2, 9, 0) }],
              complete: true,
            };
          },
        },
      });

    const first = await build().sync(null);
    expect(first.presentExternalIds).toHaveLength(3);

    // One session deleted from the healthy root; the archive becomes
    // unreadable in the same cycle.
    rmSync(join(live, "b.jsonl"));
    chmodSync(archive, 0o000);
    try {
      const second = await build().sync(first.cursor);
      expect(second.presentClaims?.map((claim) => claim.partition)).toEqual(["sessions"]);
      // The deleted session is gone from what `sessions` vouches for. Keeping
      // it would tell the gateway a document still exists that does not.
      expect(second.presentClaims?.[0]?.ids).toEqual(["cli:session-a:2026-01-02"]);
    } finally {
      chmodSync(archive, 0o700);
    }
  });

  test("a malformed transcript withholds its own root, not the whole source", async () => {
    // The commonest failure this source has: one session file the parser
    // cannot finish. It used to stop deletion detection everywhere, including
    // roots holding nothing but well-formed transcripts.
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const live = join(root, "sessions");
    const archive = join(root, "archived");
    mkdirSync(live);
    mkdirSync(archive);
    writeFileSync(join(live, "a.jsonl"), "{}\n");
    writeFileSync(join(archive, "b.jsonl"), "{}\n");

    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: live }, { path: archive }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(filePath): Promise<ParsedLocalAgentSession> {
          const archived = filePath.includes("archived");
          return {
            id: archived ? "session-archive" : "session-live",
            messages: [
              { role: "user", text: "Where did the parser go?", atMs: Date.UTC(2026, 0, 2, 9, 0) },
            ],
            // The archived transcript is truncated part-way through.
            complete: !archived,
          };
        },
      },
    });

    const result = await instance.sync(null);

    expect(result.presentExternalIds).toBeUndefined();
    expect(result.presentClaims?.map((claim) => claim.partition)).toEqual(["sessions"]);
    expect(result.presentClaims?.[0]?.ids).toEqual(["cli:session-live:2026-01-02"]);
  });

  test("a known unreadable transcript retains its IDs while same-root sibling deletions reconcile", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    writeFileSync(join(root, "held.jsonl"), "{}\n");
    writeFileSync(join(root, "gone.jsonl"), "{}\n");
    let broken = false;
    const source = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: root, id: "sessions" }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(path) {
          if (broken && basename(path) === "held.jsonl") throw new Error("Unreadable transcript");
          return {
            id: basename(path, ".jsonl"),
            messages: [
              { role: "user" as const, text: "Fictional message", atMs: Date.UTC(2026, 0, 2, 9) },
            ],
            complete: true,
          };
        },
      },
    });
    const first = await source.sync(null);
    broken = true;
    writeFileSync(join(root, "held.jsonl"), "broken\n");
    rmSync(join(root, "gone.jsonl"));
    let cursor = first.cursor;
    for (let cycle = 0; cycle < 3; cycle++) {
      const page = await source.sync(cursor);
      expect(page.documents).toEqual([]);
      expect(page.presentClaims).toEqual([{ partition: "sessions", ids: ["cli:held:2026-01-02"] }]);
      cursor = page.cursor;
    }
  });

  test("newest sessions moved into an unreadable archive are retained until the archive returns", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const live = join(root, "sessions");
    const archive = join(root, "archive");
    mkdirSync(live);
    mkdirSync(archive);
    writeFileSync(join(live, "session.jsonl"), "{}\n");
    const source = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: live }, { path: archive }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        duplicateSessionPolicy: "newest",
        async parseSession() {
          return {
            id: "moving",
            messages: [
              { role: "user" as const, text: "Fictional message", atMs: Date.UTC(2026, 0, 2, 9) },
            ],
            complete: true,
          };
        },
      },
    });
    const first = await source.sync(null);
    renameSync(join(live, "session.jsonl"), join(archive, "session.jsonl"));
    chmodSync(archive, 0o000);
    let cursor = first.cursor;
    try {
      for (let cycle = 0; cycle < 3; cycle++) {
        const page = await source.sync(cursor);
        expect(page.presentClaims).toEqual([
          { partition: "sessions", ids: ["cli:moving:2026-01-02"] },
        ]);
        cursor = page.cursor;
      }
    } finally {
      chmodSync(archive, 0o700);
    }
    const recovered = await source.sync(cursor);
    expect(recovered.documents[0]).toMatchObject({
      externalId: "cli:moving:2026-01-02",
      partitionKey: "archive",
    });
    expect(recovered.presentExternalIds).toEqual(["cli:moving:2026-01-02"]);
  });

  test("a missing optional root holds nothing; a missing required one is unread", async () => {
    // The difference the adapter is declaring when it marks a root optional.
    // An optional root that is not there is a root with nothing in it, so the
    // source can still vouch for everything. A required one that is not there
    // is a read that did not happen.
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    const live = join(root, "sessions");
    // Captured before the closure: `root` is nullable at this scope, and
    // narrowing does not survive into a function that reads it later.
    const absent = join(root, "absent");
    mkdirSync(live);
    writeFileSync(join(live, "a.jsonl"), "{}\n");

    const build = (optional: boolean) =>
      createLocalAgentSessionSource({
        providerId: PROVIDER,
        sourceId: SOURCE,
        adapter: {
          harnessId: "fictional-agent",
          agentName: "Nova",
          roots: [{ path: live }, { path: absent, optional }],
          fileExtensions: [".jsonl"],
          parserVersion: 1,
          async parseSession(): Promise<ParsedLocalAgentSession> {
            return {
              id: "session-live",
              messages: [{ role: "user", text: "Hello", atMs: Date.UTC(2026, 0, 2, 9, 0) }],
              complete: true,
            };
          },
        },
      });

    const withOptional = await build(true).sync(null);
    expect(withOptional.presentExternalIds).toHaveLength(1);
    expect(withOptional.presentClaims).toBeUndefined();

    const withRequired = await build(false).sync(null);
    expect(withRequired.presentExternalIds).toBeUndefined();
    expect(withRequired.presentClaims?.map((claim) => claim.partition)).toEqual(["sessions"]);
  });

  test("propagates source cancellation instead of converting it into a parse failure", async () => {
    root = mkdtempSync(join(tmpdir(), "local-agent-sessions-"));
    writeFileSync(join(root, "session.jsonl"), "{}\n");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    const instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        async parseSession(_path, options): Promise<ParsedLocalAgentSession> {
          throw options.signal?.reason;
        },
      },
    });

    await expect(instance.sync(null, { signal: controller.signal })).rejects.toThrow("cancelled");
  });
});

describe("createLocalAgentSessionSource — watching", () => {
  test("asks to be read once its sessions settle, not on every write", () => {
    const instance = createLocalAgentSessionSource({
      providerId: ProviderId("fictional-agent:local"),
      sourceId: SourceId("fictional-agent:local"),
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: "/nonexistent-agent-root" }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        parseSession: async () => ({ id: "unused", messages: [], complete: true }),
      },
    });

    expect(instance.watchQuietMs).toBe(AGENT_SESSION_WATCH_QUIET_MS);
    expect(AGENT_SESSION_WATCH_QUIET_MS).toBeGreaterThan(3_000);
  });
});
