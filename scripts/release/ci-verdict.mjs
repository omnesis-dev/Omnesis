#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Verify that the exact release commit earned the current full-CI inventory. */
import { pathToFileURL } from "node:url";
import { INVENTORY_VERSION, evaluateManifest } from "../ci-admission/inventory.mjs";

export function fullCiVerdict(ledger, targetSha, inventoryVersion = INVENTORY_VERSION) {
  const requests = Object.values(ledger?.requests ?? {})
    .filter((request) => request.targetSha === targetSha)
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  const successful = requests.find((request) => {
    if (request.state !== "success") return false;
    const manifest = request.manifest ?? {};
    return (
      manifest.inventoryVersion === inventoryVersion &&
      evaluateManifest(manifest.results ?? {}, manifest.inventoryVersion).success
    );
  });
  if (successful) {
    return {
      ok: true,
      state: "green",
      requestKey: successful.key,
      runId: successful.workflowRunId,
    };
  }
  if (requests.length === 0) return { ok: false, state: "missing" };
  const newest = requests[0];
  return {
    ok: false,
    state: newest.state === "success" ? "stale-inventory" : newest.state,
    requestKey: newest.key,
    runId: newest.workflowRunId,
  };
}

export function formatVerdict(verdict) {
  const mark = verdict.ok ? "✔" : "✖";
  const request = verdict.requestKey ? ` (${verdict.requestKey})` : "";
  const run = verdict.runId ? ` — Actions run ${verdict.runId}` : "";
  return `${mark} full-validation: ${verdict.state}${request}${run}`;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const targetSha = process.argv[2];
  let ledger;
  try {
    ledger = JSON.parse(await readStdin());
  } catch {
    console.error("ci-verdict: could not parse the admission ledger on stdin");
    process.exit(1);
  }
  const verdict = fullCiVerdict(ledger, targetSha);
  console.log(formatVerdict(verdict));
  process.exit(verdict.ok ? 0 : 1);
}
