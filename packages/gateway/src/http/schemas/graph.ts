// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Request-body schema for `POST /graph/walk`. Re-validated at the
 * boundary because callers (MCP agents, the CLI, hand-rolled curl) live outside
 * the gateway's compile unit. The numeric bounds mirror the walker's internal
 * clamps so an out-of-range value is rejected loudly rather than silently
 * clamped.
 */
import { z } from "zod";

const vertexRefShape = z.object({
  kind: z.enum(["document", "person", "analytics-row"]),
  id: z.string().min(1),
});

export const graphWalkBody = z.object({
  start: z.array(vertexRefShape).min(1).max(50),
  // Edge types stay a free string array: the walker traverses any
  // document_links.link_type value, so the closed vocabulary is a label here,
  // not a runtime gate.
  edgeTypes: z.array(z.string()).optional(),
  vertexTypes: z.array(z.enum(["document", "person", "analytics-row"])).optional(),
  maxHops: z.number().int().min(1).max(15).optional(),
  maxResults: z.number().int().min(10).max(2000).optional(),
  fanoutCap: z.number().int().min(1).max(500).optional(),
  provenanceKinds: z
    .array(z.enum(["source-declared", "content-derived", "cross-source-derived", "llm-derived"]))
    .optional(),
  minScore: z.number().min(0).max(1).optional(),
  includeBoundRows: z.boolean().optional(),
});
export type GraphWalkBody = z.infer<typeof graphWalkBody>;
