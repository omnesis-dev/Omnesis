// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Request-body schemas for the routes mounted in `routes/web-capture-policy.ts`. */
import { z } from "zod";
import { MAX_CAPTURE_DOMAIN_CHARS } from "@omnesis/provider-web/capture-policy";

/** Longest pasted address a browser may submit as a domain to exclude. */
const MAX_DOMAIN_INPUT_CHARS = 2_048;

// POST /web-capture-policy/excluded-domains — a pasted URL or bare host; the
// service normalizes it. `purge` also deletes every page already captured
// from the domain for good.
export const addExcludedDomainBody = z.object({
  domain: z.string().min(1).max(MAX_DOMAIN_INPUT_CHARS),
  purge: z.boolean().optional(),
});

// PUT /web-capture-policy/pause — `until: null` pauses until someone resumes.
export const setCapturePauseBody = z.object({
  until: z.number().int().nonnegative().nullable(),
});

/** Path parameter of `DELETE /web-capture-policy/excluded-domains/:domain`. */
export const excludedDomainParam = z.string().min(1).max(MAX_CAPTURE_DOMAIN_CHARS);
