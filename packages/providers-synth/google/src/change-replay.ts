// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SyncResult } from "@omnesis/source-sdk";
import type { SynthCursor } from "@omnesis/providers-synth-common";
import type { DocumentInput } from "@omnesis/types";

/** A fixture cursor that also remembers how much of an account's change journal it has sent. */
export interface ReplayCursor extends SynthCursor {
  /** How many journal entries the source had sent when this cursor was written. */
  changeSeq?: number;
}

/**
 * Add to a fixture page the records that changed since the cursor was
 * written, the way a real source's change feed does.
 *
 * A walk from the start of the fixture pins the journal where it stands: the
 * walk reads every record as it is now, so only changes made after it began
 * are owed. They are sent by the first sync after the walk ends, and from then
 * on by each sync that finds the fixture already read.
 */
export async function withChangeReplay<TCursor extends ReplayCursor>(
  cursor: TCursor | null,
  journal: readonly string[],
  page: SyncResult<TCursor>,
  emit: (externalIds: ReadonlySet<string>) => Promise<DocumentInput[]> | DocumentInput[],
): Promise<SyncResult<TCursor>> {
  const offset = cursor?.offset ?? 0;
  const sent = offset === 0 ? journal.length : Math.min(cursor?.changeSeq ?? 0, journal.length);
  const walked = offset > 0 && page.cursor.offset === offset && !page.hasMore;
  if (!walked || sent === journal.length) {
    return { ...page, cursor: { ...page.cursor, changeSeq: sent } };
  }
  const changed = await emit(new Set(journal.slice(sent)));
  return {
    ...page,
    documents: [...page.documents, ...changed],
    cursor: { ...page.cursor, changeSeq: journal.length },
  };
}
