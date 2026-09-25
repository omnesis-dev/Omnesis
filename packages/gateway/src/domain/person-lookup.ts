// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `assemblePersonLookup` — the pure read half of the agent's `lookup_people`
 * tool.
 *
 * Runs `searchPeople` (canonical-name + alias LIKE match, interaction-score
 * sort) and overlays, per candidate, the merged alias list + the
 * email/chat/meeting doc-count split and grounded memory annotations. Under
 * `experimental` it also overlays semantic-time entries and active open loops. One small follow-up query per candidate; the caller clamps `limit`
 * (≤ {@link import("@omnesis/agent").LOOKUP_PEOPLE_MAX_LIMIT}) so the worst case
 * is a bounded fan-out of cheap prepared-statement reads.
 *
 * `db` reads only, serializable output — so it runs unchanged on the gateway's
 * read-worker pool (see `io.lookupPeople`) or, when no gate is wired, on the
 * main thread. `experimental` is a PARAMETER, not `experimentalVisible()`: the
 * flag is a main-thread env read, so the caller computes it and passes the
 * boolean in — the worker never touches the env.
 */

import { listLivePersonAnnotationsForPerson } from "../brain/storage/person-annotations.js";
import { listLoopsForPerson } from "../brain/storage/open-loops.js";
import { listTemporalAnnotationsForPerson } from "../enrichment/temporal-annotations/storage.js";
import {
  getPersonInteractionCountsByChannel,
  listMergedAliasesForPerson,
  searchPeople,
} from "../data/repositories/PersonRepository.js";
import type { PersonSummary } from "@omnesis/core";
import type Database from "better-sqlite3";

type Db = Database.Database;

/**
 * The narrow read-worker capability the person port delegates `lookup_people`
 * to. The full `IoGate` (see `scheduler/io-ops.ts`) structurally satisfies it,
 * exactly as it already satisfies `PeopleBrowseGate`.
 */
export interface PersonLookupGate {
  lookupPeople(
    query: string,
    limit: number,
    opts: { experimental: boolean },
  ): Promise<PersonSummary[]>;
}

function parseEpochMillis(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : undefined;
}

export function assemblePersonLookup(
  db: Db,
  query: string,
  limit: number,
  opts: { experimental: boolean },
): PersonSummary[] {
  const rows = searchPeople(db, query, limit, { sortBy: "interaction" });

  return rows.map((row) => {
    const aliases = listMergedAliasesForPerson(db, row.id);
    const counts = getPersonInteractionCountsByChannel(db, row.id);
    const lastInteraction = parseEpochMillis(row.lastSeen);
    const summary: PersonSummary = {
      canonicalId: row.id,
      displayName: row.canonicalName,
      aliases,
      interactionScore: row.interactionScoreRecent,
    };
    if (counts.email !== undefined) summary.emailCount = counts.email;
    if (counts.chat !== undefined) summary.chatCount = counts.chat;
    if (counts.meeting !== undefined) summary.meetingCount = counts.meeting;
    if (lastInteraction !== undefined) summary.lastInteraction = lastInteraction;
    // Durable person memory is available independently of background cognition.
    const annos = listLivePersonAnnotationsForPerson(db, row.id).map((a) => ({
      claimType: a.claimType,
      claim: a.claimText,
      confidence: a.confidence,
      evidenceDocId: a.evidenceDocId,
    }));
    if (annos.length > 0) summary.annotations = annos;
    if (opts.experimental) {
      const temporalAnnotations = listTemporalAnnotationsForPerson(db, row.id).map((e) => ({
        annotationId: e.id,
        sentence: e.sentence,
        ...(e.canonical ? { when: e.canonical } : {}),
        ...(e.kind ? { kind: e.kind } : {}),
      }));
      if (temporalAnnotations.length > 0) {
        summary.temporalAnnotations = temporalAnnotations;
      }
      // The person's active obligations — via the sparse curated
      // open_loop_people join (never document_people), so a hub person can't
      // drag in the corpus.
      const openLoops = listLoopsForPerson(db, row.id).map((l) => ({
        loopId: l.id,
        title: l.title,
        state: l.state,
        ...(l.importance !== undefined ? { importance: l.importance } : {}),
      }));
      if (openLoops.length > 0) summary.openLoops = openLoops;
    }
    return summary;
  });
}
