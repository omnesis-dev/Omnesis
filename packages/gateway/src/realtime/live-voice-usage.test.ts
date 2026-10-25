// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Sqlite from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { directWriteGate, writeGateFromCall, type WriterCallFn } from "../write-gate.js";
import { runSchemaSetup } from "../data/schema.js";
import { writerHandlers } from "../scheduler/writer-handlers.js";
import {
  createLiveVoiceUsageTable,
  recordLiveVoiceUsage,
  type LiveVoiceUsageSample,
} from "./live-voice-usage.js";

const sample: LiveVoiceUsageSample = {
  callId: "00000000-0000-4000-8000-000000000001",
  model: "gpt-live-1",
  seconds: 12.5,
  confirmed: false,
  day: "2026-01-01",
};
function withDb(run: (db: Sqlite.Database) => void) {
  const db = new Sqlite(":memory:");
  try {
    createLiveVoiceUsageTable(db);
    run(db);
  } finally {
    db.close();
  }
}
describe("Live duration usage", () => {
  it("installs through normal schema setup and direct writer path", async () => {
    const db = new Sqlite(":memory:");
    try {
      runSchemaSetup(db);
      await directWriteGate(db).recordLiveVoiceUsage(sample);
      expect(db.prepare("SELECT seconds FROM live_voice_usage").get()).toEqual({ seconds: 12.5 });
    } finally {
      db.close();
    }
  });
  it("upserts cumulative maximum once per call and retains final confirmation", () =>
    withDb((db) => {
      createLiveVoiceUsageTable(db);
      recordLiveVoiceUsage(db, sample);
      recordLiveVoiceUsage(db, sample);
      recordLiveVoiceUsage(db, { ...sample, seconds: 10 });
      recordLiveVoiceUsage(db, { ...sample, seconds: 15.25, confirmed: true });
      recordLiveVoiceUsage(db, { ...sample, seconds: 14, confirmed: false });
      expect(db.prepare("SELECT * FROM live_voice_usage").all()).toEqual([
        {
          call_id: sample.callId,
          model: sample.model,
          seconds: 15.25,
          confirmed: 1,
          day: sample.day,
        },
      ]);
    }));
  it("keeps lost-terminal usage explicit and separate calls independent", () =>
    withDb((db) => {
      recordLiveVoiceUsage(db, sample);
      recordLiveVoiceUsage(db, {
        ...sample,
        callId: "00000000-0000-4000-8000-000000000002",
        seconds: 1,
      });
      expect(
        db
          .prepare(
            "SELECT SUM(seconds) AS seconds, SUM(confirmed) AS confirmed FROM live_voice_usage",
          )
          .get(),
      ).toEqual({ seconds: 13.5, confirmed: 0 });
    }));
  it("rejects mismatched day without reassigning or double counting a call", () =>
    withDb((db) => {
      recordLiveVoiceUsage(db, sample);
      expect(() => recordLiveVoiceUsage(db, { ...sample, day: "2026-01-02", seconds: 50 })).toThrow(
        "identity mismatch",
      );
      expect(db.prepare("SELECT seconds FROM live_voice_usage").get()).toEqual({ seconds: 12.5 });
    }));
  it.each([
    { seconds: -1 },
    { seconds: NaN },
    { seconds: Infinity },
    { day: "2026-02-30" },
    { callId: "live_provider_identifier" },
    { model: "arbitrary-model" },
    { content: "PRIVATE_SENTINEL" },
  ])("rejects invalid or content-bearing samples", (update) =>
    withDb((db) => {
      expect(() =>
        recordLiveVoiceUsage(db, { ...sample, ...update } as LiveVoiceUsageSample),
      ).toThrow();
      expect(db.prepare("SELECT COUNT(*) AS count FROM live_voice_usage").get()).toEqual({
        count: 0,
      });
    }),
  );
  it("routes the same typed operation through the writer gate", async () => {
    const call = vi.fn(() => Promise.resolve());
    await writeGateFromCall(call as WriterCallFn).recordLiveVoiceUsage(sample);
    expect(call).toHaveBeenCalledWith("live.recordVoiceUsage", [sample]);
    withDb((db) => {
      writerHandlers["live.recordVoiceUsage"](db, sample);
      expect(db.prepare("SELECT seconds FROM live_voice_usage").get()).toEqual({ seconds: 12.5 });
    });
  });
});
