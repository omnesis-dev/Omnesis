// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";

const workflow = (name) =>
  parse(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8"));

describe("installer coverage CI admission and verdict", () => {
  test("the actual aggregate verdict rejects a selected installer failure or skip", () => {
    const full = workflow("full-validation.yml");
    expect(full.jobs.verdict.needs).toContain("installer-coverage");
    const command = full.jobs.verdict.steps[0].run;
    const source = command.match(/^\s*node -e '([\s\S]*)'\s*$/)?.[1];
    expect(source).toBeTruthy();
    const directory = mkdtempSync(join(tmpdir(), "installer-verdict-"));
    try {
      const run = (event, selected, outcome) =>
        spawnSync(process.execPath, ["-e", source], {
          encoding: "utf8",
          env: {
            ...process.env,
            EVENT: event,
            GITHUB_STEP_SUMMARY: join(directory, "summary"),
            RESULTS_JSON: JSON.stringify({
              scope: {
                result: "success",
                outputs: { installer_coverage: selected ? "true" : "false" },
              },
              "installer-coverage": { result: outcome },
            }),
          },
        });
      expect(run("pull_request", true, "success").status).toBe(0);
      expect(run("pull_request", true, "failure").status).toBe(1);
      expect(run("pull_request", true, "skipped").status).toBe(1);
      expect(run("pull_request", false, "skipped").status).toBe(0);
      expect(run("push", false, "skipped").status).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("real journey jobs use only hosted machines, pinned source and read-only permissions", () => {
    const reusable = workflow("installer-coverage.yml");
    expect(reusable.permissions).toEqual({ contents: "read" });
    expect(reusable.on.workflow_call.inputs.extended.default).toBe(false);
    expect(reusable.jobs.plan["runs-on"]).toBe("ubuntu-latest");
    expect(reusable.jobs.macos["runs-on"]).toBe("${{ matrix.os }}");
    expect(reusable.jobs["update-interruption"]["runs-on"]).toBe("ubuntu-24.04");
    expect(reusable.jobs.macos.strategy["max-parallel"]).toBe(2);
    expect(reusable.jobs["update-interruption"].if).toBe("${{ inputs.extended }}");
    for (const job of Object.values(reusable.jobs)) {
      const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkout.with.ref).toBe("${{ inputs.target_sha }}");
      expect(checkout.with["persist-credentials"]).toBe(false);
      for (const step of job.steps.filter((step) => step.uses)) {
        expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
        if (step.uses.startsWith("actions/upload-artifact@")) {
          expect(step.with.path).toBe("${{ runner.temp }}/installer-coverage/result.json");
          expect(step.with.name).toContain("${{ github.run_attempt }}");
        }
      }
    }
  });

  test("scheduled coverage selects the extended journeys without borrowing tailnet credentials", () => {
    const nightly = workflow("install-e2e.yml");
    expect(nightly.on.schedule.length).toBeGreaterThan(0);
    expect(nightly.jobs["installer-coverage"].with.extended).toBe(true);
    expect(nightly.jobs["installer-coverage"].secrets).toBeUndefined();
    const cancellation = nightly.concurrency["cancel-in-progress"].slice(3, -2);
    expect(runInNewContext(cancellation, { github: { event_name: "schedule" } })).toBe(false);
  });

  test("branch coverage dispatch cannot enter the authenticated tailnet jobs", () => {
    const install = workflow("install-e2e.yml");
    const selected = (id, event, lanes) => {
      const condition = install.jobs[id].if;
      return runInNewContext(
        condition,
        { github: { event_name: event }, inputs: { lanes } },
        { timeout: 1000 },
      );
    };
    expect(selected("installer-coverage", "workflow_dispatch", "coverage")).toBe(true);
    expect(selected("installer-coverage", "workflow_dispatch", "all")).toBe(true);
    expect(selected("installer-coverage", "schedule", undefined)).toBe(true);
    expect(selected("installer-coverage", "pull_request", "all")).toBe(false);
    for (const id of ["single-host", "lockfile-upgrade", "tailnet-plan"]) {
      expect(selected(id, "workflow_dispatch", "coverage")).toBe(false);
    }
    expect(selected("tailnet-plan", "pull_request", "coverage")).toBe(false);
    expect(selected("tailnet-plan", "schedule", undefined)).toBe(true);
    expect(selected("tailnet-plan", "workflow_dispatch", "all")).toBe(true);
    expect(selected("tailnet-plan", "workflow_dispatch", "tailnet")).toBe(true);
    const job = install.jobs["installer-coverage"];
    expect(job.with.extended).toBe(true);
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.environment).toBeUndefined();
    expect(job.secrets).toBeUndefined();
  });
});
