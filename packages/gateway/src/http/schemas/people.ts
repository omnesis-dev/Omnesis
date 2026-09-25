// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Request-body schemas for routes mounted in `routes/people.ts`.
 *
 * `/people/merge-rules` POST validation still flows through
 * `personService.parseCreateMergeRuleInput()` because the rule shape is
 * polymorphic on `aliasType`; we validate the wrapper shape here and let
 * the service do the discriminated-union work.
 */
import { z } from "zod";

// POST /documents/people-bulk
export const peopleBulkBody = z.object({
  ids: z.array(z.string()).max(200, "Too many ids (max 200)"),
});
export type PeopleBulkBody = z.infer<typeof peopleBulkBody>;

// POST /people/merge-candidates/:id/accept
export const acceptMergeCandidateBody = z.object({
  winnerSide: z.enum(["a", "b"]),
  reason: z.string().nullable().optional(),
});
export type AcceptMergeCandidateBody = z.infer<typeof acceptMergeCandidateBody>;

// POST /people/merge-candidates/merge-cluster — unify a set of people.
export const mergeClusterBody = z.object({
  personIds: z.array(z.string().min(1)).min(2, "Need at least two people to merge"),
  reason: z.string().nullable().optional(),
});
export type MergeClusterBody = z.infer<typeof mergeClusterBody>;

// POST /people/merge-rules — accepts an arbitrary record; the service does
// the discriminated-union validation. We just enforce "is an object".
export const createMergeRuleBody = z.record(z.string(), z.unknown());
export type CreateMergeRuleBody = z.infer<typeof createMergeRuleBody>;
