// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain Bench area F — the time index.
 *
 * Everything here is written by the Cognition Steward through its OWN tools
 * (`temporal_annotation_add` / `_update` / `_delete`) on a real spawned
 * gateway, and read back through the three shipped read surfaces:
 * `/admin/brain/time-index`, `/briefs/time-index/window` and the unified
 * `/briefs/temporal/window`. The sibling suites `temporal-substrate` and
 * `temporal-calendar` cover the window routes over rows seeded directly into
 * SQLite; this file covers what happens when the STEWARD is the author —
 * precision resolution, revisions, the two invalidation paths, the write
 * gates and the reconcile refusal.
 *
 * Every date is in 2027 (and one in 2029) so nothing here can meet the
 * ambient universe, whose fixtures are all dated in 2026.
 *
 * One gateway boot drives the whole first describe, which makes its tests
 * ORDER-DEPENDENT by construction: the first test pushes every document and
 * fills the shared `docIds` map every later test reads, so none of them can
 * run on its own under a `-t` filter. The two closing tests run last because
 * they remove a document and the privacy cascade is destructive.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  fileTemporal,
  ref,
} from "./brain-bench/index.js";
import type { ExecutedTool, PuppetBehavior } from "./brain-bench/index.js";

compressCognitionCadences();

// ── the shapes the routes actually serve ────────────────────────────────────
//
// `BrainObs.TemporalAnnotationDto` describes `/briefs/time-index/window`
// (the display-ready serializer: `granularity`, ISO timestamps). The ADMIN
// list route serves the storage row instead — `precision`, unix-ms
// timestamps, plus `revision` and the link sets — so it needs its own type.

interface AdminTemporalItem {
  id: string;
  intervalStartMs: number;
  intervalEndMs: number;
  precision: string;
  canonical: string | null;
  sentence: string;
  kind: string | null;
  createdByRun: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  loopIds: string[];
  personIds: string[];
  projectionIds: string[];
  documents: Array<{ id: string; title: string | null; sourceType: string | null }>;
}

interface TemporalWindowItem {
  id: string;
  origin: "projection" | "annotation";
  start: string;
  endExclusive: string;
  precision: string;
  label: string;
  kind: string;
  annotation?: { documentIds: string[]; loopIds: string[]; revision: number };
  projection?: { sourceId: string; documentId?: string };
}

/**
 * The `temporal_annotation_add` calls the document's data run made, in call
 * order, paired with what the gateway answered. The refusals and the minted
 * ids live only in the transcript's event stream, which is what
 * `obs.executedTools` reconstructs.
 */
async function addResults(bench: BrainBench, docId: string): Promise<ExecutedTool[]> {
  const run = await bench.obs.runForDoc(docId);
  const steps = await bench.obs.executedTools(run.id);
  return steps.filter((s) => s.tool === "temporal_annotation_add");
}

// ── the corpus: one document per behaviour under test ───────────────────────

const PRECISION_DOC = email({
  externalId: "brain-tix-precision",
  title: "Dated commitments for the Northstar residency",
  content:
    "Hi Alex,\n\nHere are the dated commitments for the residency: the studio block, " +
    "the review day, the kickoff call and the coast week.\n\nStudio Northstar",
});

const UPDATE_DOC = email({
  externalId: "brain-tix-update",
  title: "Quarterly inventory review scheduling",
  content:
    "Hi Alex,\n\nThe quarterly inventory review is pencilled in for late November. " +
    "We will confirm the room nearer the time.\n\nCedar Grove Supplies",
});

const DELETE_DOC = email({
  externalId: "brain-tix-delete",
  title: "Winter closure dates",
  content:
    "Hi Alex,\n\nThe workshop closes for the winter break in early December. " +
    "Nothing is required from you.\n\nCedar Grove Supplies",
});

const EVIDENCE_DOC = email({
  externalId: "brain-tix-evidence",
  title: "Equipment audit booking",
  content:
    "Hi Alex,\n\nThe residency office confirms that the equipment audit is booked for " +
    "the fifteenth of June 2027 at the Northstar annexe. Please bring the inventory " +
    "sheet with you.\n\nStudio Northstar",
});
const EVIDENCE_QUOTE = "the equipment audit is booked for the fifteenth of June 2027";

const OVERLAP_DOC = email({
  externalId: "brain-tix-overlap",
  title: "Two things on the same April day",
  content:
    "Hi Alex,\n\nThe access handover and the fire drill both fall on the tenth of " +
    "April 2027. They are unrelated.\n\nRiverside Estate",
});

const LOOP_DOC = email({
  externalId: "brain-tix-loop",
  title: "Annexe handover paperwork",
  content:
    "Hi Alex,\n\nThe annexe handover paperwork is due back in early October 2027. " +
    "Please countersign both copies. The handover appointment is on 3 October 2027.\n\nRiverside Estate",
});

const CASCADE_DOC = email({
  externalId: "brain-tix-cascade",
  title: "Site visit confirmation",
  content:
    "Hi Alex,\n\nYour site visit is confirmed for the eleventh of August 2027. " +
    "Access is from the north gate.\n\nRiverside Estate",
});

const BEHAVIORS: PuppetBehavior[] = [
  {
    flavour: "data.created",
    docTitle: PRECISION_DOC.title,
    plan: (ctx) => ({
      calls: [
        // One per precision the store can resolve. The intervals are
        // deliberately disjoint so no add meets another's reconcile probe.
        fileTemporal({
          when: "2029",
          sentence: "TIX-YEAR the residency programme runs across this year.",
          kind: "episode",
        }),
        fileTemporal({
          when: "2027-05",
          sentence: "TIX-MONTH the studio block is held for the whole month.",
          kind: "event",
        }),
        fileTemporal({
          when: "2027-03-14",
          sentence: "TIX-DAY review day at the studio.",
          kind: "appointment",
          documentIds: [ctx.subject!],
          evidence: { docId: ctx.subject!, quote: "the review day" },
        }),
        fileTemporal({
          when: "2027-07-09T14:30:00.000Z",
          sentence: "TIX-INSTANT kickoff call with the residency office.",
          kind: "reminder",
        }),
        fileTemporal({
          when: "2027-09-02",
          until: "2027-09-06",
          sentence: "TIX-RANGE coast week away.",
          kind: "visit",
        }),
      ],
      finalText: "Filed the residency's dated commitments.",
    }),
  },
  {
    flavour: "data.created",
    docTitle: UPDATE_DOC.title,
    plan: (ctx) => ({
      calls: [
        call("temporal_annotation_add", {
          when: "2027-11-20",
          sentence: "TIX-UPDATE quarterly inventory review.",
          kind: "event",
        }),
        // Attaching the datum as a source re-grounds the entry: an update
        // that adds document links to an ungrounded entry must carry
        // evidence, the same contract the add tool enforces.
        call("temporal_annotation_update", {
          annotationId: ref("temporal_annotation_add", "id"),
          sentence: "TIX-UPDATE quarterly inventory review, in the annexe.",
          kind: "appointment",
          documentIds: [ctx.subject!],
          evidence: {
            docId: ctx.subject!,
            quote: "quarterly inventory review is pencilled in for late November",
          },
        }),
      ],
    }),
  },
  {
    flavour: "data.created",
    docTitle: DELETE_DOC.title,
    plan: (ctx) => ({
      calls: [
        call("temporal_annotation_add", {
          when: "2027-12-05",
          sentence: "TIX-DELETE winter closure begins.",
          kind: "event",
          documentIds: [ctx.subject!],
          evidence: { docId: ctx.subject!, quote: "closes for the winter break in early December" },
        }),
        call("temporal_annotation_delete", {
          annotationId: ref("temporal_annotation_add", "id"),
        }),
      ],
    }),
  },
  {
    flavour: "data.created",
    docTitle: EVIDENCE_DOC.title,
    plan: (ctx) => ({
      calls: [
        // Grounded: the quote is verbatim, so both teeth pass.
        call("temporal_annotation_add", {
          when: "2027-06-15",
          sentence: "TIX-EVIDENCE equipment audit at the Northstar annexe.",
          kind: "deadline",
          evidence: { docId: ctx.subject!, quote: EVIDENCE_QUOTE },
        }),
        // Ungrounded: a quote that is not in the document at all.
        call("temporal_annotation_add", {
          when: "2027-06-22",
          sentence: "TIX-NOQUOTE second audit slot.",
          kind: "deadline",
          evidence: {
            docId: ctx.subject!,
            quote: "a sentence that this document never contains at all",
          },
        }),
      ],
    }),
  },
  {
    flavour: "data.created",
    docTitle: OVERLAP_DOC.title,
    plan: () => ({
      calls: [
        call("temporal_annotation_add", {
          when: "2027-04-10",
          sentence: "TIX-OVERLAP-A access handover at the estate.",
          kind: "event",
        }),
        // Same day, no force: the reconcile contract must refuse and hand
        // back the candidate rather than minting a near-duplicate.
        call("temporal_annotation_add", {
          when: "2027-04-10",
          sentence: "TIX-OVERLAP-B fire drill at the estate.",
          kind: "event",
        }),
        // Same day, forced: a genuinely distinct event does land.
        call("temporal_annotation_add", {
          when: "2027-04-10",
          sentence: "TIX-OVERLAP-C fire drill at the estate.",
          kind: "event",
          force: true,
        }),
      ],
    }),
  },
  {
    flavour: "data.created",
    docTitle: LOOP_DOC.title,
    plan: (ctx) => ({
      calls: [
        call("open_loop_create", {
          title: "Countersign the TIX-LOOP annexe handover",
          description: "Both copies are due back.",
          deadline: { type: "by", date: "2027-10-03" },
          confidence: 0.9,
          importance: 0.7,
          docs: [ctx.subject!],
        }),
        call("temporal_annotation_add", {
          when: "2027-10-03",
          sentence: "TIX-DUPLICATE annexe handover paperwork is due.",
          kind: "deadline",
          documentIds: [ctx.subject!],
          loopIds: [ref("open_loop_create", "loop.id")],
          evidence: {
            docId: ctx.subject!,
            quote: "handover paperwork is due back in early October 2027",
          },
        }),
        // A separate event at the same time remains valid without force.
        call("temporal_annotation_add", {
          when: "2027-10-03",
          sentence: "TIX-LOOP annexe handover appointment.",
          kind: "event",
          documentIds: [ctx.subject!],
          evidence: {
            docId: ctx.subject!,
            quote: "The handover appointment is on 3 October 2027.",
          },
          loopIds: [ref("open_loop_create", "loop.id")],
        }),
        // The loop→time backlink is exposed on the steward's own read tool.
        call("open_loop_fetch", { id: ref("open_loop_create", "loop.id") }),
      ],
    }),
  },
  {
    flavour: "data.created",
    docTitle: CASCADE_DOC.title,
    plan: (ctx) => ({
      calls: [
        call("temporal_annotation_add", {
          when: "2027-08-11",
          sentence: "TIX-CASCADE site visit at the north gate.",
          kind: "visit",
          documentIds: [ctx.subject!],
          evidence: {
            docId: ctx.subject!,
            quote: "site visit is confirmed for the eleventh of August 2027",
          },
        }),
      ],
    }),
  },
];

describe("Brain Bench — steward-written temporal annotations", () => {
  let bench: BrainBench;
  const docIds = new Map<string, string>();

  // Written by the cascade test, read by the one-assertion `.fails` that
  // follows it: how many `temporal_annotations` rows outlived the removal of
  // the document they cited, and a description of the state around that count.

  const items = async (marker: string): Promise<AdminTemporalItem[]> => {
    // The admin list serves the storage row; see AdminTemporalItem above.
    const page = (await bench.obs.timeIndex({ limit: 500 })) as unknown as {
      items: AdminTemporalItem[];
    };
    return page.items.filter((i) => i.sentence.includes(marker));
  };
  const one = async (marker: string): Promise<AdminTemporalItem> => {
    const found = await items(marker);
    expect(found, `expected exactly one ${marker} annotation`).toHaveLength(1);
    return found[0]!;
  };

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      // Assigned, and permissive: the entailment gate's PASS arm is then a
      // real verdict rather than an unassigned gate failing open, so the
      // grounded write below proves the gate ran and let it through.
      entailment: "accept-all",
      behaviors: { behaviors: BEHAVIORS },
    });
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("every scripted temporal plan ran to completion", async () => {
    const docs = [
      PRECISION_DOC,
      UPDATE_DOC,
      DELETE_DOC,
      EVIDENCE_DOC,
      OVERLAP_DOC,
      LOOP_DOC,
      CASCADE_DOC,
    ];
    const ids = await bench.pushAndSettle(docs);
    docs.forEach((doc, i) => docIds.set(doc.externalId, ids[i]!));

    const runs = await bench.obs.settledRuns("data");
    expect(runs).toHaveLength(docs.length);
    expect(runs.every((r) => r.status === "completed")).toBe(true);
  }, 180_000);

  test("a scripted add writes a row per precision, linked and readable", async () => {
    const year = await one("TIX-YEAR");
    expect(year.precision).toBe("year");
    expect(year.canonical).toBe("2029");
    expect(year.kind).toBe("episode");
    expect(year.intervalStartMs).toBe(Date.UTC(2029, 0, 1));
    expect(year.intervalEndMs).toBe(Date.UTC(2030, 0, 1) - 1);
    expect(year.revision).toBe(1);

    const month = await one("TIX-MONTH");
    expect(month.precision).toBe("month");
    expect(month.canonical).toBe("2027-05");
    expect(month.intervalStartMs).toBe(Date.UTC(2027, 4, 1));
    expect(month.intervalEndMs).toBe(Date.UTC(2027, 5, 1) - 1);

    const day = await one("TIX-DAY");
    expect(day.precision).toBe("day");
    expect(day.canonical).toBe("2027-03-14");
    expect(day.kind).toBe("appointment");
    expect(day.intervalStartMs).toBe(Date.UTC(2027, 2, 14));
    expect(day.intervalEndMs).toBe(Date.UTC(2027, 2, 15) - 1);
    // `documentIds` really linked the triggering document.
    expect(day.documents.map((d) => d.id)).toEqual([docIds.get(PRECISION_DOC.externalId)]);
    expect(day.documents[0]!.title).toBe(PRECISION_DOC.title);

    const instant = await one("TIX-INSTANT");
    expect(instant.precision).toBe("instant");
    expect(instant.canonical).toBe("2027-07-09T14:30:00.000Z");
    expect(instant.intervalStartMs).toBe(Date.parse("2027-07-09T14:30:00.000Z"));
    expect(instant.intervalEndMs).toBe(instant.intervalStartMs);

    const range = await one("TIX-RANGE");
    expect(range.precision).toBe("range");
    expect(range.canonical).toBe("2027-09-02 .. 2027-09-06");
    expect(range.kind).toBe("visit");
    expect(range.intervalStartMs).toBe(Date.UTC(2027, 8, 2));
    expect(range.intervalEndMs).toBe(Date.UTC(2027, 8, 7) - 1);

    // Each row is attributed to the run that wrote it.
    const run = await bench.obs.runForDoc(docIds.get(PRECISION_DOC.externalId)!);
    for (const row of [year, month, day, instant, range]) expect(row.createdByRun).toBe(run.id);
  }, 60_000);

  test("update rewrites the entry and bumps its revision", async () => {
    const updated = await one("TIX-UPDATE");
    expect(updated.sentence).toContain("in the annexe");
    expect(updated.kind).toBe("appointment");
    expect(updated.revision).toBe(2);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(updated.createdAt);
    expect(updated.documents.map((d) => d.id)).toEqual([docIds.get(UPDATE_DOC.externalId)]);
    // The interval was not touched by a sentence/kind/links edit.
    expect(updated.intervalStartMs).toBe(Date.UTC(2027, 10, 20));
    expect(updated.precision).toBe("day");
  }, 60_000);

  test("delete soft-invalidates: gone from every read, kept for audit", async () => {
    expect(await items("TIX-DELETE")).toHaveLength(0);

    const from = Date.UTC(2027, 11, 1);
    const to = Date.UTC(2027, 11, 31);
    const legacy = await bench.obs.timeIndexWindow({ from, to });
    expect(legacy.entries.some((e) => e.sentence.includes("TIX-DELETE"))).toBe(false);
    const unified = (await bench.obs.temporalWindow({ from, to, timeZone: "UTC" })) as {
      items: TemporalWindowItem[];
    };
    expect(unified.items.some((i) => i.label.includes("TIX-DELETE"))).toBe(false);

    // The row survives with the deliberate-removal cause — the contract that
    // separates a curated-away entry (never resurrected, never re-filed) from
    // a churn casualty.
    const [add] = await addResults(bench, docIds.get(DELETE_DOC.externalId)!);
    const annotationId = add?.result?.data?.id as string;
    expect(annotationId).toBeTruthy();
    const row = bench.sql
      .prepare<
        [string],
        { invalidated_at: number | null; invalidation_cause: string | null; revision: number }
      >("SELECT invalidated_at, invalidation_cause, revision FROM temporal_annotations WHERE id = ?")
      .get(annotationId);
    expect(row).toBeDefined();
    expect(row!.invalidated_at).not.toBeNull();
    expect(row!.invalidation_cause).toBe("deleted");
    expect(row!.revision).toBe(2);

    // A soft delete keeps the link rows; only a purge drops them.
    const links = bench.sql
      .prepare<
        [string],
        { n: number }
      >("SELECT COUNT(*) AS n FROM temporal_annotation_documents WHERE annotation_id = ?")
      .get(annotationId);
    expect(links!.n).toBe(1);
  }, 60_000);

  test("declared evidence passes both teeth and is persisted as the grounding atom", async () => {
    const grounded = await one("TIX-EVIDENCE");
    // The evidence document is unioned into the entry's sources even though
    // `documentIds` was never passed.
    expect(grounded.documents.map((d) => d.id)).toEqual([docIds.get(EVIDENCE_DOC.externalId)]);

    const atoms = bench.sql
      .prepare<
        [string],
        { position: number; document_id: string; quote: string; broken_at: number | null }
      >("SELECT position, document_id, quote, broken_at FROM temporal_annotation_evidence WHERE annotation_id = ? ORDER BY position")
      .all(grounded.id);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]!.quote).toBe(EVIDENCE_QUOTE);
    expect(atoms[0]!.document_id).toBe(docIds.get(EVIDENCE_DOC.externalId));
    expect(atoms[0]!.broken_at).toBeNull();

    // The gate really was consulted — an unassigned verifier would leave this
    // empty and make the assertion above vacuous.
    const asked = bench.entailmentCalls.filter((c) => c.claim?.includes("TIX-EVIDENCE"));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0]!.evidence).toContain("equipment audit is booked");
  }, 60_000);

  test("a quote that is not in the document is refused before the verifier is asked", async () => {
    expect(await items("TIX-NOQUOTE")).toHaveLength(0);

    const adds = await addResults(bench, docIds.get(EVIDENCE_DOC.externalId)!);
    expect(adds).toHaveLength(2);
    expect(adds[1]!.result?.kind).toBe("error");
    expect(adds[1]!.result?.code).toBe("evidence_not_found");
    // Cheap checks first: the verifier was never asked about this sentence.
    expect(bench.entailmentCalls.some((c) => c.claim?.includes("TIX-NOQUOTE"))).toBe(false);
  }, 60_000);

  test("an overlapping add is refused with candidates, and force overrides it", async () => {
    const adds = await addResults(bench, docIds.get(OVERLAP_DOC.externalId)!);
    expect(adds).toHaveLength(3);

    expect(adds[0]!.result?.resultType).toBe("temporal_annotation.added");

    // A refusal, not an error: the steward is handed what it collided with.
    const refusal = adds[1]!.result;
    expect(refusal?.kind).toBe("structured");
    expect(refusal?.resultType).toBe("temporal_annotation.overlap_candidates");
    const candidates = refusal?.data?.candidates as Array<{ id: string; label: string }>;
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((c) => c.label.includes("TIX-OVERLAP-A"))).toBe(true);
    expect(refusal?.data?.when).toBe("2027-04-10");

    expect(adds[2]!.result?.resultType).toBe("temporal_annotation.added");

    // A and C landed; B wrote nothing.
    expect(await items("TIX-OVERLAP-A")).toHaveLength(1);
    expect(await items("TIX-OVERLAP-B")).toHaveLength(0);
    expect(await items("TIX-OVERLAP-C")).toHaveLength(1);
  }, 60_000);

  test("loopIds backlink the entry to a loop minted in the same run", async () => {
    const adds = await addResults(bench, docIds.get(LOOP_DOC.externalId)!);
    expect(adds[0]?.result?.resultType).toBe("temporal_annotation.overlap_candidates");
    expect(adds[1]?.result?.resultType).toBe("temporal_annotation.added");
    expect(await items("TIX-DUPLICATE")).toHaveLength(0);
    const entry = await one("TIX-LOOP");
    const loops = await bench.obs.loopsMatching("TIX-LOOP");
    expect(loops).toHaveLength(1);
    const loopId = loops[0]!.id;

    expect(entry.loopIds).toEqual([loopId]);
    const join = bench.sql
      .prepare<
        [string, string],
        { n: number }
      >("SELECT COUNT(*) AS n FROM temporal_annotation_loops WHERE annotation_id = ? AND loop_id = ?")
      .get(entry.id, loopId);
    expect(join!.n).toBe(1);

    // The reverse direction the steward reads: the loop carries its dates.
    const run = await bench.obs.runForDoc(docIds.get(LOOP_DOC.externalId)!);
    const steps = await bench.obs.executedTools(run.id);
    const fetched = steps.find((s) => s.tool === "open_loop_fetch");
    const temporal = fetched?.result?.data?.temporalAnnotations as Array<{
      id: string;
      sentence: string;
    }>;
    expect(temporal.map((t) => t.id)).toContain(entry.id);
  }, 60_000);

  test("the unified window federates steward annotations with source projections", async () => {
    // 2026-04 → 2027-04: the ambient calendar's two events sit at the start,
    // the steward's day-precision entry at the end. Under the route's
    // 400-day span cap, this is the widest read that spans both producers.
    const from = Date.UTC(2026, 3, 1);
    const to = Date.UTC(2027, 3, 1);
    const page = (await bench.obs.temporalWindow({ from, to, timeZone: "UTC", limit: 100 })) as {
      items: TemporalWindowItem[];
      truncated: boolean;
      coverage: { projectionSources: unknown[]; annotations: { selective: true } };
    };
    expect(page.truncated).toBe(false);

    const projections = page.items.filter((i) => i.origin === "projection");
    const annotations = page.items.filter((i) => i.origin === "annotation");
    expect(projections.length).toBeGreaterThan(0);
    expect(annotations.length).toBeGreaterThan(0);

    const mine = annotations.find((i) => i.label.includes("TIX-DAY"));
    expect(mine).toBeDefined();
    expect(mine!.kind).toBe("appointment");
    expect(mine!.start).toBe(new Date(Date.UTC(2027, 2, 14)).toISOString());
    expect(mine!.endExclusive).toBe(new Date(Date.UTC(2027, 2, 15)).toISOString());
    expect(mine!.annotation?.documentIds).toEqual([docIds.get(PRECISION_DOC.externalId)]);
    expect(mine!.annotation?.revision).toBe(1);

    // Both producers are accounted for in the same coverage block.
    expect(page.coverage.projectionSources.length).toBeGreaterThan(0);
    expect(page.coverage.annotations).toEqual({ selective: true });
  }, 60_000);

  test("the kinds facet narrows the window, and timeZone is required", async () => {
    const from = Date.UTC(2027, 2, 1);
    const to = Date.UTC(2027, 11, 31);
    const visits = (await bench.obs.temporalWindow({
      from,
      to,
      timeZone: "UTC",
      kinds: "visit",
      limit: 100,
    })) as { items: TemporalWindowItem[] };
    expect(visits.items.every((i) => i.kind === "visit")).toBe(true);
    // Chronological: the August visit precedes the September week. Scoped to
    // this file's own markers, so an ambient `visit` fixture appearing in the
    // window later cannot redden the ordering assertion.
    expect(visits.items.map((i) => i.label).filter((l) => l.startsWith("TIX-"))).toEqual([
      "TIX-CASCADE site visit at the north gate.",
      "TIX-RANGE coast week away.",
    ]);

    const deadlines = (await bench.obs.temporalWindow({
      from,
      to,
      timeZone: "UTC",
      kinds: "deadline",
      limit: 100,
    })) as { items: TemporalWindowItem[] };
    expect(deadlines.items.every((i) => i.kind === "deadline")).toBe(true);
    expect(deadlines.items.some((i) => i.label.includes("TIX-EVIDENCE"))).toBe(true);
    expect(deadlines.items.some((i) => i.label.includes("TIX-LOOP"))).toBe(false);
    expect(deadlines.items.some((i) => i.label.includes("TIX-RANGE"))).toBe(false);

    // The unified read is timezone-aware by contract: it refuses to guess.
    expect(await bench.obs.statusOf(`/briefs/temporal/window?from=${from}&to=${to}`)).toBe(400);
    // The legacy annotation-only read is deliberately timezone-ignorant.
    expect(await bench.obs.statusOf(`/briefs/time-index/window?from=${from}&to=${to}`)).toBe(200);
  }, 60_000);

  test("the stored precision survives every read surface", async () => {
    const cases = [
      {
        marker: "TIX-YEAR",
        precision: "year",
        from: Date.UTC(2029, 0, 1),
        to: Date.UTC(2029, 11, 30),
      },
      {
        marker: "TIX-MONTH",
        precision: "month",
        from: Date.UTC(2027, 4, 1),
        to: Date.UTC(2027, 5, 1),
      },
      {
        marker: "TIX-DAY",
        precision: "day",
        from: Date.UTC(2027, 2, 14),
        to: Date.UTC(2027, 2, 16),
      },
      {
        marker: "TIX-INSTANT",
        precision: "instant",
        from: Date.UTC(2027, 6, 9),
        to: Date.UTC(2027, 6, 11),
      },
      {
        marker: "TIX-RANGE",
        precision: "range",
        from: Date.UTC(2027, 8, 1),
        to: Date.UTC(2027, 8, 8),
      },
    ];

    for (const c of cases) {
      const admin = await one(c.marker);
      // Storage/admin spelling.
      expect(admin.precision, `${c.marker} admin precision`).toBe(c.precision);

      // Legacy display serializer renames it to `granularity` on the wire.
      const legacy = await bench.obs.timeIndexWindow({ from: c.from, to: c.to, limit: 500 });
      const entry = legacy.entries.find((e) => e.sentence.includes(c.marker));
      expect(entry, `${c.marker} in the legacy window`).toBeDefined();
      expect(entry!.granularity, `${c.marker} granularity`).toBe(c.precision);
      expect(entry!.id).toBe(admin.id);
      expect(entry!.canonical).toBe(admin.canonical);

      // Unified read keeps the internal spelling.
      const unified = (await bench.obs.temporalWindow({
        from: c.from,
        to: c.to,
        timeZone: "UTC",
        limit: 100,
      })) as { items: TemporalWindowItem[] };
      const item = unified.items.find((i) => i.label.includes(c.marker));
      expect(item, `${c.marker} in the unified window`).toBeDefined();
      expect(item!.precision, `${c.marker} unified precision`).toBe(c.precision);
      expect(item!.id).toBe(admin.id);
    }
  }, 120_000);

  // ── the privacy cascade ────────────────────────────────────────────────

  // Runs last: it removes a document, and the cascade is destructive.
  test("removing a cited document hard-purges the annotation it grounded", async () => {
    const entry = await one("TIX-CASCADE");
    const docId = docIds.get(CASCADE_DOC.externalId)!;
    expect(entry.documents.map((d) => d.id)).toEqual([docId]);

    await bench.deleteDoc(docId);
    await bench.drainUntilQuiet();

    // The removal itself really happened — everything downstream is only
    // meaningful because the document row is gone.
    const docRow = bench.sql
      .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM documents WHERE id = ?")
      .get(docId);
    expect(docRow!.n, "the document itself must be gone").toBe(0);

    // The privacy cascade is a HARD delete, not the soft invalidation the
    // deliberate `temporal_annotation_delete` path performs: an annotation's
    // sentence can embed content derived from the removed document, so no
    // row is kept for audit. The purge selects its victims from
    // `temporal_annotation_documents` AFTER the document rows are gone —
    // which is why that table's `document_id` deliberately carries no FK
    // (the doc-link convention): links must outlive the document so the
    // purge has something to key on, and they die with their annotation.
    const surviving = bench.sql
      .prepare<
        [string],
        { n: number }
      >("SELECT COUNT(*) AS n FROM temporal_annotations WHERE id = ?")
      .get(entry.id);
    expect(surviving!.n, "the annotation must be hard-purged, not left live").toBe(0);
    const links = bench.sql
      .prepare<
        [string],
        { n: number }
      >("SELECT COUNT(*) AS n FROM temporal_annotation_documents WHERE annotation_id = ?")
      .get(entry.id);
    expect(links!.n).toBe(0);
    expect(await items("TIX-CASCADE")).toHaveLength(0);

    // A document's removal touches nothing but its own dependents.
    expect(await items("TIX-DAY")).toHaveLength(1);
    expect(await items("TIX-LOOP")).toHaveLength(1);
  }, 120_000);
});

const REJECT_DOC = email({
  externalId: "brain-tix-reject",
  title: "Renewal notice for the annexe licence",
  content:
    "Hi Alex,\n\nThe annexe licence renewal window opens in February 2027. " +
    "We will write again with the paperwork.\n\nRiverside Estate",
});
const REJECT_QUOTE = "The annexe licence renewal window opens in February 2027";

describe("Brain Bench — the entailment gate's reject arm on a temporal write", () => {
  let bench: BrainBench;

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      entailment: "reject-all",
      behaviors: {
        behaviors: [
          {
            flavour: "data.created",
            docTitle: REJECT_DOC.title,
            plan: (ctx) => ({
              calls: [
                call("temporal_annotation_add", {
                  when: "2027-02-01",
                  sentence: "TIX-REJECT annexe licence renewal window opens.",
                  kind: "deadline",
                  evidence: { docId: ctx.subject!, quote: REJECT_QUOTE },
                }),
              ],
            }),
          },
        ],
      },
    });
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("a verifier that will not entail the sentence blocks the write", async () => {
    const [docId] = await bench.pushAndSettle([REJECT_DOC]);

    const adds = await addResults(bench, docId!);
    expect(adds).toHaveLength(1);
    expect(adds[0]!.result?.kind).toBe("error");
    expect(adds[0]!.result?.code).toBe("evidence_does_not_entail_claim");

    // Nothing persisted — not even an invalidated row.
    const page = (await bench.obs.timeIndex({ limit: 500 })) as unknown as {
      items: AdminTemporalItem[];
    };
    expect(page.items.some((i) => i.sentence.includes("TIX-REJECT"))).toBe(false);
    const rows = bench.sql
      .prepare<
        [],
        { n: number }
      >("SELECT COUNT(*) AS n FROM temporal_annotations WHERE sentence LIKE 'TIX-REJECT%'")
      .get();
    expect(rows!.n).toBe(0);

    // The verdict really came from the verifier.
    const asked = bench.entailmentCalls.filter((c) => c.claim?.includes("TIX-REJECT"));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0]!.answer).toBe("NEUTRAL");
  }, 180_000);
});

// ── supporting-evidence links and content-change invalidation ──────────────
//
// An entry may cite several documents, but only its evidence atoms decide
// survival: the basis is whatever the grounding quote lives in, and every
// other linked document is merely supporting context. Editing a supporting
// document must leave the entry alive — the invalidator judges atoms, and an
// atom-less entry is likewise kept on content change (a linked doc is not
// necessarily its basis; see the storage unit tests for that arm). This
// suite drives the grounded case through the real cascade: an entry
// evidence-grounded in its basis and additionally linked to a planning
// note survives an edit to the note.

const BASIS_DOC = email({
  externalId: "brain-tix-basis",
  title: "Ferry crossing confirmation QF-2214",
  content:
    "Hi Alex,\n\nYour ferry crossing is confirmed for the ninth of July 2027 at 08:30. " +
    "Reference QF-2214. Arrive forty minutes before departure.\n\nRiverside Estate travel desk",
});

const SUPPORTING_DOC = email({
  externalId: "brain-tix-supporting",
  title: "July crossing planning notes",
  content:
    "Hi Alex,\n\nNotes for the July crossing: pack the walking gear, book the car space, " +
    "and check the tide tables the day before.\n\nAlex",
});
const BASIS_QUOTE = "confirmed for the ninth of July 2027 at 08:30";

const SUPPORTING_DOC_V2 =
  "Hi Alex,\n\nNotes for the July crossing: pack the walking gear, book the car space, " +
  "check the tide tables the day before, and print the boarding reference.\n\nAlex";

describe("Brain Bench — a supporting document's edit and the entries it touches", () => {
  let bench: BrainBench;
  let supportingDocId = "";

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      behaviors: {
        behaviors: [
          // The planning notes themselves warrant nothing.
          {
            flavour: "data.created",
            docTitle: SUPPORTING_DOC.title,
            plan: { calls: [], finalText: "Planning notes; nothing to record." },
          },
          {
            flavour: "data.updated",
            docTitle: SUPPORTING_DOC.title,
            plan: { calls: [], finalText: "Planning notes changed; nothing to record." },
          },
          // The confirmation files the crossing, grounded by a quote from the
          // confirmation itself (the BASIS) and additionally linked to the
          // planning notes as supporting context — the enrichment shape.
          {
            flavour: "data.created",
            docTitle: BASIS_DOC.title,
            plan: (ctx) => ({
              calls: [
                fileTemporal({
                  when: "2027-07-09",
                  sentence: "TIX-FERRY the ferry crossing departs at 08:30 (ref QF-2214).",
                  kind: "appointment",
                  documentIds: [ctx.subject, supportingDocId],
                  evidence: { docId: ctx.subject, quote: BASIS_QUOTE },
                }),
              ],
              finalText: "Filed the crossing.",
            }),
          },
        ],
      },
    });

    await bench.pushAndSettle([SUPPORTING_DOC]);
    supportingDocId = await bench.docId(SUPPORTING_DOC.externalId);
    expect(supportingDocId).not.toBe("");
    await bench.pushAndSettle([BASIS_DOC]);
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("the entry exists, linked to both its basis and the supporting document", async () => {
    const page = await bench.obs.timeIndex();
    const entry = page.items.find((i) => i.sentence.includes("TIX-FERRY"));
    expect(entry, "the crossing was filed").toBeDefined();
    const linked = bench.sql
      .prepare<[string], { document_id: string }>(
        "SELECT document_id FROM temporal_annotation_documents WHERE annotation_id = ? ORDER BY document_id",
      )
      .all(entry!.id)
      .map((r) => r.document_id);
    expect(linked).toContain(supportingDocId);
    expect(linked).toHaveLength(2);
  }, 60_000);

  // The edit and its observation live in their own test so a stalled drain
  // or a missing row fails THERE, with its real error; the verdict below is
  // a single assertion over the captured state.
  let editInvalidatedAt: number | null | undefined;
  let editInvalidationCause: string | null = null;

  test("the supporting document's edit lands, and the entry's state is captured", async () => {
    await bench.update(SUPPORTING_DOC, SUPPORTING_DOC_V2);
    await bench.drainUntilQuiet();

    // The edit really reached the corpus and woke a run for it.
    const supporting = bench.sql
      .prepare<[string], { content: string }>("SELECT content FROM documents WHERE id = ?")
      .get(supportingDocId);
    expect(supporting!.content).toContain("print the boarding reference");
    expect(
      bench.puppetCalls.some((c) => c.subject === supportingDocId && c.flavour === "data.updated"),
      "the update drove a data run",
    ).toBe(true);

    const row = bench.sql
      .prepare<
        [],
        { invalidated_at: number | null; invalidation_cause: string | null } | undefined
      >("SELECT invalidated_at, invalidation_cause FROM temporal_annotations WHERE sentence LIKE '%TIX-FERRY%'")
      .get();
    expect(row, "the entry row still exists").toBeDefined();
    editInvalidatedAt = row!.invalidated_at;
    editInvalidationCause = row!.invalidation_cause;
  }, 120_000);

  test("editing the supporting document leaves the entry alive", () => {
    // The basis — the confirmation the entry actually derives from — never
    // changed, so the entry survives an edit to a document that was only
    // ever attached as support: its grounding atom lives in the basis, and
    // the supporting doc's change breaks nothing.
    expect(
      editInvalidatedAt,
      `invalidation_cause=${editInvalidationCause ?? "(null)"} — a supporting document's edit must not take the entry down`,
    ).toBeNull();
  });
});

// The re-file loop, end to end: an edit that breaks an entry's only quote
// invalidates it, the data run the same edit wakes is handed the casualty
// (a STATE lookup — the invalidation is stamped at document-event time,
// before the run row exists, so no run-timestamp window could contain it),
// the run re-files the corrected fact, and once that run completes the
// casualty retires from the lookup — a later edit's run is not shown it
// again. The runtime stamps `refile_presented_run` at prompt build.

const REFILE_DOC = email({
  externalId: "brain-tix-refile",
  title: "Move-out inspection booking",
  content:
    "Hi Alex,\n\nThe move-out inspection is booked for the third of May 2027 at 10:00. " +
    "Please bring both sets of keys.\n\nRiverside Estate",
});
const REFILE_V2 =
  "Hi Alex,\n\nUpdate: the move-out inspection has moved to the fifth of May 2027 at 10:00. " +
  "Please bring both sets of keys.\n\nRiverside Estate";
const REFILE_V3 =
  "Hi Alex,\n\nUpdate: the move-out inspection has moved to the fifth of May 2027 at 10:00. " +
  "Please bring both sets of keys. See you there.\n\nRiverside Estate";

describe("Brain Bench — the re-file loop after a grounding quote breaks", () => {
  let bench: BrainBench;
  let refileDocId = "";

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      behaviors: {
        behaviors: [
          {
            flavour: "data.created",
            docTitle: REFILE_DOC.title,
            plan: (ctx) => ({
              calls: [
                fileTemporal({
                  when: "2027-05-03",
                  sentence: "TIX-REFILE move-out inspection at the studio.",
                  kind: "appointment",
                  evidence: {
                    docId: ctx.subject,
                    quote: "inspection is booked for the third of May 2027",
                  },
                }),
              ],
              finalText: "Filed the inspection.",
            }),
          },
          // Fires for BOTH edits. The first re-files against the new date;
          // the second attempt meets the reconcile refusal (the re-filed
          // entry is live on that day) and settles without a duplicate.
          {
            flavour: "data.updated",
            docTitle: REFILE_DOC.title,
            plan: (ctx) => ({
              calls: [
                fileTemporal({
                  when: "2027-05-05",
                  sentence: "TIX-REFILE move-out inspection at the studio (moved).",
                  kind: "appointment",
                  evidence: {
                    docId: ctx.subject,
                    quote: "moved to the fifth of May 2027",
                  },
                }),
              ],
              finalText: "Re-filed the moved inspection.",
            }),
          },
        ],
      },
    });
    await bench.pushAndSettle([REFILE_DOC]);
    refileDocId = await bench.docId(REFILE_DOC.externalId);
    expect(refileDocId).not.toBe("");
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("the edit invalidates the entry, and the woken run is handed it for re-filing", async () => {
    await bench.update(REFILE_DOC, REFILE_V2);
    await bench.drainUntilQuiet();

    // The broken-quote entry is down with cause content_change …
    const row = bench.sql
      .prepare<
        [],
        | {
            invalidated_at: number | null;
            invalidation_cause: string | null;
            refile_presented_run: string | null;
          }
        | undefined
      >(
        "SELECT invalidated_at, invalidation_cause, refile_presented_run FROM temporal_annotations WHERE sentence = 'TIX-REFILE move-out inspection at the studio.'",
      )
      .get();
    expect(row, "the original entry row exists").toBeDefined();
    expect(row!.invalidated_at).not.toBeNull();
    expect(row!.invalidation_cause).toBe("content_change");

    // … the update run's prompt listed it (the state lookup caught an
    // invalidation stamped before the run row existed) …
    const run = await bench.obs.runForDoc(refileDocId);
    const prompt = await bench.obs.promptFor(run.id);
    expect(prompt).toContain("<invalidated-temporal-annotations>");
    expect(prompt).toContain("TIX-REFILE move-out inspection at the studio.");
    expect(prompt).toContain("Account for EVERY entry above");

    // … the runtime stamped the presentation with that run's id …
    expect(row!.refile_presented_run).toBe(run.id);

    // … and the re-filed replacement is live, grounded in the new quote.
    const replacement = bench.sql
      .prepare<
        [],
        { invalidated_at: number | null } | undefined
      >("SELECT invalidated_at FROM temporal_annotations WHERE sentence = 'TIX-REFILE move-out inspection at the studio (moved).'")
      .get();
    expect(replacement, "the re-filed entry exists").toBeDefined();
    expect(replacement!.invalidated_at).toBeNull();
  }, 180_000);

  test("a settled casualty is not re-presented to the next run", async () => {
    await bench.update(REFILE_DOC, REFILE_V3);
    await bench.drainUntilQuiet();

    // The second edit keeps the new quote intact: nothing new dies, and the
    // already-presented casualty (its run completed) stays retired.
    const run = await bench.obs.runForDoc(refileDocId);
    const prompt = await bench.obs.promptFor(run.id);
    expect(prompt).not.toContain("<invalidated-temporal-annotations>");

    // The replacement entry survived the benign edit — and exactly ONE live
    // row carries it: the second data.updated firing's re-file attempt met
    // the reconcile refusal instead of minting a duplicate.
    const rows = bench.sql
      .prepare<
        [],
        { invalidated_at: number | null }
      >("SELECT invalidated_at FROM temporal_annotations WHERE sentence = 'TIX-REFILE move-out inspection at the studio (moved).'")
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.invalidated_at).toBeNull();
  }, 180_000);
});
