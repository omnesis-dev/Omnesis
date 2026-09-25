// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  countAttributedRunsByWorkflow,
  createRunAttributionTable,
  getRunAttribution,
  recordRunAttribution,
  runIdsBelowWorkflowVersion,
} from "./run-attribution.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  createRunAttributionTable(db);
});

afterEach(() => db.close());

const attribution = (over: Partial<Parameters<typeof recordRunAttribution>[1]> = {}) => ({
  runId: "run_1",
  workflowId: "datum-intake" as const,
  workflowVersion: 1,
  modelId: "some-model",
  settledAt: 1_700_000_000_000,
  ...over,
});

describe("run attribution", () => {
  it("records and reads back what produced a run's output", () => {
    recordRunAttribution(db, attribution());
    expect(getRunAttribution(db, "run_1")).toEqual(attribution());
  });

  it("returns null for a run that predates attribution", () => {
    // Runs settled before the table existed carry no row, and that is not the
    // same claim as "produced by nothing".
    expect(getRunAttribution(db, "run_from_an_older_build")).toBeNull();
  });

  it("survives the run row being pruned", () => {
    // The whole point: `created_by_run` on a durable artifact outlives the
    // queue row it names, so provenance has to live somewhere that is not
    // pruned. Nothing here references cognition_runs, which is the property.
    recordRunAttribution(db, attribution());
    expect(getRunAttribution(db, "run_1")?.workflowId).toBe("datum-intake");
  });

  it("is idempotent on the run id, keeping the attempt that settled", () => {
    // A soft-failed attempt settles, then the retry settles again. The run
    // should end attributed to the model that actually finished it.
    recordRunAttribution(db, attribution({ modelId: "first-attempt", settledAt: 1 }));
    recordRunAttribution(db, attribution({ modelId: "second-attempt", settledAt: 2 }));
    expect(getRunAttribution(db, "run_1")).toMatchObject({
      modelId: "second-attempt",
      settledAt: 2,
    });
    expect(countAttributedRunsByWorkflow(db)).toEqual([{ workflowId: "datum-intake", runs: 1 }]);
  });
});

describe("finding artifacts produced under superseded rules", () => {
  beforeEach(() => {
    recordRunAttribution(db, attribution({ runId: "old_a", workflowVersion: 1, settledAt: 10 }));
    recordRunAttribution(db, attribution({ runId: "old_b", workflowVersion: 1, settledAt: 20 }));
    recordRunAttribution(db, attribution({ runId: "current", workflowVersion: 2, settledAt: 30 }));
    recordRunAttribution(
      db,
      attribution({ runId: "other_workflow", workflowId: "noticing", workflowVersion: 1 }),
    );
  });

  it("returns the runs of one workflow below a version, oldest first", () => {
    expect(runIdsBelowWorkflowVersion(db, "datum-intake", 2)).toEqual(["old_a", "old_b"]);
  });

  it("does not reach across workflows", () => {
    // A version bump to one workflow says nothing about another's artifacts.
    expect(runIdsBelowWorkflowVersion(db, "noticing", 2)).toEqual(["other_workflow"]);
  });

  it("returns nothing when the current version is the floor", () => {
    expect(runIdsBelowWorkflowVersion(db, "datum-intake", 1)).toEqual([]);
  });

  it("omits runs with no attribution, rather than treating them as stale", () => {
    // "We cannot tell what produced this" must not read as "this is stale" —
    // otherwise the first version bump after an upgrade reprocesses a corpus.
    db.prepare("DELETE FROM cognition_run_attribution WHERE run_id = 'old_a'").run();
    expect(runIdsBelowWorkflowVersion(db, "datum-intake", 99)).toEqual(["old_b", "current"]);
  });
});
