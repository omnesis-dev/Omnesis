// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Builds the marathon-prep demo fixture — the showcase that the agent
 * can reach into BOTH unstructured documents (Drive PDF, Gmail, WhatsApp)
 * AND structured analytics tables (Strava activities, Apple Health
 * vitals) inside one coherent answer.
 *
 * Scenario (today = Sun 14 Sep 2025): user finished their peak week
 * with Saturday's 25 km long run and asks whether they're actually on
 * track for the marathon. The agent's three-step plan, written without
 * foreknowledge so the demo feels like genuine discovery:
 *
 *   1. Find any training plan on file. (Surfaces a Drive PDF + an
 *      email from the user's coach Carol; the agent picks up Carol's
 *      name from the email signature.)
 *   2. Query Strava for the week's actual runs + Apple Health for the
 *      4-week resting-HR trend.
 *   3. Now that the coach is known, search for her recent notes and
 *      cite her weekly verdict.
 *
 * The mix is deliberate: the answer only lands once the planned target,
 * the measured execution, and the coach's qualitative read are
 * integrated.
 *
 * Run after edits:
 *   node evals/fixtures/agent/build-demo-marathon-prep.mjs
 *
 * Routing triggers and placeholder declarations live in the sibling
 * `demos/marathon-prep.meta.json` file.
 */

import { writeFileSync } from "node:fs";

const $S = "$SESSION";
const $M = "$MSG";

const DOC = {
  planPdf: "$DOC_synth-gdrive-006",
  planEmail: "$DOC_synth-gmail-002",
  carolLongRunWA: "$DOC_synth-whatsapp-003",
  carolPostRunWA: "$DOC_synth-whatsapp-008",
};

const STRAVA_SOURCES = [
  {
    sourceId: "strava-activities:7000000",
    sourceType: "strava-activities",
    displayName: "Strava Activities",
  },
];
const STRAVA_SUBJECTS = ["Strava Activities"];

const HEALTH_SOURCES = [
  {
    sourceId: "apple-health:ios-synth-johnsmith",
    sourceType: "apple-health",
    displayName: "Apple Health",
  },
];
const HEALTH_SUBJECTS = ["Vitals"];

const STRAVA_SQL = [
  "SELECT date_trunc('day', start_time) AS day,",
  "       name,",
  "       ROUND(distance_m / 1000, 1) AS km,",
  "       average_heartrate_bpm AS avg_hr",
  "FROM strava_activities",
  "WHERE sport_type = 'Run'",
  "  AND start_time >= TIMESTAMP '2025-09-07'",
  "  AND start_time < TIMESTAMP '2025-09-15'",
  "ORDER BY start_time",
].join("\n");

const HEALTH_SQL = [
  "SELECT date_trunc('week', start_time) AS week,",
  "       ROUND(AVG(value), 0) AS resting_hr_bpm",
  "FROM health_vitals",
  "WHERE metric_slug = 'resting_hr'",
  "  AND start_time >= TIMESTAMP '2025-08-17'",
  "GROUP BY 1",
  "ORDER BY 1",
].join("\n");

// Multiplier on every inter-event gap. Bumping above 1 lets the demo
// breathe — viewers in a live walk-through have more time to read each
// step before the next one lands.
const PACE = 1.5;

function evt(afterMs, type, payload) {
  return JSON.stringify({ afterMs: Math.round(afterMs * PACE), event: { type, payload } });
}

const events = [
  evt(400, "agent.message.start", { sessionId: $S, messageId: $M, role: "assistant" }),
  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "Let me work through this — I'll find your training plan, look at how the week actually went, then check for any coaching feedback.",
  }),

  // ── Plan: three items ────────────────────────────────────────────────
  evt(300, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_setup",
    tool: "plan",
    args: {
      add: [
        "Find your training plan",
        "Check the week's actual training data",
        "Look for coaching feedback",
      ],
    },
    intent: "Lay out the three steps",
  }),
  evt(120, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_setup",
    durationMs: 3,
    result: {
      kind: "plan.updated",
      items: [
        { id: "p1", label: "Find your training plan", status: "in_progress" },
        { id: "p2", label: "Check the week's actual training data", status: "pending" },
        { id: "p3", label: "Look for coaching feedback", status: "pending" },
      ],
    },
  }),

  // ── Step 1: find + read the marathon plan ────────────────────────────
  evt(700, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_plan",
    tool: "search_documents",
    args: { query: "marathon training plan", limit: 5 },
    intent: "Find anything that looks like a training plan",
  }),
  evt(1400, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_plan",
    durationMs: 264,
    result: {
      kind: "search.results",
      query: "marathon training plan",
      durationMs: 264,
      candidates: 3,
      results: [
        {
          documentId: DOC.planPdf,
          sourceType: "google-drive",
          sourceId: "google-drive:self",
          documentType: "file",
          title: "Marathon plan — week 6.pdf",
          snippet: "Week 6 marathon plan: mileage target 75 km, long run 25 km, intervals 6×800m.",
          ts: 1756710000000,
        },
        {
          documentId: DOC.planEmail,
          sourceType: "gmail",
          sourceId: "gmail:self",
          documentType: "email",
          title: "Marathon training plan — week 6",
          snippet:
            "Hey John, Week 6 plan attached. Big mileage week — focus on recovery between hard days. Carol",
          ts: 1756711200000,
        },
      ],
    },
  }),
  evt(700, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_plan",
    tool: "fetch_document",
    args: { documentId: DOC.planPdf },
    intent: "Read the plan in full",
  }),
  evt(1100, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_plan",
    durationMs: 258,
    result: {
      kind: "document",
      ref: {
        documentId: DOC.planPdf,
        sourceType: "google-drive",
        sourceId: "google-drive:self",
        documentType: "file",
        title: "Marathon plan — week 6.pdf",
        ts: 1756710000000,
      },
      document: {
        id: DOC.planPdf,
        title: "Marathon plan — week 6.pdf",
        content: "Week 6 marathon plan: mileage target 75 km, long run 25 km, intervals 6×800m.",
      },
    },
  }),
  evt(400, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_plan",
    tool: "annotate",
    args: {
      documentId: DOC.planPdf,
      quote: "Week 6 marathon plan: mileage target 75 km, long run 25 km, intervals 6×800m.",
    },
    intent: "Annotate the targets",
  }),
  evt(200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_plan",
    durationMs: 6,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.planPdf,
      ref: {
        documentId: DOC.planPdf,
        sourceType: "google-drive",
        sourceId: "google-drive:self",
        documentType: "file",
        title: "Marathon plan — week 6.pdf",
        ts: 1756710000000,
      },
      quote: "Week 6 marathon plan: mileage target 75 km, long run 25 km, intervals 6×800m.",
    },
  }),
  evt(300, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p1",
    tool: "plan",
    args: { complete: ["p1"] },
    intent: "Mark the plan-lookup step done",
  }),
  evt(120, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p1",
    durationMs: 2,
    result: {
      kind: "plan.updated",
      items: [
        { id: "p1", label: "Find your training plan", status: "done" },
        { id: "p2", label: "Check the week's actual training data", status: "in_progress" },
        { id: "p3", label: "Look for coaching feedback", status: "pending" },
      ],
    },
  }),

  // ── Step 2a: structured — Strava week 6 runs ─────────────────────────
  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\nPlan from your coach Carol — target **75 km / long run 25 km / 6×800m intervals**. Now what you actually ran this week.",
  }),
  evt(900, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_sql_strava",
    tool: "run_sql",
    args: { sql: STRAVA_SQL },
    intent: "Every run in the past week — distance + HR per day",
  }),
  evt(1400, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_sql_strava",
    durationMs: 192,
    result: {
      kind: "sql.rows",
      sql: STRAVA_SQL,
      columns: ["day", "name", "km", "avg_hr"],
      rows: [
        ["2025-09-07", "Intervals: 6×800m", 11.2, 168],
        ["2025-09-08", "Long run with Carol", 22.4, 148],
        ["2025-09-09", "Recovery jog", 5.1, 128],
        ["2025-09-10", "Tempo 5k", 9.2, 162],
        ["2025-09-11", "Mid-week easy", 7.8, 140],
        ["2025-09-12", "Hill repeats", 9.8, 165],
        ["2025-09-13", "Long run", 25.2, 150],
        ["2025-09-14", "Recovery jog", 4.9, 130],
      ],
      rowCount: 8,
      durationMs: 192,
      sources: STRAVA_SOURCES,
      subjects: STRAVA_SUBJECTS,
    },
  }),

  // ── Step 2b: structured — Apple Health resting HR trend ──────────────
  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\nVolume looks heavier than plan, but the 25k landed on target. Now the recovery markers — resting HR trend.",
  }),
  evt(900, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_sql_health",
    tool: "run_sql",
    args: { sql: HEALTH_SQL },
    intent: "Resting heart rate, averaged by week, last 4 weeks",
  }),
  evt(1300, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_sql_health",
    durationMs: 168,
    result: {
      kind: "sql.rows",
      sql: HEALTH_SQL,
      columns: ["week", "resting_hr_bpm"],
      rows: [
        ["2025-08-18", 58],
        ["2025-08-25", 56],
        ["2025-09-01", 55],
        ["2025-09-08", 54],
      ],
      rowCount: 4,
      durationMs: 168,
      sources: HEALTH_SOURCES,
      subjects: HEALTH_SUBJECTS,
    },
  }),
  evt(300, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p2",
    tool: "plan",
    args: { complete: ["p2"] },
    intent: "Mark the data-check step done",
  }),
  evt(120, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p2",
    durationMs: 2,
    result: {
      kind: "plan.updated",
      items: [
        { id: "p1", label: "Find your training plan", status: "done" },
        { id: "p2", label: "Check the week's actual training data", status: "done" },
        { id: "p3", label: "Look for coaching feedback", status: "in_progress" },
      ],
    },
  }),

  // ── Step 3: qualitative — Carol's weekly read ────────────────────────
  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\nResting HR has drifted **down 4 bpm over four weeks** — that's the textbook aerobic adaptation. Last piece — anything from Carol on this week?",
  }),
  evt(800, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_carol",
    tool: "search_documents",
    args: { query: 'from:"Carol Nakamura"', limit: 5 },
    intent: "Carol's recent coaching notes",
  }),
  evt(1200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_carol",
    durationMs: 198,
    result: {
      kind: "search.results",
      query: 'from:"Carol Nakamura"',
      durationMs: 198,
      candidates: 3,
      results: [
        {
          documentId: DOC.carolPostRunWA,
          sourceType: "whatsapp-messages",
          sourceId: "whatsapp-messages:self",
          documentType: "conversation",
          title: "Carol Nakamura — 2025-09-13",
          snippet:
            'Carol: "Now eat. Recovery starts at the table." · "Solid week — peak mileage in the bag, 25k right on target. Pacing right on for plan."',
          ts: 1757754600000,
        },
        {
          documentId: DOC.carolLongRunWA,
          sourceType: "whatsapp-messages",
          sourceId: "whatsapp-messages:self",
          documentType: "conversation",
          title: "Carol Nakamura — 2025-09-08",
          snippet: 'Carol: "Good run. Sticking with you for the next long one."',
          ts: 1757318400000,
        },
      ],
    },
  }),
  evt(700, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_summary",
    tool: "fetch_document",
    args: { documentId: DOC.carolPostRunWA },
    intent: "Read the post-run thread",
  }),
  evt(1100, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_summary",
    durationMs: 226,
    result: {
      kind: "document",
      ref: {
        documentId: DOC.carolPostRunWA,
        sourceType: "whatsapp-messages",
        sourceId: "whatsapp-messages:self",
        documentType: "conversation",
        title: "Carol Nakamura — 2025-09-13",
        ts: 1757754600000,
      },
      document: {
        id: DOC.carolPostRunWA,
        title: "Carol Nakamura — 2025-09-13",
        content:
          'You (08:30): "25k done. Legs gone but happy."\nCarol (09:00): "Now eat. Recovery starts at the table."\nCarol (09:02): "Solid week — peak mileage in the bag, 25k right on target. Pacing right on for plan."',
      },
    },
  }),
  evt(400, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_summary",
    tool: "annotate",
    args: {
      documentId: DOC.carolPostRunWA,
      quote: "Solid week — peak mileage in the bag, 25k right on target. Pacing right on for plan.",
      quoteAuthor: "Carol",
    },
    intent: "Annotate Carol's verdict",
  }),
  evt(200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_summary",
    durationMs: 6,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.carolPostRunWA,
      ref: {
        documentId: DOC.carolPostRunWA,
        sourceType: "whatsapp-messages",
        sourceId: "whatsapp-messages:self",
        documentType: "conversation",
        title: "Carol Nakamura — 2025-09-13",
        ts: 1757754600000,
      },
      quote: "Solid week — peak mileage in the bag, 25k right on target. Pacing right on for plan.",
      quoteAuthor: "Carol",
    },
  }),

  // ── Walk the whole week's coaching arc into the agent's context ──────
  //    `trace_connections` seeded on the plan PDF traces the chronology of
  //    plan delivery → mid-week check-in → post-run verdict for the agent
  //    to reason over; the annotate calls that follow are what put those
  //    documents on the drawer's Timeline.
  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta: "\n\nOne more sanity check — let me stitch the coaching arc end-to-end.",
  }),
  evt(700, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_trail_arc",
    tool: "trace_connections",
    args: { seedIds: [DOC.planPdf], depth: 4 },
    intent: "Trace the week's coaching arc — plan → execution → verdict",
  }),
  evt(1200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_trail_arc",
    durationMs: 184,
    result: {
      kind: "event_trail.built",
      seeds: [DOC.planPdf],
      events: [
        {
          eventId: "evt-plan-email",
          at: "2025-09-01T08:00:00Z",
          kind: "document",
          doc: {
            documentId: DOC.planEmail,
            title: "Marathon training plan — week 6",
            sourceId: "gmail:self",
            documentType: "email",
          },
          attachments: [
            {
              eventId: "evt-plan-pdf",
              at: "2025-09-01T08:00:00Z",
              kind: "seed",
              doc: {
                documentId: DOC.planPdf,
                title: "Marathon plan — week 6.pdf",
                sourceId: "google-drive:self",
                documentType: "file",
                mimeType: "application/pdf",
              },
              attachments: [],
              people: [],
              related: [],
            },
          ],
          people: [
            { personId: "p-carol", name: "Carol Nakamura", role: "sender", isSelf: false },
            { personId: "p-self", name: "You", role: "recipient", isSelf: true },
          ],
          related: [],
        },
        {
          eventId: "evt-carol-checkin",
          at: "2025-09-08T14:00:00Z",
          kind: "document",
          doc: {
            documentId: DOC.carolLongRunWA,
            title: "Carol Nakamura — 2025-09-08",
            sourceId: "whatsapp-messages:self",
            documentType: "conversation",
          },
          attachments: [],
          people: [
            { personId: "p-self", name: "You", role: "participant", isSelf: true },
            { personId: "p-carol", name: "Carol Nakamura", role: "participant", isSelf: false },
          ],
          related: [],
        },
        {
          eventId: "evt-carol-verdict",
          at: "2025-09-13T09:02:00Z",
          kind: "document",
          doc: {
            documentId: DOC.carolPostRunWA,
            title: "Carol Nakamura — 2025-09-13",
            sourceId: "whatsapp-messages:self",
            documentType: "conversation",
          },
          attachments: [],
          people: [
            { personId: "p-self", name: "You", role: "participant", isSelf: true },
            { personId: "p-carol", name: "Carol Nakamura", role: "participant", isSelf: false },
          ],
          related: [],
        },
      ],
      truncated: false,
      stats: { visited: 3, elapsedMs: 184, maxDepthReached: 2 },
    },
  }),
  evt(420, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_planemail",
    tool: "annotate",
    args: {
      documentId: DOC.planEmail,
      note: "Carol delivered the week-6 plan on Mon morning — this is the anchor for the week",
    },
    intent: "Anchor the plan email with a one-liner",
  }),
  evt(200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_planemail",
    durationMs: 5,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.planEmail,
      ref: {
        documentId: DOC.planEmail,
        sourceType: "gmail",
        sourceId: "gmail:self",
        documentType: "email",
        title: "Marathon training plan — week 6",
        ts: 1756711200000,
      },
      note: "Carol delivered the week-6 plan on Mon morning — this is the anchor for the week",
    },
  }),
  evt(220, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_verdict",
    tool: "annotate",
    args: {
      documentId: DOC.carolPostRunWA,
      quote: "Pacing right on for plan.",
      quoteAuthor: "Carol",
      note: "Carol's full-week verdict at the chronology's end-cap",
    },
    intent: "Pin Carol's verdict onto the timeline",
  }),
  evt(200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_verdict",
    durationMs: 6,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.carolPostRunWA,
      ref: {
        documentId: DOC.carolPostRunWA,
        sourceType: "whatsapp-messages",
        sourceId: "whatsapp-messages:self",
        documentType: "conversation",
        title: "Carol Nakamura — 2025-09-13",
        ts: 1757754600000,
      },
      quote: "Pacing right on for plan.",
      quoteAuthor: "Carol",
      note: "Carol's full-week verdict at the chronology's end-cap",
    },
  }),

  evt(300, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p3",
    tool: "plan",
    args: { complete: ["p3"] },
    intent: "Mark the coach-feedback step done",
  }),
  evt(120, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p3",
    durationMs: 2,
    result: {
      kind: "plan.updated",
      items: [
        { id: "p1", label: "Find your training plan", status: "done" },
        { id: "p2", label: "Check the week's actual training data", status: "done" },
        { id: "p3", label: "Look for coaching feedback", status: "done" },
      ],
    },
  }),

  // ── Final verdict ────────────────────────────────────────────────────
  evt(300, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      '\n\n**On track.**\n\n- **Volume**: 95.6 km logged vs the 75 km plan baseline — peak week. The 25.2 km long run landed on the 25 km target.\n- **Aerobic fitness**: resting HR down to 54 bpm (was 58 four weeks ago) — classic training adaptation, no overtraining signal.\n- **Coach read**: Carol called it "pacing right on for plan".\n\nDeload starts now — cut volume ~30 %, keep one quality workout, sleep more.',
  }),
  evt(500, "agent.message.end", {
    sessionId: $S,
    messageId: $M,
    stopReason: "end_turn",
    usage: { inputTokens: 1640, outputTokens: 420, cacheReadTokens: 1200, cacheCreationTokens: 0 },
  }),
];

const out =
  "# Demo fixture — marathon-prep scenario.\n" +
  "# Generated by build-demo-marathon-prep.mjs.\n" +
  "# Showcases the agent reading BOTH unstructured docs (Drive PDF,\n" +
  "# Gmail, WhatsApp) AND structured analytics (Strava + Apple Health)\n" +
  "# inside one coherent answer.\n" +
  events.join("\n") +
  "\n";
writeFileSync(new URL("../marathon-prep.jsonl", import.meta.url), out);
console.log(`wrote ${events.length} entries`);
