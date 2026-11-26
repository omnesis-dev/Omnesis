// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

export const OMATEL_CALL_LOG_TABLE = "omatel_call_log";
export const OMATEL_MESSAGES_TABLE = "omatel_messages";

/**
 * One row per call in omatel's call log. A `call-log` document aggregates a
 * whole UTC day, so the `date` column is the cross-reference back to it
 * (`call-log:${date}`), not a per-call edge.
 */
export const omatelCallLogSchema: AnalyticsTableSchema = {
  tableName: OMATEL_CALL_LOG_TABLE,
  displayName: "Phone calls (omatel)",
  description:
    "Calls placed and received with the phone's own Phone app (omatel) — outcomes, durations and peers.",
  columns: [
    { name: "id", type: "VARCHAR", description: "omatel's call id" },
    {
      name: "date",
      type: "DATE",
      description: "UTC calendar date the call started — joins the call-log day document",
    },
    { name: "time", type: "TIMESTAMPTZ", description: "Call start instant (UTC)" },
    {
      name: "direction",
      type: "VARCHAR",
      description: "incoming | outgoing",
      allowedValues: ["incoming", "outgoing"],
    },
    {
      name: "outcome",
      type: "VARCHAR",
      description: "answered | missed | rejected | blocked | unanswered | failed",
      canonicalValues: ["answered", "missed", "rejected", "blocked", "unanswered", "failed"],
    },
    {
      name: "duration_seconds",
      type: "DOUBLE",
      description: "Seconds talked (0 for a call that never connected)",
    },
    { name: "connected", type: "BOOLEAN", description: "Whether the call was answered" },
    {
      name: "counterparty",
      type: "VARCHAR",
      description: "Peer phone number (E.164 when it parses, else as the network gave it)",
      references: "person",
    },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: "time",
  record: {
    titleColumns: ["counterparty"],
    keyColumns: ["time", "counterparty", "direction"],
  },
  exampleQueries: [
    "SELECT counterparty, COUNT(*) AS calls, ROUND(SUM(duration_seconds) / 60, 1) AS minutes FROM omatel_call_log WHERE connected GROUP BY 1 ORDER BY calls DESC LIMIT 20",
    "SELECT date_trunc('week', time) AS week, COUNT(*) FILTER (WHERE outcome = 'missed') AS missed_calls FROM omatel_call_log GROUP BY week ORDER BY week DESC",
  ],
};

/**
 * One row per SMS or MMS, without its text: the text is in the
 * conversation-day documents, where search reads it.
 */
export const omatelMessagesSchema: AnalyticsTableSchema = {
  tableName: OMATEL_MESSAGES_TABLE,
  displayName: "Text messages (omatel)",
  description:
    "SMS and MMS sent and received with the phone's own Messages app (omatel) — who, when and delivery state, without the text.",
  columns: [
    { name: "id", type: "VARCHAR", description: "omatel's message id" },
    {
      name: "date",
      type: "DATE",
      description: "UTC calendar date of the message — joins the conversation-day document",
    },
    {
      name: "time",
      type: "TIMESTAMPTZ",
      description: "When it arrived (incoming) or was written (outgoing)",
    },
    {
      name: "conversation",
      type: "VARCHAR",
      description: "The conversation's address (its key in omatel)",
    },
    {
      name: "direction",
      type: "VARCHAR",
      description: "incoming | outgoing",
      allowedValues: ["incoming", "outgoing"],
    },
    {
      name: "transport",
      type: "VARCHAR",
      description: "sms | mms",
      canonicalValues: ["sms", "mms"],
    },
    {
      name: "state",
      type: "VARCHAR",
      description: "received | sending | sent | delivered | failed",
      canonicalValues: ["received", "sending", "sent", "delivered", "failed"],
    },
    {
      name: "counterparty",
      type: "VARCHAR",
      description:
        "The other party: the sender of an incoming message, the conversation for an outgoing one",
      references: "person",
    },
    { name: "characters", type: "INTEGER", description: "Length of the text in characters" },
    { name: "attachments", type: "INTEGER", description: "Number of MMS attachments" },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: "time",
  record: {
    titleColumns: ["counterparty"],
    keyColumns: ["time", "counterparty", "direction"],
  },
  exampleQueries: [
    "SELECT counterparty, COUNT(*) FILTER (WHERE direction = 'outgoing') AS sent, COUNT(*) FILTER (WHERE direction = 'incoming') AS received FROM omatel_messages GROUP BY 1 ORDER BY sent + received DESC LIMIT 20",
    "SELECT date_trunc('month', time) AS month, COUNT(*) AS messages FROM omatel_messages GROUP BY month ORDER BY month DESC",
  ],
};
