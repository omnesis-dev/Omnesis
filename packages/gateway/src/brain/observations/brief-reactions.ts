// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Thumbs on a shipped morning-brief item.
 *
 * A thumbs up says the owner wanted this kind of observation; "not
 * interested" says they did not. Both become one interest signal with the
 * item's text, replacing whatever the owner said about the item before. A
 * factual error is not about interest at all: it marks the observation
 * disputed and, when the owner wrote a correction, saves it as a Tell Omnesis
 * note so the note agent acts on it. Clearing a reaction takes the signal
 * back.
 */

import { randomUUID } from "node:crypto";
import { getObservation } from "../storage/observations.js";
import { listMorningBriefItemsForMessage } from "../storage/morning-brief-items.js";
import { getBriefItemReaction, type BriefItemReactionKind } from "../storage/interest.js";
import type { InterestEngine } from "../interest/engine.js";
import type { WriteGate } from "../../write-gate.js";
import type { Logger } from "@omnesis/core";
import type Database from "better-sqlite3";

export interface BriefItemReactionInput {
  day: string;
  messageId: string;
  observationId: string;
  /** Null clears the owner's reaction. */
  reaction: BriefItemReactionKind | null;
  /** The owner's words: why they are not interested, or the correction. */
  note?: string;
  /** The Tell Omnesis note id a factual correction is saved under; retries reuse it. */
  noteId?: string;
}

export interface BriefItemReactionView {
  observationId: string;
  reaction: BriefItemReactionKind | null;
  note?: string;
  noteId?: string;
  /** ISO 8601 UTC. */
  at?: string;
}

export type BriefItemReactionResult =
  | { ok: true; reaction: BriefItemReactionView }
  | { ok: false; reason: "not_an_item" | "notes_unavailable"; message: string };

/** Applies the owner's thumbs on one item of one sent brief. */
export type BriefItemReactor = (input: BriefItemReactionInput) => Promise<BriefItemReactionResult>;

/** The notes runtime's capture seam, as this module needs it. */
export interface BriefNoteCapture {
  capture(input: {
    id: string;
    text: string;
    capturedAt: string;
    surface: string;
    fromOwner: boolean;
  }): Promise<unknown>;
}

export interface BriefItemReactorDeps {
  db: Database.Database;
  writeGate: Pick<WriteGate, "setBriefItemReaction" | "setObservationUserAction">;
  interest: Pick<InterestEngine, "record" | "supersede">;
  /** Resolved per call; null until the notes source is up. */
  notes: () => BriefNoteCapture | null | undefined;
  clock: () => number;
  log: Logger;
}

/** How a reaction reads on the observation row, where other tools look for what the owner did. */
export const REACTION_USER_ACTIONS: Record<BriefItemReactionKind, string> = {
  up: "thumbs_up",
  not_interested: "not_interested",
  factual_error: "disputed",
};

/** The text a correction is saved as, so the note agent knows what it corrects. */
export function correctionNoteText(summary: string, correction: string): string {
  return `Correction to a morning brief item. The brief said: "${summary}". The user says: ${correction}`;
}

export function reactionView(
  reaction: Awaited<ReturnType<WriteGate["setBriefItemReaction"]>>,
  observationId: string,
): BriefItemReactionView {
  if (!reaction) return { observationId, reaction: null };
  return {
    observationId,
    reaction: reaction.reaction,
    ...(reaction.note ? { note: reaction.note } : {}),
    ...(reaction.noteId ? { noteId: reaction.noteId } : {}),
    at: new Date(reaction.updatedAt).toISOString(),
  };
}

export function createBriefItemReactor(deps: BriefItemReactorDeps): BriefItemReactor {
  return async (input) => {
    const observation = getObservation(deps.db, input.observationId);
    const shipped =
      observation !== null &&
      observation.state === "shipped" &&
      observation.shippedMessageId === input.messageId &&
      listMorningBriefItemsForMessage(deps.db, input.messageId).some(
        (item) => item.observationId === input.observationId && item.day === input.day,
      );
    if (!observation || !shipped)
      return {
        ok: false,
        reason: "not_an_item",
        message: `observation ${input.observationId} is not an item of the brief sent on ${input.day}`,
      };
    const now = deps.clock();
    const note = input.note?.trim() || undefined;
    const subjectText = observation.why
      ? `${observation.summary}\n${observation.why}`
      : observation.summary;

    if (input.reaction === null) {
      await deps.interest.supersede({ observationId: observation.id, kind: "observation" });
      const cleared = await deps.writeGate.setBriefItemReaction(
        { observationId: observation.id, clear: true },
        now,
      );
      await deps.writeGate.setObservationUserAction(observation.id, null, now);
      return { ok: true, reaction: reactionView(cleared, observation.id) };
    }

    let noteId: string | undefined;
    if (input.reaction === "factual_error") {
      // Not a word about interest: a previous thumbs up no longer stands,
      // and nothing replaces it. The correction is saved first, so that when
      // it cannot be, nothing has changed.
      if (note) {
        const notes = deps.notes();
        if (!notes)
          return {
            ok: false,
            reason: "notes_unavailable",
            message: "the correction could not be saved: notes are unavailable",
          };
        const previous = getBriefItemReaction(deps.db, observation.id);
        // The same correction again is the note already saved, whether the
        // client repeats its id or omits it; new words are a new note.
        const repeated = previous?.noteId !== null && previous?.note === note;
        noteId = input.noteId ?? (repeated ? previous.noteId! : randomUUID());
        if (!(repeated && previous.noteId === noteId)) {
          await notes.capture({
            id: noteId,
            text: correctionNoteText(observation.summary, note),
            capturedAt: new Date(now).toISOString(),
            surface: "brief",
            fromOwner: true,
          });
        }
      }
      await deps.interest.supersede({ observationId: observation.id, kind: "observation" });
    } else {
      await deps.interest.record({
        polarity: input.reaction === "up" ? 1 : -1,
        kind: "observation",
        source: input.reaction === "up" ? "brief_thumbs_up" : "brief_not_interested",
        subjectText,
        note: note ?? null,
        observationId: observation.id,
        replaces: { observationId: observation.id, kind: "observation" },
      });
    }
    const stored = await deps.writeGate.setBriefItemReaction(
      {
        observationId: observation.id,
        day: input.day,
        messageId: input.messageId,
        reaction: input.reaction,
        note: note ?? null,
        noteId: noteId ?? null,
      },
      now,
    );
    await deps.writeGate.setObservationUserAction(
      observation.id,
      REACTION_USER_ACTIONS[input.reaction],
      now,
    );
    deps.log.info(`Brief item ${observation.id}: ${input.reaction}${note ? " with a note" : ""}`);
    return { ok: true, reaction: reactionView(stored, observation.id) };
  };
}
