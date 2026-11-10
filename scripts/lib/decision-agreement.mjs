// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Agreement between a candidate decision model and the answers recorded in a
 * decision cassette — the pure half of `scripts/eval-decision-cassette.mts`.
 *
 * Each asked question compares the candidate's typed answer with the recorded
 * one: a noul agrees when both fall on the same side of 0.5, a score when both
 * round to the same level, a choice when both pick the same key. The distance
 * (|Δp| for a noul, |Δlevel| for a score, 0 or 1 for a choice) shows how far
 * apart they are when they disagree. A question the candidate could not answer
 * counts as unanswered, never as agreement.
 *
 * Rounded agreement says how alike two models are; the gates act on
 * thresholds, so {@link compareGate} also scores each thresholded question
 * the way its gate would read it.
 */

/**
 * @param {{type: string}} recorded the cassette's answer
 * @param {{type: string} | null} candidate the candidate's answer, or null when it threw
 * @returns {{type: string, answered: boolean, agree: boolean, distance: number | null}}
 */
export function compareAnswer(recorded, candidate) {
  const type = recorded.type;
  if (!candidate || candidate.type !== type) {
    return { type, answered: false, agree: false, distance: null };
  }
  switch (type) {
    case "noul": {
      const distance = Math.abs(recorded.noul - candidate.noul);
      return {
        type,
        answered: true,
        agree: recorded.noul >= 0.5 === candidate.noul >= 0.5,
        distance,
      };
    }
    case "score": {
      const distance = Math.abs(recorded.score - candidate.score);
      return {
        type,
        answered: true,
        agree: Math.round(recorded.score) === Math.round(candidate.score),
        distance,
      };
    }
    case "choice": {
      const agree = recorded.choice === candidate.choice;
      return { type, answered: true, agree, distance: agree ? 0 : 1 };
    }
    default:
      throw new Error(`Unknown decision answer type "${type}"`);
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/**
 * Summarise comparisons per answer type.
 *
 * @param {ReturnType<typeof compareAnswer>[]} rows
 */
export function summarizeAgreement(rows) {
  const byType = new Map();
  for (const row of rows) {
    const list = byType.get(row.type) ?? [];
    list.push(row);
    byType.set(row.type, list);
  }
  return [...byType.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, list]) => {
      const answered = list.filter((r) => r.answered);
      const distances = answered.map((r) => r.distance).sort((a, b) => a - b);
      return {
        type,
        asked: list.length,
        answered: answered.length,
        agreement:
          answered.length === 0 ? null : answered.filter((r) => r.agree).length / answered.length,
        meanDistance:
          distances.length === 0 ? null : distances.reduce((a, b) => a + b, 0) / distances.length,
        p90Distance: percentile(distances, 0.9),
      };
    });
}

/** A fixed-width table of {@link summarizeAgreement}'s rows. */
export function formatAgreement(summary) {
  const fmt = (v, digits = 2) => (v === null ? "—" : v.toFixed(digits));
  const lines = ["type     asked  answered  agreement  mean Δ  p90 Δ"];
  for (const s of summary) {
    lines.push(
      [
        s.type.padEnd(8),
        String(s.asked).padStart(5),
        String(s.answered).padStart(9),
        (s.agreement === null ? "—" : `${(s.agreement * 100).toFixed(1)}%`).padStart(10),
        fmt(s.meanDistance).padStart(7),
        fmt(s.p90Distance).padStart(6),
      ].join(" "),
    );
  }
  return lines.join("\n");
}

/**
 * A gate's view of one question: the gates compare a score (or a noul's
 * probability) with a fixed threshold, so two answers can round to the same
 * level and still fall on opposite sides of it. Null when the question is not
 * a score or a noul.
 *
 * @param {string} question the question id
 * @param {number} threshold pass at or above this
 * @param {{type: string}} recorded
 * @param {{type: string} | null} candidate
 */
export function compareGate(question, threshold, recorded, candidate) {
  const value = (answer) =>
    answer?.type === "score" ? answer.score : answer?.type === "noul" ? answer.noul : null;
  const recordedValue = value(recorded);
  if (recordedValue === null) return null;
  const candidateValue = candidate?.type === recorded.type ? value(candidate) : null;
  return {
    question,
    threshold,
    recordedPass: recordedValue >= threshold,
    candidatePass: candidateValue === null ? null : candidateValue >= threshold,
  };
}

/**
 * Per question: how often the candidate's pass/skip matches the recorded one,
 * and its recall on the items the recorded model passed — for the worth gate,
 * the share of worthwhile mail it would still keep. Unanswered questions are
 * left out of both; they fail open in the gateway.
 *
 * @param {NonNullable<ReturnType<typeof compareGate>>[]} rows
 */
export function summarizeGates(rows) {
  const byQuestion = new Map();
  for (const row of rows) {
    const list = byQuestion.get(row.question) ?? [];
    list.push(row);
    byQuestion.set(row.question, list);
  }
  const share = (n, d) => (d === 0 ? null : n / d);
  return [...byQuestion.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([question, list]) => {
      const answered = list.filter((r) => r.candidatePass !== null);
      const recordedPasses = answered.filter((r) => r.recordedPass);
      return {
        question,
        threshold: list[0].threshold,
        asked: list.length,
        answered: answered.length,
        passAgreement: share(
          answered.filter((r) => r.recordedPass === r.candidatePass).length,
          answered.length,
        ),
        recall: share(recordedPasses.filter((r) => r.candidatePass).length, recordedPasses.length),
        recordedPassRate: share(recordedPasses.length, answered.length),
        candidatePassRate: share(answered.filter((r) => r.candidatePass).length, answered.length),
      };
    });
}

/** A fixed-width table of {@link summarizeGates}' rows. */
export function formatGates(summary) {
  const pct = (v) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
  const lines = [
    "question          threshold  answered  pass/skip agree  recall  recorded pass  candidate pass",
  ];
  for (const s of summary) {
    lines.push(
      [
        s.question.padEnd(17),
        String(s.threshold).padStart(9),
        `${s.answered}/${s.asked}`.padStart(9),
        pct(s.passAgreement).padStart(16),
        pct(s.recall).padStart(7),
        pct(s.recordedPassRate).padStart(14),
        pct(s.candidatePassRate).padStart(15),
      ].join(" "),
    );
  }
  return lines.join("\n");
}
