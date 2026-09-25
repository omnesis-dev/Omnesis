#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Generates the `poc` universe's event journal and analytics rows.
 *
 * Re-run after editing:
 *   node packages/watch/universes/poc/_build/build.mjs
 *
 * Everything here is invented. No value is drawn from any real corpus.
 *
 * The universe is a **season in one fictional life**, March to May 2026, shaped
 * so that every watch in `../watches/` has several things to react to and every
 * awkward case the runtime has to survive actually occurs.
 *
 * Several rather than one, deliberately. A reference that fires exactly once is
 * nearly free to match by accident: any plan that fires somewhere near the right
 * moment scores the same as the plan that was asked for, and a measurement built
 * on such references reports agreement it did not earn. So each scenario recurs
 * — a rhythm that breaks three times, three calendar months of spending, three
 * spells of bad sleep — and `src/eval/entropy.test.ts` holds the corpus to that
 * shape, both that no two references behave alike and that each has more than
 * one occasion to be right about.
 *
 * The awkward cases:
 *
 * - **Out-of-order semantic time.** A source backfills: an event observed on
 *   the 22nd carries a semantic time of the 18th. Windowed operators evaluate
 *   on semantic time, so this must not be a special case for them, and `seq`
 *   and `observedAt` still only move forward.
 * - **A revised analytics row.** A card transaction lands pending and is
 *   revised in place when it posts, arriving as `updated` for a primary key
 *   already seen. An *unchanged* redelivery is deliberately absent: the journal
 *   is post-dedup, and the whole point of that is that a re-sync is a non-event.
 * - **A person merged mid-month.** Two ids for the same human appear, the
 *   earlier one before the merge and the canonical one after. A watch keyed on
 *   that person must not split into two instances.
 * - **Downtime across a timer boundary.** `observedAt` jumps by three days
 *   while semantic time continues, so a deadline that came due inside the gap
 *   comes due on the way back up — once, not once per missed boundary.
 *
 * Times are UTC. The generator is deterministic: no clock is read, and every
 * instant is derived from `MARCH`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UNIVERSE = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- The cast, matching ontology.json -------------------------------------
const SELF = "0a1b2c3d-0000-4000-8000-000000000001";
const ALICE = "b3f2a9d4-0000-4000-8000-000000000002";
const NADIA = "c91d4e02-0000-4000-8000-000000000003";
const MAYA = "5e7a1c88-0000-4000-8000-000000000004";
const DAVID = "2f4d6b90-0000-4000-8000-000000000005";
/** Maya's pre-merge identity. Appears before the merge and never after. */
const MAYA_BEFORE_MERGE = "9c3e5a17-0000-4000-8000-000000000006";
/**
 * Someone genuinely out of touch: in the diary, and nowhere else in the season.
 *
 * The lost-touch watch reads `people.last_seen`, so the person it fires on has
 * to be absent from the rest of the journal or the fixture contradicts itself —
 * a correspondent who emails weekly and was last seen fourteen months ago is not
 * a scenario, it is a stale row, and a watch tuned against one is measuring the
 * staleness.
 */
const PRIYA = "7b2c9f45-0000-4000-8000-000000000007";

/** March 2026. The 1st is a Sunday, so the 2nd is a Monday. */
const MARCH = Date.UTC(2026, 2, 1);
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;

/**
 * How long the season runs. Day 1 is the 1st of March and day 90 is the 29th of
 * May, so the journal spans three whole calendar months — which is what lets a
 * monthly watch fire three times rather than assert on a single month.
 */
const SEASON = 90;

/** `at(2, 9)` — the 2nd of March at 09:00 UTC. Days past 31 roll into April. */
function at(day, hour = 0, minute = 0) {
  return new Date(MARCH + (day - 1) * DAY + hour * HOUR + minute * MINUTE).toISOString();
}

let docSeq = 0;
/** Invented document ids, one per call, in generation order. */
function docId() {
  docSeq += 1;
  return `d0c00000-0000-4000-8000-${String(docSeq).padStart(12, "0")}`;
}

/**
 * Documents that fixtures outside this file name.
 *
 * Their ids come from a separate block, indexed by position in this list rather
 * than by generation order, so adding a document anywhere in the season leaves
 * them where they were. Everything the scripted recall and judge fixtures name
 * is here, along with `probe.json`'s booking and the recall fixture in
 * `goldens.test.ts`.
 *
 * Were the ids allocated in generation order, inserting one earlier email would
 * shift every id after it by one, and a fixture that meant "the
 * contract-signature email" would come to mean whatever occupied that slot —
 * the judge would still answer, the watch would still fire, and the golden
 * would re-record around it. Append to this list; never reorder it.
 */
const ANCHORS = [
  "lisbon-flight-booking",
  "alice-thinking-about-options",
  "alice-chat-12-march",
  "alice-chat-16-march",
  "alice-chat-21-march",
  "alice-cant-make-dinner",
  "contract-signature-needed",
  "maya-brief-thursday",
  "david-venue-deposit",
  "nadia-paperwork-arrived",
  "david-confirm-venue",
  "march-retainer-invoice",
  "march-retainer-receipt",
  "invoice-due-on-receipt",
  "orphan-invoice-14-day",
  "northstar-proposal",
  "northstar-proposal-followup",
  "quote-accepted",
  "quote-invoice-30-day",
  "lisbon-place-found",
  "april-retainer-invoice",
  "april-retainer-receipt",
  "order-confirmed",
  "order-delayed",
  "order-rescheduled",
  "order-shipped",
];

function anchorId(name) {
  const index = ANCHORS.indexOf(name);
  if (index < 0) throw new Error(`no anchor named '${name}'`);
  return `d0c00001-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

const events = [];

function emit(kind, occurredAt, observedAt, payload) {
  events.push({ kind, occurredAt, observedAt, payload });
}

/**
 * A gmail message plus the `doc.indexed` that follows it. The two are separate
 * events on purpose: embeddings land after the document, which is why a
 * semantic match can never ride the document event.
 */
function email({
  at: occurredAt,
  observed = occurredAt,
  threadId,
  from,
  to,
  title,
  tags,
  indexed = true,
  anchor,
}) {
  const id = anchor ? anchorId(anchor) : docId();
  const people = [
    { personId: from, role: "sender", isSelf: from === SELF },
    ...to.map((p) => ({ personId: p, role: "recipient", isSelf: p === SELF })),
  ];
  emit("doc.event", occurredAt, observed, {
    op: "created",
    docId: id,
    sourceId: "gmail",
    providerId: "google",
    documentType: "email",
    title,
    semanticTime: occurredAt,
    changedFields: [],
    contentChanged: false,
    metadata: { tags: tags ?? [from === SELF ? "SENT" : "INBOX"], extra: { threadId } },
    people,
  });
  if (indexed) {
    emit("doc.indexed", occurredAt, isoPlus(observed, 40_000), {
      docId: id,
      eventIndexedAt: isoPlus(observed, 40_000),
    });
  }
  return id;
}

/** A chat day-aggregate. One document per chat per day, participants only. */
function chat({
  at: occurredAt,
  observed = occurredAt,
  source,
  chatJid,
  participants,
  title,
  op = "created",
  reuseDocId,
  degraded = false,
  anchor,
}) {
  const id = reuseDocId ?? (anchor ? anchorId(anchor) : docId());
  emit("doc.event", occurredAt, observed, {
    op,
    docId: id,
    sourceId: source,
    providerId: source === "whatsapp-messages" ? "whatsapp" : "apple",
    documentType: "chat",
    title,
    semanticTime: occurredAt,
    changedFields: op === "updated" ? ["contentHash", "sourceUpdatedAt"] : [],
    contentChanged: op === "updated",
    // `isGroup` is only declared by whatsapp; imessage's profile does not have
    // it, and a journal may not carry a field its source never promised.
    metadata:
      source === "whatsapp-messages"
        ? { extra: { chatJid, isGroup: participants.length > 2 } }
        : { extra: { chatJid } },
    // A degraded event is one whose people never settled inside the bound. It
    // carries the unresolved mention it does have, so a watch keyed on a person
    // sees "not yet known" rather than "nobody was here".
    people: degraded
      ? [{ personId: null, role: "participant", isSelf: false }]
      : participants.map((p) => ({ personId: p, role: "participant", isSelf: p === SELF })),
    ...(degraded ? { degraded: true } : {}),
  });
  emit("doc.indexed", occurredAt, isoPlus(observed, 40_000), {
    docId: id,
    eventIndexedAt: isoPlus(observed, 40_000),
  });
  return id;
}

/**
 * A later message landing in a chat that already has a document for that day.
 * The day-aggregate is rewritten rather than added to, so the event names the
 * document it revises and reports which fields moved.
 */
function chatUpdate(options) {
  return chat({ ...options, op: "updated" });
}

/**
 * A file in Drive.
 *
 * The ontology declares this source, so the journal has to carry events from
 * it: without them a watch listing `google-drive` in its filter behaves exactly
 * like one that leaves it out, and a compilation can drop half the filter
 * without the corpus noticing. The travel watch reads both gmail and Drive,
 * which is where that matters.
 */
function file({ at: occurredAt, observed = occurredAt, title, documentType, mimeType, owner }) {
  const id = docId();
  emit("doc.event", occurredAt, observed, {
    op: "created",
    docId: id,
    sourceId: "google-drive",
    providerId: "google",
    documentType,
    title,
    semanticTime: occurredAt,
    changedFields: [],
    contentChanged: false,
    metadata: { extra: { mimeType } },
    people: [{ personId: owner, role: "owner", isSelf: owner === SELF }],
  });
  emit("doc.indexed", occurredAt, isoPlus(observed, 40_000), {
    docId: id,
    eventIndexedAt: isoPlus(observed, 40_000),
  });
  return id;
}

/** A call-log day-aggregate. Not embedded — a call has no body to embed. */
function call({ at: occurredAt, observed = occurredAt, counterparty, direction }) {
  const id = docId();
  emit("doc.event", occurredAt, observed, {
    op: "created",
    docId: id,
    sourceId: "apple-call-log",
    providerId: "apple",
    documentType: "call-log",
    title: "Call",
    semanticTime: occurredAt,
    changedFields: [],
    contentChanged: false,
    metadata: { extra: { direction, callCount: 1 } },
    people: [{ personId: counterparty, role: "participant", isSelf: false }],
  });
  return id;
}

function isoPlus(iso, ms) {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function analyticsRow({
  at: occurredAt,
  observed = occurredAt,
  op = "inserted",
  table,
  sourceId,
  pk,
  row,
}) {
  emit("analytics.row", occurredAt, observed, { op, table, sourceId, pk, row });
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

// An important email nobody answers — the wait runs to its deadline.
email({
  at: at(2, 9),
  threadId: "T-1001",
  from: ALICE,
  to: [SELF],
  title: "Contract signature needed before Friday",
  anchor: "contract-signature-needed",
});

// The same shape, answered on the third day — the cancel arrives in time.
email({
  at: at(3, 10),
  threadId: "T-1002",
  from: DAVID,
  to: [SELF],
  title: "Can you confirm the venue?",
  anchor: "david-confirm-venue",
});
email({
  at: at(4, 11),
  threadId: "T-1002",
  from: SELF,
  to: [DAVID],
  title: "Re: Can you confirm the venue?",
});

// Three unanswered threads inside two days, from three different people. They
// exist so the corpus holds several keys live at once: a watch keyed by thread
// with one key at a time cannot tell correct per-instance state from a shared
// last-write, because both behave identically.
email({
  at: at(2, 10),
  threadId: "T-1101",
  from: MAYA,
  to: [SELF],
  title: "Re-reading the brief before Thursday",
  anchor: "maya-brief-thursday",
});
email({
  at: at(2, 16),
  threadId: "T-1102",
  from: DAVID,
  to: [SELF],
  title: "Two options for the venue deposit",
  anchor: "david-venue-deposit",
});
email({
  at: at(3, 8),
  threadId: "T-1103",
  from: NADIA,
  to: [SELF],
  title: "Did the paperwork arrive?",
  anchor: "nadia-paperwork-arrived",
});

// A proposal sent on a Wednesday. Five business days lands on the 11th.
email({
  at: at(4, 14),
  threadId: "T-2001",
  from: SELF,
  to: [MAYA],
  title: "Proposal: Studio Northstar rebrand",
  anchor: "northstar-proposal",
});

// Alice, over two channels, across a month.
email({
  at: at(5, 8, 30),
  threadId: "T-5001",
  from: ALICE,
  to: [SELF],
  title: "Thinking about my options",
  anchor: "alice-thinking-about-options",
});
const aliceMar12 = chat({
  at: at(12, 20),
  source: "whatsapp-messages",
  chatJid: "chat-alice",
  participants: [SELF, ALICE],
  title: "Alice — 12 March",
  anchor: "alice-chat-12-march",
});

// A trip booking, for the passport comparison. Anchored: `probe.json` names it
// to give the judged departure date the comparison actually computes on.
email({
  at: at(10, 7, 15),
  threadId: "T-6001",
  from: DAVID,
  to: [SELF],
  title: "Your booking is confirmed — LHR to Lisbon, 14 Sep",
  anchor: "lisbon-flight-booking",
});

// A second proposal on the thread the first was sent on. The watch ignores it:
// my own follow-up nudge must not restart the client's clock.
email({
  at: at(6, 11),
  threadId: "T-2001",
  from: SELF,
  to: [MAYA],
  title: "Following up on the proposal",
  anchor: "northstar-proposal-followup",
});

// An invoice with no receipt, and an invoice arriving with nothing before it.
// The first lets the AND gate reach its deadline; the second is an out-of-order
// arrival the sequence gate must drop rather than stash.
email({
  at: at(7, 9),
  threadId: "T-3101",
  from: DAVID,
  to: [SELF],
  title: "Invoice 2026-04, due on receipt",
  anchor: "invoice-due-on-receipt",
});
email({
  at: at(8, 9),
  threadId: "T-4101",
  from: MAYA,
  to: [SELF],
  title: "Invoice attached, 14-day terms",
  anchor: "orphan-invoice-14-day",
});

// An invoice and its receipt, on one thread.
email({
  at: at(6, 9),
  threadId: "T-3001",
  from: MAYA,
  to: [SELF],
  title: "Invoice 2026-03 for March retainer",
  anchor: "march-retainer-invoice",
});
email({
  at: at(9, 16),
  threadId: "T-3001",
  from: MAYA,
  to: [SELF],
  title: "Receipt — payment received, thank you",
  anchor: "march-retainer-receipt",
});

// A quote accepted, then invoiced. Order is the point.
email({
  at: at(11, 10),
  threadId: "T-4001",
  from: DAVID,
  to: [SELF],
  title: "Happy to proceed with the quote",
  anchor: "quote-accepted",
});
email({
  at: at(13, 9),
  threadId: "T-4001",
  from: DAVID,
  to: [SELF],
  title: "Invoice attached, 30-day terms",
  anchor: "quote-invoice-30-day",
});

// Relocation mentioned on two channels within the fortnight.
email({
  at: at(14, 12),
  threadId: "T-7001",
  from: ALICE,
  to: [SELF],
  title: "We found a place in Lisbon",
  anchor: "lisbon-place-found",
});
chat({
  at: at(16, 19),
  source: "whatsapp-messages",
  chatJid: "chat-alice",
  participants: [SELF, ALICE],
  title: "Alice — 16 March",
  anchor: "alice-chat-16-march",
});

// The same day's chat, rewritten as more messages land. It names the document
// created earlier that day rather than minting a second one.
chatUpdate({
  at: at(12, 22),
  source: "whatsapp-messages",
  chatJid: "chat-alice",
  participants: [SELF, ALICE],
  title: "Alice — 12 March",
  reuseDocId: aliceMar12,
});

// One whose people never settled inside the bound. It carries an unresolved
// mention and says so, rather than looking like a chat with nobody in it.
const unknownMar13 = chat({
  at: at(13, 20),
  source: "whatsapp-messages",
  chatJid: "chat-unknown",
  participants: [SELF],
  title: "Unknown number — 13 March",
});
chatUpdate({
  at: at(13, 21),
  source: "whatsapp-messages",
  chatJid: "chat-unknown",
  participants: [SELF],
  title: "Unknown number — 13 March",
  reuseDocId: unknownMar13,
  degraded: true,
});

// --- A person merged mid-month --------------------------------------------
// Before: a chat carrying Maya's pre-merge identity.
chat({
  at: at(6, 21),
  source: "apple-imessage",
  chatJid: "chat-maya",
  participants: [SELF, MAYA_BEFORE_MERGE],
  title: "Maya — 6 March",
});
// After: the same human, now canonical. A watch keyed on her must not split.
chat({
  at: at(19, 21),
  source: "apple-imessage",
  chatJid: "chat-maya",
  participants: [SELF, MAYA],
  title: "Maya — 19 March",
});

/**
 * A weekly call rhythm, broken twice and resumed twice.
 *
 * The first silence starts after the 15th of March and the deadline falls on the
 * 24th — inside the observation outage below, so the watch has to catch it up on
 * the way back rather than miss it. Calls resume on the 33rd, run weekly through
 * April, and stop again after the 61st, so the second deadline falls on the 70th
 * with the journal running normally.
 *
 * Twice, because a wait that fires once proves it can fire; a wait that fires,
 * resets on the next call, and fires again proves the reset works too. And the
 * two breaks are different lengths, so a compilation whose wait is a few days out
 * misses one of them rather than sailing through both.
 */
const MUM_CALLS = [
  [1, 18, 0, "incoming"],
  [8, 18, 20, "outgoing"],
  [15, 17, 45, "incoming"],
  // A silence of eighteen days. The deadline lands on the 24th, inside the
  // outage below, so it has to be caught up rather than missed.
  [33, 19, 10, "outgoing"],
  [40, 18, 30, "incoming"],
  [47, 17, 55, "incoming"],
  // Thirteen days, with the journal running normally.
  [60, 19, 25, "outgoing"],
  [67, 18, 5, "incoming"],
  // Twenty days, at the end of the season.
  [87, 18, 40, "outgoing"],
];
for (const [day, hour, minute, direction] of MUM_CALLS) {
  call({ at: at(day, hour, minute), counterparty: NADIA, direction });
}

/**
 * Calls with everyone else, including inside both of Nadia's silences.
 *
 * A watch about one person's rhythm has to say whose. When the log holds nothing
 * but her calls, a watch that omits the person filter behaves exactly like one
 * that has it — the silence looks the same either way. These make the two
 * differ: the phone is in use throughout the weeks she does not ring.
 */
const OTHER_CALLS = [
  [4, ALICE],
  [11, DAVID],
  [19, ALICE],
  [22, MAYA],
  [28, DAVID],
  [31, ALICE],
  [36, MAYA],
  [43, DAVID],
  [51, ALICE],
  [56, MAYA],
  [59, DAVID],
  [63, ALICE],
  [66, MAYA],
  [72, DAVID],
  [75, ALICE],
  [78, MAYA],
  [82, DAVID],
  [86, ALICE],
];
OTHER_CALLS.forEach(([day, counterparty], index) => {
  call({
    at: at(day, 12 + (index % 6)),
    counterparty,
    direction: index % 2 === 0 ? "outgoing" : "incoming",
  });
});

// Alice declines the dinner, on two channels.
email({
  at: at(20, 11),
  threadId: "T-8001",
  from: ALICE,
  to: [SELF],
  title: "So sorry — can't make dinner",
  anchor: "alice-cant-make-dinner",
});
chat({
  at: at(21, 9),
  source: "whatsapp-messages",
  chatJid: "chat-alice",
  participants: [SELF, ALICE],
  title: "Alice — 21 March",
  anchor: "alice-chat-21-march",
});

// After the outage: the first thing observed once the journal resumes. The
// call-rhythm deadline came due on the 24th, inside the gap, so it is caught up
// before this event is processed.
email({
  at: at(25, 8),
  threadId: "T-1003",
  from: DAVID,
  to: [SELF],
  title: "Back online — picking up where we left off",
});

// Six weeks out, so the journal outruns the longest deadline in the corpus and
// a gate that never completes is seen to expire rather than merely to stop.
email({
  at: at(40, 9),
  threadId: "T-1004",
  from: DAVID,
  to: [SELF],
  title: "Closing the loop on last month",
});

// --- Out-of-order semantic time --------------------------------------------
// A backfill: observed on the 22nd, but it happened on the 18th.
email({
  at: at(18, 15),
  observed: at(22, 8),
  threadId: "T-9001",
  from: MAYA,
  to: [SELF],
  title: "Notes from our call",
});

// ---------------------------------------------------------------------------
// April and May
// ---------------------------------------------------------------------------

/**
 * The same scenarios again, with different people, threads and spacing.
 *
 * A watch that fires once in March and never again is matched by any plan that
 * fires somewhere in March. Recurrence is what forces a compilation to have the
 * *rule* right: three unanswered threads a month apart, in each of which the
 * answer arrives or does not, cannot be reproduced by a plan that happens to
 * pick the right week.
 *
 * The variations are the point. Where March had the invoice answered, April has
 * it ignored; where March's proposal went unanswered, May's is declined on the
 * fourth day; the fortnight silence with Maya opens and closes three times.
 */

// Threads nobody answers, spread so several are live at different moments.
[
  [32, "T-1201", ALICE, "Re-issued contract for countersignature"],
  [33, "T-1202", MAYA, "Where did we land on the schedule?"],
  [45, "T-1203", DAVID, "Deposit deadline is next Tuesday"],
  [46, "T-1204", ALICE, "One more thing about the lease"],
  [66, "T-1205", MAYA, "Final read of the copy?"],
  [67, "T-1206", DAVID, "Confirming the delivery window"],
  [68, "T-1207", ALICE, "Signature still outstanding"],
].forEach(([day, threadId, from, title]) => {
  email({ at: at(day, 9, 20), threadId, from, to: [SELF], title });
});

// And two that are answered, one the same day and one on the third — the cancel
// arriving inside the deadline and just before it.
email({ at: at(38, 8), threadId: "T-1301", from: DAVID, to: [SELF], title: "Quick question" });
email({
  at: at(38, 15),
  threadId: "T-1301",
  from: SELF,
  to: [DAVID],
  title: "Re: Quick question",
});
email({ at: at(71, 8), threadId: "T-1302", from: MAYA, to: [SELF], title: "Two dates that work" });
email({
  at: at(73, 17),
  threadId: "T-1302",
  from: SELF,
  to: [MAYA],
  title: "Re: Two dates that work",
});

// Proposals. The April one is declined on the fourth business day, inside the
// window; the May one is never answered at all.
email({
  at: at(36, 10),
  threadId: "T-2101",
  from: SELF,
  to: [DAVID],
  title: "Proposal: Harbour House brand refresh",
});
email({
  at: at(41, 16),
  threadId: "T-2101",
  from: DAVID,
  to: [SELF],
  title: "Re: Proposal — going a different way, sorry",
});
email({
  at: at(72, 11),
  threadId: "T-2102",
  from: SELF,
  to: [ALICE],
  title: "Proposal: Meridian Outfitters catalogue",
});

// Invoices. April's arrives and is paid; May's arrives and is not.
email({
  at: at(34, 9),
  threadId: "T-3201",
  from: MAYA,
  to: [SELF],
  title: "Invoice 2026-05 for April retainer",
  anchor: "april-retainer-invoice",
});
email({
  at: at(44, 14),
  threadId: "T-3201",
  from: MAYA,
  to: [SELF],
  title: "Receipt — April retainer settled",
  anchor: "april-retainer-receipt",
});
email({
  at: at(65, 9),
  threadId: "T-3202",
  from: DAVID,
  to: [SELF],
  title: "Invoice 2026-06, 30-day terms",
});

// A quote accepted and then invoiced, again, five weeks after the first.
email({
  at: at(48, 10),
  threadId: "T-4201",
  from: ALICE,
  to: [SELF],
  title: "Yes — let's go ahead with the quote",
});
email({
  at: at(53, 9),
  threadId: "T-4201",
  from: ALICE,
  to: [SELF],
  title: "Invoice attached for the agreed scope",
});

/**
 * An order, by its number.
 *
 * The number is in the title because that is the only text the journal carries,
 * and it is deliberately unlike anything else in the season: an embedding
 * scores a token like this near zero against a topical floor, which is why a
 * request about one order was refused outright until a lexical arm existed.
 * Two documents so the watch has a nomination that matters and one that does
 * not — the confirmation is not a problem, the delay is.
 */
email({
  at: at(37, 8, 30),
  threadId: "T-5501",
  from: DAVID,
  to: [SELF],
  title: "Order XR-4471 confirmed — dispatch within five days",
  anchor: "order-confirmed",
});
email({
  at: at(46, 16, 10),
  threadId: "T-5501",
  from: DAVID,
  to: [SELF],
  title: "Order XR-4471 delayed — supplier shortage, new date to follow",
  anchor: "order-delayed",
});

email({
  at: at(55, 9, 45),
  threadId: "T-5501",
  from: DAVID,
  to: [SELF],
  title: "Order XR-4471 rescheduled — now landing the week of the 25th",
  anchor: "order-rescheduled",
});
email({
  at: at(69, 11, 20),
  threadId: "T-5501",
  from: DAVID,
  to: [SELF],
  title: "Order XR-4471 shipped — tracking attached",
  anchor: "order-shipped",
});

// A second trip booking, this one departing far outside the passport window.
email({
  at: at(58, 7, 40),
  threadId: "T-6101",
  from: DAVID,
  to: [SELF],
  title: "Booking confirmed — LGW to Reykjavik, 2 Aug",
});

// A subject raised on two channels a second time, in May.
email({
  at: at(80, 12),
  threadId: "T-7101",
  from: ALICE,
  to: [SELF],
  title: "The studio lease renewal came through",
});
chat({
  at: at(82, 19),
  source: "whatsapp-messages",
  chatJid: "chat-alice",
  participants: [SELF, ALICE],
  title: "Alice — 22 May",
});

/**
 * Everyday traffic: a chat with Alice most days, and with Maya on a rhythm that
 * lapses three times.
 *
 * Three of Maya's silences run eighteen days, past a fortnight; the messages in
 * between are a day apart, comfortably inside it. A watch whose wait is a week
 * fires in the gaps too, and is a different watch.
 */
const MAYA_MESSAGES = [26, 27, 45, 46, 64, 65, 83, 84];
for (const day of MAYA_MESSAGES) {
  chat({
    at: at(day, 20, 15),
    source: "apple-imessage",
    chatJid: "chat-maya",
    participants: [SELF, MAYA],
    title: `Maya — day ${day}`,
  });
}

const ALICE_CHATS = [28, 31, 37, 42, 49, 55, 60, 64, 69, 74, 78, 83, 87];
for (const day of ALICE_CHATS) {
  chat({
    at: at(day, 19, 30),
    source: "whatsapp-messages",
    chatJid: "chat-alice",
    participants: [SELF, ALICE],
    title: `Alice — day ${day}`,
  });
}

/**
 * Files, including one that carries a booking the travel watch should see.
 *
 * The itinerary lands in Drive rather than in the inbox, which is the case a
 * filter naming only gmail misses. The rest are working documents, spread so the
 * source contributes traffic throughout the season rather than in one burst.
 */
const FILES = [
  [9, "Rebrand moodboard", "file", "image/png", SELF],
  [17, "Retainer agreement — signed", "document", "application/pdf", SELF],
  [23, "Q1 figures", "spreadsheet", "application/vnd.google-apps.spreadsheet", SELF],
  [30, "Itinerary — Reykjavik, 2 Aug", "document", "application/pdf", DAVID],
  [38, "Site survey notes", "document", "application/vnd.google-apps.document", MAYA],
  [44, "Supplier comparison", "spreadsheet", "application/vnd.google-apps.spreadsheet", SELF],
  [52, "Catalogue draft", "file", "application/pdf", ALICE],
  [57, "Insurance schedule", "document", "application/pdf", SELF],
  [65, "Q2 forecast", "spreadsheet", "application/vnd.google-apps.spreadsheet", SELF],
  [71, "Lease — countersigned", "document", "application/pdf", ALICE],
  [79, "Photo selects", "file", "image/jpeg", MAYA],
  [85, "Handover checklist", "document", "application/vnd.google-apps.document", SELF],
];
for (const [day, title, documentType, mimeType, owner] of FILES) {
  file({ at: at(day, 11, 20), title, documentType, mimeType, owner });
}

// A group chat, so the corpus holds a conversation that is not a pair.
for (const day of [29, 47, 62, 81]) {
  chat({
    at: at(day, 21),
    source: "whatsapp-messages",
    chatJid: "chat-planning",
    participants: [SELF, ALICE, DAVID],
    title: `Planning group — day ${day}`,
  });
}

/**
 * Correspondence that answers itself, filling the season between the scenarios.
 *
 * Each runs to four messages: they write, I reply the same afternoon, they come
 * back the next morning, and I close it off. A watch waiting on my silence is
 * cancelled by my replies; a watch waiting on theirs is cancelled by their
 * follow-up. That is what they are for — a corpus where every thread ends
 * unanswered cannot tell a watch that waits from one that fires on arrival,
 * because in such a corpus the two agree everywhere.
 *
 * A thread always leaves one end dangling: whoever wrote last is waiting on a
 * reply that never comes. Which end alternates, so the two waiting watches carry
 * a comparable share of the background rather than one carrying all of it.
 *
 * There are two dozen of these rather than two hundred, and the restraint is
 * deliberate. Every replay here judges with a probe that agrees with everything,
 * so a semantic watch fires on all the traffic its procedural filter admits.
 * Pile on background and the reference stops describing the scenario and starts
 * describing the volume: the invoice-and-receipt watch fired two hundred and
 * fifty-one times against a season of two hundred routine threads, once per
 * thread, which is a measurement of the probe. Distinguishing power comes from
 * varied scenarios, not from repeating one indistinguishable event.
 *
 * The subjects are ordinary working correspondence and deliberately dull. They
 * are the background against which the scenarios are supposed to stand out, and
 * anything more distinctive would give a semantic filter something to catch.
 */
const ROUTINE_SUBJECTS = [
  "Notes from the call",
  "Draft two, with the changes",
  "Photos from the site visit",
  "Reordered the sequence",
  "Numbers for the quarter",
  "Shipping dates",
  "Slides for Thursday",
  "Updated the running order",
  "One more revision",
  "Signed copy attached",
  "Colours look right now",
  "Moved the deadline out a week",
];
const ROUTINE_CAST = [ALICE, MAYA, DAVID];

let routineThread = 0;
for (let day = 27; day <= SEASON - 2; day += 3) {
  routineThread += 1;
  const from = ROUTINE_CAST[routineThread % ROUTINE_CAST.length];
  const title = ROUTINE_SUBJECTS[routineThread % ROUTINE_SUBJECTS.length];
  const threadId = `T-91${String(routineThread).padStart(3, "0")}`;
  // Every other thread runs one message shorter, so half end waiting on me and
  // half waiting on them.
  const messages = routineThread % 2 === 0 ? 4 : 3;
  const script = [
    [day, 9, from, [SELF], title],
    [day, 14, SELF, [from], `Re: ${title}`],
    [day + 1, 8, from, [SELF], `Re: ${title} — one more thing`],
    [day + 1, 12, SELF, [from], `Re: ${title} — done`],
  ].slice(0, messages);
  for (const [on, hour, sender, recipients, subject] of script) {
    email({ at: at(on, hour), threadId, from: sender, to: recipients, title: subject });
  }
}

// ---------------------------------------------------------------------------
// Cognitive state
// ---------------------------------------------------------------------------

const TAX_LOOP = "loop_8f31c2a7";
const taxOpen = {
  state: "open",
  title: "File the self-assessment return",
  deadline: at(31, 23, 59),
  actors: [SELF],
  involved: [],
  blockedBy: [],
};

emit("loop.event", at(15, 9), at(15, 9), {
  op: "updated",
  loopId: TAX_LOOP,
  before: { ...taxOpen, deadline: at(28, 23, 59) },
  after: taxOpen,
});
emit("loop.event", at(18, 16, 30), at(18, 16, 30), {
  op: "resolved",
  loopId: TAX_LOOP,
  before: taxOpen,
  after: { ...taxOpen, state: "done" },
});

/**
 * The return is amended twice, so the loop reopens and closes again.
 *
 * What separates "became closed" from "changed" is the plain `updated` above,
 * which precedes the first resolution: a watch firing on any state change fires
 * there, a day earlier and on a loop that is still open. These later cycles do
 * not add to that, because the watch reading this loop is `once_ever` and stops
 * at the first close — they are here so the season's loop events do not all sit
 * in its first fortnight, and so the directory describes a life with more than
 * one thing outstanding.
 */
const taxDone = { ...taxOpen, state: "done" };
[
  [44, 10, "updated", taxDone, taxOpen],
  [57, 15, "resolved", taxOpen, taxDone],
  [72, 9, "updated", taxDone, taxOpen],
  [83, 14, "resolved", taxOpen, taxDone],
].forEach(([day, hour, op, before, after]) => {
  emit("loop.event", at(day, hour), at(day, hour), { op, loopId: TAX_LOOP, before, after });
});

/**
 * More loops, closing in three different ways.
 *
 * One is dismissed rather than done — a watch reading only for `done` misses it,
 * and that is the distinction the request draws in so many words. One is
 * reopened after being closed, so a watch that fires on any state change fires
 * twice where the right one fires once. And one is updated repeatedly and never
 * closed at all.
 */
function loop(loopId, title, open, updates) {
  const opened = {
    state: "open",
    title,
    deadline: open.deadline,
    actors: [SELF],
    involved: [],
    blockedBy: [],
  };
  let current = opened;
  for (const [day, hour, op, state] of updates) {
    const after = { ...current, state };
    emit("loop.event", at(day, hour), at(day, hour), {
      op,
      loopId,
      before: current,
      after,
    });
    current = after;
  }
}

loop("loop_2c19d5e8", "Return the faulty monitor", { deadline: at(50, 23, 59) }, [
  [37, 11, "updated", "open"],
  [46, 15, "resolved", "dismissed"],
]);

loop("loop_a47f0b31", "Renew the studio insurance", { deadline: at(70, 23, 59) }, [
  [54, 10, "updated", "open"],
  [58, 17, "resolved", "done"],
  [64, 9, "updated", "open"],
  [71, 16, "resolved", "done"],
]);

loop("loop_e83b6d24", "Find a replacement supplier", { deadline: at(88, 23, 59) }, [
  [60, 12, "updated", "open"],
  [69, 12, "updated", "open"],
  [77, 12, "updated", "open"],
]);

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

const analytics = {
  health_vitals: [],
  health_sleep: [],
  plaid_transactions: [],
  google_calendar_events: [],
  google_calendar_attendees: [],
  people: [],
  apple_call_log: [],
};

/**
 * Resting heart rate, across the season.
 *
 * Most days sit in the fifties and sixties. Three spells run above seventy: two
 * weeks of March, a fortnight spanning April, and another in May.
 *
 * The ordinary days are what make the elevated ones mean anything. When every
 * reading in the journal is above every threshold a watch might plausibly pick,
 * a watch asking for 70 selects exactly the days a watch asking for 40 does and
 * the two replay identically — so the corpus cannot tell a correct threshold
 * from a wrong one, and a compilation that invents a number scores as though it
 * had read the request. Readings on both sides of the line are the only fix.
 */
const HR_ELEVATED = [
  [8, 21],
  [40, 52],
  [63, 76],
];

function restingHeartRate(day) {
  const elevated = HR_ELEVATED.some(([from, to]) => day >= from && day <= to);
  return elevated ? 71 + ((day * 7) % 5) : 56 + ((day * 3) % 9);
}

/**
 * A second and third metric in the same tall table.
 *
 * `health_vitals` is one row per reading with a `metric_slug`, so a watch about
 * resting heart rate has to say which slug it means. When the table holds
 * nothing else, it does not have to: a query that forgets the filter averages
 * one metric with itself and gets the same answer. Steps daily and weight
 * weekly, on numbers unrelated to the heart-rate spells, make the filter
 * load-bearing.
 */
for (let day = 1; day <= SEASON; day++) {
  const start = at(day, 23);
  const row = {
    metric_slug: "step_count",
    value: 4200 + ((day * 613) % 7400),
    unit: "count",
    start_time: start,
    end_time: at(day, 23, 59),
  };
  analytics.health_vitals.push(row);
  analyticsRow({
    at: start,
    table: "health_vitals",
    sourceId: "apple-health",
    pk: { metric_slug: "step_count", start_time: start },
    row,
  });
}

for (let day = 2; day <= SEASON; day += 7) {
  const start = at(day, 7);
  const row = {
    metric_slug: "body_mass",
    value: 74.5 + ((day * 3) % 17) / 10,
    unit: "kg",
    start_time: start,
    end_time: at(day, 7, 1),
  };
  analytics.health_vitals.push(row);
  analyticsRow({
    at: start,
    table: "health_vitals",
    sourceId: "apple-health",
    pk: { metric_slug: "body_mass", start_time: start },
    row,
  });
}

for (let day = 1; day <= SEASON; day++) {
  const start = at(day, 4);
  const value = restingHeartRate(day);
  const row = {
    metric_slug: "resting_hr",
    value,
    unit: "bpm",
    start_time: start,
    end_time: at(day, 5),
  };
  analytics.health_vitals.push(row);
  analyticsRow({
    at: start,
    table: "health_vitals",
    sourceId: "apple-health",
    pk: { metric_slug: "resting_hr", start_time: start },
    row,
  });
}

/**
 * Sleep, with two bad spells in a season of good nights.
 *
 * The baseline nights are long and deep; the bad ones are neither. There is no
 * duration or quality column — both are summed from stage intervals, which is
 * exactly what the watch does.
 *
 * Two spells rather than one, and both ending: a watch comparing a recent window
 * against a baseline needs a baseline to compare against, and one that degrades
 * and never recovers gives it none after the first firing.
 */
const SLEEP_POOR = [
  [11, 24],
  [48, 58],
  [74, 86],
];

for (let day = 1; day <= SEASON; day++) {
  const recent = SLEEP_POOR.some(([from, to]) => day >= from && day <= to);
  const stages = recent
    ? [
        ["asleepCore", 0, 210],
        ["asleepDeep", 210, 45],
        ["asleepREM", 255, 40],
        ["awake", 295, 25],
      ]
    : [
        ["asleepCore", 0, 250],
        ["asleepDeep", 250, 80],
        ["asleepREM", 330, 75],
        ["awake", 405, 10],
      ];
  for (const [stage, offset, minutes] of stages) {
    const start = at(day, 0, offset);
    const row = { stage, start_time: start, end_time: at(day, 0, offset + minutes) };
    analytics.health_sleep.push(row);
    analyticsRow({
      at: start,
      table: "health_sleep",
      sourceId: "apple-health",
      pk: { stage, start_time: start },
      row,
    });
  }
}

/** A card transaction, mirrored into both the journal and the row fixture. */
function transaction({ id, day, amount, category, merchant, pending = false }) {
  const row = {
    id,
    account_id: "acct-current",
    date: at(day).slice(0, 10),
    amount,
    currency: "GBP",
    merchant_name: merchant,
    category,
    pending,
  };
  const existing = analytics.plaid_transactions.findIndex((r) => r.id === id);
  if (existing >= 0) analytics.plaid_transactions[existing] = row;
  else analytics.plaid_transactions.push(row);
  return row;
}

const RESTAURANTS = "Food and Drink > Restaurants";

analyticsRow({
  at: at(3, 20),
  table: "plaid_transactions",
  sourceId: "plaid",
  pk: { id: "txn-0001" },
  row: transaction({
    id: "txn-0001",
    day: 3,
    amount: 120.0,
    category: RESTAURANTS,
    merchant: "Riverside Kitchen",
  }),
});

// Lands pending…
analyticsRow({
  at: at(8, 19, 30),
  table: "plaid_transactions",
  sourceId: "plaid",
  pk: { id: "txn-0002" },
  row: transaction({
    id: "txn-0002",
    day: 8,
    amount: 180.0,
    category: RESTAURANTS,
    merchant: "Stellar Sound Supper Club",
    pending: true,
  }),
});
// …and is revised in place when it posts. Same primary key, real change.
analyticsRow({
  at: at(9, 6),
  op: "updated",
  table: "plaid_transactions",
  sourceId: "plaid",
  pk: { id: "txn-0002" },
  row: transaction({
    id: "txn-0002",
    day: 8,
    amount: 185.4,
    category: RESTAURANTS,
    merchant: "Stellar Sound Supper Club",
  }),
});

analyticsRow({
  at: at(20, 21),
  table: "plaid_transactions",
  sourceId: "plaid",
  pk: { id: "txn-0003" },
  row: transaction({
    id: "txn-0003",
    day: 20,
    amount: 250.75,
    category: RESTAURANTS,
    merchant: "Harbour House",
  }),
});

/**
 * Restaurant spending through April and May.
 *
 * A monthly total is keyed by month, so three months of it are three separate
 * facts rather than one repeated — and the threshold is crossed on a different
 * day of each, which is what stops "fires in a month where the total is high"
 * from being indistinguishable from "fires on the twentieth".
 *
 * April crosses on the 11th of the month and May on the 24th; the running totals
 * are 130 / 285 / 520 / 610 and 95 / 260 / 340 / 505.
 */
[
  ["txn-0011", 33, 130.0, "Riverside Kitchen"],
  ["txn-0012", 37, 155.0, "Harbour House"],
  ["txn-0013", 42, 235.0, "Stellar Sound Supper Club"],
  ["txn-0014", 51, 90.0, "Riverside Kitchen"],
  ["txn-0015", 64, 95.0, "Harbour House"],
  ["txn-0016", 70, 165.0, "Riverside Kitchen"],
  ["txn-0017", 78, 80.0, "Stellar Sound Supper Club"],
  ["txn-0018", 85, 165.0, "Harbour House"],
].forEach(([id, day, amount, merchant]) => {
  analyticsRow({
    at: at(day, 20),
    table: "plaid_transactions",
    sourceId: "plaid",
    pk: { id },
    row: transaction({ id, day, amount, category: RESTAURANTS, merchant }),
  });
});

/**
 * Runs of large non-restaurant purchases, and one deliberate near-miss.
 *
 * Three runs put three payments over £200 inside a week. A fourth group does
 * not: its middle payment is under the threshold and its members are spread over
 * twelve days. A corpus of nothing but qualifying runs cannot tell a watch that
 * counts correctly from one that fires on any large payment at all.
 */
[
  ["txn-0101", 12, 240.0, "Studio Northstar"],
  ["txn-0102", 14, 310.5, "Meridian Outfitters"],
  ["txn-0103", 16, 205.0, "Harbour House"],
  ["txn-0104", 18, 420.0, "Meridian Outfitters"],
  ["txn-0105", 32, 260.0, "Studio Northstar"],
  ["txn-0106", 34, 280.0, "Meridian Outfitters"],
  ["txn-0107", 36, 230.0, "Harbour House"],
  // The near-miss.
  ["txn-0108", 46, 215.0, "Studio Northstar"],
  ["txn-0109", 49, 180.0, "Meridian Outfitters"],
  ["txn-0110", 58, 225.0, "Harbour House"],
  ["txn-0111", 74, 305.0, "Meridian Outfitters"],
  ["txn-0112", 76, 210.0, "Studio Northstar"],
  ["txn-0113", 79, 480.0, "Harbour House"],
].forEach(([id, day, amount, merchant]) => {
  analyticsRow({
    at: at(day, 13),
    table: "plaid_transactions",
    sourceId: "plaid",
    pk: { id },
    row: transaction({ id, day, amount, category: "Shops > General", merchant }),
  });
});

/**
 * Everyday spending: groceries, transport, coffee.
 *
 * All small, none in a restaurant category, and spread across every day of the
 * season. Without them a monthly restaurant total is the only spending in the
 * table, so a query that forgets the category filter produces the same number as
 * one that has it — and a compilation that never wrote the filter scores as
 * though it had.
 */
const EVERYDAY = [
  ["Groceries", "Food and Drink > Groceries", 18, 62],
  ["Transport", "Travel > Public Transport", 2, 9],
  ["Coffee", "Food and Drink > Coffee Shop", 3, 6],
];
let everydaySeq = 0;
for (let day = 1; day <= SEASON; day++) {
  for (const [merchant, category, base, spread] of EVERYDAY) {
    // Not every kind every day: a third of them are skipped, on a pattern that
    // depends on the day so the spacing is uneven rather than periodic.
    if ((day * 7 + base) % 3 === 0) continue;
    everydaySeq += 1;
    const id = `txn-9${String(everydaySeq).padStart(4, "0")}`;
    const amount = Math.round((base + ((day * 37) % spread)) * 100) / 100;
    analyticsRow({
      at: at(day, 8 + (everydaySeq % 9)),
      table: "plaid_transactions",
      sourceId: "plaid",
      pk: { id },
      row: transaction({ id, day, amount, category, merchant: `${merchant} Co` }),
    });
  }
}

/**
 * The diary.
 *
 * Three are with Priya, last spoken to in January 2025 — the "haven't talked to
 * in over a year" case. The others are with people seen this week, so an evening
 * tick that fires on any meeting at all is not the same watch as one that fires
 * on a stale contact, and the corpus can tell the two apart.
 */
const MEETINGS = [
  ["evt-20260325-catchup", "Catch-up with Priya Raman", 25, PRIYA],
  ["evt-20260402-review", "Quarterly review with Alice Nakamura", 35, ALICE],
  ["evt-20260419-handover", "Handover call with Priya Raman", 50, PRIYA],
  ["evt-20260430-planning", "Planning session with Maya Reeves", 61, MAYA],
  ["evt-20260515-reconnect", "Reconnect with Priya Raman", 76, PRIYA],
  ["evt-20260306-standup", "Weekly standup", 6, ALICE],
  ["evt-20260313-standup", "Weekly standup", 13, ALICE],
  ["evt-20260320-design", "Design review with Maya Reeves", 20, MAYA],
  ["evt-20260327-standup", "Weekly standup", 27, ALICE],
  ["evt-20260403-budget", "Budget walkthrough with David Lin", 34, DAVID],
  ["evt-20260410-standup", "Weekly standup", 41, ALICE],
  ["evt-20260417-design", "Design review with Maya Reeves", 48, MAYA],
  ["evt-20260424-standup", "Weekly standup", 55, ALICE],
  ["evt-20260501-budget", "Budget walkthrough with David Lin", 62, DAVID],
  ["evt-20260508-standup", "Weekly standup", 69, ALICE],
  ["evt-20260522-design", "Design review with Maya Reeves", 83, MAYA],
  ["evt-20260528-standup", "Weekly standup", 89, ALICE],
];

for (const [id, title, day, guest] of MEETINGS) {
  const event = {
    id,
    title,
    start_time: at(day, 10),
    end_time: at(day, 11),
    location: "42 Example Street",
    attendee_count: 2,
    response_status: "accepted",
  };
  analytics.google_calendar_events.push(event);
  // Invitations land the day before, which is when the evening tick reads them.
  analyticsRow({
    at: at(day - 1, 9),
    table: "google_calendar_events",
    sourceId: "google-calendar",
    pk: { id },
    row: event,
  });
  for (const person of [SELF, guest]) {
    const attendee = { event_id: id, person_id: person };
    analytics.google_calendar_attendees.push(attendee);
    analyticsRow({
      at: at(day - 1, 9),
      table: "google_calendar_attendees",
      sourceId: "google-calendar",
      pk: attendee,
      row: attendee,
    });
  }
}

/**
 * The system-owned people dimension. `last_seen` counts any document
 * referencing the person, calendar invites included — a coarse signal, which is
 * why the projection also carries an interaction score.
 */
/**
 * When the journal last mentioned each person, read off the journal itself.
 *
 * Computed rather than written down. A hand-written `last_seen` is a second
 * copy of something the events already say, and the two drift the moment the
 * season grows — leaving a correspondent who writes weekly recorded as last
 * seen months ago. A watch keyed on staleness then measures the drift instead
 * of the scenario.
 */
function lastSeen(personId) {
  let latest = null;
  for (const event of events) {
    if (event.kind !== "doc.event") continue;
    if (!event.payload.people?.some((p) => p.personId === personId)) continue;
    if (latest === null || event.occurredAt > latest) latest = event.occurredAt;
  }
  return latest;
}

analytics.people.push(
  {
    id: SELF,
    canonical_name: "Jordan Avery",
    is_self: true,
    last_seen: lastSeen(SELF),
    interaction_score: 1.0,
  },
  {
    id: ALICE,
    canonical_name: "Alice Nakamura",
    is_self: false,
    last_seen: lastSeen(ALICE),
    interaction_score: 0.82,
  },
  {
    id: NADIA,
    canonical_name: "Nadia Rowe",
    is_self: false,
    last_seen: lastSeen(NADIA),
    interaction_score: 0.64,
  },
  {
    id: MAYA,
    canonical_name: "Maya Reeves",
    is_self: false,
    last_seen: lastSeen(MAYA),
    interaction_score: 0.41,
  },
  {
    id: DAVID,
    canonical_name: "David Lin",
    is_self: false,
    last_seen: lastSeen(DAVID),
    interaction_score: 0.58,
  },
  {
    id: PRIYA,
    canonical_name: "Priya Raman",
    is_self: false,
    // She appears in the diary and in no document, so the journal has no
    // instant to offer: January 2025, over a year before any of her meetings.
    last_seen: new Date(Date.UTC(2025, 0, 14, 11)).toISOString(),
    interaction_score: 0.05,
  },
);

/**
 * Every call as a row, so a watch reading the log agrees with one reading the
 * document events.
 *
 * All of them, not only Nadia's. The table's `counterparty` is a raw string
 * rather than a person id, and it is the only thing a watch reading this table
 * can filter on — so a table holding one counterparty lets a watch that omits
 * the filter behave exactly like one that has it, which is the discrimination
 * the other calls were added to the journal for. Durations vary by call and are
 * otherwise arbitrary.
 */
const CALL_NAMES = {
  [NADIA]: "Mum",
  [ALICE]: "Alice Nakamura",
  [DAVID]: "David Lin",
  [MAYA]: "Maya Reeves",
};

[
  ...MUM_CALLS.map(([day, hour, minute, direction]) => ({
    day,
    hour,
    minute,
    direction,
    person: NADIA,
  })),
  ...OTHER_CALLS.map(([day, person], index) => ({
    day,
    hour: 12 + (index % 6),
    minute: 0,
    direction: index % 2 === 0 ? "outgoing" : "incoming",
    person,
  })),
]
  .sort((a, b) => Date.parse(at(a.day, a.hour, a.minute)) - Date.parse(at(b.day, b.hour, b.minute)))
  .forEach(({ day, hour, minute, direction, person }, index) => {
    analytics.apple_call_log.push({
      id: `call-${String(index + 1).padStart(4, "0")}`,
      counterparty: CALL_NAMES[person],
      direction,
      start_time: at(day, hour, minute),
      duration_seconds: 900 + ((day * 137) % 800),
    });
  });
for (const row of analytics.apple_call_log) {
  analyticsRow({
    at: row.start_time,
    table: "apple_call_log",
    sourceId: "apple-call-log",
    pk: { id: row.id },
    row,
  });
}

// ---------------------------------------------------------------------------
// Order, downtime, and output
// ---------------------------------------------------------------------------

// Processing order is arrival order. Semantic time may run backwards within it,
// and does — that is the backfill above.
events.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));

/**
 * Downtime. Nothing was observed between the 22nd and the 25th, so a deadline
 * that came due on the 24th — the call rhythm — comes due on the way back up.
 * Shifting the tail rather than inserting a marker is deliberate: an outage
 * leaves a gap in the journal, not an entry.
 *
 * The queued events arrive *at* the resume instant, a second apart, keeping
 * their order without stretching processing time across the days they waited.
 * Spreading them by the length of the outage would push them past events that
 * were observed normally afterwards, which is not what a backlog looks like.
 */
const OUTAGE_START = Date.parse(at(22, 12));
const RESUME = Date.parse(at(25, 6));
let queued = 0;
for (const event of events) {
  const observed = Date.parse(event.observedAt);
  if (observed > OUTAGE_START && observed < RESUME) {
    event.observedAt = new Date(RESUME + queued * 1000).toISOString();
    queued += 1;
  }
}
events.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));

const journal = events.map((event, i) => ({ seq: i + 1, ...event }));

writeFileSync(
  join(UNIVERSE, "journal.jsonl"),
  journal.map((e) => JSON.stringify(e)).join("\n") + "\n",
);

mkdirSync(join(UNIVERSE, "analytics"), { recursive: true });
for (const [table, rows] of Object.entries(analytics)) {
  writeFileSync(join(UNIVERSE, "analytics", `${table}.json`), JSON.stringify(rows, null, 2) + "\n");
}

process.stdout.write(
  `journal: ${journal.length} events\n` +
    Object.entries(analytics)
      .map(([t, r]) => `  ${t}: ${r.length} rows\n`)
      .join(""),
);
