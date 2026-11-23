// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
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
  type LocalAgentSessionRoot,
  type ParsedLocalAgentSession,
} from "@omnesis/source-sdk/local-agent-sessions";
import { SyncError } from "@omnesis/types";
import { antigravityIcon } from "./icon.js";
import { antigravityStateSpec } from "./state.js";

/**
 * Antigravity manages conversation directories under `~/.gemini/antigravity-cli/brain`
 * and `~/.gemini/antigravity/brain` on its own lifecycle. A conversation removed
 * before a scan looks identical to one that never existed, so this source can
 * only vouch for what was on disk when it last looked.
 */
const HISTORY_COVERAGE_DETAIL =
  "Antigravity manages its local conversation transcripts on its own, and Omnesis removes what Antigravity removes, so older sessions may not be here.";

const TRANSCRIPT_FILENAME = "transcript_full.jsonl";

type Entry = Record<string, unknown>;

interface ConversationSummary {
  title?: string;
  cwd?: string;
  parentSessionId?: string;
  isSubagent: boolean;
}

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

/**
 * Antigravity wraps explicit user prompts in `<USER_REQUEST>…</USER_REQUEST>`
 * followed by `<ADDITIONAL_METADATA>` and optional `<USER_SETTINGS_CHANGE>`
 * blocks. Extract the prompt text when wrapped; fall back to raw content.
 */
function extractUserRequest(content: string): string {
  const openTag = "<USER_REQUEST>";
  const closeTag = "</USER_REQUEST>";
  const start = content.indexOf(openTag);
  if (start !== -1) {
    const bodyStart = start + openTag.length;
    const end = content.indexOf(closeTag, bodyStart);
    if (end !== -1) {
      return content.slice(bodyStart, end).trim();
    }
  }
  return content.trim();
}

function firstWorkspacePath(workspaceUrisRaw: unknown): string | undefined {
  if (typeof workspaceUrisRaw !== "string" || !workspaceUrisRaw.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(workspaceUrisRaw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  for (const item of parsed) {
    if (typeof item !== "string" || !item.trim()) continue;
    if (item.startsWith("file://")) {
      try {
        return fileURLToPath(item);
      } catch {
        continue;
      }
    }
    if (isAbsolute(item)) return item;
  }
  return undefined;
}

function readConversationSummary(
  appDataDir: string,
  conversationId: string,
): ConversationSummary | null {
  const dbPath = join(appDataDir, "conversation_summaries.db");
  if (!existsSync(dbPath)) return null;
  try {
    if (!lstatSync(dbPath).isFile()) return null;
  } catch {
    return null;
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare(
        "SELECT title, workspace_uris, parent_conversation_id, nesting_depth FROM conversation_summaries WHERE conversation_id = ?",
      )
      .get(conversationId) as
      | {
          title?: unknown;
          workspace_uris?: unknown;
          parent_conversation_id?: unknown;
          nesting_depth?: unknown;
        }
      | undefined;

    let parentId =
      typeof row?.parent_conversation_id === "string" && row.parent_conversation_id.trim()
        ? row.parent_conversation_id.trim()
        : undefined;
    const nestingDepth = typeof row?.nesting_depth === "number" ? row.nesting_depth : 0;

    if (!parentId && nestingDepth === 0) {
      try {
        const parentRow = db
          .prepare("SELECT parent_id FROM conversation_parents WHERE conversation_id = ?")
          .get(conversationId) as { parent_id?: unknown } | undefined;
        if (typeof parentRow?.parent_id === "string" && parentRow.parent_id.trim()) {
          parentId = parentRow.parent_id.trim();
        }
      } catch {
        // Older or minimal databases may omit conversation_parents.
      }
    }

    if (!row && !parentId) return null;

    const title = typeof row?.title === "string" && row.title.trim() ? row.title.trim() : undefined;
    const cwd = firstWorkspacePath(row?.workspace_uris);
    return {
      title,
      cwd,
      parentSessionId: parentId,
      isSubagent: Boolean(parentId) || nestingDepth > 0,
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Restrict scanning and read-access probing to the exact path shape
 * `<conversation-id>/.system_generated/logs/transcript_full.jsonl` inside a
 * `brain/` root. Antigravity writes hundreds of per-step output directories
 * under `.system_generated/steps/`, chunked logs under `logs/chunks/`, and
 * arbitrary user artifacts alongside `.system_generated/`, none of which are
 * root session transcripts.
 */
export function excludeAntigravityPath(relativePath: string, isDirectory: boolean): boolean {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return false;
  if (isDirectory) {
    if (parts.length === 1) return parts[0]!.startsWith(".");
    if (parts.length === 2) return parts[1] !== ".system_generated";
    if (parts.length === 3) return parts[2] !== "logs";
    return true;
  }
  return !(
    parts.length === 4 &&
    !parts[0]!.startsWith(".") &&
    parts[1] === ".system_generated" &&
    parts[2] === "logs" &&
    parts[3] === TRANSCRIPT_FILENAME
  );
}

function conversationLocation(filePath: string): { sessionId: string; appDataDir: string } | null {
  if (basename(filePath) !== TRANSCRIPT_FILENAME) return null;
  const logsDir = dirname(filePath);
  if (basename(logsDir) !== "logs") return null;
  const systemDir = dirname(logsDir);
  if (basename(systemDir) !== ".system_generated") return null;
  const conversationDir = dirname(systemDir);
  const sessionId = basename(conversationDir);
  if (!sessionId || sessionId === "." || sessionId === ".." || sessionId.startsWith(".")) {
    return null;
  }
  const brainDir = dirname(conversationDir);
  const appDataDir = dirname(brainDir);
  return { sessionId, appDataDir };
}

async function parseAntigravitySession(
  filePath: string,
  options: LocalAgentSessionParseOptions = {},
): Promise<ParsedLocalAgentSession> {
  const location = conversationLocation(filePath);
  if (!location) {
    throw new SyncError("unknown", "Antigravity transcript path is not inside a conversation dir", {
      scope: "item",
    });
  }

  const { sessionId, appDataDir } = location;
  const summary = readConversationSummary(appDataDir, sessionId);

  let model: string | undefined;
  let sawRecord = false;
  let sawUserExplicit = false;
  let structurallyComplete = true;
  const messages: ParsedLocalAgentSession["messages"] = [];
  const retain = createLocalAgentSessionRetentionGuard();

  const read = await readJsonLines(
    filePath,
    (value): void | boolean => {
      if (summary?.isSubagent) return false;

      const entry = record(value);
      if (!entry || typeof entry.type !== "string" || entry.type.length === 0) {
        structurallyComplete = false;
        return;
      }
      sawRecord = true;

      if (entry.type === "USER_INPUT") {
        if (entry.source !== "USER_EXPLICIT") return;
        const occurredAt = atMs(entry.created_at);
        if (typeof entry.content !== "string" || occurredAt <= 0) {
          structurallyComplete = false;
          return;
        }
        sawUserExplicit = true;
        const text = extractUserRequest(entry.content);
        if (text) {
          retain(text);
          messages.push({ role: "user", text, atMs: occurredAt });
        }
        return;
      }

      if (entry.type === "PLANNER_RESPONSE") {
        if (entry.model !== undefined && typeof entry.model !== "string") {
          structurallyComplete = false;
        } else if (typeof entry.model === "string" && entry.model.trim()) {
          model = entry.model.trim();
        }
        if (entry.tool_calls !== undefined && !Array.isArray(entry.tool_calls)) {
          structurallyComplete = false;
          return;
        }
        if (entry.content !== undefined && typeof entry.content !== "string") {
          structurallyComplete = false;
          return;
        }
        const hasToolCalls = Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0;
        const statusOk = entry.status === undefined || entry.status === "DONE";
        if (hasToolCalls || !statusOk || typeof entry.content !== "string") return;

        const text = entry.content.trim();
        if (!text) return;
        const occurredAt = atMs(entry.created_at);
        if (occurredAt <= 0) {
          structurallyComplete = false;
          return;
        }
        if (sawUserExplicit) {
          retain(text);
          messages.push({ role: "assistant", text, atMs: occurredAt });
        }
      }
    },
    options,
  );

  // Conversations without any explicit user prompt (e.g. spawned subagents that
  // begin with a SYSTEM_MESSAGE) are internal delegated runs, not root sessions.
  const ignoredSession = Boolean(summary?.isSubagent) || (sawRecord && !sawUserExplicit);
  return {
    id: sessionId,
    cwd: summary?.cwd,
    name: summary?.title,
    model,
    parentSessionId: summary?.parentSessionId,
    messages: ignoredSession ? [] : messages,
    ignored: ignoredSession,
    complete: read.malformedLines === 0 && structurallyComplete,
  };
}

function antigravityRoots(configured?: string): LocalAgentSessionRoot[] {
  // Already resolved when arriving from declared config; env fallbacks still need expanding.
  const explicit = configured?.trim()
    ? configured.trim()
    : process.env.ANTIGRAVITY_HOME?.trim()
      ? expandHostPath(process.env.ANTIGRAVITY_HOME.trim())
      : undefined;
  if (explicit) {
    const brainPath = basename(explicit) === "brain" ? explicit : join(explicit, "brain");
    return [{ path: brainPath, id: "brain" }];
  }
  const geminiRoot = join(homedir(), ".gemini");
  return [
    { path: join(geminiRoot, "antigravity-cli", "brain"), id: "antigravity-cli", optional: true },
    { path: join(geminiRoot, "antigravity", "brain"), id: "antigravity", optional: true },
  ];
}

export default defineSource({
  id: "antigravity",
  name: "Antigravity Sessions",
  description: "Coding-agent conversations saved by Antigravity",
  provider: { id: "antigravity", name: "Antigravity" },
  authType: "local",
  unitName: "conversation days",
  primaryCount: "documents",
  singleInstance: true,
  multiDevice: { mode: "partitioned" },
  conversational: true,
  contract: {
    state: antigravityStateSpec,
    apiVersion: 2,
    requires: ["state-envelope", "snapshot-sessions"],
  },
  documentEventProfile: createLocalAgentSessionDocumentEventProfile({
    harnessId: "antigravity",
    agentName: "Antigravity",
  }),
  icon: antigravityIcon,
  config: configSchema.object({
    antigravityHome: configSchema.path({
      label: "Antigravity home",
      help: "Where Antigravity keeps its brain directory. Leave blank to collect from ~/.gemini/antigravity-cli and ~/.gemini/antigravity.",
      scope: "member",
      placeholder: "~/.gemini/antigravity-cli",
      mustExist: "directory",
    }),
  }),

  async create({
    sourceId,
    providerId,
    dataCutoff,
    config,
  }): Promise<SourceInstance<LocalAgentSessionCursor>> {
    const roots = antigravityRoots(config?.antigravityHome);
    const instance = createLocalAgentSessionSource({
      providerId,
      sourceId,
      dataCutoff,
      adapter: {
        harnessId: "antigravity",
        agentName: "Antigravity",
        roots,
        fileExtensions: [TRANSCRIPT_FILENAME],
        exclude: excludeAntigravityPath,
        parserVersion: 1,
        duplicateSessionPolicy: "newest",
        parseSession: parseAntigravitySession,
      },
    });
    return {
      ...instance,
      async sync(cursor, syncOptions) {
        const result = await instance.sync(cursor, syncOptions);
        return {
          ...result,
          progress: {
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
