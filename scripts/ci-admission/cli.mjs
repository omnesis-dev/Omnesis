#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  advanceFrontier,
  attestRun,
  attachRun,
  beginDispatch,
  createDailyRequest,
  createLedger,
  createManualRequest,
  pendingRequests,
  reconcileAttempt,
  recordReachableCommits,
} from "./model.mjs";
import { FileLedgerStore } from "./state-store.mjs";

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

async function input() {
  if (process.stdin.isTTY) return {};
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text.trim() ? JSON.parse(text) : {};
}

const command = process.argv[2];
const store = new FileLedgerStore(option("state", ".ci-admission-state"));
const payload = await input();
let ledger;
let output;

switch (command) {
  case "initialize": {
    if (await store.read({ required: false })) throw new Error("admission state already exists");
    ledger = createLedger(option("sha"), new Date().toISOString());
    await store.write(ledger);
    output = { frontier: ledger.frontier };
    break;
  }
  case "reconcile": {
    ledger = await store.read();
    const expected = ledger.frontier.scannedHeadSha;
    recordReachableCommits(ledger, payload.commits, {
      policyVersion: process.env.OMNESIS_CI_IDENTITY_POLICY_VERSION ?? "unset",
      observedAt: payload.observedAt ?? new Date().toISOString(),
    });
    advanceFrontier(ledger, expected, payload.headSha);
    await store.write(ledger, expected);
    output = {
      frontier: ledger.frontier,
      requestKeys: Object.keys(ledger.requests),
    };
    break;
  }
  case "daily": {
    ledger = await store.read();
    createDailyRequest(ledger, {
      instant: payload.instant ?? new Date(),
      targetSha: payload.targetSha,
      createdAt: payload.createdAt ?? new Date().toISOString(),
    });
    await store.write(ledger);
    output = {
      date: ledger.frontier.lastDailyDate,
      request: ledger.requests[`daily:${ledger.frontier.lastDailyDate}`] ?? null,
    };
    break;
  }
  case "manual": {
    ledger = await store.read();
    const request = createManualRequest(ledger, {
      targetSha: payload.targetSha,
      createdAt: payload.createdAt ?? new Date().toISOString(),
      id: payload.id,
    });
    await store.write(ledger);
    output = { request };
    break;
  }
  case "claim": {
    ledger = await store.read();
    const dispatches = pendingRequests(ledger, Number(payload.limit ?? 3)).map((request) => {
      beginDispatch(request);
      return {
        requestKey: request.key,
        targetSha: request.targetSha,
        dispatchToken: request.dispatchToken,
        inventoryVersion: request.manifest.inventoryVersion,
      };
    });
    await store.write(ledger);
    output = { dispatches };
    break;
  }
  case "attach": {
    ledger = await store.read();
    const request = ledger.requests[payload.requestKey];
    if (!request) throw new Error("unknown request");
    attachRun(request, payload.runId, payload.controllerSha);
    await store.write(ledger);
    output = { request };
    break;
  }
  case "admit": {
    ledger = await store.read();
    const request = ledger.requests[payload.requestKey];
    const admitted = Boolean(request && attestRun(request, payload));
    if (!admitted) process.exitCode = 78;
    output = { admitted };
    break;
  }
  case "complete": {
    ledger = await store.read();
    const request = ledger.requests[payload.requestKey];
    if (!request) throw new Error("unknown request");
    reconcileAttempt(ledger, request, payload);
    await store.write(ledger);
    output = { request, lastSuccessfulFullSha: ledger.frontier.lastSuccessfulFullSha };
    break;
  }
  default:
    throw new Error(`unknown command: ${command ?? "(missing)"}`);
}

if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
