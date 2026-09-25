// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import {
  buildBoundDocumentRegistry,
  canonicalRowKey,
  reconstructBoundDocumentRef,
  reconstructRowKey,
  type BoundDocumentBinding,
  type BoundDocumentCatalogRow,
} from "./bound-documents.js";

/** Build a binding the way the registry would, for reconstructRowKey tests. */
function binding(
  over: Partial<BoundDocumentBinding> &
    Pick<BoundDocumentBinding, "tableName" | "primaryKey" | "columnTypes" | "spec">,
): BoundDocumentBinding {
  return {
    tableDisplayName: over.tableName,
    sourceId: over.sourceId ?? over.tableName,
    columns: over.columns ?? Object.keys(over.columnTypes),
    ...over,
  };
}

describe("canonicalRowKey", () => {
  it("NUL-joins so a ':'-containing value can't collide with another tuple", () => {
    expect(canonicalRowKey(["a", "b"])).toBe("a\u0000b");
    // "a:b" + "c" must differ from "a" + "b:c"
    expect(canonicalRowKey(["a:b", "c"])).not.toBe(canonicalRowKey(["a", "b:c"]));
  });
});

describe("reconstructRowKey", () => {
  it("single-column numeric key casts to the declared type (Strava)", () => {
    const b = binding({
      tableName: "strava_activities",
      primaryKey: ["id"],
      columnTypes: { id: "BIGINT" },
      spec: { externalIdColumns: ["id"] },
    });
    const key = reconstructRowKey({ externalId: "14269000123", sourceId: "strava:athlete1" }, b);
    expect(key).toEqual({
      keyColumns: [{ name: "id", castType: "BIGINT" }],
      keyValues: ["14269000123"],
      pkString: "14269000123",
    });
  });

  it("single-column VARCHAR key needs no cast (Granola)", () => {
    const b = binding({
      tableName: "granola_meetings",
      primaryKey: ["id"],
      columnTypes: { id: "VARCHAR" },
      spec: { externalIdColumns: ["id"] },
    });
    const key = reconstructRowKey({ externalId: "note-abc", sourceId: "granola:acct" }, b);
    expect(key?.keyColumns).toEqual([{ name: "id", castType: "VARCHAR" }]);
    expect(key?.keyValues).toEqual(["note-abc"]);
  });

  it("strips a prefix and rejects documents lacking it (Notion row- vs db-)", () => {
    const b = binding({
      tableName: "notion_db1",
      primaryKey: ["id"],
      columnTypes: { id: "VARCHAR" },
      spec: { externalIdColumns: ["id"], externalIdPrefix: "row-" },
    });
    expect(
      reconstructRowKey({ externalId: "row-PAGE123", sourceId: "notion:ws" }, b)?.pkString,
    ).toBe("PAGE123");
    // The per-database summary doc (db-<id>) is not bound to a row.
    expect(reconstructRowKey({ externalId: "db-PAGE123", sourceId: "notion:ws" }, b)).toBeNull();
  });

  it("splits a composite externalId into the primary-key columns, casting each", () => {
    const b = binding({
      tableName: "activity_rows",
      primaryKey: ["account_key", "activity_id"],
      columnTypes: { account_key: "VARCHAR", activity_id: "BIGINT" },
      spec: { externalIdColumns: ["account_key", "activity_id"] },
    });
    const key = reconstructRowKey({ externalId: "acctA:7777", sourceId: "synthetic:acct" }, b);
    expect(key?.keyColumns).toEqual([
      { name: "account_key", castType: "VARCHAR" },
      { name: "activity_id", castType: "BIGINT" },
    ]);
    expect(key?.keyValues).toEqual(["acctA", "7777"]);
    expect(key?.pkString).toBe("acctA:7777");
    // Arity mismatch (no separator) → not bound.
    expect(reconstructRowKey({ externalId: "acctA", sourceId: "synthetic:acct" }, b)).toBeNull();
  });

  it("fills a source-discriminator column from the doc's account id, keeping the externalId whole (calendar)", () => {
    const b = binding({
      tableName: "calendar_events",
      primaryKey: ["source", "event_id"],
      columnTypes: { source: "VARCHAR", event_id: "VARCHAR" },
      spec: { externalIdColumns: ["event_id"], sourceKeyColumns: ["source"] },
    });
    // Google externalId is `${calendarId}:${eventId}` — the ':' must stay inside
    // event_id (single externalIdColumn → no split), while `source` comes from
    // the account id of the doc's source-id.
    const key = reconstructRowKey(
      { externalId: "calA:evt1", sourceId: "google:user@example.com" },
      b,
    );
    expect(key?.keyValues).toEqual(["user@example.com", "calA:evt1"]); // primary-key order
    expect(key?.pkString).toBe("user@example.com:calA:evt1");
  });
});

describe("reconstructRowKey on a stream-keyed table", () => {
  it("appends the document's stream to the row key, the empty stream when it has none", () => {
    const binding: BoundDocumentBinding = {
      tableName: "location_visits",
      tableDisplayName: "Visits",
      sourceId: "core-location-visits:local",
      primaryKey: ["id"],
      columns: ["id"],
      columnTypes: { id: "VARCHAR" },
      spec: { externalIdColumns: ["id"] },
      streamKeyed: true,
    };
    const keyed = reconstructRowKey(
      { externalId: "visit-1", sourceId: "core-location-visits:local", streamId: "device-a" },
      binding,
    );
    expect(keyed?.keyColumns.map((c) => c.name)).toEqual(["id", "_stream_id"]);
    expect(keyed?.keyValues).toEqual(["visit-1", "device-a"]);
    const unstreamed = reconstructRowKey(
      { externalId: "visit-1", sourceId: "core-location-visits:local" },
      binding,
    );
    expect(unstreamed?.keyValues).toEqual(["visit-1", ""]);
    const plain = reconstructRowKey(
      { externalId: "visit-1", sourceId: "core-location-visits:local", streamId: "device-a" },
      { ...binding, streamKeyed: false },
    );
    expect(plain?.keyValues).toEqual(["visit-1"]);
  });
});

describe("reconstructBoundDocumentRef (row → document, #757)", () => {
  /** Build a map<col,value> the way a RecordReference's PK columns supply it. */
  function pk(pairs: [string, string][]): Map<string, string> {
    return new Map(pairs);
  }

  it("inverts a single-column key back to the document externalId (Strava)", () => {
    const b = binding({
      tableName: "strava_activities",
      sourceId: "strava:athlete1",
      primaryKey: ["id"],
      columnTypes: { id: "BIGINT" },
      spec: { externalIdColumns: ["id"] },
    });
    const ref = reconstructBoundDocumentRef(pk([["id", "14269000123"]]), b);
    expect(ref).toEqual({ externalId: "14269000123", sourceId: "strava:athlete1" });
  });

  it("re-applies the externalId prefix (Notion row-)", () => {
    const b = binding({
      tableName: "notion_db1",
      sourceId: "notion:ws",
      primaryKey: ["id"],
      columnTypes: { id: "VARCHAR" },
      spec: { externalIdColumns: ["id"], externalIdPrefix: "row-" },
    });
    const ref = reconstructBoundDocumentRef(pk([["id", "PAGE123"]]), b);
    expect(ref?.externalId).toBe("row-PAGE123");
  });

  it("rejoins a composite externalId with the spec separator", () => {
    const b = binding({
      tableName: "activity_rows",
      sourceId: "synthetic:acct",
      primaryKey: ["account_key", "activity_id"],
      columnTypes: { account_key: "VARCHAR", activity_id: "BIGINT" },
      spec: { externalIdColumns: ["account_key", "activity_id"] },
    });
    const ref = reconstructBoundDocumentRef(
      pk([
        ["account_key", "acctA"],
        ["activity_id", "7777"],
      ]),
      b,
    );
    expect(ref?.externalId).toBe("acctA:7777");
  });

  it("reconstructs the owning source-id from a source-discriminator column (calendar)", () => {
    const b = binding({
      tableName: "calendar_events",
      sourceId: "google:user@example.com",
      primaryKey: ["source", "event_id"],
      columnTypes: { source: "VARCHAR", event_id: "VARCHAR" },
      spec: { externalIdColumns: ["event_id"], sourceKeyColumns: ["source"] },
    });
    const ref = reconstructBoundDocumentRef(
      pk([
        ["source", "user@example.com"],
        ["event_id", "calA:evt1"],
      ]),
      b,
    );
    // externalId is the event_id alone; the discriminator rebuilds the source id.
    expect(ref).toEqual({ externalId: "calA:evt1", sourceId: "google:user@example.com" });
  });

  it("round-trips with reconstructRowKey (document → row → document)", () => {
    const b = binding({
      tableName: "calendar_events",
      sourceId: "google:user@example.com",
      primaryKey: ["source", "event_id"],
      columnTypes: { source: "VARCHAR", event_id: "VARCHAR" },
      spec: { externalIdColumns: ["event_id"], sourceKeyColumns: ["source"] },
    });
    const doc = { externalId: "calA:evt1", sourceId: "google:user@example.com" };
    const key = reconstructRowKey(doc, b)!;
    const back = reconstructBoundDocumentRef(
      new Map(key.keyColumns.map((kc, i) => [kc.name, key.keyValues[i]])),
      b,
    );
    expect(back).toEqual(doc);
  });

  it("returns null when a required externalId column is missing", () => {
    const b = binding({
      tableName: "strava_activities",
      sourceId: "strava:athlete1",
      primaryKey: ["id"],
      columnTypes: { id: "BIGINT" },
      spec: { externalIdColumns: ["id"] },
    });
    expect(reconstructBoundDocumentRef(pk([["other", "x"]]), b)).toBeNull();
  });
});

describe("buildBoundDocumentRegistry", () => {
  const rows: BoundDocumentCatalogRow[] = [
    {
      tableName: "strava_activities",
      displayName: "Strava Activities",
      sourceId: "strava:athlete1",
      primaryKey: ["id"],
      columns: [
        { name: "id", type: "BIGINT" },
        { name: "distance_m", type: "DOUBLE" },
      ],
      boundDocument: { externalIdColumns: ["id"] },
    },
    {
      tableName: "strava_athlete",
      displayName: "Strava Athlete",
      sourceId: "strava:athlete1",
      primaryKey: ["id"],
      columns: [{ name: "id", type: "BIGINT" }],
      // No boundDocument — this table is excluded.
    },
  ];

  it("keys bindings by bare source type and skips tables without a boundDocument", () => {
    const reg = buildBoundDocumentRegistry(rows);
    expect([...reg.keys()]).toEqual(["strava"]);
    const stravaBindings = reg.get("strava")!;
    expect(stravaBindings).toHaveLength(1);
    expect(stravaBindings[0].tableName).toBe("strava_activities");
    expect(stravaBindings[0].columns).toEqual(["id", "distance_m"]);
    expect(stravaBindings[0].columnTypes).toEqual({ id: "BIGINT", distance_m: "DOUBLE" });
  });

  it("matches a document's <type>:<account> source-id against the bare-type key", () => {
    const reg = buildBoundDocumentRegistry(rows);
    // A shared table whose catalog source_id collapsed to the bare type still keys under it.
    const shared = buildBoundDocumentRegistry([{ ...rows[0], sourceId: "strava", tableName: "t" }]);
    expect(shared.has("strava")).toBe(true);
    expect(reg.has("strava")).toBe(true);
  });
});
