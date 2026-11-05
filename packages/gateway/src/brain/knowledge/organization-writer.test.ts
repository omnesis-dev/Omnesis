// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Starting an organization cohort admits the selected sources in one writer
 * transaction: their review work, the batch with its region and frontier, the
 * cohort and its members, and the synthesis run, or nothing at all when the
 * selection no longer holds. Every other write on the gateway waits behind
 * that transaction, so its cost must follow the cohort's few sources, not the
 * knowledge ledgers, which on a real corpus hold hundreds of thousands of work
 * rows and every cohort ever run. These run on the full gateway schema: the
 * transitions of an admission, and the plan of every read the writer runs.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../db.js";
import { KNOWLEDGE_DISCOVERY_POLICY } from "./discovery-policy.js";
import {
  getOrganizationCohortForBatch,
  selectOrganizationCohort,
  type OrganizationCohortSelection,
} from "./organization-cohorts.js";
import { startOrganizationBatch } from "./organization-writer.js";
import { KnowledgeStorageError } from "./types.js";
import { LEDGERS, ledgerScans, queryPlan, recordStatements } from "./test-utils.js";
import type Database from "better-sqlite3";

const NOW = Date.parse("2027-04-06T09:00:00Z");
const DAY = 86_400_000;
/** The ledgers, and the cohort history every admission consults. */
const ORGANIZATION_LEDGERS = [
  ...LEDGERS,
  "knowledge_organization_cohorts",
  "knowledge_organization_members",
];

let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath) as unknown as Database.Database;
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
});

const revision = (id: string) => `hash-${id}:knowledge:1`;

/** A document considered for organization at its current revision. */
function evidence(id: string): void {
  const at = new Date(NOW - DAY).toISOString();
  db.prepare(
    `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,source_created_at,source_updated_at,ingested_at,updated_at)
     VALUES(?,'fixture','fixture-notes',?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    id,
    `Field note ${id}`,
    `The survey crew logged a reading at ${id}.`,
    `hash-${id}`,
    at,
    at,
    at,
    at,
  );
  db.prepare("UPDATE knowledge_source_revisions SET generation=1 WHERE document_id=?").run(id);
  db.prepare(
    `INSERT INTO knowledge_discovery_coverage(subject_id,input_revision,phase,policy_version,status,reviewed_at)
     VALUES(?,?,'organization',?,'considered',?)`,
  ).run(id, revision(id), KNOWLEDGE_DISCOVERY_POLICY, NOW - DAY);
}

function fingerprint(versions: Record<string, string>): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        KNOWLEDGE_DISCOVERY_POLICY,
        Object.entries(versions).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    )
    .digest("hex");
}

/** A completed cohort over `members`, released for a publication retry. */
function releasedCohort(id: string, members: string[], dueAt: number): void {
  const created = NOW - 10 * DAY;
  db.prepare(
    `INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at,finished_at)
     VALUES(?,?,'fixture','routine','completed',?,?,?)`,
  ).run(`kb-${id}`, `cog-${id}`, created, created, created);
  const versions = Object.fromEntries(members.map((member) => [member, revision(member)]));
  db.prepare(
    `INSERT INTO knowledge_organization_cohorts(id,batch_id,input_fingerprint,policy_version,status,retry_at,created_at,updated_at,retrieval_reconsidered,retrieval_reconsider_at)
     VALUES(?,?,?,?,'completed',?,?,?,1,?)`,
  ).run(
    id,
    `kb-${id}`,
    fingerprint(versions),
    KNOWLEDGE_DISCOVERY_POLICY,
    created + DAY,
    created,
    created,
    dueAt,
  );
  for (const member of members)
    db.prepare(
      "INSERT INTO knowledge_organization_members(cohort_id,source_id,content_hash) VALUES(?,?,?)",
    ).run(id, member, revision(member));
}

/** Review work on `source`; settled unless a status says otherwise. */
function work(
  id: string,
  source: string,
  status = "completed",
  batchId: string | null = null,
): void {
  db.prepare(
    `INSERT INTO knowledge_work(id,subject_id,subject_kind,reason,input_revision,input_changed_at,tier,due_at,created_at,updated_at,status,batch_id)
     VALUES(?,?,'source','review',?,?,'routine',?,?,?,?,?)`,
  ).run(id, source, revision(source), NOW - DAY, NOW - DAY, NOW - DAY, NOW - DAY, status, batchId);
}

/** A batch some other run holds open. */
function openBatch(id: string): void {
  db.prepare(
    `INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at)
     VALUES(?,?,'fixture','routine','running',?,?)`,
  ).run(id, `cog-${id}`, NOW, NOW);
}

function admit(selection: OrganizationCohortSelection, suffix: string): void {
  const sources = Object.keys(selection.sourceVersions);
  startOrganizationBatch(
    db,
    {
      ...selection,
      id: `ko-${suffix}`,
      batchId: `kb-${suffix}`,
      runId: `cog-${suffix}`,
      workPrefix: `kw-${suffix}`,
      intervalMs: 60_000,
      retryMs: 600_000,
      regionNodeIds: sources.map((id) => `source:${id}`),
      frontier: sources.map((id) => ({
        nodeId: `source:${id}`,
        depth: 0,
        inputFingerprint: `frontier-${id}`,
        inputVersions: { [`source:${id}`]: selection.sourceVersions[id]! },
      })),
    },
    NOW,
  );
}

const select = () =>
  selectOrganizationCohort(db, { now: NOW, intervalMs: 60_000, retryMs: 600_000 });

/** Everything an admission writes, for comparing before and after one. */
function written(): Record<string, unknown[]> {
  const read = (sql: string) => db.prepare(sql).all();
  return {
    work: read(
      "SELECT id,subject_id,status,batch_id,input_revision FROM knowledge_work ORDER BY id",
    ),
    batches: read("SELECT id,run_id,status FROM knowledge_batches ORDER BY id"),
    regions: read("SELECT batch_id,node_id FROM knowledge_batch_regions ORDER BY 1,2"),
    frontier: read("SELECT batch_id,node_id,depth,status FROM knowledge_frontier ORDER BY 1,2"),
    cohorts: read(
      "SELECT id,batch_id,status,retrieval_reconsidered,retrieval_reconsider_at FROM knowledge_organization_cohorts ORDER BY id",
    ),
    members: read("SELECT * FROM knowledge_organization_members ORDER BY 1,2"),
    runs: read("SELECT id,kind,payload_json,status FROM cognition_runs ORDER BY id"),
  };
}

/** The error an admission throws, by code and message. */
function refusal(run: () => void): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof KnowledgeStorageError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("the admission was not refused");
}

/**
 * Scans of the recorded reads, except the newest cohort's creation time: the
 * plan names that a scan, but it reads one entry from the end of its index.
 */
function scans(statements: Map<string, unknown[]>): string[] {
  const audited = new Map(
    [...statements].filter(
      ([sql]) =>
        !/^SELECT created_at FROM knowledge_organization_cohorts (WHERE subject_loop_id IS NOT NULL\s+)?ORDER BY created_at DESC LIMIT 1$/.test(
          sql.trim(),
        ),
    ),
  );
  return ledgerScans(db, audited, ORGANIZATION_LEDGERS);
}

/** The released-retry lookup among recorded statements. */
function retryLookup(statements: Map<string, unknown[]>): [string, unknown[]] {
  const found = [...statements].find(([sql]) => /c\.retrieval_reconsider_at<=\?/.test(sql));
  if (!found) throw new Error("the released-retry lookup did not run");
  return found;
}
/** The plan steps of the lookup's probe for other pending work on a member. */
function workProbe(plan: string[]): string[] {
  return plan.filter((detail) => / w USING /.test(detail));
}

describe("admitting an organization cohort", () => {
  it("writes the work, batch, frontier, cohort and synthesis run of a chronological selection", () => {
    for (const id of ["north", "south"]) evidence(id);
    const selection = select()!;
    admit(selection, "new");
    expect(written()).toEqual({
      work: [
        {
          id: "kw-new_0",
          subject_id: "north",
          status: "batched",
          batch_id: "kb-new",
          input_revision: revision("north"),
        },
        {
          id: "kw-new_1",
          subject_id: "south",
          status: "batched",
          batch_id: "kb-new",
          input_revision: revision("south"),
        },
      ],
      batches: [{ id: "kb-new", run_id: "cog-new", status: "pending" }],
      regions: [
        { batch_id: "kb-new", node_id: "source:north" },
        { batch_id: "kb-new", node_id: "source:south" },
      ],
      frontier: [
        { batch_id: "kb-new", node_id: "source:north", depth: 0, status: "pending" },
        { batch_id: "kb-new", node_id: "source:south", depth: 0, status: "pending" },
      ],
      cohorts: [
        {
          id: "ko-new",
          batch_id: "kb-new",
          status: "pending",
          retrieval_reconsidered: 0,
          retrieval_reconsider_at: null,
        },
      ],
      members: [
        { cohort_id: "ko-new", source_id: "north", content_hash: revision("north") },
        { cohort_id: "ko-new", source_id: "south", content_hash: revision("south") },
      ],
      runs: [
        {
          id: "cog-new",
          kind: "synthesis",
          payload_json: JSON.stringify({
            focus: "knowledge-maintenance",
            batchId: "kb-new",
            organizationCohortId: "ko-new",
          }),
          status: "pending",
        },
      ],
    });
  });

  it("refuses, writing nothing, when a source picked up maintenance after selection", () => {
    for (const id of ["north", "south"]) evidence(id);
    const selection = select()!;
    work("kw-meanwhile", "south", "pending");
    const before = written();
    expect(refusal(() => admit(selection, "new"))).toEqual({
      code: "revision_conflict",
      message: "Organization evidence has pending maintenance",
    });
    expect(written()).toEqual(before);
  });

  it("refuses, writing nothing, when another cohort became active after selection", () => {
    for (const id of ["north", "south"]) evidence(id);
    const selection = select()!;
    openBatch("kb-active");
    db.prepare(
      `INSERT INTO knowledge_organization_cohorts(id,batch_id,input_fingerprint,policy_version,status,retry_at,created_at,updated_at)
       VALUES('ko-active','kb-active','fixture',?,'pending',?,?,?)`,
    ).run(KNOWLEDGE_DISCOVERY_POLICY, NOW + DAY, NOW, NOW);
    const before = written();
    expect(refusal(() => admit(selection, "new"))).toEqual({
      code: "revision_conflict",
      message: "Organization cohort changed before admission",
    });
    expect(written()).toEqual(before);
  });

  it("admits a publication retry over the work it batched itself, consuming the release", () => {
    for (const id of ["north", "south"]) evidence(id);
    releasedCohort("ko-prior", ["north", "south"], NOW - DAY);
    // Recent enough that the ordinary cadence would refuse a chronological cohort.
    db.prepare("UPDATE knowledge_organization_cohorts SET created_at=? WHERE id='ko-prior'").run(
      NOW - 1000,
    );
    const selection = select()!;
    expect(selection.publicationRetry).toBe(true);
    admit(selection, "retry");
    expect(written().cohorts).toEqual([
      {
        id: "ko-prior",
        batch_id: "kb-ko-prior",
        status: "completed",
        retrieval_reconsidered: 1,
        retrieval_reconsider_at: null,
      },
      {
        id: "ko-retry",
        batch_id: "kb-retry",
        status: "pending",
        retrieval_reconsidered: 1,
        retrieval_reconsider_at: null,
      },
    ]);
  });

  it("does not offer a released retry whose member has work in another open batch", () => {
    for (const id of ["north", "south"]) evidence(id);
    releasedCohort("ko-prior", ["north", "south"], NOW - DAY);
    openBatch("kb-elsewhere");
    work("kw-elsewhere", "north", "batched", "kb-elsewhere");
    expect(select()).toBeNull();
    // Settled work on the member never holds the retry back.
    db.prepare("UPDATE knowledge_work SET status='completed' WHERE id='kw-elsewhere'").run();
    expect(select()?.publicationRetry).toBe(true);
  });

  it("consumes the earliest current release of the selected fingerprint, leaving later ones", () => {
    for (const id of ["north", "south", "east", "west"]) evidence(id);
    releasedCohort("ko-other", ["east", "west"], NOW - 3 * DAY);
    releasedCohort("ko-first", ["north", "south"], NOW - 2 * DAY);
    releasedCohort("ko-second", ["north", "south"], NOW - DAY);
    const sourceVersions = { north: revision("north"), south: revision("south") };
    admit(
      { sourceVersions, inputFingerprint: fingerprint(sourceVersions), publicationRetry: true },
      "retry",
    );
    const due = db
      .prepare(
        "SELECT id,retrieval_reconsider_at AS at FROM knowledge_organization_cohorts WHERE id LIKE 'ko-%' ORDER BY id",
      )
      .all();
    expect(due).toEqual([
      { id: "ko-first", at: null },
      { id: "ko-other", at: NOW - 3 * DAY },
      { id: "ko-retry", at: null },
      { id: "ko-second", at: NOW - DAY },
    ]);
  });

  it("recognizes the selected retry however many other releases became eligible before it", () => {
    for (const id of ["north", "south"]) evidence(id);
    releasedCohort("ko-selected", ["north", "south"], NOW - DAY);
    const selection = select()!;
    expect(selection.publicationRetry).toBe(true);
    // Between the read and the write, more releases than one lookup returns sort first.
    for (let i = 0; i < 40; i++) {
      evidence(`early-${i}-a`);
      evidence(`early-${i}-b`);
      releasedCohort(`ko-early-${i}`, [`early-${i}-a`, `early-${i}-b`], NOW - 2 * DAY + i);
    }
    admit(selection, "retry");
    expect(
      db
        .prepare(
          "SELECT retrieval_reconsider_at AS at FROM knowledge_organization_cohorts WHERE id='ko-selected'",
        )
        .get(),
    ).toEqual({ at: null });
  });
});

describe("the reads of an admission", () => {
  it("admits a chronological cohort reading the ledgers only through seeks", () => {
    for (const id of ["north", "south", "east"]) evidence(id);
    for (const id of ["west", "ridge"]) evidence(id);
    releasedCohort("ko-released", ["west", "ridge"], NOW - DAY);
    // Released, but a member has moved on since: never current, so never chosen.
    db.prepare("UPDATE documents SET content_hash='edited' WHERE id='ridge'").run();
    for (let i = 0; i < 4; i++) work(`kw-settled-${i}`, "west");

    const selection = select()!;
    expect(selection.publicationRetry).toBeUndefined();
    const { statements, stop } = recordStatements(db);
    admit(selection, "chronological");
    stop();

    expect(getOrganizationCohortForBatch(db, "kb-chronological")?.status).toBe("pending");
    expect(statements.size).toBeGreaterThan(20);
    expect(scans(statements)).toEqual([]);
    const [sql, params] = retryLookup(statements);
    const plan = queryPlan(db, sql, params);
    // Admission confirms only the selected fingerprint; it never walks the released retries.
    expect(plan[0]).toMatch(
      /^SEARCH c USING INDEX knowledge_organization_retrieval_identity \(input_fingerprint=\?/,
    );
    expect(workProbe(plan)).toEqual([
      "SEARCH w USING INDEX knowledge_work_subject (subject_kind=? AND subject_id=?)",
    ]);
  });

  it("admits a publication retry reading the ledgers only through seeks", () => {
    for (const id of ["north", "south", "east"]) evidence(id);
    releasedCohort("ko-prior", ["north", "south", "east"], NOW - DAY);
    for (let i = 0; i < 4; i++) work(`kw-settled-${i}`, "north");

    const selection = select()!;
    expect(selection.publicationRetry).toBe(true);
    const { statements, stop } = recordStatements(db);
    admit(selection, "retry");
    stop();

    const cohort = db
      .prepare<[], { id: string; reconsiderAt: number | null }>(
        "SELECT id,retrieval_reconsider_at AS reconsiderAt FROM knowledge_organization_cohorts WHERE id='ko-prior'",
      )
      .get();
    // The retry was consumed: its released time is cleared in the same transaction.
    expect(cohort).toEqual({ id: "ko-prior", reconsiderAt: null });
    expect(scans(statements)).toEqual([]);
    const [sql, params] = retryLookup(statements);
    const plan = queryPlan(db, sql, params);
    expect(plan[0]).toMatch(
      /^SEARCH c USING INDEX knowledge_organization_retrieval_identity \(input_fingerprint=\?/,
    );
    expect(workProbe(plan)).toEqual([
      "SEARCH w USING INDEX knowledge_work_subject (subject_kind=? AND subject_id=?)",
    ]);
  });

  it("selects among released retries probing each member's own work", () => {
    for (const id of ["north", "south"]) evidence(id);
    releasedCohort("ko-prior", ["north", "south"], NOW - DAY);
    const { statements, stop } = recordStatements(db);
    expect(select()?.publicationRetry).toBe(true);
    stop();
    const [sql, params] = retryLookup(statements);
    expect(workProbe(queryPlan(db, sql, params))).toEqual([
      "SEARCH w USING INDEX knowledge_work_subject (subject_kind=? AND subject_id=?)",
    ]);
  });
});
