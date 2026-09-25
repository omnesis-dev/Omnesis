// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Line-based content diff for the document-diff engine. Produces a
 * compact unified-diff-style text (`@@` hunks, `-`/`+`/space lines) that
 * the Cognition Steward's run prompt can carry verbatim — computed once at
 * enqueue time and discarded when the run settles, never persisted
 * beyond the queue row.
 *
 * Deliberately dependency-free and bounded:
 *   - Common prefix/suffix are trimmed first (typical document edits
 *     are localized), so most diffs cost O(n) line comparisons.
 *   - The remaining middle gets an LCS alignment only while it is small
 *     (`maxLcsLines` per side); a larger middle degrades to a single
 *     replace hunk (all old lines `-`, all new lines `+`) rather than
 *     paying quadratic time/memory on the ingest box.
 *   - Inputs beyond `maxInputBytes`/`maxInputLines` yield null — the
 *     run payload then simply carries no diff and the agent reads the
 *     current document instead.
 *   - Output beyond `maxOutputBytes` is truncated with a marker.
 */

export interface ContentDiffLimits {
  /** Per-side input ceiling; larger bodies yield no diff. */
  maxInputBytes: number;
  /** Per-side input line ceiling; larger bodies yield no diff. */
  maxInputLines: number;
  /** Per-side ceiling for the exact-LCS middle; beyond it → replace hunk. */
  maxLcsLines: number;
  /** Output ceiling; longer diffs are truncated with a marker. */
  maxOutputBytes: number;
}

export const DEFAULT_CONTENT_DIFF_LIMITS: ContentDiffLimits = {
  maxInputBytes: 512 * 1024,
  maxInputLines: 10_000,
  maxLcsLines: 400,
  maxOutputBytes: 64 * 1024,
};

const CONTEXT_LINES = 2;
const TRUNCATION_MARKER = "… [diff truncated]";

interface Edit {
  kind: "same" | "del" | "add";
  line: string;
}

/** Exact line-level LCS edit script (middle regions only — bounded). */
function lcsEdits(a: string[], b: string[]): Edit[] {
  // dp[i][j] = LCS length of a[i:], b[j:]
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: Uint32Array = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * cols + j] =
        a[i] === b[j]
          ? dp[(i + 1) * cols + j + 1] + 1
          : Math.max(dp[(i + 1) * cols + j], dp[i * cols + j + 1]);
    }
  }
  const edits: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      edits.push({ kind: "same", line: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * cols + j] >= dp[i * cols + j + 1]) {
      edits.push({ kind: "del", line: a[i] });
      i++;
    } else {
      edits.push({ kind: "add", line: b[j] });
      j++;
    }
  }
  for (; i < a.length; i++) edits.push({ kind: "del", line: a[i] });
  for (; j < b.length; j++) edits.push({ kind: "add", line: b[j] });
  return edits;
}

/** Group an edit script into unified hunks with `CONTEXT_LINES` context. */
function renderHunks(edits: Edit[], beforeStart: number, afterStart: number): string[] {
  // Indexes of non-"same" edits.
  const changed: number[] = [];
  for (let k = 0; k < edits.length; k++) {
    if (edits[k].kind !== "same") changed.push(k);
  }
  if (changed.length === 0) return [];

  // Merge changed indexes into ranges whose context windows touch.
  const ranges: Array<{ from: number; to: number }> = [];
  for (const k of changed) {
    const last = ranges[ranges.length - 1];
    if (last && k - last.to <= CONTEXT_LINES * 2) last.to = k;
    else ranges.push({ from: k, to: k });
  }

  // Running line numbers per edit index.
  const beforeLineAt: number[] = new Array(edits.length);
  const afterLineAt: number[] = new Array(edits.length);
  let bl = beforeStart;
  let al = afterStart;
  for (let k = 0; k < edits.length; k++) {
    beforeLineAt[k] = bl;
    afterLineAt[k] = al;
    if (edits[k].kind !== "add") bl++;
    if (edits[k].kind !== "del") al++;
  }

  const out: string[] = [];
  for (const r of ranges) {
    const from = Math.max(0, r.from - CONTEXT_LINES);
    const to = Math.min(edits.length - 1, r.to + CONTEXT_LINES);
    let beforeCount = 0;
    let afterCount = 0;
    const body: string[] = [];
    for (let k = from; k <= to; k++) {
      const e = edits[k];
      if (e.kind === "same") {
        body.push(` ${e.line}`);
        beforeCount++;
        afterCount++;
      } else if (e.kind === "del") {
        body.push(`-${e.line}`);
        beforeCount++;
      } else {
        body.push(`+${e.line}`);
        afterCount++;
      }
    }
    out.push(
      `@@ -${beforeLineAt[from] + 1},${beforeCount} +${afterLineAt[from] + 1},${afterCount} @@`,
    );
    out.push(...body);
  }
  return out;
}

/**
 * Compute the previous→current diff. Returns null when the bodies are
 * identical or when either side exceeds the input limits (the payload
 * then carries no diff).
 */
export function computeContentDiff(
  before: string,
  after: string,
  limits: ContentDiffLimits = DEFAULT_CONTENT_DIFF_LIMITS,
): string | null {
  if (before === after) return null;
  if (
    Buffer.byteLength(before, "utf8") > limits.maxInputBytes ||
    Buffer.byteLength(after, "utf8") > limits.maxInputBytes
  ) {
    return null;
  }
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > limits.maxInputLines || b.length > limits.maxInputLines) return null;

  // Trim common prefix/suffix.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  const edits =
    midA.length <= limits.maxLcsLines && midB.length <= limits.maxLcsLines
      ? lcsEdits(midA, midB)
      : // Middle too large for exact alignment — one replace block.
        [
          ...midA.map((line): Edit => ({ kind: "del", line })),
          ...midB.map((line): Edit => ({ kind: "add", line })),
        ];

  // Re-attach context from the trimmed prefix/suffix so hunks read
  // naturally at the boundaries.
  const prefixCtx = a.slice(Math.max(0, start - CONTEXT_LINES), start);
  const suffixCtx = a.slice(endA, Math.min(a.length, endA + CONTEXT_LINES));
  const wrapped: Edit[] = [
    ...prefixCtx.map((line): Edit => ({ kind: "same", line })),
    ...edits,
    ...suffixCtx.map((line): Edit => ({ kind: "same", line })),
  ];
  const hunkStart = Math.max(0, start - CONTEXT_LINES);

  const lines = renderHunks(wrapped, hunkStart, hunkStart);
  if (lines.length === 0) return null;
  let text = lines.join("\n");
  if (Buffer.byteLength(text, "utf8") > limits.maxOutputBytes) {
    // Truncate on a line boundary under the cap, then append the marker.
    let size = 0;
    const kept: string[] = [];
    for (const line of lines) {
      const lineSize = Buffer.byteLength(line, "utf8") + 1;
      if (size + lineSize > limits.maxOutputBytes) break;
      kept.push(line);
      size += lineSize;
    }
    text = [...kept, TRUNCATION_MARKER].join("\n");
  }
  return text;
}
