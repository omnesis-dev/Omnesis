// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Reading a stored cursor back as the shape its source expects.
 *
 * A validator answers one question — is this stored value a cursor I can
 * resume from — and `null` means "no, start over". That is the right answer
 * for a cursor written by an older shape of the same source, which is what the
 * mechanism is for.
 *
 * It is the wrong answer for one particular value, and that case is why this
 * file is more than one line. A source that declares versioned state has its
 * bookmark persisted inside an envelope, and the host unwraps that envelope
 * before the source ever sees it. If the declaration is later removed, the
 * source stops being wrapped while its stored envelopes remain — and an
 * envelope handed to a plain validator fails the predicate and reads as
 * `null`. The source then re-walks its entire upstream, and nothing anywhere
 * says why.
 *
 * So an envelope is refused rather than silently discarded. Refusing parks the
 * source with a message naming the cause; discarding spends a full bootstrap's
 * worth of third-party requests and looks, from the outside, like a source
 * that simply had a lot of new data.
 */

import { isStateEnvelope } from "./source-state.js";

export type CursorValidator<T> = (cursor: unknown) => T | null;

/**
 * A stored bookmark this build cannot interpret, where treating it as absent
 * would hide the reason.
 */
export class CursorEnvelopeError extends Error {
  constructor() {
    super(
      "Stored cursor is a versioned state envelope, but this source no longer declares " +
        "`contract.state`. Reading it as a fresh start would re-walk the whole upstream " +
        "silently. Restore the source's state declaration, or clear this source's cursor " +
        "deliberately to bootstrap it.",
    );
    this.name = "CursorEnvelopeError";
  }
}

export function makeCursorValidator<T>(predicate: (v: unknown) => v is T): CursorValidator<T> {
  return (cursor: unknown) => {
    // Checked before the predicate: a lenient predicate — one whose fields are
    // all optional — would otherwise accept the envelope as a cursor whose
    // every field is missing, which resumes from nothing while reporting
    // success. That is the same loss as a bootstrap, minus the evidence.
    if (isStateEnvelope(cursor)) throw new CursorEnvelopeError();
    return predicate(cursor) ? cursor : null;
  };
}
