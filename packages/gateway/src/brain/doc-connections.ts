// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Cognition Steward's inline "connections" for a document — the open loops it is a
 * source for, the durable annotations recorded about it, and the temporal
 * annotations it grounds (deadlines/events/expiries) — projected to compact
 * wire-hint shapes. Shared search/fetch ports expose memory in every mode and
 * retain experimental gates for open loops and temporal annotations.
 *
 * Owning the projection here (not in the agent port) keeps the loop /
 * annotation shapes inside the briefs subsystem; the port calls
 * this one function.
 */

import { listTemporalAnnotationsForDoc } from "../enrichment/temporal-annotations/storage.js";
import { listLoopsForDoc } from "./storage/open-loops.js";
import { listLiveAnnotationsForDoc } from "./storage/annotations.js";
import type Database from "better-sqlite3";
import type { DocAnnotationHint, DocLoopRef, DocTemporalAnnotationRef } from "@omnesis/core";

type Db = Database.Database;

export interface DocConnections {
  openLoops: DocLoopRef[];
  annotations: DocAnnotationHint[];
  temporalAnnotations: DocTemporalAnnotationRef[];
}

/**
 * Read a document's inline connections. Both annotation families are read
 * only when their option is set; open loops can be withheld by stable callers. Returns empty stores for a document with none —
 * the caller omits empty arrays from the wire ref.
 */
export function readDocConnections(
  db: Db,
  docId: string,
  opts: { annotations: boolean; temporalAnnotations?: boolean; openLoops?: boolean },
): DocConnections {
  const openLoops: DocLoopRef[] = (opts.openLoops === false ? [] : listLoopsForDoc(db, docId)).map(
    (l) => ({
      loopId: l.id,
      title: l.title,
      state: l.state,
      ...(l.importance !== undefined ? { importance: l.importance } : {}),
    }),
  );
  const annotations: DocAnnotationHint[] = opts.annotations
    ? listLiveAnnotationsForDoc(db, docId).map((a) => ({
        claimType: a.claimType,
        claim: a.claimText,
        confidence: a.confidence,
        evidenceDocId: a.evidenceDocId,
      }))
    : [];
  const temporalAnnotations: DocTemporalAnnotationRef[] = opts.temporalAnnotations
    ? listTemporalAnnotationsForDoc(db, docId).map((e) => ({
        annotationId: e.id,
        sentence: e.sentence,
        ...(e.canonical ? { when: e.canonical } : {}),
        ...(e.kind ? { kind: e.kind } : {}),
      }))
    : [];
  return { openLoops, annotations, temporalAnnotations };
}
