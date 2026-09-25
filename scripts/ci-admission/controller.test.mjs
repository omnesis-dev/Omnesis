// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyRange,
  laneResultsFromJobs,
  parseRunIdentity,
  recoverAmbiguousDispatches,
  reconcileAttachedRuns,
  runController,
} from "./controller.mjs";
import { GitHubApiError } from "./github.mjs";
import { REQUIRED_LANES } from "./inventory.mjs";
import {
  attachRun,
  beginDispatch,
  createDailyRequest,
  createLedger,
  createManualRequest,
  reconcileAttempt,
  recordReachableCommits,
} from "./model.mjs";
import { FileLedgerStore } from "./state-store.mjs";

const sha = (number) => number.toString(16).padStart(40, "0");
const temporary = [];
afterEach(async () =>
  Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

async function fixtureStore() {
  const directory = await mkdtemp(join(tmpdir(), "ci-controller-"));
  temporary.push(directory);
  return new FileLedgerStore(directory);
}

describe("workflow adapters", () => {
  it("extracts exact admission identity and lane markers from jobs and reusable prefixes", () => {
    expect(parseRunIdentity("full-validation [external:abc] [token-1]")).toEqual({
      requestKey: "external:abc",
      dispatchToken: "token-1",
    });
    expect(parseRunIdentity("full-validation guessed token")).toBeNull();
    expect(
      laneResultsFromJobs([
        { name: "linux / lane [privacy]", conclusion: "success" },
        {
          name: "combined",
          conclusion: "failure",
          steps: [
            { name: "lane [linux-e2e]", conclusion: "success" },
            { name: "lane [browser-e2e]", conclusion: "failure" },
          ],
        },
        { name: "not-a-lane [privacy]", conclusion: "success" },
      ]),
    ).toEqual({ privacy: "success", "linux-e2e": "success", "browser-e2e": "failure" });
  });

  it("authorizes initialization by fetched numeric account ID", async () => {
    const store = await fixtureStore();
    const base = {
      operation: "initialize",
      event: { actor: "display-only", targetSha: sha(1) },
      store,
      repository: ".",
      ownerIds: new Set([10]),
      ownerAgentIds: new Set(),
      policyVersion: "1",
      resolveRepositoryHead: () => sha(1),
    };
    await expect(
      runController({ ...base, client: { user: async () => ({ id: 11 }) } }),
    ).rejects.toThrow("owner-only");
    await expect(
      runController({ ...base, client: { user: async () => ({ id: 10 }) } }),
    ).resolves.toMatchObject({ initialized: { baselineSha: sha(1) } });
  });

  it("refuses to initialize from a target other than the checked-out repository HEAD", async () => {
    const store = await fixtureStore();
    await expect(
      runController({
        operation: "initialize",
        event: { actor: "owner", targetSha: sha(1) },
        client: { user: async () => ({ id: 10 }) },
        store,
        repository: ".",
        ownerIds: new Set([10]),
        ownerAgentIds: new Set(),
        policyVersion: "1",
        resolveRepositoryHead: () => sha(2),
      }),
    ).rejects.toThrow("must equal current repository HEAD");
  });

  it("audits owner recovery and retires only unassigned unreachable work", async () => {
    const store = await fixtureStore();
    const ledger = createLedger(sha(1), "2026-09-01T00:00:00.000Z");
    recordReachableCommits(
      ledger,
      [
        {
          sha: sha(2),
          integrationTargetSha: sha(2),
          classification: "owner",
          reason: "trusted-author",
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
        {
          sha: sha(5),
          integrationTargetSha: sha(5),
          classification: "external",
          reason: "external-author",
        },
        {
          sha: sha(6),
          integrationTargetSha: sha(6),
          classification: "external",
          reason: "external-author",
        },
        {
          sha: sha(7),
          integrationTargetSha: sha(7),
          classification: "external",
          reason: "external-author",
        },
      ],
      { policyVersion: "1", observedAt: "2026-09-02T00:00:00.000Z" },
    );
    ledger.commits[sha(3)].dailyRequest = "daily:prior";
    beginDispatch(ledger.requests[`external:${sha(6)}`], "queued-token");
    attachRun(ledger.requests[`external:${sha(6)}`], 61, sha(8));
    ledger.requests[`external:${sha(7)}`].state = "success";
    ledger.frontier.scannedHeadSha = sha(7);
    ledger.frontier.scan = {
      fromSha: sha(7),
      targetSha: sha(8),
      targets: [],
      nextIndex: 0,
    };
    await store.write(ledger);

    const reachable = new Set([sha(5), sha(9)]);
    const result = await runController({
      operation: "recover",
      event: { actor: "owner", targetSha: sha(9), reason: "Restore reviewed main lineage" },
      client: { user: async () => ({ id: 10 }) },
      store,
      repository: ".",
      ownerIds: new Set([10]),
      ownerAgentIds: new Set(),
      policyVersion: "1",
      now: new Date("2026-09-08T12:00:00.000Z"),
      resolveRepositoryHead: () => sha(9),
      isRepositoryAncestor: (_repository, ancestor) => reachable.has(ancestor),
    });

    expect(result.recovery).toMatchObject({
      id: "recovery:1",
      actorId: 10,
      reason: "Restore reviewed main lineage",
      targetSha: sha(9),
      retiredOwnerCommits: [sha(2)],
      unavailableRequests: [`external:${sha(4)}`],
      previous: {
        baselineSha: sha(1),
        scannedHeadSha: sha(7),
        scanTargetSha: sha(8),
      },
    });
    const final = await store.read();
    expect(final.frontier).toMatchObject({
      baselineSha: sha(9),
      scannedHeadSha: sha(9),
      scan: null,
    });
    expect(final.commits[sha(2)].retiredByRecovery).toBe("recovery:1");
    expect(final.commits[sha(3)].retiredByRecovery).toBeUndefined();
    expect(final.requests[`external:${sha(4)}`].state).toBe("unavailable");
    expect(final.requests[`external:${sha(5)}`].state).toBe("pending");
    expect(final.requests[`external:${sha(6)}`].state).toBe("queued");
    expect(final.requests[`external:${sha(7)}`].state).toBe("success");
  });

  it("requires an owner, current HEAD, divergence, and an explicit recovery reason", async () => {
    const cases = [
      {
        actorId: 11,
        targetSha: sha(9),
        reason: "Reviewed rewrite",
        ancestor: false,
        message: "owner-only",
      },
      {
        actorId: 10,
        targetSha: sha(8),
        reason: "Reviewed rewrite",
        ancestor: false,
        message: "must equal current repository HEAD",
      },
      {
        actorId: 10,
        targetSha: sha(9),
        reason: "Reviewed rewrite",
        ancestor: true,
        message: "requires a force-pushed main history",
      },
      {
        actorId: 10,
        targetSha: sha(9),
        reason: " ",
        ancestor: false,
        message: "recovery reason",
      },
    ];
    for (const fixture of cases) {
      const store = await fixtureStore();
      await store.write(createLedger(sha(1)));
      await expect(
        runController({
          operation: "recover",
          event: {
            actor: "display-only",
            targetSha: fixture.targetSha,
            reason: fixture.reason,
          },
          client: { user: async () => ({ id: fixture.actorId }) },
          store,
          repository: ".",
          ownerIds: new Set([10]),
          ownerAgentIds: new Set([11]),
          policyVersion: "1",
          resolveRepositoryHead: () => sha(9),
          isRepositoryAncestor: () => fixture.ancestor,
        }),
      ).rejects.toThrow(fixture.message);
    }
  });

  it("reconciles a complete manifest and is idempotent for repeated completion delivery", async () => {
    const store = await fixtureStore();
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
      { policyVersion: "1", observedAt: "now" },
    );
    const request = ledger.requests[`external:${sha(2)}`];
    beginDispatch(request, "token-1");
    attachRun(request, 91, sha(9));
    await store.write(ledger);
    const jobs = [
      {
        name: "all lanes",
        conclusion: "success",
        steps: REQUIRED_LANES.map((lane) => ({ name: `lane [${lane}]`, conclusion: "success" })),
      },
    ];
    const args = {
      operation: "workflow_run",
      event: {
        workflowRun: {
          id: 91,
          display_title: `full-validation [external:${sha(2)}] [token-1]`,
          run_attempt: 1,
          head_sha: sha(9),
          conclusion: "success",
          run_started_at: "a",
          updated_at: "b",
        },
      },
      client: { workflowJobs: async () => jobs },
      store,
      repository: ".",
      ownerIds: new Set(),
      ownerAgentIds: new Set(),
      policyVersion: "1",
    };
    await runController(args);
    await runController(args);
    const final = await store.read();
    expect(final.requests[`external:${sha(2)}`].state).toBe("success");
    expect(final.requests[`external:${sha(2)}`].attempts).toHaveLength(1);
    expect(final.frontier.lastSuccessfulFullSha).toBe(sha(2));
  });

  it("reports both logical requests that shared one exact-SHA validation", async () => {
    const store = await fixtureStore();
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
      { policyVersion: "1", observedAt: "now" },
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
    beginDispatch(manual, "token-1");
    attachRun(manual, 91, sha(9));
    reconcileAttempt(ledger, manual, {
      runId: 91,
      runAttempt: 1,
      state: "success",
      startedAt: "start",
      endedAt: "end",
      manifest: {
        inventoryVersion: manual.manifest.inventoryVersion,
        results: Object.fromEntries(REQUIRED_LANES.map((lane) => [lane, "success"])),
      },
    });
    await store.write(ledger);
    const statuses = [];
    const result = await runController({
      operation: "report",
      event: { requestKey: manual.key, targetUrl: "https://example.com/run" },
      client: {
        createCommitStatus: async (targetSha, status) => statuses.push({ targetSha, status }),
      },
      store,
      repository: ".",
      ownerIds: new Set(),
      ownerAgentIds: new Set(),
      policyVersion: "1",
    });
    expect(result.reported).toEqual([manual.key, daily.key]);
    expect(statuses.map(({ status }) => status.context)).toEqual([
      `full-validation/${manual.key}`,
      `full-validation/${daily.key}`,
    ]);
  });

  it("keeps cancellation red and does not advance the success pointer", async () => {
    const store = await fixtureStore();
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
      { policyVersion: "1", observedAt: "now" },
    );
    const request = ledger.requests[`external:${sha(2)}`];
    beginDispatch(request, "token-1");
    attachRun(request, 91, sha(9));
    await store.write(ledger);
    await runController({
      operation: "workflow_run",
      event: {
        workflowRun: {
          id: 91,
          display_title: `full-validation [external:${sha(2)}] [token-1]`,
          run_attempt: 1,
          head_sha: sha(9),
          conclusion: "cancelled",
          run_started_at: "a",
          updated_at: "b",
        },
      },
      client: { workflowJobs: async () => [] },
      store,
      repository: ".",
      ownerIds: new Set(),
      ownerAgentIds: new Set(),
      policyVersion: "1",
    });
    const final = await store.read();
    const finalRequest = final.requests[`external:${sha(2)}`];
    expect(finalRequest.state).toBe("cancelled");
    expect(finalRequest.manifest.required).toEqual(REQUIRED_LANES);
    expect(finalRequest.manifest.results).toEqual({});
    expect(finalRequest.manifest.verdict.success).toBe(false);
    expect(final.frontier.lastSuccessfulFullSha).toBeNull();
  });

  it("recovers a lost dispatch response by exact durable token without dispatching twice", async () => {
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
      { policyVersion: "1", observedAt: "now" },
    );
    const request = ledger.requests[`external:${sha(2)}`];
    beginDispatch(request, "durable-token");
    request.dispatchAttempts = 1;
    let dispatchCalls = 0;
    const recovered = await recoverAmbiguousDispatches({
      ledger,
      workflow: "full-validation.yml",
      client: {
        workflowRuns: async () => [
          {
            id: 72,
            head_sha: sha(9),
            display_title: `full-validation [external:${sha(2)}] [durable-token]`,
          },
        ],
        dispatch: async () => {
          dispatchCalls += 1;
        },
      },
    });
    expect(recovered).toEqual([{ requestKey: `external:${sha(2)}`, runId: 72 }]);
    expect(request.workflowRunId).toBe(72);
    expect(dispatchCalls).toBe(0);
  });

  it("fails closed when one token resolves to duplicate full runs", async () => {
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
      { policyVersion: "1", observedAt: "now" },
    );
    const request = ledger.requests[`external:${sha(2)}`];
    beginDispatch(request, "durable-token");
    const title = `full-validation [external:${sha(2)}] [durable-token]`;
    await expect(
      recoverAmbiguousDispatches({
        ledger,
        workflow: "full-validation.yml",
        client: {
          workflowRuns: async () => [
            { id: 1, display_title: title },
            { id: 2, display_title: title },
          ],
        },
      }),
    ).rejects.toThrow("duplicate workflow runs");
  });

  it("attaches a run discovered after an empty dispatch response", async () => {
    const store = await fixtureStore();
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
      { policyVersion: "1", observedAt: "now" },
    );
    const request = ledger.requests[`external:${sha(2)}`];
    beginDispatch(request, "durable-token");
    await store.write(ledger);
    let dispatched = false;
    const client = {
      workflowRuns: async () =>
        dispatched
          ? [
              {
                id: 73,
                head_sha: sha(10),
                display_title: `full-validation [external:${sha(2)}] [durable-token]`,
              },
            ]
          : [],
      dispatch: async () => {
        dispatched = true;
        return null;
      },
    };
    const prepared = await runController({
      operation: "dispatch",
      event: {},
      client,
      store,
      repository: ".",
      ownerIds: new Set(),
      ownerAgentIds: new Set(),
      policyVersion: "1",
    });
    expect(prepared.posts).toHaveLength(1);
    expect((await store.read()).requests[`external:${sha(2)}`].dispatchAttempts).toBe(1);
    await runController({
      operation: "send_dispatch",
      event: { posts: prepared.posts },
      client,
      store,
      repository: ".",
      ownerIds: new Set(),
      ownerAgentIds: new Set(),
      policyVersion: "1",
    });
    expect((await store.read()).requests[`external:${sha(2)}`]).toMatchObject({
      state: "queued",
      workflowRunId: 73,
      manifest: { controllerSha: sha(10) },
    });
  });

  it("never posts again after a persisted dispatch attempt", async () => {
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
      { policyVersion: "1", observedAt: "now" },
    );
    const request = ledger.requests[`external:${sha(2)}`];
    beginDispatch(request, "durable-token");
    request.dispatchAttempts = 1;
    let posts = 0;
    for (let pass = 0; pass < 12; pass += 1) {
      await recoverAmbiguousDispatches({
        ledger,
        workflow: "full-validation.yml",
        client: {
          workflowRuns: async () => [],
          dispatch: async () => {
            posts += 1;
          },
        },
      });
    }
    expect(posts).toBe(0);
    expect(request.state).toBe("infrastructure_error");
    expect(request.discoveryChecks).toBe(12);
  });

  it("recovers a terminal result when the original completion state push was lost", async () => {
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
      { policyVersion: "1", observedAt: "now" },
    );
    const request = ledger.requests[`external:${sha(2)}`];
    beginDispatch(request, "durable-token");
    attachRun(request, 74, sha(10));
    const steps = REQUIRED_LANES.map((lane) => ({
      name: `lane [${lane}]`,
      conclusion: "success",
    }));
    await reconcileAttachedRuns({
      ledger,
      client: {
        workflowRun: async () => ({
          id: 74,
          head_sha: sha(10),
          display_title: `full-validation [external:${sha(2)}] [durable-token]`,
          status: "completed",
          conclusion: "success",
          run_attempt: 1,
          run_started_at: "a",
          updated_at: "b",
        }),
        workflowJobs: async () => [{ name: "manifest", conclusion: "success", steps }],
      },
    });
    expect(request.state).toBe("success");
    expect(ledger.frontier.lastSuccessfulFullSha).toBe(sha(2));
  });
});

describe("resumable provenance classification", () => {
  const metadataClient = {
    commit: async () => ({ author: null, parents: [] }),
    associatedPullRequests: async () => [],
  };

  it("checkpoints and resumes histories larger than 2,048 commits in bounded batches", async () => {
    const store = await fixtureStore();
    let ledger = createLedger(sha(1));
    await store.write(ledger);
    const targets = Array.from({ length: 2_049 }, (_, index) => ({
      sha: sha(index + 2),
      integrationTargetSha: sha(index + 2),
    }));
    let discoveries = 0;
    let batches = 0;
    while (ledger.frontier.scan != null || batches === 0) {
      const result = await classifyRange({
        client: metadataClient,
        ledger,
        repository: ".",
        headSha: targets.at(-1).sha,
        observedAt: "2026-09-08T04:00:00Z",
        policyVersion: "fixture",
        ownerIds: new Set(),
        ownerAgentIds: new Set(),
        batchSize: 128,
        discoverTargets: () => {
          discoveries += 1;
          return targets;
        },
      });
      expect(result.processed).toBeLessThanOrEqual(128);
      await store.write(ledger);
      ledger = await store.read();
      batches += 1;
    }
    expect(discoveries).toBe(1);
    expect(batches).toBe(17);
    expect(ledger.frontier.scannedHeadSha).toBe(targets.at(-1).sha);
    expect(Object.keys(ledger.commits)).toHaveLength(2_049);
    expect(Object.keys(ledger.requests)).toHaveLength(2_049);
  });

  it("persists partial progress and honors API retry timing before resuming", async () => {
    const ledger = createLedger(sha(1));
    const targets = [2, 3, 4, 5].map((number) => ({
      sha: sha(number),
      integrationTargetSha: sha(number),
    }));
    let fail = true;
    let calls = 0;
    const client = {
      commit: async (commitSha) => {
        calls += 1;
        if (commitSha === sha(4) && fail) {
          fail = false;
          throw new GitHubApiError("rate limited", {
            status: 429,
            retryable: true,
            retryAt: "2026-09-08T04:05:00.000Z",
          });
        }
        return { author: null, parents: [] };
      },
      associatedPullRequests: async () => [],
    };
    const input = {
      client,
      ledger,
      repository: ".",
      headSha: sha(5),
      observedAt: "2026-09-08T04:00:00Z",
      policyVersion: "fixture",
      ownerIds: new Set(),
      ownerAgentIds: new Set(),
      batchSize: 10,
      discoverTargets: () => targets,
    };
    const deferred = await classifyRange({ ...input, now: new Date("2026-09-08T04:00:00Z") });
    expect(deferred).toMatchObject({ complete: false, deferred: true, processed: 2 });
    expect(ledger.frontier.scan).toMatchObject({
      nextIndex: 2,
      retryAt: "2026-09-08T04:05:00.000Z",
    });
    const checkpoint = JSON.parse(JSON.stringify(ledger));
    const callsAtCheckpoint = calls;
    await classifyRange({
      ...input,
      ledger: checkpoint,
      now: new Date("2026-09-08T04:04:59Z"),
      discoverTargets: () => {
        throw new Error("a persisted scan must not rediscover history");
      },
    });
    expect(calls).toBe(callsAtCheckpoint);
    const completed = await classifyRange({
      ...input,
      ledger: checkpoint,
      now: new Date("2026-09-08T04:05:00Z"),
      discoverTargets: () => {
        throw new Error("a persisted scan must not rediscover history");
      },
    });
    expect(completed.complete).toBe(true);
    expect(checkpoint.frontier.scan).toBeNull();
    expect(checkpoint.frontier.scannedHeadSha).toBe(sha(5));
  });
});
