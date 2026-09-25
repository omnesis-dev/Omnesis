// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * How often a request expects to be spoken to.
 *
 * The measured failure taxonomy says the compiler writes the right graph and
 * drops the parts that make a watch quiet: five attempts omitted a cooldown's
 * `min_interval` and fired thirteen times where the reference fires three; four
 * omitted a recurring schedule entirely; and on one request it failed the other
 * way, adding a bound that suppressed the only firing. Both directions are the
 * same gap — no calibration for how often a watch should be allowed to speak.
 *
 * A reach count cannot close it. "This would reach a model 40 times" is a cost,
 * and a compiler with no sense of what the request wanted has nothing to compare
 * it against. What it can be given is the request's own cadence: "warn me"
 * expects rarity, "every time" expects one per occurrence, "roughly every week"
 * names a rhythm outright. Read that from the prose and the backtest can say
 * something a model can act on — *this speaks daily and the request implies
 * monthly* — rather than a number with no scale.
 *
 * Deliberately coarse. Three bands, matched on phrases people actually write,
 * and an honest `null` when the request says nothing either way. A guess dressed
 * as a measurement would produce revision advice that is confidently wrong, and
 * the revision pass gets one turn.
 */

/** What the request implies about how often it wants to hear. */
export type Cadence = "per-occurrence" | "periodic" | "exceptional";

export interface Band {
  readonly cadence: Cadence;
  /** Phrases that name it, matched on word boundaries after folding. */
  readonly phrases: readonly string[];
  /** The most a watch of this kind should reasonably fire, per day. */
  readonly firingsPerDay: number;
}

/**
 * The bands, loosest first so a request naming both reads as the looser one.
 *
 * "Tell me every time an invoice arrives" is per-occurrence even though "tell
 * me" alone would read as exceptional: the explicit phrase wins over the mood.
 *
 * The phrases name *how often*, never *when*. "The evening before" sounds like
 * a rhythm and is not one — it is an offset from something else, and a request
 * built on it fires as often as that something happens, which may be never or
 * may be daily. A phrase that cannot answer "how many times a week?" on its own
 * does not belong here; guessing from it produces revision advice that is
 * confidently wrong, and the revision pass gets one turn.
 */
const BANDS: readonly Band[] = [
  {
    cadence: "per-occurrence",
    phrases: ["every time", "each time", "whenever", "every single", "each and every", "any time"],
    firingsPerDay: 5,
  },
  {
    cadence: "periodic",
    phrases: [
      "every week",
      "every day",
      "every month",
      "weekly",
      "daily",
      "monthly",
      "each week",
      "each day",
      "each month",
      "every morning",
      "every evening",
    ],
    firingsPerDay: 1,
  },
  {
    cadence: "exceptional",
    phrases: [
      "warn me",
      "alert me",
      "let me know if",
      "tell me if",
      "ping me",
      "remind me if",
      "notify me if",
    ],
    firingsPerDay: 0.2,
  },
];

/**
 * The cadence a request names, or null when it names none.
 *
 * The caller uses this to replace the fixed firing cap, not to add a second
 * one beside it. A band that merely sat alongside the default would be inert
 * where it agrees with it and harmful where it is looser: a request asking to
 * hear about every occurrence would be told to fire less often than it asked,
 * while the honest "this is reporting a condition rather than an exception"
 * went unsaid.
 */
export function impliedCadence(request: string): Band | null {
  const text = ` ${request
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
  return BANDS.find((band) => band.phrases.some((phrase) => text.includes(` ${phrase} `))) ?? null;
}

/**
 * What to say when a plan speaks at a different rate than its request asked for.
 *
 * Phrased as an observation with both numbers in it, because the compiler is
 * being asked to reconsider rather than told what to write: a request really can
 * be about something that happens every day, and the backtest cannot tell that
 * from a missing cooldown. What it can do is put the two rates side by side.
 */
export function cadenceConcern(request: string, firings: number, days: number): string | null {
  if (days <= 0) return null;
  const band = impliedCadence(request);
  if (!band) return null;

  const perDay = firings / days;
  if (perDay <= band.firingsPerDay) return null;

  return cadenceMessage(band, firings, days);
}

/** What to say once the rate is known to exceed the cadence the request named. */
export function cadenceMessage(band: Band, firings: number, days: number): string {
  const perDay = firings / days;
  return (
    `This would speak ${firings} times over ${days} days (${perDay.toFixed(2)} a day). The ` +
    `request reads as ${describe(band.cadence)}, which is closer to ${band.firingsPerDay} a day. ` +
    `If that is right, what bounds it — a cooldown's min_interval, a recurring schedule, a ` +
    `deadline on a judgement? If the request really is about something that happens this often, ` +
    `say so and leave it.`
  );
}

function describe(cadence: Cadence): string {
  switch (cadence) {
    case "per-occurrence":
      return "wanting one alert per occurrence";
    case "periodic":
      return "wanting a regular rhythm";
    case "exceptional":
      return "wanting to hear only when something is wrong";
  }
}
