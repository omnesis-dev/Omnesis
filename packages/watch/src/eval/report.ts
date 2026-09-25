// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the run measured.
 *
 * Rates, not verdicts. The same request compiles on one attempt and misses a
 * key extractor on the next, so "did it work" is not a question this can
 * answer — "how often" is.
 *
 * The failure classes are printed separately rather than summed, because they
 * point at different work. Replies that would not parse are plumbing. Watches
 * that never validated mean the diagnostics loop is not converging. Watches
 * that validated and behave differently, or that were written for a request
 * with no answer, are the class nothing downstream catches, and they get their
 * own line.
 */

import {
  DEFECT_CLASSES,
  OUTCOME_CLASSES,
  WRONG_BUT_VALIDATES,
  type OutcomeClass,
  type SampleOutcome,
} from "./harness.js";

interface PromptSummary {
  readonly prompt: string;
  readonly samples: number;
  readonly passed: number;
  readonly rate: number;
  readonly classes: Readonly<Record<OutcomeClass, number>>;
}

function summarize(outcomes: readonly SampleOutcome[]): PromptSummary[] {
  const byPrompt = new Map<string, SampleOutcome[]>();
  for (const outcome of outcomes) {
    byPrompt.set(outcome.prompt, [...(byPrompt.get(outcome.prompt) ?? []), outcome]);
  }

  return [...byPrompt.entries()]
    .map(([prompt, samples]) => {
      const classes = Object.fromEntries(
        OUTCOME_CLASSES.map((c) => [c, samples.filter((s) => s.outcome === c).length]),
      ) as Record<OutcomeClass, number>;
      const passed = classes.ok;
      return { prompt, samples: samples.length, passed, rate: passed / samples.length, classes };
    })
    .sort((a, b) => a.rate - b.rate || (a.prompt < b.prompt ? -1 : 1));
}

export function formatSummary(
  title: string,
  outcomes: readonly SampleOutcome[],
  measures: string,
): string {
  if (outcomes.length === 0) return `## ${title}\n\n(nothing ran)`;

  const rows = summarize(outcomes);
  const passed = outcomes.filter((o) => o.outcome === "ok").length;
  const wrong = outcomes.filter((o) => WRONG_BUT_VALIDATES.includes(o.outcome)).length;
  const defects = outcomes.filter((o) => DEFECT_CLASSES.includes(o.outcome)).length;
  const defensible = outcomes.filter((o) => o.outcome === "divergent_defensible").length;
  // The two allowances reach `divergent_defensible` by different paths and mean
  // different things: one is a number the request left open, the other is the
  // shape of the answer. Counting them together would report the subsidy as
  // larger than it is, which is the same kind of error in the other direction.
  const subsidised = outcomes.filter(
    (o) =>
      o.outcome === "divergent_defensible" &&
      o.detail.startsWith("differs only inside declared latitude"),
  ).length;

  const lines = [
    `## ${title}`,
    "",
    measures,
    "",
    `**Structural-defect rate: ${defects}/${outcomes.length} (${pct(defects / outcomes.length)}).** ` +
      "This is the headline: attempts that misread the request, failed to validate, refused something " +
      "answerable, answered something unanswerable, or blew up.",
    "",
    `Defensibly divergent: ${defensible}/${outcomes.length} (${pct(defensible / outcomes.length)}) — ` +
      "read the request correctly and chose differently where it was silent. Not a defect.",
    "",
    `Exactly matched: ${passed}/${outcomes.length} (${pct(passed / outcomes.length)}) across ${rows.length} requests.`,
    "",
    // Both readings, always, so the subsidy is countable rather than argued
    // about. The strict number is what a compilation earned with no allowance
    // made; the second is what it earned once each reference's request was read
    // as leaving the shape of an answer open. The gap between them is the
    // latitude, and it belongs in the report rather than in a discussion.
    `**Agreement without latitude: ${passed}/${outcomes.length} (${pct(passed / outcomes.length)}).** ` +
      `With it: ${passed + subsidised}/${outcomes.length} (${pct((passed + subsidised) / outcomes.length)}). ` +
      `The difference — ${subsidised} ${subsidised === 1 ? "attempt" : "attempts"} — is what the ` +
      "declared latitude is worth: each one behaves differently from its reference and differs only " +
      "inside something that reference's request was found to leave open about the shape of an " +
      "answer. The remaining " +
      `${defensible - subsidised} defensible ${defensible - subsidised === 1 ? "attempt" : "attempts"} ` +
      "diverge on a number the request left open, which is a different allowance and counted apart.",
    "",
    "| request | exact | defensible | structural | parse | invalid | refused-wrongly | refused-vaguely | wrote-anyway | errored |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.prompt} | ${r.classes.ok} | ${r.classes.divergent_defensible} | ` +
        `${r.classes.structural_defect} | ${r.classes.parse_failure} | ` +
        `${r.classes.validator_rejected} | ${r.classes.refused_wrongly} | ` +
        `${r.classes.refused_vaguely} | ${r.classes.compiled_when_it_should_refuse} | ` +
        `${r.classes.errored} |`,
    ),
  ];
  if (wrong > 0) {
    lines.push(
      "",
      `**Validated and wrong: ${wrong}/${outcomes.length} (${pct(wrong / outcomes.length)}).** ` +
        "Nothing downstream catches this class — the watch installs and runs.",
    );
  }
  return lines.join("\n");
}

/** The distinct reasons behind one class, most common first. */
export function reasonsFor(
  outcomes: readonly SampleOutcome[],
  outcome: OutcomeClass,
  limit = 10,
): string[] {
  const counts = new Map<string, number>();
  for (const sample of outcomes) {
    if (sample.outcome !== outcome) continue;
    counts.set(sample.detail, (counts.get(sample.detail) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([detail, count]) => `${count}× ${detail}`);
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
