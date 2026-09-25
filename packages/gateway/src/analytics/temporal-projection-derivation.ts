// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The analytics plane's adapter onto the shared projection derivation.
 *
 * Everything here is about naming an analytics row — resolving column refs,
 * serializing a primary key, reconstructing a bound document's external id.
 * The fact itself comes from `deriveTemporalFact`, which the document plane
 * runs too, so the two planes cannot drift. DuckDB lifecycle and persistence
 * stay in `temporal-projection-store.ts`.
 */

import {
  deriveTemporalFact,
  stableProjectionId,
} from "../enrichment/temporal-projections/derive.js";
import type {
  AnalyticsTableSchema,
  AnalyticsTemporalProjectionSpec,
  TemporalIntervalPrecision,
  TemporalStatus,
} from "@omnesis/core";

export interface DerivedAnalyticsProjection extends Record<string, unknown> {
  id: string;
  source_id: string;
  table_name: string;
  record_key: string;
  slot: string;
  bound_document_external_id: string | null;
  start_ms: number;
  end_exclusive_ms: number;
  start_canonical: string;
  end_canonical: string;
  precision: TemporalIntervalPrecision;
  all_day: boolean;
  time_zone: string | null;
  label: string;
  kind: string;
  modality: string;
  status: TemporalStatus;
  source_updated_at: string | null;
  correlation_keys: string | null;
  projected_at: string;
}

function canonicalContractJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalContractJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalContractJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

export function sameProjectionContract(
  previous: AnalyticsTemporalProjectionSpec,
  next: AnalyticsTemporalProjectionSpec | undefined,
): boolean {
  return next !== undefined && canonicalContractJson(previous) === canonicalContractJson(next);
}

export function serializeRecordKey(
  primaryKey: readonly string[],
  record: Record<string, unknown>,
): string {
  if (primaryKey.length === 0) {
    throw new Error("Temporal projection requires a non-empty analytics primary key");
  }
  const key: Record<string, string | number | boolean | null> = {};
  for (const column of primaryKey) {
    const raw = record[column];
    if (raw === undefined || raw === null) {
      throw new Error(`Temporal projection primary-key column '${column}' is null`);
    }
    if (typeof raw === "object") {
      throw new Error(`Temporal projection primary-key column '${column}' must be scalar`);
    }
    key[column] = raw as string | number | boolean;
  }
  return JSON.stringify(key);
}

function boundDocumentExternalId(
  schema: AnalyticsTableSchema,
  record: Record<string, unknown>,
): string | null {
  const binding = schema.boundDocument;
  if (!binding) return null;
  const components = binding.externalIdColumns.map((column) => {
    const value = record[column];
    if (value === undefined || value === null) {
      throw new Error(`Temporal projection bound-document column '${column}' is null`);
    }
    return String(value);
  });
  const joined = components.join(binding.externalIdSeparator ?? ":");
  return `${binding.externalIdPrefix ?? ""}${joined}`;
}

/**
 * Derive one row's projection, or null when the spec's eligibility gate
 * declines this record.
 */
export function deriveAnalyticsProjection(args: {
  schema: AnalyticsTableSchema;
  spec: AnalyticsTemporalProjectionSpec;
  sourceId: string;
  record: Record<string, unknown>;
  recordKey: string;
  projectedAt: string;
}): DerivedAnalyticsProjection | null {
  const { schema, spec, sourceId, record, recordKey, projectedAt } = args;
  const semanticTimeColumn = schema.semanticTimeColumn;
  if (!semanticTimeColumn) {
    throw new Error("Temporal projection schema has no semantic time column");
  }

  const fact = deriveTemporalFact({
    spec,
    // `$semanticTime` is the one ref that does not name a column directly.
    read: (ref) => record[ref === "$semanticTime" ? semanticTimeColumn : ref],
    fallbackLabel: "",
    context: `${schema.tableName} ${recordKey}`,
  });
  if (!fact) return null;

  return {
    id: stableProjectionId(sourceId, schema.tableName, recordKey, spec.slot),
    source_id: sourceId,
    table_name: schema.tableName,
    record_key: recordKey,
    slot: spec.slot,
    bound_document_external_id: boundDocumentExternalId(schema, record),
    start_ms: fact.startMs,
    end_exclusive_ms: fact.endExclusiveMs,
    start_canonical: fact.startCanonical,
    end_canonical: fact.endCanonical,
    precision: fact.precision,
    all_day: fact.allDay,
    time_zone: fact.timeZone,
    label: fact.label,
    kind: fact.kind,
    modality: fact.modality,
    status: fact.status,
    source_updated_at: fact.sourceUpdatedAt,
    correlation_keys: fact.correlationKeys ? JSON.stringify(fact.correlationKeys) : null,
    projected_at: projectedAt,
  };
}
