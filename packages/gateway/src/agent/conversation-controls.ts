// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createLogger } from "@omnesis/core";
import type { ToolHandle } from "@omnesis/agent";

export const submissionInputSchema = z
  .object({
    clientMessageId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w-]+$/),
    text: z.string().trim().min(1).max(10_000),
    mode: z.enum(["queue", "interrupt"]),
    deepResearch: z.boolean().optional(),
    clarificationId: z.string().min(1).max(128).optional(),
  })
  .strict();
export type SubmissionInput = z.infer<typeof submissionInputSchema>;
const questionSchema = z
  .object({
    question: z.string().trim().min(1).max(1000),
    choices: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(200),
            description: z.string().max(500).optional(),
          })
          .strict(),
      )
      .min(2)
      .max(6),
  })
  .strict();
const clarificationSchema = questionSchema.strip().extend({
  id: z.string().min(1).max(128),
  choices: z.array(questionSchema.shape.choices.element.strip()).min(2).max(6),
});
export type PendingClarification = z.infer<typeof clarificationSchema>;
const submissionSchema = submissionInputSchema.strip().extend({
  id: z.string(),
  status: z.preprocess(
    (value) =>
      typeof value === "string" && !["queued", "running", "completed", "failed"].includes(value)
        ? "failed"
        : value,
    z.enum(["queued", "running", "completed", "failed"]),
  ),
  callerId: z.string().optional(),
  error: z.string().optional(),
});
export type ConversationSubmission = z.infer<typeof submissionSchema>;
export const conversationControlsSchema = z.object({
  submissions: z.array(submissionSchema),
  pendingClarification: clarificationSchema.optional(),
});
export type ConversationControlState = z.infer<typeof conversationControlsSchema>;
export interface ConversationControlsSnapshot {
  busy: boolean;
  pendingClarification?: PendingClarification;
  queuedMessages: ConversationSubmission[];
}
export class ConversationControlError extends Error {}

interface ControlHost {
  state(id: string): ConversationControlState;
  persist(id: string): Promise<void>;
  busy(id: string): boolean;
  available(id: string): boolean;
  start(id: string, submission: ConversationSubmission): Promise<void>;
  cancel(id: string): void;
}
const log = createLogger("gateway:agent").child("controls");

/** Serializes acceptance and start barriers; the conversation owns durable state. */
export class ConversationControls {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly running = new Map<string, Promise<void>>();
  constructor(private readonly host: ControlHost) {}

  active(id: string): boolean {
    return this.tails.has(id) || this.running.has(id);
  }

  snapshot(id: string): ConversationControlsSnapshot {
    const state = this.host.state(id);
    return structuredClone({
      busy: this.host.busy(id) || this.running.has(id),
      ...(state.pendingClarification ? { pendingClarification: state.pendingClarification } : {}),
      queuedMessages: state.submissions.filter(
        (s) => s.status === "queued" || s.status === "failed",
      ),
    });
  }

  async submit(
    id: string,
    input: SubmissionInput,
    callerId?: string,
  ): Promise<ConversationControlsSnapshot & { submission: ConversationSubmission }> {
    const submission = await this.lock(id, async () => {
      const state = this.host.state(id);
      const prior = state.submissions.find((s) => s.id === input.clientMessageId);
      if (prior) {
        if (
          prior.text !== input.text ||
          prior.mode !== input.mode ||
          !!prior.deepResearch !== !!input.deepResearch ||
          prior.clarificationId !== input.clarificationId
        ) {
          throw new ConversationControlError(
            "This message ID was already used for another message.",
          );
        }
        return structuredClone(prior);
      }
      if (input.clarificationId && state.pendingClarification?.id !== input.clarificationId) {
        throw new ConversationControlError(
          "This question has already been answered or replaced. Refresh the conversation.",
        );
      }
      // Bound unstarted work without discarding idempotency receipts for completed turns.
      if (state.submissions.filter((s) => s.status === "queued").length >= 32) {
        throw new ConversationControlError(
          "The conversation queue is full. Wait for a message to finish.",
        );
      }
      const next: ConversationSubmission = {
        ...input,
        ...(callerId ? { callerId } : {}),
        id: input.clientMessageId,
        status: "queued",
      };
      const previousQuestion = state.pendingClarification;
      if (input.clarificationId || input.mode === "interrupt") delete state.pendingClarification;
      if (input.mode === "interrupt" || input.clarificationId) state.submissions.unshift(next);
      else state.submissions.push(next);
      try {
        await this.host.persist(id);
      } catch (error) {
        state.submissions.splice(state.submissions.indexOf(next), 1);
        if (previousQuestion) state.pendingClarification = previousQuestion;
        throw error;
      }
      // Acceptance is durable before cancellation; a lost HTTP response is safely retryable.
      if (input.mode === "interrupt") this.host.cancel(id);
      return structuredClone(next);
    });
    this.kick(id);
    return { submission, ...this.snapshot(id) };
  }

  kick(id: string): void {
    if (!this.host.available(id)) return;
    const current = this.host.state(id);
    if (current.pendingClarification || !current.submissions.some((s) => s.status === "queued"))
      return;
    void this.lock(id, async () => {
      if (!this.host.available(id) || this.host.busy(id) || this.running.has(id)) return;
      const state = this.host.state(id);
      if (state.pendingClarification) return;
      const next = state.submissions.find((s) => s.status === "queued");
      if (!next) return;
      next.status = "running";
      const question = state.pendingClarification;
      delete state.pendingClarification;
      try {
        await this.host.persist(id);
      } catch (error) {
        next.status = "queued";
        if (question) state.pendingClarification = question;
        throw error;
      }
      // Persist running before model work: a crash may leave an uncertain turn,
      // which is surfaced as failed on resume and never automatically replayed.
      const operation = this.execute(id, next);
      this.running.set(id, operation);
      void operation
        .finally(() => {
          this.running.delete(id);
          this.kick(id);
        })
        .catch(() => {});
    }).catch(() => log.warn("could not advance a conversation queue"));
  }

  private async execute(id: string, next: ConversationSubmission): Promise<void> {
    let failed = false;
    try {
      await this.host.start(id, next);
    } catch {
      failed = true;
    }
    await this.lock(id, async () => {
      next.status = failed ? "failed" : "completed";
      if (failed)
        next.error =
          "This message could not finish. Review the conversation before sending it again.";
      try {
        await this.host.persist(id);
      } catch {
        log.warn("could not persist a conversation submission outcome");
      }
    });
  }

  observeClarification(id: string, data: unknown): void {
    const parsed = clarificationSchema.safeParse(data);
    if (!parsed.success || !this.host.available(id)) return;
    void this.lock(id, async () => {
      if (!this.host.available(id)) return;
      const state = this.host.state(id);
      if (state.submissions.some((s) => s.clarificationId === parsed.data.id)) return;
      const previous = state.pendingClarification;
      state.pendingClarification = parsed.data;
      try {
        await this.host.persist(id);
      } catch (error) {
        if (previous) state.pendingClarification = previous;
        else delete state.pendingClarification;
        throw error;
      }
    }).catch(() => log.warn("could not persist a replay clarification"));
  }

  clarificationTool(id: string): ToolHandle {
    return {
      name: "ask_clarification",
      description:
        "Ask the user a necessary clarification with 2–6 concise choices. Free text is always allowed. The question is saved across devices. After calling this tool, repeat the question and choices in your ordinary reply for clients without choice controls, then end your turn and wait for the user's answer; never choose for them. Do not use for optional suggestions after a complete answer.",
      schema: questionSchema,
      mutates: true,
      invoke: async (args, ctx) => {
        const parsed = questionSchema.safeParse(args);
        if (!parsed.success)
          return {
            kind: "error",
            code: "invalid_args",
            message: "Provide a question and 2–6 choices.",
          };
        return this.lock(id, async () => {
          if (ctx.abortSignal?.aborted || !this.host.available(id)) {
            return { kind: "error" as const, code: "canceled", message: "The turn was stopped." };
          }
          const state = this.host.state(id);
          const previous = state.pendingClarification;
          const question = { id: randomUUID(), ...parsed.data };
          state.pendingClarification = question;
          try {
            await this.host.persist(id);
          } catch (error) {
            if (previous) state.pendingClarification = previous;
            else delete state.pendingClarification;
            throw error;
          }
          return {
            kind: "structured" as const,
            resultType: "conversation.clarification",
            data: question,
          };
        });
      },
    };
  }

  get hasWork(): boolean {
    return this.tails.size > 0 || this.running.size > 0;
  }

  async settle(): Promise<void> {
    await Promise.allSettled([...this.tails.values(), ...this.running.values()]);
  }

  private async lock<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    const current = previous.then(work, work);
    this.tails.set(id, current);
    try {
      return await current;
    } finally {
      if (this.tails.get(id) === current) this.tails.delete(id);
    }
  }
}

export function restoreConversationControls(value: unknown): ConversationControlState {
  if (value === undefined) return { submissions: [] };
  const parsed = conversationControlsSchema.safeParse(value);
  if (!parsed.success)
    throw new ConversationControlError("Saved conversation controls could not be read safely.");
  for (const submission of parsed.data.submissions) {
    if (submission.status !== "running") continue;
    submission.status = "failed";
    submission.error =
      "The gateway stopped during this message. Review the conversation before sending it again.";
  }
  return parsed.data;
}
