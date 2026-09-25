// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * How the answer that left Omnesis relates to the candidate it was released
 * from, drawn under the release moment on an exchange's spine.
 *
 * The difference is encoded on three independent channels, because colour is
 * not one this record may lean on. Every line carries a marker in a column of
 * its own — `−` for text the draft had and the release did not, `+` for text
 * only the release has. Removed text is struck through and hatched; added text
 * is underlined and flat. The two tints differ in saturation as well as hue — a
 * neutral against a violet that belongs to no outcome chip — so they stay apart
 * for a reader who cannot separate red from green and are never mistaken for a
 * status. Printed in greyscale the markers and the strike/underline still carry
 * the whole meaning.
 *
 * The lines sit on the section's shared quote surface, so this block reads as
 * one of the exchange's own texts rather than as a widget of its own. Only the
 * markers, the per-line tints and the monospace grid belong to it; the card
 * under them is the same one the request and the answers are drawn on.
 *
 * Nothing here interprets the change. The gateway derives these lines from two
 * strings; a reduction the reviewer named may appear nowhere in them, and their
 * absence is not evidence about either text.
 *
 * Every string on screen is gateway-supplied and shaped by whatever asked the
 * question, so each one is passed as a text child and never as markup.
 */

import { html } from "htm/preact";

import { PRIVACY_QUOTE_CLASS } from "./shared.js";

const LINE_MARKERS = { removed: "−", added: "+" };

/** What a line's marker means, for a reader who hears the record rather than sees it. */
const LINE_ANNOUNCEMENTS = {
  removed: "In the draft, not released: ",
  added: "In the released answer: ",
};

const NO_DIFF_REASONS = {
  dissimilar:
    " Omnesis draws one only when the two texts are close enough for the lines to"
    + " describe an edit, and this pair was not.",
  too_large: " The pair is longer than Omnesis will compare.",
};

const IDENTICAL_NOTE =
  "The released answer is the drafted answer, byte for byte, so it is not printed again here.";

const NO_DIFF_NOTE =
  "No line-by-line comparison is drawn for this release."
  + " The released answer is printed in this step; the draft it came from is the candidate step above.";

const DIFF_LEGEND =
  "− was in the draft and did not leave this machine. + is in the released answer.";

/**
 * The lines a comparison can actually draw, or null when it draws none. A
 * caller uses this to decide whether the release step still needs to print its
 * own preview of the released answer: when there are lines, they already carry
 * that answer in full.
 */
export function answerDiffLines(comparison) {
  if (comparison?.kind !== "diff") return null;
  const { lines } = comparison;
  return Array.isArray(lines) && lines.length > 0 ? lines : null;
}

/**
 * One run inside a line. `removed` and `added` runs are marked up as such so
 * assistive technology reports the edit from the element rather than from the
 * colour; an unrecognised op is rendered as plain text, because dropping a run
 * would silently shorten a record.
 */
function DiffSpan({ span }) {
  const text = String(span?.text ?? "");
  if (span?.op === "removed") return html`<del>${text}</del>`;
  if (span?.op === "added") return html`<ins>${text}</ins>`;
  return html`<span>${text}</span>`;
}

/**
 * A line's content. A line with no counterpart on the other side has no
 * word-level breakdown, so the whole of it is the change; a matched pair marks
 * up only the runs that differ, leaving the shared words in body text.
 */
function DiffLineContent({ line }) {
  if (Array.isArray(line.spans) && line.spans.length > 0) {
    return line.spans.map((span, index) => html`<${DiffSpan} key=${index} span=${span} />`);
  }
  const text = String(line.text ?? "");
  if (line.op === "removed" || line.op === "added") {
    return html`<${DiffSpan} span=${{ op: line.op, text }} />`;
  }
  return text;
}

function DiffLine({ line }) {
  const op = LINE_MARKERS[line.op] ? line.op : "equal";
  const announcement = LINE_ANNOUNCEMENTS[op];
  return html`<li class=${`privacy-diff-line privacy-diff-line--${op}`}>
    <span class="privacy-diff-marker" aria-hidden="true">${LINE_MARKERS[op] ?? ""}</span>
    <span class="privacy-diff-text">
      ${announcement ? html`<span class="sr-only">${announcement}</span>` : null}
      <${DiffLineContent} line=${line} />
    </span>
  </li>`;
}

/**
 * The comparison block. It renders nothing at all for an absent comparison or
 * for a kind this build does not know — a record that cannot be described is
 * better left undescribed than narrated by a branch that guessed.
 */
export function PrivacyAnswerComparison({ comparison }) {
  if (comparison?.kind === "identical") {
    return html`<p class="privacy-diff-note">${IDENTICAL_NOTE}</p>`;
  }
  if (comparison?.kind === "no_diff") {
    return html`<p class="privacy-diff-note">
      ${NO_DIFF_NOTE}${NO_DIFF_REASONS[comparison.reason] ?? ""}
    </p>`;
  }
  const lines = answerDiffLines(comparison);
  if (!lines) return null;
  // The list is height-capped, so it states its own length: a reader looking at
  // a box that ends mid-comparison must still be able to see that it does.
  return html`<div class="privacy-diff">
    <p class="privacy-diff-caption">
      <strong>Compared with the draft</strong>
      <span>${DIFF_LEGEND}</span>
      <span class="privacy-diff-count">${lines.length} line${lines.length === 1 ? "" : "s"}</span>
    </p>
    <ol
      class=${`privacy-diff-lines ${PRIVACY_QUOTE_CLASS}`}
      tabindex="0"
      aria-label="The drafted answer compared with the released answer"
    >
      ${lines.map((line, index) => html`<${DiffLine} key=${index} line=${line} />`)}
    </ol>
  </div>`;
}
