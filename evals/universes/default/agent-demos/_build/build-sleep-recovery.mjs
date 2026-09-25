// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Builds the sleep-recovery demo fixture — the health showcase that goes
 * beyond fitness. Every claim is grounded in a tool result: the agent
 * never asserts anything (e.g. "it's marathon block") it didn't find.
 *
 * Scenario (today = Mon 15 Sep 2025): the user's sleep has been rough for
 * a fortnight. The agent:
 *
 *   1. Pulls the Apple Health sleep trend (the four bad nights + the tell:
 *      long time-to-fall-asleep on two of them).
 *   2. Instead of guessing the cause, SEARCHES for what the user has said
 *      about it — a WhatsApp thread where the partner (Claire) floats two
 *      hypotheses: the marathon block, or the late work calls.
 *   3. Tests BOTH, with evidence:
 *      - Marathon: reads the training plan (Google Drive) and the week's
 *        runs (Strava) — the hardest run was followed by a normal night,
 *        so training is ruled out.
 *      - Late calls: the calendar shows a late-evening APAC call (20:00 and
 *        21:00) on exactly the two bad-onset nights; the mechanism is the
 *        after-call scrolling the user described to Claire.
 *
 * The cited docs span Apple Health, WhatsApp, Google Drive, Strava and
 * Google Calendar — five sources, five icons in the timeline.
 *
 * Run after edits:
 *   node evals/universes/default/agent-demos/_build/build-sleep-recovery.mjs
 *
 * Routing triggers and placeholder declarations live in the sibling
 * `sleep-recovery.meta.json`.
 */

import { writeFileSync } from "node:fs";

const $S = "$SESSION";
const $M = "$MSG";

const DOC = {
  claire: "$DOC_synth-whatsapp-claire-late",
  plan: "$DOC_synth-gdrive-006",
  longRun: "$DOC_synth-strava-009",
  apac1: "$DOC_synth-gcal-apac-1",
  apac2: "$DOC_synth-gcal-apac-2",
};

// Real per-source account suffixes (from the default universe) so citations
// hit the exact-id icon key as well as the type fallback.
const SRC = {
  wa: "whatsapp-messages:+15550100",
  drive: "google-drive:john.smith@example.com",
  strava: "strava-activities:7000000",
  cal: "google-calendar:john.smith@example.com",
};

const ts = (iso) => Date.parse(iso);

const HEALTH_SOURCES = [
  {
    sourceId: "apple-health:ios-synth-johnsmith",
    sourceType: "apple-health",
    displayName: "Apple Health",
  },
];

// All columns derive from the health.json `sleep` stage arrays + the `hrv`
// / `resting_hr` vitals — see the fixture. mins_to_sleep is the leading
// inBed time before the first asleep stage (sleep-onset latency).
const SLEEP_SQL = [
  "SELECT night_of,",
  "       ROUND(asleep_minutes / 60.0, 1) AS hours_asleep,",
  "       awake_minutes AS awake_min,",
  "       onset_latency_minutes AS mins_to_sleep,",
  "       hrv_ms,",
  "       resting_hr_bpm AS resting_hr",
  "FROM health_sleep",
  "WHERE night_of >= DATE '2025-09-01'",
  "ORDER BY night_of",
].join("\n");

const PACE = 1.5;

function evt(afterMs, type, payload) {
  return JSON.stringify({ afterMs: Math.round(afterMs * PACE), event: { type, payload } });
}

const PLAN_LABELS = {
  p1: "Pull the sleep trend",
  p2: "See what you've flagged about it",
  p3: "Track down the cause",
};

function planUpdated(states) {
  return {
    kind: "plan.updated",
    items: ["p1", "p2", "p3"].map((id) => ({ id, label: PLAN_LABELS[id], status: states[id] })),
  };
}

const events = [
  evt(400, "agent.message.start", { sessionId: $S, messageId: $M, role: "assistant" }),
  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "Let me trace it properly rather than guess — I'll pull your sleep, see what you've already said about it, then test whatever leads that turns up.",
  }),

  // ── Plan ─────────────────────────────────────────────────────────────
  evt(300, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_setup",
    tool: "plan",
    args: {
      add: ["Pull the sleep trend", "See what you've flagged about it", "Track down the cause"],
    },
    intent: "Lay out the approach",
  }),
  evt(120, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_setup",
    durationMs: 3,
    result: planUpdated({ p1: "in_progress", p2: "pending", p3: "pending" }),
  }),

  // ── Step 1: the sleep trend (Apple Health) ───────────────────────────
  evt(700, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_sql_sleep",
    tool: "run_sql",
    args: { sql: SLEEP_SQL },
    intent: "Hours, wake time, time-to-fall-asleep, HRV and resting HR per night",
  }),
  evt(1500, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_sql_sleep",
    durationMs: 206,
    result: {
      kind: "sql.rows",
      sql: SLEEP_SQL,
      columns: ["night_of", "hours_asleep", "awake_min", "mins_to_sleep", "hrv_ms", "resting_hr"],
      rows: [
        ["2025-09-01", 7.1, 15, 5, 50, 55],
        ["2025-09-02", 7.1, 10, 5, 49, 55],
        ["2025-09-03", 6.5, 10, 8, 46, 57],
        ["2025-09-04", 7.0, 12, 6, 48, 56],
        ["2025-09-05", 7.1, 7, 5, 50, 55],
        ["2025-09-06", 7.3, 6, 7, 52, 54],
        ["2025-09-07", 5.9, 21, 4, 40, 59],
        ["2025-09-08", 6.4, 8, 6, 45, 56],
        ["2025-09-09", 5.0, 32, 22, 36, 61],
        ["2025-09-10", 6.5, 9, 7, 49, 55],
        ["2025-09-11", 4.2, 50, 34, 34, 63],
        ["2025-09-12", 5.1, 26, 12, 39, 60],
        ["2025-09-13", 6.9, 7, 5, 50, 54],
        ["2025-09-14", 6.5, 8, 6, 48, 55],
      ],
      rowCount: 14,
      durationMs: 206,
      sources: HEALTH_SOURCES,
      subjects: ["Sleep"],
    },
  }),
  evt(160, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\nFour short nights stand out — **7, 9, 11 and 12 Sep**, all under 6h. But the tell is the last column: on **9 and 11 Sep** you lay awake **22 and 34 minutes** before dropping off (vs your usual 5–7), with HRV as low as **34ms** and resting HR up to **63** — you couldn't switch off. The 7th and 12th were short too, but you got to sleep in reasonable time, so it's those two bad-onset nights — the **9th and 11th** — that need explaining. Rather than guess, let me see what you've said about it.",
  }),
  evt(300, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p1",
    tool: "plan",
    args: { complete: ["p1"] },
    intent: "Mark the sleep-trend step done",
  }),
  evt(120, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p1",
    durationMs: 2,
    result: planUpdated({ p1: "done", p2: "in_progress", p3: "pending" }),
  }),

  // ── Step 2: what the user actually said (WhatsApp / Claire) ───────────
  evt(700, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_claire",
    tool: "search_documents",
    args: { query: "can't sleep exhausted wired tired bad night", limit: 5 },
    intent: "Anywhere you've mentioned the bad sleep",
  }),
  evt(1200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_claire",
    durationMs: 178,
    result: {
      kind: "search.results",
      query: "can't sleep exhausted wired tired bad night",
      durationMs: 178,
      candidates: 3,
      results: [
        {
          documentId: DOC.claire,
          sourceType: "whatsapp-messages",
          sourceId: SRC.wa,
          documentType: "conversation",
          title: "Claire — 2025-09-11",
          snippet:
            'You: "Third rough night running… lay there wired for ages." · Claire: "Might be the marathon block? Or those late work calls."',
          ts: ts("2025-09-11T22:18:00Z"),
        },
      ],
    },
  }),
  evt(650, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_claire",
    tool: "fetch_document",
    args: { documentId: DOC.claire },
    intent: "Read the thread with Claire",
  }),
  evt(950, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_claire",
    durationMs: 158,
    result: {
      kind: "document",
      ref: {
        documentId: DOC.claire,
        sourceType: "whatsapp-messages",
        sourceId: SRC.wa,
        documentType: "conversation",
        title: "Claire — 2025-09-11",
        ts: ts("2025-09-11T22:18:00Z"),
      },
      document: {
        id: DOC.claire,
        title: "Claire",
        content:
          'You (9 Sep): "Third rough night running — lay there wired for ages again. Shattered."\nClaire: "Might be the marathon block catching up? You\'re deep in the big-mileage weeks. Or those late work calls."\nYou (11 Sep): "Another one after the call. Brain won\'t switch off, been scrolling for an hour."\nClaire: "Put the phone down love, you\'re up at 6 for the long run."',
      },
    },
  }),
  evt(380, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_claire",
    tool: "annotate",
    args: {
      documentId: DOC.claire,
      quote: "Might be the marathon block catching up? … Or those late work calls.",
      quoteAuthor: "Claire",
    },
    intent: "Pin Claire's two hypotheses",
  }),
  evt(200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_claire",
    durationMs: 5,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.claire,
      ref: {
        documentId: DOC.claire,
        sourceType: "whatsapp-messages",
        sourceId: SRC.wa,
        documentType: "conversation",
        title: "Claire — 2025-09-11",
        ts: ts("2025-09-11T22:18:00Z"),
      },
      quote: "Might be the marathon block catching up? … Or those late work calls.",
      quoteAuthor: "Claire",
    },
  }),
  evt(160, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\nClaire pinned it to two possibilities: the **marathon block**, or the **late work calls**. Two testable leads — let me take them in turn, starting with training.",
  }),
  evt(300, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p2",
    tool: "plan",
    args: { complete: ["p2"] },
    intent: "Mark the context step done",
  }),
  evt(120, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p2",
    durationMs: 2,
    result: planUpdated({ p1: "done", p2: "done", p3: "in_progress" }),
  }),

  // ── Step 3a: test the marathon lead (Google Drive plan + Strava) ─────
  evt(700, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_training",
    tool: "search_documents",
    args: { query: "marathon training plan long run mileage", limit: 5 },
    intent: "Your training plan and this week's runs",
  }),
  evt(1200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_training",
    durationMs: 191,
    result: {
      kind: "search.results",
      query: "marathon training plan long run mileage",
      durationMs: 191,
      candidates: 4,
      results: [
        {
          documentId: DOC.plan,
          sourceType: "google-drive",
          sourceId: SRC.drive,
          documentType: "file",
          title: "Marathon plan — week 6.pdf",
          snippet: "Week 6 marathon plan: 75 km, long run 25 km, 6×800m intervals.",
          ts: ts("2025-09-01T08:00:00Z"),
        },
        {
          documentId: DOC.longRun,
          sourceType: "strava-activities",
          sourceId: SRC.strava,
          documentType: "activity",
          title: "Long run",
          snippet: "Sat 13 Sep · 25.2 km · your biggest session of the block.",
          ts: ts("2025-09-13T07:00:00Z"),
        },
      ],
    },
  }),
  evt(400, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_plan",
    tool: "annotate",
    args: {
      documentId: DOC.plan,
      quote: "Week 6 marathon plan: 75 km, long run 25 km, 6×800m intervals",
      note: "This week's prescribed load — the training I'm checking your sleep against",
    },
    intent: "Pin the plan that sets the training load",
  }),
  evt(200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_plan",
    durationMs: 5,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.plan,
      ref: {
        documentId: DOC.plan,
        sourceType: "google-drive",
        sourceId: SRC.drive,
        documentType: "file",
        title: "Marathon plan — week 6.pdf",
        ts: ts("2025-09-01T08:00:00Z"),
      },
      quote: "Week 6 marathon plan: 75 km, long run 25 km, 6×800m intervals",
      note: "This week's prescribed load — the training I'm checking your sleep against",
    },
  }),
  evt(360, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_run",
    tool: "annotate",
    args: {
      documentId: DOC.longRun,
      quote: "Long run — 25.2 km, Sat 13 Sep",
      note: "Hardest session of the block — followed by a normal night (6.9h, HRV back to 50), not a bad one",
    },
    intent: "Pin the key run against the sleep it produced",
  }),
  evt(200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_run",
    durationMs: 5,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.longRun,
      ref: {
        documentId: DOC.longRun,
        sourceType: "strava-activities",
        sourceId: SRC.strava,
        documentType: "activity",
        title: "Long run",
        ts: ts("2025-09-13T07:00:00Z"),
      },
      quote: "Long run — 25.2 km, Sat 13 Sep",
      note: "Hardest session of the block — followed by a normal night (6.9h, HRV back to 50), not a bad one",
    },
  }),
  evt(160, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\n**Training doesn't fit.** The plan has you at **75 km with a 25 km long run** this week — a heavy block, so if mileage were the culprit it'd be biting now. But your biggest session, the **25.2 km long run on 13 Sep**, was followed by a **normal night** (6.9h, HRV back to 50), not a bad one. So it's not the marathon. On to the calls.",
  }),

  // ── Step 3b: test the late-calls lead (Google Calendar) ──────────────
  evt(700, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_calls",
    tool: "search_documents",
    args: { query: "evening call late meeting after 8pm", limit: 5 },
    intent: "What was on the calendar on the bad-onset nights",
  }),
  evt(1200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_calls",
    durationMs: 176,
    result: {
      kind: "search.results",
      query: "evening call late meeting after 8pm",
      durationMs: 176,
      candidates: 2,
      results: [
        {
          documentId: DOC.apac2,
          sourceType: "google-calendar",
          sourceId: SRC.cal,
          documentType: "event",
          title: "APAC customer call — Meridian rollout",
          snippet: "Thu 11 Sep · 21:00–22:15 · Zoom.",
          ts: ts("2025-09-11T21:00:00Z"),
        },
        {
          documentId: DOC.apac1,
          sourceType: "google-calendar",
          sourceId: SRC.cal,
          documentType: "event",
          title: "APAC customer call — Meridian rollout",
          snippet: "Tue 9 Sep · 20:00–21:30 · Zoom.",
          ts: ts("2025-09-09T20:00:00Z"),
        },
      ],
    },
  }),
  evt(600, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_call",
    tool: "annotate",
    args: {
      documentId: DOC.apac2,
      quote: "APAC customer call — 21:00–22:15",
      note: "Falls on 11 Sep — your worst night (4.2h, 34 min to fall asleep)",
    },
    intent: "Pin the late call onto the worst night",
  }),
  evt(200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_call",
    durationMs: 5,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.apac2,
      ref: {
        documentId: DOC.apac2,
        sourceType: "google-calendar",
        sourceId: SRC.cal,
        documentType: "event",
        title: "APAC customer call — Meridian rollout",
        ts: ts("2025-09-11T21:00:00Z"),
      },
      quote: "APAC customer call — 21:00–22:15",
      note: "Falls on 11 Sep — your worst night (4.2h, 34 min to fall asleep)",
    },
  }),
  evt(160, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\n**The calls fit.** A **late-evening APAC call on both 9 and 11 Sep** (20:00 and 21:00) — the two nights you couldn't drop off. And the mechanism's in the thread: after the 11th's call, which ran to 22:15, you told Claire you'd \"been scrolling for an hour\". Call ends, you're still wired on the phone.",
  }),
  evt(300, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p3",
    tool: "plan",
    args: { complete: ["p3"] },
    intent: "Mark the diagnosis step done",
  }),
  evt(120, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p3",
    durationMs: 2,
    result: planUpdated({ p1: "done", p2: "done", p3: "done" }),
  }),

  // ── Final verdict ────────────────────────────────────────────────────
  evt(300, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\n**It's the late calls, not the marathon.**\n\nClaire raised both; I tested both against your data:\n\n- **Marathon — ruled out.** Your hardest run (25.2 km, 13 Sep, from Strava) was followed by a normal night, not a bad one. Training and bad sleep don't line up.\n- **Late calls — confirmed.** A late-evening APAC call sits on both bad-onset nights (20:00 on the 9th, 21:00 on the 11th), and the mechanism is the after-call scrolling you mentioned to Claire.\n\n**Two levers**: move the APAC call out of the late-evening slot, and a hard screen-down once it ends. Protect your recovery — the long run already proves your body sleeps fine when it's left alone.",
  }),
  evt(500, "agent.message.end", {
    sessionId: $S,
    messageId: $M,
    stopReason: "end_turn",
    usage: { inputTokens: 1720, outputTokens: 520, cacheReadTokens: 1280, cacheCreationTokens: 0 },
  }),
];

const out =
  "# Demo fixture — sleep-recovery scenario.\n" +
  "# Generated by build-sleep-recovery.mjs.\n" +
  "# Health showcase beyond fitness. The agent grounds every claim: it pulls\n" +
  "# the Apple Health sleep trend, SEARCHES for what the user said (a Claire\n" +
  "# WhatsApp thread floating two hypotheses — marathon vs late calls), then\n" +
  "# tests both — the training plan (Drive) + the long run (Strava) rule out\n" +
  "# training; the calendar confirms the late APAC calls. Citations span\n" +
  "# Apple Health, WhatsApp, Google Drive, Strava and Google Calendar.\n" +
  events.join("\n") +
  "\n";
writeFileSync(new URL("../sleep-recovery.jsonl", import.meta.url), out);
console.log(`wrote ${events.length} entries`);
