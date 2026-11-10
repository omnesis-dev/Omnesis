// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Request-body schemas for the decision model routes in `models/decision-routes.ts`. */
import { z } from "zod";

// POST /admin/inference/decision-backends/:key/verify, /admin/inference/typesafe/verify
export const decisionModelBody = z.object({ model: z.string().trim().min(1).max(256) }).strict();
export type DecisionModelBody = z.infer<typeof decisionModelBody>;

// POST /admin/inference/decision-backends/probe — a server not saved yet.
export const decisionProbeBody = z
  .object({
    url: z.string().url().max(2048),
    preset: z.string().min(1).max(64).optional(),
    protocol: z.enum(["systemone", "workers-ai", "openai-decisions"]).optional(),
    auth: z.enum(["bearer", "api-key", "x-api-key"]).optional(),
    apiKey: z.string().min(1).max(4096).optional(),
  })
  .strict();
export type DecisionProbeBody = z.infer<typeof decisionProbeBody>;
