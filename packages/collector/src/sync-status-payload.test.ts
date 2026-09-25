// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { toSyncStatusPayload } from "./sync-status-payload.js";
import type { SourceStatus } from "./source-lifecycle.js";

function status(over: Partial<SourceStatus>): SourceStatus {
  return {
    sourceId: "vault-notes:operator",
    providerId: "vault:operator",
    sourceName: "vault-notes",
    state: "idle",
    ...over,
  };
}

describe("toSyncStatusPayload", () => {
  test("partial assessment keys travel only with a completed report", () => {
    const issueAssessments = [
      { code: "invalid-snapshot", scope: "partition" as const, subject: "table_one" },
    ];
    const assessed = status({ issues: [], issueAssessments });
    expect(
      toSyncStatusPayload({ event: "sync.completed", sourceId: "example:local", status: assessed }),
    ).toMatchObject({ issues: [], issueAssessments });
    expect(
      toSyncStatusPayload({ event: "sync.progress", sourceId: "example:local", status: assessed })
        .issueAssessments,
    ).toBeUndefined();
  });
  test("only completion explicitly reports issue recovery", () => {
    const complete = toSyncStatusPayload({
      event: "sync.completed",
      sourceId: "example:local",
      status: status({}),
    });
    expect(complete.issues).toBeUndefined();
    expect(
      toSyncStatusPayload({
        event: "sync.completed",
        sourceId: "example:local",
        status: status({ issues: [] }),
      }).issues,
    ).toEqual([]);
    const progress = toSyncStatusPayload({
      event: "sync.progress",
      sourceId: "example:local",
      status: status({}),
    });
    expect(progress.issues).toBeUndefined();
    expect(
      toSyncStatusPayload({
        event: "sync.error",
        sourceId: "example:local",
        status: status({ issues: [] }),
      }).issues,
    ).toBeUndefined();
    const issues = [
      {
        code: "snapshot-withheld",
        scope: "partition" as const,
        kind: "unknown" as const,
        count: 1,
        message: "Example partition unavailable",
      },
    ];
    expect(
      toSyncStatusPayload({
        event: "sync.completed",
        sourceId: "example:local",
        status: status({ issues }),
      }).issues,
    ).toEqual(issues);
  });
  test("an error carries its message and its structured remedy verbatim", () => {
    const remediation = {
      summary: "Disk access is required",
      steps: ["Open the privacy settings pane."],
      executable: "/opt/example/bin/node",
      restartRequired: true,
    };
    const payload = toSyncStatusPayload({
      event: "sync.error",
      sourceId: "vault-notes:operator",
      status: status({ state: "error", lastError: "Cannot open the database", remediation }),
    });
    expect(payload).toMatchObject({
      sourceId: "vault-notes:operator",
      providerId: "vault:operator",
      state: "error",
      errorMessage: "Cannot open the database",
      remediation,
    });
  });

  test("a failure without a remedy sends none", () => {
    const payload = toSyncStatusPayload({
      event: "sync.error",
      sourceId: "vault-notes:operator",
      status: status({ state: "error", lastError: "connection refused" }),
    });
    expect(payload.remediation).toBeUndefined();
  });

  test("the status's own state discriminates the error event", () => {
    for (const state of ["needs-auth", "rate-limited"] as const) {
      const payload = toSyncStatusPayload({
        event: "sync.error",
        sourceId: "vault-notes:operator",
        status: status({ state, lastError: "hint" }),
      });
      expect(payload.state).toBe(state);
    }
  });

  test("the freshness claim rides with the collector's reading of it", () => {
    const payload = toSyncStatusPayload({
      event: "sync.completed",
      sourceId: "vault-notes:operator",
      status: status({
        state: "idle",
        freshness: { quietPeriodMs: 60_000, hint: "Open the vault app." },
        feedProcessRunning: false,
      }),
    });
    expect(payload.state).toBe("completed");
    expect(payload.completedAt).toEqual(expect.any(Number));
    expect(payload.freshness).toEqual({
      quietPeriodMs: 60_000,
      hint: "Open the vault app.",
      processRunning: false,
    });
  });

  test("a feed program the collector could not keep open sends the launch-failure hint", () => {
    const freshness = {
      quietPeriodMs: 60_000,
      hint: "Open the vault app.",
      requiresProcess: {
        processName: "VaultApp",
        launch: { macosBundleId: "org.example.vault", failedHint: "The vault app keeps quitting." },
      },
    };
    const payloadFor = (feedProcessLaunchFailing: boolean) =>
      toSyncStatusPayload({
        event: "sync.completed",
        sourceId: "vault-notes:operator",
        status: status({
          state: "idle",
          freshness,
          feedProcessRunning: false,
          feedProcessLaunchFailing,
        }),
      });
    expect(payloadFor(false).freshness?.hint).toBe("Open the vault app.");
    expect(payloadFor(true).freshness?.hint).toBe("The vault app keeps quitting.");
  });
});
