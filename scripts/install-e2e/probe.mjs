#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the install/update lane asserts about a host, before and after.
 *
 *   node scripts/install-e2e/probe.mjs health --url <gateway> [--expect-version x.y.z] [--timeout s]
 *   node scripts/install-e2e/probe.mjs snapshot --url <gateway> --token-file <f> [--query <q>]
 *        [--services <json file>] [--doctor <json file>] [--backups <json file>] [--fleet]
 *   node scripts/install-e2e/probe.mjs compare --before <snapshot> --after <snapshot>
 *        --expect-version <x.y.z> [--expect-restart gateway,collector] [--expect-backup]
 *        [--expect-title <t>] [--expect-fleet-current]
 *
 * `snapshot` reads the gateway's HTTP API with a scoped token the lane minted
 * for itself, and folds in what the CLI printed as JSON on that host (service
 * PIDs, doctor checks, backups). `compare` states every expectation of an
 * update as one list of failures, so a red run names all of them at once.
 *
 * TLS is verified: the lane points NODE_EXTRA_CA_CERTS at the gateway's own
 * certificate when that certificate is self-signed.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function getJson(base, path, token) {
  const res = await fetch(new URL(path, base), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return res.json();
}

async function postJson(base, path, token, body) {
  const res = await fetch(new URL(path, base), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`POST ${path}: HTTP ${res.status}`);
  return res.json();
}

function readJsonFile(path) {
  if (!path || !existsSync(path)) return null;
  const text = readFileSync(path, "utf8").trim();
  return text ? JSON.parse(text) : null;
}

/** Wait until `/health` answers ok (and, when asked, with a version). */
export async function waitHealthy(base, { expectVersion, timeoutMs, intervalMs = 2000 }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const health = await getJson(base, "/health");
      if (health.status === "ok" && (!expectVersion || health.version === expectVersion))
        return health;
      last = `status=${health.status} version=${health.version}`;
    } catch (err) {
      last = err instanceof Error ? (err.cause?.code ?? err.message) : String(err);
    }
    if (Date.now() >= deadline)
      throw new Error(`gateway not healthy${expectVersion ? ` on ${expectVersion}` : ""}: ${last}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function takeSnapshot({ url, token, query, services, doctor, backups, fleet }) {
  const health = await getJson(url, "/health");
  const status = await getJson(url, "/status", token);
  const devices = await getJson(url, "/admin/devices", token);
  const snapshot = {
    takenAt: new Date().toISOString(),
    version: health.version ?? null,
    uptime: status.uptime ?? null,
    docTotal: status.documents?.total ?? null,
    devices: (devices.items ?? [])
      .filter((d) => !d.revokedAt)
      .map((d) => ({
        id: d.id,
        name: d.name,
        kind: d.kind,
        online: d.online === true,
        version: d.version ?? null,
      })),
    services: (services?.items ?? []).map((s) => ({
      component: s.component,
      state: s.state,
      pid: s.pid ?? null,
    })),
    doctorFailures: (doctor?.checks ?? []).filter((c) => c.status === "fail").map((c) => c.id),
    preUpdateBackups: (backups?.backups ?? []).filter((b) => b.purpose === "pre-update").length,
    search: null,
    fleet: null,
  };
  if (query) {
    const result = await postJson(url, "/search", token, { query, limit: 10 });
    snapshot.search = { query, titles: (result.results ?? []).map((r) => r.title) };
  }
  if (fleet) {
    const plan = await getJson(url, "/admin/fleet/update", token);
    snapshot.fleet = {
      targetVersion: plan.targetVersion ?? null,
      devices: (plan.devices ?? []).map((d) => ({
        id: d.id,
        name: d.name,
        version: d.version ?? null,
        disposition: d.disposition?.kind ?? null,
        updateState: d.updateState ?? null,
      })),
    };
  }
  return snapshot;
}

/** Every way `after` fails what an update from `before` promised. Empty means it held. */
export function compareSnapshots(before, after, expect) {
  const failures = [];
  if (after.version !== expect.version) {
    failures.push(`gateway serves ${after.version}, expected ${expect.version}`);
  }
  for (const svc of before.services) {
    const now = after.services.find((s) => s.component === svc.component);
    if (!now || now.state !== "running" || !now.pid) {
      failures.push(
        `${svc.component} is not running under its supervisor (${now?.state ?? "missing"})`,
      );
      continue;
    }
    if (expect.restart.includes(svc.component) && svc.pid && now.pid === svc.pid) {
      failures.push(`${svc.component} was not restarted (still pid ${now.pid})`);
    }
  }
  if (
    expect.restart.includes("gateway") &&
    before.uptime !== null &&
    after.uptime !== null &&
    after.uptime >= before.uptime + elapsedSeconds(before, after)
  ) {
    failures.push(`gateway uptime ${after.uptime}s shows no restart`);
  }
  for (const device of before.devices.filter((d) => d.kind === "collector")) {
    const same = after.devices.find((d) => d.id === device.id);
    if (!same)
      failures.push(`collector ${device.name} (${device.id}) is gone or has a new device id`);
    else if (!same.online) failures.push(`collector ${device.name} is not connected`);
  }
  if (before.docTotal !== after.docTotal) {
    failures.push(`document count changed from ${before.docTotal} to ${after.docTotal}`);
  }
  if (expect.title) {
    const titles = after.search?.titles ?? [];
    if (!titles.includes(expect.title)) {
      failures.push(
        `search for "${after.search?.query}" no longer finds "${expect.title}" (got ${JSON.stringify(titles)})`,
      );
    }
  }
  if (expect.backup && after.preUpdateBackups <= before.preUpdateBackups) {
    failures.push("no new pre-update backup was taken");
  }
  const newFailures = after.doctorFailures.filter((id) => !before.doctorFailures.includes(id));
  if (newFailures.length > 0)
    failures.push(`doctor reports new failures: ${newFailures.join(", ")}`);
  if (expect.fleetCurrent) {
    const fleet = after.fleet;
    if (!fleet) failures.push("no fleet plan was read");
    else {
      for (const d of fleet.devices) {
        if (d.disposition !== "current" || d.updateState === "failed") {
          failures.push(
            `fleet device ${d.name} is ${d.disposition} on ${d.version} (update ${d.updateState})`,
          );
        }
      }
    }
  }
  return failures;
}

function elapsedSeconds(before, after) {
  return Math.max(0, Math.floor((Date.parse(after.takenAt) - Date.parse(before.takenAt)) / 1000));
}

function parseFlags(argv) {
  const booleans = new Set(["expect-backup", "expect-fleet-current", "fleet"]);
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const key = arg.slice(2);
    if (booleans.has(key)) flags[key] = true;
    else {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      flags[key] = value;
    }
  }
  return flags;
}

async function main([command, ...rest]) {
  const flags = parseFlags(rest);
  if (command === "health") {
    const health = await waitHealthy(flags.url, {
      expectVersion: flags["expect-version"],
      timeoutMs: Number(flags.timeout ?? 120) * 1000,
    });
    process.stdout.write(`${health.version}\n`);
    return;
  }
  if (command === "snapshot") {
    const token = readFileSync(flags["token-file"], "utf8").trim();
    const snapshot = await takeSnapshot({
      url: flags.url,
      token,
      query: flags.query,
      services: readJsonFile(flags.services),
      doctor: readJsonFile(flags.doctor),
      backups: readJsonFile(flags.backups),
      fleet: flags.fleet === true,
    });
    process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
    return;
  }
  if (command === "compare") {
    const before = readJsonFile(flags.before);
    const after = readJsonFile(flags.after);
    if (!before || !after) throw new Error("compare needs --before and --after snapshots");
    const failures = compareSnapshots(before, after, {
      version: flags["expect-version"],
      restart: flags["expect-restart"] ? flags["expect-restart"].split(",") : [],
      backup: flags["expect-backup"] === true,
      title: flags["expect-title"],
      fleetCurrent: flags["expect-fleet-current"] === true,
    });
    if (failures.length === 0) {
      process.stdout.write(`probe: all expectations held on ${after.version}\n`);
      return;
    }
    for (const f of failures) process.stdout.write(`::error::${f}\n`);
    process.exit(1);
  }
  throw new Error("usage: probe.mjs health|snapshot|compare …");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`probe: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
