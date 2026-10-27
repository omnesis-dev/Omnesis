// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createLogger } from "@omnesis/core";
import { conversationTurnReceiptSchema, type ConversationTurnReceipt } from "./voice-session.js";
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
    spokenContext: z.string().max(8192).optional(),
    clarificationId: z.string().min(1).max(128).optional(),
  })
  // Unknown keys are dropped rather than refused, so a newer app that adds an
  // optional field can still submit to this gateway.
  .strip();
export type SubmissionInput = z.infer<typeof submissionInputSchema>;
export const sendQueuedInputSchema = z
  .object({
    submissionIds: z.array(submissionInputSchema.shape.clientMessageId).min(1).max(32),
  })
  .strip();
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
  result: conversationTurnReceiptSchema.optional(),
});
export type ConversationSubmission = z.infer<typeof submissionSchema>;
export const conversationControlsSchema = z.object({
  submissions: z.array(submissionSchema),
  pendingClarification: clarificationSchema.optional(),
});
export type ConversationControlState = z.infer<typeof conversationControlsSchema>;
export interface ConversationControlsSnapshot {
  busy: boolean;
  capabilities: { coalescedQueue: true; queueSendNow: true };
  pendingClarification?: PendingClarification;
  queuedMessages: ConversationSubmission[];
}
export class ConversationControlError extends Error {}

interface ControlHost {
  state(id: string): ConversationControlState;
  persist(id: string): Promise<void>;
  busy(id: string): boolean;
  available(id: string): boolean;
  start(
    id: string,
    submission: ConversationSubmission,
    submissionIds: string[],
  ): Promise<ConversationTurnReceipt | void>;
  cancel(id: string): void;
}
const log = createLogger("gateway:agent").child("controls");

/** Serializes acceptance and start barriers; the conversation owns durable state. */
export class ConversationControls {
  private readonly revisions = new WeakMap<ConversationControlState, number>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly running = new Map<string, Promise<ConversationTurnReceipt | undefined>>();
  private readonly resultWaiters = new Map<
    string,
    Map<
      string,
      {
        promise: Promise<ConversationTurnReceipt>;
        resolve: (value: ConversationTurnReceipt) => void;
        reject: (error: Error) => void;
      }
    >
  >();
  constructor(private readonly host: ControlHost) {}

  /** Observe durable receipt completion; execution remains entirely in the ordinary queue. */
  async waitForResult(id: string, submissionId: string): Promise<ConversationTurnReceipt> {
    const observed = await this.lock(id, async () => {
      const item = this.host
        .state(id)
        .submissions.find((candidate) => candidate.id === submissionId);
      if (!item) throw new ConversationControlError("The submitted message is unavailable.");
      if (item.result && !this.running.has(id)) return { value: structuredClone(item.result) };
      if (!this.running.has(id) && (item.status === "failed" || item.status === "completed"))
        throw new ConversationControlError(
          "The submitted message has no recoverable result. Review the conversation before trying again.",
        );
      let waiters = this.resultWaiters.get(id);
      if (!waiters) {
        waiters = new Map();
        this.resultWaiters.set(id, waiters);
      }
      let waiter = waiters.get(submissionId);
      if (!waiter) {
        let resolve!: (value: ConversationTurnReceipt) => void;
        let reject!: (error: Error) => void;
        const promise = new Promise<ConversationTurnReceipt>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        waiter = { promise, resolve, reject };
        waiters.set(submissionId, waiter);
      }
      return { pending: waiter.promise };
    });
    if (observed.value) return observed.value;
    if (!observed.pending)
      throw new ConversationControlError("The submitted result is unavailable.");
    return observed.pending;
  }

  /** Stop only this voice lease's accepted work, including corrections not started yet. */
  async cancelSubmitted(id: string, submitted: ReadonlySet<string>): Promise<void> {
    const owned = new Set(submitted);
    await this.lock(id, async () => {
      const state = this.host.state(id);
      const queued = state.submissions.filter(
        (item) => item.status === "queued" && owned.has(item.id),
      );
      const running = state.submissions.some(
        (item) => item.status === "running" && owned.has(item.id),
      );
      for (const item of queued) {
        item.status = "failed";
        item.error = "This message was stopped before it started.";
      }
      if (running) this.host.cancel(id);
      // Keep canceled items ineligible in memory even when persistence fails; never start them.
      if (queued.length) {
        try {
          await this.host.persist(id);
        } catch (error) {
          this.publishResults(id, queued);
          throw error;
        }
      }
      this.publishResults(id, queued);
    });
  }

  rejectWaitingResults(): void {
    for (const waiters of this.resultWaiters.values())
      for (const waiter of waiters.values())
        waiter.reject(new ConversationControlError("The agent service is shutting down."));
    this.resultWaiters.clear();
  }

  active(id: string): boolean {
    return this.tails.has(id) || this.running.has(id);
  }

  /** Serialize a synchronous turn start with durable submission acceptance. Never hold across model work. */
  async startTurn(id: string, start: () => void): Promise<void> {
    await this.lock(id, async () => {
      start();
    });
  }

  /** Admit synchronously with queue acceptance, then await tool work outside the lock. */
  async admitOperation<T>(id: string, start: () => Promise<T>): Promise<T> {
    const admitted = await this.lock(id, async () => ({ execution: start() }));
    return admitted.execution;
  }

  admissionRevision(id: string): number {
    return this.revisions.get(this.host.state(id)) ?? 0;
  }

  snapshot(id: string): ConversationControlsSnapshot {
    const state = this.host.state(id);
    return structuredClone({
      busy: this.host.busy(id) || this.running.has(id),
      capabilities: { coalescedQueue: true, queueSendNow: true } as const,
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
    options: {
      admit?: () => boolean;
      answerPendingClarification?: boolean;
      accepted?: (submissionId: string) => void;
      appendToPending?: ReadonlySet<string>;
    } = {},
  ): Promise<ConversationControlsSnapshot & { submission: ConversationSubmission }> {
    const submission = await this.lock(id, async () => {
      if (options.admit && !options.admit())
        throw new ConversationControlError(
          "The voice session ended before the message was accepted.",
        );
      const state = this.host.state(id);
      const prior = state.submissions.find((s) => s.id === input.clientMessageId);
      if (prior) {
        if (
          prior.text !== input.text ||
          prior.mode !== input.mode ||
          !!prior.deepResearch !== !!input.deepResearch ||
          prior.spokenContext !== input.spokenContext ||
          (!options.answerPendingClarification && prior.clarificationId !== input.clarificationId)
        ) {
          throw new ConversationControlError(
            "This message ID was already used for another message.",
          );
        }
        options.accepted?.(prior.id);
        return structuredClone(prior);
      }
      if (input.clarificationId && state.pendingClarification?.id !== input.clarificationId) {
        throw new ConversationControlError(
          "This question has already been answered or replaced. Refresh the conversation.",
        );
      }
      const pending = options.appendToPending
        ? [...state.submissions]
            .reverse()
            .find((item) => item.status === "queued" && options.appendToPending!.has(item.id))
        : undefined;
      if (pending) {
        const queuedLength = state.submissions
          .filter((item) => item.status === "queued")
          .map((item) => item.text)
          .join("\n\n").length;
        if (queuedLength + input.text.length > 10_000)
          throw new ConversationControlError(
            "The queued message is too long. Wait for it to send before adding more.",
          );
        const previous = {
          text: pending.text,
          spokenContext: pending.spokenContext,
          clarificationId: pending.clarificationId,
        };
        const question = state.pendingClarification;
        if (options.answerPendingClarification && question) {
          pending.clarificationId = question.id;
          delete state.pendingClarification;
        }
        pending.text += input.text;
        if (input.spokenContext !== undefined) pending.spokenContext = input.spokenContext;
        options.accepted?.(pending.id);
        try {
          await this.host.persist(id);
        } catch (error) {
          pending.text = previous.text;
          pending.spokenContext = previous.spokenContext;
          pending.clarificationId = previous.clarificationId;
          if (question) state.pendingClarification = question;
          throw error;
        }
        this.revisions.set(state, (this.revisions.get(state) ?? 0) + 1);
        return structuredClone(pending);
      }
      // Bound unstarted work without discarding idempotency receipts for completed turns.
      if (state.submissions.filter((s) => s.status === "queued").length >= 32) {
        throw new ConversationControlError(
          "The conversation queue is full. Wait for a message to finish.",
        );
      }
      const queued = state.submissions.filter((s) => s.status === "queued");
      if ([...queued.map((s) => s.text), input.text].join("\n\n").length > 10_000) {
        throw new ConversationControlError(
          "The queued message is too long. Wait for it to send before adding more.",
        );
      }
      const next: ConversationSubmission = {
        ...input,
        ...(options.answerPendingClarification && state.pendingClarification
          ? { clarificationId: state.pendingClarification.id }
          : {}),
        ...(callerId ? { callerId } : {}),
        id: input.clientMessageId,
        status: "queued",
      };
      const previousQuestion = state.pendingClarification;
      if (next.clarificationId || input.mode === "interrupt") delete state.pendingClarification;
      if (input.mode === "interrupt" || input.clarificationId) state.submissions.unshift(next);
      else state.submissions.push(next);
      options.accepted?.(next.id);
      try {
        await this.host.persist(id);
      } catch (error) {
        state.submissions.splice(state.submissions.indexOf(next), 1);
        if (previousQuestion) state.pendingClarification = previousQuestion;
        throw error;
      }
      this.revisions.set(state, (this.revisions.get(state) ?? 0) + 1);
      // Acceptance is durable before cancellation; a lost HTTP response is safely retryable.
      if (input.mode === "interrupt") this.host.cancel(id);
      return structuredClone(next);
    });
    this.kick(id);
    return { submission, ...this.snapshot(id) };
  }

  async sendNow(id: string, submissionIds: string[]): Promise<ConversationControlsSnapshot> {
    await this.lock(id, async () => {
      const state = this.host.state(id);
      const requested = submissionIds.map((key) => state.submissions.find((s) => s.id === key));
      if (requested.some((s) => !s || s.status === "failed")) {
        throw new ConversationControlError("The queued message changed. Refresh the conversation.");
      }
      // A retry after this batch started must not interrupt a subsequent turn.
      if (!requested.some((s) => s?.status === "queued")) return;
      const previous = state.pendingClarification;
      delete state.pendingClarification;
      try {
        await this.host.persist(id);
      } catch (error) {
        if (previous) state.pendingClarification = previous;
        throw error;
      }
      this.host.cancel(id);
    });
    this.kick(id);
    return this.snapshot(id);
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
      // Accumulate pending text into one turn while retaining every retry receipt.
      const batch = [next];
      let length = next.text.length;
      for (const item of state.submissions.slice(state.submissions.indexOf(next) + 1)) {
        if (item.status !== "queued") continue;
        // Older gateways could persist a queue larger than a single prompt.
        if (length + 2 + item.text.length > 10_000) break;
        batch.push(item);
        length += 2 + item.text.length;
      }
      for (const item of batch) item.status = "running";
      const question = state.pendingClarification;
      delete state.pendingClarification;
      try {
        await this.host.persist(id);
      } catch (error) {
        for (const item of batch) item.status = "queued";
        if (question) state.pendingClarification = question;
        throw error;
      }
      // Persist running before model work: a crash may leave an uncertain turn,
      // which is surfaced as failed on resume and never automatically replayed.
      const operation = this.execute(id, batch);
      this.running.set(id, operation);
      void operation.then(
        (result) => {
          this.running.delete(id);
          this.publishResults(id, batch, result);
          this.kick(id);
        },
        () => {
          this.running.delete(id);
          this.publishResults(id, batch);
          this.kick(id);
        },
      );
    }).catch(() => log.warn("could not advance a conversation queue"));
  }

  private async execute(
    id: string,
    batch: ConversationSubmission[],
  ): Promise<ConversationTurnReceipt | undefined> {
    let failed = false;
    let result: ConversationTurnReceipt | undefined;
    try {
      result =
        (await this.host.start(
          id,
          {
            ...batch[0]!,
            text: batch.map((item) => item.text).join("\n\n"),
            deepResearch: batch.some((item) => item.deepResearch),
            spokenContext: [...batch].reverse().find((item) => item.spokenContext !== undefined)
              ?.spokenContext,
          },
          batch.map((item) => item.id),
        )) ?? undefined;
      if (result && result.stopReason !== "end_turn") failed = true;
    } catch {
      failed = true;
    }
    return this.lock(id, async () => {
      for (const item of batch) {
        item.status = failed ? "failed" : "completed";
        if (result) item.result = structuredClone(result);
        if (failed)
          item.error =
            "This message could not finish. Review the conversation before sending it again.";
      }
      let persisted = true;
      try {
        await this.host.persist(id);
      } catch {
        persisted = false;
        for (const item of batch) {
          item.status = "failed";
          delete item.result;
          item.error =
            "The message outcome could not be saved. Review the conversation before trying again.";
        }
        log.warn("could not persist a conversation submission outcome");
      }
      return persisted ? result : undefined;
    });
  }

  /** Publish only after the canonical queue retires its active batch. */
  private publishResults(
    id: string,
    batch: ConversationSubmission[],
    result?: ConversationTurnReceipt,
  ): void {
    const waiters = this.resultWaiters.get(id);
    for (const item of batch) {
      const waiter = waiters?.get(item.id);
      if (!waiter) continue;
      if (result) waiter.resolve(structuredClone(result));
      else
        waiter.reject(
          new ConversationControlError(
            "The submitted message could not finish durably. Review the conversation before trying again.",
          ),
        );
      waiters?.delete(item.id);
    }
    if (waiters?.size === 0) this.resultWaiters.delete(id);
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
