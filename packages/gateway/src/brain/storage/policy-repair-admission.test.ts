// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createOpenLoop } from "./open-loops.js";
import { createDatabase } from "../../db.js";
import { CONTEXTUAL_VERIFIER } from "../knowledge/claim-context.js";
import { claimDueCognitionRuns, completeCognitionRun, enqueueCognitionRun } from "./run-queue.js";
import type Database from "better-sqlite3";

let db: Database.Database;
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "policy-admission-"));
  db = createDatabase(join(directory, "db"));
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
function add(id: string, kind: "ordinary" | "repair" | "root", due = 100) {
  enqueueCognitionRun(
    db,
    { id, kind: "synthesis", payload: { focus: "knowledge-maintenance", batchId: id } },
    due,
  );
  db.prepare(
    "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES(?,?,'fp','immediate','pending',100,100)",
  ).run(id, id);
  if (kind === "ordinary") return;
  const nodeId = kind === "root" ? "shared-root" : `node-${id}`;
  db.prepare(
    "INSERT OR IGNORE INTO knowledge_nodes VALUES(?,?,NULL,'Overview','A supported statement','A supported statement',1,1,'hash','current','{}','{}',100,100)",
  ).run(nodeId, kind === "root" ? "root" : "wiki");
  db.prepare("INSERT INTO knowledge_batch_regions VALUES(?,?)").run(id, nodeId);
  db.prepare(
    "INSERT INTO knowledge_work(id,subject_id,subject_kind,reason,input_revision,input_changed_at,tier,due_at,created_at,updated_at,status,batch_id) VALUES(?,?,'node','review','1',100,'immediate',100,100,100,'batched',?)",
  ).run(`work-${id}`, nodeId, id);
  if (kind === "repair")
    db.prepare(
      "INSERT INTO knowledge_claims(node_id,id,text,span_start,span_end,support_logic,verification,fingerprint,meaning_revision,meaning_hash,verifier) VALUES(?,'claim','A supported statement',0,21,'all','verified','fp',1,'hash','obsolete')",
    ).run(`node-${id}`);
}
function take(limit = 1, now = 200) {
  const runs = claimDueCognitionRuns(db, { now, limit });
  for (const run of runs) completeCognitionRun(db, run.id, { now, usage: null });
  return runs.map((r) => r.id);
}

describe("bounded proof-policy repair admission", () => {
  test("preserves both reserved shares and half ordinary admissions atomically", () => {
    for (let i = 0; i < 12; i++) add(`ordinary-${i}`, "ordinary", 1);
    for (let i = 0; i < 3; i++) {
      add(`repair-${i}`, "repair");
      add(`root-${i}`, "root");
    }
    const result = take(12);
    for (let i = 0; i < 12; i += 4)
      expect(result.slice(i, i + 4).map((id) => id.split("-")[0])).toEqual([
        "root",
        "repair",
        "ordinary",
        "ordinary",
      ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM cognition_synthesis_admissions").get()).toEqual({
      n: 3,
    });
  });
  test("current proof, forged reason, withdrawn and unbound targets do not acquire preference", () => {
    add("ordinary", "ordinary", 1);
    for (const id of ["current", "forged", "withdrawn", "unbound"]) add(id, "repair");
    db.prepare("UPDATE knowledge_claims SET verifier=? WHERE node_id='node-current'").run(
      CONTEXTUAL_VERIFIER,
    );
    db.exec(
      "DELETE FROM knowledge_claims WHERE node_id='node-forged'; UPDATE cognition_runs SET payload_json=json_set(payload_json,'$.reason','verifier_policy_revalidation') WHERE id='forged'; UPDATE knowledge_nodes SET fields_json='{\"withdrawn\":true}' WHERE id='node-withdrawn'; UPDATE knowledge_batches SET run_id='other' WHERE id='unbound'",
    );
    expect(take()).toEqual(["ordinary"]);
  });
  test("repair classification rechecks changed markers", () => {
    add("repair", "repair");
    add("ordinary", "ordinary", 1);
    db.prepare("UPDATE knowledge_claims SET verifier=?").run(CONTEXTUAL_VERIFIER);
    expect(take()).toEqual(["ordinary"]);
  });
  test.each(["doc_annotation", "person_annotation"] as const)(
    "%s requires an actually active canonical owner",
    (kind) => {
      const table = kind === "doc_annotation" ? "doc_annotations" : "person_annotations";
      const subject = kind === "doc_annotation" ? "doc_id" : "person_id";
      add("ordinary", "ordinary", 1);
      for (const state of ["missing", "invalidated", "superseded", "active"]) {
        add(state, "repair");
        db.prepare("UPDATE knowledge_nodes SET kind=?,owner_id=? WHERE id=?").run(
          kind,
          `owner-${state}`,
          `node-${state}`,
        );
        if (state !== "missing")
          db.prepare(
            `INSERT INTO ${table}(id,${subject},claim_type,claim_text,evidence_doc_id,evidence_quote,confidence,created_by_run,created_at,invalidated_at,superseded_by) VALUES(?,'subject','fact','Statement','source','Statement',1,'run',100,?,?)`,
          ).run(
            `owner-${state}`,
            state === "invalidated" ? 150 : null,
            state === "superseded" ? "successor" : null,
          );
      }
      expect(take()).toEqual(["active"]);
      expect(take()).toEqual(["ordinary"]);
    },
  );
  test("a thousand older ordinary runs cannot bury a current proof repair", () => {
    db.transaction(() => {
      for (let i = 0; i < 1000; i++) add(`ordinary-${i}`, "ordinary", 1);
    })();
    add("repair", "repair");
    expect(take()).toEqual(["repair"]);
  });
  test("restart and same-clock independent claims preserve reservation history", () => {
    add("repair-a", "repair");
    add("repair-b", "repair");
    for (let i = 0; i < 4; i++) add(`ordinary-${i}`, "ordinary", 1);
    expect(take()).toEqual(["repair-a"]);
    db.close();
    db = createDatabase(join(directory, "db"));
    expect(take(3)).toEqual(["ordinary-0", "ordinary-1", "ordinary-2"]);
    expect(take()).toEqual(["repair-b"]);
  });
  test("repeated attempts consume a slot and exclusions/backoff still apply", () => {
    add("repair", "repair");
    add("ordinary", "ordinary", 1);
    expect(claimDueCognitionRuns(db, { now: 200 })[0]?.id).toBe("repair");
    expect(claimDueCognitionRuns(db, { now: 200 })[0]?.id).toBe("ordinary");
    db.exec("UPDATE cognition_runs SET next_attempt_at=999 WHERE id='repair'");
    expect(claimDueCognitionRuns(db, { now: 200, excludeIds: ["ordinary"] })).toEqual([]);
    expect(
      claimDueCognitionRuns(db, { now: 1000, excludeIds: ["ordinary"], maxAttempts: 1 }),
    ).toEqual([]);
  });
  test("parallel-only admission waits for exclusive work without consuming a reservation", () => {
    add("root", "root");
    add("repair", "repair");
    expect(claimDueCognitionRuns(db, { now: 200, parallelOnly: true })).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM cognition_synthesis_admissions").get()).toEqual({
      n: 0,
    });
    expect(claimDueCognitionRuns(db, { now: 200 })[0]?.id).toBe("root");
    expect(
      claimDueCognitionRuns(db, { now: 200, excludeIds: ["root"], parallelOnly: true })[0]?.id,
    ).toBe("repair");
  });
  test("one root repair consumes both reservations, and unused shares do not idle", () => {
    add("root", "repair");
    db.exec("UPDATE knowledge_nodes SET kind='root' WHERE id='node-root'");
    add("repair", "repair");
    for (let i = 0; i < 3; i++) add(`ordinary-${i}`, "ordinary", 1);
    expect(take(4)).toEqual(["root", "ordinary-0", "ordinary-1", "ordinary-2"]);
    expect(take()).toEqual(["repair"]);
  });
});

test.each(["open", "done", "missing", "current"] as const)(
  "loop repair admission requires retained owner and old proof: %s",
  (state) => {
    add("ordinary", "ordinary", 1);
    {
      add(state, "repair");
      db.prepare("UPDATE knowledge_nodes SET kind='loop',owner_id=? WHERE id=?").run(
        `owner-${state}`,
        `node-${state}`,
      );
      if (state !== "missing") {
        createOpenLoop(
          db,
          {
            id: `owner-${state}`,
            title: "Prepare display",
            createdByRun: "seed",
            confidence: 0.8,
            importance: 0.5,
          },
          100,
        );
        if (state === "done")
          db.prepare("UPDATE open_loops SET state='done' WHERE id=?").run(`owner-${state}`);
      }
      if (state === "current")
        db.prepare("UPDATE knowledge_claims SET verifier=? WHERE node_id=?").run(
          CONTEXTUAL_VERIFIER,
          `node-${state}`,
        );
    }
    expect(take()).toEqual([state === "open" || state === "done" ? state : "ordinary"]);
  },
);
