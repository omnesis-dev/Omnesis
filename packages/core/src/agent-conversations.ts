// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Agent-conversation documents — the shared, transport-agnostic layer for
 * sources that ingest a user's conversations with an external AI agent
 * (OpenClaw, Hermes, …).
 *
 * The model here is deliberately independent of HOW the messages were
 * obtained. Today the collector-hosted providers read each harness's local
 * store and feed this renderer; a push transport (a harness-side plugin
 * POSTing messages to the gateway, which projects them into day documents)
 * would feed the exact same renderer. Because the `externalId` scheme and the
 * rendered body are defined here once, documents stay byte-identical across
 * transports — swapping the transport never re-embeds a document or breaks an
 * upsert key.
 *
 * Shape: one document per (platform, chat, local calendar day), dialogue-only
 * — the human's turns and the agent's replies, no tool traces or agent
 * telemetry. Modeled on WhatsApp's day-chat documents and `omnesis-chat`'s
 * dialogue-only rendering.
 */

import { computeContentHash } from "./utils.js";
import type { DocumentInput, PersonMention, ProviderId, SourceId } from "@omnesis/types";

/** Bump when the rendered identity, content, or metadata contract changes. */
export const AGENT_CONVERSATION_RENDER_VERSION = 3;

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Harness-reported authorship, never inferred from message text or role alone. */
export interface ConversationAuthor {
  kind: "owner" | "agent" | "participant" | "unknown";
  id?: string;
  name?: string;
}

/** A single user or agent turn, normalized off whatever transport carried it. */
export interface ConversationMessage {
  role: "user" | "assistant";
  author?: ConversationAuthor;
  /** The message text (any harness-side context injection already stripped). */
  text: string;
  /** Unix epoch milliseconds. */
  atMs: number;
}

/** The (platform, chat) identity of a conversation, plus display hints. */
export interface ConversationChat {
  /** Harness channel: `slack`, `telegram`, `whatsapp`, `cli`, … */
  platform: string;
  /** Stable chat id within the platform; `""` for a host-local surface (CLI). */
  chatId: string;
  /** Human-readable chat name when the harness records one. */
  chatName?: string;
  /** `dm`, `group`, … when the harness records it. */
  chatType?: string;
}

/** One (platform, chat, day) bucket and its full day of messages. */
export interface ConversationDay {
  chat: ConversationChat;
  dayKey: string;
  messages: ConversationMessage[];
}

// ---------------------------------------------------------------------------
// Local-day bucketing
// ---------------------------------------------------------------------------
// A conversation document aggregates one calendar day of one chat. The day is
// the ingesting host's LOCAL day, not UTC — a message sent at 00:30 belongs to
// the day the user experienced it, matching how the notes daily doc keys on
// the gateway-local day rather than UTC. WhatsApp keys on UTC for a different
// reason (a companion device fixed to the account's own clock); an agent
// conversation has no such anchor, so local time is the honest choice.

/** Local calendar-day key (`YYYY-MM-DD`) for a unix-ms instant. */
export function localDayKey(atMs: number): string {
  const d = new Date(atMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * `[startMs, endMs)` epoch bounds of a local day key, computed with the same
 * local-time constructor as {@link localDayKey} so the two never disagree at a
 * DST edge.
 */
export function localDayBounds(dayKey: string): { startMs: number; endMs: number } {
  const [y, m, d] = dayKey.split("-").map(Number);
  const startMs = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const endMs = new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime();
  return { startMs, endMs };
}

/** Local `HH:MM` for a unix-ms instant, for message rendering. */
export function localHourMinute(atMs: number): string {
  const d = new Date(atMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Chat id used in keys/URLs for a host-local surface with no platform chat id. */
const LOCAL_CHAT = "local";

/** Human-facing platform labels; falls back to a capitalized channel id. */
const PLATFORM_LABELS: Record<string, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  slack: "Slack",
  discord: "Discord",
  matrix: "Matrix",
  mattermost: "Mattermost",
  signal: "Signal",
  imessage: "iMessage",
  cli: "CLI",
  local: "Local",
};

export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform.charAt(0).toUpperCase() + platform.slice(1);
}

/** Composite upsert key: `<platform>:<chatId|local>:<YYYY-MM-DD>`. */
export function conversationExternalId(chat: ConversationChat, dayKey: string): string {
  return `${chat.platform}:${chat.chatId || LOCAL_CHAT}:${dayKey}`;
}

export interface RenderConversationDayOptions {
  chat: ConversationChat;
  dayKey: string;
  /** Ordered ascending by time; must be non-empty. */
  messages: ConversationMessage[];
  providerId: ProviderId;
  sourceId: SourceId;
  /** Display name of the agent, e.g. `Hermes` / `OpenClaw`. */
  agentName: string;
  /** Stable harness id used in keys / tags / provenance, e.g. `hermes`. */
  harnessId: string;
  /** How the transcript reached Omnesis. Defaults to the existing push path. */
  provenance?: "harness-pushed" | "local-session-file";
}

/** Display metadata also travels outside Markdown, for example embedding preambles. */
function singleLineLabel(value: string): string {
  return value
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .replace(/[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ");
}

/** Labels cannot introduce Markdown, HTML, or a second structural line. */
function escapeLabel(value: string): string {
  return singleLineLabel(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]()#+.!|~-]/g, "\\$&");
}

function messageAuthor(msg: ConversationMessage, agentName: string): ConversationAuthor {
  const author = msg.author ?? { kind: msg.role === "assistant" ? "agent" : "unknown" };
  if (
    (msg.role === "assistant" && !["agent", "unknown"].includes(author.kind)) ||
    (msg.role === "user" && author.kind === "agent")
  )
    return { kind: "unknown" };
  return author.kind === "agent" ? { ...author, name: author.name ?? agentName } : author;
}

export interface ConversationTurn {
  author: ConversationAuthor;
  /** Original local display time; do not reinterpret it in the indexer's timezone. */
  time: string;
  atMs: number;
  text: string;
}

/** Literal bodies cannot terminate their own fence, even with nested fences or HTML. */
export function renderConversationTurn(turn: ConversationTurn): string {
  const author = turn.author;
  const name = author.name ? ` (${escapeLabel(author.name)})` : "";
  const who =
    author.kind === "owner"
      ? "You"
      : author.kind === "agent"
        ? `Agent${name}`
        : author.kind === "participant"
          ? `Participant${name}`
          : `Unknown participant${name}`;
  let longest = 0;
  for (const run of turn.text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `**${turn.time} · ${who}**\n\n${fence}text\n${turn.text}\n${fence}`;
}

/**
 * Recover explicit turn boundaries for retrieval without recognizing headings in
 * message text. Ranges avoid storing a second full copy of each day's transcript.
 * A malformed declared contract must not fall back to heuristics over its body.
 */
export function readConversationTurns(content: string, value: unknown): ConversationTurn[] | null {
  if (value === undefined) return null;
  const fail = (): never => {
    throw new Error("Invalid structured conversation turn ranges");
  };
  if (!value || typeof value !== "object") return fail();
  const contract = value as { version?: unknown; turns?: unknown };
  if (contract.version !== 1 || !Array.isArray(contract.turns) || !contract.turns.length)
    return fail();
  let previousEnd = 0;
  const turns = contract.turns.map((raw: unknown) => {
    if (!raw || typeof raw !== "object") return fail();
    const r = raw as Record<string, unknown>;
    const author = r.author as ConversationAuthor | undefined;
    if (
      !author ||
      !["owner", "agent", "participant", "unknown"].includes(author.kind) ||
      (author.name !== undefined &&
        (typeof author.name !== "string" || author.name.length > 200)) ||
      (author.id !== undefined && (typeof author.id !== "string" || author.id.length > 256)) ||
      typeof r.time !== "string" ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(r.time) ||
      typeof r.atMs !== "number" ||
      !Number.isFinite(r.atMs) ||
      typeof r.start !== "number" ||
      !Number.isSafeInteger(r.start) ||
      r.start < previousEnd ||
      typeof r.end !== "number" ||
      !Number.isSafeInteger(r.end) ||
      r.end > content.length ||
      typeof r.bodyStart !== "number" ||
      !Number.isSafeInteger(r.bodyStart) ||
      r.bodyStart < r.start ||
      typeof r.bodyEnd !== "number" ||
      !Number.isSafeInteger(r.bodyEnd) ||
      r.bodyEnd < r.bodyStart ||
      r.bodyEnd > r.end
    )
      return fail();
    const turn = {
      author,
      time: r.time,
      atMs: r.atMs,
      text: content.slice(r.bodyStart, r.bodyEnd),
    };
    if (renderConversationTurn(turn) !== content.slice(r.start, r.end)) return fail();
    if (previousEnd > 0 && content.slice(previousEnd, r.start) !== "\n\n") return fail();
    previousEnd = r.end;
    return turn;
  });
  if (previousEnd !== content.length) return fail();
  return turns;
}

/**
 * Render one calendar day of one agent conversation into a `DocumentInput`.
 *
 * Pure function of its inputs: the same messages always produce the same
 * `contentHash`, which is what makes the re-render-the-whole-day sync shape
 * idempotent (an unchanged day upserts as a no-op).
 */
export function renderConversationDay(opts: RenderConversationDayOptions): DocumentInput {
  const {
    chat,
    dayKey,
    messages,
    providerId,
    sourceId,
    agentName,
    harnessId,
    provenance = "harness-pushed",
  } = opts;
  if (messages.length === 0) {
    throw new Error("renderConversationDay called with no messages");
  }

  const title = singleLineLabel(
    `${agentName} · ${platformLabel(chat.platform)}${
      chat.chatName?.trim() ? ` — ${chat.chatName.trim()}` : ""
    } — ${dayKey}`,
  );

  let content = `# ${escapeLabel(title)}`;
  const turns = messages.map((msg) => {
    const turn = {
      author: messageAuthor(msg, agentName),
      time: localHourMinute(msg.atMs),
      atMs: msg.atMs,
      text: msg.text.trim() || "(empty message)",
    };
    const rendered = renderConversationTurn(turn);
    content += "\n\n";
    const start = content.length;
    // The first two newlines separate the heading; the third starts the body.
    const bodyStart = start + rendered.indexOf("\n", rendered.indexOf("\n\n") + 2) + 1;
    content += rendered;
    return {
      author: turn.author,
      time: turn.time,
      atMs: turn.atMs,
      start,
      end: content.length,
      bodyStart,
      bodyEnd: bodyStart + turn.text.length,
    };
  });
  // Unknown/group participants must never be linked to the owner's person.
  const people: PersonMention[] = turns.some((turn) => turn.author.kind === "owner")
    ? [{ role: "participant", name: "You", isSelf: true }]
    : [];

  const firstMs = messages[0].atMs;
  const lastMs = messages[messages.length - 1].atMs;

  return {
    providerId,
    sourceId,
    externalId: conversationExternalId(chat, dayKey),
    title,
    content,
    contentHash: computeContentHash(content),
    metadata: {
      documentType: "conversation",
      // High-churn aggregate: route continuous edits to the daily briefs batch
      // instead of waking the real-time agent on every new turn.
      rollingAggregate: true,
      tags: [harnessId, chat.platform],
      people,
      extra: {
        harness: harnessId,
        agent: agentName,
        channel: chat.platform,
        chatId: chat.chatId || null,
        chatName: chat.chatName ?? null,
        chatType: chat.chatType ?? null,
        messageCount: messages.length,
        conversationTurns: { version: 1, turns },
        // These transcripts are the harness's own report of the conversation —
        // its process could fabricate a message — so they are NOT a trust
        // anchor on their own. Marked so a later corroboration pass can
        // distinguish them from independently-witnessed channels.
        provenance,
      },
    },
    sourceCreatedAt: new Date(firstMs).toISOString(),
    sourceUpdatedAt: new Date(lastMs).toISOString(),
  };
}
