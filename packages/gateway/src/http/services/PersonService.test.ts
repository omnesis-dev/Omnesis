// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * PersonService merge-hook coverage.
 *
 * A merge-rule mutation writes the rule row, then two hooks materialize
 * `people.merged_into`: `wakeMergeEval` kicks the periodic eval task
 * (the reconciliation net), and `fastApplyMergeRules` runs the
 * equivalence apply at the caller's priority so the merge lands before
 * the response — bounded by a timeout and never failing the mutation.
 * These tests pin which ops fire the hooks, the coalescing of
 * concurrent fast lanes, and the timeout/error containment.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, test, vi, afterEach } from "vitest";
import { createDatabase } from "../../db.js";
import { createMergeRule } from "../../people.js";
import {
  applyMergeAdjudication,
  upsertMergeCandidates,
  type MergeCandidateProposal,
} from "../../merge-candidates.js";
import {
  computeMergeEquivalences,
  upsertMergeEquivalences,
} from "../../domain/merge/rule-evaluator.js";
import { directWriteGate, type WriteGate } from "../../write-gate.js";
import { FAST_APPLY_TIMEOUT_MS, PersonService } from "./PersonService.js";
import type Database from "better-sqlite3";

function makeService(
  writeGateOverrides: Record<string, unknown> = {},
  hookOverrides: { fastApplyMergeRules?: () => Promise<void> } = {},
) {
  const calls: string[] = [];
  const writeGate = {
    createMergeRule: vi.fn(async () => {
      calls.push("write");
      return { rule: { id: "rule-1" }, created: true };
    }),
    deleteMergeRule: vi.fn(async () => true),
    deleteMergeRuleGroup: vi.fn(async () => 2),
    acceptMergeCandidate: vi.fn(async () => ({ candidate: { id: "cand-1" }, ruleCreated: true })),
    denyMergeCandidate: vi.fn(async () => ({ candidate: { id: "cand-1" } })),
    mergeCluster: vi.fn(async () => ({ rulesCreated: 2, anchorId: "p1", groupId: "g1" })),
    mergePeople: vi.fn(async () => undefined),
    ...writeGateOverrides,
  } as unknown as WriteGate;
  const wakeMergeEval = vi.fn(() => calls.push("wake"));
  const fastApplyMergeRules = vi.fn(
    hookOverrides.fastApplyMergeRules ??
      (async () => {
        calls.push("fast");
      }),
  );
  const service = new PersonService({} as Database.Database, writeGate, {
    wakeMergeEval,
    fastApplyMergeRules,
  });
  return { service, writeGate, wakeMergeEval, fastApplyMergeRules, calls };
}

const RULE_INPUT = {
  sideA: { aliasType: "email" as const, alias: "maya@example.com" },
  sideB: { aliasType: "name" as const, alias: "Maya Reeves" },
  winnerSide: "a" as const,
  reason: null,
  kind: "user" as const,
  createdBy: null,
};

describe("PersonService — merge-eval wake hook", () => {
  test("createMergeRule wakes the eval after the write resolves", async () => {
    const { service, wakeMergeEval, calls } = makeService();
    await service.createMergeRule(RULE_INPUT);
    expect(wakeMergeEval).toHaveBeenCalledTimes(1);
    // The kicked eval tick must observe the committed rule row; the
    // fast-lane apply runs after both.
    expect(calls).toEqual(["write", "wake", "fast"]);
  });

  test("acceptCandidate and mergeCluster wake the eval", async () => {
    const { service, wakeMergeEval } = makeService();
    await service.acceptCandidate({ candidateId: "cand-1", winnerSide: "a", reason: null });
    await service.mergeCluster(["p1", "p2", "p3"]);
    expect(wakeMergeEval).toHaveBeenCalledTimes(2);
  });

  test("no-op rule mutations don't wake the eval", async () => {
    // Duplicate rule, already-merged accept, and a cluster that
    // produced no rules all leave merge_rules untouched — an eval
    // tick would find nothing.
    const { service, wakeMergeEval } = makeService({
      createMergeRule: vi.fn(async () => ({ rule: { id: "rule-1" }, created: false })),
      acceptMergeCandidate: vi.fn(async () => ({
        candidate: { id: "cand-1" },
        rule: null,
        ruleCreated: false,
        alreadyMerged: true,
      })),
      mergeCluster: vi.fn(async () => ({ rulesCreated: 0, anchorId: "p1", groupId: null })),
    });
    await service.createMergeRule(RULE_INPUT);
    await service.acceptCandidate({ candidateId: "cand-1", winnerSide: "a", reason: null });
    await service.mergeCluster(["p1", "p2"]);
    expect(wakeMergeEval).not.toHaveBeenCalled();
  });

  test("rule deletes wake the eval only when something was deleted", async () => {
    const { service, wakeMergeEval } = makeService();
    await service.deleteMergeRule("rule-1");
    await service.deleteMergeRuleGroup("g1");
    expect(wakeMergeEval).toHaveBeenCalledTimes(2);

    const miss = makeService({
      deleteMergeRule: vi.fn(async () => false),
      deleteMergeRuleGroup: vi.fn(async () => 0),
    });
    await miss.service.deleteMergeRule("rule-missing");
    await miss.service.deleteMergeRuleGroup("g-missing");
    expect(miss.wakeMergeEval).not.toHaveBeenCalled();
  });

  test("denyCandidate and direct merge() don't wake the eval", async () => {
    // Deny only flips candidate status (no rule change). The direct
    // merge endpoint bypasses merge_rules entirely — waking the eval
    // would only make its orphan-pointer sweep revert it sooner.
    const { service, wakeMergeEval } = makeService();
    await service.denyCandidate("cand-1");
    await service.merge("p1", "p2");
    expect(wakeMergeEval).not.toHaveBeenCalled();
  });

  test("ops succeed when no hook is wired (tests, embedded setups)", async () => {
    const writeGate = {
      createMergeRule: vi.fn(async () => ({ rule: { id: "rule-1" }, created: true })),
    } as unknown as WriteGate;
    const service = new PersonService({} as Database.Database, writeGate);
    await expect(service.createMergeRule(RULE_INPUT)).resolves.toMatchObject({ created: true });
  });
});

describe("PersonService — fast-lane apply hook", () => {
  test("rule-changing mutations run the fast lane after the write + wake", async () => {
    const { service, fastApplyMergeRules, calls } = makeService();
    await service.createMergeRule(RULE_INPUT);
    expect(calls).toEqual(["write", "wake", "fast"]);
    await service.acceptCandidate({ candidateId: "cand-1", winnerSide: "a", reason: null });
    await service.mergeCluster(["p1", "p2"]);
    await service.deleteMergeRule("rule-1");
    await service.deleteMergeRuleGroup("g1");
    expect(fastApplyMergeRules).toHaveBeenCalledTimes(5);
  });

  test("no-op mutations skip the fast lane", async () => {
    const { service, fastApplyMergeRules } = makeService({
      createMergeRule: vi.fn(async () => ({ rule: { id: "rule-1" }, created: false })),
      acceptMergeCandidate: vi.fn(async () => ({
        candidate: { id: "cand-1" },
        rule: null,
        ruleCreated: false,
        alreadyMerged: true,
      })),
      mergeCluster: vi.fn(async () => ({ rulesCreated: 0, anchorId: "p1", groupId: null })),
      deleteMergeRule: vi.fn(async () => false),
    });
    await service.createMergeRule(RULE_INPUT);
    await service.acceptCandidate({ candidateId: "cand-1", winnerSide: "a", reason: null });
    await service.mergeCluster(["p1", "p2"]);
    await service.deleteMergeRule("rule-missing");
    expect(fastApplyMergeRules).not.toHaveBeenCalled();
  });

  test("a failing fast lane never fails the mutation", async () => {
    const { service } = makeService(
      {},
      {
        fastApplyMergeRules: async () => {
          throw new Error("io lane exploded");
        },
      },
    );
    await expect(service.createMergeRule(RULE_INPUT)).resolves.toMatchObject({ created: true });
  });

  test("the mutation genuinely AWAITS the fast lane before resolving", async () => {
    // A deferred hook: if the service ever regressed to fire-and-forget,
    // the mutation would resolve while the hook is still pending — this
    // pins the materialize-before-response contract.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { service } = makeService({}, { fastApplyMergeRules: () => gate });
    let settled = false;
    const pending = service.createMergeRule(RULE_INPUT).then((r) => {
      settled = true;
      return r;
    });
    await Promise.resolve(); // drain microtasks — the write + wake complete
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    release();
    await expect(pending).resolves.toMatchObject({ created: true });
  });

  test("a hanging fast lane is abandoned after the timeout budget", async () => {
    vi.useFakeTimers();
    try {
      const { service } = makeService(
        {},
        {
          // Never resolves — simulates a fast lane stuck behind a wedged gate.
          fastApplyMergeRules: () => new Promise<void>(() => {}),
        },
      );
      let settled = false;
      const pending = service.createMergeRule(RULE_INPUT).then((r) => {
        settled = true;
        return r;
      });
      // One tick short of the budget the mutation is still waiting…
      await vi.advanceTimersByTimeAsync(FAST_APPLY_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      // …and the budget expiring releases it.
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ created: true });
    } finally {
      vi.useRealTimers();
    }
  });

  test("concurrent mutations coalesce onto one in-flight fast lane plus one re-run", async () => {
    let runs = 0;
    let release!: () => void;
    const first = new Promise<void>((r) => {
      release = r;
    });
    const { service } = makeService(
      {},
      {
        fastApplyMergeRules: () => {
          runs += 1;
          // First pass blocks until released; the trailing re-run resolves
          // immediately.
          return runs === 1 ? first : Promise.resolve();
        },
      },
    );
    const a = service.createMergeRule(RULE_INPUT);
    const b = service.deleteMergeRule("rule-1");
    const c = service.deleteMergeRuleGroup("g1");
    release();
    await Promise.all([a, b, c]);
    // Three mutations, but at most the in-flight pass + one trailing re-run.
    expect(runs).toBe(2);
  });

  test("end-to-end: acceptCandidate materializes merged_into before returning", async () => {
    // Real db + a fast-lane closure shaped like production wiring
    // (compute + upsert), driven through the service.
    const tmp = mkdtempSync(join(tmpdir(), "omnesis-fastlane-"));
    const db = createDatabase(join(tmp, "t.db"));
    try {
      const a = randomUUID();
      const b = randomUUID();
      db.prepare(
        `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
         VALUES (?, 'Maya Reeves', 'extracted', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01'),
                (?, 'M Reeves', 'extracted', '2026-02-01', '2026-02-01', '2026-02-01', '2026-02-01')`,
      ).run(a, b);
      for (const [pid, alias] of [
        [a, "mreeves@example.com"],
        [b, "maya.reeves@northstar.example"],
      ] as const) {
        db.prepare(
          `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at)
           VALUES (?, ?, ?, 'email', '2026-01-01')`,
        ).run(randomUUID(), pid, alias);
      }
      upsertMergeCandidates(db, [
        {
          sideA: { aliasType: "email", alias: "mreeves@example.com" },
          sideB: { aliasType: "email", alias: "maya.reeves@northstar.example" },
          score: 0.95,
          detectionKind: "name_token_overlap",
          matchedTokens: ["maya", "reeves"],
          matchStrength: 1.7,
        } satisfies MergeCandidateProposal,
      ]);
      const candId = (
        db.prepare<[], { id: string }>("SELECT id FROM merge_candidates").get() as { id: string }
      ).id;

      const service = new PersonService(db, directWriteGate(db), {
        fastApplyMergeRules: async () => {
          upsertMergeEquivalences(db, computeMergeEquivalences(db));
        },
      });
      await service.acceptCandidate({ candidateId: candId, winnerSide: "a", reason: null });

      // The two people are one identity BEFORE the mutation returns —
      // whichever of them the eval elected canonical.
      const mergedInto = (id: string): string | null =>
        db
          .prepare<
            [string],
            { merged_into: string | null }
          >("SELECT merged_into FROM people WHERE id = ?")
          .get(id)?.merged_into ?? null;
      expect(mergedInto(a) === b || mergedInto(b) === a).toBe(true);
    } finally {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("PersonService.getStats — merge-queue summary", () => {
  let tmpDir: string;
  let db: Database.Database;

  afterEach(() => {
    db?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeRealService() {
    tmpDir = mkdtempSync(join(tmpdir(), "omnesis-personservice-stats-"));
    db = createDatabase(join(tmpDir, "test.db"));
    // getStats is read-only — a stub write gate is never exercised.
    return new PersonService(db, {} as WriteGate);
  }

  test("reports pending merge-candidate and active merge-rule counts", () => {
    const service = makeRealService();

    // Fresh DB: empty queue, both counts zero.
    let stats = service.getStats();
    expect(stats.pendingMergeCandidates).toBe(0);
    expect(stats.mergeRules).toBe(0);
    // Base people-table fields still present.
    expect(stats).toHaveProperty("totalPeople");
    expect(stats.selfDetected).toBe(false);

    // Two pending candidates + one active rule.
    const proposal = (alias: string): MergeCandidateProposal => ({
      sideA: { aliasType: "name", alias },
      sideB: { aliasType: "name", alias: `${alias}-alt` },
      score: 0.9,
      matchedTokens: [alias],
      detectionKind: "name_token_overlap",
      personA: `p-${alias}-a`,
      personB: `p-${alias}-b`,
    });
    upsertMergeCandidates(db, [proposal("maya"), proposal("david")]);
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "maya@example.com" },
      sideB: { aliasType: "name", alias: "Maya Reeves" },
      winnerSide: "a",
    });

    stats = service.getStats();
    expect(stats.pendingMergeCandidates).toBe(2);
    expect(stats.mergeRules).toBe(1);
  });
});

describe("PersonService.listMergeRuleGroups", () => {
  let tmpDir: string;
  let db: Database.Database;

  afterEach(() => {
    db?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedPerson(name: string, email: string): string {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO people
         (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
       VALUES (?, ?, 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run(id, name);
    db.prepare(
      `INSERT INTO person_aliases
         (id, person_id, alias, alias_type, source_id, created_at)
       VALUES (?, ?, ?, 'email', 'gmail:test', '2026-01-01')`,
    ).run(randomUUID(), id, email);
    return id;
  }

  test("pages whole canonical-winner groups before enriching every rule in the group", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "omnesis-personservice-rule-groups-"));
    db = createDatabase(join(tmpDir, "test.db"));
    const service = new PersonService(db, {} as WriteGate);
    seedPerson("Maya Reeves", "maya@example.com");
    seedPerson("FixtureDavid", "david@example.com");

    const firstGroupRules = [
      createMergeRule(db, {
        sideA: { aliasType: "email", alias: "maya@example.com" },
        sideB: { aliasType: "email", alias: "m.reeves@northstar.example" },
        winnerSide: "a",
        groupId: "group_maya",
      }).rule,
      createMergeRule(db, {
        sideA: { aliasType: "email", alias: "maya@example.com" },
        sideB: { aliasType: "phone", alias: "+1 (555) 010-0101" },
        winnerSide: "a",
        groupId: "group_maya",
      }).rule,
    ];
    const secondGroupRule = createMergeRule(db, {
      sideA: { aliasType: "email", alias: "david@example.com" },
      sideB: { aliasType: "email", alias: "d.lin@northstar.example" },
      winnerSide: "a",
      groupId: "group_david",
    }).rule;
    db.prepare("UPDATE merge_rules SET created_at = ? WHERE id IN (?, ?)").run(
      "2026-07-02T00:00:00.000Z",
      firstGroupRules[0]!.id,
      firstGroupRules[1]!.id,
    );
    db.prepare("UPDATE merge_rules SET created_at = ? WHERE id = ?").run(
      "2026-07-01T00:00:00.000Z",
      secondGroupRule.id,
    );

    const first = service.listMergeRuleGroups({ limit: 1 });
    expect(first.hasMore).toBe(true);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      name: "Maya Reeves",
      canonicalEmail: "maya@example.com",
      ruleIds: expect.arrayContaining(firstGroupRules.map((rule) => rule.id)),
      groupIds: ["group_maya"],
    });
    expect(first.items[0]!.sources).toHaveLength(2);

    const second = service.listMergeRuleGroups({ limit: 1, before: first.last! });
    expect(second.hasMore).toBe(false);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]).toMatchObject({
      name: "FixtureDavid",
      ruleIds: [secondGroupRule.id],
      groupIds: ["group_david"],
    });
  });
});

describe("PersonService.listEnrichedCandidates — adjudication passthrough", () => {
  let tmpDir: string;
  let db: Database.Database;

  afterEach(() => {
    db?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedPerson(name: string, email: string): string {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO people
         (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
       VALUES (?, ?, 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run(id, name);
    db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at)
       VALUES (?, ?, ?, 'email', '2026-01-01')`,
    ).run(randomUUID(), id, email);
    db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at, occurrence_count, is_primary)
       VALUES (?, ?, ?, 'name', '2026-01-01', 1, 1)`,
    ).run(randomUUID(), id, name);
    return id;
  }

  /** Two persons sharing a two-token name, one pending candidate between their emails. */
  function seedPendingCandidate() {
    tmpDir = mkdtempSync(join(tmpdir(), "omnesis-personservice-adjudication-"));
    db = createDatabase(join(tmpDir, "test.db"));
    const personA = seedPerson("Carla Vance", "carla@example.com");
    const personB = seedPerson("Carla Vance", "c.vance@example.com");
    upsertMergeCandidates(db, [
      {
        sideA: { aliasType: "email", alias: "carla@example.com" },
        sideB: { aliasType: "email", alias: "c.vance@example.com" },
        score: 0.9,
        matchedTokens: ["carla", "vance"],
        detectionKind: "name_token_overlap",
        personA,
        personB,
      } satisfies MergeCandidateProposal,
    ]);
    const { id: candidateId } = db.prepare("SELECT id FROM merge_candidates").get() as {
      id: string;
    };
    // Reads only — a stub write gate is never exercised.
    const service = new PersonService(db, {} as WriteGate);
    return { service, candidateId };
  }

  test("an unsure verdict's fields ride along on the pending candidate", async () => {
    const { service, candidateId } = seedPendingCandidate();
    applyMergeAdjudication(db, {
      candidateId,
      verdict: "unsure",
      reason: "Shared name but no overlapping threads; could be two Carla Vances.",
      runId: "run_x",
    });

    // The portal's assistant chip reads exactly these fields off
    // GET /people/merge-candidates.
    const { candidates } = await service.listEnrichedCandidates({ status: "pending", limit: 50 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: candidateId,
      status: "pending",
      adjudicationVerdict: "unsure",
      adjudicationReason: "Shared name but no overlapping threads; could be two Carla Vances.",
    });
    expect(candidates[0].adjudicatedAt).not.toBeNull();
  });

  test("a distinct verdict denies the candidate and the stamp follows it to the denied view", async () => {
    const { service, candidateId } = seedPendingCandidate();
    applyMergeAdjudication(db, {
      candidateId,
      verdict: "distinct",
      reason: "Different orgs and no shared correspondents.",
      runId: "run_x",
    });

    expect(
      (await service.listEnrichedCandidates({ status: "pending", limit: 50 })).candidates,
    ).toEqual([]);
    const { candidates } = await service.listEnrichedCandidates({ status: "denied", limit: 50 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: candidateId,
      status: "denied",
      adjudicationVerdict: "distinct",
      adjudicationReason: "Different orgs and no shared correspondents.",
    });
  });
});

describe("PersonService.browse — read-worker routing", () => {
  test("routes through the io gate when one is wired (keeps the query off the main thread)", async () => {
    const rows = [{ id: "p1" }] as unknown as Awaited<ReturnType<PersonService["browse"]>>;
    const browsePeople = vi.fn(async () => rows);
    const gate = {
      browsePeople,
      snapshotAbsencePlan: vi.fn(),
    };
    const service = new PersonService({} as Database.Database, {} as WriteGate, {}, gate);

    const result = await service.browse("alex", 25, { sortBy: "documents" });

    expect(result).toBe(rows);
    expect(browsePeople).toHaveBeenCalledWith("alex", 25, { sortBy: "documents" });
  });

  test("falls back to a synchronous read when no gate is wired", async () => {
    // No io gate → main-thread read. With an empty in-memory schema-less db the
    // query would throw; assert it does NOT touch a gate (the fallback branch is
    // taken) by using a db stub whose prepare records the call.
    const prepare = vi.fn(() => ({ all: () => [], get: () => undefined }));
    const service = new PersonService({ prepare } as unknown as Database.Database, {} as WriteGate);

    await service.browse("q", 10, { sortBy: "interaction" });
    expect(prepare).toHaveBeenCalled(); // ran on the main thread, not a gate
  });
});

describe("PersonService.listEnrichedCandidates — read-worker routing", () => {
  test("routes through the io gate when it exposes enrichedMergeCandidates", async () => {
    const result = {
      candidates: [],
      counts: { pending: 0, accepted: 0, denied: 0 },
    } as unknown as Awaited<ReturnType<PersonService["listEnrichedCandidates"]>>;
    const enrichedMergeCandidates = vi.fn(async () => result);
    const gate = {
      browsePeople: vi.fn(),
      enrichedMergeCandidates,
    };
    const service = new PersonService({} as Database.Database, {} as WriteGate, {}, gate);

    const out = await service.listEnrichedCandidates({ status: "pending", limit: 42 });

    expect(out).toBe(result);
    expect(enrichedMergeCandidates).toHaveBeenCalledWith({ status: "pending", limit: 42 });
  });

  test("falls back to a synchronous main-thread compute when the gate lacks the method", async () => {
    // A gate that only does browse (no enrichedMergeCandidates) must not swallow
    // the call — the service computes on the main thread instead. Use a real
    // seeded db so the compute path returns a well-formed (empty) result.
    const tmp = mkdtempSync(join(tmpdir(), "omnesis-personservice-enriched-fallback-"));
    const db = createDatabase(join(tmp, "test.db"));
    try {
      const gate = { browsePeople: vi.fn() };
      const service = new PersonService(db, {} as WriteGate, {}, gate);
      const out = await service.listEnrichedCandidates({ status: "pending", limit: 10 });
      expect(out.candidates).toEqual([]);
      expect(out.counts).toEqual({ pending: 0, accepted: 0, denied: 0, needsOperator: 0 });
    } finally {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
