// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The pages a collector that has not been updated still sends.
 *
 * An operator upgrades the gateway first — it is the thing that holds the
 * data, and the phones and the second machine follow when they follow. So
 * every field this branch added has an older spelling still on the wire, and
 * the claim that matters is not that the new spelling works but that the old
 * one is still understood, in the same way, by the code that now prefers the
 * new one.
 *
 * Written as hand-built request bodies rather than through a collector,
 * deliberately: a real collector would send today's shape, and the shape under
 * test is precisely the one no code in this repository produces any more.
 */

import "./synth-env.js";
import Database from "better-sqlite3";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SOURCE_CONTRACT_WIRE_RANGE } from "@omnesis/core";
import { MultiCollectorHarness } from "./multi-collector-harness.js";
import type { PairedCollector } from "./multi-collector-harness.js";

const SOURCE = "gmail-synth:old@example.com";

let harness: MultiCollectorHarness;
let collectorToken: string;
let collector: PairedCollector;

/** One page as an older collector posts it, with only the fields it knew. */
async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${harness.gatewayUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${collectorToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function readDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(harness.getDbPath(), { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function document(externalId: string, title: string): Record<string, unknown> {
  const content = `${title} body`;
  return {
    providerId: SOURCE,
    sourceId: SOURCE,
    externalId,
    title,
    content,
    // No `partitionKey`: the field did not exist when this collector shipped.
    contentHash: `sha256:${externalId}`,
    metadata: {},
    sourceCreatedAt: "2026-01-01T00:00:00Z",
    sourceUpdatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("a collector that predates this branch, against the new gateway", () => {
  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    await harness.start();
    collector = await harness.addCollector({
      name: "older-machine",
      hostableSourceTypes: ["gmail-synth"],
    });
    collectorToken = collector.token;
    await harness.json("/admin/sources/add", {
      method: "POST",
      body: JSON.stringify({
        deviceId: collector.deviceId,
        descriptorId: "gmail-synth",
        accountIds: ["old@example.com"],
      }),
    });
  }, 60_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("documents with no partition land in the unnamed partition", async () => {
    const res = await post("/documents", {
      documents: [document("m-1", "First"), document("m-2", "Second")],
    });
    expect(res.status).toBe(200);

    expect(
      readDb((db) =>
        db
          .prepare<
            [string],
            { external_id: string; partition_key: string }
          >("SELECT external_id, partition_key FROM documents WHERE source_id = ? ORDER BY external_id")
          .all(SOURCE),
      ),
    ).toEqual([
      { external_id: "m-1", partition_key: "" },
      { external_id: "m-2", partition_key: "" },
    ]);
  });

  test("its whole-source snapshot still reaches every one of them", async () => {
    // The regression this exists to catch: a snapshot that reconciles nothing
    // because the documents are in a partition it never names. `m-2` is
    // omitted, so the gateway must record its absence — the number that says
    // the snapshot was compared against the corpus rather than past it.
    const res = await post("/documents/reconcile", {
      providerId: SOURCE,
      sourceId: SOURCE,
      presentExternalIds: ["m-1"],
      observationId: "old-collector-obs-1",
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { absence?: { absent: number; stored: number } };
    expect(body.absence).toMatchObject({ absent: 1, stored: 2 });
    // Recorded, never applied on the spot.
    expect(
      readDb(
        (db) =>
          db
            .prepare<
              [string],
              { n: number }
            >("SELECT COUNT(*) AS n FROM documents WHERE source_id = ?")
            .get(SOURCE)!.n,
      ),
    ).toBe(2);
  });

  test("a sync-state push with no family declares no family", async () => {
    const res = await post(`/sync-state/${encodeURIComponent(SOURCE)}`, {
      cursor: { page: 1 },
      label: "An older account label",
    });
    expect(res.status).toBe(200);

    expect(
      readDb(
        (db) =>
          db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM source_family_meta").get()!.n,
      ),
    ).toBe(0);
    expect(
      readDb((db) =>
        db
          .prepare<[string], { label: string }>("SELECT label FROM sync_state WHERE source_id = ?")
          .get(SOURCE),
      ),
    ).toEqual({ label: "An older account label" });
  });

  test("an analytics page keyed by one column is understood, and fixes the table's key", async () => {
    const schema = {
      tableName: "old_wire_samples",
      displayName: "Samples",
      description: "Fictional rows from an older collector",
      columns: [
        { name: "record_id", type: "VARCHAR", description: "Parent record" },
        { name: "sample_index", type: "BIGINT", description: "Sample" },
      ],
      primaryKey: ["record_id", "sample_index"],
      semanticTimeColumn: null,
      record: { titleColumns: ["record_id"], keyColumns: ["record_id", "sample_index"] },
    };
    expect(
      (
        await post("/analytics/ingest", {
          tableName: schema.tableName,
          sourceId: SOURCE,
          schema,
          records: [
            { record_id: "r-1", sample_index: 0 },
            { record_id: "r-1", sample_index: 1 },
            { record_id: "r-2", sample_index: 0 },
          ],
        })
      ).status,
    ).toBe(200);

    // The spelling this branch replaced: values plus the column they match on.
    const deleted = await post("/analytics/ingest", {
      tableName: schema.tableName,
      sourceId: SOURCE,
      records: [],
      deletedIds: ["r-1"],
      deleteKeyColumn: "record_id",
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ deleted: 2 });

    // And the table now says how it is addressed, so a later page naming a
    // different column is refused rather than opening a second key space.
    const confused = await post("/analytics/ingest", {
      tableName: schema.tableName,
      sourceId: SOURCE,
      records: [],
      deletedIds: ["0"],
      deleteKeyColumn: "sample_index",
    });
    expect(confused.status).toBe(400);
  });

  test("legacy WebSocket progress and URL/QR auth remain observable", async () => {
    // Literal v0.4.22 event payloads: no structured progress units or auth challenge.
    collector.ws.emitEvent("sync.status", {
      sourceId: SOURCE,
      state: "syncing",
      progress: {
        phase: "Fetching",
        processed: 2,
        total: 4,
        percentComplete: 50,
        message: "Reading pages",
      },
    });
    await expect
      .poll(() => harness.json(`/admin/sync/status/${encodeURIComponent(SOURCE)}`), {
        timeout: 10_000,
      })
      .toMatchObject({
        state: "syncing",
        progress: { processed: 2, total: 4, percentComplete: 50 },
      });
    collector.ws.emitEvent("sync.status", { sourceId: SOURCE, state: "completed" });

    const { flowId } = await harness.json<{ flowId: string }>("/admin/auth-flows", {
      method: "POST",
      body: JSON.stringify({ deviceId: collector.deviceId, sourceType: "gmail-synth" }),
    });
    collector.ws.emitEvent("auth.update", {
      flowId,
      type: "url",
      url: "https://auth.example.com/authorize",
    });
    await expect
      .poll(() => harness.json(`/admin/auth-flows/${flowId}`), { timeout: 10_000 })
      .toMatchObject({ state: "awaiting-user", authUrl: "https://auth.example.com/authorize" });
    collector.ws.emitEvent("auth.update", {
      flowId,
      type: "qr",
      data: "fictional-pairing-payload",
    });
    await expect
      .poll(() => harness.json(`/admin/auth-flows/${flowId}`), { timeout: 10_000 })
      .toMatchObject({ qrData: "fictional-pairing-payload" });
    await harness.json(`/admin/auth-flows/${flowId}/cancel`, { method: "POST" });
  });

  test("adoption refuses old cursor and data traffic without disturbing untouched sources", async () => {
    const untouched = "gmail-synth:untouched@example.org";
    await harness.json("/admin/sources/add", {
      method: "POST",
      body: JSON.stringify({
        deviceId: collector.deviceId,
        descriptorId: "gmail-synth",
        accountIds: ["untouched@example.org"],
      }),
    });
    const oldCapabilities = collector.capabilities;
    await harness.reannounceCollector(collector, {
      ...oldCapabilities,
      sourceContract: SOURCE_CONTRACT_WIRE_RANGE,
    });
    const claim = await post(`/sync-state/${encodeURIComponent(SOURCE)}/begin`, {});
    expect(claim.status).toBe(200);
    const { wipeEpoch } = (await claim.json()) as { wipeEpoch: number };
    const envelope = { e: 1, v: 1, s: SOURCE, state: { bookmark: 23 } };
    expect(
      (
        await post("/documents/with-cursor", {
          providerId: SOURCE,
          sourceId: SOURCE,
          documents: [
            { ...document("m-1", "Preserved modern content"), partitionKey: "example-notebook" },
          ],
          cursor: envelope,
          wipeEpoch,
          hasMore: false,
        })
      ).status,
    ).toBe(200);
    await harness.reannounceCollector(collector, oldCapabilities);
    const getCursor = () =>
      fetch(`${harness.gatewayUrl}/sync-state/${encodeURIComponent(SOURCE)}`, {
        headers: { Authorization: `Bearer ${collectorToken}` },
      });
    expect((await getCursor()).status).toBe(409);
    for (const [path, body] of [
      [
        `/sync-state/${encodeURIComponent(SOURCE)}`,
        { cursor: { page: 99 }, writeEpoch: wipeEpoch },
      ],
      [`/sync-state/${encodeURIComponent(SOURCE)}/begin`, {}],
      ["/documents", { documents: [document("m-1", "Stale content")] }],
      [
        "/documents/with-cursor",
        { providerId: SOURCE, sourceId: SOURCE, cursor: {}, hasMore: false, wipeEpoch },
      ],
      ["/documents/reconcile", { providerId: SOURCE, sourceId: SOURCE, presentExternalIds: [] }],
      ["/analytics/ingest", { tableName: "old_wire_samples", sourceId: SOURCE, records: [] }],
      ["/analytics/ingest", { tableName: "old_wire_samples", records: [] }],
      [`/documents/delete-all/source/${encodeURIComponent(SOURCE)}`, {}],
      [`/documents/delete-all/provider/${encodeURIComponent(SOURCE)}`, {}],
    ] as const) {
      const response = await post(path, body);
      expect(response.status, path).toBe(409);
      expect(await response.json()).toMatchObject({ code: "SOURCE_WIRE_CONTRACT_UNSUPPORTED" });
    }
    expect(
      (await post(`/sync-state/${encodeURIComponent(untouched)}`, { cursor: { page: 1 } })).status,
    ).toBe(200);
    expect(
      readDb((db) =>
        db
          .prepare("SELECT cursor FROM sync_state WHERE source_id = ? AND device_id = ''")
          .get(SOURCE),
      ),
    ).toEqual({ cursor: JSON.stringify(envelope) });
    expect(
      readDb((db) =>
        db
          .prepare(
            "SELECT title, partition_key FROM documents WHERE source_id = ? AND external_id = 'm-1'",
          )
          .get(SOURCE),
      ),
    ).toEqual({ title: "Preserved modern content", partition_key: "example-notebook" });
    await harness.restartGateway();
    expect((await getCursor()).status).toBe(409);
    expect(await harness.json(`/admin/sync/status/${encodeURIComponent(SOURCE)}`)).toMatchObject({
      state: "error",
      remediation: { restartRequired: true },
    });
  }, 60_000);

  test.each(["replicated", "handoff"] as const)(
    "mixed %s members cannot overwrite an adopted shared envelope",
    async (mode) => {
      const type = `wire-${mode}-synth`;
      const sourceId = `${type}:shared`;
      const first = await harness.addCollector({
        name: `${mode}-modern`,
        hostableSourceTypes: [type],
        multiDeviceModes: { [type]: mode },
        syncLease: true,
      });
      const legacy = await harness.addCollector({
        name: `${mode}-legacy`,
        hostableSourceTypes: [type],
        multiDeviceModes: { [type]: mode },
        syncLease: true,
      });
      const request = (peer: PairedCollector, path: string, body?: unknown) =>
        fetch(`${harness.gatewayUrl}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      for (const peer of [first, legacy]) {
        const joined = await request(peer, "/devices/sources/bulk-upsert", {
          sources: [{ type, accountId: "shared", enabled: true }],
        });
        expect(joined.status).toBe(200);
        expect(await joined.json()).toMatchObject({ errors: [] });
      }
      const statePath = `/sync-state/${encodeURIComponent(sourceId)}`;
      const envelope = { e: 1, v: 1, s: sourceId, state: { bookmark: 47 } };
      // The shared row predates member rows; a replica must not adopt an envelope it cannot decode.
      await harness.json(statePath, { method: "POST", body: JSON.stringify({ cursor: envelope }) });
      const legacyLease = await request(legacy, `${statePath}/lease`, {});
      expect(legacyLease.status).toBe(200);
      expect(await legacyLease.json()).toMatchObject({ granted: true });
      await harness.reannounceCollector(first, {
        ...first.capabilities,
        sourceContract: SOURCE_CONTRACT_WIRE_RANGE,
      });
      // Real collectors claim before beginning a tick. Adoption must evict an
      // incompatible live incumbent, otherwise a handoff can never upgrade.
      const modernLease = await request(first, `${statePath}/lease`, {});
      expect(modernLease.status).toBe(200);
      expect(await modernLease.json()).toMatchObject({ granted: true, holder: first.deviceId });
      expect((await request(legacy, `${statePath}/lease`, {})).status).toBe(409);
      expect((await request(first, `${statePath}/begin`, {})).status).toBe(200);
      for (let tick = 0; tick < 2; tick++) {
        expect((await request(legacy, statePath)).status).toBe(409);
        expect((await request(legacy, statePath, { cursor: { reset: true } })).status).toBe(409);
        const modernRead = await request(first, statePath);
        expect(modernRead.status).toBe(200);
        expect(await modernRead.json()).toMatchObject({ cursor: envelope });
      }
      const status = await harness.json<{ members: Array<{ deviceId: string; state: string }> }>(
        `/admin/sync/status/${encodeURIComponent(sourceId)}`,
      );
      expect(status.members.find((member) => member.deviceId === legacy.deviceId)?.state).toBe(
        "error",
      );
      expect(status.members.find((member) => member.deviceId === first.deviceId)?.state).not.toBe(
        "error",
      );
      // A later downgrade of the current holder must not strand its upgraded peer.
      await harness.reannounceCollector(first, {
        ...first.capabilities,
        sourceContract: undefined,
      });
      await harness.reannounceCollector(legacy, {
        ...legacy.capabilities,
        sourceContract: SOURCE_CONTRACT_WIRE_RANGE,
      });
      const takeover = await request(legacy, `${statePath}/lease`, {});
      expect(takeover.status).toBe(200);
      expect(await takeover.json()).toMatchObject({ granted: true, holder: legacy.deviceId });
    },
    60_000,
  );
});
