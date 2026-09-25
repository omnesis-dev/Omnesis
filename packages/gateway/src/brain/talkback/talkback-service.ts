// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Opening an anchored follow-up thread — "talk back to the brief". The flow
 * finds the transcript of the steward run that created the brief, folds it
 * into conversation history, creates the anchored conversation, and stamps
 * it onto the brief's row — exactly once, so every client converges on one
 * thread per brief.
 *
 * The seeded history is what makes the thread feel like continuity rather
 * than a cold start: the agent literally re-enters the run in which it
 * made the brief. When an explicitly configured activity/transcript
 * retention window has pruned that transcript, the thread falls back to a
 * compact context message built from the brief row itself — less vivid,
 * still anchored.
 */

import { getBrief } from "../storage/briefs.js";
import { transcriptToHistory } from "./transcript-history.js";
import type Database from "better-sqlite3";
import type { ChatMessage } from "@omnesis/agent";
import type { Logger } from "@omnesis/core";
import type { CallerId, CreateAnchoredThreadInput } from "../../agent/service.js";
import type { FsCognitionTranscriptStore } from "../transcripts.js";
import type { BriefRow, Clock } from "../storage/types.js";

type Db = Database.Database;

export interface BriefTalkbackDeps {
  db: Db;
  writeGate: {
    setBriefThreadConversation(id: string, conversationId: string, now: number): Promise<boolean>;
    restampBriefThreadConversation(
      id: string,
      deadConversationId: string,
      conversationId: string,
      now: number,
    ): Promise<boolean>;
  };
  transcripts: FsCognitionTranscriptStore;
  /** Live handle — the agent service is rebuilt on model swaps. */
  getAgentService: () => TalkbackAgentPort | null;
  clock: Clock;
  log: Logger;
}

/** The slice of the agent service the talk-back opener needs. */
export interface TalkbackAgentPort {
  createAnchoredThread(callerId: CallerId, input: CreateAnchoredThreadInput): Promise<string>;
  deleteConversation(id: string): Promise<boolean>;
  /** True when the conversation still exists (live or on disk). */
  conversationExists(id: string): Promise<boolean>;
}

export interface OpenThreadResult {
  conversationId: string;
  /** False when the brief already had a thread and it was reused. */
  created: boolean;
}

export class BriefNotFoundError extends Error {}
export class TalkbackUnavailableError extends Error {}

export interface BriefTalkbackPort {
  openThread(callerId: string, briefId: string): Promise<OpenThreadResult>;
}

/**
 * The brief open flow: reuse a live stamped thread, replace a dead
 * pointer, else mint + CAS-stamp — a lost race deletes the just-minted
 * conversation and converges on the winner.
 */
async function openAnchoredThread(
  deps: BriefTalkbackDeps,
  anchor: {
    label: string;
    threadConversationId: string | null;
    create(service: TalkbackAgentPort): Promise<string>;
    stamp(conversationId: string): Promise<boolean>;
    restamp(deadId: string, conversationId: string): Promise<boolean>;
    /** Re-read the anchor's pointer after a lost stamp race. */
    currentThreadId(): string | null | undefined;
  },
): Promise<OpenThreadResult> {
  const service = deps.getAgentService();
  if (!service) {
    throw new TalkbackUnavailableError("the agent harness is disabled");
  }
  // Reuse the stamped thread only while its conversation still exists —
  // the user can delete a thread from any conversations list, and a dead
  // pointer must not brick talk-back for the brief forever.
  const deadThreadId =
    anchor.threadConversationId && !(await service.conversationExists(anchor.threadConversationId))
      ? anchor.threadConversationId
      : null;
  if (anchor.threadConversationId && deadThreadId === null) {
    return { conversationId: anchor.threadConversationId, created: false };
  }

  const conversationId = await anchor.create(service);
  const stamped = deadThreadId
    ? // Replace the dead pointer; CAS on the dead id so two concurrent
      // re-opens converge on one replacement.
      await anchor.restamp(deadThreadId, conversationId)
    : await anchor.stamp(conversationId);
  if (!stamped) {
    // A concurrent open won the stamp — converge on its thread and drop
    // the conversation this call minted. The winner is re-checked for
    // existence: it may itself have been deleted since it was stamped
    // (rare double-dead race), and handing back a dead id would strand
    // the client until the next open re-heals it.
    const winner = anchor.currentThreadId();
    void service.deleteConversation(conversationId).catch(() => {});
    if (winner && winner !== deadThreadId && (await service.conversationExists(winner))) {
      return { conversationId: winner, created: false };
    }
    throw new TalkbackUnavailableError(
      `${anchor.label} thread changed under this open — retry to converge`,
    );
  }
  deps.log.info(`${anchor.label} thread opened: ${conversationId}`);
  return { conversationId, created: true };
}

export function createBriefTalkback(deps: BriefTalkbackDeps): BriefTalkbackPort {
  return {
    async openThread(callerId: string, briefId: string): Promise<OpenThreadResult> {
      const brief = getBrief(deps.db, briefId);
      if (!brief) throw new BriefNotFoundError(`no brief ${briefId}`);
      return openAnchoredThread(deps, {
        label: `brief ${briefId}`,
        threadConversationId: brief.threadConversationId,
        create: (service) =>
          service.createAnchoredThread(callerId, {
            title: brief.title,
            origin: {
              kind: "brief",
              briefId: brief.id,
              runId: brief.createdByRun,
              brief: { title: brief.title, description: brief.description, body: brief.body },
            },
            initialHistory: seedBriefHistory(deps, brief),
          }),
        stamp: (conversationId) =>
          deps.writeGate.setBriefThreadConversation(brief.id, conversationId, deps.clock()),
        restamp: (deadId, conversationId) =>
          deps.writeGate.restampBriefThreadConversation(
            brief.id,
            deadId,
            conversationId,
            deps.clock(),
          ),
        currentThreadId: () => getBrief(deps.db, briefId)?.threadConversationId,
      });
    },
  };
}

/**
 * A brief thread's seed: the creating run's folded transcript when it still
 * exists (newest attempt wins), else a compact context exchange built from
 * the brief row.
 */
function seedBriefHistory(deps: BriefTalkbackDeps, brief: BriefRow): ChatMessage[] {
  const folded = foldedRunHistory(deps, brief.createdByRun, `brief ${brief.id}`);
  if (folded) return folded;
  const contextLines = [
    `This thread is about a brief you created earlier (its creating run's transcript is no longer available). Current brief state:`,
    `Title: ${brief.title}`,
    `Description: ${brief.description}`,
    ...(brief.body ? [`Body: ${brief.body}`] : []),
    ...(brief.citations.length > 0 ? [`Cited documents: ${brief.citations.join(", ")}`] : []),
    ...(brief.relatedLoopIds.length > 0
      ? [`Related loops: ${brief.relatedLoopIds.join(", ")}`]
      : []),
    `Brief id: ${brief.id}`,
  ];
  return compactContextExchange(contextLines);
}

/** Fold `runId`'s newest transcript into history, or null when pruned/unreadable. */
function foldedRunHistory(
  deps: BriefTalkbackDeps,
  runId: string,
  label: string,
): ChatMessage[] | null {
  // list() is oldest-first; the run may have several attempts (a failed
  // attempt still writes a transcript), and the seed must be the attempt
  // that actually produced the brief — the newest one.
  const ref = deps.transcripts
    .list()
    .filter((r) => r.runId === runId)
    .at(-1);
  if (!ref) return null;
  try {
    return endingWithAssistant(transcriptToHistory(deps.transcripts.load(ref.fileName)));
  } catch (err) {
    deps.log.warn(
      `${label}: transcript ${ref.fileName} unreadable, falling back to compact context: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

function compactContextExchange(contextLines: string[]): ChatMessage[] {
  return [
    { role: "user", parts: [{ kind: "text", text: contextLines.join("\n") }] },
    {
      role: "assistant",
      parts: [
        {
          kind: "text",
          text: "Understood — I have the brief's current state and will re-ground in the corpus for anything beyond it.",
        },
      ],
    },
  ];
}

/**
 * Close a user-final seed with a short assistant message so the seed is
 * always assistant-final. A folded transcript can end on a user-role
 * tool_result (the run died right after a tool call, with no closing
 * prose); left as-is, the HTTP backend's dangling-user-turn normalizer
 * would append its "Model request failed" stub at the first index PAST
 * the hidden seed prefix — making a raw error bubble the brand-new
 * thread's only visible message. Closing inside the seed keeps the stub
 * from ever being minted, and the closer itself stays hidden because it
 * is counted in seedMessageCount.
 */
function endingWithAssistant(history: ChatMessage[]): ChatMessage[] {
  if (history.length === 0 || history.at(-1)?.role === "assistant") return history;
  return [
    ...history,
    {
      role: "assistant",
      parts: [
        {
          kind: "text",
          text: "I have the full context of the run that produced this and can pick it up from here.",
        },
      ],
    },
  ];
}
