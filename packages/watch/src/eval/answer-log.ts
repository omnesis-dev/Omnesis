// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The answers a sweep drew, kept as they land.
 *
 * A sweep is a long-running process holding the only copy of something
 * expensive, and the reason to keep the answers at all is to score them again
 * later under a changed rule — which is what tells "the rate moved" apart from
 * "the model had a better day". A log written once at the end has that property
 * only for runs that reach the end. This one is written after every attempt, so
 * a sweep that dies holds everything it had paid for up to the moment it died.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { EvalTask, SampleOutcome } from "./harness.js";

/** The shape `rescore-eval.ts` reads back. */
export interface KeptRun {
  readonly model: string;
  readonly tasks: readonly EvalTask[];
  readonly outcomes: readonly SampleOutcome[];
}

/**
 * Identifies one attempt within a run.
 *
 * The arm belongs in the key. A run comparing two prompts draws sample #3 of a
 * request under each of them, so request-and-sample alone names two different
 * attempts, and anything keyed that way silently keeps one of the pair.
 */
export function attemptKey(outcome: {
  readonly prompt: string;
  readonly sample: number;
  readonly arm?: string;
}): string {
  return `${outcome.prompt}#${outcome.sample}${outcome.arm === undefined ? "" : `@${outcome.arm}`}`;
}

export class AnswerLog {
  private readonly landed: SampleOutcome[] = [];

  constructor(
    private readonly path: string,
    private readonly model: string,
    private readonly tasks: readonly EvalTask[],
  ) {
    mkdirSync(dirname(this.path), { recursive: true });
    this.write();
  }

  /** Record one attempt and put the whole log on disk. */
  append(outcome: SampleOutcome): void {
    this.landed.push(outcome);
    this.write();
  }

  /** What has been recorded so far. */
  get outcomes(): readonly SampleOutcome[] {
    return this.landed;
  }

  /**
   * Written to a neighbouring file and renamed over the real one.
   *
   * Writing after every attempt means a crash can land mid-write, and a
   * half-written file is worse than a stale one: the stale file still parses. A
   * rename within a directory is atomic, so a reader sees either the previous
   * complete log or the current one. The guarantee is against a process dying,
   * not against power loss — nothing is fsynced.
   */
  private write(): void {
    const kept: KeptRun = { model: this.model, tasks: this.tasks, outcomes: this.landed };
    const pending = `${this.path}.pending`;
    writeFileSync(pending, `${JSON.stringify(kept, null, 2)}\n`);
    renameSync(pending, this.path);
  }
}
