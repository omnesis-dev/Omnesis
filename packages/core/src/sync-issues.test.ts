// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { boundSyncIssues, syncIssuesSchema, MAX_SYNC_ISSUES } from "./sync-issues.js";
import { parseEventPayload } from "./ws-messages.js";
import type { SyncIssue } from "@omnesis/types";

const issue: SyncIssue = {
  scope: "partition",
  kind: "permission",
  count: 1,
  message: "Example folder unavailable",
  subject: "Example folder",
};
test("large issue lists aggregate, bound text and retain snapshot diagnostics", () => {
  const input = Array.from({ length: 80 }, (_, i) => ({
    ...issue,
    subject: `Example ${i}`,
    message: "x".repeat(4000),
  }));
  input.push({ ...issue, code: "snapshot-withheld" } as (typeof input)[number]);
  const result = boundSyncIssues(input);
  expect(syncIssuesSchema.safeParse(result).success).toBe(true);
  expect(result).toHaveLength(MAX_SYNC_ISSUES);
  expect(result[0]?.code).toBe("snapshot-withheld");
  expect(result.at(-1)?.code).toBe("additional-sync-issues");
  expect(boundSyncIssues([issue, issue])[0]?.count).toBe(2);
});
test("legacy omission and malformed issues retain a valid surrounding status", () => {
  for (const issues of [undefined, { invalid: true }, Array.from({ length: 51 }, () => issue)]) {
    const parsed = parseEventPayload("sync.status", {
      sourceId: "example:local",
      state: "completed",
      issues,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.issues).toBeUndefined();
  }
});

test("a malformed partial assessment cannot degrade into a full warning clear", () => {
  for (const issueAssessments of [
    { invalid: true },
    [{ scope: "partition" }],
    Array.from({ length: 51 }, () => ({ code: "invalid-snapshot", scope: "partition" })),
  ]) {
    expect(
      parseEventPayload("sync.status", {
        sourceId: "example:local",
        state: "completed",
        issues: [],
        issueAssessments,
      }).ok,
    ).toBe(false);
  }
});
