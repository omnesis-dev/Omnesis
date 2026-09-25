// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Cross-surface tool-result contract test (epic #804, criterion C19).
 *
 * The agent emits typed tool results on the wire; three surfaces decode them —
 * the gateway/portal reducer (TS), the iOS app (Swift), and the Android app
 * (Kotlin). A recurring "green-but-broken" bug class is a field the server
 * dutifully projects onto the wire that a client decoder silently drops, so the
 * surface renders nothing and no test reddens. This test pins that contract from
 * the TS side:
 *
 *   1. ONE canonical, invented fixture (`__fixtures__/tool-result-contract.json`)
 *      carries a representative payload per tool-result kind — emphasising the
 *      fields that have been dead-wired on clients before: a DocRef's `refCount`
 *      + `breadcrumb`, a record citation's `primaryKeyColumns` + `snapshot`
 *      (#757), and a `run_sql` result's `rowIdentities` (#757).
 *   2. Each fixture `wire` payload is re-derived through the REAL server projector
 *      — the tool's `invoke()` driven by a stub port that yields the corresponding
 *      internal result — and asserted to round-trip every advertised field with no
 *      drop (deep-equal to the fixture, plus a `toolResultSchema` parse).
 *   3. The Swift and Kotlin mirror copies are asserted byte-identical to the
 *      canonical fixture, so the three surfaces can never load divergent copies.
 *
 * The Swift/Kotlin halves of this contract live in
 * `ios/Tests/OmnesisTests/ToolResultContractDecodeTests.swift` and
 * `android/core-transport/src/test/kotlin/.../AgentToolResultContractDecodeTest.kt`;
 * they load the SAME fixture (mirror copies) and assert each surface decodes every
 * field it models. They run on the macOS lane (the native toolchains aren't on the
 * Linux box) via `scripts/ios-snapshot.sh` / `scripts/android-render.sh`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { toolResultSchema, type DocRef, type EventTrail, type ToolResult } from "@omnesis/core";
import { describe, expect, it } from "vitest";

import { createAnnotateTool } from "./tools/annotate.js";
import { createCiteRecordTool } from "./tools/cite-record.js";
import { createTraceConnectionsTool } from "./tools/trace-connections.js";
import { createFetchDocumentTool } from "./tools/fetch-document.js";
import { createLookupPeopleTool } from "./tools/lookup-people.js";
import { createRunSqlTool } from "./tools/run-sql.js";
import { createSearchDocumentsTool } from "./tools/search.js";
import type {
  PersonPortResult,
  RecordCitationResolved,
  SearchPortResult,
  SqlPortResult,
  ToolContext,
} from "./tools/types.js";

const CTX: ToolContext = { sessionId: "S", messageId: "M" };

const FIXTURE_REL = "./__fixtures__/tool-result-contract.json";
const FIXTURE_PATH = fileURLToPath(new URL(FIXTURE_REL, import.meta.url));

// Mirror copies the native decode tests load — kept byte-identical by this test
// so there is exactly one logical fixture, never three drifting ones. Paths are
// relative to THIS file (packages/agent/src/) → repo root → the per-surface tree.
const IOS_MIRROR = fileURLToPath(
  new URL("../../../ios/Tests/OmnesisTests/Fixtures/tool-result-contract.json", import.meta.url),
);
const ANDROID_MIRROR = fileURLToPath(
  new URL(
    "../../../android/core-transport/src/test/resources/tool-result-contract.json",
    import.meta.url,
  ),
);

interface FixtureCase {
  kind: string;
  wire: ToolResult;
}
interface Fixture {
  cases: FixtureCase[];
}

const canonicalRaw = readFileSync(FIXTURE_PATH, "utf8");
const fixture = JSON.parse(canonicalRaw) as Fixture;

function caseFor(kind: string): FixtureCase {
  const found = fixture.cases.find((c) => c.kind === kind);
  if (!found) throw new Error(`fixture has no case for kind '${kind}'`);
  return found;
}

/**
 * Re-derive the internal port result from a fixture `wire` payload and run the
 * real tool projector. Returns the projected ToolResult so the caller can assert
 * it round-trips every advertised field. The point of going through the projector
 * (not re-parsing the wire) is to catch a projector that drops a field on the way
 * out — the gateway-side half of the dead-wire bug class.
 */
const projectors: Record<string, (wire: ToolResult) => Promise<ToolResult>> = {
  "search.results": async (wire) => {
    if (wire.kind !== "search.results") throw new Error("kind");
    const portResult: SearchPortResult = {
      query: wire.query,
      durationMs: wire.durationMs,
      totalCandidates: wire.candidates,
      // The breadcrumb + refCount the gateway search port stapled onto the
      // DocRefs are part of the port result the projector forwards verbatim.
      results: wire.results as DocRef[],
    };
    const tool = createSearchDocumentsTool({ port: { search: async () => portResult } });
    return tool.invoke({ query: wire.query }, CTX);
  },
  document: async (wire) => {
    if (wire.kind !== "document") throw new Error("kind");
    const tool = createFetchDocumentTool({
      port: {
        fetch: async () => ({
          ref: wire.ref,
          document: wire.document,
          neighbors: wire.neighbors,
          neighborsTruncated: wire.neighborsTruncated,
        }),
      },
    });
    return tool.invoke({ documentId: wire.ref.documentId, includeNeighbors: true }, CTX);
  },
  "person.results": async (wire) => {
    if (wire.kind !== "person.results") throw new Error("kind");
    const portResult: PersonPortResult = {
      query: wire.query,
      durationMs: wire.durationMs,
      results: wire.results,
    };
    const tool = createLookupPeopleTool({ port: { lookup: async () => portResult } });
    return tool.invoke({ query: wire.query }, CTX);
  },
  "annotate.recorded": async (wire) => {
    if (wire.kind !== "annotate.recorded") throw new Error("kind");
    // The annotate projector fetches the doc to fill the ref, then resolves the
    // agent's "You" convention to `quoteIsSelf` itself — so the stub only needs
    // to return the ref; the self-quote orientation is the projector's job.
    const tool = createAnnotateTool({
      port: {
        fetch: async () => ({ ref: wire.ref, document: {} }),
      },
    });
    return tool.invoke(
      {
        documentId: wire.documentId,
        quote: wire.quote,
        quoteAuthor: wire.quoteAuthor,
        note: wire.note,
      },
      CTX,
    );
  },
  "cite_record.recorded": async (wire) => {
    if (wire.kind !== "cite_record.recorded") throw new Error("kind");
    const resolved: RecordCitationResolved = {
      table: wire.table,
      recordKey: wire.recordKey,
      primaryKeyColumns: wire.primaryKeyColumns,
      title: wire.title,
      keyFields: wire.keyFields,
      semanticTime: wire.semanticTime,
      snapshot: wire.snapshot,
      sourceId: wire.sourceId,
      sourceType: wire.sourceType,
      tableDisplayName: wire.tableDisplayName,
      boundDocumentId: wire.boundDocumentId,
    };
    const tool = createCiteRecordTool({ port: { resolve: async () => resolved } });
    return tool.invoke(
      {
        reference: {
          table: wire.table,
          recordKey: wire.recordKey,
          primaryKeyColumns: wire.primaryKeyColumns,
        },
        snapshot: wire.snapshot,
      },
      CTX,
    );
  },
  "event_trail.built": async (wire) => {
    if (wire.kind !== "event_trail.built") throw new Error("kind");
    const trail: EventTrail = {
      seeds: wire.seeds,
      events: wire.events,
      truncated: wire.truncated,
      stats: wire.stats,
    };
    const tool = createTraceConnectionsTool({ port: { build: async () => trail } });
    return tool.invoke({ seedIds: wire.seeds }, CTX);
  },
  "sql.rows": async (wire) => {
    if (wire.kind !== "sql.rows") throw new Error("kind");
    const portResult: SqlPortResult = {
      sql: wire.sql,
      columns: wire.columns,
      rows: wire.rows,
      rowCount: wire.rowCount,
      truncated: wire.truncated,
      durationMs: wire.durationMs,
      rowIdentities: wire.rowIdentities,
      sources: wire.sources,
      subjects: wire.subjects,
    };
    const tool = createRunSqlTool({ port: { run: async () => portResult } });
    return tool.invoke({ sql: wire.sql }, CTX);
  },
};

describe("cross-surface tool-result contract (C19)", () => {
  it("the fixture is a non-empty set of valid tool-result payloads", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(7);
    for (const c of fixture.cases) {
      // Each fixture payload must itself be a valid wire ToolResult.
      expect(() => toolResultSchema.parse(c.wire)).not.toThrow();
      expect(c.wire.kind).toBe(c.kind);
    }
  });

  it("the iOS + Android mirror copies are byte-identical to the canonical fixture", () => {
    // ONE shared fixture, not three divergent copies: the native decode tests
    // load these mirrors on the macOS lane, so a drift here would let the
    // surfaces test against different data. Byte-identical is the guard.
    expect(readFileSync(IOS_MIRROR, "utf8")).toBe(canonicalRaw);
    expect(readFileSync(ANDROID_MIRROR, "utf8")).toBe(canonicalRaw);
  });

  for (const c of fixture.cases) {
    it(`'${c.kind}' round-trips every advertised field through the real server projector`, async () => {
      const project = projectors[c.kind];
      if (!project) throw new Error(`no projector wired for fixture kind '${c.kind}'`);
      const projected = await project(c.wire);
      // The projector must reproduce the fixture wire payload field-for-field —
      // a dropped field (e.g. refCount, breadcrumb, primaryKeyColumns, snapshot,
      // rowIdentities) makes this deep-equal fail loudly.
      expect(projected).toEqual(c.wire);
      // And the projected payload must still validate at the wire boundary.
      expect(() => toolResultSchema.parse(projected)).not.toThrow();
    });
  }

  it("specifically pins the dead-wire-prone fields on the search DocRef", () => {
    const wire = caseFor("search.results").wire;
    if (wire.kind !== "search.results") throw new Error("kind");
    const top = wire.results[0]!;
    // Adjacency hints — historically dropped by client decoders.
    expect(top.refCount).toBeGreaterThan(0);
    expect(top.breadcrumb && top.breadcrumb.length).toBeGreaterThan(0);
  });

  it("specifically pins the dead-wire-prone fields on cite_record + sql.rows", () => {
    const cite = caseFor("cite_record.recorded").wire;
    if (cite.kind !== "cite_record.recorded") throw new Error("kind");
    // #757 fields a renderer ignores but the wire must still carry intact.
    expect(cite.primaryKeyColumns.length).toBeGreaterThan(0);
    expect(Object.keys(cite.snapshot).length).toBeGreaterThan(0);

    const sql = caseFor("sql.rows").wire;
    if (sql.kind !== "sql.rows") throw new Error("kind");
    expect(sql.rowIdentities && sql.rowIdentities.length).toBe(sql.rows.length);
  });
});
