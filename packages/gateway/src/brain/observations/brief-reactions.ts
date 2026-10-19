// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Thumbs on a shipped morning-brief item.
 *
 * A thumbs up says the owner wanted this kind of observation; "not
 * interested" says they did not. Both become one interest signal with the
 * item's text, replacing whatever the owner said about the item before. A
 * factual error is not about interest at all: it marks the observation
 * disputed and, when the owner wrote a correction, saves it as a quick-capture
 * note so the note agent acts on it. Clearing a reaction takes the signal
 * back. The signal, the reaction row and the observation's user action land
 * in one writer transaction; only the correction note is saved first, on its
 * own, so a note that could not be saved leaves the item untouched.
 */

import { createHash } from "node:crypto";
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
}

export interface BriefItemReactionView {
  observationId: string;
  reaction: BriefItemReactionKind | null;
  note?: string;
  /** The quick-capture note a factual correction was saved as. */
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
  writeGate: Pick<WriteGate, "setBriefItemReaction">;
  interest: Pick<InterestEngine, "draft">;
  /** Resolved per call; null until the notes source is up. */
  notes: () => BriefNoteCapture | null | undefined;
  clock: () => number;
  log: Logger;
}

/** The text a correction is saved as, so the note agent knows what it corrects. */
export function correctionNoteText(summary: string, correction: string): string {
  return `Correction to a morning brief item. The brief said: "${summary}". The user says: ${correction}`;
}

/**
 * The note id a correction is saved under: a name-based UUID of the item and
 * the correction's words, so the same correction sent twice is one note and
 * a client cannot point the reaction at a note it did not write.
 */
export function correctionNoteId(observationId: string, correction: string): string {
  const hex = createHash("sha256")
    .update(`brief-correction\u0000${observationId}\u0000${correction}`)
    .digest("hex");
  // RFC 4122 layout with the name-based version nibble and the variant bits.
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function reactionView(
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

    let noteId: string | undefined;
    if (input.reaction === "factual_error" && note) {
      // Not a word about interest. The correction is saved before anything
      // else changes, so a note that cannot be saved leaves the item as it was.
      noteId = correctionNoteId(observation.id, note);
      const previous = getBriefItemReaction(deps.db, observation.id);
      if (previous?.noteId !== noteId) {
        const notes = deps.notes();
        if (!notes)
          return {
            ok: false,
            reason: "notes_unavailable",
            message: "the correction could not be saved: notes are unavailable",
          };
        try {
          await notes.capture({
            id: noteId,
            text: correctionNoteText(observation.summary, note),
            capturedAt: new Date(now).toISOString(),
            surface: "brief",
            fromOwner: true,
          });
        } catch (error) {
          deps.log.warn(
            `Correction on brief item ${observation.id} not saved: ${error instanceof Error ? error.message : String(error)}`,
          );
          return {
            ok: false,
            reason: "notes_unavailable",
            message: "the correction could not be saved: notes are unavailable",
          };
        }
      }
    }

    const signal =
      input.reaction === "up" || input.reaction === "not_interested"
        ? deps.interest.draft({
            polarity: input.reaction === "up" ? 1 : -1,
            kind: "observation",
            source: input.reaction === "up" ? "brief_thumbs_up" : "brief_not_interested",
            subjectText: observation.why
              ? `${observation.summary}\n${observation.why}`
              : observation.summary,
            note: note ?? null,
            observationId: observation.id,
          })
        : null;
    const stored = await deps.writeGate.setBriefItemReaction(
      {
        observationId: observation.id,
        day: input.day,
        messageId: input.messageId,
        reaction: input.reaction,
        note: note ?? null,
        noteId: noteId ?? null,
        signal,
      },
      now,
    );
    deps.log.info(
      `Brief item ${observation.id}: ${input.reaction ?? "cleared"}${note ? " with a note" : ""}`,
    );
    return { ok: true, reaction: reactionView(stored, observation.id) };
  };
}
