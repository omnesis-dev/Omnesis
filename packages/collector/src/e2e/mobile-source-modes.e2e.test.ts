// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Production mobile source contracts through the real pairing and gateway
 * routes. The wire announcements are explicit here rather than imported from
 * gateway expectations, so a production contract drift can make this test fail.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { DEVICE_HOSTED_SOURCE_TYPES, type DeviceCapability } from "@omnesis/types";
import { GatewayWsClient } from "@omnesis/gateway-client";
import { MultiCollectorHarness } from "./multi-collector-harness.js";

interface MobileDevice {
  id: string;
  token: string;
  tokenId: string;
  kind: "ios" | "android";
}

interface SourceRow {
  id: string;
  deviceId: string;
  multiDeviceMode: string;
  members: string[];
  replicaVersionPolicy?: string;
}

const NATIVE_MODE_ANNOUNCEMENTS = {
  ios: {
    "apple-health": "replicated",
    "activity-segments": "partitioned",
    "core-location-visits": "partitioned",
    photos: "partitioned",
  },
  android: {
    "health-connect": "partitioned",
    "android-activity-segments": "partitioned",
    photos: "partitioned",
  },
} as const;

/** The gateway of the describe block running; each block boots its own. */
let harness: MultiCollectorHarness;
const devices: MobileDevice[] = [];

const request = async <T>(path: string, token: string, init?: RequestInit): Promise<T> => {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init?.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${harness.gatewayUrl}${path}`, { ...init, headers });
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${path} → ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
};

const capabilities = (kind: "ios" | "android", installId: string): DeviceCapability => {
  const sourceTypes = [...DEVICE_HOSTED_SOURCE_TYPES[kind]].sort();
  const multiDeviceModes = NATIVE_MODE_ANNOUNCEMENTS[kind];
  const replicaVersionPolicies: DeviceCapability["replicaVersionPolicies"] =
    kind === "ios" ? { "apple-health": "source-updated-at" } : {};
  return {
    platform: kind,
    installId,
    suggestedName: `fictional-${kind}-${installId.slice(-6)}`,
    hostableSourceTypes: sourceTypes,
    pushBasedSourceTypes: sourceTypes,
    multiDeviceModes,
    replicaVersionPolicies,
    syncLease: Object.values(multiDeviceModes).includes("replicated"),
  };
};

const pair = async (
  kind: "ios" | "android",
  suffix: string,
  /** Types this device's app announces as exclusive: it predates their multi-device contract. */
  legacyTypes: readonly string[] = [],
): Promise<MobileDevice> => {
  const staged = await request<{ pairingCode: string }>(
    "/admin/devices/pair",
    harness.bootstrapToken,
    {
      method: "POST",
      body: JSON.stringify({ kind }),
    },
  );
  const response = await fetch(`${harness.gatewayUrl}/devices/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pairingCode: staged.pairingCode,
      capabilities: {
        ...capabilities(kind, `fictional-install-${suffix}`),
        ...(legacyTypes.length > 0
          ? {
              multiDeviceModes: {
                ...NATIVE_MODE_ANNOUNCEMENTS[kind],
                ...Object.fromEntries(legacyTypes.map((type) => [type, "exclusive"])),
              },
              replicaVersionPolicies: Object.fromEntries(
                Object.entries(capabilities(kind, suffix).replicaVersionPolicies ?? {}).filter(
                  ([type]) => !legacyTypes.includes(type),
                ),
              ),
            }
          : {}),
      },
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    device: { id: string };
    token: string;
    tokenId: string;
  };
  const device = { id: body.device.id, token: body.token, tokenId: body.tokenId, kind };
  devices.push(device);
  return device;
};

const contribute = async (device: MobileDevice, type: string, accountId = "local") => {
  const result = await request<{ errors: unknown[] }>(
    "/devices/sources/bulk-upsert",
    device.token,
    {
      method: "POST",
      body: JSON.stringify({ sources: [{ type, accountId, enabled: true }] }),
    },
  );
  expect(result.errors).toEqual([]);
};

const source = async (id: string): Promise<SourceRow> => {
  const { items } = await request<{ items: SourceRow[] }>("/admin/sources", harness.bootstrapToken);
  return items.find((item) => item.id === id)!;
};

const ingest = (device: MobileDevice, sourceId: string, tableName: string, id: string, value = 7) =>
  request<{ ingested: number }>("/analytics/ingest", device.token, {
    method: "POST",
    body: JSON.stringify({
      sourceId,
      tableName,
      schema: {
        tableName,
        displayName: "Synthetic mobile rows",
        description: "Invented rows for multi-device acceptance",
        columns: [
          { name: "id", type: "VARCHAR", description: "Stable row id" },
          { name: "value", type: "BIGINT", description: "Synthetic value" },
        ],
        primaryKey: ["id"],
        semanticTimeColumn: null,
      },
      records: [{ id, value }],
      deletedIds: [],
    }),
  });

const sql = async (query: string): Promise<unknown[][]> =>
  (
    await request<{ rows: unknown[][] }>("/analytics/sql", harness.bootstrapToken, {
      method: "POST",
      body: JSON.stringify({ sql: query }),
    })
  ).rows;

const pushSourceDocument = async (
  device: MobileDevice,
  sourceId: string,
  externalId: string,
  content: string,
  sourceUpdatedAt: string,
  documentType: string,
  providerId = sourceId,
) => {
  return request<{ ingested: number }>("/documents", device.token, {
    method: "POST",
    body: JSON.stringify({
      documents: [
        {
          providerId,
          sourceId,
          externalId,
          title: "Synthetic movement day",
          content,
          contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
          metadata: { documentType },
          sourceCreatedAt: sourceUpdatedAt,
          sourceUpdatedAt,
        },
      ],
    }),
  });
};

const pushActivityDocument = async (
  device: MobileDevice,
  sourceId: string,
  externalId: string,
  content: string,
) =>
  pushSourceDocument(
    device,
    sourceId,
    externalId,
    content,
    new Date().toISOString(),
    "activity-segment-day",
  );

const documentContent = (sourceId: string, externalId: string): string | null => {
  const db = new Database(harness.getDbPath(), { readonly: true });
  try {
    return (
      db
        .prepare<[string, string], { content: string }>(
          "SELECT content FROM documents WHERE source_id = ? AND external_id = ?",
        )
        .get(sourceId, externalId)?.content ?? null
    );
  } finally {
    db.close();
  }
};

const documentStreams = (sourceId: string): { rows: number; streams: number } => {
  const db = new Database(harness.getDbPath(), { readonly: true });
  try {
    return db
      .prepare<[string], { rows: number; streams: number }>(
        "SELECT COUNT(*) AS rows, COUNT(DISTINCT stream_id) AS streams FROM documents WHERE source_id = ?",
      )
      .get(sourceId)!;
  } finally {
    db.close();
  }
};

describe("production mobile source modes", () => {
  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    await harness.start();
  }, 120_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("Photos adopts the incumbent library and isolates iOS and Android lifecycle operations", async () => {
    const id = "photos:local";
    const path = `/admin/sources/${encodeURIComponent(id)}`;
    const owner = await pair("ios", "photos-incumbent", ["photos"]);
    const android = await pair("android", "photos-new");
    const oldPhone = await pair("ios", "photos-old-build", ["photos"]);
    await contribute(owner, "photos");
    const push = (device: MobileDevice, externalId: string, content: string) =>
      pushSourceDocument(
        device,
        id,
        externalId,
        content,
        "2026-01-02T12:00:00.000Z",
        "photo",
        "photos",
      );
    const rows = () => {
      const db = new Database(harness.getDbPath(), { readonly: true });
      try {
        return db
          .prepare<
            [string],
            { id: string; stream_id: string; external_id: string; content: string }
          >(
            "SELECT id, stream_id, external_id, content FROM documents WHERE source_id = ? ORDER BY stream_id, external_id",
          )
          .all(id);
      } finally {
        db.close();
      }
    };
    const statePath = `/sync-state/${encodeURIComponent(id)}`;
    await push(owner, "42", "Invented library photo with OCR text");
    await request(statePath, owner.token, {
      method: "POST",
      body: JSON.stringify({ cursor: { phase: "backfill", offset: 42 } }),
    });
    const legacyRows = rows();
    expect(legacyRows).toHaveLength(1);
    expect(legacyRows[0]!.stream_id).toBe("");
    // Updating an announcement alone is not a mode transition. The upgraded
    // app explicitly prepares its source before reading a new sync cursor.
    const ws = new GatewayWsClient(harness.gatewayUrl, owner.token, {
      capabilities: capabilities("ios", "fictional-install-photos-incumbent"),
    });
    try {
      ws.connect();
      await expect.poll(() => ws.isAuthenticated(), { timeout: 10_000 }).toBe(true);
      expect((await source(id)).multiDeviceMode).toBe("exclusive");
      await request(path, owner.token, {
        method: "PATCH",
        body: JSON.stringify({ multiDeviceMode: "partitioned" }),
      });
    } finally {
      ws.disconnect();
    }
    expect(rows()).toEqual([{ ...legacyRows[0]!, stream_id: owner.id }]);
    expect(await request(statePath, owner.token)).toMatchObject({
      cursor: { phase: "backfill", offset: 42 },
    });
    // Idempotent upgrade/restart preserves document identity and progress.
    await request(path, owner.token, {
      method: "PATCH",
      body: JSON.stringify({ multiDeviceMode: "partitioned" }),
    });
    await harness.restartGateway();
    expect(rows()).toEqual([{ ...legacyRows[0]!, stream_id: owner.id }]);
    await push(owner, "42", legacyRows[0]!.content);
    expect(rows()).toEqual([{ ...legacyRows[0]!, stream_id: owner.id }]);
    await contribute(android, "photos");
    const refused = await request<{ errors: unknown[] }>(
      "/devices/sources/bulk-upsert",
      oldPhone.token,
      {
        method: "POST",
        body: JSON.stringify({ sources: [{ type: "photos", accountId: "local", enabled: true }] }),
      },
    );
    expect(refused.errors).toHaveLength(1);
    await expect(push(oldPhone, "42", "Old client must not overwrite a member")).rejects.toThrow(
      "409",
    );
    await push(android, "42", "A distinct photo with the same local identifier");
    await push(android, "42", "A distinct photo with the same local identifier");
    expect(documentStreams(id)).toEqual({ rows: 2, streams: 2 });
    expect(rows().find((row) => row.stream_id === owner.id)).toEqual({
      ...legacyRows[0]!,
      stream_id: owner.id,
    });
    await request(statePath, android.token, {
      method: "POST",
      body: JSON.stringify({ cursor: { phase: "steady", offset: 7 } }),
    });
    expect(await request(statePath, owner.token)).toMatchObject({
      cursor: { phase: "backfill", offset: 42 },
    });
    await request("/documents/reconcile", android.token, {
      method: "POST",
      body: JSON.stringify({ providerId: "photos", sourceId: id, presentExternalIds: [] }),
    });
    const absenceDb = new Database(harness.getDbPath(), { readonly: true });
    try {
      expect(
        absenceDb
          .prepare("SELECT stream_id, external_id FROM document_absences WHERE source_id = ?")
          .all(id),
      ).toEqual([{ stream_id: android.id, external_id: "42" }]);
    } finally {
      absenceDb.close();
    }
    await request(`${path}/members/${android.id}`, android.token, { method: "DELETE" });
    expect(rows()).toEqual([{ ...legacyRows[0]!, stream_id: owner.id }]);
    // A buffered page is not an opt-in. This must remain true after the
    // cleanup journal completes and after every in-memory guard is lost.
    await harness.restartGateway();
    await expect(push(android, "42", "Late buffered photo after detach")).rejects.toThrow("409");
    expect((await source(id)).members).toEqual([owner.id]);
    expect(rows()).toEqual([{ ...legacyRows[0]!, stream_id: owner.id }]);
    await contribute(android, "photos");
    await push(android, "42", "Photo restored after rejoining");
    expect(documentStreams(id)).toEqual({ rows: 2, streams: 2 });
    expect(rows().find((row) => row.stream_id === owner.id)?.id).toBe(legacyRows[0]!.id);
    await request("/documents/delete", android.token, {
      method: "POST",
      body: JSON.stringify({ providerId: "photos", sourceId: id, externalIds: ["42"] }),
    });
    expect(rows()).toEqual([{ ...legacyRows[0]!, stream_id: owner.id }]);
    await push(android, "43", "Invented screenshot to reindex");
    const reset = await request(`${path}/resync`, harness.bootstrapToken, {
      method: "POST",
      body: JSON.stringify({ deviceId: android.id }),
    });
    expect(reset).toMatchObject({ ok: true, scope: "stream" });
    expect(rows()).toEqual([{ ...legacyRows[0]!, stream_id: owner.id }]);
    expect(await request(statePath, android.token)).toMatchObject({ cursor: null });
    expect(await request(statePath, owner.token)).toMatchObject({
      cursor: { phase: "backfill", offset: 42 },
    });
    await push(android, "43", "Invented screenshot to reindex");
    expect(documentStreams(id)).toEqual({ rows: 2, streams: 2 });
    const tablet = await pair("ios", "photos-tablet");
    await contribute(tablet, "photos");
    await push(tablet, "43", "Independent tablet image sharing a local identifier");
    expect(documentStreams(id)).toEqual({ rows: 3, streams: 3 });
    const beforeDowngrade = rows();
    const downgraded = new GatewayWsClient(harness.gatewayUrl, owner.token, {
      capabilities: {
        ...capabilities("ios", "fictional-install-photos-incumbent"),
        multiDeviceModes: { ...NATIVE_MODE_ANNOUNCEMENTS.ios, photos: "exclusive" },
      },
    });
    try {
      downgraded.connect();
      await expect.poll(() => downgraded.isAuthenticated(), { timeout: 10_000 }).toBe(true);
      await expect(push(owner, "42", "Downgraded owner must not write")).rejects.toThrow("409");
      await expect(
        request(statePath, owner.token, {
          method: "POST",
          body: JSON.stringify({ cursor: { offset: 999 } }),
        }),
      ).rejects.toThrow("409");
      expect(rows()).toEqual(beforeDowngrade);
      expect((await source(id)).multiDeviceMode).toBe("partitioned");
    } finally {
      downgraded.disconnect();
    }
  }, 120_000);

  test("apple-health pairs two Apple devices into one replicated source", async () => {
    const phone = await pair("ios", "health-phone");
    const tablet = await pair("ios", "health-tablet");
    await contribute(phone, "apple-health");
    await contribute(tablet, "apple-health");

    expect(await source("apple-health:local")).toMatchObject({
      multiDeviceMode: "replicated",
      members: [phone.id, tablet.id],
      replicaVersionPolicy: "source-updated-at",
    });
    expect(
      await ingest(phone, "apple-health:local", "mobile_health_rows", "shared-row", 7),
    ).toMatchObject({
      ingested: 1,
    });
    await request(`/sync-state/${encodeURIComponent("apple-health:local")}/lease`, phone.token, {
      method: "DELETE",
    });
    expect(
      await request<{ granted: boolean }>(
        `/sync-state/${encodeURIComponent("apple-health:local")}/lease`,
        tablet.token,
        { method: "POST", body: "{}" },
      ),
    ).toMatchObject({ granted: true });
    expect(
      await ingest(tablet, "apple-health:local", "mobile_health_rows", "shared-row", 11),
    ).toMatchObject({
      ingested: 1,
    });
    expect(await sql("SELECT COUNT(*), MAX(value) FROM mobile_health_rows")).toEqual([[1, 11]]);
    await pushSourceDocument(
      phone,
      "apple-health:local",
      "sample:stable-uuid",
      "Fresh synthetic health sample",
      "2026-08-29T12:00:00.000Z",
      "health-sample",
    );
    await pushSourceDocument(
      tablet,
      "apple-health:local",
      "sample:stable-uuid",
      "Stale synthetic health sample",
      "2026-08-28T12:00:00.000Z",
      "health-sample",
    );
    expect(documentContent("apple-health:local", "sample:stable-uuid")).toBe(
      "Fresh synthetic health sample",
    );

    await request(
      `/admin/sources/${encodeURIComponent("apple-health:local")}/members/${tablet.id}`,
      harness.bootstrapToken,
      { method: "DELETE" },
    );
    expect((await source("apple-health:local")).members).toEqual([phone.id]);
    expect(await sql("SELECT COUNT(*) FROM mobile_health_rows")).toEqual([[1]]);
  }, 60_000);

  test.each([
    {
      kind: "android" as const,
      type: "health-connect",
      table: "android_health_rows",
    },
  ])(
    "$type keeps one analytics stream per physical device",
    async ({ kind, type, table }) => {
      const first = await pair(kind, `${type}-one`);
      const second = await pair(kind, `${type}-two`);
      await contribute(first, type);
      await contribute(second, type);
      const sourceId = `${type}:local`;
      expect(await source(sourceId)).toMatchObject({
        multiDeviceMode: "partitioned",
        members: [first.id, second.id],
      });

      await ingest(first, sourceId, table, "same-upstream-id");
      await ingest(second, sourceId, table, "same-upstream-id");
      expect(await sql(`SELECT COUNT(*), COUNT(DISTINCT _stream_id) FROM ${table}`)).toEqual([
        [2, 2],
      ]);

      await request(
        `/admin/sources/${encodeURIComponent(sourceId)}/members/${second.id}`,
        harness.bootstrapToken,
        { method: "DELETE" },
      );
      expect((await source(sourceId)).members).toEqual([first.id]);
      expect(await sql(`SELECT COUNT(*), COUNT(DISTINCT _stream_id) FROM ${table}`)).toEqual([
        [1, 1],
      ]);
    },
    90_000,
  );

  test.each([
    { kind: "ios" as const, type: "activity-segments" },
    { kind: "android" as const, type: "android-activity-segments" },
  ])(
    "$type keeps the production document stream of each physical device",
    async ({ kind, type }) => {
      const first = await pair(kind, `${type}-docs-one`);
      const second = await pair(kind, `${type}-docs-two`);
      await contribute(first, type);
      await contribute(second, type);
      const sourceId = `${type}:local`;

      await pushActivityDocument(
        first,
        sourceId,
        "day:2026-08-28",
        "Invented phone movement summary",
      );
      await pushActivityDocument(
        second,
        sourceId,
        "day:2026-08-28",
        "Invented tablet movement summary",
      );
      expect(documentStreams(sourceId)).toEqual({ rows: 2, streams: 2 });

      await request(
        `/admin/sources/${encodeURIComponent(sourceId)}/members/${second.id}`,
        harness.bootstrapToken,
        { method: "DELETE" },
      );
      expect((await source(sourceId)).members).toEqual([first.id]);
      expect(documentStreams(sourceId)).toEqual({ rows: 1, streams: 1 });
    },
    90_000,
  );
});

/**
 * A replacement phone meets sources an earlier phone created before the
 * partitioned contract existed. It boots its own gateway: pairing is rate
 * limited per address, and the block above already pairs many devices.
 */
describe("a new phone and an earlier phone's legacy sources", () => {
  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    await harness.start();
  }, 120_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test.each([
    { label: "revoked", type: "core-location-visits", revoke: true },
    { label: "paired on an app that predates the contract", type: "photos", revoke: false },
  ])(
    "a new iPhone converts a legacy exclusive $type source whose earlier phone is $label",
    async ({ type, revoke }) => {
      const id = `${type}:earlier-phone`;
      const path = `/admin/sources/${encodeURIComponent(id)}`;
      const earlier = await pair("ios", `${type}-earlier`, [type]);
      await contribute(earlier, type, "earlier-phone");
      expect(await source(id)).toMatchObject({
        deviceId: earlier.id,
        multiDeviceMode: "exclusive",
      });
      const push = (device: MobileDevice, externalId: string, content: string) =>
        pushSourceDocument(
          device,
          id,
          externalId,
          content,
          "2026-02-03T09:00:00.000Z",
          "synthetic-item",
          type,
        );
      await push(earlier, "item-1", "Invented item kept from the earlier phone");
      await push(earlier, "item-2", "Another invented item from the earlier phone");
      const rows = () => {
        const db = new Database(harness.getDbPath(), { readonly: true });
        try {
          return db
            .prepare<[string], { stream_id: string; external_id: string; content: string }>(
              "SELECT stream_id, external_id, content FROM documents WHERE source_id = ? ORDER BY stream_id, external_id",
            )
            .all(id);
        } finally {
          db.close();
        }
      };
      const earlierRows = rows().map((row) => ({ ...row, stream_id: earlier.id }));
      expect(earlierRows).toHaveLength(2);
      if (revoke) {
        await request(`/admin/devices/${earlier.id}`, harness.bootstrapToken, {
          method: "DELETE",
        });
      }

      // What the new phone's activation sends: convert, then join.
      const current = await pair("ios", `${type}-current`);
      await request(path, current.token, {
        method: "PATCH",
        body: JSON.stringify({ multiDeviceMode: "partitioned" }),
      });
      await request(`${path}/members`, current.token, {
        method: "POST",
        body: JSON.stringify({ deviceId: current.id }),
      });
      expect(await source(id)).toMatchObject({
        deviceId: earlier.id,
        multiDeviceMode: "partitioned",
        members: [earlier.id, current.id],
      });
      expect(rows()).toEqual(earlierRows);

      await push(current, "item-1", "Invented item from the new phone with the same local id");
      await push(current, "item-3", "Invented item only the new phone has");
      await request("/documents/reconcile", current.token, {
        method: "POST",
        body: JSON.stringify({ providerId: type, sourceId: id, presentExternalIds: ["item-3"] }),
      });
      expect(rows().filter((row) => row.stream_id === earlier.id)).toEqual(earlierRows);
      expect(rows().filter((row) => row.stream_id === current.id)).toHaveLength(2);
      const absenceDb = new Database(harness.getDbPath(), { readonly: true });
      try {
        expect(
          absenceDb
            .prepare("SELECT DISTINCT stream_id FROM document_absences WHERE source_id = ?")
            .all(id),
        ).toEqual([{ stream_id: current.id }]);
      } finally {
        absenceDb.close();
      }
      if (revoke) return;

      // The earlier phone is refused with the update message until its app
      // announces the partitioned contract; then it writes its own stream.
      await expect(push(earlier, "item-2", "Write from the outdated app")).rejects.toThrow(
        /409.*update the device/,
      );
      expect(rows().filter((row) => row.stream_id === earlier.id)).toEqual(earlierRows);
      const updated = new GatewayWsClient(harness.gatewayUrl, earlier.token, {
        capabilities: capabilities("ios", `fictional-install-${type}-earlier`),
      });
      try {
        updated.connect();
        await expect.poll(() => updated.isAuthenticated(), { timeout: 10_000 }).toBe(true);
        await push(earlier, "item-4", "Invented item after the earlier phone updated");
      } finally {
        updated.disconnect();
      }
      expect(rows().filter((row) => row.stream_id === earlier.id)).toHaveLength(3);
      expect(rows().filter((row) => row.stream_id === current.id)).toHaveLength(2);
    },
    90_000,
  );
  test.each([
    { label: "revoked", revoke: true },
    { label: "paired on an app that predates the contract", revoke: false },
  ])(
    "a new iPhone shares a legacy exclusive apple-health source whose earlier phone is $label",
    async ({ revoke }) => {
      const type = "apple-health";
      const id = `${type}:earlier-phone`;
      const path = `/admin/sources/${encodeURIComponent(id)}`;
      const table = revoke ? "earlier_health_revoked" : "earlier_health_outdated";
      const earlier = await pair("ios", `health-earlier-${revoke}`, [type]);
      await contribute(earlier, type, "earlier-phone");
      expect(await source(id)).toMatchObject({
        deviceId: earlier.id,
        multiDeviceMode: "exclusive",
      });
      await ingest(earlier, id, table, "kept-row", 3);
      await pushSourceDocument(
        earlier,
        id,
        "sample:earlier",
        "Invented sample from the earlier phone",
        "2026-03-01T08:00:00.000Z",
        "health-sample",
      );
      if (revoke) {
        await request(`/admin/devices/${earlier.id}`, harness.bootstrapToken, {
          method: "DELETE",
        });
      }

      const current = await pair("ios", `health-current-${revoke}`);
      // The new phone can tell that the current owner will not contribute.
      expect(
        (
          await request<{ items: Array<SourceRow & { dormantHosts: string[] }> }>(
            "/admin/sources",
            current.token,
          )
        ).items.find((item) => item.id === id)?.dormantHosts,
      ).toEqual([earlier.id]);
      await request(path, current.token, {
        method: "PATCH",
        body: JSON.stringify({ multiDeviceMode: "replicated" }),
      });
      await request(`${path}/members`, current.token, {
        method: "POST",
        body: JSON.stringify({ deviceId: current.id }),
      });
      expect(await source(id)).toMatchObject({
        deviceId: earlier.id,
        multiDeviceMode: "replicated",
        members: [earlier.id, current.id],
        replicaVersionPolicy: "source-updated-at",
      });

      await ingest(current, id, table, "new-row", 5);
      await pushSourceDocument(
        current,
        id,
        "sample:current",
        "Invented sample from the new phone",
        "2026-03-02T08:00:00.000Z",
        "health-sample",
      );
      expect(await sql(`SELECT id, value FROM ${table} ORDER BY id`)).toEqual([
        ["kept-row", 3],
        ["new-row", 5],
      ]);
      expect(documentContent(id, "sample:earlier")).toBe("Invented sample from the earlier phone");
      expect(documentContent(id, "sample:current")).toBe("Invented sample from the new phone");
      if (revoke) return;

      // The earlier phone's outdated app cannot write to the shared rows.
      await expect(ingest(earlier, id, table, "kept-row", 99)).rejects.toThrow(/409/);
      await expect(
        pushSourceDocument(
          earlier,
          id,
          "sample:earlier",
          "Overwrite from the outdated app",
          "2026-03-09T08:00:00.000Z",
          "health-sample",
        ),
      ).rejects.toThrow(/409/);
      expect(await sql(`SELECT value FROM ${table} WHERE id = 'kept-row'`)).toEqual([[3]]);
      expect(documentContent(id, "sample:earlier")).toBe("Invented sample from the earlier phone");
      const updated = new GatewayWsClient(harness.gatewayUrl, earlier.token, {
        capabilities: capabilities("ios", `fictional-install-health-earlier-${revoke}`),
      });
      try {
        updated.connect();
        await expect.poll(() => updated.isAuthenticated(), { timeout: 10_000 }).toBe(true);
        await ingest(earlier, id, table, "updated-row", 7);
      } finally {
        updated.disconnect();
      }
      expect(await sql(`SELECT id FROM ${table} ORDER BY id`)).toEqual([
        ["kept-row"],
        ["new-row"],
        ["updated-row"],
      ]);
    },
    90_000,
  );
});
