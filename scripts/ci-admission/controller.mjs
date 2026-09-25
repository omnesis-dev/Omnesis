#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { GitHubApiError, GitHubClient, parseTrustedIds } from "./github.mjs";
import {
  discoverReachable,
  isAncestorInRepository,
  isMechanicalMerge,
  mapIntegrationTargetsInRepository,
  repositoryHead,
} from "./git-graph.mjs";
import { INVENTORY_VERSION, REQUIRED_LANES } from "./inventory.mjs";
import {
  advanceFrontier,
  attachRun,
  beginDispatch,
  classifyProvenance,
  createDailyRequest,
  createLedger,
  createManualRequest,
  pendingRequests,
  reconcileAttempt,
  recordReachableCommits,
  recoverLedger,
  shouldCreateDailyDuringReconcile,
  syncSharedValidations,
} from "./model.mjs";
import { FileLedgerStore } from "./state-store.mjs";

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function loadEvent() {
  const path = option("event", process.env.GITHUB_EVENT_PATH);
  return path ? JSON.parse(await readFile(path, "utf8")) : {};
}

export function parseRunIdentity(title) {
  const match = /^full-validation \[([^\]]+)] \[([^\]]+)]$/.exec(title ?? "");
  return match ? { requestKey: match[1], dispatchToken: match[2] } : null;
}

export function laneResultsFromJobs(jobs) {
  const results = {};
  const record = (name, conclusion) => {
    const match = /(?:^| \/ )lane \[([^\]]+)]$/.exec(name ?? "");
    if (!match || !REQUIRED_LANES.includes(match[1])) return;
    const previous = results[match[1]];
    results[match[1]] = previous && previous !== "success" ? previous : conclusion;
  };
  for (const job of jobs) {
    record(job.name, job.conclusion);
    for (const step of job.steps ?? []) record(step.name, step.conclusion);
  }
  return results;
}

async function settleWorkflowRun({ client, ledger, run }) {
  const identity = parseRunIdentity(run.display_title);
  if (!identity) throw new Error("completed run has no admission identity");
  const request = ledger.requests[identity.requestKey];
  if (
    !request ||
    request.dispatchToken !== identity.dispatchToken ||
    request.workflowRunId !== run.id ||
    request.manifest.controllerSha !== run.head_sha
  ) {
    throw new Error("workflow run does not match its admission request");
  }
  if (run.status !== undefined && run.status !== "completed") {
    reconcileAttempt(ledger, request, {
      runId: run.id,
      runAttempt: run.run_attempt,
      state: run.status === "in_progress" ? "in_progress" : "queued",
      startedAt: run.run_started_at,
    });
    return request;
  }
  const jobs = await client.workflowJobs(run.id);
  const results = laneResultsFromJobs(jobs);
  const terminalState =
    run.conclusion === "success"
      ? "success"
      : run.conclusion === "cancelled"
        ? "cancelled"
        : "failure";
  reconcileAttempt(ledger, request, {
    runId: run.id,
    runAttempt: run.run_attempt,
    state: terminalState,
    startedAt: run.run_started_at,
    endedAt: run.updated_at,
    manifest: { inventoryVersion: INVENTORY_VERSION, required: REQUIRED_LANES, results },
  });
  return request;
}

export async function reconcileAttachedRuns({ client, ledger }) {
  const reconciled = [];
  for (const request of Object.values(ledger.requests)) {
    if (!["queued", "in_progress"].includes(request.state) || request.workflowRunId == null)
      continue;
    const run = await client.workflowRun(request.workflowRunId);
    await settleWorkflowRun({ client, ledger, run });
    reconciled.push({ requestKey: request.key, state: request.state });
  }
  return reconciled;
}

const DEFAULT_CLASSIFICATION_BATCH_SIZE = 50;

export async function classifyRange({
  client,
  ledger,
  repository,
  headSha,
  observedAt,
  policyVersion,
  ownerIds,
  ownerAgentIds,
  batchSize = DEFAULT_CLASSIFICATION_BATCH_SIZE,
  now = new Date(),
  discoverTargets = (source, from, to) =>
    mapIntegrationTargetsInRepository(source, discoverReachable(source, from, to)),
}) {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0)
    throw new Error("classification batch size must be a positive integer");
  const expected = ledger.frontier.scannedHeadSha;
  let scan = ledger.frontier.scan;
  if (!scan) {
    scan = {
      fromSha: expected,
      targetSha: headSha,
      targets: discoverTargets(repository, expected, headSha),
      nextIndex: 0,
      policyVersion,
      observedAt,
      retryAt: null,
      lastError: null,
    };
    ledger.frontier.scan = scan;
  }
  if (scan.fromSha !== expected) throw new Error("classification scan does not match its frontier");
  if (scan.policyVersion !== policyVersion)
    throw new Error("identity policy changed during a classification scan");
  if (scan.retryAt && now < new Date(scan.retryAt)) {
    return { complete: false, deferred: true, processed: 0, targetSha: scan.targetSha };
  }
  scan.retryAt = null;
  scan.lastError = null;
  const stop = Math.min(scan.targets.length, scan.nextIndex + batchSize);
  let processed = 0;
  while (scan.nextIndex < stop) {
    const target = scan.targets[scan.nextIndex];
    try {
      const [metadata, pulls] = await Promise.all([
        client.commit(target.sha),
        client.associatedPullRequests(target.sha),
      ]);
      if (!metadata || !Array.isArray(metadata.parents) || metadata.author === undefined) {
        throw new Error(`incomplete GitHub provenance for ${target.sha}`);
      }
      const introducing = pulls.filter((pull) => pull.merged_at != null);
      const mergePull = introducing.find((pull) => pull.merge_commit_sha === target.sha);
      const mechanicalWrapper = Boolean(
        mergePull &&
        isMechanicalMerge(repository, {
          sha: target.sha,
          parents: metadata.parents.map((parent) => parent.sha),
          prMergeSha: mergePull.merge_commit_sha,
        }),
      );
      const provenance = classifyProvenance({
        authorId: metadata.author?.id ?? null,
        pullRequests: introducing.map((pull) => ({ authorId: pull.user?.id ?? null })),
        mechanicalWrapper,
        ownerIds,
        ownerAgentIds,
      });
      recordReachableCommits(
        ledger,
        [
          {
            ...target,
            ...provenance,
            pullRequest: introducing.length === 1 ? introducing[0].number : null,
          },
        ],
        { policyVersion: scan.policyVersion, observedAt: scan.observedAt },
      );
      scan.nextIndex += 1;
      processed += 1;
    } catch (error) {
      if (!(error instanceof GitHubApiError) || !error.retryable) throw error;
      scan.retryAt = error.retryAt ?? new Date(now.valueOf() + 60_000).toISOString();
      scan.lastError = { status: error.status ?? null, observedAt: now.toISOString() };
      return { complete: false, deferred: true, processed, targetSha: scan.targetSha };
    }
  }
  if (scan.nextIndex < scan.targets.length) {
    return { complete: false, deferred: false, processed, targetSha: scan.targetSha };
  }
  const completedTarget = scan.targetSha;
  advanceFrontier(ledger, expected, completedTarget);
  return { complete: true, deferred: false, processed, targetSha: completedTarget };
}

async function waitForDispatchedRun(client, workflow, title, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const matches = (await client.workflowRuns(workflow)).filter(
      (run) => run.display_title === title,
    );
    if (matches.length > 1) throw new Error(`duplicate workflow runs named ${title}`);
    if (matches.length === 1) return matches[0];
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return null;
}

export async function recoverAmbiguousDispatches({ client, ledger, workflow }) {
  const ambiguous = Object.values(ledger.requests).filter(
    (request) => request.state === "dispatching" && request.workflowRunId == null,
  );
  if (ambiguous.length === 0) return [];
  const runs = await client.workflowRuns(workflow);
  const recovered = [];
  for (const request of ambiguous) {
    const title = `full-validation [${request.key}] [${request.dispatchToken}]`;
    const matches = runs.filter((run) => run.display_title === title);
    if (matches.length > 1) throw new Error(`duplicate workflow runs named ${title}`);
    if (matches.length === 1) {
      if (!matches[0].head_sha)
        throw new Error(`workflow run ${matches[0].id} has no controller SHA`);
      attachRun(request, matches[0].id, matches[0].head_sha);
      recovered.push({ requestKey: request.key, runId: matches[0].id });
    } else if ((request.dispatchAttempts ?? 0) > 0) {
      request.discoveryChecks = (request.discoveryChecks ?? 0) + 1;
      if (request.discoveryChecks >= 12) request.state = "infrastructure_error";
    }
  }
  return recovered;
}

function prepareDispatches(ledger) {
  return Object.values(ledger.requests)
    .filter(
      (request) =>
        request.state === "dispatching" &&
        request.workflowRunId == null &&
        (request.dispatchAttempts ?? 0) === 0,
    )
    .map((request) => {
      request.dispatchAttempts = 1;
      request.discoveryChecks = 0;
      return {
        requestKey: request.key,
        targetSha: request.targetSha,
        dispatchToken: request.dispatchToken,
        inventoryVersion: request.manifest.inventoryVersion,
      };
    });
}

async function sendPreparedDispatches({ client, ledger, workflow, posts }) {
  const sent = [];
  for (const post of posts ?? []) {
    const request = ledger.requests[post.requestKey];
    if (
      !request ||
      request.state !== "dispatching" ||
      request.workflowRunId != null ||
      request.dispatchAttempts !== 1 ||
      request.dispatchToken !== post.dispatchToken ||
      request.targetSha !== post.targetSha ||
      request.manifest.inventoryVersion !== post.inventoryVersion
    ) {
      throw new Error(`prepared dispatch no longer matches ${post.requestKey}`);
    }
    const title = `full-validation [${request.key}] [${request.dispatchToken}]`;
    const before = await waitForDispatchedRun(client, workflow, title, 1);
    if (before) {
      if (!before.head_sha) throw new Error(`workflow run ${before.id} has no controller SHA`);
      attachRun(request, before.id, before.head_sha);
      sent.push({ requestKey: request.key, runId: before.id, posted: false });
      continue;
    }
    const response = await client.dispatch(workflow, {
      request_key: request.key,
      target_sha: request.targetSha,
      dispatch_token: request.dispatchToken,
      inventory_version: request.manifest.inventoryVersion,
    });
    const runId = response?.workflow_run_id ?? response?.id;
    let run;
    if (Number.isSafeInteger(runId))
      run = response?.head_sha ? response : await client.workflowRun(runId);
    else run = await waitForDispatchedRun(client, workflow, title);
    if (run) {
      if (!run.head_sha) throw new Error(`workflow run ${run.id} has no controller SHA`);
      attachRun(request, run.id, run.head_sha);
    }
    sent.push({ requestKey: request.key, runId: request.workflowRunId, posted: true });
  }
  return sent;
}

export async function runController({
  operation,
  event,
  client,
  store,
  repository,
  workflow = "full-validation.yml",
  now = new Date(),
  ownerIds,
  ownerAgentIds,
  policyVersion,
  inFlightLimit = 3,
  classificationBatchSize = Number(
    process.env.OMNESIS_CI_CLASSIFICATION_BATCH_SIZE ?? DEFAULT_CLASSIFICATION_BATCH_SIZE,
  ),
  resolveRepositoryHead = repositoryHead,
  isRepositoryAncestor = isAncestorInRepository,
}) {
  let ledger = await store.read({ required: false });
  if (operation === "initialize") {
    if (ledger) throw new Error("admission state already exists");
    const actor = await client.user(event.actor);
    if (!ownerIds.has(actor?.id) && !ownerAgentIds.has(actor?.id))
      throw new Error("initialization is owner-only");
    if (event.targetSha !== resolveRepositoryHead(repository))
      throw new Error("initialization target must equal current repository HEAD");
    ledger = createLedger(event.targetSha, now.toISOString());
    await store.write(ledger);
    return { initialized: ledger.frontier };
  }
  if (!ledger) throw new Error("admission state is not initialized");
  const expected = ledger.frontier.scannedHeadSha;

  if (operation === "recover") {
    const actor = await client.user(event.actor);
    if (!ownerIds.has(actor?.id)) throw new Error("frontier recovery is owner-only");
    const currentHead = resolveRepositoryHead(repository);
    if (event.targetSha !== currentHead)
      throw new Error("recovery target must equal current repository HEAD");
    const scannedFrontierDiverged = !isRepositoryAncestor(
      repository,
      ledger.frontier.scannedHeadSha,
      currentHead,
    );
    const activeScanDiverged =
      ledger.frontier.scan != null &&
      !isRepositoryAncestor(repository, ledger.frontier.scan.targetSha, currentHead);
    if (!scannedFrontierDiverged && !activeScanDiverged)
      throw new Error("frontier recovery requires a force-pushed main history");
    const unreachableOwnerCommits = Object.values(ledger.commits)
      .filter(
        (commit) =>
          commit.classification === "owner" &&
          commit.dailyRequest == null &&
          !isRepositoryAncestor(repository, commit.integrationTargetSha, currentHead),
      )
      .map((commit) => commit.sha);
    const unreachablePendingRequests = Object.values(ledger.requests)
      .filter(
        (request) =>
          request.state === "pending" &&
          !isRepositoryAncestor(repository, request.targetSha, currentHead),
      )
      .map((request) => request.key);
    const recovery = recoverLedger(ledger, {
      targetSha: currentHead,
      reason: event.reason,
      actorId: actor.id,
      recoveredAt: now.toISOString(),
      unreachableOwnerCommits,
      unreachablePendingRequests,
    });
    await store.write(ledger, expected);
    return { frontier: ledger.frontier, recovery };
  }

  if (operation === "dispatch") {
    const recovered = await recoverAmbiguousDispatches({ client, ledger, workflow });
    syncSharedValidations(ledger);
    const posts = prepareDispatches(ledger);
    await store.write(ledger, expected);
    return { frontier: ledger.frontier, recovered, posts };
  }
  if (operation === "send_dispatch") {
    const sent = await sendPreparedDispatches({ client, ledger, workflow, posts: event.posts });
    await store.write(ledger, expected);
    return { frontier: ledger.frontier, sent };
  }
  if (operation === "report") {
    const request = ledger.requests[event.requestKey];
    if (
      !request ||
      !["success", "failure", "cancelled", "infrastructure_error", "unavailable"].includes(
        request.state,
      )
    ) {
      throw new Error("only a terminal admitted request can be reported");
    }
    const reportable = [
      request,
      ...Object.values(ledger.requests).filter(
        (candidate) => candidate.completedBySharedValidation === request.key,
      ),
    ];
    for (const candidate of reportable) {
      await client.createCommitStatus(candidate.targetSha, {
        state:
          candidate.state === "success"
            ? "success"
            : candidate.state === "cancelled"
              ? "error"
              : "failure",
        context: `full-validation/${candidate.key}`.slice(0, 100),
        description:
          candidate.state === "success"
            ? "Full validation passed"
            : `Full validation ${candidate.state}`.slice(0, 140),
        target_url: event.targetUrl,
      });
    }
    return {
      reported: reportable.map((candidate) => candidate.key),
      targetSha: request.targetSha,
      state: request.state,
    };
  }

  let classification = null;
  if (["push", "reconcile", "daily"].includes(operation)) {
    classification = await classifyRange({
      client,
      ledger,
      repository,
      headSha: event.targetSha,
      observedAt: now.toISOString(),
      policyVersion,
      ownerIds,
      ownerAgentIds,
      batchSize: classificationBatchSize,
      now,
    });
  }
  let reconciled = [];
  let recovered = [];
  if (operation === "reconcile") {
    reconciled = await reconcileAttachedRuns({ client, ledger });
    recovered = await recoverAmbiguousDispatches({ client, ledger, workflow });
  }
  if (
    (operation === "daily" ||
      (operation === "reconcile" && shouldCreateDailyDuringReconcile(now))) &&
    ledger.frontier.scan == null &&
    ledger.frontier.scannedHeadSha === event.targetSha
  ) {
    createDailyRequest(ledger, {
      instant: event.scheduledAt ?? now,
      targetSha: event.targetSha,
      createdAt: now.toISOString(),
    });
  } else if (operation === "manual") {
    const actor = await client.user(event.actor);
    if (!ownerIds.has(actor?.id) && !ownerAgentIds.has(actor?.id))
      throw new Error("manual admission is owner-only");
    if (!isRepositoryAncestor(repository, ledger.frontier.baselineSha, event.targetSha)) {
      throw new Error("manual target predates or diverges from the trusted CI admission baseline");
    }
    if (!isRepositoryAncestor(repository, event.targetSha, resolveRepositoryHead(repository))) {
      throw new Error("manual target is not reachable from current main");
    }
    createManualRequest(ledger, {
      targetSha: event.targetSha,
      createdAt: now.toISOString(),
      id: event.id,
    });
  } else if (operation === "workflow_run") {
    const run = event.workflowRun;
    await settleWorkflowRun({ client, ledger, run });
  } else if (!["push", "reconcile", "daily"].includes(operation)) {
    throw new Error(`unknown operation: ${operation}`);
  }

  const claims = pendingRequests(ledger, inFlightLimit).map((request) => {
    beginDispatch(request);
    return {
      requestKey: request.key,
      targetSha: request.targetSha,
      dispatchToken: request.dispatchToken,
      inventoryVersion: request.manifest.inventoryVersion,
    };
  });
  syncSharedValidations(ledger);
  await store.write(ledger, expected);
  // The caller must commit and atomically push this state before invoking the
  // separate `dispatch` operation. A full workflow may never outrun its token.
  return { frontier: ledger.frontier, classification, reconciled, recovered, claims };
}

if (process.argv[1] && basename(process.argv[1]) === "controller.mjs") {
  const operation = option("operation");
  const event = await loadEvent();
  const repository = option("repository", process.cwd());
  const store = new FileLedgerStore(option("state", ".ci-admission-state"));
  const client = new GitHubClient({
    repository: requiredEnvironment("GITHUB_REPOSITORY"),
    token: requiredEnvironment("GITHUB_TOKEN"),
  });
  const result = await runController({
    operation,
    event,
    client,
    store,
    repository,
    ownerIds: parseTrustedIds(requiredEnvironment("OMNESIS_CI_OWNER_IDS")),
    ownerAgentIds: parseTrustedIds(process.env.OMNESIS_CI_OWNER_AGENT_IDS),
    policyVersion: requiredEnvironment("OMNESIS_CI_IDENTITY_POLICY_VERSION"),
    inFlightLimit: Number(process.env.OMNESIS_CI_IN_FLIGHT_LIMIT ?? 3),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
