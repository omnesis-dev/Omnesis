// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain Bench — area H: person-merge adjudication and notes compaction.
 *
 * Two background lanes that nothing else drives end to end. Both are
 * self-maintenance: one decides identity questions the deterministic merge
 * tier could not settle, the other curates the agent's own memory blob back
 * under its size target. Both are also the sharpest test of mutation
 * authority, because each is granted exactly ONE artifact — a merge verdict,
 * or a note — and everything else is physically absent from its toolset.
 *
 * Two gateways, split on configuration rather than on subject: the merge lane
 * needs `brain.mergeAdjudication.enabled`, the notes lane needs a
 * deliberately tiny `notesMaxBytes` so an append can cross the soft cap
 * without writing kilobytes of fixture text.
 *
 * Merge candidates are seeded through a short-lived writable handle (the
 * pattern `enqueueCrashedDataRun` established) rather than grown from pushed
 * documents: the detector's own cadence and its corpus-wide IDF scoring make
 * the natural path both slow and non-deterministic, and what this suite is
 * about is what the ENGINE does with a pending candidate — the enqueue fold,
 * the evidence pack, the verdict tool, the writer's re-guard — not how the
 * candidate came to exist.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  waitFor,
  type ExecutedTool,
  type ToolResultView,
} from "./brain-bench/index.js";

compressCognitionCadences();

/** A tool result the gateway actually answered with. */
type ToolResult = NonNullable<ToolResultView>;

/** The results of one tool in a run, in call order. */
function resultsOf(calls: readonly ExecutedTool[], tool: string): ToolResult[] {
  return calls.filter((c) => c.tool === tool).map((c) => c.result ?? {});
}

/** The `data` payload of a structured tool result. */
function structured(result: ToolResult): Record<string, unknown> {
  expect(result.kind).toBe("structured");
  return result.data as Record<string, unknown>;
}

/** The settled run carrying a given dedupe key. */
async function runByDedupeKey(bench: BrainBench, kind: string, dedupeKey: string) {
  const runs = await bench.obs.runs({ kind });
  const run = runs.items.find((r) => r.dedupeKey === dedupeKey);
  if (!run) {
    throw new Error(
      `no ${kind} run with dedupe key ${dedupeKey}; saw ${runs.items
        .map((r) => r.dedupeKey ?? "<none>")
        .join(", ")}`,
    );
  }
  return run;
}

/** The settled data run a pushed document caused. */
async function dataRunFor(bench: BrainBench, docId: string): Promise<string> {
  const run = await bench.obs.runForDoc(docId);
  expect(run.status).toBe("completed");
  return run.id;
}

// ═══════════════════════════════════════════════════════════════════════════
// merge adjudication
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The enqueue pass's due gate. Clearing it re-arms the pass on the rhythm's
 * next tick, so a test can seed candidates AFTER boot (the pass fires once at
 * start-up, when there is nothing to see, and then not again for its cadence).
 */
const MERGE_ADJUDICATION_LAST_RUN_KEY = "merge-adjudication:last-run";

const DEDUPE_PREFIX = "merge-adjudication:candidate:";

/**
 * One seeded identity. Both sides of every candidate below are freshly
 * invented people carrying a bench-scoped address, so a side can never
 * accidentally resolve to somebody the ambient universe already contains.
 */
interface SeedPerson {
  id: string;
  name: string;
  email: string;
  /** A second, conflicting name alias — makes the person a multi-person blob. */
  blobName?: string;
}

interface SeedCandidate {
  id: string;
  a: SeedPerson;
  b: SeedPerson;
  status?: "pending" | "denied";
  matchedTokens?: string[];
}

const CAND = {
  merge: "mcand-bench-verdict-merge",
  distinct: "mcand-bench-verdict-distinct",
  unsure: "mcand-bench-verdict-unsure",
  authority: "mcand-bench-authority",
  blob: "mcand-bench-blob",
  settled: "mcand-bench-settled",
  reguard: "mcand-bench-reguard",
} as const;

const CANDIDATES: SeedCandidate[] = [
  {
    id: CAND.merge,
    matchedTokens: ["maya", "reeves"],
    a: { id: "pers-bench-merge-a", name: "Maya Reeves", email: "bench-merge-a@example.com" },
    b: { id: "pers-bench-merge-b", name: "Maya Reeves", email: "bench-merge-b@example.org" },
  },
  {
    id: CAND.distinct,
    matchedTokens: ["jamie", "lopez"],
    a: { id: "pers-bench-distinct-a", name: "Jamie Lopez", email: "bench-distinct-a@example.com" },
    b: { id: "pers-bench-distinct-b", name: "Jamie Lopez", email: "bench-distinct-b@example.org" },
  },
  {
    id: CAND.unsure,
    matchedTokens: ["david", "lin"],
    a: { id: "pers-bench-unsure-a", name: "David Lin", email: "bench-unsure-a@example.com" },
    b: { id: "pers-bench-unsure-b", name: "David Lin", email: "bench-unsure-b@example.org" },
  },
  {
    id: CAND.authority,
    matchedTokens: ["sarah", "mendez"],
    a: { id: "pers-bench-auth-a", name: "Sarah Mendez", email: "bench-auth-a@example.com" },
    b: { id: "pers-bench-auth-b", name: "Sarah Mendez", email: "bench-auth-b@example.org" },
  },
  {
    id: CAND.blob,
    matchedTokens: ["maya", "reeves"],
    a: {
      id: "pers-bench-blob-a",
      name: "Maya Reeves",
      email: "bench-blob-a@example.com",
      // Two structurally different names on one identity: exactly the
      // multi-person blob the writer guard refuses to weld further.
      blobName: "David Lin",
    },
    b: { id: "pers-bench-blob-b", name: "Maya Reeves", email: "bench-blob-b@example.org" },
  },
  {
    id: CAND.settled,
    status: "denied",
    matchedTokens: ["sarah", "mendez"],
    a: { id: "pers-bench-settled-a", name: "Sarah Mendez", email: "bench-settled-a@example.com" },
    b: { id: "pers-bench-settled-b", name: "Sarah Mendez", email: "bench-settled-b@example.org" },
  },
  {
    id: CAND.reguard,
    status: "denied",
    matchedTokens: ["jamie", "lopez"],
    a: { id: "pers-bench-reguard-a", name: "Jamie Lopez", email: "bench-reguard-a@example.com" },
    b: { id: "pers-bench-reguard-b", name: "Jamie Lopez", email: "bench-reguard-b@example.org" },
  },
];

/**
 * Directly-seeded run rows, for the two cases the enqueuer cannot produce: it
 * only ever offers PENDING candidates, so a run whose candidate is already
 * settled by execution time has to be planted the way a crash-recovery probe
 * plants one.
 */
const SETTLED_RUN_ID = "run_bench_settled_probe";
const REGUARD_RUN_ID = "run_bench_reguard_probe";

function seedCandidates(bench: BrainBench): void {
  const nowIso = new Date().toISOString();
  bench.withWriteHandle((db) => {
    const person = db.prepare<[string, string, string, string, string, string, string]>(
      `INSERT OR IGNORE INTO people
         (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
    );
    const alias = db.prepare<[string, string, string, string, string]>(
      `INSERT OR IGNORE INTO person_aliases (id, person_id, alias, alias_type, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const candidate = db.prepare<
      [string, string, string, string, string, number, string, string, number, string, string]
    >(
      `INSERT INTO merge_candidates
         (id, side_a_alias_type, side_a_alias, side_b_alias_type, side_b_alias,
          score, detection_kind, matched_tokens, match_strength, status, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const cand of CANDIDATES) {
      for (const p of [cand.a, cand.b]) {
        person.run(p.id, p.name, "email", nowIso, nowIso, nowIso, nowIso);
        alias.run(`alias-${p.id}-name`, p.id, p.name, "name", nowIso);
        alias.run(`alias-${p.id}-email`, p.id, p.email, "email", nowIso);
        if (p.blobName) alias.run(`alias-${p.id}-blob`, p.id, p.blobName, "name", nowIso);
      }
      candidate.run(
        cand.id,
        "email",
        cand.a.email,
        "email",
        cand.b.email,
        0.82,
        "name-token",
        JSON.stringify(cand.matchedTokens ?? []),
        0.9,
        cand.status ?? "pending",
        nowIso,
      );
    }
  });
  for (const [runId, candidateId] of [
    [SETTLED_RUN_ID, CAND.settled],
    [REGUARD_RUN_ID, CAND.reguard],
  ] as const) {
    bench.seedRun({
      id: runId,
      kind: "merge_adjudication",
      payload: { candidateId },
      dedupeKey: `${DEDUPE_PREFIX}${candidateId}`,
    });
  }
}

/** Clear the enqueue pass's due marker so the next rhythm tick fires it. */
function rearmMergeAdjudication(bench: BrainBench): void {
  bench.markers.clear(MERGE_ADJUDICATION_LAST_RUN_KEY);
}

/** Wait until a run exists for every named dedupe key, then drain. */
async function settleAdjudications(bench: BrainBench, dedupeKeys: string[]): Promise<void> {
  await waitFor(
    () => `merge_adjudication runs for ${dedupeKeys.join(", ")}`,
    async () => {
      const page = await bench.obs.runs({ kind: "merge_adjudication" });
      const have = new Set(page.items.map((r) => r.dedupeKey));
      return dedupeKeys.every((k) => have.has(k)) ? true : null;
    },
    60_000,
  );
  await bench.drainUntilQuiet();
}

interface CandidateRow {
  status: string;
  adjudicated_at: string | null;
  adjudication_verdict: string | null;
  adjudication_reason: string | null;
  adjudication_evidence_fingerprint: string | null;
  adjudication_count: number | null;
  rule_id: string | null;
}

function candidateRow(bench: BrainBench, id: string): CandidateRow | undefined {
  return bench.sql
    .prepare<[string], CandidateRow>(
      `SELECT status, adjudicated_at, adjudication_verdict, adjudication_reason,
              adjudication_evidence_fingerprint, adjudication_count, rule_id
         FROM merge_candidates WHERE id = ?`,
    )
    .get(id);
}

const MERGE_REASON =
  "One contact card carries both addresses and every thread uses them interchangeably.";
const DISTINCT_REASON =
  "Both addresses appear as separate recipients on the same thread, so these are two people.";
const UNSURE_REASON =
  "Two relatives share this surname and nothing in the pack separates the given names.";
const BLOB_REASON =
  "The sides read as one identity, but side A already welds two unrelated names together.";

/** The document whose data run tries to reach for the merge verdict tool. */
const DOC_DATA_RUN = email({
  externalId: "brain-adj-data-run",
  title: "Cedar Grove Supplies delivery notice",
  content: [
    "Hi Alex,",
    "",
    "The workshop benches are scheduled for delivery next Tuesday morning.",
    "",
    "Cedar Grove Supplies",
  ].join("\n"),
});

describe("merge adjudication", () => {
  let bench: BrainBench;

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      brain: { mergeAdjudication: { enabled: true } },
      behaviors: {
        behaviors: [
          {
            flavour: "merge_adjudication",
            promptContains: CAND.merge,
            plan: { calls: [call("merge_adjudicate", { verdict: "merge", reason: MERGE_REASON })] },
          },
          {
            flavour: "merge_adjudication",
            promptContains: CAND.distinct,
            plan: {
              calls: [call("merge_adjudicate", { verdict: "distinct", reason: DISTINCT_REASON })],
            },
          },
          {
            flavour: "merge_adjudication",
            promptContains: CAND.unsure,
            plan: {
              calls: [call("merge_adjudicate", { verdict: "unsure", reason: UNSURE_REASON })],
            },
          },
          {
            // The authority probe: reach for two artifacts this lane was never
            // granted, then do the one thing it may do.
            flavour: "merge_adjudication",
            promptContains: CAND.authority,
            plan: {
              calls: [
                call("open_loop_create", {
                  title: "Follow up on the identity question",
                  confidence: 0.8,
                  importance: 0.5,
                }),
                call("brief_create", {
                  kind: "info",
                  title: "Two identities may be one person",
                  description: "Raised from the adjudication lane.",
                  confidence: 0.8,
                  urgency: 0.3,
                }),
                call("merge_adjudicate", { verdict: "unsure", reason: UNSURE_REASON }),
              ],
            },
          },
          {
            flavour: "merge_adjudication",
            promptContains: CAND.blob,
            plan: { calls: [call("merge_adjudicate", { verdict: "merge", reason: BLOB_REASON })] },
          },
          {
            flavour: "merge_adjudication.settled",
            subject: CAND.settled,
            plan: { calls: [], finalText: "Nothing to adjudicate; the candidate is settled." },
          },
          {
            // The same settled shape, but with a model that ignores the
            // prompt's "do not call merge_adjudicate" and calls it anyway.
            flavour: "merge_adjudication.settled",
            subject: CAND.reguard,
            plan: {
              calls: [call("merge_adjudicate", { verdict: "merge", reason: MERGE_REASON })],
            },
          },
          {
            // The reverse authority direction: a lane that was never granted
            // the merge verdict reaching for it.
            flavour: "data.created",
            docTitle: DOC_DATA_RUN.title,
            plan: {
              calls: [call("merge_adjudicate", { verdict: "distinct", reason: DISTINCT_REASON })],
            },
          },
        ],
      },
    });

    seedCandidates(bench);
    rearmMergeAdjudication(bench);
    await settleAdjudications(bench, [
      `${DEDUPE_PREFIX}${CAND.merge}`,
      `${DEDUPE_PREFIX}${CAND.distinct}`,
      `${DEDUPE_PREFIX}${CAND.unsure}`,
      `${DEDUPE_PREFIX}${CAND.authority}`,
      `${DEDUPE_PREFIX}${CAND.blob}`,
    ]);
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("a pending candidate becomes one adjudication run, keyed to that candidate", async () => {
    const run = await runByDedupeKey(bench, "merge_adjudication", `${DEDUPE_PREFIX}${CAND.merge}`);
    expect(run.status).toBe("completed");
    expect(run.dedupeKey).toBe(`merge-adjudication:candidate:${CAND.merge}`);

    // The prompt is the adjudication flavour, carrying the deterministic
    // evidence pack rather than a bare instruction.
    const prompt = await bench.obs.promptFor(run.id);
    expect(prompt).toContain(`Loop agent run ${run.id} (kind: merge_adjudication, attempt 1).`);
    expect(prompt).toContain("You are adjudicating ONE pending person-merge candidate");
    expect(prompt).toContain(`Merge candidate ${CAND.merge} (detected `);
    expect(prompt).toContain('Side A: email "bench-merge-a@example.com" resolves to:');
    expect(prompt).toContain('Side B: email "bench-merge-b@example.org" resolves to:');
    expect(prompt).toContain("pers-bench-merge-a");
    expect(prompt).toContain("Cross-side co-occurrence:");

    // The puppet recognized the run from its envelope, not from the prose.
    const seen = bench.puppetCalls.filter((c) => c.kind === "merge_adjudication");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((c) => c.flavour === "merge_adjudication")).toBe(true);

    // And the verdict landed through the real tool, against the real writer.
    const [result] = resultsOf(await bench.obs.executedTools(run.id), "merge_adjudicate");
    expect(result).toBeDefined();
    const data = structured(result!);
    expect(data.candidateId).toBe(CAND.merge);
    expect(data.verdict).toBe("merge");
    expect(data.outcome).toBe("merged");
    expect(String(data.detail)).toContain("merge rule created");
  }, 120_000);

  test("each of the three verdicts produces its documented outcome", async () => {
    // merge → the candidate is accepted and a reversible system rule carries
    // the model's reason verbatim.
    const merged = candidateRow(bench, CAND.merge);
    expect(merged?.status).toBe("accepted");
    expect(merged?.adjudication_verdict).toBe("merge");
    expect(merged?.adjudication_reason).toBe(MERGE_REASON);
    expect(merged?.rule_id).toBeTruthy();
    const rule = bench.sql
      .prepare<
        [string],
        { kind: string; reason: string | null; created_by: string | null; active: number }
      >("SELECT kind, reason, created_by, active FROM merge_rules WHERE id = ?")
      .get(merged!.rule_id!);
    expect(rule?.kind).toBe("system");
    expect(rule?.reason).toBe(MERGE_REASON);
    expect(rule?.active).toBe(1);
    const mergeRun = await runByDedupeKey(
      bench,
      "merge_adjudication",
      `${DEDUPE_PREFIX}${CAND.merge}`,
    );
    expect(rule?.created_by).toBe(mergeRun.id);

    // distinct → a permanent veto: the candidate leaves the pending set.
    const distinctRun = await runByDedupeKey(
      bench,
      "merge_adjudication",
      `${DEDUPE_PREFIX}${CAND.distinct}`,
    );
    const [distinctResult] = resultsOf(
      await bench.obs.executedTools(distinctRun.id),
      "merge_adjudicate",
    );
    expect(structured(distinctResult!).outcome).toBe("denied");
    const denied = candidateRow(bench, CAND.distinct);
    expect(denied?.status).toBe("denied");
    expect(denied?.adjudication_verdict).toBe("distinct");
    expect(denied?.rule_id).toBeNull();

    // unsure → recorded only: the candidate stays for the operator, annotated.
    const unsureRun = await runByDedupeKey(
      bench,
      "merge_adjudication",
      `${DEDUPE_PREFIX}${CAND.unsure}`,
    );
    const [unsureResult] = resultsOf(
      await bench.obs.executedTools(unsureRun.id),
      "merge_adjudicate",
    );
    expect(structured(unsureResult!).outcome).toBe("recorded");
    const recorded = candidateRow(bench, CAND.unsure);
    expect(recorded?.status).toBe("pending");
    expect(recorded?.adjudication_verdict).toBe("unsure");
    expect(recorded?.adjudication_reason).toBe(UNSURE_REASON);
    expect(recorded?.adjudication_count).toBe(1);
    // No rule was minted for either non-merge verdict.
    expect(
      bench.sql
        .prepare<
          [string, string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM merge_rules WHERE side_a_alias = ? OR side_b_alias = ?")
        .get("bench-unsure-a@example.com", "bench-unsure-a@example.com")?.n,
    ).toBe(0);
  }, 120_000);

  test("the adjudication lane holds the merge verdict and nothing else", async () => {
    const run = await runByDedupeKey(
      bench,
      "merge_adjudication",
      `${DEDUPE_PREFIX}${CAND.authority}`,
    );
    const calls = await bench.obs.executedTools(run.id);

    // Both loop/brief writes were never present to be called: the runtime
    // filters the toolset by the workflow's declared authority, so the model
    // gets an unknown-tool answer rather than a refusal from the tool itself.
    const [loopResult] = resultsOf(calls, "open_loop_create");
    expect(loopResult!.kind).toBe("error");
    expect(loopResult!.code).toBe("unknown_tool");
    expect(String(loopResult!.message)).toContain("open_loop_create");
    const [briefResult] = resultsOf(calls, "brief_create");
    expect(briefResult!.kind).toBe("error");
    expect(briefResult!.code).toBe("unknown_tool");

    // Nothing was written by either attempt.
    expect((await bench.obs.loops()).items).toHaveLength(0);
    expect((await bench.obs.briefs()).items).toHaveLength(0);

    // The one granted verb still worked, so the denial is authority, not a
    // broken run.
    const [verdict] = resultsOf(calls, "merge_adjudicate");
    expect(structured(verdict!).outcome).toBe("recorded");
  }, 120_000);

  test("no other lane can reach the merge verdict tool", async () => {
    const [docId] = await bench.pushAndSettle([DOC_DATA_RUN]);
    const runId = await dataRunFor(bench, docId!);

    const [result] = resultsOf(await bench.obs.executedTools(runId), "merge_adjudicate");
    expect(result).toBeDefined();
    expect(result!.kind).toBe("error");
    expect(result!.code).toBe("unknown_tool");
    expect(String(result!.message)).toContain("merge_adjudicate");

    // The candidate a confused data run might have judged is untouched.
    expect(candidateRow(bench, CAND.unsure)?.adjudication_count).toBe(1);
  }, 180_000);

  test("a candidate already settled by the time the run executes is a no-op", async () => {
    const run = await runByDedupeKey(
      bench,
      "merge_adjudication",
      `${DEDUPE_PREFIX}${CAND.settled}`,
    );
    expect(run.id).toBe(SETTLED_RUN_ID);
    expect(run.status).toBe("completed");

    // The prompt builder reads the candidate's LIVE status at claim time and
    // switches flavour, rather than presenting an evidence pack for a decision
    // that has already been made.
    const prompt = await bench.obs.promptFor(run.id);
    expect(prompt).toContain(`Merge candidate ${CAND.settled} is already denied`);
    expect(prompt).toContain("there is nothing to adjudicate");
    expect(prompt).toContain("Do not call merge_adjudicate");
    expect(prompt).not.toContain("You are adjudicating ONE pending person-merge candidate");

    // The puppet saw the settled flavour and, per the plan, did nothing.
    const seen = bench.puppetCalls.filter((c) => c.flavour === "merge_adjudication.settled");
    expect(seen.length).toBeGreaterThan(0);
    expect(await bench.obs.executedTools(run.id)).toHaveLength(0);

    // The row keeps the decision it already had.
    const row = candidateRow(bench, CAND.settled);
    expect(row?.status).toBe("denied");
    expect(row?.adjudicated_at).toBeNull();
    expect(row?.adjudication_verdict).toBeNull();
    expect(row?.adjudication_count ?? 0).toBe(0);
  }, 120_000);

  test("a settled candidate survives a run that calls the verdict tool anyway", async () => {
    // The no-op prompt asks the model not to call the tool, but the tool is
    // still in the toolset (the runtime attaches it for the run's kind, not
    // for the candidate's state). What makes that safe is the writer, not the
    // prompt: it refuses a verdict on anything that is no longer pending, and
    // refuses BEFORE stamping, so a settled decision cannot be overwritten.
    const run = await runByDedupeKey(
      bench,
      "merge_adjudication",
      `${DEDUPE_PREFIX}${CAND.reguard}`,
    );
    expect(run.id).toBe(REGUARD_RUN_ID);
    expect(run.status).toBe("completed");
    expect(await bench.obs.promptFor(run.id)).toContain(
      `Merge candidate ${CAND.reguard} is already denied`,
    );

    const [result] = resultsOf(await bench.obs.executedTools(run.id), "merge_adjudicate");
    expect(result).toBeDefined();
    const data = structured(result!);
    expect(data.verdict).toBe("merge");
    expect(data.outcome).toBe("not_pending");
    expect(String(data.detail)).toContain("no longer pending");

    const row = candidateRow(bench, CAND.reguard);
    expect(row?.status).toBe("denied");
    expect(row?.adjudicated_at).toBeNull();
    expect(row?.adjudication_verdict).toBeNull();
    expect(row?.adjudication_count ?? 0).toBe(0);
    expect(row?.rule_id).toBeNull();
    expect(
      bench.sql
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM merge_rules WHERE side_a_alias = ?")
        .get("bench-reguard-a@example.com")?.n,
    ).toBe(0);
  }, 120_000);

  test("a merge verdict the writer guard refuses is recorded as guard_blocked", async () => {
    const run = await runByDedupeKey(bench, "merge_adjudication", `${DEDUPE_PREFIX}${CAND.blob}`);

    // The pack warns the model up front — the guard is not a surprise.
    const prompt = await bench.obs.promptFor(run.id);
    expect(prompt).toContain("internally conflicting name aliases");
    expect(prompt).toContain("will be REFUSED by the writer guard");

    const [result] = resultsOf(await bench.obs.executedTools(run.id), "merge_adjudicate");
    const data = structured(result!);
    expect(data.verdict).toBe("merge");
    expect(data.outcome).toBe("guard_blocked");
    expect(String(data.detail)).toContain("writer guard refused");

    // The verdict is still stamped (the operator sees what the model thought),
    // but nothing was merged and the candidate stays for manual review.
    const row = candidateRow(bench, CAND.blob);
    expect(row?.status).toBe("pending");
    expect(row?.adjudication_verdict).toBe("merge");
    expect(row?.adjudication_reason).toBe(BLOB_REASON);
    expect(row?.rule_id).toBeNull();
    expect(
      bench.sql
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM merge_rules WHERE side_a_alias = ?")
        .get("bench-blob-a@example.com")?.n,
    ).toBe(0);
  }, 120_000);

  test("a verdict is bound to the evidence it saw, and only moved evidence re-opens it", async () => {
    const before = candidateRow(bench, CAND.unsure);
    // The stamp is the fingerprint of what the run's pack presented — a
    // content hash, not a timestamp.
    expect(before?.adjudication_evidence_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(before?.adjudication_count).toBe(1);

    // Re-arming the pass over UNCHANGED evidence enqueues nothing: the verdict
    // on the row already answers the question being asked. The marker is
    // written LAST by the pass, so waiting for it to reappear is what makes
    // "no second run" a statement about the pass's decision rather than about
    // a pass that never ran.
    rearmMergeAdjudication(bench);
    await bench.markers.waitFor(MERGE_ADJUDICATION_LAST_RUN_KEY, (v) => v !== undefined);
    await bench.drainUntilQuiet();
    const afterNoChange = (await bench.obs.runs({ kind: "merge_adjudication" })).items.filter(
      (r) => r.dedupeKey === `${DEDUPE_PREFIX}${CAND.unsure}`,
    );
    expect(afterNoChange).toHaveLength(1);
    expect(candidateRow(bench, CAND.unsure)?.adjudication_count).toBe(1);

    // Move the evidence the fingerprint covers, and the candidate is due again
    // — a SECOND run, because the first is settled and cannot be folded into.
    bench.withWriteHandle((db) => {
      db.prepare<[string, string]>(
        "UPDATE merge_candidates SET matched_tokens = ? WHERE id = ?",
      ).run(JSON.stringify(["david", "lin", "shared-thread"]), CAND.unsure);
    });
    rearmMergeAdjudication(bench);
    await waitFor(
      "a second adjudication run for the re-evidenced candidate",
      async () => {
        const runs = (await bench.obs.runs({ kind: "merge_adjudication" })).items.filter(
          (r) => r.dedupeKey === `${DEDUPE_PREFIX}${CAND.unsure}`,
        );
        return runs.length >= 2 ? runs : null;
      },
      60_000,
    );
    await bench.drainUntilQuiet();

    const after = candidateRow(bench, CAND.unsure);
    expect(after?.adjudication_count).toBe(2);
    expect(after?.adjudication_evidence_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // The new stamp covers the new evidence, so it differs from the old one.
    expect(after?.adjudication_evidence_fingerprint).not.toBe(
      before?.adjudication_evidence_fingerprint,
    );
  }, 180_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// notes compaction
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A deliberately tiny soft cap. Everything below is sized against it: the
 * first append sits comfortably under, the second crosses it, and the
 * compaction rewrite lands back under — all in a few hundred bytes of
 * fixture text rather than the 8 KiB the production default would need.
 */
const NOTES_CAP = 400;

const FIRST_NOTE = "Alex prefers written summaries over calls.";

/** ~401 bytes: on its own it pushes the blob over the soft cap. */
const OVER_CAP_NOTE = "Cedar Grove Supplies bills net thirty and chases invoices by email. "
  .repeat(6)
  .trim();

/** ~197 bytes: still over the cap, still under the 2x hard ceiling. */
const SECOND_OVER_CAP_NOTE = "Studio Northstar confirms rehearsal slots on the Thursday before. "
  .repeat(3)
  .trim();

/** What the scripted compaction run curates the blob down to. */
const COMPACTED_NOTES = [
  "Alex prefers written summaries over calls.",
  "Cedar Grove Supplies bills net thirty and emails invoices from billing@example.com.",
  "Studio Northstar confirms rehearsal slots from bookings@example.com.",
].join("\n");

const EDIT_OLD = "Alex prefers written summaries over calls.";
const EDIT_NEW = "Alex prefers written summaries.";
/** Absent from the blob — the surgical edit's miss arm. */
const EDIT_MISSING = "Riverside Estate parking is limited to twelve vehicles.";
/** Present twice — the surgical edit's ambiguity arm. */
const EDIT_AMBIGUOUS = "@example.com";

const DOC_NOTE_UNDER = email({
  externalId: "brain-adj-notes-under",
  title: "Riverside Estate scheduling preferences",
  content: [
    "Hi Alex,",
    "",
    "Noted that you would rather have the summary in writing than on a call.",
    "",
    "Riverside Estate",
  ].join("\n"),
});

const DOC_NOTE_OVER = email({
  externalId: "brain-adj-notes-over",
  title: "Cedar Grove Supplies billing terms",
  content: [
    "Hi Alex,",
    "",
    "Our billing terms are net thirty on every open account.",
    "",
    "Cedar Grove Supplies",
  ].join("\n"),
});

const DOC_NOTE_EDIT = email({
  externalId: "brain-adj-notes-edit",
  title: "Studio Northstar rehearsal reminder",
  content: [
    "Hi Alex,",
    "",
    "A reminder that the rehearsal slot is confirmed the Thursday before.",
    "",
    "Studio Northstar",
  ].join("\n"),
});

describe("agent notes and their background compaction", () => {
  let bench: BrainBench;

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      brain: { notesMaxBytes: NOTES_CAP },
      behaviors: {
        behaviors: [
          {
            flavour: "data.created",
            docTitle: DOC_NOTE_UNDER.title,
            plan: { calls: [call("notes_append", { text: FIRST_NOTE })] },
          },
          {
            // Two over-cap appends inside ONE run: the second proves the
            // compaction enqueue is a singleton, which a second run could not
            // show (the first compaction would already have drained).
            flavour: "data.created",
            docTitle: DOC_NOTE_OVER.title,
            plan: {
              calls: [
                call("notes_append", { text: OVER_CAP_NOTE }),
                call("notes_append", { text: SECOND_OVER_CAP_NOTE }),
              ],
            },
          },
          {
            flavour: "notes_compaction",
            plan: {
              calls: [
                // Not granted to this lane: curation must not become an
                // interruption.
                call("brief_create", {
                  kind: "info",
                  title: "Notes were getting long",
                  description: "Raised from the compaction lane.",
                  confidence: 0.8,
                  urgency: 0.2,
                }),
                call("notes_rewrite", { text: COMPACTED_NOTES }),
              ],
            },
          },
          {
            flavour: "data.created",
            docTitle: DOC_NOTE_EDIT.title,
            plan: {
              calls: [
                call("notes_edit", { oldText: EDIT_OLD, newText: EDIT_NEW }),
                call("notes_edit", { oldText: EDIT_MISSING, newText: "" }),
                call("notes_edit", { oldText: EDIT_AMBIGUOUS, newText: "@example.org" }),
              ],
            },
          },
        ],
      },
    });
  }, 300_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("an append under the cap lands and is served back, with its byte budget", async () => {
    expect(await bench.obs.notes()).toBe("");

    const [docId] = await bench.pushAndSettle([DOC_NOTE_UNDER]);
    const runId = await dataRunFor(bench, docId!);

    const [result] = resultsOf(await bench.obs.executedTools(runId), "notes_append");
    const data = structured(result!);
    expect(data.bytesUsed).toBe(Buffer.byteLength(FIRST_NOTE, "utf8"));
    expect(data.maxBytes).toBe(NOTES_CAP);
    // Under the cap, so no curation is owed and none is announced.
    expect(data.overCap).toBeUndefined();
    expect(data.compactionScheduled).toBeUndefined();

    expect(await bench.obs.notes()).toBe(FIRST_NOTE);
    expect((await bench.obs.runs({ kind: "notes_compaction" })).items).toHaveLength(0);
  }, 120_000);

  test("crossing the soft cap still writes, and arms exactly one compaction run", async () => {
    const [docId] = await bench.pushAndSettle([DOC_NOTE_OVER]);
    const runId = await dataRunFor(bench, docId!);

    const appends = resultsOf(await bench.obs.executedTools(runId), "notes_append");
    expect(appends).toHaveLength(2);

    // Memory writes must succeed immediately: the append lands even though it
    // is over the target, and the debt is declared rather than hidden.
    const first = structured(appends[0]!);
    expect(first.overCap).toBe(true);
    expect(first.maxBytes).toBe(NOTES_CAP);
    expect(Number(first.bytesUsed)).toBeGreaterThan(NOTES_CAP);
    expect(first.compactionScheduled).toBe(true);

    // The second over-cap append finds a compaction already pending. The flag
    // reports the STATE ("curation is owed and is coming"), not the act, so it
    // is true again — the model must not read the second answer as "your write
    // will never be curated".
    const second = structured(appends[1]!);
    expect(second.overCap).toBe(true);
    expect(Number(second.bytesUsed)).toBeGreaterThan(Number(first.bytesUsed));
    expect(second.compactionScheduled).toBe(true);

    // And there is exactly one compaction run behind both of them: the fold
    // key is fixed rather than per-write, so an arbitrary number of over-cap
    // writes owes exactly one curation pass.
    const compactions = (await bench.obs.runs({ kind: "notes_compaction" })).items;
    expect(compactions).toHaveLength(1);
    expect(compactions[0]!.dedupeKey).toBe("notes-compaction");
    expect(compactions[0]!.status).toBe("completed");
    expect(compactions[0]!.attempts).toBe(1);
  }, 180_000);

  test("the compaction run rewrites the blob back under the cap", async () => {
    const run = await runByDedupeKey(bench, "notes_compaction", "notes-compaction");

    // The prompt states the live byte count read at claim time, against the
    // configured cap — not a snapshot taken when it was scheduled.
    const prompt = await bench.obs.promptFor(run.id);
    expect(prompt).toContain(`Loop agent run ${run.id} (kind: notes_compaction, attempt 1).`);
    expect(prompt).toMatch(
      new RegExp(`Notes compaction: your agent notes are \\d+ bytes against the ${NOTES_CAP}-byte`),
    );
    expect(prompt).toContain("scheduled because: notes over soft cap");

    const [rewrite] = resultsOf(await bench.obs.executedTools(run.id), "notes_rewrite");
    const data = structured(rewrite!);
    expect(data.content).toBe(COMPACTED_NOTES);
    expect(data.maxBytes).toBe(NOTES_CAP);
    expect(Number(data.bytesUsed)).toBeLessThan(NOTES_CAP);

    // The read surface every prompt is built from agrees.
    expect(await bench.obs.notes()).toBe(COMPACTED_NOTES);
    expect(Buffer.byteLength(await bench.obs.notes(), "utf8")).toBeLessThan(NOTES_CAP);
  }, 120_000);

  test("the compaction lane may write notes and nothing else", async () => {
    const run = await runByDedupeKey(bench, "notes_compaction", "notes-compaction");
    const calls = await bench.obs.executedTools(run.id);

    const [briefResult] = resultsOf(calls, "brief_create");
    expect(briefResult).toBeDefined();
    expect(briefResult!.kind).toBe("error");
    expect(briefResult!.code).toBe("unknown_tool");
    expect(String(briefResult!.message)).toContain("brief_create");

    expect((await bench.obs.briefs()).items).toHaveLength(0);
    expect((await bench.obs.loops()).items).toHaveLength(0);
    // The granted verb in the same run worked, so the denial is authority.
    expect(resultsOf(calls, "notes_rewrite")[0]!.kind).toBe("structured");
  }, 120_000);

  test("notes_edit replaces a unique span, and refuses a miss or an ambiguity", async () => {
    const [docId] = await bench.pushAndSettle([DOC_NOTE_EDIT]);
    const runId = await dataRunFor(bench, docId!);

    const edits = resultsOf(await bench.obs.executedTools(runId), "notes_edit");
    expect(edits).toHaveLength(3);

    // A unique span is spliced in place; the edit shrinks the blob, so the
    // ceiling never binds.
    const applied = structured(edits[0]!);
    expect(applied.maxBytes).toBe(NOTES_CAP);
    expect(Number(applied.bytesUsed)).toBe(
      Buffer.byteLength(COMPACTED_NOTES.replace(EDIT_OLD, EDIT_NEW), "utf8"),
    );
    expect(applied.overCap).toBeUndefined();

    // A span that is not there is a re-askable refusal naming what was missed.
    expect(edits[1]!.kind).toBe("error");
    expect(edits[1]!.code).toBe("notes_edit_not_found");
    expect(String(edits[1]!.message)).toContain(EDIT_MISSING);

    // A span that occurs twice is refused with the occurrence count, so the
    // model knows to lengthen the needle rather than retry verbatim.
    expect(edits[2]!.kind).toBe("error");
    expect(edits[2]!.code).toBe("notes_edit_ambiguous");
    expect(String(edits[2]!.message)).toContain("occurs 2 times");

    // Exactly one edit changed anything.
    expect(await bench.obs.notes()).toBe(COMPACTED_NOTES.replace(EDIT_OLD, EDIT_NEW));
    expect(await bench.obs.notes()).toContain(EDIT_NEW);
    expect(await bench.obs.notes()).not.toContain(EDIT_OLD);
    // The refused edits left the second address untouched.
    expect((await bench.obs.notes()).split(EDIT_AMBIGUOUS)).toHaveLength(3);
    // Still under the cap, so no further compaction was armed.
    expect((await bench.obs.runs({ kind: "notes_compaction" })).items).toHaveLength(1);
  }, 180_000);
});
