// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Request-body schemas for the developer-annotations routes
 * (`routes/dev-annotations.ts`). The whole surface is gated behind
 * `OMNESIS_DEV_MODE`; these validate the operator-authored note payloads at
 * the wire boundary.
 */
import { z } from "zod";
import { DEV_ANNOTATION_TARGET_TYPES } from "../../dev-annotations/store.js";
import { nonEmptyString } from "./common.js";

// POST /dev/annotations
export const createDevAnnotationBody = z
  .object({
    targetType: z.enum(DEV_ANNOTATION_TARGET_TYPES),
    /** Opaque entity id; omitted / null only for a free-form `route` note. */
    targetId: z.string().min(1).max(512).nullish(),
    note: nonEmptyString.max(8000),
    /** Denormalized snapshot of what the operator was looking at. */
    context: z.record(z.string(), z.unknown()).nullish(),
    deepLink: z.string().max(2048).nullish(),
    client: z.enum(["portal", "ios", "android"]).nullish(),
  })
  .superRefine((body, ctx) => {
    // Most target kinds are addressed by an opaque id, so it must be present.
    // The exceptions are the idless singletons: `route` (a free-form note
    // tagged with a screen) and `agent_notes` (the one steward notes blob).
    // Declared here (a 400) rather than in the handler so the boundary owns
    // the whole validation contract.
    if (body.targetType !== "route" && body.targetType !== "agent_notes" && !body.targetId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetId"],
        message: `a ${body.targetType} annotation requires a targetId`,
      });
    }
  });
export type CreateDevAnnotationBody = z.infer<typeof createDevAnnotationBody>;

// POST /dev/annotations/:id/resolve
export const resolveDevAnnotationBody = z.object({
  /** Optional "what I did" note recorded on resolution. */
  note: z.string().nullish(),
});
export type ResolveDevAnnotationBody = z.infer<typeof resolveDevAnnotationBody>;
