// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A firing carries two times, and only one of them is a clock.
 *
 * The engine runs on journal time: an event's semantic time *is* the engine's
 * now, which is what makes a replay reach the same answers as the live run. So
 * a firing is stamped with when the thing it is about happened, and for most
 * watches that is also when the watch spoke — the two are the same instant.
 *
 * They come apart whenever a watch is about something that already had a date.
 * A calendar event created in June and moved today has a semantic time in June,
 * so its firing is stamped June. Read as a record of what a watch is about,
 * that is right. Read as a ledger of when the watch spoke — which is what a
 * list of firings is for — it says the watch fired last month, and an operator
 * checking whether their stimulus worked sees a firing that appears to predate
 * it.
 *
 * So the moment the runtime recorded the firing is kept alongside, and the two
 * never have to be confused for one another.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DatabaseConstructor from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { watchDslSchema } from "../dsl/schema.js";
import { AnalyticsDatabase } from "../universe/analytics.js";
import { analyticsDir, loadOntology } from "../universe/paths.js";
import { validateWatch } from "../validator/validate.js";
import { WatchEngine } from "./engine.js";
import { CountingJudge, ScriptedRecall } from "./providers.js";
import { WatchStateStore } from "./state.js";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "watch2-firing-times-"));
  scratch.push(dir);
  return dir;
}

/** The operator's case: an event dated long before the change that fired. */
const SUBJECT_TIME = "2026-07-07T19:20:04.000Z";
/** When the journal saw that change — a month after the event's own date. */
const NOTICED = "2026-08-08T08:46:38.093Z";

describe("the two times on a firing", () => {
  it("keeps when the runtime recorded it, not only what it is about", () => {
    const store = new WatchStateStore();
    store.recordFiring(
      "w-1",
      10417,
      "event_changed",
      "k:0",
      SUBJECT_TIME,
      { moved: true },
      NOTICED,
      [],
    );

    const [firing] = store.firings("w-1");
    expect(firing?.firedAt, "the subject's time was not preserved").toBe(SUBJECT_TIME);

    expect(firing?.noticedAt, "no record of when the watch actually spoke").toBe(NOTICED);
    // The point of the whole change: a month between the two, and the ledger
    // must not report the older one as the moment the watch fired.
    expect(Date.parse(NOTICED) - Date.parse(SUBJECT_TIME)).toBeGreaterThan(
      20 * 24 * 60 * 60 * 1000,
    );
    store.close();
  });

  it("records the absence honestly when the caller has no moment to give", () => {
    // A null says "not recorded". A clock read here would invent one, and this
    // package deliberately reads none — a replay of the same journal has to
    // reach the same answers.
    const store = new WatchStateStore();
    store.recordFiring("w-1", 1, "n", "k:0", SUBJECT_TIME, {}, null, []);
    expect(store.firings("w-1")[0]?.noticedAt).toBeNull();
    store.close();
  });

  it("still discards a replayed firing rather than restamping it", () => {
    // The idempotency the unique constraint gives is the reason a resumed run
    // does not double-count. A second attempt must not quietly move the time
    // either, or a replay would rewrite history to say the watch spoke today.
    const store = new WatchStateStore();
    expect(
      store.recordFiring("w-1", 7, "n", "k:0", SUBJECT_TIME, {}, "2026-08-08T08:00:00.000Z", []),
    ).toBe(true);
    expect(
      store.recordFiring("w-1", 7, "n", "k:0", SUBJECT_TIME, {}, "2026-08-09T09:00:00.000Z", []),
      "the replay was counted as a new firing",
    ).toBe(false);

    const firings = store.firings("w-1");
    expect(firings).toHaveLength(1);
    expect(firings[0]?.noticedAt, "the replay restamped the original").toBe(
      "2026-08-08T08:00:00.000Z",
    );
    store.close();
  });
});

describe("a store written before this column existed", () => {
  it("gains it on open, and reads its old firings as undated rather than failing", () => {
    // The live store is a file that already exists, and `CREATE TABLE IF NOT
    // EXISTS` does nothing to it. Without the additive upgrade the first query
    // naming the column fails and the whole runtime is down.
    const path = join(tempDir(), "old.db");
    const legacy = new DatabaseConstructor(path);
    legacy.exec(`
      CREATE TABLE watch_firings (
        watch_id     TEXT NOT NULL,
        seq          INTEGER NOT NULL,
        node_id      TEXT NOT NULL,
        key_hash     TEXT NOT NULL,
        fired_at     TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE (watch_id, seq, node_id, key_hash)
      )`);
    legacy
      .prepare(
        `INSERT INTO watch_firings (watch_id, seq, node_id, key_hash, fired_at, payload_json)
         VALUES ('w-1', 1, 'n', 'k:0', ?, '{}')`,
      )
      .run(SUBJECT_TIME);
    legacy.close();

    const store = new WatchStateStore(path);
    const [old] = store.firings("w-1");
    expect(old?.firedAt, "the existing firing was lost").toBe(SUBJECT_TIME);
    expect(old?.noticedAt, "an unrecorded moment must read as absent, not as a guess").toBeNull();

    // And the upgraded store records the moment from here on.
    store.recordFiring("w-1", 2, "n", "k:0", SUBJECT_TIME, {}, NOTICED, []);
    expect(store.firings("w-1")[1]?.noticedAt).toBe(NOTICED);
    store.close();
  });

  it("is safe to open twice — the upgrade does not run again", () => {
    const path = join(tempDir(), "twice.db");
    const first = new WatchStateStore(path);
    first.recordFiring("w-1", 1, "n", "k:0", SUBJECT_TIME, {}, "2026-08-08T08:00:00.000Z", []);
    first.close();

    const second = new WatchStateStore(path);
    expect(second.firings("w-1")[0]?.noticedAt).toBe("2026-08-08T08:00:00.000Z");
    second.close();
  });
});

describe("the engine, end to end", () => {
  it("stamps a firing with the journal's observation, not the document's date", async () => {
    // The live shape exactly: a calendar event whose semantic time is its
    // creation a month ago, changed today. Nothing but the journal envelope
    // says when that change was seen.
    const ontology = loadOntology();
    const raw = {
      watch: {
        name: "moved-again",
        firing_policy: "stays_active",
        ontology_fingerprint: ontology.fingerprint,
        nodes: [
          {
            id: "changed",
            type: "source.document_event",
            filter: {
              source: "google-calendar",
              event: ["updated"],
              documentType: "calendar-event",
            },
            output_map: { doc_id: "$e.docId" },
          },
        ],
        sink: { input: "changed", output_map: { evidence: "$n.changed.doc_id" } },
      },
    };
    const result = validateWatch(raw, ontology);
    expect(result.valid, result.diagnostics.map((d) => d.code).join(", ")).toBe(true);

    const analytics = await AnalyticsDatabase.materialize(ontology, analyticsDir(), "projections");
    const store = new WatchStateStore();
    try {
      const engine = new WatchEngine({
        watch: watchDslSchema.parse(raw).watch,
        ontology,
        store,
        watchId: "w-moved",
        journal: [
          {
            seq: 10417,
            kind: "doc.event",
            occurredAt: SUBJECT_TIME,
            observedAt: NOTICED,
            payload: {
              op: "updated",
              docId: "doc-1",
              sourceId: "google-calendar",
              providerId: "google",
              documentType: "calendar-event",
              title: "An appointment",
              semanticTime: SUBJECT_TIME,
              changedFields: ["metadata"],
              contentChanged: true,
              metadata: {},
              people: [],
            },
          },
        ] as never,
        analytics,
        judge: new CountingJudge(),
        recall: new ScriptedRecall([], 0),
      });
      const trace = await engine.run();
      expect(trace.firings.length, "the fixture did not fire").toBe(1);

      const [firing] = store.firings("w-moved");
      expect(firing?.firedAt, "the subject's time was not kept").toBe(SUBJECT_TIME);
      expect(firing?.noticedAt, "the engine did not carry the journal's observation").toBe(NOTICED);
    } finally {
      store.close();
      analytics.close();
    }
  });
});
