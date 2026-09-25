// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The sweeps that ship with the gateway.
 *
 * Each is an id, a cadence, a time of day, and a paragraph. They are read-only
 * on every surface: the portal lists them beside the operator's own, and the
 * only edit is a fork — a user file of the same id that layers over this one
 * (see `registry.ts`). That keeps upgrades meaningful, since a system sweep
 * whose prose improves in a release improves for everyone who has not forked
 * it.
 *
 * The prose obeys the same contract asked of a community sweep, which is the
 * point of writing them this way: it names the substrate it maintains (briefs,
 * loops, deadlines) but never a tool, a source, or a person. A sweep that
 * needs to know how Omnesis is built is not portable, and portability is the
 * whole reason a sweep is prose rather than code.
 *
 * Anchors are staggered deliberately. The run drainer executes non-daily runs
 * strictly serialized, so themes sharing a clock would queue behind each other
 * for hours; and anything running between the daily boundary and the morning
 * digest holds the digest's readiness barrier open. The times below sit
 * outside that window and apart from each other.
 */

import type { SystemSweepDef } from "./types.js";

export const SYSTEM_SWEEPS: readonly SystemSweepDef[] = [
  {
    id: "may-day",
    name: "Day ahead",
    cadenceHours: 24,
    at: "05:00",
    enabled: true,
    // Anchored to the daily boundary, inside the window the morning digest
    // waits on — deliberately. The digest is an editorial pass over what the
    // overnight work found, and this pass is most of that work.
    expectedBeforeDigest: true,
    // Its product is informative event preparation — restating today with the
    // context around it — which the reactive awareness gate reads as an echo.
    briefLane: "lookahead",
    steeringPrompt:
      "Prepare the user for the day that is starting. Look at what is happening today — meetings, appointments, scheduled events — and for the ones that merit it write an informative brief: what it is, when, with whom, and the context worth having to hand, drawn from the surrounding correspondence. Stamp each brief with the time of the event it concerns so the feed can rank it into the right part of the day, and cite the documents you drew it from. Check the open loops falling due today or very shortly and remind the user where a reminder would help. Then look a week out — across both source-owned schedules and your own recorded interpretations of upcoming time — and for anything genuinely approaching that needs preparing, surface it and open a loop if it is a real obligation nobody is tracking yet. If along the way you find a tracked obligation has already been fulfilled — a receipt, a confirmation, a reply that settles it — close its loop as done with a note and remove the briefs it made moot; never delete a loop that was actually completed, because the record of what happened is worth keeping. Check what is already in the feed before writing anything, so an earlier pass's card is updated rather than duplicated. Where an event later today would benefit from the freshest possible picture, schedule yourself a short follow-up shortly beforehand to rebuild its brief. Most days only a handful of things merit a brief, and an empty pass is a fine outcome.",
  },
  {
    id: "missed-calls",
    name: "Missed calls",
    cadenceHours: 24,
    at: "05:10",
    enabled: true,
    // Its cross-channel reconciliation is overnight work for the digest, but
    // its cards still face the ordinary reactive-awareness gate.
    expectedBeforeDigest: true,
    steeringPrompt:
      "Review recent genuinely missed incoming calls. Do not treat a call known to have been blocked, rejected, or answered elsewhere as missed; treat one sent to voicemail according to whether it left an unresolved action. Try to identify each caller from the available identity links and surrounding corpus even when no contact name is attached, but never guess. Reconcile what happened afterwards with that person across every channel. A later unanswered follow-up strengthens the case only when it plausibly concerns the same attempt or underlying matter; only a connected return call, a substantive reply from the user that plausibly handles that attempt or matter, or other clear evidence that it was handled makes the call moot. Surface only credible calls that still appear to need a response or action, and leave an isolated unidentified call quiet unless repetition or corroborating context makes it matter. An empty pass is a fine outcome.",
  },
  {
    id: "weekly-finances",
    name: "Weekly finances",
    cadenceHours: 24 * 7,
    at: "09:10",
    enabled: true,
    steeringPrompt:
      "Review the past week's financial activity across every source — new or upcoming invoices and bills, subscriptions renewing, refunds owed or awaited, and any charge that looks unusual for its merchant or amount. Surface only what needs a decision or action; ignore routine, already-settled transactions.",
  },
  {
    id: "waiting-on-others",
    name: "Waiting on others",
    cadenceHours: 24 * 7,
    at: "09:40",
    enabled: true,
    steeringPrompt:
      "Scan for things the user is waiting on from someone else — a reply, a delivery, a document, a decision, a payment — that have gone quiet past a reasonable turnaround for that person and channel. Surface the ones genuinely worth a nudge; skip anything still within a normal wait.",
  },
  {
    id: "relationships-nudge",
    name: "Relationships",
    cadenceHours: 24 * 14,
    at: "10:10",
    enabled: true,
    steeringPrompt:
      "Who has the user not been in touch with for notably longer than their usual rhythm together, and are there unanswered messages or owed replies to people who matter? Surface a gentle, specific reconnect nudge only where it would genuinely land; never manufacture social pressure.",
  },
  {
    id: "health-trends",
    name: "Health trends",
    cadenceHours: 24 * 7,
    at: "10:40",
    enabled: true,
    steeringPrompt:
      "Review the past week's health and fitness data against the user's OWN recent baseline — sleep, activity, resting heart rate, body metrics. Surface a meaningful shift or sustained trend worth their awareness. Never diagnose, never surface a single normal reading, and defer anything medical to a clinician.",
  },
  {
    id: "upcoming-horizon",
    name: "Upcoming horizon",
    cadenceHours: 24 * 7,
    at: "11:10",
    enabled: true,
    temporalAnnotationPrimeDays: 21,
    steeringPrompt:
      "Look ~2-3 weeks ahead across calendar, travel, deadlines, renewals, and dated obligations. Start from the primed temporal annotations in this prompt (re-ground each before acting on it) and query for any window you need beyond them — do NOT re-derive structured dates that temporal projections already carry. What is coming that benefits from acting NOW — a booking to make, a document to prepare, a decision with a closing window? Surface where early action matters; skip anything already well in hand.",
  },
  {
    id: "subscriptions-review",
    name: "Subscriptions",
    cadenceHours: 24 * 30,
    at: "11:40",
    enabled: true,
    steeringPrompt:
      "Review recurring subscriptions, memberships, insurance, and auto-renewals visible in the corpus. Is anything renewing soon that the user might want to cancel, downgrade, or renegotiate — especially things they seem not to use? Surface renewals with a real decision window and a hint of why; ignore ones clearly wanted.",
  },
];

/** Ids that a user file may layer over rather than define from scratch. */
export const SYSTEM_SWEEP_IDS: ReadonlySet<string> = new Set(SYSTEM_SWEEPS.map((s) => s.id));
