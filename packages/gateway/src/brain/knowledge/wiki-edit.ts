// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { assertNever } from "@omnesis/core";
import {
  ClaimMarkupError,
  parseClaimMarkup,
  stripClaimMarkup,
  type ParsedClaim,
} from "./claims.js";

/**
 * Targeted edits to a wiki or root page's tagged Markdown — the exact text
 * `knowledge_fetch({id, editing:true})` returns. Applying them yields a full
 * replacement Markdown that the ordinary save path validates; this module only
 * locates and splices text, and never judges claims, references or support.
 */
export type WikiEditOp =
  | { op: "replace_section"; heading: string; markdown: string }
  | {
      op: "insert_section";
      markdown: string;
      after?: string | undefined;
      before?: string | undefined;
      at?: "start" | "end" | undefined;
    }
  | { op: "delete_section"; heading: string }
  | { op: "replace_text"; old: string; new: string };

export type WikiEditErrorCode =
  | "edit_target_not_found"
  | "edit_target_ambiguous"
  | "edit_section_boundary"
  | "edit_invalid";

export class WikiEditError extends Error {
  constructor(
    readonly code: WikiEditErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WikiEditError";
  }
}

export interface WikiHeading {
  level: number;
  text: string;
  /** The heading as the model addresses it, e.g. `## Costs`. */
  label: string;
  /** Offset of the start of the heading's line. */
  lineStart: number;
}

export interface WikiEditResult {
  markdown: string;
  /** Labels of the sections each edit touched, in edit order, without repeats. */
  changedSections: string[];
}

const PREAMBLE = "(before the first heading)";
const LEADING_TAGS = /^(?:[ \t]*<\/?claim(?:\s[^>]*)?>)*/;
const TRAILING_CLOSE_TAGS = /(?:[ \t]*<\/claim>)+[ \t]*$/;
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Every ATX heading outside fenced code, including one whose line opens with
 * claim tags (`<claim id="x" refs="…">## Costs`). Claim tags at either end of a
 * line are ignored for fences and headings alike; tags inside heading text are
 * not part of its name. Setext headings are not addressable sections.
 */
export function listWikiHeadings(markdown: string): WikiHeading[] {
  const headings: WikiHeading[] = [];
  let fence: string | null = null;
  let offset = 0;
  for (const raw of markdown.split("\n")) {
    const lineStart = offset;
    offset += raw.length + 1;
    const line = (raw.endsWith("\r") ? raw.slice(0, -1) : raw).replace(LEADING_TAGS, "");
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      // A fence closes on a bare run of its own character at least as long.
      if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        /^ {0,3}[`~]+[ \t]*$/.test(line.replace(TRAILING_CLOSE_TAGS, ""))
      )
        fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    const match = ATX_HEADING.exec(line.replace(TRAILING_CLOSE_TAGS, ""));
    if (!match) continue;
    const text = stripTags(match[2] ?? "")
      .replace(/(?:^|[ \t]+)#+[ \t]*$/, "")
      .trim();
    if (!text) continue;
    const level = match[1]!.length;
    headings.push({ level, text, label: `${"#".repeat(level)} ${text}`, lineStart });
  }
  return headings;
}

/** Apply edits in order, each against the result of the previous one. */
export function applyWikiEdits(markdown: string, edits: readonly WikiEditOp[]): WikiEditResult {
  let text = markdown;
  const changed: string[] = [];
  const note = (label: string) => {
    if (!changed.includes(label)) changed.push(label);
  };
  edits.forEach((edit, index) => {
    const where = `edits[${index}] (${edit.op})`;
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const normalize = (value: string) => value.replace(/\r?\n/g, eol);
    switch (edit.op) {
      case "replace_text": {
        if (!edit.old) throw new WikiEditError("edit_invalid", `${where}: old must not be empty`);
        if (edit.old === edit.new)
          throw new WikiEditError("edit_invalid", `${where}: old and new are identical`);
        let old = edit.old;
        const replacement = normalize(edit.new);
        let positions = occurrences(text, old);
        if (positions.length === 0 && normalize(old) !== old) {
          old = normalize(old);
          positions = occurrences(text, old);
        }
        if (positions.length === 0) {
          const plain = plainTextOf(text);
          throw new WikiEditError(
            "edit_target_not_found",
            `${where}: old text was not found in the page's editing markdown. It must match the text knowledge_fetch({id, editing:true}) returns exactly, including claim tags, whitespace and punctuation.` +
              (plain !== null && plain.includes(stripTags(edit.old))
                ? " The words occur in the visible text but span claim tags: include the tags in old exactly as they appear."
                : ""),
          );
        }
        if (positions.length > 1)
          throw new WikiEditError(
            "edit_target_ambiguous",
            `${where}: old text occurs ${positions.length} times; it must occur exactly once. Include more surrounding text to make it unique.`,
          );
        const at = positions[0]!;
        note(sectionLabelAt(text, at));
        text = text.slice(0, at) + replacement + text.slice(at + old.length);
        return;
      }
      case "replace_section":
      case "delete_section": {
        const claims = claimsOf(text, where);
        const headings = listWikiHeadings(text);
        const heading = findHeading(headings, edit.heading, where);
        const { start, end } = sectionSpan(text, claims, headings, heading, where);
        note(heading.label);
        const span = text.slice(start, end);
        const trailing = span.slice(span.trimEnd().length);
        if (edit.op === "delete_section") {
          text = text.slice(0, start) + text.slice(end);
          return;
        }
        const body = normalize(edit.markdown)
          .replace(/^(?:[ \t]*\r?\n)+/, "")
          .trimEnd();
        if (!body)
          throw new WikiEditError(
            "edit_invalid",
            `${where}: markdown is empty; use delete_section to remove a section`,
          );
        const first = listWikiHeadings(body)[0];
        if (!first || !/^(?:\s*<claim\s[^>]*>)*\s*$/.test(body.slice(0, first.lineStart)))
          throw new WikiEditError(
            "edit_invalid",
            `${where}: markdown must open with the section's heading (inside its claim tag); to drop the heading, use replace_text or knowledge_save`,
          );
        text =
          text.slice(0, start) +
          body +
          (trailing || (end < text.length ? eol : "")) +
          text.slice(end);
        return;
      }
      case "insert_section": {
        const anchors = [edit.after, edit.before, edit.at].filter((value) => value !== undefined);
        if (anchors.length !== 1)
          throw new WikiEditError(
            "edit_invalid",
            `${where}: give exactly one of after (a heading), before (a heading) or at ("start" or "end")`,
          );
        const body = normalize(edit.markdown)
          .replace(/^(?:[ \t]*\r?\n)+/, "")
          .trimEnd();
        if (!body) throw new WikiEditError("edit_invalid", `${where}: markdown is empty`);
        let offset: number;
        if (edit.at === "start") offset = 0;
        else if (edit.at === "end") offset = text.length;
        else {
          const claims = claimsOf(text, where);
          const headings = listWikiHeadings(text);
          const heading = findHeading(headings, (edit.after ?? edit.before)!, where);
          const span = sectionSpan(text, claims, headings, heading, where);
          offset = edit.after !== undefined ? span.end : span.start;
        }
        let before = text.slice(0, offset);
        const after = text.slice(offset);
        if (before && !before.endsWith(eol)) before += eol;
        if (before && !before.endsWith(eol + eol)) before += eol;
        text = before + body + eol + (after && !/^\r?\n/.test(after) ? eol : "") + after;
        note(listWikiHeadings(body)[0]?.label ?? sectionLabelAt(text, before.length));
        return;
      }
      default:
        assertNever(edit);
    }
  });
  return { markdown: text, changedSections: changed };
}

function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) found.push(at);
  return found;
}

function plainTextOf(markdown: string): string | null {
  try {
    return stripClaimMarkup(markdown);
  } catch (error) {
    if (error instanceof ClaimMarkupError) return null;
    throw error;
  }
}

function stripTags(text: string): string {
  return text.replace(/<\/?claim(?:\s[^>]*)?>/g, "");
}

function claimsOf(markdown: string, where: string): ParsedClaim[] {
  try {
    return parseClaimMarkup(markdown).claims;
  } catch (error) {
    if (error instanceof ClaimMarkupError)
      throw new WikiEditError(
        "edit_invalid",
        `${where}: the page's claim markup is invalid before this edit (${error.message}); an earlier edit in this call must leave claim tags balanced`,
      );
    throw error;
  }
}

function findHeading(headings: readonly WikiHeading[], query: string, where: string): WikiHeading {
  const wanted = query.trim();
  const levelled = /^(#{1,6})[ \t]+(.*)$/.exec(wanted);
  const level = levelled ? levelled[1]!.length : undefined;
  const text = (levelled ? levelled[2]! : wanted).replace(/[ \t]+#+$/, "").trim();
  const matches = headings.filter(
    (heading) => heading.text === text && (level === undefined || heading.level === level),
  );
  const available = headings.length
    ? headings.map((heading) => heading.label).join(" | ")
    : "the page has no headings";
  if (matches.length === 0)
    throw new WikiEditError(
      "edit_target_not_found",
      `${where}: no heading matches ${JSON.stringify(wanted)}. Available headings: ${available}`,
    );
  if (matches.length > 1) {
    const levels = new Set(matches.map((heading) => heading.level));
    throw new WikiEditError(
      "edit_target_ambiguous",
      `${where}: ${matches.length} headings match ${JSON.stringify(wanted)} (${matches.map((heading) => heading.label).join(", ")}). ` +
        (levels.size === matches.length
          ? "Prefix the heading with its # marks to choose one level."
          : "Duplicate headings cannot be addressed as sections; use replace_text with unique surrounding text."),
    );
  }
  return matches[0]!;
}

/**
 * A section runs from its heading to the next heading of the same or a higher
 * level. Its edges move back over claim tags that open immediately before a
 * heading, so a section carries the claim wrapping its heading. An edge inside
 * any other claim span would split that claim, and is refused.
 */
function sectionSpan(
  markdown: string,
  claims: readonly ParsedClaim[],
  headings: readonly WikiHeading[],
  heading: WikiHeading,
  where: string,
): { start: number; end: number } {
  const index = headings.indexOf(heading);
  const next = headings.slice(index + 1).find((other) => other.level <= heading.level);
  const edge = (offset: number) => {
    let start = offset;
    for (let moved = true; moved; ) {
      moved = false;
      for (const claim of claims)
        if (
          claim.sourceSpan.start < start &&
          start < claim.sourceSpan.end &&
          !/\S/.test(markdown.slice(claim.contentSpan.start, start))
        ) {
          start = claim.sourceSpan.start;
          moved = true;
        }
    }
    const crossing = claims.find(
      (claim) => claim.sourceSpan.start < start && start < claim.sourceSpan.end,
    );
    if (crossing)
      throw new WikiEditError(
        "edit_section_boundary",
        `${where}: section ${JSON.stringify(heading.label)} cannot be cut out cleanly because claim ${JSON.stringify(crossing.id)} spans its boundary. Use replace_text for this change, or knowledge_save to restructure the page.`,
      );
    return start;
  };
  return { start: edge(heading.lineStart), end: next ? edge(next.lineStart) : markdown.length };
}

function sectionLabelAt(markdown: string, offset: number): string {
  let label = PREAMBLE;
  for (const heading of listWikiHeadings(markdown)) {
    if (heading.lineStart > offset) break;
    label = heading.label;
  }
  return label;
}
