// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

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
import { claudeCodeIcon } from "./icon.js";
import { claudeCodeStateSpec } from "./state.js";

/**
 * Claude Code prunes local session transcripts older than its configured
 * retention window on its own schedule, independent of whether this source
 * has ever read a given file. A file already gone by the time a scan reaches
 * its directory looks identical to one that never existed, so this source
 * can never claim its corpus is the tool's complete history — only what was
 * on disk when it last looked.
 */
const HISTORY_COVERAGE_DETAIL =
  "Claude Code deletes old session transcripts on its own, and Omnesis removes what Claude Code removes, so older sessions may not be here.";

type Entry = Record<string, unknown>;

interface ClaudeNode {
  id: string;
  parentId: string | null;
  /**
   * Where the conversation continues across a compaction. Claude Code starts
   * each compacted continuation as a fresh root — `parentUuid: null` — and
   * records the message it continues from here instead, so the physical tree
   * ends at every compaction while the conversation does not.
   */
  logicalParentId?: string;
  /**
   * The main-chain message that was the conversation's tip when this
   * compaction boundary was first written. Claude Code usually names the same
   * message as `logicalParentId`, but it can instead name a message it carries
   * across the compaction and writes after the boundary, beneath the
   * continuation; the history before the compaction then ends here.
   */
  precedingLeaf?: string;
  /** Position of this node's first record in the file. */
  order: number;
  sidechain: boolean;
  atMs: number;
  cwd?: string;
  branch?: string;
  role?: "user" | "assistant";
  turnOrigin?: "human" | "automatic";
  text?: string;
  model?: string;
}

/**
 * Claude Code writes session-adjacent state into the same JSONL files as the
 * conversation tree. These records deliberately have no UUID/parent edge and
 * must not participate in transcript validation or leaf selection. Keep this
 * allowlist explicit so an unknown record shape still makes reconciliation
 * fail closed instead of silently dropping conversation data.
 */
const NON_TREE_RECORD_TYPES = new Set([
  "agent-name",
  "agent-color",
  "agent-setting",
  "artifact-autoreact-ledger",
  "artifact-comment-monitor",
  "atis-latch",
  "attribution-snapshot",
  "bridge-session",
  // Replacements only target persisted tool-result payloads, which this
  // source excludes from indexed conversation content.
  "content-replacement",
  // Per-session token, duration and line-count accounting. No tree edge and
  // no conversation content: every field is a total.
  "cost-state",
  "ended-by-model",
  "file-history-delta",
  "fork-context-ref",
  "frame-link",
  // Claude's persistence-sync taint does not redact the local transcript.
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
  // A workflow's journal: one record as each of its agents starts, and one
  // as it finishes or fails.
  "failed",
  "result",
  "started",
  "summary",
  "tag",
  "worktree-state",
]);

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

function nodeFromEntry(entry: Entry): ClaudeNode | null {
  if (typeof entry.uuid !== "string" || entry.uuid.length === 0) return null;
  const node: ClaudeNode = {
    id: entry.uuid,
    parentId: typeof entry.parentUuid === "string" ? entry.parentUuid : null,
    order: 0,
    sidechain: entry.isSidechain === true,
    atMs: atMs(entry.timestamp),
    cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
    branch: typeof entry.gitBranch === "string" ? entry.gitBranch : undefined,
  };
  // Only a compaction boundary may bridge to an earlier chain. Honouring the
  // field on any record would let an arbitrary line splice unrelated history
  // into the transcript.
  if (
    entry.type === "system" &&
    entry.subtype === "compact_boundary" &&
    typeof entry.logicalParentUuid === "string" &&
    entry.logicalParentUuid.length > 0
  ) {
    node.logicalParentId = entry.logicalParentUuid;
  }
  if (node.sidechain) return node;

  const message = record(entry.message);
  if (!message) return node;
  if (entry.type === "user" && message.role === "user") {
    if (entry.isMeta === true || entry.isCompactSummary === true) {
      node.turnOrigin = "automatic";
      return node;
    }
    const toolContext =
      Object.hasOwn(entry, "toolUseResult") ||
      Object.hasOwn(entry, "sourceToolUseID") ||
      typeof entry.sourceToolAssistantUUID === "string";
    if (toolContext) return node;
    const origin = record(entry.origin);
    const humanOrigin = origin?.kind === "human";
    if (!humanOrigin && (entry.origin !== undefined || entry.userType !== "external")) {
      node.turnOrigin = "automatic";
      return node;
    }
    const text = textContent(message.content);
    if (text) {
      node.role = "user";
      node.turnOrigin = "human";
      node.text = text;
    }
    return node;
  }
  if (entry.type !== "assistant" || message.role !== "assistant" || entry.isMeta === true) {
    return node;
  }

  const stopReason = message.stop_reason;
  if (
    entry.isApiErrorMessage === true ||
    (stopReason !== "end_turn" && stopReason !== "stop_sequence")
  ) {
    return node;
  }
  const text = textContent(message.content);
  if (text) {
    node.role = "assistant";
    node.text = text;
  }
  if (typeof message.model === "string") node.model = message.model;
  return node;
}

function sameClaudeNodeContent(left: ClaudeNode, right: ClaudeNode): boolean {
  return (
    left.sidechain === right.sidechain &&
    left.atMs === right.atMs &&
    left.branch === right.branch &&
    left.role === right.role &&
    left.turnOrigin === right.turnOrigin &&
    left.text === right.text &&
    left.model === right.model
  );
}

function parentGraphIsValid(nodes: Map<string, ClaudeNode>): boolean {
  const settled = new Set<string>();
  for (const start of nodes.keys()) {
    const path = new Set<string>();
    let id: string | null = start;
    let child: ClaudeNode | undefined;
    while (id && !settled.has(id)) {
      if (path.has(id)) return false;
      path.add(id);
      const node = nodes.get(id);
      if (!node) {
        // A forked subagent's transcript starts from a message in the agent
        // it was forked from, which lives in that agent's file. The edge
        // leaving the file is where the fork begins, not a lost record.
        if (child?.sidechain) {
          path.delete(id);
          break;
        }
        return false;
      }
      child = node;
      id = node.parentId;
    }
    for (const visited of path) settled.add(visited);
  }
  return true;
}

/**
 * Where the conversation continues from before a compaction boundary. The
 * boundary's own bridge is honoured when it names a message written before
 * it. A bridge naming a message written after it points into the
 * continuation — following it loops back to the boundary — so the history
 * instead ends at the conversation's tip as the boundary found it. A bridge
 * whose message is absent is returned unresolved, which fails the file closed.
 */
function continuationBefore(node: ClaudeNode, nodes: Map<string, ClaudeNode>): string | null {
  const bridge = node.logicalParentId;
  if (bridge === undefined) return null;
  const target = nodes.get(bridge);
  if (!target || target.order < node.order) return bridge;
  return node.precedingLeaf ?? bridge;
}

async function parseClaudeCodeSession(
  filePath: string,
  options: LocalAgentSessionParseOptions = {},
): Promise<ParsedLocalAgentSession> {
  const nodes = new Map<string, ClaudeNode>();
  let sessionId: string | undefined;
  let aiTitle: string | undefined;
  let customTitle: string | undefined;
  let selectedLeaf: string | null | undefined;
  let fallbackLeaf: string | undefined;
  let nodeOrder = 0;
  let structurallyComplete = true;
  // A file carrying only session-adjacent state has no conversation to
  // reconcile, and saying so is what lets deletion reconciliation proceed
  // past it. The verdict is taken from the records the branches below
  // actually recognised as such: a second, narrower list of type names drifts
  // from those branches, and every type missing from it leaves a
  // metadata-only file looking unreadable — which gaps its root for as long
  // as the file stays unchanged, so forever.
  let sawSessionState = false;
  let onlySessionState = true;
  const retain = createLocalAgentSessionRetentionGuard();

  const read = await readJsonLines(
    filePath,
    (value) => {
      const entry = record(value);
      if (!entry) {
        structurallyComplete = false;
        onlySessionState = false;
        return;
      }
      if (!sessionId && typeof entry.sessionId === "string") sessionId = entry.sessionId;
      if (entry.type === "ai-title" && typeof entry.aiTitle === "string") {
        sawSessionState = true;
        retain.upsert("metadata:ai-title", entry.aiTitle);
        aiTitle = entry.aiTitle;
        return;
      }
      if (entry.type === "custom-title") {
        sawSessionState = true;
        if (typeof entry.customTitle !== "string") {
          structurallyComplete = false;
          return;
        }
        retain.upsert("metadata:custom-title", entry.customTitle);
        customTitle = entry.customTitle;
        return;
      }
      if (entry.type === "file-history-snapshot" || entry.type === "queue-operation") {
        sawSessionState = true;
        return;
      }
      if (typeof entry.type === "string" && NON_TREE_RECORD_TYPES.has(entry.type)) {
        sawSessionState = true;
        return;
      }
      if (entry.type === "last-prompt") {
        sawSessionState = true;
        if (!Object.hasOwn(entry, "leafUuid")) return;
        if (entry.leafUuid === null && entry.explicit === true) {
          selectedLeaf = null;
          return;
        }
        if (typeof entry.leafUuid !== "string" || entry.leafUuid.length === 0) {
          structurallyComplete = false;
          return;
        }
        selectedLeaf = entry.leafUuid;
        return;
      }
      // Everything from here is read as part of the conversation tree, so the
      // file is no longer only session-adjacent state — including a record
      // whose type the parser does not know, which keeps failing closed below.
      onlySessionState = false;
      if (
        !Object.hasOwn(entry, "parentUuid") ||
        (entry.parentUuid !== null &&
          (typeof entry.parentUuid !== "string" || entry.parentUuid.length === 0))
      ) {
        structurallyComplete = false;
        return;
      }
      if (entry.type === "user" || entry.type === "assistant") {
        const message = record(entry.message);
        if (!message || message.role !== entry.type || !validContent(message.content)) {
          structurallyComplete = false;
          return;
        }
      }
      const node = nodeFromEntry(entry);
      if (!node) {
        structurallyComplete = false;
        return;
      }
      const previousNode = nodes.get(node.id);
      if (previousNode && !sameClaudeNodeContent(previousNode, node)) {
        structurallyComplete = false;
        return;
      }
      retain.upsert(
        `node:${node.id}`,
        node.id,
        node.parentId ?? undefined,
        node.logicalParentId,
        node.cwd,
        node.branch,
        node.text,
        node.model,
      );
      // Current Claude Code can replay a semantically identical node with a
      // corrected parent edge or working directory. Those mutable context fields
      // do not change conversation identity; the last record is the current state.
      node.order = previousNode ? previousNode.order : nodeOrder++;
      if (node.logicalParentId !== undefined) {
        node.precedingLeaf = previousNode ? previousNode.precedingLeaf : fallbackLeaf;
      }
      nodes.set(node.id, node);
      if (!node.sidechain) {
        // A clear-to-empty marker applies only until the next main-chain
        // transcript record. Continuing the conversation makes that record
        // the active fallback again.
        if (selectedLeaf === null && !previousNode) selectedLeaf = undefined;
        fallbackLeaf = node.id;
      }
    },
    options,
  );

  if (!sessionId) {
    return {
      id: basename(filePath, ".jsonl"),
      messages: [],
      ignored: true,
      // Known metadata-only files contain no conversation to reconcile. Empty,
      // unknown, damaged, or unidentified conversation records still fail closed.
      complete:
        sawSessionState &&
        onlySessionState &&
        structurallyComplete &&
        read.malformedLines === 0 &&
        !read.trailingPartial,
    };
  }
  if (!parentGraphIsValid(nodes)) structurallyComplete = false;
  if (typeof selectedLeaf === "string" && !nodes.has(selectedLeaf)) {
    structurallyComplete = false;
  }
  const leaf =
    selectedLeaf === null
      ? undefined
      : typeof selectedLeaf === "string" && nodes.has(selectedLeaf)
        ? selectedLeaf
        : fallbackLeaf;
  const reversed: ClaudeNode[] = [];
  const seen = new Set<string>();
  let id: string | null | undefined = leaf;
  while (id && !seen.has(id)) {
    seen.add(id);
    const node = nodes.get(id);
    if (!node) break;
    reversed.push(node);
    // Cross a compaction rather than stopping at it. Stopping read a session
    // compacted once as though it began at the compaction, and did so while
    // reporting the file complete: every day before it vanished from a fresh
    // read with nothing to say it had. A bridge whose target is absent ends
    // the walk with `id` still set, which fails the file closed below.
    id = node.parentId ?? continuationBefore(node, nodes);
  }
  if (id !== null && id !== undefined) structurallyComplete = false;

  let cwd: string | undefined;
  let branch: string | undefined;
  let model: string | undefined;
  const messages: ParsedLocalAgentSession["messages"] = [];
  let humanTurn = false;
  for (const node of reversed.reverse()) {
    if (node.cwd !== undefined) cwd = node.cwd;
    if (node.branch !== undefined) branch = node.branch;
    if (node.model !== undefined) model = node.model;
    if (node.turnOrigin === "human") humanTurn = true;
    if (node.turnOrigin === "automatic") humanTurn = false;
    if (node.role === "user" && node.text && node.atMs > 0) {
      messages.push({ role: node.role, text: node.text, atMs: node.atMs });
    } else if (node.role === "assistant" && node.text && node.atMs > 0 && humanTurn) {
      messages.push({ role: node.role, text: node.text, atMs: node.atMs });
      humanTurn = false;
    }
  }

  return {
    id: sessionId,
    cwd,
    name: customTitle?.trim() || aiTitle?.trim() || undefined,
    branch,
    model,
    messages,
    complete: read.malformedLines === 0 && structurallyComplete,
  };
}

function defaultSessionsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return join(configDir ? expandHostPath(configDir) : join(homedir(), ".claude"), "projects");
}

function sessionsPath(configured?: string): string {
  // Already resolved: the host expands a declared path before the factory sees
  // it, so what arrives is absolute and free of shell conventions. The
  // environment fallbacks are not declared settings and still need expanding.
  return configured?.trim() ? configured : defaultSessionsPath();
}

// The cursor type is pinned on `create`'s return rather than as a type
// argument: TypeScript infers every type argument or none, so naming the
// cursor here would default the configuration schema's type and hand `create`
// an untyped bag.
export default defineSource({
  id: "claude-code",
  name: "Claude Code Sessions",
  description: "Coding-agent conversations saved by Claude Code",
  provider: { id: "claude-code", name: "Claude Code" },
  authType: "local",
  unitName: "conversation days",
  primaryCount: "documents",
  singleInstance: true,
  multiDevice: { mode: "partitioned" },
  conversational: true,
  contentRetention: "best-effort",
  contract: {
    // The host resolves the stored cursor against this before `sync` runs,
    // so an unrecognised value is refused as unreadable rather than read as
    // "no sessions yet".
    state: claudeCodeStateSpec,
    apiVersion: 2,
    requires: ["state-envelope", "snapshot-sessions"],
  },
  documentEventProfile: createLocalAgentSessionDocumentEventProfile({
    harnessId: "claude-code",
    agentName: "Claude Code",
  }),
  icon: claudeCodeIcon,
  config: configSchema.object({
    sessionsPath: configSchema.path({
      label: "Sessions directory",
      help: "Where Claude Code writes session transcripts. Leave blank to use the location this machine already uses.",
      // Member-scoped: it names a directory on one machine. Two hosts running
      // this source will have it in different places, and one of them may not
      // have set it at all.
      scope: "member",
      placeholder: "~/.claude/projects",
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
        harnessId: "claude-code",
        agentName: "Claude Code",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 6,
        parseSession: parseClaudeCodeSession,
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
