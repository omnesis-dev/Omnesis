// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `entity_context` — a READ-ONLY reap of the cognitive graph. Given one seed
 * entity (a document, a person, or a tracked loop), it returns the connected
 * loops / documents / people / temporal annotations the background Cognition Steward has
 * linked around it — the neighbourhood the agent would otherwise reconstruct by
 * stitching many `search_loops` / `fetch_loop` / `fetch_document` calls
 * together. Available in experimental mode to BOTH the interactive (chat) agent
 * and the background Cognition Steward.
 *
 * Pointer-only: it returns ids + labels + light attributes, not bodies. The
 * agent follows the ids with its existing fetch tools when it needs detail.
 */

import { z } from "zod";

import type { ToolResult } from "@omnesis/core";

import type { ToolContext, ToolHandle } from "../backend.js";
import type { EntityContextPort, EntityContextSeedKind } from "./types.js";

const SEED_KINDS = [
  "document",
  "person",
  "loop",
] as const satisfies readonly EntityContextSeedKind[];

const entityContextArgsSchema = z
  .object({
    kind: z
      .enum(SEED_KINDS)
      .describe(
        "What the seed id refers to: a document, a person (canonical id), or a tracked loop.",
      ),
    id: z.string().min(1).describe("The seed entity's id (document id, person id, or loop id)."),
    depth: z
      .number()
      .int()
      .min(1)
      .max(3)
      .optional()
      .describe(
        "How many hops out from the seed to gather (default 2). 1 = the seed's " +
          "direct links; 2 also pulls each linked loop's docs/people/related loops.",
      ),
  })
  .strict();

export interface EntityContextToolDeps {
  port: EntityContextPort;
}

export function createEntityContextTool(deps: EntityContextToolDeps): ToolHandle {
  return {
    name: "entity_context",
    description:
      "Reap the cognitive neighbourhood around ONE entity in a single call: " +
      "given a document, person, or tracked loop, return the connected open " +
      "loops, source documents, people (with any notes the agent recorded about " +
      "them), and dated temporal annotations the background agent has linked. Use " +
      'this for "everything connected to X" / "what am I tracking about X" ' +
      "questions instead of stitching many searches together. Returns ids + " +
      "labels (pointer-only); fetch the ids for detail. READ-ONLY. An empty " +
      "result (seed:null or no neighbours) is a successful call.",
    schema: entityContextArgsSchema,
    summarize(args: unknown): string | undefined {
      if (!args || typeof args !== "object") return undefined;
      const a = args as Record<string, unknown>;
      if (typeof a.kind !== "string" || typeof a.id !== "string") return undefined;
      return `${a.kind}:${a.id}`;
    },
    async invoke(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = entityContextArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          kind: "error",
          code: "invalid_args",
          message: parsed.error.issues[0]?.message ?? "invalid arguments",
        };
      }
      const { kind, id, depth } = parsed.data;
      try {
        const result = await deps.port.reap({ kind, id }, { depth }, ctx.abortSignal);
        return {
          kind: "structured",
          resultType: "entity_context.reaped",
          data: result,
        };
      } catch (err) {
        return {
          kind: "error",
          code: "entity_context_failed",
          message: (err as Error).message ?? "entity_context failed",
        };
      }
    },
  };
}
