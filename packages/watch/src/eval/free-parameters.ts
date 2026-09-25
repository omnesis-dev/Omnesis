// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What each request leaves open, and how far open.
 *
 * A watch binds numbers its request may or may not have named. "I haven't
 * replied for 3 days" names the wait exactly; "tell me if that rhythm stops"
 * names nothing, and any of eight, nine or twelve days is a reading of it. Both
 * kinds are in every corpus watch, and until they are told apart two very
 * different things score the same: a compilation that misread the request, and
 * one that read it correctly and made a different judgement call where the
 * request was silent.
 *
 * So every bound parameter is one of two things, and this file is where a watch
 * says which:
 *
 * - **Named** — the request states it, and a compilation that chose otherwise
 *   misread the request. Nothing is declared here; the reconstructibility test
 *   finds the number in the prose.
 * - **Free** — the request is silent, and the watch's value is one defensible
 *   choice among several. Declared below with the range that is defensible.
 *
 * The declaration serves two readers and has to satisfy both, which is what
 * keeps it honest. `reconstructible.test.ts` fails if a parameter is neither
 * named nor declared — so nothing can be quietly bound. And it fails if a
 * parameter is declared free while the request names it — so nothing can be
 * quietly excused. The scorer then uses the same table to decide whether a
 * divergence is `defensible` or `structural`.
 */

/** A parameter a request does not pin down, and the range that reads it fairly. */
export interface FreeParameter {
  /** The node it sits on, and the field. `weekly_cap.min_interval`. */
  readonly at: string;
  /**
   * What a defensible reading may choose.
   *
   * For a duration, milliseconds. For an hour-of-day, the hour. For a count,
   * the count. Inclusive at both ends.
   */
  readonly from: number;
  readonly to: number;
  /** Why the request leaves it open, in the request's own words. */
  readonly because: string;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * Free parameters per watch.
 *
 * A watch absent from this table declares that its request names everything it
 * binds — which the reconstructibility test then has to agree with.
 */
export const FREE_PARAMETERS: Readonly<Record<string, readonly FreeParameter[]>> = {
  "elevated-resting-hr-week": [
    {
      at: "daily_tick.recurring.hour",
      from: 0,
      to: 23,
      because: "'stays above 70 for a whole week' says nothing about when to look",
    },
    {
      at: "weekly_cap.min_interval",
      from: 3 * DAY,
      to: 30 * DAY,
      because:
        "the request asks to be warned, not to be warned at a particular rate; the seven days here echo the query's window rather than anything asked for",
    },
  ],
  "invoice-and-receipt-both-arrived": [
    {
      at: "both_sides.deadline",
      from: 7 * DAY,
      to: 90 * DAY,
      because: "'for the same job' bounds nothing; a job's paperwork can straddle weeks",
    },
  ],
  "major-life-turning-point": [
    {
      at: "weekly_tick.recurring.hour",
      from: 0,
      to: 23,
      because: "the request names no cadence at all, let alone an hour",
    },
    {
      at: "turning_point_review.deadline",
      from: HOUR,
      to: 24 * HOUR,
      because: "how long one investigation may run is an operational choice, not a request",
    },
    {
      at: "monthly_cap.min_interval",
      from: 7 * DAY,
      to: 90 * DAY,
      because: "'wake my agent when something happens' asks for no rate limit; one is prudence",
    },
  ],
  "meeting-with-lost-touch": [
    {
      at: "evening_tick.recurring.hour",
      from: 16,
      to: 22,
      because: "'the evening before' names an evening, not an hour",
    },
  ],
  "mum-call-rhythm-stopped": [
    {
      at: "rhythm_broken.duration",
      from: 8 * DAY,
      to: 21 * DAY,
      because:
        "'we talk roughly every week — tell me if that rhythm stops' asks for a gap longer than the rhythm, and says no more",
    },
  ],
  "same-topic-across-two-channels": [
    {
      at: "weekly_horizon.recurring.hour",
      from: 0,
      to: 23,
      because: "the horizon tick is scaffolding; the request never mentions it",
    },
  ],
  "sleep-materially-worse": [
    {
      at: "daily_tick.recurring.hour",
      from: 0,
      to: 23,
      because: "'over the past two weeks' names the window, not the hour it is checked",
    },
    {
      at: "materiality_judge.deadline",
      from: HOUR,
      to: 24 * HOUR,
      because: "how long one judgement may take is operational",
    },
    {
      at: "materiality_judge.max_live_instances",
      from: 1,
      to: 4,
      because: "a ceiling on concurrent judgements is prudence, not a request",
    },
    {
      at: "fortnight_cap.min_interval",
      from: 3 * DAY,
      to: 60 * DAY,
      because:
        "'over the past two weeks' names the window the query looks back over; how often to be told is a separate choice the request never makes",
    },
  ],
};

/**
 * A rate limiter that exists as prudence rather than because the request asked.
 *
 * `FREE_PARAMETERS` already says of every one of these that the request names
 * no rate — "asks for no rate limit; one is prudence". That declaration makes
 * any value in the range defensible, and stops one step short: a compilation
 * that fitted no limiter at all is still scored as a misreading, even though
 * the request it was given asks for a limit exactly as much as it asks for a
 * seven-day one, which is to say not at all.
 *
 * So a watch may also declare that the *presence* of the bound is its own
 * choice. The claim is checkable and is checked: the slot has to exist on the
 * reference, and removing it has to change how the reference behaves — a
 * declaration over a bound that does nothing would be latitude bought for free.
 * And the request must not name a rate, which is the same guard
 * `reconstructible.test.ts` applies to the values.
 *
 * This is not a blanket amnesty for missing nodes. It names one slot on one
 * watch, and the divergence still has to *disappear* when the reference is
 * rebuilt without it — a compilation that dropped the limiter and also read the
 * wrong table is structural, as before.
 */
export interface CadenceLatitude {
  /** The role of the bound, as `<node type>|<field>`. */
  readonly slot: string;
  /** Why the request leaves the rate open, in the request's own words. */
  readonly because: string;
}

export const CADENCE_LATITUDES: Readonly<Record<string, CadenceLatitude>> = {
  "major-life-turning-point": {
    slot: "stateful.cooldown|min_interval",
    because:
      "'wake my agent when something happens that I'd consider a major turning point' asks for no rate limit at all; one is prudence",
  },
};

/**
 * Two watches carry the same limiter and are deliberately absent above.
 *
 * `elevated-resting-hr-week` and `sleep-materially-worse` each hold a
 * `stateful.cooldown` whose request names no rate either — but on this journal
 * the limiter never binds: strip it from the reference and the watch fires the
 * same three times, because the condition it guards comes true further apart
 * than the guard is wide. A compilation that omits an inert bound and is
 * otherwise right already scores as an exact match, so declaring latitude for
 * it would buy nothing and could only ever excuse a divergence caused by
 * something else. `cadence-latitude.test.ts` measures this and fails if it
 * stops being true — if the corpus grows a case where the limiter bites, the
 * declaration becomes load-bearing and has to be made deliberately.
 */

/** The cadence latitude a watch declares for a slot, or null. */
export function cadenceLatitudeFor(watch: string, slot: string): CadenceLatitude | null {
  const declared = CADENCE_LATITUDES[watch];
  return declared !== undefined && declared.slot === slot ? declared : null;
}

/** The declared range for a parameter, or null when the request names it. */
export function toleranceFor(watch: string, at: string): FreeParameter | null {
  return FREE_PARAMETERS[watch]?.find((p) => p.at === at) ?? null;
}

/**
 * The ways a comparison may be lenient — one per thing a request leaves open
 * about *how a firing is described*, as opposed to what it is worth.
 *
 * A free parameter above is a number the request did not pin down. These are
 * the same idea one level out: the request did not pin down how the answer
 * should be phrased, either. Both are latitude, and until this file listed the
 * second kind it was granted silently inside the comparison, where nothing
 * could count it.
 */
export type LatitudeRule = "extra-facts" | "numeric-precision" | "node-names" | "key-vocabulary";

export interface Latitude {
  readonly rule: LatitudeRule;
  /** For `numeric-precision`: the decimal places both sides are read at. */
  readonly places?: number;
  /** Why the request leaves it open, in the request's own words. */
  readonly because: string;
}

/**
 * What each watch's request leaves open about the shape of its answer.
 *
 * Declared per watch rather than assumed globally, because the claim is about a
 * particular request and has to be checkable against it. `latitude.test.ts`
 * holds each declaration to the watch's structure — `node-names` may only be
 * declared by a watch whose sink actually reads `$fired_by`, and must be
 * declared by one that does — so neither an unearned grant nor a silent
 * reliance can survive.
 *
 * `constants` is deliberately absent. No corpus reference writes a literal into
 * its payload, so nothing here is excused by dropping them; that rule exists to
 * stop a *compilation* covering the reference with values it never computed,
 * which is a restriction rather than a latitude.
 */
export const LATITUDES: Readonly<Record<string, readonly Latitude[]>> = {
  "alice-decided-to-leave": [
    {
      rule: "extra-facts",
      because:
        "'tell me if it looks like Alice has decided to leave her job' asks for a verdict and names nothing the alert must carry",
    },
    {
      rule: "key-vocabulary",
      because:
        "'Alice has decided to leave her job' is about one named person, so a key over her separates nothing",
    },
  ],
  "alice-declines-dinner": [
    {
      rule: "extra-facts",
      because:
        "'alert me when Alice tells me she's not coming' names the occasion, not the contents of the alert",
    },
    {
      rule: "node-names",
      because:
        "'whether by email or by WhatsApp' scopes where to look; it does not ask the alert to say which of the two it was, and $fired_by answers that with a node name this watch chose for itself",
    },
    {
      rule: "key-vocabulary",
      because:
        "'Alice tells me she's not coming to the dinner' is one person and one dinner; a key separates nothing",
    },
  ],
  "elevated-resting-hr-week": [
    {
      rule: "extra-facts",
      because:
        "'warn me if my resting heart rate stays above 70 for a whole week' asks for a warning and names no figure to quote back",
    },
    {
      rule: "numeric-precision",
      places: 1,
      because:
        "'stays above 70' names a threshold, not a format; an average reported to more places is the same average",
    },
    {
      rule: "key-vocabulary",
      because:
        "'my resting heart rate' is one series; there is no dimension to open separate instances over",
    },
  ],
  "important-email-unanswered": [
    {
      rule: "extra-facts",
      because:
        "'tell me when someone sends me an email that looks really important' names no fields for the telling",
    },
  ],
  "invoice-and-receipt-both-arrived": [
    {
      rule: "extra-facts",
      because:
        "'tell me when both an invoice and its receipt have arrived' names the pair, not what to report about it",
    },
  ],
  "large-card-spending-streak": [
    {
      rule: "extra-facts",
      because:
        "'let me know if I make three payments over £200 in a week' names the pattern, not the notice",
    },
    {
      rule: "numeric-precision",
      places: 1,
      because:
        "'three payments over £200 in a week' names the threshold; how many places an amount is echoed at, it does not",
    },
    {
      rule: "key-vocabulary",
      because:
        "'I make three payments' counts across one account and names no dimension to hold apart",
    },
  ],
  "major-life-turning-point": [
    {
      rule: "extra-facts",
      because:
        "'wake my agent when something happens that I'd consider a major turning point' says nothing about what the waking should carry",
    },
    {
      rule: "key-vocabulary",
      because:
        "'a major turning point in my life' is about one life and names no dimension to split on",
    },
  ],
  "maya-conversation-lapsed": [
    {
      rule: "extra-facts",
      because: "'tell me if we go quiet for a fortnight' names the silence, not the report",
    },
    {
      rule: "key-vocabulary",
      because:
        "'Maya and I message each other often' is one named person; keying on her separates nothing",
    },
  ],
  "meeting-with-lost-touch": [
    {
      rule: "extra-facts",
      because:
        "'remind me if I have a meeting tomorrow with someone I haven't talked to in over a year' names the meeting and the person, and nothing further",
    },
    {
      rule: "key-vocabulary",
      because: "'the evening before' is one reminder about tomorrow, not one per meeting",
    },
  ],
  "mum-call-rhythm-stopped": [
    {
      rule: "extra-facts",
      because: "'tell me if that rhythm stops' asks to be told, and does not say what to be told",
    },
    {
      rule: "key-vocabulary",
      because:
        "'my mum and I talk roughly every week' is one person's rhythm; there is nothing to hold apart",
    },
  ],
  "order-problem-by-number": [
    {
      rule: "extra-facts",
      because:
        "'tell me if there's a problem or a delay with order XR-4471' names the occasion and says nothing about what the telling should carry",
    },
    {
      rule: "key-vocabulary",
      because:
        "'order XR-4471' is one named order; there is no dimension to hold separate instances over",
    },
  ],
  "proposal-no-reply-5bd": [
    {
      rule: "extra-facts",
      because: "'alert me' names no contents for the alert",
    },
  ],
  "quote-accepted-then-invoiced": [
    {
      rule: "extra-facts",
      because:
        "'tell me when a quote I sent is accepted and the invoice follows' names the sequence, not the summary",
    },
  ],
  "restaurant-budget-500": [
    {
      rule: "extra-facts",
      because:
        "'let me know when I've spent more than £500 on restaurants' names the threshold, not the statement",
    },
    {
      rule: "numeric-precision",
      places: 1,
      because:
        "'more than £500 on restaurants' names the threshold; the places a running total is quoted at, it does not",
    },
  ],
  "same-topic-across-two-channels": [
    {
      rule: "extra-facts",
      because:
        "'tell me when Alice raises her house move with me on two different channels' names the occasion, not the notice",
    },
    {
      rule: "node-names",
      because:
        "'on two different channels' is what has to happen; naming which channel spoke first is $fired_by answering with this watch's own node name",
    },
    {
      rule: "key-vocabulary",
      because:
        "'Alice raises her house move with me' is one subject and one person; there is no dimension to hold apart",
    },
  ],
  "sleep-materially-worse": [
    {
      rule: "extra-facts",
      because:
        "'tell me if my sleep has been getting materially worse' asks for a judgement and names nothing to accompany it",
    },
    {
      rule: "key-vocabulary",
      because:
        "'my sleep' is one person's, so there is no dimension for an instance key to hold apart",
    },
  ],
  "tax-loop-closed": [
    {
      rule: "extra-facts",
      because: "'ping me when my tax-return open loop gets closed' names one loop and no contents",
    },
    {
      rule: "key-vocabulary",
      because:
        "'my tax-return open loop' is one named loop, so a key over it would separate nothing",
    },
  ],
  "trip-vs-passport-expiry": [
    {
      rule: "extra-facts",
      because:
        "'warn me if I book international travel departing within 6 months of my passport expiring' names the condition, not the warning",
    },
    {
      rule: "key-vocabulary",
      because: "'my passport expiring' is one passport; there is nothing for a key to separate",
    },
  ],
};

/** Every latitude this watch's request grants, by rule. */
export function latitudeFor(watch: string, rule: LatitudeRule): Latitude | null {
  return LATITUDES[watch]?.find((l) => l.rule === rule) ?? null;
}

/** Every rule this watch declares. */
export function latitudesOf(watch: string): readonly Latitude[] {
  return LATITUDES[watch] ?? [];
}
