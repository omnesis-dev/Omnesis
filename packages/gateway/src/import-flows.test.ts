// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { DeviceId } from "@omnesis/types";
import { ImportFlowRegistry, type ImportFlowEvent } from "./import-flows.js";

const DEV = "11111111-1111-4111-8111-111111111111";
const SRC = "whatsapp-messages:+15550100001";

describe("ImportFlowRegistry", () => {
  test("start returns a flow with a UUID id and starting state", () => {
    const reg = new ImportFlowRegistry();
    const flow = reg.start({ sourceId: SRC, deviceId: DeviceId(DEV) });
    expect(flow.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(flow.state).toBe("starting");
    expect(flow.sourceId).toBe(SRC);
    expect(flow.deviceId).toBe(DEV);
  });

  test("isImporting is true only while a flow for that source is live", () => {
    const reg = new ImportFlowRegistry();
    const other = "whatsapp-messages:+15550100002";
    expect(reg.isImporting(SRC)).toBe(false);

    const f = reg.start({ sourceId: SRC, deviceId: DeviceId(DEV) });
    expect(reg.isImporting(SRC)).toBe(true);
    // One source's import says nothing about another's.
    expect(reg.isImporting(other)).toBe(false);

    reg.ingestEvent(f.id, { type: "progress", phase: "merge", processed: 1, total: 2 });
    expect(reg.isImporting(SRC)).toBe(true);

    reg.ingestEvent(f.id, { type: "complete", ok: true, imported: 1, merged: 0, skipped: 0 });
    expect(reg.isImporting(SRC), "a finished import still reported as in flight").toBe(false);
  });

  test("isImporting stops claiming a flow that outlived its TTL", async () => {
    // A collector that dies mid-import leaves its flow reading `running` until
    // the cleanup sweep removes it. A caller asking "is an import in flight?"
    // would otherwise be told yes for an hour about an import that ended when
    // the process did — and for the journal, that means every row from that
    // source classified as history and quietly ignored.
    const reg = new ImportFlowRegistry({ ttlMs: 5 });
    reg.start({ sourceId: SRC, deviceId: DeviceId(DEV) });
    expect(reg.isImporting(SRC)).toBe(true);

    await new Promise((r) => setTimeout(r, 10));
    expect(reg.isImporting(SRC), "an expired flow was still reported in flight").toBe(false);
  });

  test("ingestEvent transitions: progress → running, complete(ok) → completed with tally", () => {
    const reg = new ImportFlowRegistry();
    const f = reg.start({ sourceId: SRC, deviceId: DeviceId(DEV) });
    reg.ingestEvent(f.id, { type: "progress", phase: "merge", processed: 5, total: 10 });
    expect(reg.get(f.id)?.state).toBe("running");
    expect(reg.get(f.id)?.processed).toBe(5);
    reg.ingestEvent(f.id, { type: "complete", ok: true, imported: 7, merged: 3, skipped: 1 });
    const done = reg.get(f.id)!;
    expect(done.state).toBe("completed");
    expect(done).toMatchObject({ imported: 7, merged: 3, skipped: 1 });
  });

  test("complete(ok:false) → error with message", () => {
    const reg = new ImportFlowRegistry();
    const f = reg.start({ sourceId: SRC, deviceId: DeviceId(DEV) });
    reg.ingestEvent(f.id, { type: "complete", ok: false, error: "wrong password" });
    expect(reg.get(f.id)?.state).toBe("error");
    expect(reg.get(f.id)?.errorMessage).toBe("wrong password");
  });

  test("subscribe receives every ingested event; unsubscribe stops them", () => {
    const reg = new ImportFlowRegistry();
    const f = reg.start({ sourceId: SRC, deviceId: DeviceId(DEV) });
    const seen: ImportFlowEvent[] = [];
    const off = reg.subscribe(f.id, (e) => seen.push(e));
    reg.ingestEvent(f.id, { type: "progress", phase: "decrypt", processed: 0 });
    reg.ingestEvent(f.id, { type: "complete", ok: true, imported: 1, merged: 0, skipped: 0 });
    off();
    reg.ingestEvent(f.id, { type: "progress", phase: "after-unsub", processed: 9 });
    expect(seen.map((e) => e.type)).toEqual(["progress", "complete"]);
  });

  test("update mutates the record WITHOUT fanning out to subscribers", () => {
    const reg = new ImportFlowRegistry();
    const f = reg.start({ sourceId: SRC, deviceId: DeviceId(DEV) });
    const seen: ImportFlowEvent[] = [];
    reg.subscribe(f.id, (e) => seen.push(e));
    reg.update(f.id, { state: "error", errorMessage: "cancelled" });
    expect(reg.get(f.id)?.state).toBe("error");
    expect(reg.get(f.id)?.errorMessage).toBe("cancelled");
    expect(seen).toHaveLength(0); // no fan-out — collector remains the sole emitter
  });

  test("a subscriber that throws does not break sibling subscribers", () => {
    const reg = new ImportFlowRegistry();
    const f = reg.start({ sourceId: SRC, deviceId: DeviceId(DEV) });
    const seen: string[] = [];
    reg.subscribe(f.id, () => {
      throw new Error("boom");
    });
    reg.subscribe(f.id, (e) => seen.push(e.type));
    expect(() =>
      reg.ingestEvent(f.id, { type: "progress", phase: "x", processed: 0 }),
    ).not.toThrow();
    expect(seen).toEqual(["progress"]);
  });

  test("get returns null after TTL; cleanup expires aged flows and notifies subscribers", async () => {
    const reg = new ImportFlowRegistry({ ttlMs: 5 });
    const f = reg.start({ sourceId: SRC, deviceId: DeviceId(DEV) });
    const terminal: ImportFlowEvent[] = [];
    reg.subscribe(f.id, (e) => terminal.push(e));
    await new Promise((r) => setTimeout(r, 10));
    expect(reg.cleanup()).toBe(1);
    expect(reg.get(f.id)).toBeNull();
    expect(terminal).toEqual([{ type: "complete", ok: false, error: "expired" }]);
  });

  test("ingestEvent on an unknown/expired flow returns null without throwing", () => {
    const reg = new ImportFlowRegistry();
    expect(reg.ingestEvent("nope", { type: "progress", phase: "x", processed: 0 })).toBeNull();
  });
});
