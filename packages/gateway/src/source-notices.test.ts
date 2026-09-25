// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { SourceId } from "@omnesis/types";
import { buildSourceNotices } from "./source-notices.js";
import type { DisplaySyncStatus } from "./sync-status.js";

const base: DisplaySyncStatus = {
  sourceId: SourceId("example-source:local"),
  state: "synced",
  lastSyncAt: "2026-03-01T10:00:00.000Z",
};

describe("buildSourceNotices", () => {
  test("a healthy source with nothing to say has no notices", () => {
    expect(buildSourceNotices(base)).toEqual([]);
  });

  test("unknown coverage keeps the source's own reason and asks nothing", () => {
    const [notice] = buildSourceNotices({
      ...base,
      coverage: "unknown",
      coverageDetail: "The app deletes old items on its own",
    });
    expect(notice).toEqual({
      kind: "coverage-unknown",
      severity: "info",
      title: "Older history may be incomplete",
      detail: "The app deletes old items on its own. Nothing needs doing.",
    });
  });

  test("partial coverage says only what the source said", () => {
    const [notice] = buildSourceNotices({
      ...base,
      coverage: "partial",
      coverageDetail: "One profile could not be read on this pass.",
    });
    expect(notice).toEqual({
      kind: "coverage-partial",
      severity: "info",
      title: "Some history is not here",
      detail: "One profile could not be read on this pass.",
    });
  });

  test("complete coverage says nothing", () => {
    expect(buildSourceNotices({ ...base, coverage: "complete" })).toEqual([]);
  });

  test("a replica dispute names the device that deleted, in the source's unit", () => {
    const [notice] = buildSourceNotices(
      { ...base, unitName: "messages", restoredClaims: 9 },
      { dispute: { count: 9, deletedBy: ["travel-laptop"] } },
    );
    expect(notice).toMatchObject({
      kind: "replica-dispute",
      severity: "info",
      title: "Keeping 9 messages that travel-laptop no longer has",
    });
    expect(notice!.detail).toContain("nothing is lost");
    expect(notice!.steps).toHaveLength(1);
  });

  test("a dispute whose deleter is unnamed still reads, in the singular", () => {
    const [notice] = buildSourceNotices(
      { ...base, unitName: "messages" },
      { dispute: { count: 1, deletedBy: [] } },
    );
    expect(notice!.title).toBe("Keeping 1 item that another device no longer has");
  });

  test("several deleters are named together", () => {
    const [notice] = buildSourceNotices(base, {
      dispute: { count: 2, deletedBy: ["studio-desk", "travel-laptop"] },
    });
    expect(notice!.title).toBe("Keeping 2 items that studio-desk and travel-laptop no longer have");
  });

  test("an error with a remedy leads with the remedy and keeps the raw message as detail", () => {
    const [notice] = buildSourceNotices({
      ...base,
      state: "error",
      errorMessage: "EPERM: operation not permitted",
      erroredAt: "2026-03-02T08:00:00.000Z",
      remediation: {
        summary: "Disk access is required",
        steps: ["Open the settings pane.", "Turn on disk access for the collector."],
        executable: "/usr/local/bin/node",
        restartRequired: true,
      },
    });
    expect(notice).toEqual({
      kind: "error",
      severity: "error",
      title: "Disk access is required",
      detail: "EPERM: operation not permitted",
      steps: [
        "Open the settings pane.",
        "Turn on disk access for the collector.",
        "The program running the collector is /usr/local/bin/node.",
        "Then restart the collector.",
      ],
      since: "2026-03-02T08:00:00.000Z",
    });
  });

  test("needs-auth asks for a reconnect, naming the account when it can", () => {
    const [auth] = buildSourceNotices({
      ...base,
      state: "needs-auth",
      providerId: "example:account-1",
      errorMessage: "needs reauth: run `cli -- sources reauth example:account-1`",
    });
    expect(auth).toMatchObject({
      kind: "needs-auth",
      severity: "error",
      steps: [
        "Reconnect the account — in the portal, or with: omnesis sources reauth example:account-1",
      ],
    });
    expect(buildSourceNotices({ ...base, state: "needs-auth" })[0]!.steps).toEqual([
      "Reconnect the account.",
    ]);
  });

  test("rate-limited is information, without a retry window that would go stale", () => {
    const [limited] = buildSourceNotices({
      ...base,
      state: "rate-limited",
      errorMessage: "rate-limited: rate limited; retrying in ~6h",
      erroredAt: "2026-03-02T08:00:00.000Z",
    });
    expect(limited).toEqual({
      kind: "rate-limited",
      severity: "info",
      title: "Paused by the provider's rate limit",
      detail: "Syncing resumes on its own once the provider allows it. Nothing needs doing.",
      since: "2026-03-02T08:00:00.000Z",
    });
  });

  test("a phone permission that keeps the source from syncing names the capability", () => {
    const [notice] = buildSourceNotices({
      ...base,
      state: "permission-degraded",
      permissionHealth: {
        state: "permission-degraded",
        reportedState: "permission-degraded",
        checkedAt: Date.UTC(2026, 2, 4),
        receivedAt: Date.UTC(2026, 2, 4),
        validUntil: Date.UTC(2026, 2, 5),
        reportStale: false,
        capabilities: [
          {
            id: "library",
            label: "Photo library",
            state: "permission-degraded",
            requirement: "required",
            impact: "only selected photos are read",
            remediation: "Allow access to all photos in the app's settings",
            repairAction: "open-app-settings",
          },
        ],
      },
    });
    expect(notice).toEqual({
      kind: "permission",
      severity: "warning",
      title: "A permission this source needs is limited",
      detail: "Photo library: only selected photos are read.",
      steps: ["Allow access to all photos in the app's settings."],
      since: "2026-03-04T00:00:00.000Z",
    });
  });

  test("a sync issue carries its remedy and first-observed time", () => {
    const [notice] = buildSourceNotices({
      ...base,
      issues: [
        {
          code: "snapshot-withheld",
          scope: "partition",
          kind: "unknown",
          count: 1,
          message:
            "Items deleted at the source are not being removed yet: a folder was unreadable.",
          remediation: {
            summary: "Nothing is lost.",
            steps: ["This clears on its own."],
            restartRequired: false,
          },
          since: Date.UTC(2026, 2, 3),
        },
      ],
    });
    expect(notice).toEqual({
      kind: "sync-issue",
      severity: "warning",
      title: "Items deleted at the source are not being removed yet: a folder was unreadable.",
      detail: "Nothing is lost.",
      steps: ["This clears on its own."],
      since: "2026-03-03T00:00:00.000Z",
    });
  });

  test("notices come most severe first", () => {
    const notices = buildSourceNotices(
      {
        ...base,
        state: "error",
        errorMessage: "boom",
        coverage: "unknown",
        issues: [
          { scope: "item", kind: "unknown", count: 2, message: "Two rows were skipped.", since: 1 },
        ],
      },
      { dispute: { count: 3, deletedBy: ["studio-desk"] } },
    );
    expect(notices.map((n) => n.severity)).toEqual(["error", "warning", "info", "info"]);
  });

  test("a stale source without a hint still explains itself", () => {
    expect(buildSourceNotices({ ...base, state: "stale" })[0]).toMatchObject({
      kind: "stale",
      severity: "warning",
    });
  });

  test("stale and auth-expiring become warnings", () => {
    expect(
      buildSourceNotices({
        ...base,
        state: "stale",
        staleHint: "Open the app so it records again.",
      })[0],
    ).toMatchObject({
      kind: "stale",
      severity: "warning",
      detail: "Open the app so it records again.",
    });
    expect(
      buildSourceNotices({
        ...base,
        state: "auth-expiring",
        consentExpiresAt: "2026-10-12T00:00:00Z",
      })[0],
    ).toMatchObject({ kind: "auth-expiring", title: "Connection expires on 12 October 2026" });
  });
});
