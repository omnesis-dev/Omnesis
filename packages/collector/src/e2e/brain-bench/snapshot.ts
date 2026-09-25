// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whole-state snapshots of what a bench run left behind.
 *
 * A snapshot is the regression net for a workflow: drive one stimulus,
 * serialize the cognitive rows the run could have written, and compare
 * against a committed golden. Where an individual assertion pins one fact,
 * a snapshot pins the relationships between all of them at once — so a
 * cascade that silently stops firing, an evidence sidecar that stops being
 * written, or a consumption edge that stops being recorded shows up without
 * anyone having predicted that particular regression.
 *
 * Fields are enumerated rather than spread, so a snapshot is a deliberate
 * projection: a migration that adds a column does not churn every golden,
 * and does not appear in one either until it is named here.
 *
 * Ids are minted per run, so they are renamed to stable ordinals — by
 * entity kind, and in an order the test controls rather than the order
 * SQLite happens to return. Row order within each table is preserved on
 * purpose: an ordering change is exactly the kind of regression a snapshot
 * should catch.
 */

import type Database from "better-sqlite3";

/** Renames minted ids to stable ordinals, so a snapshot is comparable across runs. */
class IdCanonicalizer {
  private readonly seen = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  /**
   * `loop_a1b2` → `loop#1`. Ids with no readable prefix — documents and runs
   * are bare UUIDs — take the `kind` the caller names, so the two do not
   * share one counter: they would otherwise renumber each other, and adding
   * a document to an arc would rewrite every run reference in the golden.
   */
  canon(id: string | null | undefined, kind?: string): string | null {
    if (id === null || id === undefined) return null;
    const existing = this.seen.get(id);
    if (existing) return existing;
    const prefix = /^([a-z]+)_/.exec(id)?.[1] ?? kind ?? "id";
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    const label = `${prefix}#${n}`;
    this.seen.set(id, label);
    return label;
  }

  /** Replace every known id embedded in free text (ledger notes, claim text). */
  scrub(text: string | null | undefined): string | null {
    if (text === null || text === undefined) return null;
    let out = text;
    // Longest id first, so an id that is a PREFIX of another cannot eat it —
    // `seedRun` lets a test choose its own run ids, so `run_a` and `run_ab`
    // are reachable.
    const longestFirst = [...this.seen].sort(([a], [b]) => b.length - a.length);
    for (const [raw, label] of longestFirst) out = out.split(raw).join(label);
    return out;
  }
}

function rebase(ms: number | null | undefined, epoch: number): string | null {
  if (ms === null || ms === undefined) return null;
  const delta = ms - epoch;
  if (Math.abs(delta) < 60_000) return "T+0";
  return `T+${Math.round(delta / 60_000)}m`;
}

export interface BrainSnapshot {
  loops: unknown[];
  retiredLoops: unknown[];
  briefs: unknown[];
  docAnnotations: unknown[];
  personAnnotations: unknown[];
  temporalAnnotations: unknown[];
  consumptionEdges: unknown[];
  notes: string | null;
  runs: unknown[];
}

/**
 * Serialize the cognitive state. `epoch` anchors relative timestamps —
 * pass the instant the bench started so `T+0` means "at boot".
 */
export function snapshotBrainState(db: Database.Database, epoch: number): BrainSnapshot {
  const c = new IdCanonicalizer();
  const all = <T>(sql: string, ...params: unknown[]): T[] =>
    db.prepare(sql).all(...(params as never[])) as T[];

  // Canonicalize in a stable read order first, so ordinals do not depend on
  // which table happened to be read first.
  type IdRow = { id: string };
  for (const r of all<IdRow>("SELECT id FROM open_loops ORDER BY created_at, id")) c.canon(r.id);
  for (const r of all<IdRow>("SELECT id FROM briefs ORDER BY created_at, id")) c.canon(r.id);
  for (const r of all<IdRow>("SELECT id FROM doc_annotations ORDER BY created_at, id"))
    c.canon(r.id);
  for (const r of all<IdRow>("SELECT id FROM person_annotations ORDER BY created_at, id"))
    c.canon(r.id);
  for (const r of all<IdRow>("SELECT id FROM temporal_annotations ORDER BY created_at, id"))
    c.canon(r.id);
  // Document ids are random UUIDs, so ordering by them assigns ordinals by
  // coin flip and a snapshot differs from itself. Order by what the AUTHOR
  // controls instead: the source, then the external id — scrubbed, because a
  // loop's mirror document carries the loop id as its external id, and loops
  // were canonicalized above.
  const docs = all<{ id: string; source_id: string; external_id: string }>(
    "SELECT id, source_id, external_id FROM documents",
  )
    .map((r) => ({ ...r, sortKey: `${r.source_id}\u0000${c.scrub(r.external_id) ?? ""}` }))
    .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  for (const r of docs) c.canon(r.id, "doc");
  for (const r of all<IdRow>("SELECT id FROM cognition_runs ORDER BY enqueued_at, id"))
    c.canon(r.id, "run");

  interface LoopRow {
    id: string;
    created_by_run: string;
    state: string;
    confidence: number;
    importance: number;
    title: string;
    description: string;
    deadline_json: string | null;
    created_at: number;
    last_update: number;
    decay_check_count: number;
  }
  const loops = all<LoopRow>("SELECT * FROM open_loops ORDER BY created_at, id").map((l) => ({
    id: c.canon(l.id),
    createdByRun: c.canon(l.created_by_run),
    state: l.state,
    confidence: l.confidence,
    importance: l.importance,
    title: c.scrub(l.title),
    description: c.scrub(l.description),
    deadline: l.deadline_json ? JSON.parse(l.deadline_json) : null,
    decayCheckCount: l.decay_check_count,
    createdAt: rebase(l.created_at, epoch),
    docs: all<{ doc_id: string }>(
      "SELECT doc_id FROM open_loop_docs WHERE loop_id = ? ORDER BY doc_id",
      l.id,
    ).map((d) => c.canon(d.doc_id)),
    people: all<{ person_id: string; role: string }>(
      "SELECT person_id, role FROM open_loop_people WHERE loop_id = ? ORDER BY role, person_id",
      l.id,
    ).map((p) => ({ role: p.role, person: c.canon(p.person_id) })),
    ledger: all<{ run_id: string; note: string }>(
      "SELECT run_id, note FROM open_loop_ledger WHERE loop_id = ? ORDER BY seq",
      l.id,
    ).map((e) => ({ runId: c.canon(e.run_id), note: c.scrub(e.note) })),
  }));

  interface BriefRow {
    id: string;
    created_by_run: string;
    kind: string;
    title: string;
    description: string;
    body: string | null;
    confidence: number;
    urgency: number;
    state: string;
    created_at: number;
    next_show: number | null;
    event_at: number | null;
    user_feedback: string | null;
  }
  const briefs = all<BriefRow>("SELECT * FROM briefs ORDER BY created_at, id").map((b) => ({
    id: c.canon(b.id),
    createdByRun: c.canon(b.created_by_run),
    kind: b.kind,
    state: b.state,
    title: c.scrub(b.title),
    description: c.scrub(b.description),
    body: c.scrub(b.body),
    confidence: b.confidence,
    urgency: b.urgency,
    userFeedback: b.user_feedback,
    nextShowSet: b.next_show !== null,
    eventAtSet: b.event_at !== null,
    citations: all<{ doc_id: string }>(
      "SELECT doc_id FROM brief_citations WHERE brief_id = ? ORDER BY position",
      b.id,
    ).map((x) => c.canon(x.doc_id)),
    relatedLoops: all<{ loop_id: string }>(
      "SELECT loop_id FROM brief_related_loops WHERE brief_id = ? ORDER BY loop_id",
      b.id,
    ).map((x) => c.canon(x.loop_id)),
    claims: all<{
      claim_text: string;
      claim_basis: string;
      confidence: number;
      verification_state: string;
      evidence_doc_id: string | null;
      evidence_quote: string | null;
      invalidated_at: number | null;
    }>(
      "SELECT claim_text, claim_basis, confidence, verification_state, evidence_doc_id, evidence_quote, invalidated_at FROM brief_claims WHERE brief_id = ? ORDER BY id",
      b.id,
    ).map((cl) => ({
      claimText: c.scrub(cl.claim_text),
      claimBasis: cl.claim_basis,
      confidence: cl.confidence,
      verificationState: cl.verification_state,
      evidenceDoc: c.canon(cl.evidence_doc_id),
      evidenceQuote: cl.evidence_quote,
      live: cl.invalidated_at === null,
    })),
  }));

  const annotationRows = (table: string, subjectCol: string, evidenceTable: string): unknown[] => {
    interface AnnoRow {
      id: string;
      claim_type: string;
      claim_text: string;
      evidence_doc_id: string | null;
      evidence_quote: string | null;
      confidence: number;
      claim_basis: string;
      created_by_run: string | null;
      invalidated_at: number | null;
      verification_state: string | null;
      superseded_by: string | null;
      [k: string]: unknown;
    }
    return all<AnnoRow>(`SELECT * FROM ${table} ORDER BY created_at, id`).map((a) => ({
      id: c.canon(a.id),
      subject: c.canon(a[subjectCol] as string),
      createdByRun: c.canon(a.created_by_run),
      claimType: a.claim_type,
      claimText: c.scrub(a.claim_text),
      claimBasis: a.claim_basis,
      confidence: a.confidence,
      verificationState: a.verification_state,
      supersededBy: c.canon(a.superseded_by),
      live: a.invalidated_at === null,
      evidence: all<{ evidence_doc_id: string; evidence_quote: string; broken_at: number | null }>(
        `SELECT evidence_doc_id, evidence_quote, broken_at FROM ${evidenceTable} WHERE annotation_id = ? ORDER BY position`,
        a.id,
      ).map((e) => ({
        doc: c.canon(e.evidence_doc_id),
        quote: e.evidence_quote,
        broken: e.broken_at !== null,
      })),
    }));
  };

  interface TemporalRow {
    id: string;
    interval_start_ms: number;
    interval_end_ms: number;
    precision: string;
    canonical: string;
    sentence: string;
    kind: string | null;
    created_by_run: string | null;
    invalidated_at: number | null;
    invalidation_cause: string | null;
    revision: number;
  }
  const temporal = all<TemporalRow>(
    "SELECT * FROM temporal_annotations ORDER BY created_at, id",
  ).map((t) => ({
    id: c.canon(t.id),
    createdByRun: c.canon(t.created_by_run),
    canonical: t.canonical,
    precision: t.precision,
    kind: t.kind,
    sentence: c.scrub(t.sentence),
    revision: t.revision,
    live: t.invalidated_at === null,
    invalidationCause: t.invalidation_cause,
    documents: all<{ document_id: string }>(
      "SELECT document_id FROM temporal_annotation_documents WHERE annotation_id = ? ORDER BY document_id",
      t.id,
    ).map((d) => c.canon(d.document_id)),
    loops: all<{ loop_id: string }>(
      "SELECT loop_id FROM temporal_annotation_loops WHERE annotation_id = ? ORDER BY loop_id",
      t.id,
    ).map((d) => c.canon(d.loop_id)),
  }));

  const consumptionEdges = all<{
    prior_store: string;
    prior_annotation_id: string;
    dependent_kind: string;
    dependent_id: string;
    run_id: string;
  }>(
    "SELECT * FROM cognition_consumption_edges ORDER BY prior_store, prior_annotation_id, dependent_kind, dependent_id",
  ).map((e) => ({
    priorStore: e.prior_store,
    prior: c.canon(e.prior_annotation_id),
    dependentKind: e.dependent_kind,
    dependent: c.canon(e.dependent_id),
    runId: c.canon(e.run_id),
  }));

  const retired = all<{
    title: string;
    outcome: string;
    importance: number;
    cadence_days: number | null;
    recurrence_count: number;
  }>("SELECT * FROM retired_loops ORDER BY retired_at, id").map((r) => ({
    title: c.scrub(r.title),
    outcome: r.outcome,
    importance: r.importance,
    cadenceDays: r.cadence_days,
    recurrenceCount: r.recurrence_count,
  }));

  const runs = all<{ kind: string; status: string; dedupe_key: string | null; attempts: number }>(
    "SELECT kind, status, dedupe_key, attempts FROM cognition_runs ORDER BY enqueued_at, id",
  ).map((r) => ({
    kind: r.kind,
    status: r.status,
    attempts: r.attempts,
    dedupeKey: c.scrub(r.dedupe_key),
  }));

  const notes = (
    db.prepare("SELECT content FROM cognition_notes WHERE id = 1").get() as
      | { content: string }
      | undefined
  )?.content;

  return {
    loops,
    retiredLoops: retired,
    briefs,
    docAnnotations: annotationRows("doc_annotations", "doc_id", "doc_annotation_evidence"),
    personAnnotations: annotationRows(
      "person_annotations",
      "person_id",
      "person_annotation_evidence",
    ),
    temporalAnnotations: temporal,
    consumptionEdges,
    notes: c.scrub(notes ?? null),
    runs,
  };
}
