// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

/** DuckDB table for Apple phone + FaceTime calls. Per-source (not shared with a
 * future WhatsApp-calls source) so it stays source-encapsulated. */
export const APPLE_CALL_LOG_TABLE = "apple_call_log";

/**
 * Structured twin of the call-log documents — but NOT a 1:1 `boundDocument`
 * like Calendar's: a `call-log` document aggregates a whole day's calls, while
 * this table has one row per raw call (keyed on `ZUNIQUE_ID`). The `date`
 * column is the natural cross-reference back to the day-document's
 * `externalId` (`call-log:${date}`) — there's no per-call bound edge.
 */
export const appleCallLogSchema: AnalyticsTableSchema = {
  tableName: APPLE_CALL_LOG_TABLE,
  displayName: "Apple Call Log",
  description: "Phone and FaceTime calls (macOS iCloud call-history sync) — durations and peers.",
  columns: [
    { name: "id", type: "VARCHAR", description: "Call unique ID (ZUNIQUE_ID)" },
    {
      name: "date",
      type: "DATE",
      description: "Calendar date (UTC) the call happened — joins the call-log day-document",
    },
    { name: "time", type: "TIMESTAMPTZ", description: "Call start instant (UTC)" },
    { name: "direction", type: "VARCHAR", description: "incoming | outgoing" },
    {
      name: "medium",
      type: "VARCHAR",
      description:
        "phone | facetime (FaceTime's audio/video split isn't reliably distinguishable from the verified schema fields — see call-log.ts's callMedium)",
    },
    {
      name: "duration_seconds",
      type: "DOUBLE",
      description: "Call duration in seconds (0 for missed/unanswered)",
    },
    {
      name: "connected",
      type: "BOOLEAN",
      description:
        "Whether the call actually connected — duration > 0 for outgoing calls (ZANSWERED is unreliable there), ZANSWERED for incoming",
    },
    {
      name: "counterparty",
      type: "VARCHAR",
      description: "Peer phone number (E.164) or Apple ID email",
      references: "person",
    },
    {
      name: "counterparty_name",
      type: "VARCHAR",
      description: "Cached counterparty display name, if known",
      nullable: true,
    },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: "time",
  record: {
    titleColumns: ["counterparty_name", "counterparty"],
    keyColumns: ["time", "counterparty", "direction"],
  },
  exampleQueries: [
    "SELECT counterparty_name, counterparty, COUNT(*) AS calls, ROUND(SUM(duration_seconds) / 60, 1) AS minutes FROM apple_call_log WHERE connected GROUP BY 1, 2 ORDER BY calls DESC LIMIT 20",
    "SELECT date_trunc('week', time) AS week, COUNT(*) FILTER (WHERE NOT connected AND direction = 'incoming') AS missed_calls FROM apple_call_log GROUP BY week ORDER BY week DESC",
  ],
};
