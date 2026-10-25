// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import type Sqlite from "better-sqlite3";

const sampleSchema = z
  .object({
    callId: z.string().uuid(),
    model: z.literal("gpt-live-1"),
    seconds: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    confirmed: z.boolean(),
    day: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((day) => {
        const parsed = new Date(`${day}T00:00:00Z`);
        return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
      }),
  })
  .strict();

/** Gateway-generated call UUID only; no provider/session/conversation identifiers or content. */
export type LiveVoiceUsageSample = z.infer<typeof sampleSchema>;

/** Additive table: older gateways may ignore it; no existing table or schema version changes. */
export function createLiveVoiceUsageTable(db: Sqlite.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS live_voice_usage (
    call_id TEXT PRIMARY KEY NOT NULL,
    model TEXT NOT NULL,
    seconds REAL NOT NULL CHECK (seconds >= 0),
    confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
    day TEXT NOT NULL
  )`);
}

/** Cumulative snapshots are high-water marks, never additive token-equivalent spend. */
export function recordLiveVoiceUsage(db: Sqlite.Database, input: LiveVoiceUsageSample): void {
  const sample = sampleSchema.parse(input);
  const result = db
    .prepare(
      `INSERT INTO live_voice_usage (call_id, model, seconds, confirmed, day)
    VALUES (@callId, @model, @seconds, @confirmed, @day)
    ON CONFLICT(call_id) DO UPDATE SET
      seconds = MAX(live_voice_usage.seconds, excluded.seconds),
      confirmed = MAX(live_voice_usage.confirmed, excluded.confirmed)
    WHERE live_voice_usage.model = excluded.model AND live_voice_usage.day = excluded.day
  `,
    )
    .run({ ...sample, confirmed: sample.confirmed ? 1 : 0 });
  if (!result.changes) throw new Error("Live voice usage identity mismatch");
}
