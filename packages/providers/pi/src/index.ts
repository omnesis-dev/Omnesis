// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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
import { piIcon } from "./icon.js";
import { piStateSpec } from "./state.js";

/**
 * Pi removes old session files from its sessions directory on its own
 * schedule, independent of whether this source has ever read a given file. A
 * file already gone by the time a scan reaches its directory looks identical
 * to one that never existed, so this source can never claim its corpus is
 * the tool's complete history — only what was on disk when it last looked.
 */
const HISTORY_COVERAGE_DETAIL =
  "Pi deletes old session files on its own, and Omnesis removes what Pi removes, so older sessions may not be here.";

const DEFAULT_PI_AGENT_PATH = join(homedir(), ".pi", "agent");

type Entry = Record<string, unknown>;

interface PiNode {
  id: string;
  parentId: string | null;
  kind: string;
  atMs: number;
  role?: "user" | "assistant";
  text?: string;
  model?: string;
  name?: string;
}

function record(value: unknown): Entry | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Entry)
    : null;
}

function timestamp(value: unknown, fallback: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof fallback === "string") {
    const parsed = Date.parse(fallback);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function validContent(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (!Array.isArray(value)) return false;
  return value.every((valueBlock) => {
    const block = record(valueBlock);
    return (
      block !== null &&
      typeof block.type === "string" &&
      (block.type !== "text" || typeof block.text === "string")
    );
  });
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => record(block))
    .filter((block): block is Entry => block?.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text).trim())
    .filter(Boolean)
    .join("\n\n");
}

function nodeFromEntry(entry: Entry): PiNode | null {
  if (typeof entry.id !== "string" || entry.id.length === 0) return null;
  const parentId = typeof entry.parentId === "string" ? entry.parentId : null;
  const kind = typeof entry.type === "string" ? entry.type : "unknown";
  const node: PiNode = {
    id: entry.id,
    parentId,
    kind,
    atMs: timestamp(undefined, entry.timestamp),
  };

  if (kind === "session_info" && typeof entry.name === "string") node.name = entry.name;
  if (
    kind === "model_change" &&
    typeof entry.provider === "string" &&
    typeof entry.modelId === "string"
  ) {
    node.model = `${entry.provider}/${entry.modelId}`;
  }
  if (kind !== "message") return node;

  const message = record(entry.message);
  if (!message || (message.role !== "user" && message.role !== "assistant")) return node;
  node.atMs = timestamp(message.timestamp, entry.timestamp);
  node.role = message.role;
  if (
    message.role === "assistant" &&
    typeof message.provider === "string" &&
    typeof message.model === "string"
  ) {
    node.model = `${message.provider}/${message.model}`;
  }

  const stopReason = message.stopReason;
  if (message.role === "assistant" && stopReason !== "stop") return node;
  const text = textContent(message.content);
  if (text) node.text = text;
  return node;
}

function parentGraphIsValid(nodes: Map<string, PiNode>): boolean {
  const settled = new Set<string>();
  for (const start of nodes.keys()) {
    const path = new Set<string>();
    let id: string | null = start;
    while (id && !settled.has(id)) {
      if (path.has(id)) return false;
      path.add(id);
      const node = nodes.get(id);
      if (!node) return false;
      id = node.parentId;
    }
    for (const visited of path) settled.add(visited);
  }
  return true;
}

function parentSessionId(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const file = basename(value, ".jsonl");
  return file.split("_").at(-1) || file;
}

async function parsePiSession(
  filePath: string,
  options: LocalAgentSessionParseOptions = {},
): Promise<ParsedLocalAgentSession> {
  let header: Entry | null = null;
  const nodes = new Map<string, PiNode>();
  const linear: PiNode[] = [];
  let leafId: string | null = null;
  let legacyIndex = 0;
  let structurallyComplete = true;
  const retain = createLocalAgentSessionRetentionGuard();

  const read = await readJsonLines(
    filePath,
    (value) => {
      const entry = record(value);
      if (!entry) {
        structurallyComplete = false;
        return;
      }
      if (entry.type === "session" && !header) {
        header = entry;
        return;
      }
      const normalized =
        typeof entry.id === "string" || (header?.version ?? 1) !== 1
          ? entry
          : {
              ...entry,
              id: `legacy-${legacyIndex++}`,
              parentId: leafId,
            };
      if (
        !Object.hasOwn(normalized, "parentId") ||
        (normalized.parentId !== null &&
          (typeof normalized.parentId !== "string" || normalized.parentId.length === 0))
      ) {
        structurallyComplete = false;
        return;
      }
      if (normalized.type === "message") {
        const message = record(normalized.message);
        if (!message || typeof message.role !== "string" || !validContent(message.content)) {
          structurallyComplete = false;
          return;
        }
      }
      const node = nodeFromEntry(normalized);
      if (!node) {
        structurallyComplete = false;
        return;
      }
      if (nodes.has(node.id)) {
        structurallyComplete = false;
        return;
      }
      retain(node.id, node.parentId ?? undefined, node.kind, node.text, node.model, node.name);
      nodes.set(node.id, node);
      linear.push(node);
      leafId = node.id;
    },
    options,
  );

  const parsedHeader = header as Entry | null;
  if (
    !parsedHeader ||
    typeof parsedHeader.id !== "string" ||
    parsedHeader.id.length === 0 ||
    typeof parsedHeader.cwd !== "string"
  ) {
    // One malformed file among the batch: the shared harness's per-file catch
    // (`createLocalAgentSessionSource`) marks this file incomplete and moves
    // on to the next one in the page, so the failure never reaches beyond
    // the file that caused it.
    throw new SyncError("unknown", "Pi session has no valid header", { scope: "item" });
  }

  if (!parentGraphIsValid(nodes)) structurallyComplete = false;

  let active = linear;
  if (leafId && nodes.size > 0) {
    const reversed: PiNode[] = [];
    const seen = new Set<string>();
    let id: string | null = leafId;
    while (id && !seen.has(id)) {
      seen.add(id);
      const node = nodes.get(id);
      if (!node) break;
      reversed.push(node);
      id = node.parentId;
    }
    if (id !== null) structurallyComplete = false;
    active = reversed.reverse();
  }

  let name: string | undefined;
  let model: string | undefined;
  const messages: ParsedLocalAgentSession["messages"] = [];
  let humanTurn = false;
  for (const node of active) {
    if (node.name !== undefined) name = node.name;
    if (node.model !== undefined) model = node.model;
    if (node.role === "user" && node.text && node.atMs > 0) {
      messages.push({ role: node.role, text: node.text, atMs: node.atMs });
      humanTurn = true;
    } else if (node.role === "assistant" && node.text && node.atMs > 0 && humanTurn) {
      messages.push({ role: node.role, text: node.text, atMs: node.atMs });
      humanTurn = false;
    }
  }

  return {
    id: parsedHeader.id,
    cwd: parsedHeader.cwd,
    name,
    model,
    parentSessionId: parentSessionId(parsedHeader.parentSession),
    messages,
    complete: read.malformedLines === 0 && structurallyComplete,
  };
}

function piAgentPath(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  return configured ? expandHostPath(configured) : DEFAULT_PI_AGENT_PATH;
}

function configuredSessionDir(agentPath: string): string | undefined {
  try {
    const settings = record(JSON.parse(readFileSync(join(agentPath, "settings.json"), "utf8")));
    return typeof settings?.sessionDir === "string" && settings.sessionDir.trim()
      ? expandHostPath(settings.sessionDir.trim())
      : undefined;
  } catch {
    return undefined;
  }
}

function sessionsPath(configured?: string): string {
  // Already resolved: the host expands a declared path before the factory sees
  // it, so what arrives is absolute and free of shell conventions. The
  // environment fallbacks are not declared settings and still need expanding.
  if (configured?.trim()) return configured;
  const fromEnvironment = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (fromEnvironment) return expandHostPath(fromEnvironment);
  const agentPath = piAgentPath();
  return configuredSessionDir(agentPath) ?? join(agentPath, "sessions");
}

// The cursor type is pinned on `create`'s return rather than as a type
// argument: TypeScript infers every type argument or none, so naming the
// cursor here would default the configuration schema's type and hand `create`
// an untyped bag.
export default defineSource({
  id: "pi",
  name: "Pi Sessions",
  description: "Coding-agent conversations saved by Pi",
  provider: { id: "pi", name: "Pi" },
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
    state: piStateSpec,
    apiVersion: 2,
    requires: ["state-envelope", "snapshot-sessions"],
  },
  documentEventProfile: createLocalAgentSessionDocumentEventProfile({
    harnessId: "pi",
    agentName: "Pi",
  }),
  icon: piIcon,
  config: configSchema.object({
    sessionsPath: configSchema.path({
      label: "Sessions directory",
      help: "Where Pi writes session transcripts. Leave blank to use the location this machine already uses.",
      // Member-scoped: it names a directory on one machine. Two hosts running
      // this source will have it in different places, and one of them may not
      // have set it at all.
      scope: "member",
      placeholder: "~/.pi/agent/sessions",
      mustExist: "directory",
    }),
  }),

  async create({
    sourceId,
    providerId,
    dataCutoff,
    config,
  }): Promise<SourceInstance<LocalAgentSessionCursor>> {
    const root = sessionsPath(config?.sessionsPath);
    const instance = createLocalAgentSessionSource({
      providerId,
      sourceId,
      dataCutoff,
      adapter: {
        harnessId: "pi",
        agentName: "Pi",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 2,
        parseSession: parsePiSession,
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
