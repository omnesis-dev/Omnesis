// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  INVENTORY_VERSION,
  REQUIRED_LANES,
  evaluateManifest,
  validationDefinitionHash,
} from "./inventory.mjs";
import {
  advanceFrontier,
  attestRun,
  attachRun,
  beginDispatch,
  classifyProvenance,
  createDailyRequest,
  createLedger,
  createManualRequest,
  londonDate,
  londonHour,
  pendingRequests,
  reconcileAttempt,
  recordReachableCommits,
  recoverLedger,
  shouldCreateDailyDuringReconcile,
} from "./model.mjs";

const sha = (number) => number.toString(16).padStart(40, "0");
const owners = new Set([101]);
const agents = new Set([202]);
const classify = (input) =>
  classifyProvenance({ ...input, ownerIds: owners, ownerAgentIds: agents });

describe("validation inventory", () => {
  it("changes identity when a lane or trusted workflow definition changes", () => {
    const base = { lanes: ["unit"], definitions: [["ci.yml", "run: npm test\n"]] };
    expect(validationDefinitionHash(base)).not.toBe(
      validationDefinitionHash({ ...base, lanes: ["unit", "e2e"] }),
    );
    expect(validationDefinitionHash(base)).not.toBe(
      validationDefinitionHash({
        ...base,
        definitions: [["ci.yml", "run: npm test -- --changed\n"]],
      }),
    );
  });
});

describe("contributor provenance", () => {
  it("uses structured account and PR identity, never display metadata", () => {
    expect(classify({ authorId: 101 })).toEqual({
      classification: "owner",
      reason: "trusted-author",
    });
    expect(classify({ authorId: 202 })).toEqual({
      classification: "owner",
      reason: "trusted-author",
    });
    expect(classify({ authorId: 101, pullRequests: [{ authorId: 303 }] })).toEqual({
      classification: "external",
      reason: "external-pr-author",
    });
    expect(classify({ authorId: null, login: "spoof", email: "spoof@example.com" })).toEqual({
      classification: "external",
      reason: "unattributed",
    });
    expect(classify({ authorId: 404 })).toEqual({
      classification: "external",
      reason: "external-author",
    });
  });

  it("suppresses only a merge wrapper proven mechanical", () => {
    expect(classify({ authorId: 404, mechanicalWrapper: true })).toEqual({
      classification: "mechanical-wrapper",
      reason: "github-pr-wrapper",
    });
    expect(classify({ authorId: 404, mechanicalWrapper: false }).classification).toBe("external");
  });
});

describe("request policy", () => {
  it("keeps external requests per contribution and owner work for one daily batch", () => {
    const ledger = createLedger(sha(1));
    recordReachableCommits(
      ledger,
      [
        {
          sha: sha(2),
          integrationTargetSha: sha(4),
          classification: "external",
          reason: "external-pr-author",
        },
        {
          sha: sha(3),
          integrationTargetSha: sha(3),
          classification: "owner",
          reason: "trusted-author",
        },
        {
          sha: sha(4),
          integrationTargetSha: sha(4),
          classification: "external",
          reason: "external-author",
        },
      ],
      { policyVersion: "fixture", observedAt: "2026-09-08T02:00:00Z" },
    );
    // Duplicate and overlapping delivery is idempotent and cannot retarget a request.
    recordReachableCommits(ledger, [{ ...ledger.commits[sha(2)] }], {
      policyVersion: "fixture",
      observedAt: "later",
    });
    expect(Object.keys(ledger.requests)).toEqual([`external:${sha(2)}`, `external:${sha(4)}`]);
    const daily = createDailyRequest(ledger, {
      instant: "2026-09-08T03:00:00Z",
      targetSha: sha(4),
      createdAt: "2026-09-08T03:00:00Z",
    });
    expect(daily.ownerCommits).toEqual([sha(3)]);
    expect(Object.keys(ledger.requests)).toHaveLength(3);
    expect(
      createDailyRequest(ledger, {
        instant: "2026-09-08T20:00:00Z",
        targetSha: sha(9),
        createdAt: "later",
      }),
    ).toBe(daily);
  });

  it("creates no daily request without owner changes", () => {
    const ledger = createLedger(sha(1));
    expect(
      createDailyRequest(ledger, {
        instant: "2026-01-10T04:00:00Z",
        targetSha: sha(1),
        createdAt: "now",
      }),
    ).toBeNull();
    expect(ledger.days["2026-01-10"].outcome).toBe("no-owner-changes");
  });

  it("shares one active exact-SHA validation between manual and daily requests", () => {
    const ledger = createLedger(sha(1));
    recordReachableCommits(
      ledger,
      [
        {
          sha: sha(2),
          integrationTargetSha: sha(2),
          classification: "owner",
          reason: "trusted-author",
        },
      ],
      { policyVersion: "fixture", observedAt: "now" },
    );
    const manual = createManualRequest(ledger, {
      targetSha: sha(2),
      createdAt: "2026-09-09T03:30:00Z",
      id: "release",
    });
    const daily = createDailyRequest(ledger, {
      instant: "2026-09-09T04:00:00Z",
      targetSha: sha(2),
      createdAt: "2026-09-09T04:00:00Z",
    });
    expect(manual.state).toBe("pending");
    expect(daily).toMatchObject({ state: "waiting", satisfiedBy: manual.key });
    expect(pendingRequests(ledger, 3).map((request) => request.key)).toEqual([manual.key]);

    beginDispatch(manual, "shared-token");
    attachRun(manual, 55, sha(9));
    reconcileAttempt(ledger, manual, {
      runId: 55,
      runAttempt: 1,
      state: "success",
      startedAt: "start",
      endedAt: "end",
      manifest: {
        inventoryVersion: manual.manifest.inventoryVersion,
        results: Object.fromEntries(REQUIRED_LANES.map((lane) => [lane, "success"])),
      },
    });
    expect(daily).toMatchObject({
      state: "success",
      workflowRunId: 55,
      completedBySharedValidation: manual.key,
    });
    expect(daily.manifest.verdict.success).toBe(true);
  });

  it("keeps a later explicit manual rerun independent from a terminal verdict", () => {
    const ledger = createLedger(sha(1));
    createManualRequest(ledger, {
      targetSha: sha(2),
      createdAt: "earlier",
      id: "fixture",
    }).state = "success";
    const rerun = createManualRequest(ledger, {
      targetSha: sha(2),
      createdAt: "later",
      id: "rerun",
    });
    expect(rerun.state).toBe("pending");
    expect(rerun.satisfiedBy).toBeUndefined();
  });

  it.each([
    ["success", "failure"],
    ["failure", "success"],
  ])("updates a shared follower across a %s to %s rerun", (initial, final) => {
    const ledger = createLedger(sha(1));
    recordReachableCommits(
      ledger,
      [
        {
          sha: sha(2),
          integrationTargetSha: sha(2),
          classification: "owner",
          reason: "trusted-author",
        },
      ],
      { policyVersion: "fixture", observedAt: "now" },
    );
    const source = createManualRequest(ledger, {
      targetSha: sha(2),
      createdAt: "2026-09-09T03:30:00Z",
      id: "release",
    });
    const follower = createDailyRequest(ledger, {
      instant: "2026-09-09T04:00:00Z",
      targetSha: sha(2),
      createdAt: "2026-09-09T04:00:00Z",
    });
    beginDispatch(source, "shared-token");
    attachRun(source, 55, sha(9));
    const complete = Object.fromEntries(REQUIRED_LANES.map((lane) => [lane, "success"]));
    for (const [index, state] of [initial, final].entries()) {
      reconcileAttempt(ledger, source, {
        runId: 55,
        runAttempt: index + 1,
        state,
        startedAt: `start-${index}`,
        endedAt: `end-${index}`,
        manifest: {
          inventoryVersion: source.manifest.inventoryVersion,
          results: state === "success" ? complete : { privacy: "failure" },
        },
      });
    }
    expect(source.state).toBe(final);
    expect(follower.state).toBe(final);
    expect(follower.attempts).toEqual(source.attempts);
    expect(follower.manifest).toEqual(source.manifest);
  });

  it("shares an active daily with a later manual request but never suppresses external work", () => {
    const ledger = createLedger(sha(1));
    recordReachableCommits(
      ledger,
      [
        {
          sha: sha(2),
          integrationTargetSha: sha(3),
          classification: "external",
          reason: "external-author",
        },
        {
          sha: sha(3),
          integrationTargetSha: sha(3),
          classification: "owner",
          reason: "trusted-author",
        },
      ],
      { policyVersion: "fixture", observedAt: "now" },
    );
    const daily = createDailyRequest(ledger, {
      instant: "2026-09-09T04:00:00Z",
      targetSha: sha(3),
      createdAt: "2026-09-09T04:00:00Z",
    });
    const manual = createManualRequest(ledger, {
      targetSha: sha(3),
      createdAt: "2026-09-09T04:01:00Z",
      id: "release",
    });
    expect(daily.state).toBe("pending");
    expect(manual).toMatchObject({ state: "waiting", satisfiedBy: daily.key });
    expect(new Set(pendingRequests(ledger, 3).map((request) => request.key))).toEqual(
      new Set([`external:${sha(2)}`, daily.key]),
    );
  });

  it("does not return retired owner commits to a later daily batch", () => {
    const ledger = createLedger(sha(1));
    recordReachableCommits(
      ledger,
      [
        {
          sha: sha(2),
          integrationTargetSha: sha(2),
          classification: "owner",
          reason: "trusted-author",
        },
      ],
      { policyVersion: "fixture", observedAt: "2026-09-07T00:00:00Z" },
    );
    recoverLedger(ledger, {
      targetSha: sha(9),
      reason: "Reviewed replacement history",
      actorId: 101,
      recoveredAt: "2026-09-08T00:00:00Z",
      unreachableOwnerCommits: [sha(2)],
    });
    expect(
      createDailyRequest(ledger, {
        instant: "2026-09-09T04:00:00Z",
        targetSha: sha(9),
        createdAt: "2026-09-09T04:00:00Z",
      }),
    ).toBeNull();
  });

  it("uses Europe/London dates across both DST transitions", () => {
    expect(londonDate("2026-01-10T04:00:00Z")).toBe("2026-01-10");
    expect(londonDate("2026-07-10T03:00:00Z")).toBe("2026-07-10");
    expect(londonDate("2026-03-29T00:59:59Z")).toBe("2026-03-29");
    expect(londonDate("2026-03-29T23:30:00Z")).toBe("2026-03-30");
    expect(londonDate("2026-10-25T00:30:00Z")).toBe("2026-10-25");
    expect(londonDate("2026-10-25T23:30:00Z")).toBe("2026-10-25");
    expect(londonHour("2026-01-10T03:59:59Z")).toBe(3);
    expect(shouldCreateDailyDuringReconcile("2026-01-10T03:59:59Z")).toBe(false);
    expect(shouldCreateDailyDuringReconcile("2026-01-10T04:00:00Z")).toBe(true);
    expect(shouldCreateDailyDuringReconcile("2026-07-10T02:59:59Z")).toBe(false);
    expect(shouldCreateDailyDuringReconcile("2026-07-10T03:00:00Z")).toBe(true);
  });

  it("bounds dispatch without dropping pending requests", () => {
    const ledger = createLedger(sha(1));
    recordReachableCommits(
      ledger,
      Array.from({ length: 5 }, (_, index) => ({
        sha: sha(index + 2),
        integrationTargetSha: sha(index + 2),
        classification: "external",
        reason: "external-author",
      })),
      { policyVersion: "fixture", observedAt: "now" },
    );
    const claimed = pendingRequests(ledger, 3);
    claimed.forEach((request, index) => beginDispatch(request, `token-${index}`));
    expect(claimed).toHaveLength(3);
    expect(pendingRequests(ledger, 3)).toHaveLength(0);
    expect(
      Object.values(ledger.requests).filter((request) => request.state === "pending"),
    ).toHaveLength(2);
  });
});

describe("completion and attestation", () => {
  function runningRequest() {
    const ledger = createLedger(sha(1));
    recordReachableCommits(
      ledger,
      [
        {
          sha: sha(2),
          integrationTargetSha: sha(2),
          classification: "external",
          reason: "external-author",
        },
      ],
      { policyVersion: "fixture", observedAt: "now" },
    );
    const request = ledger.requests[`external:${sha(2)}`];
    beginDispatch(request, "opaque-token");
    attachRun(request, 55, sha(9));
    return { ledger, request };
  }

  it("rejects guessed, stale, mismatched and duplicate runs, but admits explicit rerun attempts", () => {
    const { ledger, request } = runningRequest();
    const exact = {
      targetSha: sha(2),
      token: "opaque-token",
      runId: 55,
      inventoryVersion: INVENTORY_VERSION,
      controllerSha: sha(9),
    };
    expect(attestRun(request, exact)).toBe(true);
    expect(attestRun(request, { ...exact, token: "wrong" })).toBe(false);
    expect(attestRun(request, { ...exact, controllerSha: sha(10) })).toBe(false);
    reconcileAttempt(ledger, request, {
      runId: 55,
      runAttempt: 1,
      state: "cancelled",
      startedAt: "a",
      endedAt: "b",
    });
    expect(attestRun(request, exact)).toBe(false);
    expect(attestRun(request, { ...exact, runAttempt: 2 })).toBe(true);
  });

  it("advances successful SHA only for a complete current manifest", () => {
    for (const terminal of ["failure", "cancelled", "infrastructure_error", "unavailable"]) {
      const { ledger, request } = runningRequest();
      reconcileAttempt(ledger, request, {
        runId: 55,
        runAttempt: 1,
        state: terminal,
        startedAt: "a",
        endedAt: "b",
      });
      expect(ledger.frontier.lastSuccessfulFullSha).toBeNull();
    }
    const { ledger, request } = runningRequest();
    const results = Object.fromEntries(REQUIRED_LANES.map((lane) => [lane, "success"]));
    reconcileAttempt(ledger, request, {
      runId: 55,
      runAttempt: 1,
      state: "success",
      startedAt: "a",
      endedAt: "b",
      manifest: { inventoryVersion: INVENTORY_VERSION, results },
    });
    expect(ledger.frontier.lastSuccessfulFullSha).toBe(sha(2));
    expect(evaluateManifest({ ...results, privacy: "skipped" }).success).toBe(false);
    expect(evaluateManifest(results, "stale").success).toBe(false);
  });

  it("does not move the successful SHA backward when validations finish out of order", () => {
    const ledger = createLedger(sha(1));
    const older = createManualRequest(ledger, {
      targetSha: sha(2),
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "older",
    });
    const newer = createManualRequest(ledger, {
      targetSha: sha(3),
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "a-newer",
    });
    const results = Object.fromEntries(REQUIRED_LANES.map((lane) => [lane, "success"]));
    for (const [request, runId] of [
      [older, 55],
      [newer, 56],
    ]) {
      beginDispatch(request, `token-${runId}`);
      attachRun(request, runId, sha(9));
    }

    reconcileAttempt(ledger, newer, {
      runId: 56,
      runAttempt: 1,
      state: "success",
      startedAt: "a",
      endedAt: "b",
      manifest: { inventoryVersion: INVENTORY_VERSION, results },
    });
    reconcileAttempt(ledger, older, {
      runId: 55,
      runAttempt: 1,
      state: "success",
      startedAt: "a",
      endedAt: "c",
      manifest: { inventoryVersion: INVENTORY_VERSION, results },
    });

    expect(ledger.frontier.lastSuccessfulFullSha).toBe(sha(3));
    expect(ledger.frontier.lastSuccessfulFullRequestKey).toBe("manual:a-newer");
  });

  it("migrates a legacy success frontier using only valid manifests", () => {
    const ledger = createLedger(sha(1));
    const valid = createManualRequest(ledger, {
      targetSha: sha(2),
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "valid",
    });
    const newer = createManualRequest(ledger, {
      targetSha: sha(3),
      createdAt: "2026-01-01T00:01:00.000Z",
      id: "newer",
    });
    const invalid = createManualRequest(ledger, {
      targetSha: sha(2),
      createdAt: "2026-01-01T00:02:00.000Z",
      id: "invalid",
    });
    const results = Object.fromEntries(REQUIRED_LANES.map((lane) => [lane, "success"]));
    for (const [request, runId] of [
      [valid, 55],
      [newer, 56],
      [invalid, 57],
    ]) {
      beginDispatch(request, `token-${runId}`);
      attachRun(request, runId, sha(9));
    }
    reconcileAttempt(ledger, valid, {
      runId: 55,
      runAttempt: 1,
      state: "success",
      startedAt: "a",
      endedAt: "b",
      manifest: { inventoryVersion: INVENTORY_VERSION, results },
    });
    reconcileAttempt(ledger, invalid, {
      runId: 57,
      runAttempt: 1,
      state: "success",
      startedAt: "a",
      endedAt: "c",
      manifest: { inventoryVersion: INVENTORY_VERSION, results: {} },
    });

    delete ledger.frontier.lastSuccessfulFullRequestKey;
    delete ledger.frontier.nextRequestSequence;
    for (const request of Object.values(ledger.requests)) delete request.sequence;
    reconcileAttempt(ledger, newer, {
      runId: 56,
      runAttempt: 1,
      state: "success",
      startedAt: "a",
      endedAt: "d",
      manifest: { inventoryVersion: INVENTORY_VERSION, results },
    });

    expect(ledger.frontier.lastSuccessfulFullSha).toBe(sha(3));
    expect(ledger.frontier.lastSuccessfulFullRequestKey).toBe("manual:newer");
  });

  it("uses the newest coalesced request consistently across legacy migration", () => {
    const ledger = createLedger(sha(1));
    const source = createManualRequest(ledger, {
      targetSha: sha(2),
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "source",
    });
    const independent = createManualRequest(ledger, {
      targetSha: sha(3),
      createdAt: "2026-01-01T00:01:00.000Z",
      id: "independent",
    });
    recordReachableCommits(
      ledger,
      [
        {
          sha: sha(4),
          integrationTargetSha: sha(4),
          classification: "owner",
          reason: "trusted-author",
        },
      ],
      { policyVersion: "fixture", observedAt: "2026-01-01T00:02:00.000Z" },
    );
    const follower = createDailyRequest(ledger, {
      instant: "2026-01-01T04:00:00.000Z",
      targetSha: sha(2),
      createdAt: "2026-01-01T00:02:00.000Z",
    });
    const results = Object.fromEntries(REQUIRED_LANES.map((lane) => [lane, "success"]));
    for (const [request, runId] of [
      [source, 55],
      [independent, 56],
    ]) {
      beginDispatch(request, `token-${runId}`);
      attachRun(request, runId, sha(9));
    }
    reconcileAttempt(ledger, source, {
      runId: 55,
      runAttempt: 1,
      state: "success",
      startedAt: "a",
      endedAt: "b",
      manifest: { inventoryVersion: INVENTORY_VERSION, results },
    });
    expect(follower.state).toBe("success");
    expect(ledger.frontier.lastSuccessfulFullRequestKey).toBe(follower.key);

    delete ledger.frontier.lastSuccessfulFullRequestKey;
    delete ledger.frontier.nextRequestSequence;
    for (const request of Object.values(ledger.requests)) delete request.sequence;
    reconcileAttempt(ledger, independent, {
      runId: 56,
      runAttempt: 1,
      state: "success",
      startedAt: "a",
      endedAt: "c",
      manifest: { inventoryVersion: INVENTORY_VERSION, results },
    });

    expect(ledger.frontier.lastSuccessfulFullSha).toBe(sha(2));
    expect(ledger.frontier.lastSuccessfulFullRequestKey).toBe(follower.key);
  });

  it("retains a terminal failure's partial lane manifest without advancing success", () => {
    const { ledger, request } = runningRequest();
    reconcileAttempt(ledger, request, {
      runId: 55,
      runAttempt: 1,
      state: "failure",
      startedAt: "a",
      endedAt: "b",
      manifest: {
        inventoryVersion: INVENTORY_VERSION,
        required: REQUIRED_LANES,
        results: { privacy: "success", "linux-unit": "failure" },
      },
    });
    expect(request.manifest.required).toEqual(REQUIRED_LANES);
    expect(request.manifest.results).toEqual({ privacy: "success", "linux-unit": "failure" });
    expect(request.manifest.verdict.success).toBe(false);
    expect(request.manifest.verdict.unsuccessful).toEqual(["linux-unit"]);
    expect(ledger.frontier.lastSuccessfulFullSha).toBeNull();
  });

  it("fails a stale frontier CAS", () => {
    const ledger = createLedger(sha(1));
    expect(() => advanceFrontier(ledger, sha(9), sha(2))).toThrow("stale frontier");
  });
});

describe("full inventory", () => {
  it("retains native build and live integration lanes", () => {
    expect(REQUIRED_LANES).toEqual(
      expect.arrayContaining(["ios-live-e2e", "android-build", "android-live-e2e"]),
    );
  });
});
