// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { homedir } from "node:os";
import { join } from "node:path";
import {
  defineSource,
  config as configSchema,
  expandHostPath,
  type SourceInstance,
} from "@omnesis/source-sdk";
import {
  createLocalAgentSessionDocumentEventProfile,
  createLocalAgentSessionRetentionGuard,
  createLocalAgentSessionSource,
  readJsonLines,
  type LocalAgentSessionCursor,
  type LocalAgentSessionParseOptions,
  type ParsedLocalAgentSession,
} from "@omnesis/source-sdk/local-agent-sessions";
import { SyncError } from "@omnesis/types";
import { codexIcon } from "./icon.js";
import { codexStateSpec } from "./state.js";

/**
 * Codex rotates and archives session files under `~/.codex` on its own
 * schedule, independent of whether this source has ever read a given file.
 * A file already gone by the time a scan reaches its directory looks
 * identical to one that never existed, so this source can never claim its
 * corpus is the tool's complete history — only what was on disk when it last
 * looked.
 */
const HISTORY_COVERAGE_DETAIL =
  "Codex archives and removes old session files on its own, and Omnesis removes what Codex removes, so older sessions may not be here.";

type Entry = Record<string, unknown>;

function record(value: unknown): Entry | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Entry)
    : null;
}

function atMs(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function typedText(
  value: unknown,
  textBlockType: "text" | "output_text",
): { valid: boolean; text: string } {
  if (!Array.isArray(value)) return { valid: false, text: "" };
  const text: string[] = [];
  for (const valueBlock of value) {
    const block = record(valueBlock);
    if (!block || typeof block.type !== "string") return { valid: false, text: "" };
    if (block.type !== textBlockType) continue;
    if (typeof block.text !== "string") return { valid: false, text: "" };
    const trimmed = block.text.trim();
    if (trimmed) text.push(trimmed);
  }
  return { valid: true, text: text.join("\n\n") };
}

type SessionClassification = "root" | "ignored" | "invalid";

function classifySession(payload: Entry): SessionClassification {
  if (typeof payload.id !== "string" || !payload.id) return "invalid";
  if (
    payload.session_id !== undefined &&
    (typeof payload.session_id !== "string" || !payload.session_id)
  ) {
    return "invalid";
  }
  const threadSource = payload.thread_source;
  if (threadSource !== undefined && typeof threadSource !== "string" && !record(threadSource)) {
    return "invalid";
  }
  if (payload.parent_thread_id !== undefined && typeof payload.parent_thread_id !== "string") {
    return "invalid";
  }
  if (payload.forked_from_id !== undefined && typeof payload.forked_from_id !== "string") {
    return "invalid";
  }
  if (typeof payload.parent_thread_id === "string") return "ignored";
  const rootRuntime =
    payload.source === "cli" || payload.source === "vscode" || payload.source === "exec";
  if (rootRuntime && threadSource === "user") return "root";
  if (
    rootRuntime &&
    threadSource === undefined &&
    (payload.session_id === undefined || payload.session_id === payload.id)
  ) {
    return "root";
  }
  if (threadSource !== undefined || rootRuntime) return "ignored";
  if (payload.source === "mcp" || payload.source === "unknown") return "ignored";
  const source = record(payload.source);
  if (
    source &&
    (Object.hasOwn(source, "subagent") ||
      Object.hasOwn(source, "internal") ||
      Object.hasOwn(source, "custom"))
  ) {
    return "ignored";
  }
  return "invalid";
}

function rollBackTurns(messages: ParsedLocalAgentSession["messages"], count: number): void {
  let remaining = count;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    remaining -= 1;
    if (remaining === 0) {
      messages.splice(index);
      return;
    }
  }
  if (remaining > 0) messages.length = 0;
}

async function parseCodexSession(
  filePath: string,
  options: LocalAgentSessionParseOptions = {},
): Promise<ParsedLocalAgentSession> {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let branch: string | undefined;
  let model: string | undefined;
  let parentSessionId: string | undefined;
  let ignoredSession = false;
  let structurallyComplete = true;
  let sawRecord = false;
  const messages: ParsedLocalAgentSession["messages"] = [];
  let humanTurn = false;
  const retain = createLocalAgentSessionRetentionGuard();

  const read = await readJsonLines(
    filePath,
    (value): void | boolean => {
      const entry = record(value);
      if (!entry) {
        structurallyComplete = false;
        return;
      }
      if (!sawRecord) {
        sawRecord = true;
        if (entry.type !== "session_meta") {
          structurallyComplete = false;
          return false;
        }
      }
      const payload = record(entry.payload);
      if (!payload) {
        structurallyComplete = false;
        return;
      }

      if (entry.type === "session_meta" && !sessionId) {
        const classification = classifySession(payload);
        if (classification === "invalid") {
          structurallyComplete = false;
          return false;
        }
        const threadId = typeof payload.id === "string" ? payload.id : "";
        sessionId =
          typeof payload.session_id === "string" && payload.session_id
            ? payload.session_id
            : threadId;
        cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
        parentSessionId =
          typeof payload.parent_thread_id === "string"
            ? payload.parent_thread_id
            : typeof payload.forked_from_id === "string"
              ? payload.forked_from_id
              : undefined;
        const git = record(payload.git);
        branch = typeof git?.branch === "string" ? git.branch : undefined;
        ignoredSession = classification === "ignored";
        if (ignoredSession) return false;
        return;
      }

      if (entry.type === "turn_context") {
        if (payload.cwd !== undefined && typeof payload.cwd !== "string") {
          structurallyComplete = false;
        }
        if (payload.model !== undefined && typeof payload.model !== "string") {
          structurallyComplete = false;
        }
        if (typeof payload.cwd === "string") cwd = payload.cwd;
        if (typeof payload.model === "string") model = payload.model;
        return;
      }

      if (entry.type === "event_msg" && payload.type === "thread_rolled_back") {
        if (
          typeof payload.num_turns !== "number" ||
          !Number.isInteger(payload.num_turns) ||
          payload.num_turns < 0
        ) {
          structurallyComplete = false;
          return;
        }
        rollBackTurns(messages, payload.num_turns);
        humanTurn = messages.at(-1)?.role === "user";
        return;
      }

      const occurredAt = atMs(entry.timestamp);
      if (entry.type === "event_msg" && payload.type === "item_completed") {
        const item = record(payload.item);
        if (!item) {
          structurallyComplete = false;
          return;
        }
        if (
          item.type === "UserMessage" ||
          item.type === "user_message" ||
          item.type === "userMessage"
        ) {
          const parsed = typedText(item.content, "text");
          if (!parsed.valid || occurredAt <= 0) {
            structurallyComplete = false;
          } else if (parsed.text) {
            retain(parsed.text);
            messages.push({ role: "user", text: parsed.text, atMs: occurredAt });
            humanTurn = true;
          }
        }
        return;
      }
      if (entry.type === "event_msg" && payload.type === "user_message") {
        if (typeof payload.message !== "string" || occurredAt <= 0) {
          structurallyComplete = false;
          return;
        }
        const text = payload.message.trim();
        if (text) {
          retain(text);
          messages.push({ role: "user", text, atMs: occurredAt });
          humanTurn = true;
        }
        return;
      }

      if (
        entry.type !== "response_item" ||
        payload.type !== "message" ||
        payload.role !== "assistant" ||
        payload.phase !== "final_answer"
      ) {
        return;
      }
      if (occurredAt <= 0) {
        structurallyComplete = false;
        return;
      }
      const parsed = typedText(payload.content, "output_text");
      if (!parsed.valid) {
        structurallyComplete = false;
      } else {
        if (parsed.text && humanTurn) {
          retain(parsed.text);
          messages.push({ role: "assistant", text: parsed.text, atMs: occurredAt });
        }
        humanTurn = false;
      }
    },
    options,
  );

  // One malformed file among the batch: the shared harness's per-file catch
  // (`createLocalAgentSessionSource`) marks this file incomplete and moves on
  // to the next one in the page, so the failure never reaches beyond the file
  // that caused it.
  if (!sessionId) {
    throw new SyncError("unknown", "Codex session has no session metadata", { scope: "item" });
  }
  return {
    id: sessionId,
    cwd,
    branch,
    model,
    parentSessionId,
    messages: ignoredSession ? [] : messages,
    ignored: ignoredSession,
    complete: read.malformedLines === 0 && structurallyComplete,
  };
}

function defaultCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? expandHostPath(configured) : join(homedir(), ".codex");
}

function codexHome(configured?: string): string {
  // Already resolved: the host expands a declared path before the factory sees
  // it, so what arrives is absolute and free of shell conventions. The
  // environment fallbacks are not declared settings and still need expanding.
  return configured?.trim() ? configured : defaultCodexHome();
}

// The cursor type is pinned on `create`'s return rather than as a type
// argument: TypeScript infers every type argument or none, so naming the
// cursor here would default the configuration schema's type and hand `create`
// an untyped bag.
export default defineSource({
  id: "codex",
  name: "Codex Sessions",
  description: "Coding-agent conversations saved by Codex",
  provider: { id: "codex", name: "Codex" },
  authType: "local",
  unitName: "conversation days",
  primaryCount: "documents",
  singleInstance: true,
  multiDevice: { mode: "partitioned" },
  conversational: true,
  contract: {
    // The host resolves the stored cursor against this before `sync` runs,
    // so an unrecognised value is refused as unreadable rather than read as
    // "no sessions yet".
    state: codexStateSpec,
    apiVersion: 2,
    requires: ["state-envelope", "snapshot-sessions"],
  },
  documentEventProfile: createLocalAgentSessionDocumentEventProfile({
    harnessId: "codex",
    agentName: "Codex",
  }),
  icon: codexIcon,
  config: configSchema.object({
    codexHome: configSchema.path({
      label: "Codex home",
      help: "Where Codex keeps its sessions. Leave blank to use the location this machine already uses.",
      // Member-scoped: it names a directory on one machine. Two hosts running
      // this source will have it in different places, and one of them may not
      // have set it at all.
      scope: "member",
      placeholder: "~/.codex",
      mustExist: "directory",
    }),
  }),

  async create({
    sourceId,
    providerId,
    dataCutoff,
    config,
  }): Promise<SourceInstance<LocalAgentSessionCursor>> {
    const home = codexHome(config?.codexHome);
    const instance = createLocalAgentSessionSource({
      providerId,
      sourceId,
      dataCutoff,
      adapter: {
        harnessId: "codex",
        agentName: "Codex",
        roots: [
          { path: join(home, "sessions") },
          { path: join(home, "archived_sessions"), optional: true },
        ],
        fileExtensions: [".jsonl", ".jsonl.gz", ".jsonl.zst"],
        parserVersion: 3,
        duplicateSessionPolicy: "newest",
        parseSession: parseCodexSession,
      },
    });
    return {
      ...instance,
      async sync(cursor, syncOptions) {
        const result = await instance.sync(cursor, syncOptions);
        return {
          ...result,
          progress: {
            // The harness reports progress only for a round with files to
            // walk. A round with none still carries the coverage caveat, so
            // it needs a phase of its own: a first call with no cursor is
            // still the bootstrap, however little it found.
            phase: cursor === null ? "bootstrap" : "incremental",
            processed: 0,
            ...result.progress,
            coverage: "unknown",
            detail: HISTORY_COVERAGE_DETAIL,
          },
        };
      },
    };
  },
});
