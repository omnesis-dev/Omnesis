// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The cognition run-prompt envelope — the identity line every background
 * run's prompt opens with, and its parser.
 *
 * The envelope states which run a prompt belongs to (id, kind, attempt) so
 * a re-claimed attempt can recognize and adopt work its predecessor left
 * behind. It lives here, in one place, because two very different callers
 * depend on the same bytes: the gateway's prompt builder writes it, and
 * scripted background-model harnesses read it to decide which run they are
 * being asked to perform. A format-only-in-the-writer arrangement drifts —
 * the reader's copy silently stops matching and every scripted run degrades
 * into a no-op — so writer and reader are defined together and cannot.
 *
 * The prose is load-bearing: the model reads it too. Change it only
 * deliberately, and never in a way that drops the id, kind, or attempt.
 */

/** The identity a run prompt's envelope carries. */
export interface CognitionRunEnvelope {
  runId: string;
  kind: string;
  attempt: number;
}

/**
 * The re-attempt caution, appended when an earlier attempt of the same run
 * may have already written something.
 */
const RE_ATTEMPT_NOTE =
  "A previous attempt of this run may have partially completed. Before creating anything, check for loops, briefs, and ledger entries already stamped with this run id and adopt that work instead of duplicating it.";

/** Render the envelope line (plus the re-attempt caution from attempt 2 on). */
export function formatCognitionRunEnvelope(run: CognitionRunEnvelope): string {
  const reAttempt = run.attempt > 1 ? `\n${RE_ATTEMPT_NOTE}` : "";
  return `Loop agent run ${run.runId} (kind: ${run.kind}, attempt ${run.attempt}).${reAttempt}`;
}

/** Matches the first line of {@link formatCognitionRunEnvelope}. */
const ENVELOPE_RE = /^Loop agent run (\S+) \(kind: (\w+), attempt (\d+)\)\./;

/**
 * Read the envelope off a run prompt. Null when the text does not open with
 * one — a caller that scripts runs should treat that as "not a cognition
 * run prompt" and refuse to act, never as a default kind.
 */
export function parseCognitionRunEnvelope(prompt: string): CognitionRunEnvelope | null {
  const m = ENVELOPE_RE.exec(prompt);
  if (!m) return null;
  return { runId: m[1]!, kind: m[2]!, attempt: Number.parseInt(m[3]!, 10) };
}

/**
 * The prompt body beneath the envelope: everything after the envelope line
 * (and its optional re-attempt caution) and the blank line that follows.
 */
export function cognitionRunPromptBody(prompt: string): string {
  const lines = prompt.split("\n");
  if (lines.length === 0 || !ENVELOPE_RE.test(lines[0] ?? "")) return prompt;
  let i = 1;
  if (lines[i] === RE_ATTEMPT_NOTE) i++;
  while (i < lines.length && lines[i] === "") i++;
  return lines.slice(i).join("\n");
}
