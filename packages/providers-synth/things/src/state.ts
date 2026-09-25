// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A migration the end-to-end suite can actually run.
 *
 * Every real source declares what it persists, and three of them declare a
 * migration — but no end-to-end test can reach one. A synthetic double is
 * barred from inheriting its twin's declaration, because a real decoder
 * refuses the cursor a double actually writes, and the doubles are what an
 * end-to-end run drives. So the machinery that carries an installed cursor
 * forward has unit coverage on both sides of a seam that nothing crosses.
 *
 * This double declares its own, over its own cursor. The shape is the
 * commonest migration there is — a field renamed — chosen because it is the
 * one where getting the decoder wrong is invisible: a decoder that accepts
 * both spellings classifies the old one as current and silently resumes from a
 * field that is not there, which reads as a source that had nothing new.
 *
 * The double's cursor is `{ offset }`, the position in its fixture list. The
 * generation before it spelled that `index`.
 */

import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { SynthCursor } from "@omnesis/providers-synth-common";

/** The shape stored today. */
export const THINGS_SYNTH_STATE_VERSION = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const thingsSynthStateSpec: SourceStateSpec<SynthCursor> = {
  version: THINGS_SYNTH_STATE_VERSION,

  /**
   * Requires `offset` to be present rather than merely well-typed when it
   * happens to appear.
   *
   * An optional-field decoder would accept the earlier `{ index }` shape —
   * `offset` is absent, and absent passes an optional check — so the value
   * would be stamped as current, and the source would resume from an offset
   * of nothing. That is not a loud failure: it looks like a source that
   * restarted with nothing new to say.
   */
  decode(value: unknown): SynthCursor | null {
    if (!isRecord(value)) return null;
    if (typeof value.offset !== "number") return null;
    return value as SynthCursor;
  },

  /**
   * A stored value from before envelopes existed. The earlier generation is
   * the one carrying `index`; anything else already speaks the current shape.
   */
  legacyVersion(value: unknown): number | null {
    if (!isRecord(value)) return null;
    return typeof value.index === "number" ? 1 : THINGS_SYNTH_STATE_VERSION;
  },

  migrate: {
    /** `index` became `offset`. The number means the same thing. */
    1: (prior: unknown): SynthCursor => {
      const index = isRecord(prior) && typeof prior.index === "number" ? prior.index : 0;
      return { offset: index };
    },
  },

  /**
   * A fixture list is re-readable in full, so an unreadable bookmark costs a
   * re-walk and loses nothing.
   */
  onUnreadable: "rebootstrap",
};
