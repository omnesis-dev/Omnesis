// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = parse(readFileSync(join(root, ".github/workflows/install-e2e.yml"), "utf8"));

/**
 * Whether a job runs for an event: its `if:` read as the JavaScript it is
 * written as (comparisons of two context values with literals).
 */
function runsFor(job, event, lanes = "all") {
  const expression = job.if
    .replaceAll("github.event_name", "event")
    .replaceAll("inputs.lanes", "lanes");
  expect(expression).toMatch(/^[\w\s=!&|()'.-]+$/u);
  return new Function("event", "lanes", `return ${expression};`)(event, lanes);
}

describe("install-e2e Docker single-host lanes", () => {
  const linux = workflow.jobs["docker-host-linux"];
  const mac = workflow.jobs["docker-host-mac"];

  test("D1 runs wherever the single-host lanes do, pull requests included", () => {
    expect(linux["runs-on"]).toBe("ubuntu-24.04");
    for (const event of ["pull_request", "push", "schedule"])
      expect(runsFor(linux, event)).toBe(true);
    expect(runsFor(linux, "workflow_dispatch", "all")).toBe(true);
    expect(runsFor(linux, "workflow_dispatch", "docker")).toBe(true);
    expect(runsFor(linux, "workflow_dispatch", "tailnet")).toBe(false);
    expect(linux.steps.some((step) => step.run?.includes("docker-host.sh linux"))).toBe(true);
  });

  test("D2 runs on the macos-15-intel runner twice daily and on dispatch, never for a pull request", () => {
    expect(mac["runs-on"]).toBe("macos-15-intel");
    expect(runsFor(mac, "schedule")).toBe(true);
    expect(runsFor(mac, "workflow_dispatch", "all")).toBe(true);
    expect(runsFor(mac, "workflow_dispatch", "docker")).toBe(true);
    for (const event of ["pull_request", "push"]) expect(runsFor(mac, event)).toBe(false);
    expect(
      mac.steps.some((step) => step.uses?.startsWith("douglascamata/setup-docker-macos-action@")),
    ).toBe(true);
    expect(mac.steps.some((step) => step.run?.includes("docker-host.sh mac"))).toBe(true);
  });

  test("both lanes read only, pin every action, and keep their credentials out of the checkout", () => {
    for (const job of [linux, mac]) {
      expect(job.permissions).toEqual({ contents: "read" });
      for (const step of job.steps.filter((step) => step.uses))
        expect(step.uses).toMatch(/@[a-f0-9]{40}$/u);
      const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkout.with["persist-credentials"]).toBe(false);
    }
  });

  test("a change to the image build triggers the lanes, and a dispatch can pick them alone", () => {
    for (const trigger of [workflow.on.pull_request, workflow.on.push]) {
      expect(trigger.paths).toEqual(
        expect.arrayContaining(["Dockerfile", ".dockerignore", "scripts/install-e2e/**"]),
      );
    }
    expect(workflow.on.workflow_dispatch.inputs.lanes.options).toContain("docker");
  });

  test("the lane refuses to run outside CI and names its scenarios", () => {
    const script = join(root, "scripts/install-e2e/docker-host.sh");
    const work = mkdtempSync(join(tmpdir(), "docker-host-test-"));
    const env = { ...process.env, E2E_WORK: work };
    delete env.CI;
    const outside = spawnSync("bash", [script, "linux"], { env, encoding: "utf8" });
    expect(outside.status).not.toBe(0);
    expect(outside.stderr).toContain("runs on CI machines only");
    const unnamed = spawnSync("bash", [script], { env: { ...env, CI: "true" }, encoding: "utf8" });
    expect(unnamed.status).not.toBe(0);
    expect(unnamed.stderr).toContain("usage: docker-host.sh linux|mac");
    rmSync(work, { recursive: true, force: true });
  });
});
