// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The mention worth gate: a background pass that asks the decision model
 * whether each email carrying a date mention is worth recording, so the
 * temporal query can leave out the mentions of marketing, newsletters and
 * notifications.
 *
 * - Active only while `enrichment.dates.worthGate` is on and the decision
 *   model is assigned and ready; otherwise it idles and the query shows every
 *   mention.
 * - It asks the email worth rubric (`email-worth-v1`) at its threshold, the
 *   question the Brain's worth gate asks too. Both read and record the
 *   email's shared answer (`worth/answers.ts`), so an email is sent to the
 *   decision model once whichever gate needs it first. An attachment rides on
 *   its email's answer.
 * - Only emails are judged; any other document, and a document or email
 *   carrying structured booking dates, is exempt and always shown.
 * - An unreachable model, a rejected key or a malformed reply leaves the
 *   document pending with a growing backoff, so one failing email never holds
 *   up the rest; a pending document's mentions are shown meanwhile.
 *
 * Each tick reads a batch on the io pool, asks the model from the main thread
 * (network only) and settles the batch in one background writer call.
 */

import { randomUUID } from "node:crypto";
import { assertNever, type DecisionCapability, type Logger } from "@omnesis/core";
import { runWithPriority } from "../../priority.js";
import {
  runBackfillTick,
  isIdleResult,
  type IdleResult,
} from "../../scheduler/tasks/backfill-helpers.js";
import { periodicJob } from "../../background-jobs/scheduler-job.js";
import { QueueTracker } from "../../background-jobs/trackers.js";
import { askScore } from "../../brain/decision-call.js";
import {
  EMAIL_WORTH_QUESTIONS,
  EMAIL_WORTH_QUESTION_ID,
  WORTH_GATE_RUBRIC_VERSION,
  passesWorthThreshold,
} from "../../worth/rubric.js";
import type { Scheduler } from "../../scheduler/scheduler.js";
import type { PeriodicTask, TaskOutcome } from "../../scheduler/types.js";
import type { IoGate } from "../../scheduler/io-ops.js";
import type { WriteGate } from "../../write-gate.js";
import type { BackgroundJobsRegistry } from "../../background-jobs/registry.js";
import type { ResolvedDateEnrichmentSettings } from "./config.js";
import type { WorthAnswer } from "../../worth/answers.js";
import type {
  MentionJudgementDeferral,
  MentionJudgementRecord,
  PendingMentionJudgement,
} from "./mention-judgements.js";

export const MENTION_WORTH_GATE_TASK_NAME = "enrichment.judgeDateMentions";

/** Documents read per tick. */
const BATCH = 32;
/** Decision-model calls in flight at once. */
const CONCURRENCY = 4;
/** Per-call timeout; a slower model counts as a failure for this attempt. */
const CALL_TIMEOUT_MS = 30_000;
/** Cadence while documents are waiting, and when the queue is empty or the gate is off. */
const ACTIVE_PERIOD_MS = 2_000;
const IDLE_PERIOD_MS = 300_000;
/** Documents judged in one stretch before its end is logged at info level. */
const CAUGHT_UP_LOG_MIN = 100;
/** Judgements requeued per writer call after a rubric change. */
const REQUEUE_BATCH = 500;
/** Backoff for a document that cannot be settled yet: doubling from a minute, capped at a day. */
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 86_400_000;

export interface MentionWorthGateDeps {
  ioGate: Pick<IoGate, "fetchPendingMentionJudgements">;
  writeGate: Pick<WriteGate, "applyMentionJudgements" | "requeueStaleMentionJudgements">;
  getSettings: () => ResolvedDateEnrichmentSettings;
  getDecision: () => DecisionCapability | null;
  recordSpend: (modelId: string, inputTokens: number) => Promise<void>;
  tracker: QueueTracker;
  clock?: () => number;
  /** Ids for the worth answers this gate records. */
  idGen?: () => string;
  log: Logger;
}

/** When a document that failed `attempts` times before this one may be tried again. */
export function nextAttemptAt(now: number, attempts: number): number {
  return now + Math.min(RETRY_BASE_MS * 2 ** attempts, RETRY_MAX_MS);
}

export function mentionWorthGateTask(
  deps: MentionWorthGateDeps,
): PeriodicTask<unknown, IdleResult> {
  const { ioGate, writeGate, getSettings, getDecision, tracker, log } = deps;
  const clock = deps.clock ?? Date.now;
  const judgeDeps = { ...deps, idGen: deps.idGen ?? (() => randomUUID()) };
  let requeued = false;
  let judged = 0;
  return {
    name: MENTION_WORTH_GATE_TASK_NAME,
    runner: "main",
    priority: "background",
    periodMs: ACTIVE_PERIOD_MS,
    idlePeriodMs: IDLE_PERIOD_MS,
    startDelayMs: 10_000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      return runBackfillTick(MENTION_WORTH_GATE_TASK_NAME, log, async () =>
        runWithPriority("background", async () => {
          if (!getSettings().worthGate) return { idle: true };
          const decision = getDecision();
          if (!decision) return { idle: true };
          if (!requeued) {
            // One bounded batch per tick until judgements from an earlier
            // rubric are all back in the queue.
            const n = await writeGate.requeueStaleMentionJudgements(
              WORTH_GATE_RUBRIC_VERSION,
              REQUEUE_BATCH,
            );
            if (n > 0) log.info(`mention worth gate: ${n} judgements requeued for a new rubric`);
            if (n < REQUEUE_BATCH) requeued = true;
            else return { idle: false };
          }

          const pending = await ioGate.fetchPendingMentionJudgements(
            BATCH,
            WORTH_GATE_RUBRIC_VERSION,
            decision.modelId,
            clock(),
          );
          if (pending.length === 0) {
            // Extraction kicks the gate for every few documents it queues, so
            // only a real backlog earns an info line.
            if (judged >= CAUGHT_UP_LOG_MIN) {
              log.info(`mention worth gate caught up: ${judged} documents judged`);
            } else if (judged > 0) {
              log.debug(`mention worth gate caught up: ${judged} documents judged`);
            }
            judged = 0;
            return { idle: true };
          }

          const { records, deferrals, answers, failed } = await judge(
            pending,
            decision,
            judgeDeps,
            clock,
          );
          const settled = await writeGate.applyMentionJudgements(records, deferrals, answers);
          judged += settled;
          tracker.recordTick(settled);
          if (failed > 0) {
            log.warn(`mention worth gate: decision model unavailable for ${failed} documents`);
          }
          // Nothing settled means every document in reach is waiting: rest.
          return { idle: settled === 0 };
        }),
      );
    },
  };
}

type Ask = Extract<PendingMentionJudgement, { kind: "ask" }>;

async function judge(
  pending: readonly PendingMentionJudgement[],
  decision: DecisionCapability,
  deps: MentionWorthGateDeps & { idGen: () => string },
  clock: () => number,
): Promise<{
  records: MentionJudgementRecord[];
  deferrals: MentionJudgementDeferral[];
  answers: WorthAnswer[];
  failed: number;
}> {
  const records: MentionJudgementRecord[] = [];
  const deferrals: MentionJudgementDeferral[] = [];
  const answers: WorthAnswer[] = [];
  const deferral = (p: PendingMentionJudgement): MentionJudgementDeferral => ({
    documentId: p.documentId,
    generation: p.generation,
    nextAttemptAt: nextAttemptAt(clock(), p.attempts),
  });
  const scored = (
    p: PendingMentionJudgement & { subjectDocumentId: string },
    contentHash: string,
    score: number,
  ): MentionJudgementRecord => ({
    documentId: p.documentId,
    generation: p.generation,
    verdict: passesWorthThreshold(score) ? "keep" : "drop",
    subjectDocumentId: p.subjectDocumentId,
    contentHash,
    rubricVersion: WORTH_GATE_RUBRIC_VERSION,
    score,
    judgedAt: clock(),
  });
  // Several documents of one batch can share an email (its attachments);
  // they share its one call.
  const asks = new Map<string, Ask[]>();
  for (const p of pending) {
    switch (p.kind) {
      case "exempt":
        records.push({
          documentId: p.documentId,
          generation: p.generation,
          verdict: "exempt",
          subjectDocumentId: p.subjectDocumentId,
          contentHash: null,
          rubricVersion: null,
          score: null,
          judgedAt: clock(),
        });
        break;
      case "wait":
        deferrals.push(deferral(p));
        break;
      case "answered":
        records.push(scored(p, p.answer.contentHash, p.answer.score));
        break;
      case "ask": {
        const key = `${p.subjectDocumentId}:${p.contentHash}`;
        asks.set(key, [...(asks.get(key) ?? []), p]);
        break;
      }
      default:
        assertNever(p);
    }
  }

  let failed = 0;
  const groups = [...asks.values()];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < groups.length) {
      const group = groups[next++]!;
      const first = group[0]!;
      const reply = await askScore(
        decision,
        { state: { ...first.state }, questions: EMAIL_WORTH_QUESTIONS },
        EMAIL_WORTH_QUESTION_ID,
        { recordSpend: deps.recordSpend, log: deps.log, timeoutMs: CALL_TIMEOUT_MS },
      );
      const score = reply.score;
      if (score === null) {
        failed += group.length;
        deferrals.push(...group.map(deferral));
        continue;
      }
      answers.push({
        id: `wa_${deps.idGen()}`,
        subjectDocumentId: first.subjectDocumentId,
        contentHash: first.contentHash,
        rubricVersion: WORTH_GATE_RUBRIC_VERSION,
        requestedModelId: decision.modelId,
        modelId: reply.modelId,
        score,
        answeredAt: clock(),
      });
      for (const p of group) records.push(scored(p, p.contentHash, score));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, groups.length) }, worker));
  return { records, deferrals, answers, failed };
}

export interface BootMentionWorthGateDeps extends Omit<MentionWorthGateDeps, "tracker"> {
  scheduler: Scheduler;
  backgroundJobs: BackgroundJobsRegistry;
  /** Cheap count of documents waiting for a judgement — seeds the tracker. */
  countPending: () => number;
  /** Whether the gate is active: the setting is on and the decision model is ready. */
  active: () => boolean;
}

/**
 * Register the mention worth gate. Always scheduled; each tick checks the
 * setting and the decision model, so turning either on or off takes effect
 * live.
 *
 * Returns a `kick` that fires the next tick at once — wired to date
 * extraction, which queues the documents the gate judges.
 */
export function bootMentionWorthGate(deps: BootMentionWorthGateDeps): { kick: () => void } {
  let initialRemaining = 0;
  try {
    initialRemaining = deps.countPending();
  } catch (err) {
    deps.log.warn(
      `mention worth gate: pending-count seed failed: ${err instanceof Error ? err.message : err}`,
    );
  }
  const tracker = new QueueTracker({ initialRemaining });
  const task = mentionWorthGateTask({ ...deps, tracker });
  deps.scheduler.schedule(task);
  deps.backgroundJobs.registerAll([
    periodicJob(task, {
      scheduler: deps.scheduler,
      displayName: "Date mention worth gate",
      description:
        "Asks the decision model whether each email with a date mention is worth recording; the time query leaves out mentions from email judged not worth it.",
      category: "indexer",
      tracker,
      isDisabled: () => !deps.active(),
    }),
  ]);
  return {
    kick: () =>
      void runWithPriority("background", () =>
        deps.scheduler.kickPeriodic(MENTION_WORTH_GATE_TASK_NAME),
      ),
  };
}
