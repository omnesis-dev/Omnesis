// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The wire contract between the browser extension's push pipeline and the
 * gateway's request-body schemas.
 *
 * The extension builds its payloads with `buildWebPageDocument` /
 * `buildPageVisit` and its transport wraps them in the `POST /documents` and
 * `POST /analytics/ingest` envelopes; the gateway re-validates both at its zod
 * boundary (`ingestDocumentsBody`, `analyticsIngestBody`). The two sides live in
 * different compile units and the extension ships as a browser bundle, so a
 * shape change on either side would otherwise only surface as a rejected push
 * against a live gateway. This suite runs the real `PushClient` against a
 * recording fetch, so the envelopes under test are the ones the transport
 * actually sends, and parses them with the real gateway schemas.
 */
import {
  PushClient,
  PAGE_VISITS_SCHEMA,
  WEB_SOURCE_ID,
  buildPageVisit,
  buildWebPageDocument,
  type DurableStore,
  type FetchLike,
  type PageVisit,
} from "@omnesis/extension";
import webSource from "@omnesis/provider-web";
import { describe, expect, it } from "vitest";
import { analyticsIngestBody } from "./analytics.js";
import { ingestDocumentsBody } from "./documents.js";
import type { DocumentInput } from "@omnesis/types";

const GATEWAY_URL = "https://gateway.example.com:7600";
const VISITED_AT = "2026-02-01T09:30:00.000Z";
const CONTENT_HASH = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const BROWSER_PROFILE = {
  deviceId: "0d0e0f10-1111-4222-8333-444455556666",
  label: "Personal",
};

const pageCapture = {
  normalizedUrl: "https://news.example.com/articles/quarterly-planning",
  title: "Quarterly planning notes",
  text: "Invented readable text about a fictional quarterly planning session.",
  contentHash: CONTENT_HASH,
  visitedAt: VISITED_AT,
};

const visitCapture = {
  normalizedUrl: pageCapture.normalizedUrl,
  title: pageCapture.title,
  visitedAt: VISITED_AT,
  dwellMs: 12_345.6,
};

interface RecordedRequest {
  path: string;
  body: unknown;
}

/**
 * Drive one queue item through the real transport and return the request it
 * produced. The fetch answers with the success body the transport requires so
 * the item is delivered (and the drain settles) rather than retained.
 */
async function recordDelivery(
  enqueue: (client: PushClient) => Promise<void>,
): Promise<RecordedRequest> {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = (input, init) => {
    const path = new URL(input).pathname;
    requests.push({ path, body: JSON.parse(init.body) as unknown });
    return Promise.resolve({
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify({ ingested: 1, deleted: 0 })),
    });
  };
  const memory = new Map<string, string>();
  const store: DurableStore = {
    get: (key) => Promise.resolve(memory.get(key)),
    set: (key, value) => {
      memory.set(key, value);
      return Promise.resolve();
    },
  };
  const client = new PushClient({ gatewayUrl: GATEWAY_URL, token: "test-token", fetch, store });
  await enqueue(client);
  const result = await client.drain();
  expect(result.delivered).toBe(1);
  expect(requests).toHaveLength(1);
  return requests[0]!;
}

function recordDocument(doc: DocumentInput): Promise<RecordedRequest> {
  return recordDelivery((client) => client.enqueueDocument(doc));
}

function recordVisit(visit: PageVisit): Promise<RecordedRequest> {
  return recordDelivery((client) => client.enqueueVisit(visit));
}

/** JSON round-trip: what the gateway receives is the serialized form, not the object. */
function overTheWire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("extension → POST /documents", () => {
  it("delivers a profile-attributed web page that ingestDocumentsBody accepts unchanged", async () => {
    const doc = await buildWebPageDocument({ ...pageCapture, browserProfile: BROWSER_PROFILE });
    const request = await recordDocument(doc);

    expect(request.path).toBe("/documents");
    const parsed = ingestDocumentsBody.safeParse(request.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // Metadata passes through as built: the gateway strips only the retired
    // `captureMethod` producer field, which the extension no longer sends.
    expect(parsed.data.documents).toEqual([overTheWire(doc)]);
    expect(parsed.data.documents[0]!.metadata).not.toHaveProperty("captureMethod");
    expect(parsed.data.documents[0]!.metadata.extra).toEqual({
      browserDeviceId: BROWSER_PROFILE.deviceId,
      browserProfileLabel: BROWSER_PROFILE.label,
    });
    expect(parsed.data.writeEpochs).toBeUndefined();
  });

  it("delivers an unattributed web page that ingestDocumentsBody accepts unchanged", async () => {
    const doc = await buildWebPageDocument(pageCapture);
    const request = await recordDocument(doc);

    const parsed = ingestDocumentsBody.safeParse(request.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.documents).toEqual([overTheWire(doc)]);
    expect(parsed.data.documents[0]!.metadata).not.toHaveProperty("extra");
    expect(parsed.data.documents[0]!.metadata).not.toHaveProperty("captureMethod");
  });

  it("rejects a document envelope whose document lacks contentHash", async () => {
    const { contentHash: _omitted, ...withoutHash } = await buildWebPageDocument(pageCapture);
    const parsed = ingestDocumentsBody.safeParse({ documents: [withoutHash] });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.path)).toContainEqual([
      "documents",
      0,
      "contentHash",
    ]);
  });
});

describe("extension → POST /analytics/ingest", () => {
  it("delivers a profile-attributed visit that analyticsIngestBody accepts with its schema intact", async () => {
    const visit = buildPageVisit({ ...visitCapture, browserProfile: BROWSER_PROFILE });
    const request = await recordVisit(visit);

    expect(request.path).toBe("/analytics/ingest");
    const parsed = analyticsIngestBody.safeParse(request.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.tableName).toBe(PAGE_VISITS_SCHEMA.tableName);
    expect(parsed.data.sourceId).toBe(WEB_SOURCE_ID);
    expect(parsed.data.records).toEqual([overTheWire(visit)]);
    // The extension's literal already spells every column type in the
    // source-sdk's canonical form, so the gateway's normalization returns the
    // schema as sent. If this assertion ever fails, the extension is sending a
    // spelling the gateway rewrites, and the two literals have diverged.
    expect(parsed.data.schema).toEqual(overTheWire(PAGE_VISITS_SCHEMA));
    expect(parsed.data.deletedIds).toBeUndefined();
    expect(parsed.data.presentIds).toBeUndefined();
  });

  it("delivers an unattributed visit that analyticsIngestBody accepts", async () => {
    const visit = buildPageVisit(visitCapture);
    const request = await recordVisit(visit);

    const parsed = analyticsIngestBody.safeParse(request.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.records).toEqual([overTheWire(visit)]);
    expect(parsed.data.records[0]).not.toHaveProperty("browser_device_id");
    expect(parsed.data.records[0]).not.toHaveProperty("browser_profile_label");
    expect(parsed.data.schema).toEqual(overTheWire(PAGE_VISITS_SCHEMA));
  });

  it("fills every schema column, with the primary key and other non-nullable columns non-null", () => {
    // The row as the gateway sees it: a JSON object, keyed by column name.
    const asRow = (visit: PageVisit) =>
      JSON.parse(JSON.stringify(visit)) as Record<string, unknown>;
    const attributed = asRow(buildPageVisit({ ...visitCapture, browserProfile: BROWSER_PROFILE }));
    const unattributed = asRow(buildPageVisit(visitCapture));

    // An attributed visit names every column the schema declares.
    for (const column of PAGE_VISITS_SCHEMA.columns) {
      expect(attributed).toHaveProperty(column.name);
    }
    // Whether or not the profile is known, the primary key and every other
    // non-nullable column carry a value; nullable ones may be null or absent.
    for (const row of [attributed, unattributed]) {
      for (const key of PAGE_VISITS_SCHEMA.primaryKey) {
        expect(row[key]).not.toBeNull();
        expect(row[key]).toBeDefined();
      }
      for (const column of PAGE_VISITS_SCHEMA.columns) {
        if (column.nullable) continue;
        expect(row[column.name]).not.toBeNull();
        expect(row[column.name]).toBeDefined();
      }
      // No column the schema does not declare.
      for (const key of Object.keys(row)) {
        expect(PAGE_VISITS_SCHEMA.columns.map((column) => column.name)).toContain(key);
      }
    }
    expect(attributed.dwell_ms).toBe(12_346);
  });

  it("rejects a visit envelope whose schema uses a column type outside the source-sdk allowlist", () => {
    const visit = buildPageVisit(visitCapture);
    const parsed = analyticsIngestBody.safeParse({
      tableName: PAGE_VISITS_SCHEMA.tableName,
      sourceId: WEB_SOURCE_ID,
      records: [visit],
      schema: {
        ...PAGE_VISITS_SCHEMA,
        columns: PAGE_VISITS_SCHEMA.columns.map((column) =>
          column.name === "dwell_ms" ? { ...column, type: "GEOMETRY" } : column,
        ),
      },
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.path).toEqual(["schema"]);
    expect(parsed.error.issues[0]?.message).toMatch(/unsupported analytics column type/);
  });
});

describe("page_visits schema parity", () => {
  it("the extension's PAGE_VISITS_SCHEMA literal equals the web source's declared schema", () => {
    // The extension carries a browser-bundle-safe copy of the schema the `web`
    // source declares; this is the unit-level twin of the spawned-gateway
    // parity check, so a change to either literal reddens here first.
    const declared = webSource.analyticsSchemas?.find(
      (schema) => schema.tableName === PAGE_VISITS_SCHEMA.tableName,
    );
    expect(declared).toBeDefined();
    expect(PAGE_VISITS_SCHEMA).toEqual(declared);
  });
});
