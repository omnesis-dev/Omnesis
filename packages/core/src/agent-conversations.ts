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
export const AGENT_CONVERSATION_RENDER_VERSION = 2;

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** A single user or agent turn, normalized off whatever transport carried it. */
export interface ConversationMessage {
  role: "user" | "assistant";
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

/** Render one message as a titled block, preserving multi-line agent replies. */
function renderMessage(msg: ConversationMessage, agentName: string): string {
  const who = msg.role === "user" ? "You" : agentName;
  // Defensive for transports that don't pre-filter empty turns.
  const text = msg.text.trim() || "_(empty message)_";
  return `**${localHourMinute(msg.atMs)} · ${who}**\n${text}`;
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

  const title = `${agentName} · ${platformLabel(chat.platform)}${
    chat.chatName?.trim() ? ` — ${chat.chatName.trim()}` : ""
  } — ${dayKey}`;

  const content = [`# ${title}`, "", ...messages.map((m) => renderMessage(m, agentName))].join(
    "\n\n",
  );

  // The human is the only resolved participant; the agent is rendered as body
  // text, mirroring the built-in agent-chat source (which never adds the
  // assistant to the people graph). `isSelf` lets the gateway merge these
  // turns onto the canonical self person without the source knowing the
  // user's phone or email.
  const people: PersonMention[] = [{ role: "participant", name: "You", isSelf: true }];

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
