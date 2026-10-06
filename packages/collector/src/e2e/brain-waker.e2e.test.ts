// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Journal-backed intake: every changed evidence version receives durable interpretation coverage. */
import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  addressedToAgent,
  bulkMail,
  compressCognitionCadences,
  email,
  note,
  preserveCurrentOwner,
  sourceInterpretations,
} from "./brain-bench/index.js";

compressCognitionCadences();
const arrival = email({
  externalId: "intake-arrival",
  title: "Workshop reservation",
  content: "The workshop reservation is held until Friday.",
});
const edited = email({
  externalId: "intake-edited",
  title: "Workshop headcount",
  content: "The workshop has forty guests.",
});
const burst = note({
  externalId: "intake-burst",
  title: "Workshop packing list",
  content: "Draft one: bring the stands.",
});
const historical = email({
  externalId: "intake-history",
  title: "Archived workshop invoice",
  content: "The archived workshop invoice was paid in full.",
  ageDays: 60,
});
const marketing = bulkMail({
  externalId: "intake-marketing",
  title: "Workshop equipment offers",
  metadata: { bulkMail: true },
});
const directed = addressedToAgent({
  externalId: "intake-directed",
  title: "Workshop assistant instruction",
  content: "Remember the workshop opens at nine.",
});

function coverage(bench: BrainBench, id: string) {
  return bench.sql
    .prepare<
      [string],
      { input_revision: string; phase: string; status: string }
    >("SELECT input_revision,phase,status FROM knowledge_discovery_coverage WHERE subject_id=? ORDER BY input_revision,phase")
    .all(id);
}
function revision(bench: BrainBench, id: string): string {
  return bench.sql
    .prepare<[string], { content_hash: string }>("SELECT content_hash FROM documents WHERE id=?")
    .get(id)!.content_hash;
}

describe("Brain intake — evidence versions", () => {
  let bench: BrainBench;
  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      brain: {
        knowledge: { soonDelay: "0s", routineDelay: "0s", maxSeeds: 4, maxFrontierNodes: 4 },
      },
      behaviors: {
        dynamic: sourceInterpretations({
          sources: [
            {
              plan: { calls: [], finalText: "Read the source; no new durable artifact is needed." },
            },
          ],
          maintainNode: preserveCurrentOwner,
        }),
      },
    });
    await bench.drainUntilQuiet();
  }, 300_000);
  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("boot sync creates no retired datum runs or unsolicited owner state", async () => {
    expect((await bench.obs.runs({ kind: "data" })).items).toEqual([]);
    expect((await bench.obs.loops()).items).toEqual([]);
    expect((await bench.obs.briefs()).items).toEqual([]);
    expect(
      bench.sql.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM documents").get()!.n,
    ).toBeGreaterThanOrEqual(10);
  });

  test("a new source is interpreted at its exact content version", async () => {
    const [id] = await bench.pushAndSettle([arrival]);
    const run = await bench.obs.interpretationForSource(id!);
    expect(run.kind).toBe("synthesis");
    expect(run.status).toBe("completed");
    expect(coverage(bench, id!)).toEqual(
      expect.arrayContaining([
        { input_revision: revision(bench, id!), phase: "interpretation", status: "considered" },
        { input_revision: revision(bench, id!), phase: "organization", status: "considered" },
      ]),
    );
  });

  test("an edit preserves document identity and produces coverage for both versions", async () => {
    const [id] = await bench.pushAndSettle([edited]);
    const old = revision(bench, id!);
    await bench.update(edited, "The workshop has fifty-five guests.");
    await bench.drainUntilQuiet();
    expect(await bench.docId(edited.externalId)).toBe(id);
    expect(revision(bench, id!)).not.toBe(old);
    const organized = coverage(bench, id!).filter((row) => row.phase === "organization");
    expect(organized.map((row) => row.input_revision)).toEqual(
      expect.arrayContaining([old, revision(bench, id!)]),
    );
    expect((await bench.obs.runsForSource(id!)).length).toBeGreaterThanOrEqual(2);
  });

  test("rapid edits settle the latest source version without requiring a datum diff", async () => {
    const [id] = await bench.pushAndSettle([burst]);
    await bench.update(burst, "Draft two: bring the stands and cables.");
    await bench.update(burst, "Draft three: bring the stands, cables and lights.");
    await bench.drainUntilQuiet();
    expect(coverage(bench, id!)).toEqual(
      expect.arrayContaining([
        { input_revision: revision(bench, id!), phase: "organization", status: "considered" },
      ]),
    );
    expect((await bench.obs.runs({ kind: "data" })).items).toEqual([]);
  });

  test("bulk headers and historical timestamps do not erase arrival evidence", async () => {
    const ids = await bench.pushAndSettle([marketing, historical]);
    for (const id of ids)
      expect(
        coverage(bench, id).some(
          (row) => row.phase === "interpretation" && row.input_revision === revision(bench, id),
        ),
      ).toBe(true);
  });

  test("addressed instructions are interpreted through the same real source protocol", async () => {
    const [id] = await bench.pushAndSettle([directed]);
    const run = await bench.obs.interpretationForSource(id!);
    const steps = await bench.obs.executedTools(run.id);
    expect(
      steps.some((step) => step.tool === "fetch_many" && JSON.stringify(step.args).includes(id!)),
    ).toBe(true);
    expect(coverage(bench, id!).some((row) => row.phase === "organization")).toBe(true);
  });

  test("deletion cannot leave an orphan interpretation or resurrect purged evidence", async () => {
    const doomed = email({
      externalId: "intake-deleted",
      title: "Cancelled workshop rider",
      content: "The draft workshop rider is provisional.",
    });
    await bench.pushAll([doomed]);
    const id = await bench.docId(doomed.externalId);
    await bench.deleteDoc(id);
    await bench.drainUntilQuiet();
    expect(bench.sql.prepare("SELECT 1 FROM documents WHERE id=?").get(id)).toBeUndefined();
    expect(
      bench.sql
        .prepare(
          "SELECT 1 FROM knowledge_work WHERE subject_id=? AND status IN ('pending','batched')",
        )
        .get(id),
    ).toBeUndefined();
    expect((await bench.obs.runs({ kind: "data" })).items).toEqual([]);
  });
});
