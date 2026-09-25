// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The one derivation both projection planes run.
 *
 * An analytics row and a document differ only in how a spec field names where
 * its value lives — a column, or a typed metadata field. Callers supply a
 * `read` that resolves a ref on their plane (including the `$semanticTime`
 * sentinel, which stands for the record's own declared event time) and get back
 * the same canonical fact either way. Identity columns, storage, and the
 * lifecycle around a contract change stay with each plane's store.
 */

import { createHash } from "node:crypto";
import {
  canonicalInstant,
  canonicalizeInterval,
  isTemporalKind,
  isTemporalModality,
  isTemporalStatus,
  type CanonicalInterval,
  type MappedProjectionField,
  type TemporalKind,
  type TemporalModality,
  type TemporalProjectionSpec,
  type TemporalStatus,
} from "@omnesis/core";

export interface DerivedTemporalFact extends CanonicalInterval {
  timeZone: string | null;
  label: string;
  kind: TemporalKind;
  modality: TemporalModality;
  status: TemporalStatus;
  sourceUpdatedAt: string | null;
  correlationKeys: Record<string, string | number | boolean | null> | null;
}

/** Resolve a spec ref to its raw value on one record of one plane. */
export type ReadRef = (ref: string) => unknown;

/**
 * Resolve a field that is either a constant or a mapped lookup.
 *
 * An unmapped or null value falls back to the spec's declared `default` rather
 * than dropping the record: a provider adding an enum value we have never seen
 * should degrade to a stated default, not silently lose the fact.
 */
function resolveMapped<T extends string>(
  field: MappedProjectionField<T, string>,
  read: ReadRef,
  guard: (value: unknown) => value is T,
  label: string,
  context: string,
): T {
  if (typeof field === "string") return field;
  const raw = read(field.from);
  const mapped = raw === null || raw === undefined ? undefined : field.map[String(raw)];
  const resolved = mapped ?? field.default;
  if (!guard(resolved)) {
    throw new Error(`${context}: temporal projection resolved an invalid ${label} '${resolved}'`);
  }
  return resolved;
}

function optionalInstant(value: unknown, label: string, context: string): string | null {
  if (value === null || value === undefined) return null;
  return canonicalInstant(value, `${context}: ${label}`).iso;
}

function scalarRecord(
  refs: readonly string[],
  read: ReadRef,
  context: string,
): Record<string, string | number | boolean | null> | null {
  if (refs.length === 0) return null;
  const result: Record<string, string | number | boolean | null> = {};
  for (const ref of refs) {
    const value = read(ref);
    if (value === undefined || value === null) result[ref] = null;
    else if (value instanceof Date) result[ref] = value.toISOString();
    else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[ref] = value;
    } else {
      throw new Error(`${context}: temporal correlation key '${ref}' must be scalar`);
    }
  }
  return result;
}

/**
 * Derive one canonical fact, or null when this record owns no fact for the
 * slot — either because the spec's eligibility gate declines it (calendar
 * sources use that gate to suppress recurrence masters whose occurrences the
 * provider cannot safely materialize), or because it carries no start.
 */
export function deriveTemporalFact(args: {
  spec: TemporalProjectionSpec<string>;
  read: ReadRef;
  /** Used when the spec declares no label ref, or the labelled value is empty. */
  fallbackLabel: string;
  /** Prefix for error messages — a table plus record key, or a document id. */
  context: string;
}): DerivedTemporalFact | null {
  const { spec, read, fallbackLabel, context } = args;
  if (spec.eligibility && read(spec.eligibility) !== true) return null;

  // A record that carries no start owns no projection. An absent date is a
  // record the slot simply does not describe — a task with no due date, a row
  // whose optional column is null — not a malformed one, so it is declined
  // rather than rejected. A present but unparseable date still throws below.
  const start = read(spec.start);
  if (start === undefined || start === null || start === "") return null;

  const interval = canonicalizeInterval({
    start,
    end: spec.end === undefined ? undefined : read(spec.end),
    // An explicit boolean ref wins; otherwise the value's own shape decides.
    allDay: spec.allDay ? read(spec.allDay) === true : undefined,
    context,
  });

  const labelled = spec.label === undefined ? undefined : read(spec.label);
  const label = String(labelled ?? "").trim() || fallbackLabel.trim() || "Untitled";

  return {
    ...interval,
    timeZone: spec.timeZone ? String(read(spec.timeZone) ?? "") || null : null,
    label,
    kind: resolveMapped(spec.kind, read, isTemporalKind, "kind", context),
    modality: resolveMapped(spec.modality, read, isTemporalModality, "modality", context),
    status: resolveMapped(spec.status ?? "active", read, isTemporalStatus, "status", context),
    sourceUpdatedAt: spec.sourceUpdatedAt
      ? optionalInstant(read(spec.sourceUpdatedAt), "sourceUpdatedAt", context)
      : null,
    correlationKeys: scalarRecord(spec.correlationKeys ?? [], read, context),
  };
}

/**
 * Identity of a projected fact: stable across re-derivation so a re-sync
 * updates a row rather than accumulating duplicates. The parts are whatever
 * uniquely names the record on its plane, plus the slot.
 */
export function stableProjectionId(...parts: readonly string[]): string {
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
  return `tp_${digest}`;
}

/**
 * Content-derived token that changes whenever the projected fact changes.
 * Read surfaces expose it so a client can tell a re-projection that altered
 * nothing from one that moved the fact.
 */
export function projectionRevision(fact: {
  startCanonical: string;
  endCanonical: string;
  label: string;
  kind: string;
  modality: string;
  status: string;
  sourceUpdatedAt: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        start: fact.startCanonical,
        end: fact.endCanonical,
        label: fact.label,
        kind: fact.kind,
        modality: fact.modality,
        status: fact.status,
        sourceUpdatedAt: fact.sourceUpdatedAt,
      }),
    )
    .digest("hex")
    .slice(0, 24);
}
