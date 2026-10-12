// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Observation repository over a real gateway store: create/read round trips,
 * the terminal-state guard on every transition, the loop and document
 * cascades, expiry, the retention prune into `observation_outcomes`, and the
 * "would have pushed" log.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../../db.js";
import {
  createObservation,
  deleteObservationsAttachedToLoops,
  deleteObservationsCitingDocs,
  dropObservationsForResolvedLoop,
  expireObservations,
  findOpenObservationsForLoops,
  getObservation,
  hasAnyObservations,
  listObservationOutcomes,
  listObservations,
  listObservationsForLoop,
  listOpenObservations,
  listWouldPushLog,
  pruneClosedObservations,
  recordObservationClaims,
  recordObservationScores,
  setObservationUserAction,
  transitionObservation,
  type CreateObservationInput,
} from "./observations.js";
import { createOpenLoop } from "./open-loops.js";
import type { ObservationScores } from "./types.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const DAY = 86_400_000;
const T0 = Date.parse("2026-07-02T08:00:00.000Z");

function doc(externalId: string, content: string, sourceId = "mail-fixture"): DocumentInput {
  return {
    providerId: ProviderId("google"),
    sourceId: SourceId(sourceId),
    externalId,
    title: `Message ${externalId}`,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    sourceCreatedAt: "2026-07-01T09:00:00.000Z",
    sourceUpdatedAt: "2026-07-01T09:00:00.000Z",
    metadata: { documentType: "email" },
  };
}

function scores(partial: Partial<ObservationScores> = {}): ObservationScores {
  return {
    alreadyKnown: 0,
    consequence: 3,
    timing: 2,
    modelId: "scripted-decision",
    at: T0,
    ...partial,
  };
}

describe("observation repository", () => {
  let path: string;
  let db: Db;
  let docA: string;
  let docB: string;
  let docC: string;

  function docId(externalId: string): string {
    return db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
      .get(externalId)!.id;
  }

  function note(id: string, input: Partial<CreateObservationInput> = {}, now = T0) {
    return createObservation(
      db,
      { id, createdByRun: "run_note", summary: `Observation ${id}`, ...input },
      now,
    );
  }

  function loop(id: string, state: "open" | "snoozed" | "done" | "dismissed" = "open") {
    return createOpenLoop(
      db,
      {
        id,
        createdByRun: "run_loop",
        title: `Loop ${id}`,
        confidence: 0.8,
        importance: 0.5,
        state,
      },
      T0,
    );
  }

  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(path);
    upsertDocuments(db, [
      doc("a", "The studio rent invoice is due on Friday."),
      doc("b", "Workshop venue confirmed for the 14th.", "drive-fixture"),
      doc("c", "Reminder: renew the parking permit."),
    ]);
    docA = docId("a");
    docB = docId("b");
    docC = docId("c");
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
  });

  describe("create and read", () => {
    test("round-trips every field, deduplicating citations in order and sorting related loops", () => {
      loop("loop_b");
      loop("loop_a");
      const noted = scores({ consequence: 4, timing: 3 });
      const created = note("obs_1", {
        why: "Late payment adds a fee.",
        userAuthored: true,
        windowStart: T0 + DAY,
        relevantUntil: T0 + 3 * DAY,
        citations: [docB, docA, docB],
        relatedLoopIds: ["loop_b", "loop_a"],
        claims: [{ docId: docA, quote: "rent invoice is due", verification: "unverified" }],
        notedScores: noted,
        wouldPushAt: T0,
      });
      expect(created).toMatchObject({
        id: "obs_1",
        createdByRun: "run_note",
        summary: "Observation obs_1",
        why: "Late payment adds a fee.",
        userAuthored: true,
        windowStart: T0 + DAY,
        relevantUntil: T0 + 3 * DAY,
        citations: [docB, docA],
        relatedLoopIds: ["loop_a", "loop_b"],
        claims: [{ docId: docA, quote: "rent invoice is due", verification: "unverified" }],
        state: "live",
        closeReason: null,
        notedScores: noted,
        scores: null,
        wouldPushAt: T0,
        shippedAt: null,
        shippedConversationId: null,
        shippedMessageId: null,
        userAction: null,
        createdAt: T0,
        updatedAt: T0,
        closedAt: null,
      });
      expect(getObservation(db, "obs_1")).toEqual(created);
    });

    test("defaults optional fields", () => {
      expect(note("obs_min")).toMatchObject({
        why: "",
        userAuthored: false,
        windowStart: null,
        relevantUntil: null,
        citations: [],
        relatedLoopIds: [],
        claims: [],
        notedScores: null,
        wouldPushAt: null,
      });
    });

    test("an unknown id reads as null", () => {
      expect(getObservation(db, "obs_missing")).toBeNull();
    });

    test("tolerates corrupt stored JSON", () => {
      note("obs_corrupt");
      db.prepare(
        "UPDATE observations SET claims_json = 'not json', scores_json = '{', noted_scores_json = 'x' WHERE id = 'obs_corrupt'",
      ).run();
      expect(getObservation(db, "obs_corrupt")).toMatchObject({
        claims: [],
        scores: null,
        notedScores: null,
      });
      db.prepare(
        "UPDATE observations SET claims_json = '{\"a\":1}' WHERE id = 'obs_corrupt'",
      ).run();
      expect(getObservation(db, "obs_corrupt")?.claims).toEqual([]);
    });

    test("hasAnyObservations reflects whether a row exists", () => {
      expect(hasAnyObservations(db)).toBe(false);
      note("obs_1");
      expect(hasAnyObservations(db)).toBe(true);
    });
  });

  describe("listing", () => {
    beforeEach(() => {
      note("obs_1", { createdByRun: "run_x" }, T0);
      note("obs_2", {}, T0 + 1);
      note("obs_3", { createdByRun: "run_x" }, T0 + 2);
      transitionObservation(db, "obs_2", { state: "held", reason: "below_bar" }, T0 + 5);
      transitionObservation(db, "obs_3", { state: "dropped", reason: "withdrawn" }, T0 + 6);
    });

    test("listObservations is newest-created first with state, run and cursor filters", () => {
      expect(listObservations(db).map((o) => o.id)).toEqual(["obs_3", "obs_2", "obs_1"]);
      expect(listObservations(db, { states: ["live", "held"] }).map((o) => o.id)).toEqual([
        "obs_2",
        "obs_1",
      ]);
      expect(listObservations(db, { states: [] }).map((o) => o.id)).toHaveLength(3);
      expect(listObservations(db, { createdByRun: "run_x" }).map((o) => o.id)).toEqual([
        "obs_3",
        "obs_1",
      ]);
      expect(
        listObservations(db, { beforeCreated: { createdAt: T0 + 2, id: "obs_3" } }).map(
          (o) => o.id,
        ),
      ).toEqual(["obs_2", "obs_1"]);
      expect(listObservations(db, { limit: 1 }).map((o) => o.id)).toEqual(["obs_3"]);
    });

    test("listOpenObservations returns live and held only, oldest first", () => {
      expect(listOpenObservations(db).map((o) => o.id)).toEqual(["obs_1", "obs_2"]);
      expect(listOpenObservations(db, 1).map((o) => o.id)).toEqual(["obs_1"]);
    });
  });

  describe("loop attachments", () => {
    beforeEach(() => {
      loop("loop_1");
      loop("loop_2");
      note("obs_a", { relatedLoopIds: ["loop_1"] }, T0);
      note("obs_b", { relatedLoopIds: ["loop_1", "loop_2"] }, T0 + 1);
      note("obs_c", { relatedLoopIds: ["loop_2"] }, T0 + 2);
      transitionObservation(db, "obs_c", { state: "dropped", reason: "withdrawn" }, T0 + 3);
    });

    test("findOpenObservationsForLoops returns distinct open ones, newest first", () => {
      expect(findOpenObservationsForLoops(db, []).map((o) => o.id)).toEqual([]);
      expect(findOpenObservationsForLoops(db, ["loop_1", "loop_2"]).map((o) => o.id)).toEqual([
        "obs_b",
        "obs_a",
      ]);
      expect(findOpenObservationsForLoops(db, ["loop_2"]).map((o) => o.id)).toEqual(["obs_b"]);
    });

    test("listObservationsForLoop includes closed ones and pages by cursor", () => {
      expect(listObservationsForLoop(db, "loop_2").map((o) => o.id)).toEqual(["obs_c", "obs_b"]);
      expect(
        listObservationsForLoop(db, "loop_2", {
          beforeCreated: { createdAt: T0 + 2, id: "obs_c" },
        }).map((o) => o.id),
      ).toEqual(["obs_b"]);
      expect(listObservationsForLoop(db, "loop_1", { limit: 1 }).map((o) => o.id)).toEqual([
        "obs_b",
      ]);
    });

    test("dropObservationsForResolvedLoop keeps observations another active loop still holds", () => {
      db.prepare("UPDATE open_loops SET state = 'done' WHERE id = 'loop_1'").run();
      expect(dropObservationsForResolvedLoop(db, "loop_1", T0 + 10)).toEqual(["obs_a"]);
      expect(getObservation(db, "obs_a")).toMatchObject({
        state: "dropped",
        closeReason: "superseded",
        closedAt: T0 + 10,
      });
      expect(getObservation(db, "obs_b")?.state).toBe("live");
    });

    test("a snoozed sibling loop still counts as active", () => {
      db.prepare("UPDATE open_loops SET state = 'snoozed' WHERE id = 'loop_2'").run();
      db.prepare("UPDATE open_loops SET state = 'done' WHERE id = 'loop_1'").run();
      expect(dropObservationsForResolvedLoop(db, "loop_1", T0 + 10)).toEqual(["obs_a"]);
      expect(getObservation(db, "obs_b")?.state).toBe("live");
    });

    test("drops shared observations once every related loop is resolved", () => {
      db.prepare("UPDATE open_loops SET state = 'dismissed' WHERE id = 'loop_2'").run();
      db.prepare("UPDATE open_loops SET state = 'done' WHERE id = 'loop_1'").run();
      expect(dropObservationsForResolvedLoop(db, "loop_1", T0 + 10).sort()).toEqual([
        "obs_a",
        "obs_b",
      ]);
      // The already-dropped observation keeps its original reason.
      expect(getObservation(db, "obs_c")?.closeReason).toBe("withdrawn");
    });

    test("deleteObservationsAttachedToLoops deletes open ones, or every one with includeClosed", () => {
      expect(deleteObservationsAttachedToLoops(db, [], { includeClosed: true })).toEqual([]);
      expect(
        deleteObservationsAttachedToLoops(db, ["loop_2"], { includeClosed: false }).sort(),
      ).toEqual(["obs_b"]);
      expect(getObservation(db, "obs_c")).not.toBeNull();
      expect(deleteObservationsAttachedToLoops(db, ["loop_2"], { includeClosed: true })).toEqual([
        "obs_c",
      ]);
      expect(getObservation(db, "obs_c")).toBeNull();
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM observation_related_loops WHERE observation_id IN ('obs_b','obs_c')",
          )
          .get(),
      ).toEqual({ n: 0 });
    });
  });

  describe("state transitions", () => {
    test("live → held keeps the observation open and records reason and scores", () => {
      note("obs_1");
      const s = scores({ consequence: 1 });
      expect(
        transitionObservation(
          db,
          "obs_1",
          { state: "held", reason: "below_bar", scores: s },
          T0 + 1,
        ),
      ).toBe(true);
      expect(getObservation(db, "obs_1")).toMatchObject({
        state: "held",
        closeReason: "below_bar",
        scores: s,
        closedAt: null,
        updatedAt: T0 + 1,
      });
      expect(listOpenObservations(db).map((o) => o.id)).toEqual(["obs_1"]);
    });

    test("held → held again re-scores, and held → shipped stamps the message", () => {
      note("obs_1");
      transitionObservation(db, "obs_1", { state: "held", reason: "below_bar" }, T0 + 1);
      expect(
        transitionObservation(
          db,
          "obs_1",
          { state: "held", reason: "below_bar", scores: scores({ consequence: 1.5 }) },
          T0 + 2,
        ),
      ).toBe(true);
      expect(getObservation(db, "obs_1")?.scores?.consequence).toBe(1.5);
      expect(
        transitionObservation(
          db,
          "obs_1",
          { state: "shipped", shipped: { conversationId: "conv_1", messageId: "msg_1" } },
          T0 + 3,
        ),
      ).toBe(true);
      expect(getObservation(db, "obs_1")).toMatchObject({
        state: "shipped",
        closeReason: null,
        shippedAt: T0 + 3,
        shippedConversationId: "conv_1",
        shippedMessageId: "msg_1",
        closedAt: T0 + 3,
      });
    });

    test("a null scores transition clears the scores; omitted scores leave them", () => {
      note("obs_1");
      recordObservationScores(db, "obs_1", scores(), T0 + 1);
      transitionObservation(db, "obs_1", { state: "held", reason: "below_bar" }, T0 + 2);
      expect(getObservation(db, "obs_1")?.scores).not.toBeNull();
      transitionObservation(db, "obs_1", { state: "held", scores: null }, T0 + 3);
      expect(getObservation(db, "obs_1")).toMatchObject({ scores: null, closeReason: null });
    });

    test("shipped and dropped are terminal: every further transition and rescore is refused", () => {
      note("obs_s");
      note("obs_d");
      transitionObservation(
        db,
        "obs_s",
        { state: "shipped", shipped: { conversationId: "c", messageId: "m" } },
        T0 + 1,
      );
      transitionObservation(db, "obs_d", { state: "dropped", reason: "expired" }, T0 + 1);
      for (const id of ["obs_s", "obs_d"]) {
        const before = getObservation(db, id);
        expect(transitionObservation(db, id, { state: "held", reason: "below_bar" }, T0 + 2)).toBe(
          false,
        );
        expect(
          transitionObservation(db, id, { state: "dropped", reason: "withdrawn" }, T0 + 2),
        ).toBe(false);
        expect(
          transitionObservation(
            db,
            id,
            { state: "shipped", shipped: { conversationId: "c2", messageId: "m2" } },
            T0 + 2,
          ),
        ).toBe(false);
        expect(recordObservationScores(db, id, scores(), T0 + 2)).toBe(false);
        expect(recordObservationClaims(db, id, [], T0 + 2)).toBe(false);
        expect(getObservation(db, id)).toEqual(before);
      }
    });

    test("a missing observation is refused", () => {
      expect(transitionObservation(db, "obs_none", { state: "held" }, T0)).toBe(false);
      expect(recordObservationScores(db, "obs_none", scores(), T0)).toBe(false);
      expect(recordObservationClaims(db, "obs_none", [], T0)).toBe(false);
      expect(setObservationUserAction(db, "obs_none", "completed", T0)).toBe(false);
    });

    test("transition records a user action when given", () => {
      note("obs_1");
      transitionObservation(
        db,
        "obs_1",
        { state: "dropped", reason: "suppressed", userAction: "asked not to see this" },
        T0 + 1,
      );
      expect(getObservation(db, "obs_1")).toMatchObject({
        state: "dropped",
        closeReason: "suppressed",
        userAction: "asked not to see this",
      });
    });

    test("recordObservationScores and recordObservationClaims change an open observation only", () => {
      note("obs_1", {
        citations: [docA],
        claims: [{ docId: docA, quote: "rent invoice is due", verification: "unverified" }],
      });
      const s = scores({ timing: 3 });
      expect(recordObservationScores(db, "obs_1", s, T0 + 1)).toBe(true);
      expect(
        recordObservationClaims(
          db,
          "obs_1",
          [{ docId: docA, quote: "rent invoice is due", verification: "entailed" }],
          T0 + 2,
        ),
      ).toBe(true);
      expect(getObservation(db, "obs_1")).toMatchObject({
        state: "live",
        scores: s,
        claims: [{ verification: "entailed" }],
        updatedAt: T0 + 2,
      });
    });

    test("setObservationUserAction records on a terminal observation too", () => {
      note("obs_1");
      transitionObservation(
        db,
        "obs_1",
        { state: "shipped", shipped: { conversationId: "c", messageId: "m" } },
        T0 + 1,
      );
      expect(setObservationUserAction(db, "obs_1", "completed the task", T0 + 2)).toBe(true);
      expect(getObservation(db, "obs_1")).toMatchObject({
        state: "shipped",
        userAction: "completed the task",
        updatedAt: T0 + 2,
      });
    });
  });

  describe("expiry", () => {
    test("drops open observations whose window ended, at the boundary inclusive", () => {
      note("obs_past", { relevantUntil: T0 + 10 });
      note("obs_edge", { relevantUntil: T0 + 20 });
      note("obs_future", { relevantUntil: T0 + 21 });
      note("obs_unbounded");
      note("obs_held", { relevantUntil: T0 + 5 });
      transitionObservation(db, "obs_held", { state: "held", reason: "below_bar" }, T0 + 1);
      note("obs_closed", { relevantUntil: T0 + 5 });
      transitionObservation(db, "obs_closed", { state: "dropped", reason: "withdrawn" }, T0 + 1);

      expect(expireObservations(db, T0 + 20).sort()).toEqual(["obs_edge", "obs_held", "obs_past"]);
      for (const id of ["obs_past", "obs_edge", "obs_held"])
        expect(getObservation(db, id)).toMatchObject({
          state: "dropped",
          closeReason: "expired",
          closedAt: T0 + 20,
        });
      expect(getObservation(db, "obs_future")?.state).toBe("live");
      expect(getObservation(db, "obs_unbounded")?.state).toBe("live");
      expect(getObservation(db, "obs_closed")?.closeReason).toBe("withdrawn");
      expect(expireObservations(db, T0 + 20)).toEqual([]);
    });
  });

  describe("document deletion (privacy)", () => {
    test("deletes every observation citing a deleted document, whatever its state", () => {
      expect(deleteObservationsCitingDocs(db, [])).toEqual([]);
      note("obs_a", { citations: [docA] });
      note("obs_ab", { citations: [docB, docA] });
      note("obs_c", { citations: [docC] });
      note("obs_shipped", { citations: [docA] });
      transitionObservation(
        db,
        "obs_shipped",
        { state: "shipped", shipped: { conversationId: "c", messageId: "m" } },
        T0 + 1,
      );
      expect(deleteObservationsCitingDocs(db, [docA]).sort()).toEqual([
        "obs_a",
        "obs_ab",
        "obs_shipped",
      ]);
      expect(listObservations(db).map((o) => o.id)).toEqual(["obs_c"]);
      expect(
        db
          .prepare<
            [string],
            { n: number }
          >("SELECT COUNT(*) AS n FROM observation_citations WHERE doc_id = ?")
          .get(docA)?.n,
      ).toBe(0);
    });
  });

  describe("retention prune", () => {
    test("reduces closed observations older than the cutoff to outcomes, oldest first, bounded", () => {
      const noted = scores({ consequence: 4, timing: 3 });
      note("obs_old1", {
        summary:
          "The quarterly studio insurance renewal notice arrived and needs a signature before the end of the month",
        citations: [docA, docB],
        notedScores: noted,
        wouldPushAt: T0,
      });
      note("obs_old2", { citations: [docC] });
      note("obs_old3");
      note("obs_recent");
      note("obs_open");
      transitionObservation(
        db,
        "obs_old1",
        {
          state: "shipped",
          shipped: { conversationId: "c", messageId: "m" },
          scores: scores(),
          userAction: "completed",
        },
        T0 + 1,
      );
      transitionObservation(db, "obs_old2", { state: "dropped", reason: "expired" }, T0 + 2);
      transitionObservation(db, "obs_old3", { state: "dropped", reason: "stale" }, T0 + 3);
      transitionObservation(db, "obs_recent", { state: "dropped", reason: "withdrawn" }, T0 + 50);

      const first = pruneClosedObservations(db, T0 + 10, T0 + 100, 2);
      expect(first).toEqual({ pruned: 2, ids: ["obs_old1", "obs_old2"] });
      const second = pruneClosedObservations(db, T0 + 10, T0 + 101, 2);
      expect(second).toEqual({ pruned: 1, ids: ["obs_old3"] });
      expect(pruneClosedObservations(db, T0 + 10, T0 + 102)).toEqual({ pruned: 0, ids: [] });

      expect(
        listObservations(db)
          .map((o) => o.id)
          .sort(),
      ).toEqual(["obs_open", "obs_recent"]);
      expect(
        db
          .prepare<
            [],
            { n: number }
          >("SELECT COUNT(*) AS n FROM observation_citations WHERE observation_id LIKE 'obs_old%'")
          .get()?.n,
      ).toBe(0);

      const outcomes = listObservationOutcomes(db);
      expect(outcomes.map((o) => o.id)).toEqual(["obs_old3", "obs_old2", "obs_old1"]);
      const old1 = outcomes.find((o) => o.id === "obs_old1")!;
      expect(old1).toEqual({
        id: "obs_old1",
        topic: "The quarterly studio insurance renewal notice arrived and",
        sourceKinds: ["google/drive-fixture", "google/mail-fixture"],
        state: "shipped",
        closeReason: null,
        notedScores: noted,
        scores: scores(),
        wouldPushAt: T0,
        userAction: "completed",
        createdAt: T0,
        closedAt: T0 + 1,
        prunedAt: T0 + 100,
      });
      expect(outcomes.find((o) => o.id === "obs_old2")).toMatchObject({
        state: "dropped",
        closeReason: "expired",
        sourceKinds: ["google/mail-fixture"],
      });
      expect(outcomes.find((o) => o.id === "obs_old3")?.sourceKinds).toEqual([]);
      expect(listObservationOutcomes(db, 1)).toHaveLength(1);
    });

    test("truncates a long topic to 80 characters", () => {
      note("obs_long", { summary: `${"x".repeat(120)} tail` });
      transitionObservation(db, "obs_long", { state: "dropped", reason: "expired" }, T0 + 1);
      pruneClosedObservations(db, T0 + 1, T0 + 2);
      const topic = listObservationOutcomes(db)[0]!.topic;
      expect(topic).toHaveLength(80);
      expect(topic.endsWith("…")).toBe(true);
    });

    test("never prunes an open observation, however old", () => {
      note("obs_live", {}, T0 - 400 * DAY);
      note("obs_held", {}, T0 - 400 * DAY);
      transitionObservation(db, "obs_held", { state: "held", reason: "below_bar" }, T0 - 300 * DAY);
      expect(pruneClosedObservations(db, T0, T0)).toEqual({ pruned: 0, ids: [] });
      expect(listOpenObservations(db)).toHaveLength(2);
    });
  });

  describe("would-have-pushed log", () => {
    test("lists live and pruned observations with a push time, newest push first", () => {
      const noted = scores({ consequence: 4, timing: 3 });
      note("obs_a", { notedScores: noted, wouldPushAt: T0 + 1, relevantUntil: T0 + DAY }, T0 + 1);
      note("obs_b", { notedScores: noted, wouldPushAt: T0 + 5 }, T0 + 5);
      note("obs_none", { notedScores: scores() }, T0 + 6);
      note("obs_pruned", { notedScores: noted, wouldPushAt: T0 + 3 }, T0 + 3);
      transitionObservation(db, "obs_pruned", { state: "dropped", reason: "expired" }, T0 + 4);
      pruneClosedObservations(db, T0 + 4, T0 + 10);
      transitionObservation(
        db,
        "obs_b",
        { state: "shipped", shipped: { conversationId: "c", messageId: "m" } },
        T0 + 7,
      );

      const log = listWouldPushLog(db);
      expect(log.map((e) => e.id)).toEqual(["obs_b", "obs_pruned", "obs_a"]);
      expect(log[0]).toEqual({
        id: "obs_b",
        summary: "Observation obs_b",
        notedScores: noted,
        createdAt: T0 + 5,
        wouldPushAt: T0 + 5,
        state: "shipped",
        shippedAt: T0 + 7,
        relevantUntil: null,
      });
      expect(log[1]).toMatchObject({
        id: "obs_pruned",
        summary: "Observation obs_pruned",
        state: "dropped",
        shippedAt: null,
        relevantUntil: null,
      });
      expect(log[2]).toMatchObject({ state: "live", relevantUntil: T0 + DAY });
      expect(listWouldPushLog(db, 1).map((e) => e.id)).toEqual(["obs_b"]);
    });
  });
});
