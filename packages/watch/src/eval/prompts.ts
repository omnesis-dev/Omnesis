// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Requests this ontology cannot answer, and what a correct refusal must name.
 *
 * There were five. There are four: the identifier request — "tell me when an
 * email quotes reference XR-4471" — is answerable now, through a lexical recall
 * arm, and a prompt asserting that it must be refused would be testing the
 * model against a rule the system no longer holds.
 *
 * The vacancy is deliberately not backfilled. The obvious replacement is a
 * request whose only handle is an undistinctive term, which the validator does
 * reject — but a compiler can always dodge into a semantic arm instead, so such
 * a prompt would measure which arm the model happened to reach for rather than
 * whether it recognised an unanswerable request. The four that remain all turn
 * on data that is genuinely absent, which is a fact about the ontology and not
 * about the compiler's taste.
 *
 * A refusal class shrinking is the point of the arm, not an accounting problem.
 */
/**
 * Requests the corpus does not answer.
 *
 * The paired set — each corpus watch's own `nl_query` — measures whether the
 * compiler can rebuild something a person already wrote. This set measures
 * something the paired set structurally cannot: what happens when there is no
 * reference to converge on, and in particular whether the compiler knows when
 * to stop.
 *
 * **Refusal is scored, not tolerated.** Four of these describe things this
 * ontology genuinely cannot express, and each fails in a different way:
 *
 * - an identifier lookup, which an embedding provably cannot do
 * - data no source in this ontology produces
 * - a field the substrate has a table for but does not retain per row
 * - a state the loop model does not have
 *
 * A compiler that answers them anyway has produced a watch that validates and
 * watches the wrong thing, which is the failure this whole contract exists to
 * prevent — worse than a refusal, and invisible to the validator.
 *
 * The rest should compile. They are deliberately spread across the shapes the
 * DSL offers rather than clustered on the easy one, so a compiler that only
 * knows how to write a document filter scores badly rather than averagely.
 */

type ExpectedOutcome = "compiles" | "refuses";

export interface UnseenPrompt {
  readonly id: string;
  readonly query: string;
  readonly expect: ExpectedOutcome;
  /** What makes this the right answer. Printed beside a failure. */
  readonly because: string;
  /**
   * For a request that must be refused: what a refusal has to name to count.
   *
   * A refusal is only worth anything if it identifies the thing that is
   * missing. "I cannot do that" and "the attendee table holds only the event
   * and the person, so another invitee's answer is not retained" are both
   * refusals, and only one of them tells anybody what to build next. Each
   * group below is a set of alternatives — the refusal must mention at least
   * one word from each group, so a reason can use whichever vocabulary it
   * likes and still have to be about the right absence.
   */
  readonly refusalMustMention?: readonly (readonly string[])[];
  /**
   * Worked examples to keep out of the prompt for this request.
   *
   * Hold-out is not only a paired-set concern. A corpus watch whose comment
   * names the very absence a must-refuse request turns on hands the answer
   * over, and the refusal it earns measures reading rather than reasoning.
   */
  readonly withholdExamples?: readonly string[];
}

export const UNSEEN_PROMPTS: readonly UnseenPrompt[] = [
  // --- must refuse -------------------------------------------------------
  {
    id: "absent-source",
    query: "Let me know when I finish a run longer than ten kilometres.",
    expect: "refuses",
    because: "no source in this ontology produces workouts or distances",
    refusalMustMention: [
      ["no source", "not a source", "no such source", "does not produce", "nothing produces"],
      ["workout", "distance", "fitness", "exercise", "activity", "health_vitals", "metric_slug"],
    ],
  },
  {
    id: "unretained-field",
    query: "Tell me when Alice declines a calendar invitation I sent her.",
    expect: "refuses",
    withholdExamples: ["alice-declines-dinner"],
    because:
      "the attendee edge table holds only event and person; the response status on the events table is the user's own, so another attendee's answer is not retained anywhere",
    refusalMustMention: [
      ["attendee", "response_status", "responsestatus", "rsvp"],
      [
        "not retained",
        "the user's own",
        "own rsvp",
        "own response",
        "not recorded",
        "not stored",
        "no column",
        "not exposed",
      ],
    ],
  },
  {
    id: "absent-loop-state",
    query: "Ping me when one of my open loops becomes blocked on someone else.",
    expect: "refuses",
    because:
      "the loop states are open, snoozed, done and dismissed — there is no blocked state — and blockedBy holds prerequisite loop ids rather than people, so 'blocked on someone' has no home in the model",
    refusalMustMention: [
      ["open", "snoozed", "dismissed", "blockedby", "prerequisite"],
      ["no such state", "not a state", "no blocked state", "does not have", "not one of", "only"],
    ],
  },
  {
    id: "others-have-not-accepted",
    query: "Tell me the morning of a meeting if none of the other invitees has accepted yet.",
    expect: "refuses",
    withholdExamples: ["alice-declines-dinner"],
    because:
      "the attendee edge table holds only event_id and person_id, and response_status on the events table is the user's own answer. Who was invited is retained; what they said is not. This one is worth having beside the RSVP refusal because it looks answerable — the join exists, and only the column it needs is missing",
    refusalMustMention: [
      ["attendee", "response_status", "responsestatus", "rsvp"],
      [
        "not retained",
        "the user's own",
        "own rsvp",
        "own response",
        "no column",
        "not stored",
        "not recorded",
        "not exposed",
      ],
    ],
  },

  // --- should compile ----------------------------------------------------
  {
    id: "daily-spend-cap",
    query: "Tell me if I spend more than £150 in a single day on my card.",
    expect: "compiles",
    because: "an analytics-row trip-wire keyed by day, aggregating plaid_transactions",
  },
  {
    id: "long-meeting-tomorrow",
    query: "The evening before, tell me if tomorrow has a meeting longer than two hours.",
    expect: "compiles",
    because: "a recurring tick into a SQL node over google_calendar_events",
  },
  {
    id: "call-from-person",
    query: "Let me know on any day I get an incoming call I did not make myself.",
    expect: "compiles",
    because:
      "apple_call_log declares direction with the closed values incoming and outgoing, so an inbound day is expressible. Naming a person is deliberately avoided: the table's counterparty is a raw string rather than an identity, and the call-log document declares only participant — so 'a call from David Lin who I missed' would need a missed flag the source does not carry",
  },
  {
    id: "drive-file-shared",
    query: "Tell me when a document lands in my drive that I did not create.",
    expect: "compiles",
    because: "a google-drive document event with an inbound person predicate",
  },
  {
    id: "whatsapp-then-email",
    query: "If Alice messages me on WhatsApp and then emails me within two days, tell me.",
    expect: "compiles",
    because:
      "a sequence gate across two document sources, keyed on the person. Alice is named rather than left as 'someone' for a reason the ontology enforces: a WhatsApp chat is identified by its chatJid and an email by its sender's person id, so nothing joins the two halves unless the person is bound at compile time",
  },
  {
    id: "sleep-short-three-nights",
    query: "Warn me if I sleep less than six hours three nights running.",
    expect: "compiles",
    because: "a tick into a SQL node over health_sleep with a rising edge",
  },
  {
    id: "whatsapp-chat-goes-quiet",
    query: "Tell me if a WhatsApp chat I was using goes silent for three days.",
    expect: "compiles",
    because:
      "a wait keyed on the chat, re-armed by each day's document and firing when three days pass with none. Two things the request deliberately does not ask for, because the source cannot answer either: 'and I have not replied' needs a sender role WhatsApp does not declare, and 'busy' needs a message count its day-aggregate documents do not carry",
  },
  {
    id: "hrv-dropping",
    query: "Let me know if my heart-rate variability has been dropping for a fortnight.",
    expect: "compiles",
    because: "health_vitals filtered on the hrv metric slug, evaluated on a tick",
  },
  {
    id: "loop-deadline-near",
    query: "Once a day, tell me about any loop of mine that is still open and past its deadline.",
    expect: "compiles",
    because:
      "a loop event carries its deadline as $e.after.deadline, which a SQL node can compare against the bound $today. Deliberately not 'three days before': a wait's duration is a literal the validator parses, not an expression, so a countdown to a value read off the event has no expression to write it in",
  },
  {
    id: "big-refund",
    query: "Tell me when a refund over £100 lands on my card.",
    expect: "compiles",
    because: "a plaid_transactions row predicate on the sign and size of the amount",
  },
  {
    id: "meeting-i-have-not-answered",
    query: "Tell me the morning of a meeting I still have not answered.",
    expect: "compiles",
    because:
      "google_calendar_events.response_status is the user's own RSVP and carries needsAction, so a tick into SQL over it answers this. The version about other attendees is in the refusal set, because that is the answer their status does not exist",
  },
  {
    id: "quiet-week-with-person",
    query: "If I have not spoken to Nadia Rowe in three weeks, say so.",
    expect: "compiles",
    because: "the people projection carries last_seen, and Nadia Rowe is in the directory",
  },
  {
    id: "calendar-and-mail-conflict",
    query: "Warn me when I get an email about a meeting that is already in my calendar today.",
    expect: "compiles",
    because: "a document event armed against a SQL lookup over google_calendar_events",
  },
];
