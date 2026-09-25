// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { loadCallLog, mapCallLog } from "./fixtures.js";

const ctx = {
  sourceId: SourceId("android-call-log:android-synth-johnsmith"),
  providerId: ProviderId("android"),
};

describe("android-call-log fixtures", () => {
  it("produces at least one day entry", () => {
    expect(loadCallLog().length).toBeGreaterThan(0);
  });

  it("maps each day entry to a call-log document with a self participant", () => {
    for (const entry of loadCallLog()) {
      const doc = mapCallLog(entry, ctx);
      expect(doc.externalId).toBe(entry.externalId);
      expect(doc.metadata.documentType).toBe("call-log");
      expect(doc.metadata.rollingAggregate).toBe(true);
      expect(doc.metadata.people?.some((p) => p.role === "participant")).toBe(true);
      expect(doc.content).toContain(`# Calls — ${entry.date}`);
    }
  });

  it("contentHash is deterministic across repeated mapping (idempotent re-sync)", () => {
    for (const entry of loadCallLog()) {
      const first = mapCallLog(entry, ctx).contentHash;
      const second = mapCallLog(entry, ctx).contentHash;
      expect(second).toBe(first);
    }
  });

  it("extra.calls carries one entry per raw call, matching callCount", () => {
    for (const entry of loadCallLog()) {
      const doc = mapCallLog(entry, ctx);
      const extra = doc.metadata.extra as { callCount: number; calls: unknown[] };
      expect(extra.calls.length).toBe(entry.calls.length);
      expect(extra.callCount).toBe(entry.calls.length);
    }
  });
});
