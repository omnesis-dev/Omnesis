// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type {
  PrivacyAnswerComparison,
  PrivacyAnswerDiffLine,
  PrivacyAnswerDiffOp,
  PrivacyAnswerDiffSpan,
} from "@omnesis/types/privacy";

/**
 * The longest pair of answers a read will compare. An answer to an external
 * caller is conversational prose; 20,000 characters is five times the preview a
 * step displays and far past anything the reviewer produces. Beyond it the
 * comparison is not worth the latency it would add to a read that has to serve
 * a whole page of steps.
 */
const MAX_INPUT_CHARS = 20_000;

/**
 * The line table is |candidate lines| x |released lines| cells of 32 bits, so
 * this bounds it at 1 MiB and a quarter of a million comparisons — reached only
 * by a pair of 500-line answers, which the character cap above already makes
 * rare. A pair past it is reported as uncompared rather than partially diffed.
 */
const MAX_LINE_CELLS = 250_000;

/**
 * The same bound for the word table inside one matched line pair. A pair past
 * it keeps its lines and loses only its spans, because the line-level result is
 * still true.
 */
const MAX_WORD_CELLS = 10_000;

/**
 * How much of the visible content must survive for the whole comparison to be
 * presented as an edit. Reductions that strike a name, an address or a figure
 * leave most of the answer standing and score far above this; two texts written
 * independently about the same subject share whole lines only by accident and
 * score near zero. The gap between those two populations is wide, so the
 * threshold sits in the empty middle rather than at a measured boundary.
 */
const MIN_OVERALL_SIMILARITY = 0.3;

/**
 * How much two lines must share before the word-level breakdown between them is
 * shown. Under it the pairing is an artifact of position — the two lines are
 * unrelated, and highlighting the handful of words they happen to share would
 * assert an edit that never happened.
 */
const MIN_LINE_PAIR_SIMILARITY = 0.5;

interface Edit {
  op: PrivacyAnswerDiffOp;
  value: string;
}

/**
 * Compare the answer that left Omnesis against the candidate it was released
 * from. Returns what the record may state about the pair and nothing beyond it:
 * an identical release, a line-by-line edit, or a refusal to describe the
 * change as an edit at all.
 */
export function compareReleasedAnswer(
  candidate: string,
  released: string,
): PrivacyAnswerComparison {
  if (candidate === released) return { kind: "identical" };
  if (candidate.length > MAX_INPUT_CHARS || released.length > MAX_INPUT_CHARS) {
    return { kind: "no_diff", reason: "too_large" };
  }

  const candidateLines = splitLines(candidate);
  const releasedLines = splitLines(released);
  if (candidateLines.length * releasedLines.length > MAX_LINE_CELLS) {
    return { kind: "no_diff", reason: "too_large" };
  }

  const lines = buildLines(diffSequences(candidateLines, releasedLines));
  const matched = matchedVisibleChars(lines);
  const total = visibleLength(candidateLines) + visibleLength(releasedLines);
  const similarity = total === 0 ? 1 : (2 * matched) / total;
  if (similarity < MIN_OVERALL_SIMILARITY) return { kind: "no_diff", reason: "dissimilar" };
  return { kind: "diff", lines };
}

/**
 * Lines without their terminators, so a text that changed from CRLF to LF still
 * reads as unchanged content. A trailing terminator yields a final empty line,
 * which is what makes "a line was appended" show as one added line.
 */
function splitLines(value: string): string[] {
  return value.split(/\r\n|\n|\r/u);
}

/** Words and the whitespace between them, so the pieces re-join into the line. */
function tokenize(line: string): string[] {
  return line.match(/\s+|\S+/gu) ?? [];
}

/**
 * Turn the line-level edit script into displayable lines, attaching a word-level
 * breakdown wherever a removed line and an added line sit opposite each other in
 * the same change block and are similar enough to be one line edited.
 *
 * Opposite means same position within the block: the block boundaries come from
 * the surrounding unchanged lines, so a block is usually one line against one
 * line, and pairing by position keeps a multi-line block from claiming a
 * correspondence the similarity check would only have to withdraw.
 */
function buildLines(edits: Edit[]): PrivacyAnswerDiffLine[] {
  const lines: PrivacyAnswerDiffLine[] = [];
  let index = 0;
  while (index < edits.length) {
    const edit = edits[index];
    if (edit.op === "equal") {
      lines.push({ op: "equal", text: edit.value, spans: null });
      index += 1;
      continue;
    }
    const removed: string[] = [];
    while (index < edits.length && edits[index].op === "removed") {
      removed.push(edits[index].value);
      index += 1;
    }
    const added: string[] = [];
    while (index < edits.length && edits[index].op === "added") {
      added.push(edits[index].value);
      index += 1;
    }
    lines.push(...pairChangeBlock(removed, added));
  }
  return lines;
}

function pairChangeBlock(removed: string[], added: string[]): PrivacyAnswerDiffLine[] {
  const removedLines: PrivacyAnswerDiffLine[] = removed.map((text) => ({
    op: "removed",
    text,
    spans: null,
  }));
  const addedLines: PrivacyAnswerDiffLine[] = added.map((text) => ({
    op: "added",
    text,
    spans: null,
  }));
  for (let i = 0; i < removedLines.length && i < addedLines.length; i += 1) {
    const spans = wordSpans(removed[i], added[i]);
    if (!spans) continue;
    removedLines[i].spans = spans.removed;
    addedLines[i].spans = spans.added;
  }
  return [...removedLines, ...addedLines];
}

interface LinePairSpans {
  removed: PrivacyAnswerDiffSpan[];
  added: PrivacyAnswerDiffSpan[];
}

/**
 * The word-level breakdown of one line pair, or null when the pair is too big to
 * compare or too different for the breakdown to mean anything.
 */
function wordSpans(removedLine: string, addedLine: string): LinePairSpans | null {
  const removedWords = tokenize(removedLine);
  const addedWords = tokenize(addedLine);
  if (removedWords.length * addedWords.length > MAX_WORD_CELLS) return null;

  const edits = diffSequences(removedWords, addedWords);
  const shared = edits
    .filter((edit) => edit.op === "equal")
    .reduce((sum, edit) => sum + visibleChars(edit.value), 0);
  const total = visibleChars(removedLine) + visibleChars(addedLine);
  const similarity = total === 0 ? 1 : (2 * shared) / total;
  if (similarity < MIN_LINE_PAIR_SIMILARITY) return null;

  return {
    removed: mergeSpans(edits.filter((edit) => edit.op !== "added")),
    added: mergeSpans(edits.filter((edit) => edit.op !== "removed")),
  };
}

/** Adjacent runs of one op become one span, so a client renders fewer nodes. */
function mergeSpans(edits: Edit[]): PrivacyAnswerDiffSpan[] {
  const spans: PrivacyAnswerDiffSpan[] = [];
  for (const edit of edits) {
    const last = spans.at(-1);
    if (last && last.op === edit.op) last.text += edit.value;
    else spans.push({ op: edit.op, text: edit.value });
  }
  return spans;
}

/**
 * The edit script that turns `a` into `b`, derived from the longest common
 * subsequence of the two. Costs |a| x |b| cells, which is why every caller
 * checks that product against its budget first.
 */
function diffSequences(a: readonly string[], b: readonly string[]): Edit[] {
  const width = b.length + 1;
  const lengths = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i * width + j] =
        a[i] === b[j]
          ? lengths[(i + 1) * width + (j + 1)] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + (j + 1)]);
    }
  }

  const edits: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      edits.push({ op: "equal", value: a[i] });
      i += 1;
      j += 1;
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + (j + 1)]) {
      edits.push({ op: "removed", value: a[i] });
      i += 1;
    } else {
      edits.push({ op: "added", value: b[j] });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) edits.push({ op: "removed", value: a[i] });
  for (; j < b.length; j += 1) edits.push({ op: "added", value: b[j] });
  return edits;
}

/**
 * Characters that carry content, whitespace excluded. Measuring similarity on
 * these keeps indentation and line wrapping from voting on whether one text is
 * an edit of another.
 */
function visibleChars(value: string): number {
  return value.replace(/\s+/gu, "").length;
}

function visibleLength(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + visibleChars(line), 0);
}

/** Content the released answer kept: whole unchanged lines plus unchanged spans. */
function matchedVisibleChars(lines: readonly PrivacyAnswerDiffLine[]): number {
  let matched = 0;
  for (const line of lines) {
    if (line.op === "equal") {
      matched += visibleChars(line.text);
      continue;
    }
    // A matched pair reports the same shared text on both of its lines, so only
    // one side is counted; the ratio compares that against both sides' totals.
    if (line.op !== "removed" || !line.spans) continue;
    for (const span of line.spans) {
      if (span.op === "equal") matched += visibleChars(span.text);
    }
  }
  return matched;
}
