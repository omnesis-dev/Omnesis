// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { createCiteRecordTool } from "./cite-record.js";
import { RecordPortError, type RecordCitationResolved, type RecordPort } from "./types.js";

const CTX = { sessionId: "S", messageId: "M" } as const;

const REFERENCE = {
  table: "demo_transactions",
  recordKey: "row:demo_transactions:txn-001",
  primaryKeyColumns: [{ name: "id", value: "txn-001", castType: "VARCHAR" }],
};

const SNAPSHOT = { id: "txn-001", merchant: "Stellar Sound", amount: "42.00" };

const RESOLVED: RecordCitationResolved = {
  table: "demo_transactions",
  recordKey: "row:demo_transactions:txn-001",
  primaryKeyColumns: [{ name: "id", value: "txn-001", castType: "VARCHAR" }],
  title: "Stellar Sound",
  keyFields: [
    { label: "Merchant", value: "Stellar Sound" },
    { label: "Amount", value: "42.00" },
  ],
  semanticTime: "2026-05-23T10:00:00.000Z",
  snapshot: SNAPSHOT,
  sourceId: "demo:acct1",
  sourceType: "demo",
  tableDisplayName: "Demo Transactions",
  boundDocumentId: null,
};

function port(impl: RecordPort["resolve"]): RecordPort {
  return { resolve: impl };
}

describe("createCiteRecordTool", () => {
  it("records a record citation from a resolved row", async () => {
    const tool = createCiteRecordTool({ port: port(async () => RESOLVED) });
    const r = await tool.invoke({ reference: REFERENCE, snapshot: SNAPSHOT }, CTX);
    expect(r.kind).toBe("cite_record.recorded");
    if (r.kind === "cite_record.recorded") {
      expect(r.table).toBe("demo_transactions");
      expect(r.recordKey).toBe("row:demo_transactions:txn-001");
      expect(r.semanticTime).toBe("2026-05-23T10:00:00.000Z");
      expect(r.snapshot).toEqual(SNAPSHOT);
      expect(r.title).toBe("Stellar Sound");
      expect(r.keyFields).toHaveLength(2);
      expect(r.boundDocumentId).toBeNull();
      expect(r.sourceType).toBe("demo");
    }
  });

  it("carries a bound document id through when the port resolves one", async () => {
    const tool = createCiteRecordTool({
      port: port(async () => ({ ...RESOLVED, boundDocumentId: "doc-99" })),
    });
    const r = await tool.invoke({ reference: REFERENCE, snapshot: SNAPSHOT }, CTX);
    expect(r.kind).toBe("cite_record.recorded");
    if (r.kind === "cite_record.recorded") expect(r.boundDocumentId).toBe("doc-99");
  });

  it("maps an unknown-table rejection to a clean error", async () => {
    const tool = createCiteRecordTool({
      port: port(async () => {
        throw new RecordPortError({ reason: "unknown_table", table: "ghost" });
      }),
    });
    const r = await tool.invoke({ reference: REFERENCE, snapshot: SNAPSHOT }, CTX);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("record_unknown_table");
  });

  it("maps a timeless-table rejection to record_not_timeline_eligible", async () => {
    const tool = createCiteRecordTool({
      port: port(async () => {
        throw new RecordPortError({ reason: "not_timeline_eligible", table: "demo_profiles" });
      }),
    });
    const r = await tool.invoke({ reference: REFERENCE, snapshot: SNAPSHOT }, CTX);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("record_not_timeline_eligible");
  });

  it("rejects a reference with an empty table", async () => {
    const tool = createCiteRecordTool({ port: port(async () => RESOLVED) });
    const r = await tool.invoke(
      { reference: { ...REFERENCE, table: "" }, snapshot: SNAPSHOT },
      CTX,
    );
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("invalid_args");
  });

  it("rejects a reference with no primary-key columns", async () => {
    const tool = createCiteRecordTool({ port: port(async () => RESOLVED) });
    const r = await tool.invoke(
      { reference: { ...REFERENCE, primaryKeyColumns: [] }, snapshot: SNAPSHOT },
      CTX,
    );
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("invalid_args");
  });

  it("surfaces an unexpected port failure as cite_record_failed", async () => {
    const tool = createCiteRecordTool({
      port: port(async () => {
        throw new Error("transient db error");
      }),
    });
    const r = await tool.invoke({ reference: REFERENCE, snapshot: SNAPSHOT }, CTX);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("cite_record_failed");
  });

  it("summarize produces a table + key excerpt", () => {
    const tool = createCiteRecordTool({ port: port(async () => RESOLVED) });
    const s = tool.summarize?.({ reference: REFERENCE, snapshot: SNAPSHOT });
    expect(s).toContain("demo_transactions");
  });
});
