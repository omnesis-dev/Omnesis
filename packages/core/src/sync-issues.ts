// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { syncRemediationSchema } from "./sync-remediation.js";
import type { SyncIssue, SyncIssueAssessment } from "@omnesis/types";

export const MAX_SYNC_ISSUES = 50;
export const syncIssueSchema = z.object({
  code: z.string().max(100).optional(),
  scope: z.enum(["item", "partition"]),
  kind: z.enum(["auth", "network", "rate-limit", "permission", "transient", "unknown"]),
  count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  subject: z.string().max(512).optional(),
  message: z.string().max(2000),
  remediation: syncRemediationSchema.optional(),
}) satisfies z.ZodType<SyncIssue>;
export const syncIssuesSchema = z.array(syncIssueSchema).max(MAX_SYNC_ISSUES);
export const syncIssueAssessmentsSchema = z
  .array(
    syncIssueSchema
      .pick({ code: true, scope: true, subject: true })
      .extend({ code: z.string().min(1).max(100) }),
  )
  .max(MAX_SYNC_ISSUES);
export function syncIssueIdentity(issue: SyncIssue | SyncIssueAssessment): string {
  return JSON.stringify([
    issue.code ?? ("kind" in issue ? issue.kind : ""),
    issue.scope,
    issue.subject ?? (issue.code ? null : "message" in issue ? issue.message : null),
  ]);
}
export const syncIssueStatusSchema = syncIssueSchema.extend({
  since: z.number().finite().nonnegative(),
});

/** Preserve useful diagnoses without letting a large provider page lose its status event. */
export function boundSyncIssues(issues: readonly SyncIssue[]): SyncIssue[] {
  const grouped = new Map<string, SyncIssue>();
  for (const issue of issues) {
    const bounded = {
      ...issue,
      code: issue.code?.slice(0, 100),
      subject: issue.subject?.slice(0, 512),
      message: issue.message.slice(0, 2000),
      count: Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(issue.count) || 0)),
      remediation: syncRemediationSchema.safeParse(issue.remediation).data,
    };
    const key = syncIssueIdentity(bounded);
    const prior = grouped.get(key);
    if (prior) prior.count = Math.min(Number.MAX_SAFE_INTEGER, prior.count + bounded.count);
    else grouped.set(key, bounded);
  }
  const result = [...grouped.values()].sort(
    (a, b) => Number(b.code === "snapshot-withheld") - Number(a.code === "snapshot-withheld"),
  );
  if (result.length <= MAX_SYNC_ISSUES) return result;
  const omitted = result.slice(MAX_SYNC_ISSUES - 1);
  return [
    ...result.slice(0, MAX_SYNC_ISSUES - 1),
    {
      code: "additional-sync-issues",
      scope: "partition",
      kind: "unknown",
      count: omitted.reduce(
        (sum, issue) => Math.min(Number.MAX_SAFE_INTEGER, sum + issue.count),
        0,
      ),
      message: `${omitted.length} additional diagnostic groups were omitted; inspect collector diagnostics for the affected data.`,
    },
  ];
}
