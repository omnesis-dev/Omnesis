// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { INVENTORY_VERSION, evaluateManifest } from "./inventory.mjs";

const SHA_RE = /^[0-9a-f]{40}$/;
const TERMINAL = new Set([
  "success",
  "failure",
  "cancelled",
  "infrastructure_error",
  "unavailable",
]);

export function assertSha(value, name = "SHA") {
  if (!SHA_RE.test(value ?? "")) throw new Error(`${name} must be a lowercase 40-hex SHA`);
  return value;
}

export function createLedger(baselineSha, now = new Date().toISOString()) {
  assertSha(baselineSha, "baseline SHA");
  return {
    schema: 1,
    frontier: {
      initializedAt: now,
      baselineSha,
      scannedHeadSha: baselineSha,
      scan: null,
      lastDailyDate: null,
      lastSuccessfulFullSha: null,
      lastSuccessfulFullRequestKey: null,
      nextRequestSequence: 1,
      inventoryVersion: INVENTORY_VERSION,
    },
    commits: {},
    requests: {},
    days: {},
    recoveries: [],
  };
}

export function recoverLedger(
  ledger,
  {
    targetSha,
    reason,
    actorId,
    recoveredAt,
    unreachableOwnerCommits = [],
    unreachablePendingRequests = [],
  },
) {
  assertSha(targetSha, "recovery target SHA");
  const normalizedReason = reason?.trim();
  if (
    !normalizedReason ||
    normalizedReason.length > 500 ||
    [...normalizedReason].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw new Error("recovery reason must be 1-500 printable characters");
  }
  if (!Number.isSafeInteger(actorId) || actorId <= 0) throw new Error("invalid recovery actor ID");

  const recoveryNumber = (ledger.recoveries ??= []).length + 1;
  const recoveryId = `recovery:${recoveryNumber}`;
  const retiredOwnerCommits = [];
  for (const sha of unreachableOwnerCommits) {
    const commit = ledger.commits[sha];
    if (!commit || commit.classification !== "owner" || commit.dailyRequest != null) continue;
    commit.retiredByRecovery = recoveryId;
    commit.retiredAt = recoveredAt;
    commit.retirementReason = "unreachable-after-main-recovery";
    retiredOwnerCommits.push(sha);
  }
  const unavailableRequests = [];
  for (const key of unreachablePendingRequests) {
    const request = ledger.requests[key];
    if (!request || request.state !== "pending") continue;
    request.state = "unavailable";
    request.unavailableAt = recoveredAt;
    request.unavailableReason = "unreachable-after-main-recovery";
    unavailableRequests.push(key);
  }

  const previous = {
    baselineSha: ledger.frontier.baselineSha,
    scannedHeadSha: ledger.frontier.scannedHeadSha,
    scanTargetSha: ledger.frontier.scan?.targetSha ?? null,
  };
  ledger.frontier.baselineSha = targetSha;
  ledger.frontier.scannedHeadSha = targetSha;
  ledger.frontier.scan = null;
  ledger.recoveries.push({
    id: recoveryId,
    recoveredAt,
    actorId,
    reason: normalizedReason,
    targetSha,
    previous,
    retiredOwnerCommits,
    unavailableRequests,
  });
  syncSharedValidations(ledger);
  return ledger.recoveries.at(-1);
}

function trusted(id, ownerIds, ownerAgentIds) {
  return Number.isInteger(id) && (ownerIds.has(id) || ownerAgentIds.has(id));
}

export function classifyProvenance({
  authorId,
  pullRequests = [],
  mechanicalWrapper = false,
  ownerIds = new Set(),
  ownerAgentIds = new Set(),
}) {
  if (mechanicalWrapper) {
    return { classification: "mechanical-wrapper", reason: "github-pr-wrapper" };
  }
  if (!trusted(authorId, ownerIds, ownerAgentIds)) {
    return {
      classification: "external",
      reason: authorId == null ? "unattributed" : "external-author",
    };
  }
  if (pullRequests.some((pr) => !trusted(pr.authorId, ownerIds, ownerAgentIds))) {
    return { classification: "external", reason: "external-pr-author" };
  }
  return { classification: "owner", reason: "trusted-author" };
}

export function recordReachableCommits(ledger, commits, { policyVersion, observedAt }) {
  for (const commit of commits) {
    assertSha(commit.sha);
    assertSha(commit.integrationTargetSha, "integration target SHA");
    const existing = ledger.commits[commit.sha];
    if (existing) {
      if (
        existing.integrationTargetSha !== commit.integrationTargetSha ||
        existing.classification !== commit.classification
      ) {
        throw new Error(`immutable classification changed for ${commit.sha}`);
      }
      continue;
    }
    const record = {
      sha: commit.sha,
      integrationTargetSha: commit.integrationTargetSha,
      classification: commit.classification,
      reason: commit.reason,
      pullRequest: commit.pullRequest ?? null,
      policyVersion,
      firstObservedAt: observedAt,
      dailyRequest: null,
    };
    ledger.commits[commit.sha] = record;
    if (record.classification === "external") {
      const key = `external:${record.sha}`;
      ledger.requests[key] ??= makeRequest(ledger, {
        key,
        kind: "external",
        contributionSha: record.sha,
        targetSha: record.integrationTargetSha,
        createdAt: observedAt,
      });
    }
  }
  return ledger;
}

function ensureRequestSequences(ledger) {
  let next = Number.isSafeInteger(ledger.frontier.nextRequestSequence)
    ? ledger.frontier.nextRequestSequence
    : 1;
  for (const request of Object.values(ledger.requests)) {
    if (!Number.isSafeInteger(request.sequence) || request.sequence <= 0) request.sequence = next++;
    else next = Math.max(next, request.sequence + 1);
  }
  ledger.frontier.nextRequestSequence = next;
}

function makeRequest(ledger, { key, kind, contributionSha = null, targetSha, createdAt }) {
  ensureRequestSequences(ledger);
  return {
    key,
    kind,
    contributionSha,
    targetSha: assertSha(targetSha, "target SHA"),
    createdAt,
    sequence: ledger.frontier.nextRequestSequence++,
    state: "pending",
    dispatchToken: null,
    workflowRunId: null,
    attempts: [],
    manifest: {
      inventoryVersion: INVENTORY_VERSION,
      required: [],
      results: {},
      controllerSha: null,
    },
  };
}

function shareActiveValidation(ledger, request) {
  const existing = Object.values(ledger.requests).find(
    (candidate) =>
      candidate.key !== request.key &&
      new Set([candidate.kind, request.kind]).size === 2 &&
      [candidate.kind, request.kind].every((kind) => ["daily", "manual"].includes(kind)) &&
      candidate.targetSha === request.targetSha &&
      candidate.manifest.inventoryVersion === request.manifest.inventoryVersion &&
      ["pending", "dispatching", "queued", "in_progress", "waiting"].includes(candidate.state),
  );
  if (!existing) return request;
  request.state = "waiting";
  request.satisfiedBy = existing.satisfiedBy ?? existing.key;
  return request;
}

export function syncSharedValidations(ledger) {
  for (const request of Object.values(ledger.requests)) {
    if (!request.satisfiedBy) continue;
    const source = ledger.requests[request.satisfiedBy];
    if (!source) throw new Error(`${request.key} references a missing shared validation`);
    request.workflowRunId = source.workflowRunId;
    request.dispatchToken = source.dispatchToken;
    request.attempts = structuredClone(source.attempts);
    request.manifest = structuredClone(source.manifest);
    if (TERMINAL.has(source.state)) {
      request.state = source.state;
      request.completedBySharedValidation = source.key;
    } else {
      request.state = "waiting";
      delete request.completedBySharedValidation;
    }
  }
  return ledger;
}

export function londonDate(instant) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.valueOf())) throw new Error("invalid scheduled instant");
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function londonHour(instant) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.valueOf())) throw new Error("invalid scheduled instant");
  const hour = new Intl.DateTimeFormat("en", {
    timeZone: "Europe/London",
    hour: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .find((part) => part.type === "hour")?.value;
  if (hour == null) throw new Error("could not derive Europe/London hour");
  return Number(hour);
}

export function shouldCreateDailyDuringReconcile(instant) {
  return londonHour(instant) >= 4;
}

export function createDailyRequest(ledger, { instant, targetSha, createdAt }) {
  const date = londonDate(instant);
  const key = `daily:${date}`;
  if (ledger.requests[key] || ledger.days[date]) return ledger.requests[key] ?? null;
  const included = Object.values(ledger.commits)
    .filter(
      (commit) =>
        commit.classification === "owner" &&
        commit.dailyRequest == null &&
        commit.retiredByRecovery == null,
    )
    .map((commit) => commit.sha);
  ledger.frontier.lastDailyDate = date;
  if (included.length === 0) {
    ledger.days[date] = { date, createdAt, outcome: "no-owner-changes" };
    return null;
  }
  const request = makeRequest(ledger, { key, kind: "daily", targetSha, createdAt });
  request.ownerCommits = included;
  ledger.requests[key] = request;
  shareActiveValidation(ledger, request);
  for (const sha of included) ledger.commits[sha].dailyRequest = key;
  ledger.days[date] = { date, createdAt, outcome: "requested", requestKey: key };
  return request;
}

export function createManualRequest(ledger, { targetSha, createdAt, id = randomUUID() }) {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(id)) throw new Error("invalid manual request ID");
  const key = `manual:${id}`;
  if (ledger.requests[key]) throw new Error(`manual request already exists: ${key}`);
  const request = makeRequest(ledger, { key, kind: "manual", targetSha, createdAt });
  ledger.requests[key] = request;
  return shareActiveValidation(ledger, request);
}

export function pendingRequests(ledger, inFlightLimit = 3) {
  const active = Object.values(ledger.requests).filter((request) =>
    ["dispatching", "queued", "in_progress"].includes(request.state),
  ).length;
  return Object.values(ledger.requests)
    .filter((request) => request.state === "pending")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key))
    .slice(0, Math.max(0, inFlightLimit - active));
}

export function beginDispatch(request, token = randomUUID()) {
  if (request.state !== "pending") throw new Error(`${request.key} is not pending`);
  request.state = "dispatching";
  request.dispatchToken = token;
  request.dispatchAttempts = 0;
  return request;
}

export function attachRun(request, runId, controllerSha = null) {
  if (request.state !== "dispatching") throw new Error(`${request.key} is not dispatching`);
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("invalid workflow run ID");
  if (request.workflowRunId != null && request.workflowRunId !== runId) {
    throw new Error(`${request.key} already belongs to another run`);
  }
  request.workflowRunId = runId;
  if (controllerSha != null)
    request.manifest.controllerSha = assertSha(controllerSha, "controller SHA");
  request.state = "queued";
  return request;
}

export function attestRun(
  request,
  { targetSha, token, runId, runAttempt = 1, inventoryVersion, controllerSha = null },
) {
  const greatestAttempt = Math.max(0, ...request.attempts.map((attempt) => attempt.runAttempt));
  return (
    request.targetSha === targetSha &&
    request.dispatchToken === token &&
    request.workflowRunId === runId &&
    request.manifest.inventoryVersion === inventoryVersion &&
    request.manifest.controllerSha != null &&
    request.manifest.controllerSha === controllerSha &&
    (!TERMINAL.has(request.state) || runAttempt > greatestAttempt)
  );
}

export function reconcileAttempt(
  ledger,
  request,
  { runId, runAttempt, state, startedAt, endedAt = null, manifest = null },
) {
  if (request.workflowRunId !== runId) throw new Error("run ID does not match request");
  const prior = request.attempts.find((attempt) => attempt.runAttempt === runAttempt);
  const attempt = { runId, runAttempt, state, startedAt, endedAt };
  if (prior) Object.assign(prior, attempt);
  else request.attempts.push(attempt);

  if (!TERMINAL.has(state)) {
    request.state = state;
    return request;
  }
  if (state === "success") {
    const verdict = evaluateManifest(manifest?.results ?? {}, manifest?.inventoryVersion);
    if (!verdict.success) {
      request.state = "failure";
      request.manifest = { ...request.manifest, ...(manifest ?? {}), verdict };
      return request;
    }
    request.manifest = { ...request.manifest, ...manifest, verdict };
    request.state = "success";
    ensureRequestSequences(ledger);
    const recordedKey = ledger.frontier.lastSuccessfulFullRequestKey;
    let recorded = recordedKey == null ? null : ledger.requests[recordedKey];
    if (recorded == null && ledger.frontier.lastSuccessfulFullSha != null) {
      const candidates = Object.values(ledger.requests)
        .filter(
          (candidate) =>
            candidate.targetSha === ledger.frontier.lastSuccessfulFullSha &&
            candidate.state === "success" &&
            candidate.manifest.verdict?.success === true,
        )
        .sort((left, right) => left.sequence - right.sequence);
      recorded = candidates.at(-1) ?? null;
      if (recorded != null) ledger.frontier.lastSuccessfulFullRequestKey = recorded.key;
    }
    const satisfied = Object.values(ledger.requests).filter(
      (candidate) => candidate === request || candidate.satisfiedBy === request.key,
    );
    const latest = satisfied.sort((left, right) => left.sequence - right.sequence).at(-1);
    if (recorded == null || latest.sequence >= recorded.sequence) {
      ledger.frontier.lastSuccessfulFullSha = latest.targetSha;
      ledger.frontier.lastSuccessfulFullRequestKey = latest.key;
    }
    syncSharedValidations(ledger);
    return request;
  }
  if (manifest) {
    request.manifest = {
      ...request.manifest,
      ...manifest,
      verdict: evaluateManifest(manifest.results ?? {}, manifest.inventoryVersion),
    };
  }
  request.state = state;
  syncSharedValidations(ledger);
  return request;
}

export function advanceFrontier(ledger, expectedSha, nextSha) {
  if (ledger.frontier.scannedHeadSha !== expectedSha)
    throw new Error("stale frontier compare-and-swap");
  ledger.frontier.scannedHeadSha = assertSha(nextSha);
  ledger.frontier.scan = null;
}
