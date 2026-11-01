// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Note-only durable handoff; normal chat presentation tools stay in chat. */
import { z } from "zod";
import { noteHandoffId, type NoteHandoff } from "./handoffs.js";
import type { ToolHandle } from "@omnesis/agent";
import type { NoteEntry } from "../../sources/omnesis-notes/storage.js";
import type { NoteAgentRow, NoteAgentReceipt } from "./storage.js";

const handoffSchema = z
  .object({
    question: z.string().trim().min(1).max(1000),
    context: z.string().trim().max(2000).optional(),
  })
  .strict();
function boundedHandoffContext(input: {
  actionOutcomes: string[];
  readFindings: string[];
  truncated: boolean;
  [key: string]: unknown;
}): string {
  const data = {
    ...input,
    actionOutcomes: [...input.actionOutcomes],
    readFindings: [...input.readFindings],
  };
  while (
    Buffer.byteLength(JSON.stringify(data), "utf8") > 45_000 &&
    (data.readFindings.length || data.actionOutcomes.length)
  ) {
    if (data.readFindings.length) data.readFindings.pop();
    else data.actionOutcomes.pop();
    data.truncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > 45_000) {
    return JSON.stringify({
      truncated: true,
      warning:
        "Prior context exceeded its budget. Read back current state before acting; do not repeat earlier actions.",
      confirmedTaskChanges: input.confirmedTaskChanges,
      taskAtCapture:
        input.taskAtCapture && typeof input.taskAtCapture === "object"
          ? {
              id: (input.taskAtCapture as { id?: unknown }).id,
              title: (input.taskAtCapture as { title?: unknown }).title,
            }
          : undefined,
      priorUncertain: input.priorUncertain,
      pendingMutations: input.pendingMutations,
      uncertainMutation: input.uncertainMutation,
    });
  }
  return JSON.stringify(data);
}

export function buildContinueInChatTool(deps: {
  entry: NoteEntry;
  row: NoteAgentRow;
  context: () => {
    actionOutcomes: string[];
    readFindings: string[];
    truncated: boolean;
    [key: string]: unknown;
  };
  changes: () => NoteAgentReceipt["changes"];
  freeze: () => void;
  finished: () => boolean;
  reserve: (input: NoteHandoff) => Promise<boolean>;
}): ToolHandle {
  return {
    name: "continue_in_chat",
    schema: handoffSchema,
    mutates: true,
    description:
      "Move a necessary question about this blocked note to a normal chat. Provide the plain question and optional brief context for the remaining work. After this succeeds, stop making changes and end this Note turn. Do not use for optional follow-ups or completed requests.",
    invoke: async (raw, ctx) => {
      const parsed = handoffSchema.safeParse(raw);
      if (!parsed.success)
        return {
          kind: "error",
          code: "invalid_args",
          message: "Provide a plain question and optional brief context.",
        };
      if (ctx.abortSignal?.aborted || deps.finished())
        return { kind: "error", code: "note_finished", message: "This turn has finished." };
      // Freeze before awaiting the writer: already admitted parallel calls must
      // still pass the runner's invoke-time fence, and outstanding work is quoted.
      deps.freeze();
      const { entry, row } = deps;
      const snapshot = deps.context();
      const input: NoteHandoff = {
        conversationId: noteHandoffId(entry.id, row.revision),
        noteId: entry.id,
        revision: row.revision,
        attempt: row.attempts,
        text: entry.text,
        capturedAt: entry.capturedAt,
        day: entry.day,
        instructionAt:
          row.revision === 0 ? entry.capturedAt : new Date(row.createdAt).toISOString(),
        ...(entry.capturedTimeZoneId ? { timeZone: entry.capturedTimeZoneId } : {}),
        ...(entry.taskId ? { taskId: entry.taskId } : {}),
        question: parsed.data.question,
        context: boundedHandoffContext({ ...snapshot, remainingWork: parsed.data.context }),
        requiresReview:
          snapshot.priorUncertain === true ||
          snapshot.uncertainMutation === true ||
          (typeof snapshot.pendingMutations === "number" && snapshot.pendingMutations > 0) ||
          (Array.isArray(snapshot.pendingToolCalls) && snapshot.pendingToolCalls.length > 0),
        changes: [...deps.changes()],
      };
      if (!(await deps.reserve(input)))
        return {
          kind: "error",
          code: "note_superseded",
          message: "The note changed; no handoff was reserved.",
        };
      return {
        kind: "structured",
        resultType: "note.clarification_queued",
        data: { conversationId: input.conversationId },
      };
    },
  };
}
