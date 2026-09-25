// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * One boot budget, actually shared.
 *
 * Gateway- and harness-spawning test and developer paths once chose their own
 * numbers. The small ones decided the outcome, so a loaded machine killed
 * whole suites in their hooks — which reports as a failed file with no failing
 * test, and reads like a broken feature rather than a harness that stopped
 * waiting.
 *
 * This asserts the number is defined once and reached the same way by every
 * consumer: the shell helper and the JavaScript helper are executed and their
 * answers compared against the file, and each consumer is checked for a
 * restated literal.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { gatewayBootBudgetMs, gatewayBootBudgetSeconds } from "./lib/boot-budget.mjs";

const ROOT = join(import.meta.dirname, "..");
const BUDGET_FILE = join(ROOT, "scripts/lib/gateway-boot-budget.json");
const declared = JSON.parse(readFileSync(BUDGET_FILE, "utf8"));

describe("the shared gateway boot budget", () => {
  it("is a plausible number of seconds", () => {
    expect(typeof declared.seconds).toBe("number");
    // Below a cold `tsx` transform of the gateway there is no point having a
    // budget at all; above a few minutes, a genuinely dead gateway stops being
    // reported promptly by the hook around it.
    expect(declared.seconds).toBeGreaterThanOrEqual(60);
    expect(declared.seconds).toBeLessThanOrEqual(300);
  });

  it("says why it is that number", () => {
    expect(String(declared.why).length).toBeGreaterThan(200);
  });

  it("reads the same through the JavaScript helper", () => {
    expect(gatewayBootBudgetSeconds()).toBe(declared.seconds);
    expect(gatewayBootBudgetMs()).toBe(declared.seconds * 1000);
  });

  it("reads the same through the shell helper", () => {
    const answer = execFileSync(
      "bash",
      ["-c", `source "${join(ROOT, "scripts/lib/boot_budget")}"; gateway_boot_budget_seconds`],
      { encoding: "utf8" },
    ).trim();
    expect(answer).toBe(String(declared.seconds));
  });

  it("falls back to a usable number when the shell helper cannot run node", () => {
    // A machine without node on PATH must still get a number: an empty string
    // turns `$((SECONDS + READY_TIMEOUT))` into a syntax error, which is a
    // worse failure than waiting the wrong amount of time.
    const answer = execFileSync(
      "bash",
      [
        "-c",
        `PATH=/nonexistent; source "${join(ROOT, "scripts/lib/boot_budget")}"; gateway_boot_budget_seconds`,
      ],
      { encoding: "utf8" },
    ).trim();
    expect(answer).toMatch(/^\d+$/);
    expect(Number(answer)).toBeGreaterThanOrEqual(60);
  });

  // The fallback is the one place the number is necessarily restated, so it is
  // the one place that can silently drift from the file it stands in for.
  it("keeps the shell fallback equal to the declared budget", () => {
    const helper = readFileSync(join(ROOT, "scripts/lib/boot_budget"), "utf8");
    const fallback = /GATEWAY_BOOT_BUDGET_FALLBACK_SECONDS=(\d+)/.exec(helper)?.[1];
    expect(Number(fallback)).toBe(declared.seconds);
  });
});

describe("every consumer reads the shared budget", () => {
  it("names consumers that exist", () => {
    expect(declared.consumers.length).toBeGreaterThan(0);
    for (const consumer of declared.consumers) {
      expect(existsSync(join(ROOT, consumer)), `${consumer} is listed but absent`).toBe(true);
    }
  });

  it.each([
    ["packages/collector/src/e2e/gateway-env.ts", "gateway-boot-budget.json"],
    [
      "packages/collector/src/e2e/harness-runtime-conformance.ts",
      "const timeoutMs = gatewayBootBudgetMs();",
    ],
    ["packages/collector/src/e2e/synth-harness.ts", "gatewayBootBudgetMs"],
    ["packages/collector/src/e2e/multi-collector-harness.ts", "gatewayBootBudgetMs"],
    ["packages/collector/src/e2e/harness.ts", "gatewayBootBudgetMs"],
    ["packages/collector/src/e2e/tofu.e2e.test.ts", "gatewayBootBudgetMs"],
    ["scripts/dev-instance.sh", "gateway_boot_budget_seconds"],
    ["scripts/ios-push-spike.sh", "gateway_boot_budget_seconds"],
    ["scripts/shot-portal.sh", "gateway_boot_budget_seconds"],
    ["scripts/synth-gateway.sh", "gateway_boot_budget_seconds"],
    ["scripts/dev-scripts-smoke.test.mjs", "gatewayBootBudgetMs"],
  ])("%s resolves it rather than restating it", (consumer, marker) => {
    const source = readFileSync(join(ROOT, consumer), "utf8");
    expect(source).toContain(marker);
    expect(declared.consumers).toContain(consumer);
  });

  // The literals that used to live in these files. Any of them reappearing next
  // to a health-wait is the drift this file exists to catch.
  it.each([
    ["packages/collector/src/e2e/synth-harness.ts", /const timeout = [\d_]+/],
    [
      "packages/collector/src/e2e/harness-runtime-conformance.ts",
      /const timeoutMs = [\d_]+|Date\.now\(\) \+ [\d_]+/,
    ],
    ["packages/collector/src/e2e/multi-collector-harness.ts", /const timeout = [\d_]+/],
    ["packages/collector/src/e2e/harness.ts", /const timeout = [\d_]+/],
    ["packages/collector/src/e2e/tofu.e2e.test.ts", /const timeout = [\d_]+/],
    ["scripts/dev-instance.sh", /READY_TIMEOUT="\$\{OMNESIS_DEV_READY_TIMEOUT:-\d+\}"/],
    ["scripts/shot-portal.sh", /READY_TIMEOUT="\$\{OMNESIS_SHOT_READY_TIMEOUT:-\d+\}"/],
    ["scripts/synth-gateway.sh", /READY_TIMEOUT="\$\{OMNESIS_SYNTH_READY_TIMEOUT:-\d+\}"/],
    ["scripts/dev-scripts-smoke.test.mjs", /Date\.now\(\) \+ \d+/],
  ])("%s carries no boot-budget literal of its own", (consumer, forbidden) => {
    expect(readFileSync(join(ROOT, consumer), "utf8")).not.toMatch(forbidden);
  });

  /**
   * The guard that would have caught the fifth budget. Four consumers were
   * wired and a second E2E harness was not, so the lane still died in a hook
   * on a 15-second wait nobody had noticed — found by a red lane rather than
   * by this file, which is the wrong way round.
   *
   * Every place that waits for a gateway or harness host to become ready has
   * to reach the shared budget. A new one is caught here rather than by whoever
   * next reads a red lane carefully.
   */
  it("finds no gateway-boot wait that reaches its own number", () => {
    const searched = ["packages/collector/src/e2e", "scripts"];
    /**
     * Waiting for a gateway inside a container is a different wait: it includes
     * starting the image, and the budget that makes sense for a `tsx` boot in
     * this repo does not describe it. Exempt on purpose, and named here so the
     * exemption is a decision rather than an omission.
     */
    const containerBoot = [
      "scripts/docker-e2e/lib.sh",
      // The topology lane waits for a gateway that a real `install.sh` run has
      // just cloned, installed and built inside a container. That wait is not
      // the one this budget describes, and holding it to a number sized for a
      // tsx boot in this repo would make the lane fail on the install rather
      // than on anything it is testing.
      "scripts/docker-topology/lib.sh",
      // The dedicated gateway's admin command waits for a production gateway on
      // an operator's host to serve a new release, which can include running
      // its migrations. Holding an update to a budget sized for a tsx boot in
      // this repo would roll a healthy update back on a slow machine.
      "scripts/hardened-gateway.sh",
      // The install lane's "did not start" is its mailbox helper, and the
      // gateway it waits for is one a real `install.sh` built and started under
      // the runner's service manager — not a tsx boot.
      "scripts/install-e2e/tailnet-gateway.sh",
    ];
    const offenders = [];
    for (const dir of searched) {
      const listed = execFileSync("git", ["ls-files", "-z", "--", dir], {
        cwd: ROOT,
        encoding: "utf8",
      })
        .split("\0")
        .filter((file) => /\.(ts|mjs|sh)$/.test(file));
      for (const file of listed) {
        const source = readFileSync(join(ROOT, file), "utf8");
        // A wait for /health, a boot token, or an external plugin service.
        if (!/did not (start|become healthy)/.test(source)) continue;
        if (/gatewayBootBudget|gateway_boot_budget|BOOT_BUDGET/.test(source)) continue;
        if (containerBoot.includes(file)) continue;
        offenders.push(file);
      }
    }
    expect(offenders, "these wait for a gateway on a budget of their own").toEqual([]);
  });
});
