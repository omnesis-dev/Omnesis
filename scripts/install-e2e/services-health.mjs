#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseCommand } from "./args.mjs";
import { gatewayBootBudgetMs, gatewayBootBudgetSeconds } from "../lib/boot-budget.mjs";

const run = promisify(execFile);
const components = ["gateway", "collector"];

function identity(services, component) {
  const matches = services.filter((service) => service.component === component);
  const service = matches[0];
  if (
    matches.length !== 1 ||
    !Number.isInteger(service.pid) ||
    service.pid <= 0 ||
    !service.started
  ) {
    throw new Error(`${component} has no running process identity`);
  }
  return service;
}

/** Capture supervisor PIDs and OS process start times, without talking to the gateway. */
export async function captureServices(cli, signal, execute = run) {
  const { stdout } = await execute(cli, ["service", "status", "--json"], { signal });
  const { items } = JSON.parse(stdout);
  return Promise.all(
    components.map(async (component) => {
      const service = items.find((item) => item.component === component);
      if (
        !service?.installed ||
        service.state !== "running" ||
        !Number.isInteger(service.pid) ||
        service.pid <= 0
      ) {
        throw new Error(`${component} is not running under its supervisor`);
      }
      const { stdout: started } = await execute(
        "ps",
        ["-p", String(service.pid), "-o", "lstart="],
        { signal },
      );
      const result = { component, pid: service.pid, started: started.trim() };
      identity([result], component);
      return result;
    }),
  );
}

function assertSameServices(before, after) {
  for (const component of components) {
    const expected = identity(before, component);
    const actual = identity(after, component);
    if (actual.pid !== expected.pid || actual.started !== expected.started) {
      throw new Error(`${component} process changed during the dry run`);
    }
  }
}

/** Retry positive readiness only while both original supervised processes remain alive. */
export async function waitUnchangedHealthy(
  before,
  {
    readServices,
    readHealth,
    timeoutMs = gatewayBootBudgetMs(),
    now = Date.now,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  },
) {
  const deadline = now() + timeoutMs;
  let last = "no healthy response";
  const budget = () => {
    const remaining = deadline - now();
    if (remaining <= 0)
      throw new Error(`gateway did not become healthy with unchanged services: ${last}`);
    return remaining;
  };
  for (;;) {
    assertSameServices(before, await readServices(AbortSignal.timeout(budget())));
    let healthy = false;
    try {
      await readHealth(AbortSignal.timeout(Math.min(5000, budget())));
      healthy = true;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    // Check after successful probes too: a replacement can answer health immediately.
    assertSameServices(before, await readServices(AbortSignal.timeout(budget())));
    budget();
    if (healthy) return;
    await sleep(Math.min(1000, budget()));
  }
}

async function main(argv) {
  const { command, flags } = parseCommand(argv, {
    capture: { values: ["cli"], required: ["cli"] },
    wait: {
      values: ["cli", "before", "url", "expect-version"],
      numbers: ["timeout"],
      required: ["cli", "before", "url", "expect-version"],
    },
  });
  if (command === "capture") {
    const services = await captureServices(flags.cli, AbortSignal.timeout(20_000));
    process.stdout.write(`${JSON.stringify(services)}\n`);
    return;
  }
  await waitUnchangedHealthy(JSON.parse(readFileSync(flags.before, "utf8")), {
    timeoutMs: (flags.timeout ?? gatewayBootBudgetSeconds()) * 1000,
    readServices: (signal) => captureServices(flags.cli, signal),
    readHealth: async (signal) => {
      const response = await fetch(new URL("/health", flags.url), { signal });
      if (!response.ok) throw new Error(`health HTTP ${response.status}`);
      const health = await response.json();
      if (health.status !== "ok" || health.version !== flags["expect-version"]) {
        throw new Error("gateway health or version does not match the installed candidate");
      }
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`services-health: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
