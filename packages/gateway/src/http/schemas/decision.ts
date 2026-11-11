// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Request-body schemas for the decision model routes in `models/decision-routes.ts`. */
import { z } from "zod";

// POST /admin/inference/backends/:key/decision/verify, /admin/inference/typesafe/verify
export const decisionModelBody = z.object({ model: z.string().trim().min(1).max(256) }).strict();
export type DecisionModelBody = z.infer<typeof decisionModelBody>;

// POST /admin/inference/decision/probe — a decision API not saved yet. `backendKey`
// names a saved backend whose API key to send when the body carries none, so a
// form adding decisions to an existing backend never asks for its key again.
export const decisionProbeBody = z
  .object({
    url: z.string().url().max(2048),
    preset: z.string().min(1).max(64).optional(),
    protocol: z.enum(["systemone", "workers-ai", "openai-decisions"]).optional(),
    auth: z.enum(["bearer", "api-key", "x-api-key"]).optional(),
    apiKey: z.string().min(1).max(4096).optional(),
    backendKey: z.string().min(1).max(256).optional(),
  })
  .strict();
export type DecisionProbeBody = z.infer<typeof decisionProbeBody>;
