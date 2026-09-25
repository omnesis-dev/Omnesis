#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// One-time migration: walk ~/.config/omnesis/conversations/*.json and
// bake `unitName` onto every DocRef inside stored tool_use args /
// tool_result results. Runs against the live gateway's /admin/sync/status
// endpoint to build the sourceId → unitName lookup map.
//
// Idempotent — running twice is a no-op (refs that already have unitName
// are left alone). Delete this script after one successful run per
// CLAUDE.md's migration policy.
//
// Usage:
//   OMNESIS_GATEWAY_URL=https://localhost:7600 \
//   OMNESIS_TOKEN=$(cat ~/.config/omnesis/token) \
//   node scripts/migrate-conversations-add-unit-name.mjs

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const GATEWAY = process.env.OMNESIS_GATEWAY_URL ?? "https://localhost:7600";
const TOKEN =
  process.env.OMNESIS_TOKEN ??
  readFileSync(join(homedir(), ".config/omnesis/token"), "utf8").trim();
const CONVS_DIR =
  process.env.OMNESIS_CONVERSATIONS_DIR ?? join(homedir(), ".config/omnesis/conversations");

// macOS-issued localhost certs aren't in Node's CA bundle.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function api(path) {
  const res = await fetch(`${GATEWAY}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return await res.json();
}

/**
 * Build a sourceId → unitName map by composing two endpoints:
 *   1. /admin/sources gives every configured source as { id, type }.
 *   2. /admin/sources/descriptors gives { id (typeId), unitName? }.
 * Neither path bakes source-specific knowledge into this script —
 * adding a new provider with `unitName: "voicemails"` propagates
 * automatically next time this script runs.
 */
async function fetchUnitNameMap() {
  const [sourcesBody, descriptorsBody] = await Promise.all([
    api("/admin/sources"),
    api("/admin/sources/descriptors"),
  ]);
  const sources = Array.isArray(sourcesBody?.items) ? sourcesBody.items : [];
  const descriptors = Array.isArray(descriptorsBody?.items) ? descriptorsBody.items : [];
  const unitByType = new Map();
  for (const d of descriptors) {
    if (typeof d?.id === "string" && typeof d?.unitName === "string" && d.unitName) {
      unitByType.set(d.id, d.unitName);
    }
  }
  const out = new Map();
  for (const s of sources) {
    if (typeof s?.id !== "string" || typeof s?.type !== "string") continue;
    const unit = unitByType.get(s.type);
    if (unit) out.set(s.id, unit);
  }
  return out;
}

function isDocRefLike(v) {
  return (
    v &&
    typeof v === "object" &&
    typeof v.documentId === "string" &&
    typeof v.sourceId === "string" &&
    typeof v.sourceType === "string"
  );
}

let patched = 0;

function patchRef(ref, unitNameMap) {
  if (ref.unitName !== undefined) return false;
  const hit = unitNameMap.get(ref.sourceId);
  if (!hit) return false;
  ref.unitName = hit;
  patched++;
  return true;
}

function walkResult(result, unitNameMap) {
  if (!result || typeof result !== "object") return false;
  let changed = false;
  if (result.kind === "search.results" && Array.isArray(result.results)) {
    for (const r of result.results) {
      if (isDocRefLike(r) && patchRef(r, unitNameMap)) changed = true;
    }
  } else if (
    (result.kind === "document" || result.kind === "cite.recorded") &&
    isDocRefLike(result.ref)
  ) {
    if (patchRef(result.ref, unitNameMap)) changed = true;
  }
  return changed;
}

function walkMessage(m, unitNameMap) {
  if (!m || typeof m !== "object" || !Array.isArray(m.parts)) return false;
  let changed = false;
  for (const p of m.parts) {
    if (p?.kind === "tool_result" && walkResult(p.result, unitNameMap)) changed = true;
  }
  return changed;
}

function migrateFile(path, unitNameMap) {
  const raw = readFileSync(path, "utf8");
  const convo = JSON.parse(raw);
  if (!Array.isArray(convo?.messages)) return false;
  let changed = false;
  for (const m of convo.messages) {
    if (walkMessage(m, unitNameMap)) changed = true;
  }
  if (!changed) return false;
  writeFileSync(path, JSON.stringify(convo, null, 2) + "\n");
  return true;
}

async function main() {
  const unitNameMap = await fetchUnitNameMap();
  console.log(`Loaded ${unitNameMap.size} sourceId → unitName entries from gateway`);

  let touched = 0;
  let scanned = 0;
  let stat;
  try {
    stat = statSync(CONVS_DIR);
  } catch {
    console.log(`${CONVS_DIR} not found, nothing to do`);
    return;
  }
  if (!stat.isDirectory()) {
    console.log(`${CONVS_DIR} not a dir`);
    return;
  }

  for (const name of readdirSync(CONVS_DIR)) {
    if (!name.endsWith(".json")) continue;
    scanned++;
    const path = join(CONVS_DIR, name);
    if (migrateFile(path, unitNameMap)) {
      touched++;
      console.log(`  patched ${name}`);
    }
  }
  console.log(
    `Done — scanned ${scanned} file(s), patched ${touched} file(s), updated ${patched} ref(s) total`,
  );
}

await main();
