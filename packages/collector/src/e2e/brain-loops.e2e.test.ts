// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain Bench — area B: open loops.
 *
 * The loop is the steward's unit of durable commitment, and almost every
 * invariant around it is a CASCADE rather than a row write: creating one
 * projects a searchable mirror document, reconciling onto one must not mint
 * a second, resolving one retires it into the consolidation store, deleting
 * one must take its brief, its join rows and its mirror with it, and the
 * decay engine must schedule its own revisits without ever reaping a loop
 * itself.
 *
 * Every test asserts that a cascade fired (or deliberately did not), never
 * that the steward *should* have made the decision that triggered it — the
 * decisions are scripted by the behavior table.
 *
 * One gateway boot drives all of it, which makes the tests ORDER-DEPENDENT
 * by construction: the document-driven arcs run first and the clock-driven
 * arcs last, because advancing the virtual clock makes EVERY open loop's
 * decay check due at once.
 *
 * The virtual clock is frozen between advances, so wall time never moves
 * inside a phase: two writes in the same phase carry identical timestamps,
 * and nothing here may assert that one is later than another.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  ref,
  waitFor,
  type LoopDto,
} from "./brain-bench/index.js";

compressCognitionCadences();

// ── the arcs ────────────────────────────────────────────────────────────────
//
// Each arc owns a unique marker token: loop titles carry it, the scripted
// `open_loop_search` queries use it, and every assertion attributes rows back
// through it. No marker is a substring of another, so a lexical search for one
// arc can never surface another arc's loop.

const A = "Larkspur"; // create → reconcile → silent close
const B = "Harborview"; // delete cascade
const P = "Fernwood"; // the product /loops contract
const D_KEEP = "Alderway"; // decay: the KEEP arm
const D_GONE = "Brambling"; // decay: keep once, then reap
const C = "Quarrystone"; // recurrence consolidation

/** The note the Brambling decay check leaves on its first (KEEP) visit. */
const BRAMBLING_KEPT_NOTE = "The Brambling lighting quote is still unanswered.";

const A1 = email({
  externalId: "loops-larkspur-request",
  title: `Deposit request for the ${A} showcase`,
  content: `Hi Alex,\n\nRiverside Estate is holding the ${A} showcase date for you. Please send the deposit to confirm the booking.\n\nRiverside Estate`,
});

const A2 = email({
  externalId: "loops-larkspur-rider",
  title: `Stage rider for the ${A} showcase`,
  content: `Hi Alex,\n\nAttaching the stage rider for the ${A} showcase. The deposit is still outstanding, so the date is not locked yet.\n\nRiverside Estate`,
});

const A3 = email({
  externalId: "loops-larkspur-receipt",
  title: `Deposit received for the ${A} showcase`,
  content: `Hi Alex,\n\nWe have received your deposit for the ${A} showcase. The date is confirmed and nothing further is needed.\n\nRiverside Estate`,
});

const B1 = email({
  externalId: "loops-harborview-review",
  title: `Lease review request for ${B}`,
  content: `Hi Alex,\n\nCould you review the ${B} lease before Friday? Whitfield Law needs your comments to close it out.\n\nDana`,
});

const B2 = email({
  externalId: "loops-harborview-withdrawn",
  title: `${B} lease withdrawn`,
  content: `Hi Alex,\n\nThe landlord has withdrawn the ${B} lease entirely — please ignore the review request, there is nothing left to comment on.\n\nDana`,
});

const P1 = email({
  externalId: "loops-fernwood-status",
  title: `${P} rental status`,
  content: `Hi Alex,\n\nTwo things on the ${P} booking: the signed rental agreement has not come back yet, and the catering menus are attached whenever you want to compare them.\n\nStudio Northstar`,
});

const D1 = email({
  externalId: "loops-studio-status",
  title: `Studio status for the ${D_KEEP} and ${D_GONE} sessions`,
  content: `Hi Alex,\n\nThe ${D_KEEP} rehearsal slot is not confirmed yet, and we are still waiting on a lighting quote for ${D_GONE}.\n\nStudio Northstar`,
});

const C1 = email({
  externalId: "loops-quarrystone-permit-1",
  title: `${C} permit renewal notice`,
  content: `Hi Alex,\n\nThe ${C} workshop permit is due for renewal. Send the renewal form back when you can.\n\nCedar Grove Supplies`,
});

const C2 = email({
  externalId: "loops-quarrystone-permit-2",
  title: `${C} permit renewal notice again`,
  content: `Hi Alex,\n\nThe ${C} workshop permit is due for renewal once more. Send the renewal form back when you can.\n\nCedar Grove Supplies`,
});

// ── local helpers (capabilities the kit does not expose) ────────────────────

/** The legacy LIKE document search — the hidden-mirror findability probe. */
interface LikeSearchResult {
  results: Array<{ id: string; title: string; source_id: string }>;
}

/** A mirror document as it lands in the corpus. */
interface MirrorDocRow {
  id: string;
  title: string;
  content: string;
  source_id: string;
}

const HOUR = 3_600_000;

/**
 * Pull a `deletedBriefIds` list out of a run transcript's event stream. Tool
 * results are carried verbatim (sometimes as a JSON string), so the scan is
 * structural rather than keyed on an event type.
 */
function findDeletedBriefIds(value: unknown): string[] | null {
  if (typeof value === "string") {
    try {
      return findDeletedBriefIds(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDeletedBriefIds(item);
      if (found) return found;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.deletedBriefIds)) return obj.deletedBriefIds as string[];
    for (const nested of Object.values(obj)) {
      const found = findDeletedBriefIds(nested);
      if (found) return found;
    }
    return null;
  }
  return null;
}

/** Count join rows of one table for a loop. */
function joinRowCount(bench: BrainBench, table: string, loopId: string): number {
  return (
    bench.sql
      .prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE loop_id = ?`)
      .get(loopId)?.n ?? -1
  );
}

/** The mirror document for a loop, or undefined once it has been removed. */
function mirrorOf(bench: BrainBench, loopId: string): MirrorDocRow | undefined {
  return bench.sql
    .prepare<
      [string],
      MirrorDocRow
    >("SELECT id, title, content, source_id FROM documents WHERE external_id = ?")
    .get(loopId);
}

describe("Brain Bench — open loops", () => {
  let bench: BrainBench;

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      clock: "virtual",
      brain: {
        // The clock-driven arcs move virtual time forward by days; documents
        // pushed afterwards still carry wall-clock timestamps, so widen the
        // waker's recency gate rather than back-dating every fixture. The
        // ambient universe is months old, so it stays outside this window.
        recencyWindow: "30d",
        // The derivation barrier defers a data run to `now + 30m` and relies
        // on a later release pass to pull it back. Under a FROZEN virtual
        // clock a deferred run can never age into being due on its own, so
        // the bench takes the barrier out rather than depending on the
        // release pass firing before every assertion.
        derivationBarrier: "0s",
        // A month of decay back-off compressed to an hour, so the first
        // status-check on a fresh loop is one clock advance away.
        decay: { backoffBase: "1h", backoffCap: "8h", datedFloor: "30m" },
      },
      behaviors: {
        behaviors: [
          // ── arc A: create ────────────────────────────────────────────────
          {
            flavour: "data.created",
            docTitle: A1.title,
            plan: (ctx) => ({
              calls: [
                call("open_loop_search", { query: `${A} showcase deposit` }),
                call("open_loop_create", {
                  title: `Send the deposit for the ${A} showcase`,
                  description: `Riverside Estate holds the ${A} date until the deposit lands.`,
                  confidence: 0.9,
                  importance: 0.7,
                  docs: [ctx.subject],
                  actors: ["maya.reeves@example.org"],
                }),
                call("open_loop_ledger_append", {
                  id: ref("open_loop_create", "loop.id"),
                  note: `Deposit requested to hold the ${A} showcase date.`,
                }),
              ],
              finalText: "Tracked the deposit obligation.",
            }),
          },
          // ── arc A: reconcile onto the existing loop ──────────────────────
          {
            flavour: "data.created",
            docTitle: A2.title,
            plan: (ctx) => ({
              calls: [
                call("open_loop_search", { query: `${A} showcase deposit` }),
                // The loop was minted by an EARLIER run, so its id can only
                // come from this run's live search result.
                call("open_loop_update", {
                  id: ref("open_loop_search", "loops.0.id"),
                  docs: [ref("open_loop_search", "loops.0.docs.0"), ctx.subject],
                }),
                call("open_loop_ledger_append", {
                  id: ref("open_loop_search", "loops.0.id"),
                  note: `Stage rider arrived; the ${A} deposit is still outstanding.`,
                }),
              ],
              finalText: "Reconciled onto the existing loop.",
            }),
          },
          // ── arc A: silent close ──────────────────────────────────────────
          {
            flavour: "data.created",
            docTitle: A3.title,
            plan: () => ({
              calls: [
                call("open_loop_search", { query: `${A} showcase deposit` }),
                call("open_loop_update", {
                  id: ref("open_loop_search", "loops.0.id"),
                  state: "done",
                }),
                call("open_loop_ledger_append", {
                  id: ref("open_loop_search", "loops.0.id"),
                  note: `Deposit confirmed for the ${A} showcase; closing without a card.`,
                }),
              ],
              finalText: "Closed silently — nothing left for the user to do.",
            }),
          },
          // ── arc B: a loop with an attached brief ─────────────────────────
          {
            flavour: "data.created",
            docTitle: B1.title,
            plan: (ctx) => ({
              calls: [
                call("open_loop_search", { query: `${B} lease review` }),
                call("open_loop_create", {
                  title: `Review the ${B} lease`,
                  description: `Whitfield Law is waiting on comments for the ${B} lease.`,
                  confidence: 0.85,
                  importance: 0.8,
                  docs: [ctx.subject],
                  actors: ["dana.whitfield@whitfieldlaw.example"],
                }),
                call("open_loop_ledger_append", {
                  id: ref("open_loop_create", "loop.id"),
                  note: `Review of the ${B} lease requested.`,
                }),
                call("brief_create", {
                  kind: "loop",
                  title: `${B} lease needs your comments`,
                  description: "Requested before Friday.",
                  citations: [ctx.subject],
                  relatedLoopIds: [ref("open_loop_create", "loop.id")],
                  confidence: 0.85,
                  urgency: 0.6,
                }),
              ],
            }),
          },
          // ── arc B: the obligation is rescinded → delete, not done ────────
          {
            flavour: "data.created",
            docTitle: B2.title,
            plan: () => ({
              calls: [
                call("open_loop_search", { query: `${B} lease review` }),
                call("open_loop_delete", { id: ref("open_loop_search", "loops.0.id") }),
              ],
              finalText: "The obligation was rescinded; the loop should never have existed.",
            }),
          },
          // ── arc P: two loops of different importance, with people ────────
          {
            flavour: "data.created",
            docTitle: P1.title,
            plan: (ctx) => ({
              calls: [
                call("open_loop_search", { query: `${P} rental` }),
                call("open_loop_create", {
                  title: `Return the signed ${P} rental agreement`,
                  description: `Studio Northstar is waiting on the countersigned ${P} agreement.`,
                  confidence: 0.9,
                  importance: 0.9,
                  docs: [ctx.subject],
                  actors: ["maya.reeves@example.org"],
                  involved: ["jamie.lopez@example.com"],
                }),
                call("open_loop_create", {
                  title: `Compare the ${P} catering menus`,
                  description: `Menus for the ${P} booking are attached; no deadline given.`,
                  confidence: 0.7,
                  importance: 0.2,
                  docs: [ctx.subject],
                }),
                call("open_loop_ledger_append", {
                  id: ref("open_loop_create", "loop.id"),
                  note: `Agreement for ${P} sent for signature.`,
                }),
              ],
            }),
          },
          // ── arc D: two loops the decay engine will revisit ───────────────
          {
            flavour: "data.created",
            docTitle: D1.title,
            plan: (ctx) => ({
              calls: [
                call("open_loop_search", { query: "studio session status" }),
                call("open_loop_create", {
                  title: `Confirm the ${D_KEEP} rehearsal slot`,
                  description: `Studio Northstar has not confirmed the ${D_KEEP} slot.`,
                  confidence: 0.8,
                  importance: 0.6,
                  docs: [ctx.subject],
                }),
                call("open_loop_create", {
                  title: `Chase the ${D_GONE} lighting quote`,
                  description: `No lighting quote for ${D_GONE} has arrived.`,
                  confidence: 0.75,
                  importance: 0.5,
                  docs: [ctx.subject],
                }),
              ],
            }),
          },
          // ── arc C: a recurring commitment, minted twice ──────────────────
          {
            flavour: "data.created",
            docTitle: C1.title,
            plan: (ctx) => ({
              calls: [
                call("open_loop_search", { query: `${C} permit renewal` }),
                call("open_loop_create", {
                  title: `Renew ${C} workshop permit`,
                  description: `Cedar Grove Supplies asked for the ${C} renewal form.`,
                  confidence: 0.85,
                  importance: 0.55,
                  docs: [ctx.subject],
                }),
              ],
            }),
          },
          {
            flavour: "data.created",
            docTitle: C2.title,
            plan: (ctx) => ({
              // Deliberately re-worded: the consolidation key is the
              // order-insensitive normalized title, not the literal string.
              calls: [
                call("open_loop_search", { query: `${C} permit renewal` }),
                call("open_loop_create", {
                  title: `${C} workshop permit — renew`,
                  description: `Cedar Grove Supplies asked for the ${C} renewal form again.`,
                  confidence: 0.85,
                  importance: 0.55,
                  docs: [ctx.subject],
                }),
              ],
            }),
          },

          // ── decay behaviors ──────────────────────────────────────────────
          // Most-specific first: the Brambling REAP arm only matches once the
          // KEEP arm's ledger note is in the prompt's ledger tail.
          {
            flavour: "time_based.decay",
            promptContains: BRAMBLING_KEPT_NOTE,
            plan: (ctx) => ({
              calls: [call("open_loop_delete", { id: ctx.subject })],
              finalText: "Nothing ever came back on this; it has decayed to irrelevance.",
            }),
          },
          {
            flavour: "time_based.decay",
            promptContains: D_GONE,
            plan: (ctx) => ({
              calls: [
                call("open_loop_ledger_append", { id: ctx.subject, note: BRAMBLING_KEPT_NOTE }),
                call("open_loop_update", { id: ctx.subject, decayCheckPassed: true }),
              ],
              finalText: "Still plausible; keeping for one more cycle.",
            }),
          },
          {
            flavour: "time_based.decay",
            promptContains: D_KEEP,
            plan: (ctx) => ({
              calls: [
                call("open_loop_ledger_append", {
                  id: ctx.subject,
                  note: `Still waiting on the ${D_KEEP} slot; keeping.`,
                }),
                call("open_loop_update", { id: ctx.subject, decayCheckPassed: true }),
              ],
              finalText: "Kept.",
            }),
          },
          {
            flavour: "time_based.decay",
            promptContains: C,
            plan: (ctx) => ({
              calls: [
                call("open_loop_update", { id: ctx.subject, state: "done" }),
                call("open_loop_ledger_append", {
                  id: ctx.subject,
                  note: `${C} permit renewal filed; closing.`,
                }),
              ],
              finalText: "Filed and closed.",
            }),
          },
          // Every other loop's decay check is a deliberate no-op, so one arc's
          // clock advance never disturbs another arc's loops.
          { flavour: "time_based.decay", plan: { calls: [] } },
        ],
      },
    });
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  // ── 1. create + mirror ─────────────────────────────────────────────────

  test("a created loop lands with its docs and actors, and is mirrored into the corpus", async () => {
    // Baseline: the ambient corpus is dated outside the (widened) recency
    // window, so nothing woke the engine before this push.
    expect((await bench.obs.runs({ kind: "data" })).items).toHaveLength(0);

    const [a1Id] = await bench.pushAndSettle([A1]);

    const loops = await bench.obs.loopsMatching(A);
    expect(loops).toHaveLength(1);
    const loop = loops[0]!;
    expect(loop.state).toBe("open");
    expect(loop.importance).toBeCloseTo(0.7, 5);
    expect(loop.docs).toEqual([a1Id]);
    // A bare email resolves to its person; the admin list echoes raw ids.
    expect(loop.actors).toHaveLength(1);
    expect(loop.actors[0]).not.toBe("maya.reeves@example.org");
    expect(loop.involved).toEqual([]);

    const detail = await bench.obs.loop(loop.id);
    expect(detail.ledger).toHaveLength(1);
    expect(detail.ledger[0]!.note).toContain("Deposit requested");
    expect(detail.ledger[0]!.runId).toBe(loop.createdByRun);

    // The join rows the delete cascade later has to clear.
    expect(joinRowCount(bench, "open_loop_docs", loop.id)).toBe(1);
    expect(joinRowCount(bench, "open_loop_people", loop.id)).toBe(1);

    // The mirror: the tables are the truth, the document exists so the loop
    // inherits the search index.
    const mirror = mirrorOf(bench, loop.id);
    expect(mirror).toBeDefined();
    expect(mirror!.source_id).toBe("open-loops");
    expect(mirror!.title).toBe(loop.title);
    expect(mirror!.content).toContain("State: open");
    expect(mirror!.content).toContain("Deposit requested");

    // Findable ONLY when the caller names the hidden source. Unscoped search
    // still finds the triggering email, so the negative is not vacuous.
    const scoped = await bench.harness.gatewayJson<LikeSearchResult>(
      `/documents/search?q=${A}&sources=open-loops`,
    );
    expect(scoped.results.map((r) => r.id)).toContain(mirror!.id);

    const unscoped = await bench.harness.gatewayJson<LikeSearchResult>(`/documents/search?q=${A}`);
    expect(unscoped.results.length).toBeGreaterThan(0);
    expect(unscoped.results.map((r) => r.id)).not.toContain(mirror!.id);
  }, 120_000);

  // ── 2. reconcile, don't duplicate ──────────────────────────────────────

  test("a second document about the same matter reconciles onto the loop", async () => {
    const before = (await bench.obs.loopsMatching(A))[0]!;

    const [a2Id] = await bench.pushAndSettle([A2]);

    const loops = await bench.obs.loopsMatching(A);
    expect(loops).toHaveLength(1);
    const loop = loops[0]!;
    expect(loop.id).toBe(before.id);
    expect(loop.state).toBe("open");
    // The update replaced the doc list with BOTH documents — the second one
    // was folded into the existing loop, not into a new one.
    expect(new Set(loop.docs)).toEqual(new Set([...before.docs, a2Id]));
    expect(joinRowCount(bench, "open_loop_docs", loop.id)).toBe(2);

    // The paginated ledger route pages newest-first (the loop DETAIL route
    // inlines the same entries oldest-first).
    const ledger = await bench.obs.ledger(loop.id);
    expect(ledger.items).toHaveLength(2);
    expect(ledger.items[0]!.note).toContain("Stage rider arrived");
    expect(ledger.items[1]!.note).toContain("Deposit requested");
    // The two entries were written by two different runs.
    expect(ledger.items[1]!.runId).not.toBe(ledger.items[0]!.runId);

    // The reconcile went through the gateway's own search tool, and that
    // search surfaced the loop the EARLIER run minted — the only channel
    // through which this run could have learned the id it then updated.
    const steps = await bench.obs.executedTools((await bench.obs.runForDoc(a2Id!)).id);
    const search = steps.find((s) => s.tool === "open_loop_search");
    expect(search, "the reconcile run searched for an existing loop").toBeDefined();
    const surfaced = search!.result?.data?.loops as Array<{ id: string }> | undefined;
    expect(surfaced?.map((l) => l.id)).toContain(before.id);

    // The mirror tracks the ledger.
    expect(mirrorOf(bench, loop.id)!.content).toContain("Stage rider arrived");
  }, 120_000);

  // ── 3. silent close ────────────────────────────────────────────────────

  test("a resolution document closes the loop with a note and no brief", async () => {
    const briefsBefore = await bench.obs.briefs();
    expect(briefsBefore.items).toHaveLength(0);

    const [a3Id] = await bench.pushAndSettle([A3]);

    const loops = await bench.obs.loopsMatching(A);
    expect(loops).toHaveLength(1);
    expect(loops[0]!.state).toBe("done");

    const detail = await bench.obs.loop(loops[0]!.id);
    expect(detail.ledger).toHaveLength(3);
    expect(detail.ledger[2]!.note).toContain("closing without a card");
    // Silence is the whole point: no card was raised, none attached.
    expect(detail.briefs).toHaveLength(0);
    expect((await bench.obs.briefs()).items).toHaveLength(0);
    expect(await bench.obs.unreadCount()).toBe(0);

    // Non-vacuous: the resolution run really executed and really resolved the
    // loop — it simply wrote no brief while doing so.
    const dataRuns = await bench.obs.settledRuns("data");
    expect(dataRuns).toHaveLength(3);
    expect(dataRuns.every((r) => r.status === "completed")).toBe(true);
    const steps = await bench.obs.executedTools((await bench.obs.runForDoc(a3Id!)).id);
    // The gateway handed this run the loop the earlier runs had been building,
    // so the resolving update could only have targeted that loop.
    const surfaced = steps.find((s) => s.tool === "open_loop_search")?.result?.data?.loops as
      | Array<{ id: string }>
      | undefined;
    expect(surfaced?.map((l) => l.id)).toContain(loops[0]!.id);
    const resolutions = steps.filter(
      (s) => s.tool === "open_loop_update" && (s.args as { state?: unknown }).state === "done",
    );
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]!.result?.kind).not.toBe("error");

    // A resolved loop leaves the consolidation store its first trace.
    const trace = (await bench.obs.retiredLoops()).items.find((r) => r.title.includes(A));
    expect(trace).toBeDefined();
    expect(trace!.outcome).toBe("done");
    expect(trace!.recurrenceCount).toBe(1);
    expect(trace!.cadenceDays).toBeNull();
  }, 120_000);

  // ── 4. loop delete cascade ─────────────────────────────────────────────

  test("deleting a loop clears its brief, its join rows and its mirror", async () => {
    await bench.pushAndSettle([B1]);

    const created = await bench.obs.loopsMatching(B);
    expect(created).toHaveLength(1);
    const loopId = created[0]!.id;
    const briefs = await bench.obs.briefsMatching(B);
    expect(briefs).toHaveLength(1);
    const briefId = briefs[0]!.id;
    expect(briefs[0]!.relatedLoopIds).toEqual([loopId]);
    const mirrorId = mirrorOf(bench, loopId)?.id;
    expect(mirrorId).toBeDefined();
    // The positive control for the post-delete assertion below: the scoped
    // query DOES find the mirror while the loop exists, so its emptiness
    // afterwards is the cascade's doing and not a query that never matched.
    const scopedBefore = await bench.harness.gatewayJson<LikeSearchResult>(
      `/documents/search?q=${B}&sources=open-loops`,
    );
    expect(scopedBefore.results.map((r) => r.id)).toContain(mirrorId);
    expect(joinRowCount(bench, "open_loop_docs", loopId)).toBe(1);
    expect(joinRowCount(bench, "open_loop_people", loopId)).toBe(1);
    expect(joinRowCount(bench, "open_loop_ledger", loopId)).toBe(1);

    const [b2Id] = await bench.pushAndSettle([B2]);

    // The loop is gone from the store …
    expect(await bench.obs.loopsMatching(B)).toHaveLength(0);
    await expect(bench.obs.loop(loopId)).rejects.toThrow();

    // … and so is the brief the engine-enforced invariant took with it.
    expect(await bench.obs.briefsMatching(B)).toHaveLength(0);
    const briefRow = bench.sql
      .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM briefs WHERE id = ?")
      .get(briefId);
    expect(briefRow?.n).toBe(0);
    const citationRows = bench.sql
      .prepare<
        [string],
        { n: number }
      >("SELECT COUNT(*) AS n FROM brief_citations WHERE brief_id = ?")
      .get(briefId);
    expect(citationRows?.n).toBe(0);

    // The tool reported the cascade it performed.
    const deleteRun = (await bench.obs.settledRuns("data")).find(
      (r) => r.dedupeKey === `data:doc:${b2Id}`,
    );
    expect(deleteRun).toBeDefined();
    const refs = await bench.obs.transcripts({ runId: deleteRun!.id });
    const { transcript } = await bench.obs.transcript(refs.items.at(-1)!.fileName);
    expect(findDeletedBriefIds(transcript.events)).toEqual([briefId]);

    // Join rows and ledger went with it.
    expect(joinRowCount(bench, "open_loop_docs", loopId)).toBe(0);
    expect(joinRowCount(bench, "open_loop_people", loopId)).toBe(0);
    expect(joinRowCount(bench, "open_loop_ledger", loopId)).toBe(0);

    // And the corpus mirror was removed, not left as a stale search hit.
    expect(mirrorOf(bench, loopId)).toBeUndefined();
    const scoped = await bench.harness.gatewayJson<LikeSearchResult>(
      `/documents/search?q=${B}&sources=open-loops`,
    );
    expect(scoped.results).toHaveLength(0);

    // A delete is not a resolution: it leaves a `deleted` trace (the loop had
    // never been decay-checked, so it did not decay).
    const trace = (await bench.obs.retiredLoops()).items.find((r) => r.id === loopId);
    expect(trace).toBeDefined();
    expect(trace!.outcome).toBe("deleted");
  }, 120_000);

  // ── 5. the product /loops contract ─────────────────────────────────────

  test("/loops ranks by importance, filters by state, and enriches refs", async () => {
    await bench.pushAndSettle([P1]);

    const mine = await bench.obs.loopsMatching(P);
    expect(mine).toHaveLength(2);
    const high = mine.find((l) => l.importance > 0.5)!;
    const low = mine.find((l) => l.importance < 0.5)!;

    // Ranked by importance, descending. Arc A's loop is resolved and arc B's
    // was deleted, so these two are the whole active set.
    const active = await bench.obs.productLoops({ state: "active" });
    expect(active.loops.map((l) => l.id)).toEqual([high.id, low.id]);

    // The state filter is the two product tabs.
    const resolved = await bench.obs.productLoops({ state: "resolved" });
    expect(resolved.loops.map((l) => l.id)).not.toContain(high.id);
    expect(resolved.loops.some((l) => l.title.includes(A))).toBe(true);

    // The product surface enriches person refs; the admin surface echoes raw
    // ids. Same loop, deliberately different shapes.
    const productHigh = active.loops.find((l) => l.id === high.id)!;
    expect(productHigh.actors).toHaveLength(1);
    expect(productHigh.actors[0]!.name).toBe("Maya Reeves");
    expect(productHigh.actors[0]!.isSelf).toBe(false);
    expect(productHigh.actors[0]!.id).toBe(high.actors[0]);
    expect(productHigh.involved).toHaveLength(1);
    expect(productHigh.involved[0]!.name).toBe("Jamie Lopez");
    expect(productHigh.blockedBy).toEqual([]);
    const adminHigh: LoopDto = (await bench.obs.loops()).items.find((l) => l.id === high.id)!;
    expect(typeof adminHigh.actors[0]).toBe("string");

    // The detail route carries the loop plus its inline ledger.
    const detail = await bench.obs.productLoop(high.id);
    expect(detail.loop.id).toBe(high.id);
    expect(detail.loop.actors[0]!.name).toBe("Maya Reeves");
    expect(detail.ledger).toHaveLength(1);
    expect(detail.ledger![0]!.note).toContain("sent for signature");
    expect(detail.ledgerTruncated).toBe(false);

    // The low-importance loop has no people and an empty ledger.
    const detailLow = await bench.obs.productLoop(low.id);
    expect(detailLow.loop.actors).toEqual([]);
    expect(detailLow.ledger).toEqual([]);
  }, 120_000);

  // ── 6. decay lifecycle ─────────────────────────────────────────────────

  test("the decay sweep schedules checks; the agent keeps one loop and reaps another", async () => {
    await bench.pushAndSettle([D1]);

    const seeded = await bench.obs.loops({ state: "active" });
    const keep = seeded.items.find((l) => l.title.includes(D_KEEP))!;
    const gone = seeded.items.find((l) => l.title.includes(D_GONE))!;
    expect(keep).toBeDefined();
    expect(gone).toBeDefined();
    expect(keep.decayCheckCount).toBe(0);
    expect(keep.lastDecayCheck).toBeNull();

    // The sweep only ENQUEUES: one future-dated `time_based` check per open
    // loop, folded on one dedupe key each. The scheduled route exposes the
    // run's loop scope rather than its fold key, so the key itself is read
    // off the queue — and the sweep is a rhythm task gated on the decay
    // dirty-mark, so it lands after the run that created the loops settles.
    const pendingKeys = await waitFor(
      () => `decay checks to be scheduled (have: ${bench.pendingDedupeKeys().join(", ")})`,
      () => {
        const keys = bench.pendingDedupeKeys();
        return keys.includes(`decay:loop:${keep.id}`) && keys.includes(`decay:loop:${gone.id}`)
          ? keys
          : null;
      },
      30_000,
    );
    expect(pendingKeys.filter((k) => k === `decay:loop:${keep.id}`)).toHaveLength(1);
    expect(pendingKeys.filter((k) => k === `decay:loop:${gone.id}`)).toHaveLength(1);

    const scheduled = await bench.obs.scheduled();
    const scheduledForKeep = (
      scheduled.items as unknown as Array<{ kind: string; loopId: string | null }>
    ).filter((r) => r.loopId === keep.id);
    expect(scheduledForKeep).toHaveLength(1);
    expect(scheduledForKeep[0]!.kind).toBe("time_based");

    // ── first cycle: both loops are KEPT ────────────────────────────────
    await bench.clock.advance(2 * HOUR);
    await bench.drainUntilQuiet();

    const afterFirst = await bench.obs.loops({ state: "active" });
    const keptKeep = afterFirst.items.find((l) => l.id === keep.id);
    const keptGone = afterFirst.items.find((l) => l.id === gone.id);
    expect(keptKeep).toBeDefined();
    expect(keptGone).toBeDefined();
    // A KEEP stamps the check and widens the next interval; it never resolves.
    expect(keptKeep!.state).toBe("open");
    expect(keptKeep!.decayCheckCount).toBe(1);
    expect(keptKeep!.lastDecayCheck).not.toBeNull();
    expect(keptGone!.decayCheckCount).toBe(1);

    const decayRuns = await bench.obs.settledRuns("time_based");
    expect(decayRuns.some((r) => r.dedupeKey === `decay:loop:${keep.id}`)).toBe(true);
    expect(decayRuns.some((r) => r.dedupeKey === `decay:loop:${gone.id}`)).toBe(true);
    expect(decayRuns.every((r) => r.status === "completed")).toBe(true);

    // ── second cycle: the loop nothing came back on is reaped ───────────
    await bench.clock.advance(2 * HOUR);
    await bench.drainUntilQuiet();

    const afterSecond = await bench.obs.loops();
    expect(afterSecond.items.find((l) => l.id === gone.id)).toBeUndefined();
    const survivor = afterSecond.items.find((l) => l.id === keep.id);
    expect(survivor).toBeDefined();
    expect(survivor!.state).toBe("open");
    expect(survivor!.decayCheckCount).toBeGreaterThanOrEqual(2);

    // The reaped loop is retired as `decayed`: the decay engine had been
    // checking it (decay_check_count > 0) when the agent removed it.
    const trace = (await bench.obs.retiredLoops()).items.find((r) => r.id === gone.id);
    expect(trace).toBeDefined();
    expect(trace!.outcome).toBe("decayed");

    // Its mirror and its pending check went with it.
    expect(mirrorOf(bench, gone.id)).toBeUndefined();
    expect(bench.pendingDedupeKeys()).not.toContain(`decay:loop:${gone.id}`);
  }, 180_000);

  // ── 6b. clock discipline on the delete-retire path ─────────────────────

  test("a decayed loop's retirement trace is stamped with the cognition clock", async () => {
    // The brain is clock-disciplined end to end: every write takes an
    // injected `now`, so under a virtual clock a retirement trace must carry
    // virtual time — `retired_at` feeds the `cadenceDays` arithmetic, which
    // is only meaningful on the clock the engine reasons in. The delete path
    // threads the run's cognition clock through `writeGate.deleteOpenLoop`
    // into `retireLoop`, the same way the resolve path hands
    // `updateOpenLoop` its `clock()`.
    const clock = await bench.clock.now();
    expect(clock.virtual).toBe(true);
    // The decay arc advanced the cognition clock four hours past boot while
    // wall time stayed frozen. That gap is what lets the assertion tell the
    // two clocks apart at all; without it, it would hold whichever clock
    // stamped the row.
    const skewFromWallMs = clock.now - Date.now();
    expect(skewFromWallMs).toBeGreaterThan(3 * HOUR);
    expect(skewFromWallMs).toBeLessThan(5 * HOUR);

    const trace = (await bench.obs.retiredLoops()).items.find((r) => r.title.includes(D_GONE));
    expect(trace, "the reaped loop left a retirement trace").toBeDefined();
    expect(trace!.outcome).toBe("decayed");
    expect(Number.isFinite(Date.parse(trace!.retiredAt))).toBe(true);

    // A minute of slack: the assertion is about WHICH clock stamped the row,
    // not about millisecond precision.
    const skewMs = Math.abs(Date.parse(trace!.retiredAt) - clock.now);
    expect(
      skewMs,
      `retiredAt=${trace!.retiredAt}; cognition clock=${new Date(clock.now).toISOString()}; ` +
        `wall clock=${new Date().toISOString()}`,
    ).toBeLessThan(60_000);
  }, 60_000);

  // ── 7. recurrence consolidation ────────────────────────────────────────

  test("a commitment that recurs is consolidated with a cadence and a count", async () => {
    await bench.pushAndSettle([C1]);
    const first = (await bench.obs.loopsMatching(C)).find((l) => l.state === "open")!;
    expect(first).toBeDefined();

    // Its decay check closes it — the first retirement of this wording.
    await bench.clock.advance(1 * HOUR);
    await bench.drainUntilQuiet();

    const firstTrace = (await bench.obs.retiredLoops()).items.find((r) => r.id === first.id);
    expect(firstTrace).toBeDefined();
    expect(firstTrace!.outcome).toBe("done");
    expect(firstTrace!.recurrenceCount).toBe(1);
    expect(firstTrace!.cadenceDays).toBeNull();

    // The same commitment comes back, worded differently.
    await bench.pushAndSettle([C2]);
    const second = (await bench.obs.loopsMatching(C)).find((l) => l.state === "open")!;
    expect(second).toBeDefined();
    expect(second.id).not.toBe(first.id);

    // Three days and one hour later it retires again.
    await bench.clock.advance(73 * HOUR);
    await bench.drainUntilQuiet();

    const traces = (await bench.obs.retiredLoops()).items;
    const secondTrace = traces.find((r) => r.id === second.id);
    expect(secondTrace).toBeDefined();
    expect(secondTrace!.outcome).toBe("done");
    // The recurrence key is the normalized title, so the re-worded loop
    // consolidates onto the first trace instead of starting over — and the
    // cadence is the whole-day gap between the two retirements.
    expect(secondTrace!.recurrenceCount).toBe(2);
    expect(secondTrace!.cadenceDays).toBe(3);

    // The first trace is untouched: the store is append-only per loop id.
    const firstAgain = traces.find((r) => r.id === first.id);
    expect(firstAgain!.recurrenceCount).toBe(1);
    expect(firstAgain!.cadenceDays).toBeNull();

    // Both retirements are visible to reconcile.
    expect(traces.filter((r) => r.title.includes(C))).toHaveLength(2);
  }, 180_000);
});
