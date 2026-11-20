// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MultiCollectorHarness, type PairedCollector } from "./multi-collector-harness.js";

const SOURCE = "notes-synth:storage-primary";
const SIBLING = "notes-synth:storage-sibling";
const ROLLING = "notes-synth:storage-rolling";
const ACCOUNTING = "notes-synth:storage-accounting";
const OLD = "2001-01-01T00:00:00.000Z";
const RECENT = new Date().toISOString();
const CUTOFF = "2010-01-01T00:00:00.000Z";

interface StorageSnapshot {
  physical: { totalBytes: number } | null;
  pressure: { state: string; usageBytes: number | null };
  policy: { maxBytes: number | null };
  retention: Array<{ sourceId: string; maxAgeDays: number }>;
  logical: {
    sources: Array<{
      sourceId: string;
      documents: number;
      payloadBytes: number;
      months: Array<{ month: string; documents: number; payloadBytes: number }>;
    }>;
  } | null;
  index: { embeddingBytes: number } | null;
  accounting: {
    logical: { state: string; measuredAt: string | null; error: string | null };
    index: { state: string; measuredAt: string | null; error: string | null };
  };
  trimJobs: Array<{ id: string; sourceId: string; before: string; state: string; deleted: number }>;
}

/** Tiny real files can exceed a one-byte quota; no disk-filling fixture is needed. */
describe("gateway storage admission and explicit retention", () => {
  let harness: MultiCollectorHarness;
  let collector: PairedCollector;

  beforeAll(async () => {
    harness = new MultiCollectorHarness({
      gatewayConfig: { gateway: { storage: { maxBytes: 1 } } },
    });
    await harness.start();
    collector = await harness.addCollector({
      name: "storage-fixture",
      hostableSourceTypes: ["notes-synth"],
    });
    const registered = await deviceJson<{ errors: unknown[] }>("/devices/sources/bulk-upsert", {
      sources: ["storage-primary", "storage-sibling", "storage-rolling"].map((accountId) => ({
        type: "notes-synth",
        accountId,
        enabled: true,
      })),
    });
    expect(registered.errors).toEqual([]);
  }, 90_000);
  afterAll(async () => {
    await harness?.destroy();
  }, 20_000);

  async function deviceRequest(path: string, body?: unknown): Promise<Response> {
    return fetch(`${harness.gatewayUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${collector.token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function deviceJson<T>(path: string, body?: unknown): Promise<T> {
    const response = await deviceRequest(path, body);
    const text = await response.text();
    if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`);
    return JSON.parse(text) as T;
  }
  const admin = <T>(path: string, body?: unknown, method = "POST") =>
    harness.json<T>(path, body === undefined ? undefined : { method, body: JSON.stringify(body) });
  function document(
    sourceId: string,
    externalId: string,
    date = OLD,
    content = "Invented storage fixture",
    metadata = {},
  ) {
    return {
      providerId: sourceId,
      sourceId,
      externalId,
      title: "Storage fixture",
      content,
      contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      metadata,
      sourceCreatedAt: date,
      sourceUpdatedAt: date,
    };
  }
  const push = (documents: ReturnType<typeof document>[]) =>
    deviceJson<{ ingested: number }>("/documents", { documents });
  function stored(sourceId: string): string[] {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return db
        .prepare<[string], { external_id: string }>(
          "SELECT external_id FROM documents WHERE source_id = ? ORDER BY external_id",
        )
        .all(sourceId)
        .map((row) => row.external_id);
    } finally {
      db.close();
    }
  }

  test("a one-byte limit parks growth, keeps reads and settings usable, and does not advance cursors", async () => {
    await expect
      .poll(async () => (await admin<StorageSnapshot>("/admin/storage")).pressure.state, {
        timeout: 15_000,
      })
      .toBe("blocked");
    try {
      const sourcePath = `/sync-state/${encodeURIComponent(SOURCE)}`;
      const stateBefore = await deviceJson<{ cursor: unknown; wipeEpoch: number }>(sourcePath);
      const ingest = await deviceRequest("/documents", {
        documents: [document(SOURCE, "blocked")],
      });
      expect(ingest.status).toBe(507);
      expect(await ingest.json()).toMatchObject({ code: "INSUFFICIENT_STORAGE" });
      const cursor = await deviceRequest(sourcePath, {
        cursor: { page: 99 },
        writeEpoch: stateBefore.wipeEpoch,
      });
      expect(cursor.status).toBe(507);
      const attempt = await deviceRequest(`${sourcePath}/begin`, { attemptId: randomUUID() });
      expect(attempt.status).toBe(507);
      const analytics = await deviceRequest("/analytics/ingest", {
        tableName: "storage_fixture_rows",
        sourceId: SOURCE,
        schema: {
          tableName: "storage_fixture_rows",
          displayName: "Storage counters",
          description: "Invented counters",
          columns: [{ name: "id", type: "VARCHAR", description: "Row key" }],
          primaryKey: ["id"],
        },
        records: [{ id: "blocked-row" }],
      });
      expect(analytics.status).toBe(507);
      expect(stored(SOURCE)).toEqual([]);
      const stateAfter = await deviceJson<{ cursor: unknown; wipeEpoch: number }>(sourcePath);
      expect(stateAfter.cursor).toEqual(stateBefore.cursor);
      expect(stateAfter.wipeEpoch).toBe(stateBefore.wipeEpoch);
    } finally {
      const recovered = await admin<StorageSnapshot>(
        "/admin/storage/policy",
        { maxBytes: null },
        "PATCH",
      );
      expect(recovered.policy.maxBytes).toBeNull();
      expect(recovered.pressure.state).toBe("normal");
      expect(
        await push([
          document(SOURCE, "old"),
          document(SOURCE, "young", RECENT),
          document(SOURCE, "contact", OLD, "Invented contact", { documentType: "contact" }),
          document(SIBLING, "sibling-old"),
        ]),
      ).toMatchObject({ ingested: 4 });
    }
  });

  test("storage inventory and controls require admin scope", async () => {
    const reader = await admin<{ token: string }>("/admin/devices", {
      name: "storage-read-only",
      kind: "cli",
      scopes: ["read"],
    });
    const read = await fetch(`${harness.gatewayUrl}/admin/storage`, {
      headers: { Authorization: `Bearer ${reader.token}` },
    });
    expect(read.status).toBe(403);
    const startResponse = await fetch(`${harness.gatewayUrl}/admin/storage/trim/jobs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${reader.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: SOURCE, before: CUTOFF }),
    });
    expect(startResponse.status).toBe(403);
    await expect(
      admin("/admin/storage/trim/jobs", { sourceId: SOURCE, before: "invalid" }),
    ).rejects.toMatchObject({ status: 400 });
    const response = await fetch(`${harness.gatewayUrl}/admin/storage/policy`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${reader.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ maxBytes: 1 }),
    });
    expect(response.status).toBe(403);
    const unauthenticated = await fetch(`${harness.gatewayUrl}/admin/storage`);
    expect(unauthenticated.status).toBe(401);
  });

  test("one cutoff command preserves newer data, contacts and siblings and suppresses removed identities", async () => {
    const job = await admin<StorageSnapshot["trimJobs"][number]>("/admin/storage/trim/jobs", {
      sourceId: SOURCE,
      before: CUTOFF,
    });
    await expect
      .poll(
        async () =>
          (await admin<StorageSnapshot>("/admin/storage")).trimJobs.find(
            (entry) => entry.id === job.id,
          )?.state,
        { timeout: 30_000, interval: 300 },
      )
      .toBe("completed");
    expect(stored(SOURCE)).toEqual(["contact", "young"]);
    expect(stored(SIBLING)).toEqual(["sibling-old"]);
    await push([document(SOURCE, "old", OLD, "Updated upstream content must stay suppressed")]);
    expect(stored(SOURCE)).toEqual(["contact", "young"]);
  }, 40_000);

  test("one trim request removes every older document across batches and resumes after restart", async () => {
    const old = Array.from({ length: 253 }, (_, index) =>
      document(SOURCE, `durable-${String(index).padStart(3, "0")}`),
    );
    await push(old);
    expect(await admin<{ paused: boolean }>("/admin/background/pause", {})).toMatchObject({
      paused: true,
    });
    const job = await admin<StorageSnapshot["trimJobs"][number]>("/admin/storage/trim/jobs", {
      sourceId: SOURCE,
      before: CUTOFF,
    });
    expect(job).toMatchObject({ sourceId: SOURCE, before: CUTOFF, state: "queued", deleted: 0 });
    // No second confirmation is sent, even though the request exceeds one page.
    await harness.restartGateway();
    await expect
      .poll(
        async () => {
          const snapshot = await admin<StorageSnapshot>("/admin/storage");
          return snapshot.trimJobs.find((entry) => entry.id === job.id)?.state;
        },
        { timeout: 90_000, interval: 300 },
      )
      .toBe("completed");
    const completed = (await admin<StorageSnapshot>("/admin/storage")).trimJobs.find(
      (entry) => entry.id === job.id,
    )!;
    expect(completed.deleted).toBe(253);
    expect(stored(SOURCE)).toEqual(["contact", "young"]);
    expect(stored(SIBLING)).toEqual(["sibling-old"]);
    await push([document(SOURCE, "durable-000", OLD, "Changed content must remain suppressed")]);
    expect(stored(SOURCE)).toEqual(["contact", "young"]);
    await harness.restartGateway();
    expect((await admin<StorageSnapshot>("/admin/storage")).trimJobs).toContainEqual(
      expect.objectContaining({ id: job.id, state: "completed", deleted: 253 }),
    );
  }, 150_000);

  test("rolling retention prunes stored old data and rejects reingestion while retaining contacts and recent data", async () => {
    await push([
      document(ROLLING, "rolling-old"),
      document(ROLLING, "rolling-young", RECENT),
      document(ROLLING, "rolling-contact", OLD, "Invented contact", { documentType: "contact" }),
    ]);
    await admin("/admin/storage/retention", { sourceId: ROLLING, maxAgeDays: 365 }, "PATCH");
    const config = JSON.parse(readFileSync(join(harness.gatewayConfigDir, "omnesis.json"), "utf8"));
    expect(config.gateway.storage.retention).toEqual([{ sourceId: ROLLING, maxAgeDays: 365 }]);
    const bindingDb = new Database(harness.getDbPath(), { readonly: true });
    try {
      expect(
        bindingDb
          .prepare("SELECT source_incarnation FROM storage_retention_bindings WHERE source_id = ?")
          .get(ROLLING),
      ).toMatchObject({ source_incarnation: expect.any(String) });
    } finally {
      bindingDb.close();
    }
    await expect
      .poll(() => stored(ROLLING), { timeout: 30_000, interval: 300 })
      .toEqual(["rolling-contact", "rolling-young"]);
    await push([
      document(ROLLING, "rolling-old"),
      document(ROLLING, "new-old"),
      document(ROLLING, "new-young", RECENT),
    ]);
    expect(stored(ROLLING)).toEqual(["new-young", "rolling-contact", "rolling-young"]);
    expect(stored(SIBLING)).toEqual(["sibling-old"]);
  }, 40_000);

  test("limits and rolling retention survive restart; disabling rolling retention allows old data again", async () => {
    const limit = 10 * 1024 ** 3;
    await admin("/admin/storage/policy", { maxBytes: limit }, "PATCH");
    await harness.restartGateway();
    const snapshot = await admin<StorageSnapshot>("/admin/storage");
    expect(snapshot.policy.maxBytes).toBe(limit);
    expect(snapshot.retention).toContainEqual(
      expect.objectContaining({ sourceId: ROLLING, maxAgeDays: 365 }),
    );
    await push([document(ROLLING, "still-filtered")]);
    expect(stored(ROLLING)).not.toContain("still-filtered");
    await admin("/admin/storage/retention", { sourceId: ROLLING, maxAgeDays: null }, "PATCH");
    await push([document(ROLLING, "rolling-old")]);
    expect(stored(ROLLING)).toContain("rolling-old");
    await push([document(SOURCE, "old")]);
    expect(stored(SOURCE)).not.toContain("old");
  }, 90_000);
});

describe("independent storage accounting without an indexer", () => {
  let harness: MultiCollectorHarness;
  let collector: PairedCollector;
  beforeAll(async () => {
    harness = new MultiCollectorHarness({ extraGatewayEnv: { OMNESIS_INDEXER_ENABLED: "false" } });
    await harness.start();
    collector = await harness.addCollector({
      name: "accounting-fixture",
      hostableSourceTypes: ["notes-synth"],
    });
    const response = await fetch(`${harness.gatewayUrl}/devices/sources/bulk-upsert`, {
      method: "POST",
      headers: { Authorization: `Bearer ${collector.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: [{ type: "notes-synth", accountId: "storage-accounting", enabled: true }],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ errors: [] });
  }, 90_000);
  afterAll(async () => {
    await harness?.destroy();
  }, 20_000);
  const admin = <T>(path: string, body?: unknown, method = "POST") =>
    harness.json<T>(path, body === undefined ? undefined : { method, body: JSON.stringify(body) });
  function document(sourceId: string, externalId: string, date: string, content: string) {
    return {
      providerId: sourceId,
      sourceId,
      externalId,
      title: "Invented accounting entry",
      content,
      contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      metadata: {},
      sourceCreatedAt: date,
      sourceUpdatedAt: date,
    };
  }
  async function push(documents: ReturnType<typeof document>[]) {
    const response = await fetch(`${harness.gatewayUrl}/documents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${collector.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ documents }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ingested: documents.length });
  }
  function stored(sourceId: string): string[] {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return db
        .prepare<[string], { external_id: string }>(
          "SELECT external_id FROM documents WHERE source_id=? ORDER BY external_id",
        )
        .all(sourceId)
        .map((row) => row.external_id);
    } finally {
      db.close();
    }
  }

  test("source accounting works through read workers without an indexer and reflects trimming after restart", async () => {
    async function measuredDocuments(expected: number): Promise<StorageSnapshot> {
      let latest: StorageSnapshot | undefined;
      // A scan already in flight owns its earlier high-water mark. A subsequent
      // pass must see writes committed after that mark without restarting it.
      await expect
        .poll(
          async () => {
            latest = await admin<StorageSnapshot>("/admin/storage/refresh", {});
            return latest.logical?.sources.find((row) => row.sourceId === ACCOUNTING)?.documents;
          },
          { timeout: 15_000, interval: 100 },
        )
        .toBe(expected);
      return latest!;
    }
    await admin("/admin/storage/policy", { maxBytes: null }, "PATCH");
    await push([
      document(ACCOUNTING, "measurement-old", OLD, "Invented café entry"),
      document(
        ACCOUNTING,
        "measurement-kept",
        "2012-02-10T00:00:00.000Z",
        "Invented archive entry",
      ),
      document(ACCOUNTING, "measurement-new", RECENT, "Invented recent entry"),
    ]);
    const measured = await measuredDocuments(3);
    const source = measured.logical?.sources.find((row) => row.sourceId === ACCOUNTING);
    expect(source).toMatchObject({ documents: 3, payloadBytes: expect.any(Number) });
    expect(source!.payloadBytes).toBeGreaterThan(0);
    expect(source!.months.map((month) => month.month)).toContain("2001-01");
    // This harness has no model/indexer to answer an accounting RPC. The
    // initialized index file must still be measurable through the real IO pool.
    expect(measured.index).not.toBeNull();
    expect(measured.accounting).toMatchObject({
      logical: { state: "ready", error: null },
      index: { state: "ready", error: null },
    });
    const job = await admin<StorageSnapshot["trimJobs"][number]>("/admin/storage/trim/jobs", {
      sourceId: ACCOUNTING,
      before: CUTOFF,
    });
    await expect
      .poll(
        async () => {
          const snapshot = await admin<StorageSnapshot>("/admin/storage");
          return snapshot.trimJobs.find((row) => row.id === job.id)?.state;
        },
        { timeout: 30_000, interval: 200 },
      )
      .toBe("completed");
    const afterTrim = await measuredDocuments(2);
    const kept = afterTrim.logical?.sources.find((row) => row.sourceId === ACCOUNTING);
    expect(kept!.documents).toBe(2);
    expect(kept!.months.map((month) => month.month)).not.toContain("2001-01");
    expect(kept!.payloadBytes).toBeLessThan(source!.payloadBytes);
    expect(stored(ACCOUNTING)).toEqual(["measurement-kept", "measurement-new"]);
    await harness.restartGateway();
    const restarted = await measuredDocuments(2);
    expect(restarted.accounting.logical.state).toBe("ready");
    expect(restarted.accounting.index.state).toBe("ready");
    const restored = restarted.logical?.sources.find((row) => row.sourceId === ACCOUNTING);
    expect(restored!.documents).toBe(2);
    expect(restored!.months.map((month) => month.month)).not.toContain("2001-01");
  }, 90_000);
});
