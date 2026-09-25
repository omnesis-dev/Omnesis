// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { artifactProvenance } from "./artifact-provenance.js";
import { createRunAttributionTable, recordRunAttribution } from "./storage/run-attribution.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  createRunAttributionTable(db);
});

afterEach(() => db.close());

describe("artifactProvenance", () => {
  it("names the procedure, its version, and the model", () => {
    recordRunAttribution(db, {
      runId: "run_1",
      workflowId: "daily-source-review",
      workflowVersion: 3,
      modelId: "some-model",
      settledAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    });

    expect(artifactProvenance(db, "run_1")).toEqual({
      runId: "run_1",
      workflow: { id: "daily-source-review", label: "Daily source review", version: 3 },
      modelId: "some-model",
      settledAt: "2026-01-02T03:04:05.000Z",
    });
  });

  it("says so plainly when the artifact predates attribution", () => {
    // An artifact older than the ledger genuinely cannot be explained.
    // Inventing a plausible workflow would make the surface less trustworthy
    // than admitting the gap.
    expect(artifactProvenance(db, "run_from_an_older_build")).toEqual({
      runId: "run_from_an_older_build",
      workflow: null,
      modelId: null,
      settledAt: null,
    });
  });

  it("reports no workflow for an id this build does not know", () => {
    // How a downgraded gateway reads an artifact a newer one produced: the
    // run is attributed, but to a procedure this build cannot name.
    recordRunAttribution(db, {
      runId: "run_2",
      workflowId: "some-future-workflow" as never,
      workflowVersion: 1,
      modelId: "m",
      settledAt: 1,
    });
    const out = artifactProvenance(db, "run_2");
    expect(out.workflow).toBeNull();
    // The rest still resolves — a partial answer beats none.
    expect(out.modelId).toBe("m");
    expect(out.settledAt).not.toBeNull();
  });

  it("reports a missing model id as absent rather than an empty string", () => {
    recordRunAttribution(db, {
      runId: "run_3",
      workflowId: "noticing",
      workflowVersion: 1,
      modelId: "",
      settledAt: 1,
    });
    expect(artifactProvenance(db, "run_3").modelId).toBeNull();
  });
});
