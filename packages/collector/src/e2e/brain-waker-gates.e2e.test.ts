// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Relevance gates, independent thread evidence, and derivation readiness at real intake boundaries. */
import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  compressCognitionCadences,
  email,
  note,
  preserveCurrentOwner,
  sourceInterpretations,
  waitFor,
  type DecisionServerRequest,
} from "./brain-bench/index.js";
compressCognitionCadences();
function decision(request: DecisionServerRequest) {
  const purpose = Object.keys(request.questions)[0]!;
  const state = request.state as { title?: string; source?: { title: string } };
  const title = state.source?.title ?? state.title ?? "";
  return { [purpose]: { type: "score" as const, score: title.startsWith("Discard") ? 0 : 2 } };
}
function coverage(bench: BrainBench, id: string) {
  return bench.sql
    .prepare<
      [string],
      { input_revision: string; status: string }
    >("SELECT input_revision,status FROM knowledge_discovery_coverage WHERE subject_id=? AND phase='organization'")
    .all(id);
}
describe("Brain intake — gates and readiness", () => {
  let bench: BrainBench;
  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      brain: {
        knowledge: { soonDelay: "0s", routineDelay: "0s", maxSeeds: 8, maxFrontierNodes: 8 },
        mergeAdjudication: { enabled: false },
      },
      decision: { policy: decision },
      extraGatewayConfig: {
        enrichment: { dates: { enabled: false } },
        gateway: { backfill: { links: { interval: "1h", idleDelay: "1h" } } },
      },
      behaviors: {
        dynamic: sourceInterpretations({
          sources: [{ plan: { calls: [] } }],
          maintainNode: preserveCurrentOwner,
        }),
      },
    });
    await bench.drainUntilQuiet();
  }, 300_000);
  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("irrelevant automated, rollup and low-signal sources settle gated while controls are interpreted", async () => {
    const docs = [
      email({
        externalId: "gate-automated",
        title: "Discard automated receipt",
        metadata: { automated: true },
        content: "A generic automatic receipt with no personal context.",
      }),
      note({
        externalId: "gate-rollup",
        title: "Discard aggregate counters",
        metadata: { rollup: true },
        content: "Aggregate counters with no actionable context.",
      }),
      note({
        externalId: "gate-low-signal",
        title: "Discard low-signal transcript",
        metadata: { lowSignal: true },
        content: "An empty generic transcript.",
      }),
      email({
        externalId: "gate-control",
        title: "Workshop confirmation",
        content: "The workshop is confirmed for Thursday.",
      }),
    ];
    const ids = await bench.pushAndSettle(docs);
    for (let i = 0; i < ids.length; i++) {
      const rows = coverage(bench, ids[i]!);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe(i === 3 ? "considered" : "gated");
      if (i < 3) expect(await bench.obs.runsForSource(ids[i]!)).toEqual([]);
    }
  }, 180_000);

  test("useful dated context is interpreted even when its normalized sender markers are automated", async () => {
    const docs = ["bulkMail", "automated", "rollup", "lowSignal"].map((marker, i) =>
      email({
        externalId: `gate-useful-${i}`,
        title: `Useful workshop deadline ${i}`,
        content: "Please confirm the workshop booking by Friday.",
        metadata: { [marker]: true },
      }),
    );
    const ids = await bench.pushAndSettle(docs);
    for (const id of ids)
      expect(coverage(bench, id).some((row) => row.status === "considered")).toBe(true);
  }, 180_000);

  test("same-thread messages retain independent evidence identities inside maintenance batches", async () => {
    const docs = [1, 2, 3].map((n) =>
      email({
        externalId: `gate-thread-${n}`,
        title: `Workshop thread revision ${n}`,
        content: `Workshop update ${n}.`,
        metadata: { threadId: "fictional-workshop-thread" },
      }),
    );
    const ids = await bench.pushAndSettle(docs);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids)
      expect(coverage(bench, id).some((row) => row.status === "considered")).toBe(true);
    expect((await bench.obs.runs({ kind: "data" })).items).toEqual([]);
  }, 180_000);

  test("metadata-only resync preserves content coverage while a real edit receives a new input revision", async () => {
    const doc = email({
      externalId: "gate-metadata",
      title: "Workshop deposit",
      content: "The deposit is due on Friday.",
    });
    const [id] = await bench.pushAndSettle([doc]);
    const first = coverage(bench, id!)[0]!.input_revision;
    await bench.pushAndSettle([{ ...doc, metadata: { ...doc.metadata, read: true } }]);
    expect(coverage(bench, id!)).toHaveLength(1);
    await bench.update(doc, "The deposit is due on Monday.");
    await bench.drainUntilQuiet();
    const versions = coverage(bench, id!).map((row) => row.input_revision);
    expect(versions).toHaveLength(2);
    expect(versions).toContain(first);
  }, 180_000);

  test("the derivation barrier parks durable source work and releases immediately when columns become ready", async () => {
    const control = email({
      externalId: "gate-derivation-anchor",
      title: "Derivation anchor",
      content: "An invented workshop anchor.",
    });
    const [controlId] = await bench.pushAndSettle([control]);
    await bench.patchConfig({ brain: { derivationBarrier: "1h" } });
    const anchor = bench.sql
      .prepare<
        [string],
        { provider_id: string; source_id: string }
      >("SELECT provider_id,source_id FROM documents WHERE id=?")
      .get(controlId!)!;
    const stamp = "2020-01-01T00:00:00.000Z";
    // Valid source-reference IDs sort ahead of UUIDs, keeping the derivation
    // subject behind the filler backlog while every arrival remains interpretable.
    bench.withWriteHandle((db) =>
      db.transaction(() => {
        const insert = db.prepare(
          "INSERT INTO documents(id,provider_id,source_id,external_id,stream_id,title,content,content_hash,metadata,source_created_at,source_updated_at,ingested_at,updated_at) VALUES(?,?,?,?, '',?,?,?,'{}',?,?,?,?)",
        );
        for (let i = 0; i < 60; i++)
          insert.run(
            `0-readiness-wall-${i}`,
            anchor.provider_id,
            anchor.source_id,
            `readiness-wall-${i}`,
            `Readiness filler ${i}`,
            `Invented filler ${i}.`,
            `readiness-fingerprint-${i}`,
            stamp,
            stamp,
            stamp,
            stamp,
          );
      })(),
    );
    const doc = email({
      externalId: "gate-readiness-subject",
      title: "Workshop readiness subject",
      content: "The workshop schedule needs interpretation.",
    });
    await bench.push(doc);
    const id = await bench.docId(doc.externalId);
    const held = await waitFor(
      "source work held for derivation",
      () =>
        bench.sql
          .prepare<
            [string],
            { id: string; last_error: string }
          >("SELECT id,last_error FROM knowledge_work WHERE subject_id=? AND status='pending' AND last_error='derivation'")
          .get(id) ?? null,
      60_000,
    );
    expect(held.last_error).toBe("derivation");
    expect(await bench.obs.runsForSource(id)).toEqual([]);
    bench.withWriteHandle((db) =>
      db
        .prepare(
          "UPDATE documents SET links_extracted_at=?,people_resolved_at=? WHERE id=? OR id LIKE '0-readiness-wall-%'",
        )
        .run(new Date().toISOString(), new Date().toISOString(), id),
    );
    await bench.drainUntilQuiet({ timeoutMs: 180_000, stallMs: 60_000 });
    expect((await bench.obs.interpretationForSource(id)).status).toBe("completed");
    expect(
      bench.sql
        .prepare("SELECT 1 FROM knowledge_work WHERE id=? AND status IN ('pending','batched')")
        .get(held.id),
    ).toBeUndefined();
  }, 240_000);
});
