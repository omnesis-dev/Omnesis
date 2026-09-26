// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_PRIVACY_POLICY_FAMILY_ID } from "@omnesis/types/privacy";
import { directWriteGate } from "../write-gate.js";
import { normalizeGrantRules, validateGrantRuleReferences } from "../access/store-rules.js";
import { createAccessTables } from "../access/store.js";
import {
  createPrivacyPolicyHistoryTables,
  privacyPolicyDeletionBlockedReason,
  listPrivacyPolicyFamilies,
  listPrivacyPolicyVersions,
  privacyPolicyFamilyVersion,
  privacyPolicyVersion,
} from "./policy-history.js";
import { PrivacyPolicyStore, policyRevision } from "./policy-store.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-policy-history-"));
  dirs.push(dir);
  const db = new Database(":memory:");
  db.exec("CREATE TABLE devices (id TEXT PRIMARY KEY)");
  createPrivacyPolicyHistoryTables(db);
  let revision = 0;
  let now = 1_000;
  const store = new PrivacyPolicyStore(dir, {
    db,
    writeGate: directWriteGate(db),
    revisionGen: () => (++revision).toString(16).padStart(64, "0"),
    now: () => ++now,
  });
  return { db, store };
}

describe("privacy policy history", () => {
  it("removes an unused family from the library while retaining its history", async () => {
    const { db, store } = await fixture();
    const original = await store.get();
    const family = await store.createFamily({
      name: "Unused policy",
      policy: original.policy,
      action: "fork",
      originRevision: original.revision,
    });
    expect(privacyPolicyDeletionBlockedReason(db, family.familyId!)).toBeNull();
    expect(await store.deleteFamily(family.familyId!)).toEqual({ outcome: "deleted" });
    expect(await store.getFamily(family.familyId!)).toBeNull();
    expect(listPrivacyPolicyFamilies(db).map((entry) => entry.id)).not.toContain(family.familyId);
    expect(privacyPolicyFamilyVersion(db, family.familyId!, 1)?.revision).toBe(family.revision);
    expect(
      await store.runFamilyIfRevision(family.familyId!, family.revision, async () => true),
    ).toBeNull();
    expect(await store.deleteFamily(family.familyId!)).toEqual({ outcome: "not-found" });
    expect(
      await store.updateFamily(family.familyId!, family.revision, () => original.policy),
    ).toBeNull();
    await expect(store.restoreFamily(family.familyId!, family.revision, family)).rejects.toThrow(
      "not found",
    );
    expect(() =>
      validateGrantRuleReferences(
        db,
        normalizeGrantRules([
          {
            capability: "answer",
            sources: { mode: "all", sourceIds: [] },
            release: { mode: "reviewed", policyFamilyId: family.familyId! },
          },
        ]),
      ),
    ).toThrow("Invalid privacy policy family");
    const replacement = await store.createFamily({
      name: "Unused policy",
      policy: original.policy,
      action: "template",
    });
    expect(replacement.familyId).not.toBe(family.familyId);
    expect(await store.deleteFamily(DEFAULT_PRIVACY_POLICY_FAMILY_ID)).toMatchObject({
      outcome: "in-use",
    });
  });

  it.each(["access_grant_capabilities", "access_level_capabilities"])(
    "blocks deletion when %s retains a policy reference",
    async (table) => {
      const { db, store } = await fixture();
      const original = await store.get();
      const family = await store.createFamily({
        name: "Used policy",
        policy: original.policy,
        action: "template",
      });
      // References count independently of the owner's expiry or revocation state.
      db.exec(`CREATE TABLE ${table} (policy_family_id TEXT)`);
      db.prepare(`INSERT INTO ${table} VALUES (?)`).run(family.familyId);
      expect(privacyPolicyDeletionBlockedReason(db, family.familyId!)).toContain("used by");
      expect(await store.deleteFamily(family.familyId!)).toMatchObject({ outcome: "in-use" });
      expect(await store.getFamily(family.familyId!)).not.toBeNull();
      db.exec(`DELETE FROM ${table}`);
      expect(await store.deleteFamily(family.familyId!)).toEqual({ outcome: "deleted" });
    },
  );

  it("bootstraps the existing revision, then assigns a unique revision to every change", async () => {
    const { db, store } = await fixture();
    const first = await store.get();
    const policyA = "# Policy A\n\nAllow summaries.\n";
    const second = await store.update(first.revision, () => policyA);
    const third = await store.update(second!.revision, () => "# Policy B\n\nRequire approval.\n");
    const fourth = await store.update(third!.revision, () => policyA);

    expect(first.generation).toBe(1);
    expect(second!.generation).toBe(2);
    expect(fourth!.digest).toBe(second!.digest);
    expect(fourth!.revision).not.toBe(second!.revision);
    expect(listPrivacyPolicyVersions(db, { limit: 10 }).map((item) => item.generation)).toEqual([
      4, 3, 2, 1,
    ]);
  });

  it("preserves the legacy content-hash revision when bootstrapping an existing mirror", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnesis-policy-bootstrap-"));
    dirs.push(dir);
    const policy = "# Existing policy\n\nRequire approval.";
    await writeFile(join(dir, "privacy-policy.md"), policy, "utf8");
    const db = new Database(":memory:");
    createPrivacyPolicyHistoryTables(db);
    const store = new PrivacyPolicyStore(dir, { db, writeGate: directWriteGate(db) });

    const document = await store.get();
    expect(document.revision).toBe(policyRevision(policy));
    expect(document.generation).toBe(1);
  });

  it("repairs direct mirror edits and records reverts as new ledger entries", async () => {
    const { db, store } = await fixture();
    const first = await store.get();
    await writeFile(store.path, "# Direct edit\n\nDeny exact details.\n", "utf8");
    const repaired = await store.get();
    const changed = await store.update(first.revision, () => "# Changed\n\nAllow summaries.\n");
    const reverted = await store.revert(changed!.revision, first.policy, first.generation);

    expect(repaired).toEqual(first);
    expect(await readFile(store.path, "utf8")).toBe(first.policy);
    expect(reverted.generation).toBe(3);
    expect(reverted.revision).not.toBe(first.revision);
    expect(listPrivacyPolicyVersions(db, { limit: 10 })).toMatchObject([
      { generation: 3, action: "revert", revertedFromGeneration: 1 },
      { generation: 2, action: "edit" },
      { generation: 1, action: "bootstrap" },
    ]);
    expect(privacyPolicyVersion(db, reverted.generation)).toMatchObject({
      action: "revert",
      revertedFromGeneration: first.generation,
    });
  });

  it("repairs a malformed mirror from the durable ledger", async () => {
    const { db, store } = await fixture();
    const first = await store.get();
    await writeFile(store.path, "", "utf8");

    const repaired = await store.get();

    expect(repaired).toEqual(first);
    expect(await readFile(store.path, "utf8")).toBe(first.policy);
    expect(listPrivacyPolicyVersions(db, { limit: 10 })).toHaveLength(1);
  });

  it("appends a revert even when its target text already matches current", async () => {
    const { db, store } = await fixture();
    const first = await store.get();
    const reverted = await store.revert(first.revision, first.policy, first.generation);

    expect(reverted.generation).toBe(2);
    expect(reverted.revision).not.toBe(first.revision);
    expect(listPrivacyPolicyVersions(db, { limit: 10 })).toMatchObject([
      { generation: 2, action: "revert", revertedFromGeneration: 1 },
      { generation: 1, action: "bootstrap" },
    ]);
  });

  it("does not append a generation for a no-op save", async () => {
    const { db, store } = await fixture();
    const first = await store.get();
    const unchanged = await store.update(first.revision, (policy) => policy);
    expect(unchanged!.generation).toBe(first.generation);
    expect(listPrivacyPolicyVersions(db, { limit: 10 })).toHaveLength(1);
  });

  it("finishes an interrupted mirror write without reversing the durable commit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnesis-policy-recovery-"));
    dirs.push(dir);
    const db = new Database(":memory:");
    createPrivacyPolicyHistoryTables(db);
    const writeGate = directWriteGate(db);
    let failWrites = false;
    const store = new PrivacyPolicyStore(dir, {
      db,
      writeGate,
      mirrorWrite: async (path, policy) => {
        if (failWrites) throw new Error("synthetic mirror failure");
        await writeFile(path, policy, { mode: 0o600 });
      },
    });
    const first = await store.get();
    failWrites = true;
    await expect(
      store.update(first.revision, () => "# Durable policy\n\nAllow summaries only.\n"),
    ).rejects.toThrow("synthetic mirror failure");
    expect(await readFile(store.path, "utf8")).toBe(first.policy);

    const recovered = await new PrivacyPolicyStore(dir, { db, writeGate }).get();
    expect(recovered.policy).toContain("Allow summaries only");
    expect(recovered.generation).toBe(2);
    expect(await readFile(store.path, "utf8")).toBe(recovered.policy);
    expect(listPrivacyPolicyVersions(db, { limit: 10 })).toHaveLength(2);
  });

  it("forks immutable named families and restores an earlier family version append-only", async () => {
    const { db, store } = await fixture();
    const initial = await store.get();
    const fork = await store.createFamily({
      name: "Fictional research policy",
      policy: initial.policy,
      action: "fork",
      originRevision: initial.revision,
    });
    const changed = await store.updateFamily(
      fork.familyId!,
      fork.revision,
      () => "# Fictional research policy\n\nRequire approval for exact details.\n",
    );
    const restored = await store.restoreFamily(fork.familyId!, changed!.revision, fork);

    expect(restored.familyVersion).toBe(3);
    expect(restored.policy).toBe(fork.policy);
    expect(
      listPrivacyPolicyVersions(db, { familyId: fork.familyId, limit: 10 }).map((version) => ({
        familyVersion: version.familyVersion,
        action: version.action,
        originRevision: version.originRevision,
      })),
    ).toEqual([
      { familyVersion: 3, action: "restore", originRevision: fork.revision },
      { familyVersion: 2, action: "edit", originRevision: null },
      { familyVersion: 1, action: "fork", originRevision: initial.revision },
    ]);
    expect(listPrivacyPolicyFamilies(db).map((family) => family.name)).toContain(
      "Fictional research policy",
    );
    expect(privacyPolicyFamilyVersion(db, fork.familyId!, restored.familyVersion!)).toMatchObject({
      action: "restore",
      revertedFromGeneration: fork.generation,
    });
  });

  it("guards one named family revision and atomically bumps grants when it is published", async () => {
    const { db, store } = await fixture();
    createAccessTables(db);
    const initial = await store.get();
    db.exec(`
      INSERT INTO access_principals (id, name, kind, created_at, updated_at)
      VALUES ('principal-test', 'Fictional assistant', 'interactive', 1, 1);
      INSERT INTO access_grants (id, principal_id, name, revision, created_at, updated_at)
      VALUES ('grant-test', 'principal-test', 'Reviewed answers', 4, 1, 1);
    `);
    db.prepare(
      `INSERT INTO access_grant_capabilities
         (grant_id, capability, source_mode, source_ids, release_mode, policy_family_id)
       VALUES ('grant-test', 'answer', 'all', '[]', 'reviewed', ?)`,
    ).run(DEFAULT_PRIVACY_POLICY_FAMILY_ID);

    await expect(
      store.runFamilyIfRevision(DEFAULT_PRIVACY_POLICY_FAMILY_ID, "0".repeat(64), async () => 1),
    ).resolves.toBeNull();
    await expect(
      store.runFamilyIfRevision(
        DEFAULT_PRIVACY_POLICY_FAMILY_ID,
        initial.revision,
        async (document) => document.familyVersion,
      ),
    ).resolves.toBe(1);
    await store.update(initial.revision, () => "# Changed policy\n\nRequire approval.\n");
    expect(db.prepare("SELECT revision FROM access_grants WHERE id = 'grant-test'").get()).toEqual({
      revision: 5,
    });
    const policyAudit = db
      .prepare(
        `SELECT event_type, principal_id, grant_id, grant_revision, detail
           FROM access_audit_events WHERE grant_id = 'grant-test'`,
      )
      .get() as Record<string, unknown> & { detail: string };
    expect({ ...policyAudit, detail: JSON.parse(policyAudit.detail) }).toEqual({
      event_type: "grant-policy-updated",
      principal_id: "principal-test",
      grant_id: "grant-test",
      grant_revision: 5,
      detail: {
        policyFamilyId: DEFAULT_PRIVACY_POLICY_FAMILY_ID,
        policyRevision: expect.any(String),
      },
    });
  });

  it("uses the policy-family index and updates many affected grants without materializing ids", async () => {
    const { db, store } = await fixture();
    createAccessTables(db);
    const initial = await store.get();
    db.exec(`
      INSERT INTO access_principals (id, name, kind, created_at, updated_at)
      VALUES ('principal-many', 'Synthetic many-grant principal', 'interactive', 1, 1);
    `);
    const insertGrant = db.prepare(
      `INSERT INTO access_grants (id, principal_id, name, revision, created_at, updated_at)
       VALUES (?, 'principal-many', ?, 1, 1, 1)`,
    );
    const insertReviewed = db.prepare(
      `INSERT INTO access_grant_capabilities
         (grant_id, capability, source_mode, source_ids, release_mode, policy_family_id)
       VALUES (?, 'answer', 'all', '[]', 'reviewed', ?)`,
    );
    const insertUnreviewed = db.prepare(
      `INSERT INTO access_grant_capabilities
         (grant_id, capability, source_mode, source_ids, release_mode, policy_family_id)
       VALUES (?, 'answer', 'all', '[]', 'unreviewed', NULL)`,
    );
    db.transaction(() => {
      for (let index = 0; index < 240; index += 1) {
        const grantId = `grant-many-${String(index).padStart(3, "0")}`;
        insertGrant.run(grantId, `Synthetic grant ${index}`);
        if (index % 2 === 0) insertReviewed.run(grantId, DEFAULT_PRIVACY_POLICY_FAMILY_ID);
        else insertUnreviewed.run(grantId);
      }
    })();

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT grant_id FROM access_grant_capabilities
          WHERE policy_family_id = ? AND capability = 'answer' AND release_mode = 'reviewed'`,
      )
      .all(DEFAULT_PRIVACY_POLICY_FAMILY_ID) as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes("idx_access_grant_capabilities_policy"))).toBe(
      true,
    );

    await store.update(initial.revision, () => "# Changed policy\n\nAllow summaries only.\n");
    expect(
      db
        .prepare(
          `SELECT revision, COUNT(*) AS count FROM access_grants
            WHERE principal_id = 'principal-many' GROUP BY revision ORDER BY revision`,
        )
        .all(),
    ).toEqual([
      { revision: 1, count: 120 },
      { revision: 2, count: 120 },
    ]);
  });
});
