// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createKnowledgeTables } from "../knowledge/schema.js";
import { createBriefsStorageTables } from "./schema.js";
import { createOpenLoop, getOpenLoop, updateOpenLoop } from "./open-loops.js";
import {
  createConsumptionEdgesTables,
  mutateWithConsumptionDependencies,
} from "./consumption-edges.js";
import { captureOutcomeWriteFence } from "./outcome-write-fence.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,content_hash TEXT,source_id TEXT); INSERT INTO documents VALUES('source','v1','fictional')",
  );
  createBriefsStorageTables(db);
  createConsumptionEdgesTables(db);
  createKnowledgeTables(db);
  createOpenLoop(
    db,
    {
      id: "task",
      createdByRun: "seed",
      title: "Prepare the workshop",
      confidence: 0.8,
      importance: 0.5,
      docs: ["source"],
    },
    1,
  );
});
afterEach(() => db.close());

it.each(["edited", "deleted", "withdrawn"])(
  "rejects %s evidence before running the mutation",
  (change) => {
    const outcomeFence = captureOutcomeWriteFence(db, "task", ["source"]);
    if (change === "edited") db.exec("UPDATE documents SET content_hash='v2'");
    else if (change === "deleted") db.exec("DELETE FROM documents");
    else
      db.exec(
        "INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) VALUES('source','v1',1,2)",
      );
    const mutate = vi.fn(() => updateOpenLoop(db, "task", { state: "done" }, 2));
    expect(
      mutateWithConsumptionDependencies(
        db,
        { priors: [], runId: "run", outcomeFence },
        "loop",
        "task",
        2,
        mutate,
      ),
    ).toEqual({ ok: false, dead: [], conflict: "evidence_changed" });
    expect(mutate).not.toHaveBeenCalled();
    expect(getOpenLoop(db, "task")?.state).toBe("open");
  },
);

it("rejects a concurrent owner edit even when last_update does not change", () => {
  const outcomeFence = captureOutcomeWriteFence(db, "task", ["source"]);
  updateOpenLoop(db, "task", { description: "The venue is still undecided." }, 1);
  const mutate = vi.fn(() => updateOpenLoop(db, "task", { state: "done" }, 2));
  expect(
    mutateWithConsumptionDependencies(
      db,
      { priors: [], runId: "run", outcomeFence },
      "loop",
      "task",
      2,
      mutate,
    ),
  ).toEqual({ ok: false, dead: [], conflict: "outcome_changed" });
  expect(mutate).not.toHaveBeenCalled();
  expect(getOpenLoop(db, "task")?.description).toBe("The venue is still undecided.");
});

it("allows the unchanged snapshot and checks inside the writer transaction", () => {
  const outcomeFence = captureOutcomeWriteFence(db, "task", ["source"]);
  const result = mutateWithConsumptionDependencies(
    db,
    { priors: [], runId: "run", outcomeFence },
    "loop",
    "task",
    2,
    () => {
      expect(db.inTransaction).toBe(true);
      return updateOpenLoop(db, "task", { state: "done" }, 2);
    },
  );
  expect(result).toMatchObject({ ok: true, value: { state: "done" } });
});

it("pins absence when admitting a new outcome", () => {
  const outcomeFence = captureOutcomeWriteFence(db, "new-task", ["source"]);
  createOpenLoop(
    db,
    {
      id: "new-task",
      createdByRun: "other",
      title: "Arrange supplies",
      confidence: 0.8,
      importance: 0.5,
    },
    2,
  );
  const mutate = vi.fn();
  expect(
    mutateWithConsumptionDependencies(
      db,
      { priors: [], runId: "run", outcomeFence },
      "loop",
      "new-task",
      3,
      mutate,
    ),
  ).toEqual({ ok: false, dead: [], conflict: "outcome_changed" });
  expect(mutate).not.toHaveBeenCalled();
});

it("allows owner-only dismissal when old evidence is unavailable", () => {
  db.exec("DELETE FROM documents");
  const outcomeFence = captureOutcomeWriteFence(db, "task", []);
  const result = mutateWithConsumptionDependencies(
    db,
    { priors: [], runId: "run", outcomeFence },
    "loop",
    "task",
    2,
    () => updateOpenLoop(db, "task", { state: "dismissed" }, 2),
  );
  expect(result).toMatchObject({ ok: true, value: { state: "dismissed" } });
});

it("rejects an evidence ABA generation even when body and framing return to the snapshot", () => {
  db.exec(
    "INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at,generation) VALUES('source','v1',0,1,1)",
  );
  const outcomeFence = captureOutcomeWriteFence(db, "task", ["source"]);
  db.exec(
    "UPDATE documents SET content_hash='v2'; UPDATE knowledge_source_revisions SET content_hash='v2',generation=2; UPDATE documents SET content_hash='v1'; UPDATE knowledge_source_revisions SET content_hash='v1',generation=3",
  );
  const mutate = vi.fn(() => updateOpenLoop(db, "task", { state: "done" }, 2));
  expect(
    mutateWithConsumptionDependencies(
      db,
      { priors: [], runId: "run", outcomeFence },
      "loop",
      "task",
      2,
      mutate,
    ),
  ).toEqual({ ok: false, dead: [], conflict: "evidence_changed" });
  expect(mutate).not.toHaveBeenCalled();
});
