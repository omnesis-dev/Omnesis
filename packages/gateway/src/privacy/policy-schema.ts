// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  PRIVACY_POLICY_APPROVAL_SECTION_HEADING,
  PRIVACY_POLICY_CREDENTIAL_APPROVAL_CLAUSE,
  PRIVACY_POLICY_CREDENTIAL_APPROVAL_SENTENCE,
  PRIVACY_POLICY_CREDENTIAL_DENY_SENTENCE,
} from "./policy-store.js";
import type {
  PrivacyPolicyDecision,
  PrivacyExistenceDecision,
  PrivacyPolicyRow,
  PrivacyPolicySchema,
  PrivacyPolicySchemaEdit,
} from "@omnesis/types/privacy";

/**
 * A typed projection of the decision table inside a privacy policy, so clients
 * can offer named controls instead of asking a person to hand-write markdown.
 *
 * The projection is deliberately *not* a re-serialization of the whole policy.
 * A policy is prose a reviewer model reads, and the operator owns that prose
 * once they adopt a template; regenerating it from a fixed template would
 * silently discard their edits. So a parse also records the exact character
 * range the table occupies, and an edit splices a rebuilt table back into that
 * range. Prose outside the table survives byte for byte; rows inside it are
 * re-rendered in canonical form, so an edit normalizes cell padding and the
 * separator row even where it changes no decision.
 *
 * Only the table and the credential clause are projected, because those are the
 * only parts with a fixed grammar. Anything the parser cannot read leaves the
 * schema null and the client falls back to the text editor.
 */

const DECISION_TEXT: Record<PrivacyPolicyDecision, string> = {
  allow: "Allow",
  reduce: "Release with reductions",
  approve: "Approval required",
  deny: "Deny",
};

const DECISION_BY_TEXT = new Map<string, PrivacyPolicyDecision>(
  Object.entries(DECISION_TEXT).map(([decision, text]) => [
    text.toLowerCase(),
    decision as PrivacyPolicyDecision,
  ]),
);

function existenceDecision(value: string): PrivacyExistenceDecision | null {
  const decision = DECISION_BY_TEXT.get(value.trim().toLowerCase());
  return decision && decision !== "reduce" ? decision : null;
}

/** The table header every built-in template shares. */
const TABLE_HEADER = "| Information | Existence | Summary | Exact or original |";
const LEGACY_TABLE_HEADER = "| Information | Summary | Exact or original |";

/** Columns the header declares, and therefore what a row and separator carry. */
const TABLE_COLUMNS = 4;

/** One separator cell, including the alignment colons GFM allows. */
const SEPARATOR_CELL = /^\s*:?-{3,}:?\s*$/;

/** A markdown heading line, which ends whatever section precedes it. */
const HEADING = /^\s{0,3}#{1,6}\s/;

/** Where the decision table sits, as a character range into the policy text. */
interface PolicyTableRange {
  start: number;
  end: number;
}

/**
 * The projection a client sees, plus the range an edit splices. The range is a
 * detail of this module's rewrite and is deliberately not published: a client
 * that spliced text itself would be composing policy the grammar has to read.
 */
export interface ParsedPrivacyPolicySchema {
  schema: PrivacyPolicySchema;
  table: PolicyTableRange;
}

/** The wire projection: what a client renders as named controls. */
export function parsePrivacyPolicySchema(policy: string): PrivacyPolicySchema | null {
  return readPrivacyPolicySchema(policy)?.schema ?? null;
}

export function readPrivacyPolicySchema(policy: string): ParsedPrivacyPolicySchema | null {
  const start = policy.indexOf(TABLE_HEADER);
  if (start === -1) return null;
  // A second table means the grammar is ambiguous — do not guess which one the
  // controls should drive.
  if (policy.indexOf(TABLE_HEADER, start + TABLE_HEADER.length) !== -1) return null;

  const rest = policy.slice(start);
  const lines = rest.split("\n");
  // Header, separator, then one line per row until the first non-row line.
  if (lines.length < 3 || !isSeparatorRow(lines[1]!)) return null;

  const rows: PrivacyPolicyRow[] = [];
  const labels = new Set<string>();
  let consumed = lines[0]!.length + 1 + lines[1]!.length;
  for (const line of lines.slice(2)) {
    if (!line.startsWith("|")) break;
    const row = parseRow(line);
    if (!row) return null;
    // A label is how an edit names its row. Two rows answering to one name make
    // every edit a coin flip, so the table is treated as unreadable instead.
    if (labels.has(row.label)) return null;
    labels.add(row.label);
    rows.push(row);
    consumed += 1 + line.length;
  }
  if (rows.length === 0) return null;

  return {
    schema: {
      rows,
      credentialApprovalEnabled: policy.includes(PRIVACY_POLICY_CREDENTIAL_APPROVAL_CLAUSE),
    },
    table: { start, end: start + consumed },
  };
}

/**
 * Applies a decision change to a policy by rebuilding only its table. Returns
 * null when the policy no longer parses or the edit names a row the table does
 * not have — a stale client must not be able to rewrite a policy it cannot see.
 */
export function applyPrivacyPolicySchemaEdit(
  policy: string,
  edit: PrivacyPolicySchemaEdit,
): string | null {
  const parsed = readPrivacyPolicySchema(policy);
  if (!parsed) return null;

  let rows = parsed.schema.rows;
  if (edit.row !== undefined) {
    const wanted = edit.row.normalize("NFC");
    const index = rows.findIndex((row) => row.label === wanted);
    if (index === -1) return null;
    const target = rows[index]!;
    rows = [
      ...rows.slice(0, index),
      {
        label: target.label,
        existence: edit.existence ?? target.existence,
        summary: edit.summary ?? target.summary,
        exact: edit.exact ?? target.exact,
      },
      ...rows.slice(index + 1),
    ];
  }

  const spliced =
    policy.slice(0, parsed.table.start) + renderTable(rows) + policy.slice(parsed.table.end);

  if (edit.credentialApprovalEnabled === undefined) return spliced;
  return applyCredentialApproval(spliced, edit.credentialApprovalEnabled);
}

/**
 * The credential opt-in is matched by the deterministic gate as an exact
 * substring, so it is added and removed as a whole line and never reworded.
 *
 * It also has to end up somewhere a reviewer model reads it as authoritative.
 * The protective templates close with a floor stating that credentials cannot
 * be released even with approval, so enabling the opt-in also replaces that one
 * sentence with the one the gate now enforces, and files the clause under the
 * section that collects approval requirements. Leaving both sentences standing
 * would hand the reviewer a policy that contradicts itself about the single
 * most consequential category.
 */
function applyCredentialApproval(policy: string, enabled: boolean): string {
  const present = policy.includes(PRIVACY_POLICY_CREDENTIAL_APPROVAL_CLAUSE);
  if (present === enabled) return policy;
  return enabled ? enableCredentialApproval(policy) : disableCredentialApproval(policy);
}

function enableCredentialApproval(policy: string): string {
  const reconciled = replaceOnce(
    policy,
    PRIVACY_POLICY_CREDENTIAL_DENY_SENTENCE,
    PRIVACY_POLICY_CREDENTIAL_APPROVAL_SENTENCE,
  );
  return fileUnderApprovalSection(reconciled, PRIVACY_POLICY_CREDENTIAL_APPROVAL_CLAUSE);
}

function disableCredentialApproval(policy: string): string {
  const withoutClause = policy
    .split("\n")
    .filter((line) => line !== PRIVACY_POLICY_CREDENTIAL_APPROVAL_CLAUSE);
  const restored = replaceOnce(
    dropEmptyApprovalSection(withoutClause).join("\n"),
    PRIVACY_POLICY_CREDENTIAL_APPROVAL_SENTENCE,
    PRIVACY_POLICY_CREDENTIAL_DENY_SENTENCE,
  );
  return restored;
}

/**
 * Append `clause` to the section that collects approval requirements, creating
 * that section at the end of the document when the policy has none.
 */
function fileUnderApprovalSection(policy: string, clause: string): string {
  const lines = policy.split("\n");
  const heading = lines.findIndex(
    (line) => line.trim() === PRIVACY_POLICY_APPROVAL_SECTION_HEADING,
  );
  if (heading === -1) {
    const kept = dropTrailingBlankLines(lines);
    return [...kept, "", PRIVACY_POLICY_APPROVAL_SECTION_HEADING, "", clause, ""].join("\n");
  }
  const end = sectionEnd(lines, heading);
  // After the section's last line of substance, so the clause joins the
  // requirements already there rather than splitting them from their heading.
  let insertAt = end;
  while (insertAt > heading + 1 && lines[insertAt - 1]!.trim() === "") insertAt -= 1;
  return [...lines.slice(0, insertAt), clause, ...lines.slice(insertAt)].join("\n");
}

/**
 * Drop the approval-requirements section once removing the clause has left it
 * with nothing to say, so enabling and disabling the opt-in round-trips back to
 * the original text. A section the operator wrote into is kept.
 */
function dropEmptyApprovalSection(lines: readonly string[]): string[] {
  const heading = lines.findIndex(
    (line) => line.trim() === PRIVACY_POLICY_APPROVAL_SECTION_HEADING,
  );
  if (heading === -1) return [...lines];
  const end = sectionEnd(lines, heading);
  if (lines.slice(heading + 1, end).some((line) => line.trim() !== "")) return [...lines];
  let start = heading;
  while (start > 0 && lines[start - 1]!.trim() === "") start -= 1;
  const kept = [...lines.slice(0, start), ...lines.slice(end)];
  // Removing a trailing section takes the document's final newline with it.
  if (end === lines.length) kept.push("");
  return kept;
}

/** The index one past the last line of the section opened at `heading`. */
function sectionEnd(lines: readonly string[], heading: number): number {
  let end = heading + 1;
  while (end < lines.length && !HEADING.test(lines[end]!)) end += 1;
  return end;
}

function dropTrailingBlankLines(lines: readonly string[]): string[] {
  const kept = [...lines];
  while (kept.length > 0 && kept.at(-1)!.trim() === "") kept.pop();
  return kept;
}

/** Literal single-occurrence replacement; `$` in `replacement` stays literal. */
function replaceOnce(text: string, search: string, replacement: string): string {
  const at = text.indexOf(search);
  if (at === -1) return text;
  return text.slice(0, at) + replacement + text.slice(at + search.length);
}

function renderTable(rows: readonly PrivacyPolicyRow[]): string {
  return [
    TABLE_HEADER,
    "| --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${row.label} | ${DECISION_TEXT[row.existence]} | ${DECISION_TEXT[row.summary]} | ${DECISION_TEXT[row.exact]} |`,
    ),
  ].join("\n");
}

function isSeparatorRow(line: string): boolean {
  const cells = splitRow(line);
  return cells !== null && cells.every((cell) => SEPARATOR_CELL.test(cell));
}

function parseRow(line: string): PrivacyPolicyRow | null {
  const cells = splitRow(line);
  if (!cells) return null;
  // Composed and decomposed spellings of an accented label look identical on
  // screen; folding both to NFC keeps the row addressable by what it displays.
  const label = cells[0]!.trim().normalize("NFC");
  const existence = existenceDecision(cells[1]!);
  const summary = DECISION_BY_TEXT.get(cells[2]!.trim().toLowerCase());
  const exact = DECISION_BY_TEXT.get(cells[3]!.trim().toLowerCase());
  if (!label || !existence || !summary || !exact) return null;
  return { label, existence, summary, exact };
}

/**
 * Upgrade the former Summary/Exact table to an explicit Existence/Summary/Exact
 * table. Copying Summary is conservative except for reductions: an existence
 * bit cannot be generalized, so those become per-watch approval.
 */
export function migrateLegacyPrivacyPolicyTable(policy: string): string {
  const start = policy.indexOf(LEGACY_TABLE_HEADER);
  if (start === -1 || policy.indexOf(LEGACY_TABLE_HEADER, start + 1) !== -1) return policy;
  const rest = policy.slice(start);
  const lines = rest.split("\n");
  if (lines.length < 3) return policy;
  const separator = splitRowColumns(lines[1]!, 3);
  if (
    !separator ||
    separator.length !== 3 ||
    !separator.every((cell) => SEPARATOR_CELL.test(cell))
  ) {
    return policy;
  }
  const rows: PrivacyPolicyRow[] = [];
  let consumed = lines[0]!.length + 1 + lines[1]!.length;
  for (const line of lines.slice(2)) {
    if (!line.startsWith("|")) break;
    const cells = splitRowColumns(line, 3);
    if (!cells || cells.length !== 3) return policy;
    const label = cells[0]!.trim().normalize("NFC");
    const summary = DECISION_BY_TEXT.get(cells[1]!.trim().toLowerCase());
    const exact = DECISION_BY_TEXT.get(cells[2]!.trim().toLowerCase());
    if (!label || !summary || !exact) return policy;
    rows.push({
      label,
      existence: summary === "reduce" ? "approve" : summary,
      summary,
      exact,
    });
    consumed += 1 + line.length;
  }
  if (rows.length === 0) return policy;
  return policy.slice(0, start) + renderTable(rows) + policy.slice(start + consumed);
}

/**
 * The cells of a pipe-bounded table row, or null when the line is not one.
 * Splitting a bounded row yields a leading and a trailing empty cell around the
 * real ones.
 */
function splitRow(line: string): string[] | null {
  return splitRowColumns(line, TABLE_COLUMNS);
}

function splitRowColumns(line: string, columns: number): string[] | null {
  const cells = line.split("|");
  if (cells.length !== columns + 2) return null;
  if (cells[0] !== "" || cells.at(-1)!.trim() !== "") return null;
  return cells.slice(1, -1);
}
