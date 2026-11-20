// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bindStorageRetentionPolicy,
  captureStorageRetentionBindingInputs,
  createStorageRetentionBindingTables,
  readBoundStorageRetentionPolicies,
  readStorageRetentionBinding,
  readStorageSourceIncarnation,
  reconcileStorageRetentionBindings,
  storageRetentionBindingIsCurrent,
} from "./retention-bindings.js";

let db: Database.Database;
const policy = { sourceId: "fictional-notes:one", maxAgeDays: 365 };
function insertSource(createdAt = 123): void {
  db.prepare("INSERT INTO sources(id, created_at) VALUES (?, ?)").run(policy.sourceId, createdAt);
}
function reconcile(policies = [policy]) {
  return reconcileStorageRetentionBindings(db, {
    policies: captureStorageRetentionBindingInputs(db, policies),
  });
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE sources(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL); CREATE TABLE removed_sources(id TEXT PRIMARY KEY)",
  );
  createStorageRetentionBindingTables(db);
});
afterEach(() => db.close());

describe("source incarnation authority", () => {
  it("seeds existing sources once and never mints authority on reads", () => {
    db.exec(
      "DROP TRIGGER storage_source_incarnation_insert; DROP TABLE storage_source_incarnations",
    );
    insertSource();
    createStorageRetentionBindingTables(db);
    const incarnation = readStorageSourceIncarnation(db, policy.sourceId);
    expect(incarnation).toMatch(/^[a-f0-9]{32}$/);
    createStorageRetentionBindingTables(db);
    expect(readStorageSourceIncarnation(db, policy.sourceId)).toBe(incarnation);
    expect(readStorageSourceIncarnation(db, "fictional-notes:missing")).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM storage_source_incarnations").get()).toEqual({
      count: 1,
    });
  });

  it("rotates identity on remove/readd even when created_at is identical", () => {
    insertSource();
    const first = readStorageSourceIncarnation(db, policy.sourceId);
    db.prepare("DELETE FROM sources WHERE id = ?").run(policy.sourceId);
    expect(readStorageSourceIncarnation(db, policy.sourceId)).toBeNull();
    insertSource();
    expect(readStorageSourceIncarnation(db, policy.sourceId)).not.toBe(first);
    db.prepare("INSERT INTO removed_sources(id) VALUES (?)").run(policy.sourceId);
    expect(readStorageSourceIncarnation(db, policy.sourceId)).toBeNull();
  });
});

describe("rolling retention binding", () => {
  it("preserves raw-config bindings across restart, and never rebinds a recreated source", () => {
    insertSource();
    reconcile();
    const bound = readBoundStorageRetentionPolicies(db, [policy])[0]!;
    expect(reconcile().changed).toBe(0);
    expect(storageRetentionBindingIsCurrent(db, bound)).toBe(true);
    createStorageRetentionBindingTables(db);
    expect(readBoundStorageRetentionPolicies(db, [policy])).toEqual([bound]);
    db.prepare("DELETE FROM sources WHERE id = ?").run(policy.sourceId);
    insertSource();
    reconcile();
    expect(readBoundStorageRetentionPolicies(db, [policy])).toEqual([]);
    expect(storageRetentionBindingIsCurrent(db, bound)).toBe(false);
    expect(readStorageRetentionBinding(db, policy.sourceId)?.sourceIncarnation).toBe(
      bound.sourceIncarnation,
    );
    reconcile([{ ...policy, maxAgeDays: 30 }]);
    expect(readBoundStorageRetentionPolicies(db, [{ ...policy, maxAgeDays: 30 }])).toEqual([]);
  });

  it("rotates policy authority on duration and enabled-state ABA, while preserving source identity", () => {
    insertSource();
    reconcile();
    const first = readBoundStorageRetentionPolicies(db, [policy])[0]!;
    reconcile([{ ...policy, maxAgeDays: 30 }]);
    reconcile();
    const restored = readBoundStorageRetentionPolicies(db, [policy])[0]!;
    expect(restored.sourceIncarnation).toBe(first.sourceIncarnation);
    expect(restored.bindingId).not.toBe(first.bindingId);
    expect(storageRetentionBindingIsCurrent(db, first)).toBe(false);
    reconcile([]);
    expect(readBoundStorageRetentionPolicies(db, [policy])).toEqual([]);
    reconcile();
    expect(readBoundStorageRetentionPolicies(db, [policy])[0]!.bindingId).not.toBe(
      restored.bindingId,
    );
  });

  it("retains retired identity when config is removed then replayed after source replacement", () => {
    insertSource();
    reconcile();
    reconcile([]);
    db.prepare("DELETE FROM sources WHERE id = ?").run(policy.sourceId);
    insertSource();
    reconcile();
    expect(readBoundStorageRetentionPolicies(db, [policy])).toEqual([]);
    const current = readStorageSourceIncarnation(db, policy.sourceId)!;
    expect(bindStorageRetentionPolicy(db, { ...policy, sourceIncarnation: current })).toEqual({
      stale: false,
      changed: 1,
    });
    expect(readBoundStorageRetentionPolicies(db, [policy])).toHaveLength(1);
  });

  it("never adopts a source that appeared after a missing-source policy was captured", () => {
    const captured = captureStorageRetentionBindingInputs(db, [policy]);
    insertSource();
    reconcileStorageRetentionBindings(db, { policies: captured });
    reconcile();
    expect(readBoundStorageRetentionPolicies(db, [policy])).toEqual([]);
  });

  it("preserves the captured identity when a queued reconcile crosses source replacement", () => {
    insertSource();
    const captured = captureStorageRetentionBindingInputs(db, [policy]);
    const first = captured[0]!.sourceIncarnation!;
    db.prepare("DELETE FROM sources WHERE id = ?").run(policy.sourceId);
    insertSource();
    reconcileStorageRetentionBindings(db, { policies: captured });
    expect(readBoundStorageRetentionPolicies(db, [policy])).toEqual([]);
    expect(bindStorageRetentionPolicy(db, { ...policy, sourceIncarnation: first })).toEqual({
      stale: true,
      changed: 0,
    });
  });

  it("fences queued config and explicit-binding writes without changing stored authority", () => {
    insertSource();
    const clock = new Int32Array(new SharedArrayBuffer(4));
    const authority = { buffer: clock.buffer, revision: 0 };
    const captured = captureStorageRetentionBindingInputs(db, [policy]);
    Atomics.store(clock, 0, 2);
    expect(reconcileStorageRetentionBindings(db, { policies: captured, authority })).toEqual({
      stale: true,
      changed: 0,
    });
    expect(
      bindStorageRetentionPolicy(db, {
        ...policy,
        sourceIncarnation: captured[0]!.sourceIncarnation!,
        authority,
      }),
    ).toEqual({ stale: true, changed: 0 });
    expect(readStorageRetentionBinding(db, policy.sourceId)).toBeNull();
  });

  it("upgrades matching legacy timestamps but preserves mismatched legacy authority as inactive", () => {
    insertSource();
    const legacy = [{ ...policy, sourceCreatedAt: 123 }];
    reconcileStorageRetentionBindings(db, {
      policies: captureStorageRetentionBindingInputs(db, [policy], legacy),
    });
    expect(readBoundStorageRetentionPolicies(db, [policy])).toHaveLength(1);
    db.exec("DELETE FROM storage_retention_bindings");
    reconcileStorageRetentionBindings(db, {
      policies: captureStorageRetentionBindingInputs(
        db,
        [policy],
        [{ ...policy, sourceCreatedAt: 122 }],
      ),
    });
    expect(readBoundStorageRetentionPolicies(db, [policy])).toEqual([]);
    reconcile();
    expect(readBoundStorageRetentionPolicies(db, [policy])).toEqual([]);
  });
});

it("revokes durable policy authority when intermediate config changes coalesce before the writer", () => {
  insertSource();
  reconcile();
  const original = readBoundStorageRetentionPolicies(db, [policy])[0]!;
  reconcileStorageRetentionBindings(db, {
    policies: captureStorageRetentionBindingInputs(db, [policy]),
    renewSourceIds: [policy.sourceId],
  });
  expect(storageRetentionBindingIsCurrent(db, original)).toBe(false);
  expect(readBoundStorageRetentionPolicies(db, [policy])[0]!.bindingId).not.toBe(
    original.bindingId,
  );
});

it.each(["renew", "disable", "explicit"] as const)(
  "%s atomically cancels retired rolling jobs while manual approval stays independent",
  (operation) => {
    insertSource();
    reconcile();
    const bound = readBoundStorageRetentionPolicies(db, [policy])[0]!;
    db.exec(`CREATE TABLE storage_trim_jobs(id TEXT PRIMARY KEY, source_id TEXT, kind TEXT, state TEXT,
    error TEXT, updated_at INTEGER, completed_at INTEGER, revision INTEGER);
    INSERT INTO storage_trim_jobs VALUES('rolling', 'fictional-notes:one','rolling','running',NULL,0,NULL,0);
    INSERT INTO storage_trim_jobs VALUES('manual', 'fictional-notes:one','manual','running',NULL,0,NULL,0)`);
    if (operation === "renew")
      reconcileStorageRetentionBindings(db, {
        policies: captureStorageRetentionBindingInputs(db, [policy]),
        renewSourceIds: [policy.sourceId],
      });
    else if (operation === "disable") reconcile([]);
    else bindStorageRetentionPolicy(db, bound);
    expect(
      db.prepare("SELECT state,revision FROM storage_trim_jobs WHERE id='rolling'").get(),
    ).toEqual({ state: "cancelled", revision: 1 });
    expect(
      db.prepare("SELECT state,revision FROM storage_trim_jobs WHERE id='manual'").get(),
    ).toEqual({ state: "running", revision: 0 });
  },
);
