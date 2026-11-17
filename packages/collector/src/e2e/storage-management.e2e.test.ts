// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MultiCollectorHarness, type PairedCollector } from "./multi-collector-harness.js";

const SOURCE = "notes-synth:storage-primary";
const SIBLING = "notes-synth:storage-sibling";
const ROLLING = "notes-synth:storage-rolling";
const OLD = "2001-01-01T00:00:00.000Z";
const RECENT = new Date().toISOString();
const CUTOFF = "2010-01-01T00:00:00.000Z";

interface StorageSnapshot {
  physical: { totalBytes: number } | null;
  pressure: { state: string; usageBytes: number | null };
  policy: { maxBytes: number | null };
  retention: Array<{ sourceId: string; maxAgeDays: number }>;
  logical: { sources: Array<{ sourceId: string; documents: number }> } | null;
}
interface Preview {
  token: string;
  sourceId: string;
  before: string;
  documents: number;
  hasMore: boolean;
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
  const preview = (sourceId = SOURCE, before = CUTOFF) =>
    admin<Preview>("/admin/storage/trim/preview", { sourceId, before });
  const trim = (token: string) =>
    admin<{ deleted: number; hasMore: boolean }>("/admin/storage/trim", { token });

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
    const previewResponse = await fetch(`${harness.gatewayUrl}/admin/storage/trim/preview`, {
      method: "POST",
      headers: { Authorization: `Bearer ${reader.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: SOURCE, before: CUTOFF }),
    });
    expect(previewResponse.status).toBe(403);
    const response = await fetch(`${harness.gatewayUrl}/admin/storage/policy`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${reader.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ maxBytes: 1 }),
    });
    expect(response.status).toBe(403);
    const unauthenticated = await fetch(`${harness.gatewayUrl}/admin/storage`);
    expect(unauthenticated.status).toBe(401);
  });

  test("preview removes exactly old source documents, preserving young data, contacts, and sibling sources", async () => {
    const plan = await preview();
    expect(plan).toMatchObject({ sourceId: SOURCE, before: CUTOFF, documents: 1, hasMore: false });
    expect(stored(SOURCE)).toEqual(["contact", "old", "young"]);
    expect(await trim(plan.token)).toMatchObject({ deleted: 1, hasMore: false });
    expect(stored(SOURCE)).toEqual(["contact", "young"]);
    expect(stored(SIBLING)).toEqual(["sibling-old"]);
    await expect(trim(plan.token)).rejects.toMatchObject({ status: 409 });
    await push([document(SOURCE, "old", OLD, "Updated upstream content must stay suppressed")]);
    expect(stored(SOURCE)).toEqual(["contact", "young"]);
  });

  test("a changed document invalidates the whole approval and deletes nothing", async () => {
    await push([document(SOURCE, "stale-a"), document(SOURCE, "stale-b")]);
    const plan = await preview();
    expect(plan.documents).toBe(2);
    await push([document(SOURCE, "stale-a", OLD, "A new revision arrived after preview")]);
    await expect(trim(plan.token)).rejects.toMatchObject({ status: 409 });
    expect(stored(SOURCE)).toEqual(["contact", "stale-a", "stale-b", "young"]);
    await expect(trim(plan.token)).rejects.toMatchObject({ status: 409 });
    const fresh = await preview();
    expect(await trim(fresh.token)).toMatchObject({ deleted: 2 });
  });

  test("one confirmation is bounded to 100 exact documents", async () => {
    await push(
      Array.from({ length: 101 }, (_, index) =>
        document(SOURCE, `batch-${String(index).padStart(3, "0")}`),
      ),
    );
    const plan = await preview();
    expect(plan.documents).toBe(100);
    expect(plan.hasMore).toBe(true);
    expect(await trim(plan.token)).toMatchObject({ deleted: 100, hasMore: true });
    const remaining = stored(SOURCE);
    expect(remaining).toHaveLength(3);
    expect(remaining).toEqual(expect.arrayContaining(["contact", "young"]));
    expect(remaining.filter((id) => id.startsWith("batch-"))).toHaveLength(1);
    expect(await trim((await preview()).token)).toMatchObject({ deleted: 1 });
  });

  test("rolling retention prunes stored old data and rejects reingestion while retaining contacts and recent data", async () => {
    await push([
      document(ROLLING, "rolling-old"),
      document(ROLLING, "rolling-young", RECENT),
      document(ROLLING, "rolling-contact", OLD, "Invented contact", { documentType: "contact" }),
    ]);
    await admin("/admin/storage/retention", { sourceId: ROLLING, maxAgeDays: 365 }, "PATCH");
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
