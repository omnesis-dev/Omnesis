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
 *   node scripts/install-e2e/probe.mjs pair --url <gateway> --token-file <f> --kind <kind> [--ttl <s>]
 *
 * `pair` mints a pairing code with a lifetime of its own choosing: the
 * collector redeems it only after cloning and building, which can outlast the
 * CLI's default code lifetime on a slow runner.
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
import { parseCommand } from "./args.mjs";

/** Device kinds `omnesis update --fleet` commands; any other kind is updated with its host. */
const FLEET_KINDS = new Set(["collector", "agent"]);
const PAIRING_CODE = /^[0-9A-F]{10}$/;

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

/** Mint a pairing code for `kind` that stays valid for `ttlSeconds`. */
export async function mintPairingCode(base, token, { kind, ttlSeconds }) {
  const pending = await postJson(base, "/admin/devices/pair", token, {
    kind,
    ttlMs: Math.round(ttlSeconds * 1000),
  });
  if (!PAIRING_CODE.test(String(pending.pairingCode))) {
    throw new Error("the gateway answered without a pairing code");
  }
  return pending.pairingCode;
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
  // When uptime was read, not when the snapshot finished: the restart check
  // compares the two.
  const takenAt = new Date().toISOString();
  const devices = await getJson(url, "/admin/devices", token);
  const snapshot = {
    takenAt,
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
    // The lane installs without an embedding model, and `POST /search` finds
    // nothing then (#117), so the keyword check goes through the gateway's
    // document search, which matches stored document content directly.
    const result = await getJson(
      url,
      `/documents/search?q=${encodeURIComponent(query)}&limit=10`,
      token,
    );
    snapshot.search = { query, titles: (result.results ?? []).map((r) => r.title) };
  }
  if (fleet) {
    const plan = await getJson(url, "/admin/fleet/update", token);
    snapshot.fleet = {
      targetVersion: plan.targetVersion ?? null,
      devices: (plan.devices ?? []).map((d) => ({
        id: d.id,
        name: d.name,
        kind: d.kind ?? null,
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
  for (const component of expect.restart) {
    if (!before.services.some((s) => s.component === component)) {
      failures.push(`${component} had no service record before, so its restart cannot be checked`);
    }
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
  // A gateway that restarted has been up for less time than has passed
  // since the first snapshot; the slack absorbs the two roundings.
  if (
    expect.restart.includes("gateway") &&
    before.uptime !== null &&
    after.uptime !== null &&
    after.uptime > elapsedSeconds(before, after) + 2
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
      // The gateway host's own devices are updated with the host and the
      // plan lists them as refused (host-managed); only the kinds the fleet
      // update commands have to be current.
      for (const d of fleet.devices.filter((x) => FLEET_KINDS.has(x.kind))) {
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

const COMMANDS = {
  health: { values: ["url", "expect-version"], numbers: ["timeout"], required: ["url"] },
  snapshot: {
    values: ["url", "token-file", "query", "services", "doctor", "backups"],
    booleans: ["fleet"],
    required: ["url", "token-file"],
  },
  compare: {
    values: ["before", "after", "expect-version", "expect-restart", "expect-title"],
    booleans: ["expect-backup", "expect-fleet-current"],
    required: ["before", "after", "expect-version"],
  },
  pair: {
    values: ["url", "token-file", "kind"],
    numbers: ["ttl"],
    required: ["url", "token-file", "kind"],
  },
};

async function main(argv) {
  const { command, flags } = parseCommand(argv, COMMANDS);
  if (command === "health") {
    const health = await waitHealthy(flags.url, {
      expectVersion: flags["expect-version"],
      timeoutMs: (flags.timeout ?? 120) * 1000,
    });
    process.stdout.write(`${health.version}\n`);
    return;
  }
  const token = readFileSync(flags["token-file"] ?? "/dev/null", "utf8").trim();
  if (command === "snapshot") {
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
  if (command === "pair") {
    const code = await mintPairingCode(flags.url, token, {
      kind: flags.kind,
      ttlSeconds: flags.ttl ?? 3600,
    });
    process.stdout.write(`${code}\n`);
    return;
  }
  const before = readJsonFile(flags.before);
  const after = readJsonFile(flags.after);
  if (!before || !after) throw new Error("compare: --before and --after must name snapshots");
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`probe: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
