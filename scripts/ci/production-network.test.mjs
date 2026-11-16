// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parse } from "yaml";

const root = join(import.meta.dirname, "..", "..");
const tripwire = join(root, "scripts", "ci", "network-tripwire.cjs");
const script = join(root, "scripts", "ci", "production-network.sh");
const workflow = (name) => parse(readFileSync(join(root, ".github", "workflows", name), "utf8"));

const ISOLATE = "Keep this job off production Omnesis services";
const VERIFY = "Check nothing tried to reach production Omnesis services";

let scratch;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** Runs `source` in a Node process with only the tripwire preloaded. */
function withTripwire(source) {
  scratch = mkdtempSync(join(tmpdir(), "omnesis-network-tripwire-"));
  const log = join(scratch, "tripwire.log");
  writeFileSync(log, "");
  const file = join(scratch, "probe.mjs");
  writeFileSync(file, source);
  const result = spawnSync(process.execPath, [file], {
    cwd: scratch,
    env: {
      ...process.env,
      NODE_OPTIONS: `--require ${tripwire}`,
      OMNESIS_NETWORK_TRIPWIRE_LOG: log,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { ...result, log: readFileSync(log, "utf8") };
}

describe("the CI network tripwire", () => {
  test("refuses and records a deliberate lookup of the production relay in every kind of Node process", () => {
    // Each step runs only after the previous one was refused, so a broken
    // tripwire stops at the first DNS question and never sends a request.
    const run = withTripwire(`
      import dns from "node:dns";
      import { lookup } from "node:dns/promises";
      import { execFileSync } from "node:child_process";
      import { Worker } from "node:worker_threads";
      const outcomes = [];
      const refused = (label, error) => {
        outcomes.push(label + ":" + (error?.code ?? "resolved"));
        if (error?.code !== "ENOTFOUND") { console.log(JSON.stringify(outcomes)); process.exit(1); }
      };
      await new Promise((done) => dns.lookup("relay.omnesis.app", (error) => { refused("lookup", error); done(); }));
      await lookup("RELAY.Omnesis.APP.").then(() => refused("esm"), (error) => refused("esm", error));
      await new dns.promises.Resolver().resolve4("dns.omnesis.app").then(() => refused("resolver"), (error) => refused("resolver", error));
      await new Promise((done) => {
        const worker = new Worker('require("node:dns").lookup("push.omnesis.app", (e) => require("node:worker_threads").parentPort.postMessage(e?.code ?? "resolved"))', { eval: true });
        worker.once("message", (code) => { refused("worker", { code }); worker.terminate().then(done); });
      });
      const child = execFileSync(process.execPath, ["-e", 'require("node:dns").lookup("omnesis.app", (e) => process.stdout.write(e?.code ?? "resolved"))'], { encoding: "utf8" });
      refused("child", { code: child });
      await fetch("https://g-0123456789ab.relay.omnesis.app/").then(() => refused("fetch"), (error) => refused("fetch", error.cause));
      // Everything else still resolves, and a look-alike name is not recorded.
      await lookup("localhost");
      await lookup("omnesis.app.invalid").catch(() => {});
      console.log(JSON.stringify(outcomes));
    `);
    expect(run.stdout.trim(), run.stderr).toBe(
      JSON.stringify([
        "lookup:ENOTFOUND",
        "esm:ENOTFOUND",
        "resolver:ENOTFOUND",
        "worker:ENOTFOUND",
        "child:ENOTFOUND",
        "fetch:ENOTFOUND",
      ]),
    );
    expect(run.status).toBe(0);
    for (const call of [
      "dns.lookup(relay.omnesis.app)",
      "dns.promises.lookup(RELAY.Omnesis.APP.)",
      "dns.promises.Resolver.resolve4(dns.omnesis.app)",
      "dns.lookup(push.omnesis.app)",
      "dns.lookup(omnesis.app)",
      "dns.lookup(g-0123456789ab.relay.omnesis.app)",
    ])
      expect(run.log).toContain(`[network-tripwire] blocked ${call}`);
    expect(run.log).not.toContain("omnesis.app.invalid");
    expect(run.log).not.toContain("localhost");
  });

  test("verify fails a job whose record names an attempt, and passes an empty one", () => {
    scratch = mkdtempSync(join(tmpdir(), "omnesis-network-verify-"));
    const log = join(scratch, "production-network-tripwire.log");
    const verify = () =>
      spawnSync("bash", [script, "verify"], {
        env: { ...process.env, RUNNER_TEMP: scratch },
        encoding: "utf8",
      });
    expect(verify().status, "a job that was never isolated").toBe(1);
    writeFileSync(log, "");
    expect(verify().status).toBe(0);
    writeFileSync(log, "[network-tripwire] blocked dns.lookup(relay.omnesis.app) pid=1\n");
    const failed = verify();
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("dns.lookup(relay.omnesis.app)");
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
          run: "scripts/ci/production-network.sh isolate",
        });
        // Nothing before the block runs Node, a test or an installer.
        for (const step of steps.slice(0, isolate))
          expect(String(step.run ?? "")).not.toMatch(/\b(node|npm|npx|tsx|gradlew|xcodebuild)\b/);
        expect(steps.at(-1)).toMatchObject({
          name: VERIFY,
          if: "${{ always() && steps.production-network.outcome == 'success' }}",
          run: "scripts/ci/production-network.sh verify",
        });
        // A step-level NODE_OPTIONS would drop the tripwire for that step.
        for (const step of steps)
          if (step.env?.NODE_OPTIONS !== undefined)
            expect(step.env.NODE_OPTIONS).toMatch(/^\$\{\{ env\.NODE_OPTIONS \}\} /);
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
