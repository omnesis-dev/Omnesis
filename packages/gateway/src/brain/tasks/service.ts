// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Tasks domain service: the journal views and task reads on the read
 * handle, and every task command through the write gate, followed by the
 * same cascades a Brain run applies to a loop it changes.
 */

import { getNoteEntry } from "../../sources/omnesis-notes/storage.js";
import {
  TaskQueryService,
  type TaskDocument,
  type TaskItem,
  type TaskView,
  type TaskViewResult,
  type TaskCounts,
} from "./views.js";
import type { OpenLoopLedgerEntry, TaskSchedule } from "../storage/types.js";
import type { TaskCommand, TaskCommandOrigin, TaskCommandResult } from "../storage/tasks.js";
import type { OmnesisNotesRuntime } from "../../sources/omnesis-notes/wiring.js";
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
  /**
   * `brain.interest.enabled`, read per command: whether an accept, create or
   * ignore records the interest signal it implies. Omitted, it does.
   */
  interestEnabled?: () => boolean;
}

/** Accepting a suggestion with what the user wants to add about it. */
export interface AcceptWithNote extends TaskCommandOrigin {
  id: string;
  scheduledFor?: TaskSchedule | null;
  /** What the user typed or dictated. */
  note: string;
  /** The note's id, which makes a retried request a replay. */
  noteId: string;
}

/** The text of a note written while accepting a task, as the note agent and the notes list read it. */
export function taskNoteText(title: string, note: string): string {
  return `This is a note about the task “${title}”: ${note.trim()}`;
}

export class TaskService {
  private readonly queries: TaskQueryService;

  constructor(
    private readonly db: Database.Database,
    private readonly writeGate: Pick<WriteGate, "applyTaskCommand">,
    private readonly clock: () => number = Date.now,
    private readonly effects?: TaskEffects,
    /** Tell Omnesis capture, for a suggestion accepted with a note. */
    private readonly notes?: () => Pick<OmnesisNotesRuntime, "capture">,
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

  /**
   * Accept a suggestion and save what the user said about it as a Tell
   * Omnesis note naming the task, which the note agent then reads and applies
   * to it. Both land or neither does: a note that cannot be saved undoes the
   * acceptance. A retry with the same note id finds the note already saved
   * and answers with the task as it stands.
   */
  async acceptWithNote(input: AcceptWithNote): Promise<TaskCommandResult & { noteId?: string }> {
    const notes = this.notes?.();
    if (!notes) return { ok: false, reason: "invalid", message: "notes are unavailable" };
    const saved = getNoteEntry(this.db, input.noteId);
    if (saved) {
      const item = this.queries.get(input.id);
      if (saved.taskId !== input.id || !item)
        return { ok: false, reason: "invalid", message: "that note belongs to another task" };
      return {
        ok: true,
        loop: item.row,
        loopId: input.id,
        eventSeq: this.queries.latestUndoable(input.id),
        resolved: false,
        reopened: false,
        receipt: `Added to your tasks: ${item.row.title}`,
        noteId: saved.id,
      };
    }
    const { note, noteId, ...accept } = input;
    const result = await this.apply({ ...accept, kind: "accept" });
    if (!result.ok || !result.loop) return result;
    try {
      await notes.capture({
        id: noteId,
        text: taskNoteText(result.loop.title, note),
        capturedAt: new Date(this.clock()).toISOString(),
        surface: "tasks",
        fromOwner: true,
        taskId: result.loopId,
      });
    } catch (err) {
      if (result.eventSeq !== null)
        await this.apply({
          surface: input.surface,
          runId: input.runId,
          kind: "undo",
          seq: result.eventSeq,
        });
      throw err;
    }
    return { ...result, noteId };
  }

  async apply(command: TaskCommand): Promise<TaskCommandResult> {
    const now = this.clock();
    const recordInterest = this.effects?.interestEnabled?.() ?? true;
    const result = await this.writeGate.applyTaskCommand(
      recordInterest ? command : { ...command, recordInterest: false },
      now,
    );
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
