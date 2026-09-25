// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the eval runner was asked to do.
 *
 * Its own module, and not a few lines inside the script, because the failure
 * mode here is expensive and silent. `Number("abc")` is `NaN`, and `NaN`
 * compares false against everything: a `NaN` ceiling passes every spend check
 * and runs unbounded against a prepaid account, and a `NaN` sample count builds
 * an array of that length, does no work at all, and reports `0/0` as though the
 * run had succeeded. Neither announces itself.
 *
 * So every numeric flag is parsed here, in one place a test can reach, and a
 * value that is not a positive number is a hard error before anything is
 * spent.
 */

type PromptSet = "paired" | "unseen" | "both";
export type Arms = "current" | "control" | "ab" | "two-pass";

export interface EvalArgs {
  readonly samples: number;
  readonly set: PromptSet;
  readonly only: string | null;
  readonly concurrency: number;
  /** Estimated USD at which the run stops asking for more. */
  readonly ceiling: number;
  readonly out: string | null;
  /**
   * Which prompt or prompts a sweep compiles under.
   *
   * `ab` compiles every request under both in one interleaved run. One run
   * rather than two: the arms then meet the same provider, the same cache and
   * the same hour, so what separates them is the prompt. Two sweeps an hour
   * apart measure the prompt and the afternoon together.
   *
   * `control` runs the un-calibrated prompt alone and labels it, which is what
   * a repeated-sweep noise measurement needs: to say how far two runs of one
   * unchanged setup drift, the setup has to be pinned to a named arm rather
   * than to whatever the default currently is.
   */
  readonly arms: Arms;
}

const DEFAULTS: EvalArgs = {
  samples: 5,
  set: "both",
  only: null,
  concurrency: 6,
  ceiling: 15,
  out: null,
  arms: "current",
};

export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  const args: {
    -readonly [K in keyof EvalArgs]: EvalArgs[K];
  } = { ...DEFAULTS };

  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);

    switch (flag) {
      case "--samples":
        args.samples = wholeNumber(flag, value);
        break;
      case "--concurrency":
        args.concurrency = wholeNumber(flag, value);
        break;
      case "--ceiling":
        args.ceiling = positive(flag, value);
        break;
      case "--set":
        args.set = oneOf(flag, value, ["paired", "unseen", "both"]);
        break;
      case "--only":
        args.only = notAFlag(flag, value);
        break;
      case "--out":
        args.out = notAFlag(flag, value);
        break;
      case "--arms":
        args.arms = oneOf(flag, value, ["current", "control", "ab", "two-pass"]);
        break;
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }
  return args;
}

/**
 * A number above zero, or a clear stop.
 *
 * Rejects `NaN` and `Infinity` explicitly rather than relying on a comparison:
 * `NaN > 0` is false and `NaN <= 0` is also false, so a check written either
 * way round lets it through.
 */
function positive(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} needs a positive number, got '${value}'`);
  }
  return parsed;
}

/**
 * A count, which has to be a whole one.
 *
 * `positive` alone is not enough: `--samples 1e-9` is a positive number, and
 * `Array.from({ length: 1e-9 })` has length zero — so the sweep builds no work,
 * does nothing, and prints `0/0` as a clean result. That is the same silent
 * nothing a `NaN` produces, arrived at from the other side. A fractional
 * ceiling is legitimate; a fractional count is not.
 */
function wholeNumber(flag: string, value: string): number {
  const parsed = positive(flag, value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${flag} needs a whole number, got '${value}'`);
  }
  return parsed;
}

/**
 * A value, not the next flag.
 *
 * `--out --set` would otherwise write the report to a file called `--set` and
 * swallow the flag that followed, silently doing something other than what was
 * asked.
 */
function notAFlag(flag: string, value: string): string {
  if (value.startsWith("--")) throw new Error(`${flag} needs a value, got the flag '${value}'`);
  return value;
}

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${flag} must be one of ${allowed.join(", ")}, got '${value}'`);
  }
  return value as T;
}
