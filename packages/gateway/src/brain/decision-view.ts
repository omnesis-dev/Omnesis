// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The per-run decision view — the operator's "what did the agent decide
 * and why" projection over a stored run transcript (the tuning surface
 * for the wake-up heuristics and the agent prompt).
 *
 * A transcript holds the verbatim agent event stream; this module folds
 * it down to the parts an operator tunes on: which datum the run was
 * about (from the persisted payload), which loop/brief mutations the
 * agent made (tool calls whose names are in the Cognition Steward's mutating
 * set), how much non-mutating research it did, and the agent's own
 * closing text (the "why"). Pure functions — no I/O; callers load the
 * transcripts (see `transcripts.ts`).
 */

import { COGNITION_MUTATING_TOOL_NAMES } from "./steward/tools.js";
import {
  parseCognitionDailyRunPayload,
  parseCognitionDataRunPayload,
  parseCognitionDecayCheckRunPayload,
  parseCognitionFeedbackRunPayload,
  parseCognitionMayDayRunPayload,
  parseCognitionDigestRunPayload,
  parseCognitionSynthesisRunPayload,
  parseCognitionSweepRunPayload,
  parseCognitionBootstrapRunPayload,
  parseCognitionTimeBasedRunPayload,
  parseCognitionVerificationRunPayload,
  parseCognitionMergeAdjudicationRunPayload,
  parseCognitionNotesCompactionRunPayload,
  parseCognitionSubscriptionCompileRunPayload,
} from "./run-payloads.js";
import type { CognitionRunTranscript } from "./transcripts.js";
import type { CognitionRunKind, CognitionRunUsage } from "./storage/types.js";

/** One mutating tool call the run made — a decision, in operator terms. */
export interface CognitionDecisionAction {
  tool: string;
  /** One human-readable line derived from the tool's arguments. */
  detail: string;
  /** False when the tool result came back as an error. */
  ok: boolean;
}

/** The decision view of one run attempt. */
export interface CognitionRunDecision {
  runId: string;
  attempt: number;
  kind: CognitionRunKind;
  finishedAt: number;
  outcome: "completed" | "failed";
  errorMessage: string | null;
  failureCode: string | null;
  /**
   * What the run was about, as one line — e.g. `doc abc123 (created)`,
   * `source health-samples 2026-06-30 → 2026-07-01`, `brief brf_1`.
   * Null when the transcript predates payload persistence.
   */
  subject: string | null;
  /** The triggering document id for `data` runs (the per-datum filter key). */
  docId: string | null;
  /** Mutating tool calls, in order. Empty = the agent decided to do nothing. */
  actions: CognitionDecisionAction[];
  /** Count of non-mutating tool calls (search, open, trail, …). */
  researchToolCalls: number;
  /** The agent's closing text — its own account of why. */
  finalText: string;
  usage: CognitionRunUsage | null;
}

/** String field of an opaque args object, or null. */
function argString(args: unknown, key: string): string | null {
  if (args === null || typeof args !== "object") return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * One line for a mutating tool call, from the fields the tool schemas
 * carry. Falls back to the bare tool name — never throws on unexpected
 * args (the model wrote them).
 */
function describeAction(tool: string, args: unknown): string {
  const title = argString(args, "title");
  const id = argString(args, "id");
  const label = title ? `"${truncate(title, 60)}"` : (id ?? "");
  switch (tool) {
    case "open_loop_create":
      return `create loop ${label}`.trim();
    case "open_loop_update": {
      const state = argString(args, "state");
      return `update loop ${id ?? ""}${state ? ` → ${state}` : ""}`.trim();
    }
    case "open_loop_ledger_append": {
      const note = argString(args, "note");
      return `ledger ${id ?? ""}${note ? `: ${truncate(note, 60)}` : ""}`.trim();
    }
    case "open_loop_delete":
      return `delete loop ${id ?? ""}`.trim();
    case "brief_create":
      return `create brief ${label}`.trim();
    case "brief_update":
      return `update brief ${id ?? ""}`.trim();
    case "brief_delete":
      return `withdraw brief ${id ?? ""}`.trim();
    case "notes_append":
      return "append agent notes";
    case "notes_rewrite":
      return "rewrite agent notes";
    case "notes_edit":
      return "edit agent notes";
    case "schedule_agent_run": {
      const when = argString(args, "when");
      return `schedule run${when ? ` at ${when}` : ""}`;
    }
    case "annotation_supersede":
    case "person_annotation_supersede": {
      const supersededBy = argString(args, "supersededBy");
      return `supersede ${id ?? ""}${supersededBy ? ` → ${supersededBy}` : ""}`.trim();
    }
    default:
      return tool;
  }
}

/** The one-line subject for a persisted run payload, per run kind. */
export function describeRunSubject(kind: CognitionRunKind, payload: unknown): string | null {
  if (payload === undefined || payload === null) return null;
  switch (kind) {
    case "data": {
      const data = parseCognitionDataRunPayload(payload);
      return data ? `doc ${data.docId} (${data.event})` : null;
    }
    case "daily": {
      const daily = parseCognitionDailyRunPayload(payload);
      if (daily) return `source ${daily.sourceId} ${daily.dateFrom} → ${daily.dateTo}`;
      const mayDay = parseCognitionMayDayRunPayload(payload);
      if (mayDay) return `may-day ${mayDay.date}`;
      const digest = parseCognitionDigestRunPayload(payload);
      return digest ? `morning digest ${digest.date}` : null;
    }
    case "feedback": {
      const feedback = parseCognitionFeedbackRunPayload(payload);
      return feedback ? `brief ${feedback.briefId}` : null;
    }
    case "time_based": {
      const decay = parseCognitionDecayCheckRunPayload(payload);
      if (decay) return `decay-check loop ${decay.decayCheckLoopId}`;
      const timeBased = parseCognitionTimeBasedRunPayload(payload);
      return timeBased ? `prompt: ${truncate(timeBased.prompt, 60)}` : null;
    }
    case "synthesis": {
      const s = parseCognitionSynthesisRunPayload(payload);
      if (!s) return null;
      if (s.focus === "collision") {
        return `collision judge: ${
          [...(s.loopIds ?? []), ...(s.temporalAnnotationIds ?? [])].join(", ") || "(no members)"
        }`;
      }
      if (s.focus === "annotation-contradiction") {
        return `annotation contradiction (${s.store ?? "?"}): ${
          (s.annotationIds ?? []).join(", ") || "(no members)"
        }`;
      }
      return `noticing ${s.date ?? ""}`.trim();
    }
    case "sweep": {
      const s = parseCognitionSweepRunPayload(payload);
      return s ? `sweep "${s.sweepId}" for ${s.date}` : null;
    }
    case "bootstrap": {
      const b = parseCognitionBootstrapRunPayload(payload);
      return b ? `bootstrap doc ${b.docId}` : null;
    }
    case "verification": {
      const v = parseCognitionVerificationRunPayload(payload);
      return v ? `re-verify (${v.store}): ${v.annotationIds.join(", ")}` : null;
    }
    case "merge_adjudication": {
      const m = parseCognitionMergeAdjudicationRunPayload(payload);
      return m ? `merge candidate ${m.candidateId}` : null;
    }
    case "notes_compaction": {
      const n = parseCognitionNotesCompactionRunPayload(payload);
      return n ? `notes compaction: ${truncate(n.reason, 60)}` : null;
    }
    case "subscription_compile": {
      const c = parseCognitionSubscriptionCompileRunPayload(payload);
      return c ? `watch compile (${c.authoredBy}): ${truncate(c.request, 60)}` : null;
    }
    default:
      return null;
  }
}

/** The docId of a persisted `data` payload; null for every other shape. */
function dataRunDocId(kind: CognitionRunKind, payload: unknown): string | null {
  if (kind !== "data") return null;
  return parseCognitionDataRunPayload(payload)?.docId ?? null;
}

/** Fold one transcript down to its decision view. */
export function summarizeCognitionTranscript(t: CognitionRunTranscript): CognitionRunDecision {
  const actions: CognitionDecisionAction[] = [];
  // toolCallId → index into `actions`, so a later result event can set `ok`.
  const actionByCallId = new Map<string, number>();
  let researchToolCalls = 0;

  for (const event of t.events) {
    if (event.type === "agent.tool.start") {
      const payload = event.payload as { toolCallId?: string; tool?: string; args?: unknown };
      const tool = typeof payload?.tool === "string" ? payload.tool : "";
      if (!tool) continue;
      if (COGNITION_MUTATING_TOOL_NAMES.has(tool)) {
        const index =
          actions.push({ tool, detail: describeAction(tool, payload.args), ok: true }) - 1;
        if (typeof payload.toolCallId === "string") actionByCallId.set(payload.toolCallId, index);
      } else {
        researchToolCalls += 1;
      }
    } else if (event.type === "agent.tool.result") {
      const payload = event.payload as { toolCallId?: string; result?: { kind?: string } };
      const index =
        typeof payload?.toolCallId === "string"
          ? actionByCallId.get(payload.toolCallId)
          : undefined;
      if (index !== undefined && payload?.result?.kind === "error") {
        actions[index]!.ok = false;
      }
    }
  }

  return {
    runId: t.runId,
    attempt: t.attempt,
    kind: t.kind,
    finishedAt: t.finishedAt,
    outcome: t.outcome,
    errorMessage: t.errorMessage ?? null,
    failureCode: t.failureCode ?? null,
    subject: describeRunSubject(t.kind, t.payload),
    docId: dataRunDocId(t.kind, t.payload),
    actions,
    researchToolCalls,
    finalText: t.finalText,
    usage: t.usage,
  };
}
