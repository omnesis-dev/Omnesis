// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { ProgressTracker } from "./progress-tracker.js";
import { SourceLifecycle, type SourceStatus } from "./source-lifecycle.js";

const REMEDY = {
  summary: "Disk access is required",
  steps: ["Open the privacy settings pane."],
  restartRequired: true,
};

function erroredStatus(): SourceStatus {
  const status: SourceStatus = {
    sourceId: "vault-notes:operator",
    providerId: "vault:operator",
    sourceName: "vault-notes",
    state: "idle",
  };
  SourceLifecycle.toError(status, "Cannot open the database", undefined, REMEDY);
  return status;
}

describe("SourceLifecycle — a remedy never outlives the failure it explains", () => {
  test("toError records the remedy beside the message", () => {
    const status = erroredStatus();
    expect(status).toMatchObject({
      state: "error",
      lastError: "Cannot open the database",
      remediation: REMEDY,
    });
  });

  test("an error raised without a remedy replaces the previous one's", () => {
    const status = erroredStatus();
    SourceLifecycle.toError(status, "connection refused");
    expect(status.remediation).toBeUndefined();
  });

  test.each([
    ["toSyncing", (s: SourceStatus) => SourceLifecycle.toSyncing(s)],
    ["toIdle", (s: SourceStatus) => SourceLifecycle.toIdle(s)],
    ["toNeedsAuth", (s: SourceStatus) => SourceLifecycle.toNeedsAuth(s, "needs reauth: expired")],
    ["toRateLimited", (s: SourceStatus) => SourceLifecycle.toRateLimited(s, "rate-limited: 6h", 1)],
    ["toDisabled", (s: SourceStatus) => SourceLifecycle.toDisabled(s)],
  ])("%s drops it", (_name, transition) => {
    const status = erroredStatus();
    transition(status);
    expect(status.remediation).toBeUndefined();
  });

  test("reactivating a stuck source drops it with the message", () => {
    const status = erroredStatus();
    SourceLifecycle.toNeedsAuth(status, "needs reauth: expired");
    status.remediation = REMEDY;
    SourceLifecycle.reactivateFromStuck(status);
    expect(status.state).toBe("idle");
    expect(status.lastError).toBeUndefined();
    expect(status.remediation).toBeUndefined();
  });
});

describe("a coverage claim outlives the run that made it", () => {
  test("completing a sync clears the meter but keeps what the source said about its history", () => {
    const status: SourceStatus = {
      sourceId: "obsidian-notes:Vault",
      providerId: "obsidian",
      sourceName: "Notes",
      state: "syncing",
    };
    const tracker = new ProgressTracker(() => {}, 0);

    tracker.reportPage(
      status,
      {
        phase: "notes",
        total: 10,
        processed: 0,
        coverage: "partial",
        detail: "catching up on 2019",
      },
      4,
    );
    expect(status.progress?.coverage).toBe("partial");
    expect(status.coverage).toBe("partial");

    SourceLifecycle.toIdle(status);

    // The meter is gone, as it should be — the run is over. The claim is not:
    // it describes the corpus, and it only became true at the moment the run
    // finished, which is exactly when the old shape stopped showing it.
    expect(status.progress).toBeUndefined();
    expect(status.coverage).toBe("partial");
    expect(status.coverageDetail).toBe("catching up on 2019");
  });

  test("a later page that says nothing about coverage leaves the standing claim alone", () => {
    const status: SourceStatus = {
      sourceId: "obsidian-notes:Vault",
      providerId: "obsidian",
      sourceName: "Notes",
      state: "syncing",
    };
    const tracker = new ProgressTracker(() => {}, 0);

    tracker.reportPage(status, { phase: "notes", processed: 0, coverage: "unknown" }, 1);
    tracker.reportPage(status, { phase: "notes", processed: 0 }, 2);

    expect(status.coverage).toBe("unknown");
  });

  test("the weakest claim of a run wins, whatever order the pages came in", () => {
    // A source that walks several things behind one row — a bank session
    // holding several accounts — makes a claim per thing. Taking the last
    // would let whichever finished last speak for all of them.
    for (const order of [
      ["partial", "unknown"],
      ["unknown", "partial"],
    ] as const) {
      const status: SourceStatus = {
        sourceId: "enable-banking:bank",
        providerId: "enable",
        sourceName: "Accounts",
        state: "syncing",
      };
      const tracker = new ProgressTracker(() => {}, 0);
      let n = 0;
      for (const coverage of order) {
        tracker.reportPage(
          status,
          { phase: "txns", processed: 0, coverage, coverageSubject: `acct-${n++}` },
          1,
        );
      }
      expect(status.coverage).toBe("partial");
    }
  });

  test("a definite gap outranks not knowing, because it is the answer worth acting on", () => {
    const status: SourceStatus = {
      sourceId: "enable-banking:bank",
      providerId: "enable",
      sourceName: "Accounts",
      state: "syncing",
    };
    const tracker = new ProgressTracker(() => {}, 0);
    const a = {
      processed: 0,
      phase: "txns",
      coverage: "partial",
      detail: "only 90 days",
      coverageSubject: "a",
    };
    tracker.reportPage(status, a as never, 1);
    tracker.reportPage(
      status,
      { processed: 0, phase: "txns", coverage: "unknown", coverageSubject: "b" },
      2,
    );
    expect(status.coverage).toBe("partial");
    // The wording belongs to the claim that won, not to the page that ran last.
    expect(status.coverageDetail).toBe("only 90 days");
  });

  test("an all-clear from one subject does not overwrite a gap another reported", () => {
    const status: SourceStatus = {
      sourceId: "enable-banking:bank",
      providerId: "enable",
      sourceName: "Accounts",
      state: "syncing",
    };
    const tracker = new ProgressTracker(() => {}, 0);
    tracker.reportPage(
      status,
      { processed: 0, phase: "txns", coverage: "unknown", coverageSubject: "acct-a" },
      1,
    );
    tracker.reportPage(
      status,
      { processed: 0, phase: "txns", coverage: "complete", coverageSubject: "acct-b" },
      2,
    );
    // Both are true at once, of different accounts, and a caveat that applies
    // to part of a connection applies to the connection.
    expect(status.coverage).toBe("unknown");
  });

  test("a subject that revises its own claim is believed, because it has not made two", () => {
    // A messaging bootstrap says "still arriving" on every page until the page
    // where it says "finished". Keeping the weaker there re-asserts a question
    // the source just answered — on the longest run it ever has, the one right
    // after pairing.
    const status: SourceStatus = {
      sourceId: "whatsapp-messages:phone",
      providerId: "whatsapp",
      sourceName: "Accounts",
      state: "syncing",
    };
    const tracker = new ProgressTracker(() => {}, 0);
    for (const coverage of ["unknown", "unknown", "complete"] as const) {
      tracker.reportPage(status, { processed: 0, phase: "bootstrap", coverage }, 1);
    }
    expect(status.coverage).toBe("complete");
  });

  test("a revision clears the wording that came with the claim it replaced", () => {
    const status: SourceStatus = {
      sourceId: "whatsapp-messages:phone",
      providerId: "whatsapp",
      sourceName: "Accounts",
      state: "syncing",
    };
    const tracker = new ProgressTracker(() => {}, 0);
    tracker.reportPage(
      status,
      { processed: 0, phase: "b", coverage: "partial", detail: "re-pair to refresh" },
      1,
    );
    tracker.reportPage(status, { processed: 0, phase: "b", coverage: "complete" }, 2);
    expect(status.coverage).toBe("complete");
    // Otherwise the operator is told to re-pair a device that just finished.
    expect(status.coverageDetail).toBeUndefined();
  });

  test("one subject improving does not lift a gap another subject still reports", () => {
    const status: SourceStatus = {
      sourceId: "enable-banking:bank",
      providerId: "enable",
      sourceName: "Accounts",
      state: "syncing",
    };
    const tracker = new ProgressTracker(() => {}, 0);
    tracker.reportPage(
      status,
      { processed: 0, phase: "t", coverage: "partial", coverageSubject: "acct-a" },
      1,
    );
    tracker.reportPage(
      status,
      { processed: 0, phase: "t", coverage: "unknown", coverageSubject: "acct-b" },
      2,
    );
    tracker.reportPage(
      status,
      { processed: 0, phase: "t", coverage: "complete", coverageSubject: "acct-b" },
      3,
    );
    expect(status.coverage).toBe("partial");
  });

  test("a later run may settle what an earlier one could not", () => {
    const status: SourceStatus = {
      sourceId: "google-gmail:someone",
      providerId: "google",
      sourceName: "Accounts",
      state: "syncing",
    };
    new ProgressTracker(() => {}, 0).reportPage(
      status,
      { processed: 0, phase: "b", coverage: "unknown" },
      1,
    );
    expect(status.coverage).toBe("unknown");

    // A fresh run gets a fresh accumulator, so a resync that genuinely walked
    // the whole mailbox can clear a claim an interrupted one left behind.
    SourceLifecycle.toIdle(status);
    new ProgressTracker(() => {}, 0).reportPage(
      status,
      { processed: 0, phase: "b", coverage: "complete" },
      1,
    );
    expect(status.coverage).toBe("complete");
  });

  test("a weaker claim replaces a stronger one within the run, and takes its wording", () => {
    const status: SourceStatus = {
      sourceId: "obsidian-notes:Vault",
      providerId: "obsidian",
      sourceName: "Notes",
      state: "syncing",
    };
    const tracker = new ProgressTracker(() => {}, 0);

    tracker.reportPage(
      status,
      { processed: 0, phase: "notes", coverage: "complete", coverageSubject: "a" },
      1,
    );
    tracker.reportPage(
      status,
      {
        processed: 0,
        phase: "notes",
        coverage: "partial",
        detail: "backfilling",
        coverageSubject: "b",
      },
      2,
    );

    expect(status.coverage).toBe("partial");
    // The wording belongs to the claim it explains, so it arrives with it.
    expect(status.coverageDetail).toBe("backfilling");
  });
});
