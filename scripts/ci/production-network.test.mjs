// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { ownedProcessCleanupReceipt, spawnOwnedChildProcess } from "@omnesis/core";
import { Resolver } from "node:dns/promises";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parse } from "yaml";

const root = join(import.meta.dirname, "..", "..");
const script = join(root, "scripts", "ci", "production-network.sh");
const workflow = (name) => parse(readFileSync(join(root, ".github", "workflows", name), "utf8"));

const ISOLATE = "Keep this job off production Omnesis services";
const VERIFY = "Check nothing tried to reach production Omnesis services";

let scratch;
let retainScratch = false;
afterEach(() => {
  if (scratch && !retainScratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
  retainScratch = false;
});

describe("the loopback DNS sink", () => {
  test("refuses a deliberate lookup of the production relay and records it", async () => {
    scratch = mkdtempSync(join(tmpdir(), "omnesis-dns-sink-"));
    const record = join(scratch, "dns-sink.log");
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    let owner;
    try {
      owner = spawnOwnedChildProcess(
        process.platform === "win32" ? "python" : "python3",
        [join(root, "scripts", "ci", "dns-sink.py"), String(port), record],
        { env: process.env },
      );
    } catch (error) {
      retainScratch = ownedProcessCleanupReceipt(error) !== undefined;
      throw error;
    }
    const ready = once(owner.child.stdout, "data", { signal: AbortSignal.timeout(5_000) });
    owner.child.stderr.resume();
    const stop = async () => {
      try {
        await owner.stop();
        expect(owner.joinedConfirmed).toBe(true);
      } catch (error) {
        retainScratch = ownedProcessCleanupReceipt(error) !== undefined;
        throw error;
      }
    };
    try {
      await Promise.all([
        owner.ready,
        Promise.race([
          ready.then(([chunk]) => expect(String(chunk).trim()).toBe("ready")),
          owner.joined.then(() => {
            throw new Error("DNS sink closed before readiness");
          }),
        ]),
      ]);
      const resolver = new Resolver({ timeout: 2_000, tries: 2 });
      resolver.setServers([`127.0.0.1:${port}`]);
      // It never answers with an address.
      await expect(resolver.resolve4("relay.omnesis.app")).rejects.toMatchObject({
        code: "EREFUSED",
      });
      await expect(resolver.resolve4("G-0123.Relay.Omnesis.App")).rejects.toMatchObject({
        code: "EREFUSED",
      });
      expect(readFileSync(record, "utf8")).toMatch(
        /DNS query for relay\.omnesis\.app\n.*DNS query for g-0123\.relay\.omnesis\.app\n$/i,
      );
    } finally {
      await stop();
    }
  });
});

describe("verify", () => {
  test("fails a job that was never isolated", () => {
    scratch = mkdtempSync(join(tmpdir(), "omnesis-network-verify-"));
    const result = spawnSync("bash", [script, "verify"], {
      env: { ...process.env, RUNNER_TEMP: scratch },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("was the job isolated?");
  });
});

// Every job that runs tests, a gateway, an app or an installer is isolated.
// The rest only read the checkout, or manage the runner's network themselves.
const GUARDED_WORKFLOWS = [
  "ci.yml",
  "android.yml",
  "ios.yml",
  "mobile-journeys.yml",
  "harness-conformance.yml",
  "topology-e2e.yml",
  "docker-e2e.yml",
  "docker-smoke.yml",
  "docker.yml",
  "install-smoke.yml",
  "installer-coverage.yml",
  "installer-release-skew.yml",
  "install-e2e.yml",
];
const EXEMPT = {
  "ci.yml": { privacy: "scans the checkout's text only" },
  "mobile-journeys.yml": { changes: "reads the diff only" },
  "installer-coverage.yml": {
    plan: "computes a matrix only",
    "update-interruption": "injects its own network faults on the runner",
  },
  "install-e2e.yml": {
    "tailnet-plan": "decides whether to run only",
    "tailnet-preflight": "checks credentials only",
    "tailnet-fixture": "builds fixtures only",
    "tailnet-gateway": "Tailscale takes over the runner's DNS",
    "tailnet-collector": "Tailscale takes over the runner's DNS",
  },
};

describe("test jobs keep off production Omnesis services", () => {
  for (const file of GUARDED_WORKFLOWS) {
    for (const [name, job] of Object.entries(workflow(file).jobs)) {
      if (!job.steps) continue; // a reusable-workflow call is checked in its own file
      test(`${file} ${name}`, () => {
        if (EXEMPT[file]?.[name]) {
          expect(job.steps.map((step) => step.name)).not.toContain(ISOLATE);
          return;
        }
        const steps = job.steps;
        const checkout = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
        const isolate = steps.findIndex((step) => step.name === ISOLATE);
        expect(isolate, "no isolate step").toBeGreaterThan(checkout);
        expect(checkout).toBeGreaterThan(-1);
        expect(steps[isolate]).toMatchObject({
          id: "production-network",
          run: "$GITHUB_WORKSPACE/scripts/ci/production-network.sh isolate",
        });
        // Nothing before the block runs Node, a test or an installer.
        for (const step of steps.slice(0, isolate))
          expect(String(step.run ?? "")).not.toMatch(/\b(node|npm|npx|tsx|gradlew|xcodebuild)\b/);
        expect(steps.at(-1)).toMatchObject({
          name: VERIFY,
          if: "${{ always() && steps.production-network.outcome == 'success' }}",
          run: "$GITHUB_WORKSPACE/scripts/ci/production-network.sh verify",
        });
      });
    }
  }

  test("workflows that publish to production are left alone", () => {
    for (const file of ["site.yml", "release.yml", "cloud-relay-image.yml", "docker-publish.yml"])
      expect(readFileSync(join(root, ".github", "workflows", file), "utf8")).not.toContain(
        "production-network.sh",
      );
  });
});
