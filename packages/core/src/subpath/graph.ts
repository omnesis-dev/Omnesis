// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `@omnesis/core/graph` — the Omnesis graph schema: the vocabulary of
 * vertex / edge kinds, their provenance + direction descriptors, and the
 * materialised-walk DTOs. Pure types + pure functions, no database.
 *
 * Importing from this subpath signals the consumer is working with the
 * cross-document graph (the walker, the trail/graph routes, the agent
 * trace_connections tool).
 */

export type {
  GraphVertexKind,
  GraphVertex,
  GraphEdgeType,
  NearDuplicateEdgeType,
  SameEntityEdgeType,
  GraphEdgeProvenanceKind,
  GraphEdgeStorage,
  GraphEdgeEndpoints,
  GraphEdgeDescriptor,
  GraphEdge,
  DocumentGraph,
  BuildDocumentGraphOptions,
} from "../graph.js";

export {
  NEAR_DUPLICATE_EDGE_TYPE,
  SAME_ENTITY_EDGE_TYPE,
  analyticsRowKey,
  GRAPH_EDGE_TYPES,
  graphEdgeDescriptors,
  graphEdgeDescriptor,
  graphEdgeProvenance,
  isGraphEdgeType,
} from "../graph.js";
