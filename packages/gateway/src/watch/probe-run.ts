// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Running a watch's recall arm over documents the install already holds.
 *
 * The half of the probe that touches the corpus, kept apart from the
 * arithmetic in `probe.ts` so the arithmetic stays testable without one.
 *
 * The window is bounded twice, and both bounds are reported. Time, because a
 * threshold chosen against last quarter says nothing about a source that
 * started six months ago; and count, because scoring is a cosine against every
 * chunk of every document and an unbounded probe over a large corpus is a
 * long synchronous walk on a gateway that is also serving.
 */

import { sourcePrefixPredicate } from "../data/source-addressing.js";
import { summariseProbe, type ProbeSummary } from "./probe.js";
import type { Db } from "../data/types.js";
import type { RecallScorer } from "@omnesis/watch";

/** One document-event node with a semantic arm, as the probe reads it. */
export interface ProbeArm {
  readonly nodeId: string;
  readonly query: string;
  readonly threshold: number;
  readonly sources: readonly string[];
  readonly documentTypes: readonly string[];
}

export interface ProbeArmResult extends ProbeSummary {
  readonly nodeId: string;
  readonly query: string;
  /** The window actually walked, so a thin answer is readable as thin. */
  readonly windowDays: number;
  readonly capped: boolean;
}

export interface ProbeDeps {
  readonly db: Db;
  /** Where chunk embeddings live. Null means nothing can be scored at all. */
  readonly indexDb: Db | null;
  readonly recall: RecallScorer;
  /**
   * Whether the embedder this scorer needs is assigned.
   *
   * The runtime scores an unembeddable query as zero, which is right for it —
   * a failure must not nominate the corpus — and exactly wrong here: every
   * document would score zero and the probe would report, confidently, that
   * the threshold is far too high. A diagnostic that cannot measure has to say
   * so rather than answer.
   */
  readonly canScore: () => boolean;
  readonly now?: () => number;
}

/**
 * Documents a `source.document_event` filter would have admitted.
 *
 * Source matching follows the runtime's own rule exactly, and must: a bare
 * type widens to every account under it (`gmail` admits `gmail:someone`),
 * while an id that already names an account is exact. Matching on equality
 * alone is the failure this whole diagnostic exists to catch — a watch that
 * validates, installs, sits active and never fires — and a probe that made
 * the same mistake would report "nothing to score" for a watch that is
 * matching documents perfectly well. The provider is never consulted, because
 * the runtime never consults it.
 *
 * Documents with no chunk are excluded rather than scored. A semantic arm
 * waits for indexing, so the runtime never looks at them; counting them as
 * zeroes would pad the denominator and pull the distribution down with
 * documents no watch would ever have seen.
 *
 * The people and metadata predicates are deliberately not applied, and neither
 * is the event op. All three narrow, so ignoring them can only over-count —
 * which is why the number is reported as "considered" rather than "matched".
 */
function candidates(
  db: Db,
  indexDb: Db | null,
  arm: ProbeArm,
  sinceIso: string,
  limit: number,
): string[] {
  if (!indexDb || arm.sources.length === 0) return [];
  const sourcePredicate = sourcePrefixPredicate("d.source_id", arm.sources);
  const params: unknown[] = [...sourcePredicate.params];
  const typeClause =
    arm.documentTypes.length > 0
      ? ` AND lower(json_extract(d.metadata, '$.documentType')) IN (${arm.documentTypes.map(() => "?").join(", ")})`
      : "";
  const rows = db
    .prepare<unknown[], { id: string }>(
      `SELECT d.id
         FROM documents d
        WHERE (${sourcePredicate.sql})
          AND d.source_created_at IS NOT NULL
          AND d.source_created_at >= ?${typeClause}
        ORDER BY d.source_created_at DESC
        LIMIT ?`,
    )
    .all(...params, sinceIso, ...arm.documentTypes.map((t) => t.toLowerCase()), limit)
    .map((row) => row.id);
  return rows.filter((id) => hasChunks(indexDb, id));
}

function hasChunks(indexDb: Db, documentId: string): boolean {
  return (
    indexDb
      .prepare<
        [string],
        { found: number }
      >("SELECT 1 AS found FROM chunks WHERE document_id = ? AND embedding IS NOT NULL LIMIT 1")
      .get(documentId) !== undefined
  );
}

/**
 * How many documents are scored between yields.
 *
 * Scoring is a synchronous cosine per chunk, and the query vector is cached
 * after the first document — so awaiting the scorer schedules a microtask,
 * which drains before the event loop services a single socket. Without an
 * explicit macrotask the whole walk is one blocking span on a gateway that is
 * also answering requests.
 */
const PROBE_YIELD_EVERY = 50;

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export async function probeArm(
  deps: ProbeDeps,
  arm: ProbeArm,
  options: { windowDays: number; limit: number },
): Promise<ProbeArmResult> {
  const now = deps.now?.() ?? Date.now();
  const sinceIso = new Date(now - options.windowDays * 86_400_000).toISOString();
  const ids = candidates(deps.db, deps.indexDb, arm, sinceIso, options.limit + 1);
  const capped = ids.length > options.limit;
  const considered = capped ? ids.slice(0, options.limit) : ids;

  const scores: number[] = [];
  for (const [index, documentId] of considered.entries()) {
    scores.push(await deps.recall.score({ nodeId: arm.nodeId, documentId, query: arm.query }));
    if ((index + 1) % PROBE_YIELD_EVERY === 0) await yieldToLoop();
  }

  return {
    nodeId: arm.nodeId,
    query: arm.query,
    windowDays: options.windowDays,
    capped,
    ...summariseProbe(scores, arm.threshold),
  };
}

/** Every semantic arm a stored watch carries, or an empty list. */
export function semanticArms(dsl: unknown): ProbeArm[] {
  const nodes = (dsl as { watch?: { nodes?: unknown } } | null)?.watch?.nodes;
  if (!Array.isArray(nodes)) return [];
  const arms: ProbeArm[] = [];
  for (const node of nodes as Record<string, unknown>[]) {
    if (node["type"] !== "source.document_event") continue;
    const semantic = (node["recall"] as { semantic?: { query?: unknown; threshold?: unknown } })
      ?.semantic;
    if (typeof semantic?.query !== "string" || typeof semantic.threshold !== "number") continue;
    const filter = node["filter"] as { source?: unknown; documentType?: unknown } | undefined;
    arms.push({
      nodeId: String(node["id"] ?? ""),
      query: semantic.query,
      threshold: semantic.threshold,
      sources: asArray(filter?.source),
      documentTypes: asArray(filter?.documentType),
    });
  }
  return arms;
}

function asArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}
