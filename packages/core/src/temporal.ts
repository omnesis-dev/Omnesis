// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Shared read model for Omnesis' three temporal layers.
 *
 * Projections are deterministic, source-owned facts. Annotations are mutable
 * interpretations owned by the cognition agent. Mentions are dates written in
 * a document's text, found by the deterministic date recognizer: they say that
 * a document refers to a day or a month, and nothing about what happens then.
 * The union is intentionally read-only: mutation ports accept annotation ids
 * and live elsewhere.
 *
 * The vocabulary both layers speak lives in `temporal-vocabulary.ts` and is
 * re-exported here so this module stays the one import a reader of the read
 * model needs.
 */
export type {
  TemporalOrigin,
  TemporalKind,
  TemporalModality,
  TemporalStatus,
  TemporalPrecision,
} from "./temporal-vocabulary.js";

import type {
  TemporalOrigin,
  TemporalKind,
  TemporalModality,
  TemporalStatus,
  TemporalPrecision,
} from "./temporal-vocabulary.js";

export interface TemporalQueryInput {
  /**
   * ISO instant (offset/Z required), YYYY-MM-DD, YYYY-MM, YYYY, or a relative
   * calendar expression such as `-7d`, `+2w`, `-1M`, `+1y`.
   */
  from: string;
  /** Exclusive range end. Omit to query the whole coarse `from` period. */
  to?: string;
  /** IANA time zone used for date-only and relative expressions. */
  timeZone: string;
  /**
   * Which layers to read. Omitted means projections and annotations: mentions
   * are numerous and unclassified, so a caller asks for them by name.
   */
  origins?: TemporalOrigin[];
  kinds?: TemporalKind[];
  modalities?: TemporalModality[];
  statuses?: TemporalStatus[];
  sourceIds?: string[];
  documentIds?: string[];
  entityIds?: string[];
  limit?: number;
  /**
   * Opaque keyset cursor returned by the previous query.
   *
   * A page walk is a best-effort view of live projection and annotation
   * stores, not a cross-store snapshot. Rows whose sort key changes while a
   * walk is in progress can be omitted or returned again; accumulating
   * clients should de-duplicate by temporal item id.
   */
  cursor?: string;
}

export interface TemporalProjectionProvenance {
  sourceId: string;
  slot: string;
  tableName?: string;
  recordKey?: Record<string, string | number | boolean | null>;
  documentId?: string;
  documentExternalId?: string;
  correlationKeys?: Record<string, string | number | boolean | null>;
  sourceUpdatedAt?: string;
  projectedAt: string;
  /** Content-derived token that changes whenever the projected fact changes. */
  revision: string;
}

export interface TemporalAnnotationProvenance {
  documentIds: string[];
  personIds: string[];
  loopIds: string[];
  projectionIds: string[];
  confidence?: number;
  rationale?: string;
  createdByRun: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface TemporalMentionProvenance {
  documentId: string;
  sourceId: string;
  /** The phrase as written in the document, e.g. "next Friday" or "12 October". */
  text: string;
  /** True when the phrase was relative and resolved against the document's own date. */
  relative: boolean;
  /**
   * Open-ended phrasing ("before", "after", "since", "until"). The item's
   * interval is then the one bound the phrase names, not the open range.
   */
  mod?: string;
}

export interface TemporalItem {
  id: string;
  origin: TemporalOrigin;
  start: string;
  /** Canonical half-open end. Always strictly later than `start`. */
  endExclusive: string;
  /**
   * True when the item starts or ends INSIDE the query window — the window
   * is one of its own boundaries, not merely a slice of a longer span. A
   * window whose every item merely spans it (a trip-long rental, a
   * multi-year warranty) describes nothing about those days; the anchored
   * distinction is what separates "this day is described" from "this day
   * sits inside something long". Set by the query, relative to its window.
   */
  anchored?: boolean;
  precision: TemporalPrecision;
  allDay: boolean;
  timeZone?: string;
  label: string;
  kind: TemporalKind;
  modality: TemporalModality;
  status: TemporalStatus;
  projection?: TemporalProjectionProvenance;
  annotation?: TemporalAnnotationProvenance;
  mention?: TemporalMentionProvenance;
}

export interface TemporalProjectionCoverage {
  sourceId: string;
  tableName?: string;
  slots: string[];
  lastMaterializedAt?: string;
  lastSyncAt?: string;
}

export interface TemporalSpecialistCoverage {
  sourceId: string;
  queryVia: "analytics" | "search";
  reason: "high-volume" | "not-projected" | "timeless";
  lastSyncAt?: string;
}

export interface TemporalCoverage {
  projectionSources: TemporalProjectionCoverage[];
  specialistSources: TemporalSpecialistCoverage[];
  /**
   * Annotations carry no per-source coverage accounting — the flag's name is
   * a wire-compat relic. Their bar is near-exhaustive per document, but no
   * completeness claim over the corpus can be made for them.
   */
  annotations: { selective: true };
  /**
   * Present when the query read mentions. Documents still waiting for the
   * date recognizer contribute no mentions yet, so a non-zero
   * `pendingDocuments` means a thin mention result may only be incomplete.
   * `countCapped` means the window holds more mentions than were counted, so
   * `summary.anchored` is a floor. `unworthyHidden` means the mention worth
   * gate applied to this read: mentions from email judged not worth recording
   * (marketing, newsletters, notifications) are left out. It is never set when
   * the caller names documents, which are always read.
   */
  mentions?: { pendingDocuments: number; countCapped?: true; unworthyHidden?: true };
}

export interface TemporalQueryResult {
  type: "temporal.results";
  window: {
    start: string;
    endExclusive: string;
    timeZone: string;
  };
  items: TemporalItem[];
  /**
   * How many matched items (across the whole window, not just this page)
   * are anchored in it vs merely spanning it. "0 anchored, 12 spanning"
   * means the window itself is undescribed however many rows came back.
   */
  summary: { anchored: number; spanning: number };
  coverage: TemporalCoverage;
  truncated: boolean;
  nextCursor?: string;
}
