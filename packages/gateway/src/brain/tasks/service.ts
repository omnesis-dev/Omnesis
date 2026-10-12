// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Tasks domain service: the journal views and task reads on the read
 * handle, and every task command through the write gate, followed by the
 * same cascades a Brain run applies to a loop it changes.
 */

import {
  TaskQueryService,
  type TaskDocument,
  type TaskItem,
  type TaskView,
  type TaskViewResult,
  type TaskCounts,
} from "./views.js";
import type { OpenLoopLedgerEntry } from "../storage/types.js";
import type { TaskCommand, TaskCommandResult } from "../storage/tasks.js";
import type { WriteGate } from "../../write-gate.js";
import type Database from "better-sqlite3";

/**
 * What follows a task change. The searchable loop mirror exists only while
 * the Brain runs, so it is optional.
 */
export interface TaskEffects {
  writeGate: Pick<WriteGate, "cancelScheduledRunsForLoop" | "dropObservationsForResolvedLoop">;
  mirror?: {
    refresh(loopId: string): Promise<void>;
    remove(loopIds: readonly string[]): Promise<void>;
  };
}

export class TaskService {
  private readonly queries: TaskQueryService;

  constructor(
    db: Database.Database,
    private readonly writeGate: Pick<WriteGate, "applyTaskCommand">,
    private readonly clock: () => number = Date.now,
    private readonly effects?: TaskEffects,
  ) {
    this.queries = new TaskQueryService(db);
  }

  now(): number {
    return this.clock();
  }

  view(
    view: TaskView,
    day: string,
    options?: { limit?: number; before?: { resolvedAt: number; id: string } },
  ): TaskViewResult {
    return this.queries.view(view, day, options);
  }

  get(id: string): TaskItem | null {
    return this.queries.get(id);
  }

  /** The documents `items` refer to that are still there to open, by id. */
  counts(day: string): TaskCounts {
    return this.queries.counts(day);
  }

  documents(items: readonly TaskItem[]): Map<string, TaskDocument> {
    return this.queries.documents(items);
  }

  /** A task's change history, newest first, and the change undo would revert. */
  history(id: string): { events: OpenLoopLedgerEntry[]; undoSeq: number | null } {
    return { events: this.queries.history(id), undoSeq: this.queries.latestUndoable(id) };
  }

  async apply(command: TaskCommand): Promise<TaskCommandResult> {
    const now = this.clock();
    const result = await this.writeGate.applyTaskCommand(command, now);
    if (!result.ok || !this.effects) return result;
    const { mirror, writeGate } = this.effects;
    if (result.loop === null) {
      // Deleted: its scheduled checks would only wake a run to find it gone.
      await mirror?.remove([result.loopId]);
      await writeGate.cancelScheduledRunsForLoop(result.loopId);
      return result;
    }
    await mirror?.refresh(result.loopId);
    if (result.resolved) {
      // A resolved task needs no more checks, and tomorrow's brief must not
      // raise what the user just handled.
      await writeGate.cancelScheduledRunsForLoop(result.loopId);
      await writeGate.dropObservationsForResolvedLoop(result.loopId, now);
    }
    return result;
  }
}
