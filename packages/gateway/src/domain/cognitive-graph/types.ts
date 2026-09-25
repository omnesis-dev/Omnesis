// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The cognitive graph's own vertex/edge vocabulary — deliberately SEPARATE from
 * the raw document graph's `GraphVertexKind` (`@omnesis/core/graph`). These
 * kinds never enter a `DocumentGraph`, a `TrailEvent`, or the `/graph/walk`
 * wire schema; they surface only through the reap projection ({@link
 * CognitiveNeighborhood}), which is its own response type. That separation is
 * what keeps the closed render/decode paths (portal SVG, iOS/Android trail
 * decoders) frozen while the cognitive layer grows.
 */

import type { WalkVertex } from "../graph-engine/bounded-walk.js";

/** Entities the cognitive graph traverses. `document` + `person` overlap the raw graph's kinds but are cognitive-typed here. */
export type CognitiveVertexKind = "document" | "person" | "loop" | "temporal-annotation";

interface BaseVertex extends WalkVertex {
  readonly kind: CognitiveVertexKind;
}

interface CogDocumentVertex extends BaseVertex {
  readonly kind: "document";
  readonly documentId: string;
  readonly title?: string;
  readonly sourceId?: string;
}

interface CogPersonVertex extends BaseVertex {
  readonly kind: "person";
  readonly personId: string;
  readonly name: string;
  /** Agent-authored claims about this person (decorations, not their own vertices). */
  notes?: string[];
}

interface CogLoopVertex extends BaseVertex {
  readonly kind: "loop";
  readonly loopId: string;
  readonly title: string;
  readonly state: string;
  readonly importance?: number;
}

interface CogTemporalAnnotationVertex extends BaseVertex {
  readonly kind: "temporal-annotation";
  readonly annotationId: string;
  readonly sentence: string;
  readonly when?: string;
  readonly annotationKind?: string;
}

export type CognitiveVertex =
  | CogDocumentVertex
  | CogPersonVertex
  | CogLoopVertex
  | CogTemporalAnnotationVertex;

/**
 * How two cognitive entities relate. All cognitive edges are agent-authored
 * (`llm-derived` provenance). Undirected relations (`related-to`) normalise
 * their endpoints in the de-dup key.
 */
export type CognitiveEdgeType =
  | "involves" // loop ↔ person (actor or involved)
  | "grounds-in" // loop ↔ document (source material)
  | "related-to" // loop ↔ loop (grouped on a live brief)
  | "dated-in" // temporal annotation ↔ {loop, person} (subject of a dated fact)
  | "evidenced-by"; // temporal annotation ↔ document (source atom)

/** All cognitive edges are agent-authored and modelled undirected. */
export interface CognitiveEdge {
  readonly from: string;
  readonly to: string;
  readonly type: CognitiveEdgeType;
}

// ─── The reap projection (the tool/HTTP result) ───────────────────────────

/** A loop reached from the seed. */
interface ReapedLoop {
  loopId: string;
  title: string;
  state: string;
  importance?: number;
}
/** A document reached from the seed. */
interface ReapedDocument {
  documentId: string;
  title?: string;
  sourceId?: string;
}
/** A person reached from the seed, with any agent-authored claims about them. */
interface ReapedPerson {
  personId: string;
  name: string;
  notes?: string[];
}
/** A temporal annotation reached from the seed. */
interface ReapedTemporalAnnotation {
  annotationId: string;
  sentence: string;
  when?: string;
  kind?: string;
}

/** What the reap resolved the seed to (or null if it doesn't exist / isn't cognitive). */
interface ReapedSeed {
  kind: CognitiveVertexKind;
  id: string;
  label: string;
}

/**
 * The cognitive neighbourhood around one seed entity — a pointer-only,
 * per-kind-capped projection grouped by kind. This is the reap tool's result.
 * Never contains document/message bodies; the agent follows the ids with its
 * existing fetch tools if it needs more.
 */
export interface CognitiveNeighborhood {
  seed: ReapedSeed | null;
  loops: ReapedLoop[];
  documents: ReapedDocument[];
  people: ReapedPerson[];
  temporalAnnotations: ReapedTemporalAnnotation[];
  /**
   * True when a per-kind cap or the vertex ceiling dropped members — i.e. the
   * returned lists are a sample, not the whole reachable set. This is the only
   * completeness signal (`counts` below reports what was returned, not the true
   * reachable total).
   */
  truncated: boolean;
  /** The returned per-kind counts (== the array lengths), for convenience. */
  counts: { loops: number; documents: number; people: number; temporalAnnotations: number };
}
