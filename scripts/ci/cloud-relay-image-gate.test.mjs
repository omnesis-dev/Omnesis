// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  REPOSITORY,
  REQUIRED_JOBS,
  REQUIRED_STEPS,
  checkValidationRun,
  validateValidationRun,
} from "./cloud-relay-image-gate.mjs";

const source = "a".repeat(40);
const makeRun = (overrides = {}) => ({
  id: 123,
  run_attempt: 1,
  head_sha: source,
  head_repository: { full_name: REPOSITORY },
  repository: { full_name: REPOSITORY },
  head_branch: "main",
  path: ".github/workflows/full-validation.yml",
  event: "workflow_dispatch",
  display_title: "full-validation (workflow_dispatch, lanes: all)",
  status: "completed",
  conclusion: "success",
  ...overrides,
});
const makeJobs = () =>
  REQUIRED_JOBS.map((name) => ({
    run_id: 123,
    run_attempt: 1,
    name,
    status: "completed",
    conclusion: "success",
    steps: (REQUIRED_STEPS[name] ?? []).map((step) => ({
      name: step,
      status: "completed",
      conclusion: "success",
    })),
  }));

describe("F9: the cloud relay image is built only for a fully validated commit of main", () => {
  test("a complete green all-lanes dispatch on main passes, with optional jobs skipped", () => {
    const jobs = [
      ...makeJobs(),
      { run_id: 123, run_attempt: 1, name: "optional", status: "completed", conclusion: "skipped" },
    ];
    expect(validateValidationRun(makeRun(), jobs, makeRun())).toEqual({
      sourceSha: source,
      validationRun: 123,
      runAttempt: 1,
      verifiedJobs: jobs.length,
    });
  });

  test.each([
    ["head_sha", "b".repeat(39)],
    ["head_sha", "A".repeat(40)],
    ["head_sha", undefined],
    ["head_repository", { full_name: "someone/fork" }],
    ["repository", { full_name: "someone/fork" }],
    ["head_branch", "feature"],
    ["path", ".github/workflows/partial.yml"],
    ["event", "pull_request"],
    ["event", "pull_request_target"],
    ["event", "push"],
    ["event", "schedule"],
    ["display_title", "full-validation (workflow_dispatch, lanes: linux)"],
    ["status", "in_progress"],
    ["conclusion", "failure"],
    ["id", 0],
    ["id", true],
    ["id", "123"],
    ["run_attempt", 0],
    ["run_attempt", null],
  ])("a run with %s = %j is refused", (key, value) => {
    expect(() => validateValidationRun(makeRun({ [key]: value }), makeJobs(), makeRun())).toThrow();
  });

  test("malformed runs and job lists are refused", () => {
    for (const run of [
      null,
      [],
      makeRun({ repository: null }),
      makeRun({ head_repository: "x" }),
    ]) {
      expect(() => validateValidationRun(run, makeJobs(), makeRun())).toThrow();
    }
    expect(() => validateValidationRun(makeRun(), null, makeRun())).toThrow();
  });

  test("a missing, failed, cancelled or duplicated job is refused", () => {
    expect(() => validateValidationRun(makeRun(), makeJobs().slice(1), makeRun())).toThrow();
    for (const [key, value] of [
      ["name", null],
      ["run_id", 124],
      ["run_attempt", 2],
      ["status", "queued"],
      ["conclusion", "failure"],
      ["conclusion", "cancelled"],
      ["conclusion", "skipped"],
    ]) {
      const jobs = makeJobs();
      jobs[0][key] = value;
      expect(() => validateValidationRun(makeRun(), jobs, makeRun())).toThrow();
    }
    const jobs = makeJobs();
    expect(() => validateValidationRun(makeRun(), [...jobs, jobs[0]], makeRun())).toThrow();
    expect(() => validateValidationRun(makeRun(), [...jobs, null], makeRun())).toThrow();
  });

  test("a lane step that is missing, skipped, unfinished or doubled is refused", () => {
    const index = makeJobs().findIndex((job) => job.name === "node / unit");
    for (const steps of [
      undefined,
      [],
      [null],
      [{ name: "lane [affected-unit]", status: "completed", conclusion: "success" }],
    ]) {
      const jobs = makeJobs();
      jobs[index].steps = steps;
      expect(() => validateValidationRun(makeRun(), jobs, makeRun())).toThrow();
    }
    for (const [key, value] of [
      ["status", "in_progress"],
      ["conclusion", "skipped"],
    ]) {
      const jobs = makeJobs();
      jobs[index].steps[0][key] = value;
      expect(() => validateValidationRun(makeRun(), jobs, makeRun())).toThrow();
    }
    const jobs = makeJobs();
    jobs[index].steps.push({ ...jobs[index].steps[0] });
    expect(() => validateValidationRun(makeRun(), jobs, makeRun())).toThrow();
  });

  test("a run rerun or changed while its jobs were read is refused", () => {
    for (const fresh of [
      null,
      makeRun({ id: 124 }),
      makeRun({ run_attempt: 2 }),
      makeRun({ status: "in_progress" }),
      makeRun({ head_sha: "b".repeat(40) }),
    ]) {
      expect(() => validateValidationRun(makeRun(), makeJobs(), fresh)).toThrow();
    }
  });

  test("checkValidationRun reads the run, every job page, then the run again", async () => {
    const jobs = makeJobs();
    const filler = Array.from({ length: 100 - (jobs.length % 100) }, (_, index) => ({
      run_id: 123,
      run_attempt: 1,
      name: `extra ${index}`,
      status: "completed",
      conclusion: "skipped",
    }));
    const all = [...jobs, ...filler];
    const calls = [];
    const fetchJson = async (path) => {
      calls.push(path);
      if (path.includes("/compare/")) return { status: "ahead" };
      const page = /&page=(\d+)/u.exec(path);
      if (!page) return makeRun();
      const number = Number(page[1]);
      return { jobs: all.slice((number - 1) * 100, number * 100) };
    };
    const result = await checkValidationRun("123", fetchJson);
    expect(result.sourceSha).toBe(source);
    expect(calls[0]).toBe(`repos/${REPOSITORY}/actions/runs/123`);
    expect(calls.at(-2)).toBe(`repos/${REPOSITORY}/actions/runs/123`);
    expect(calls.at(-1)).toBe(`repos/${REPOSITORY}/compare/${source}...main`);
    expect(calls.filter((path) => path.includes("/jobs")).length).toBe(all.length / 100 + 1);
  });

  test.each(["diverged", "behind", undefined])(
    "a commit that is not on main (compare status %j) is refused",
    async (status) => {
      const fetchJson = async (path) => {
        if (path.includes("/compare/")) return { status };
        if (path.includes("/jobs")) return { jobs: makeJobs() };
        return makeRun();
      };
      await expect(checkValidationRun("123", fetchJson)).rejects.toThrow(/not on main/u);
    },
  );

  test.each(["", "0", "12a", "-4", "1 2", "123; rm -rf /"])(
    "a run id %j is refused before any request",
    async (id) => {
      let called = false;
      await expect(
        checkValidationRun(id, async () => {
          called = true;
          return {};
        }),
      ).rejects.toThrow();
      expect(called).toBe(false);
    },
  );
});

describe("F9: the image workflow", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/cloud-relay-image.yml", import.meta.url),
    "utf8",
  );
  const job = (name) => {
    const start = workflow.indexOf(`\n  ${name}:\n`);
    expect(start).toBeGreaterThan(0);
    const rest = workflow.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][a-z-]*:\n/u);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };

  test("runs only after full validation or by hand, never for pull requests", () => {
    const triggers = workflow.slice(
      workflow.indexOf("\non:\n"),
      workflow.indexOf("\npermissions:"),
    );
    expect(triggers).toMatch(
      /workflow_run:\n\s+workflows: \[full-validation\]\n\s+types: \[completed\]/u,
    );
    expect(triggers).toContain("workflow_dispatch:");
    expect(triggers).not.toMatch(/pull_request|push:|schedule:/u);
    expect(workflow).toMatch(/\npermissions: \{\}\n/u);
  });

  test("only the main branch of this repository builds or signs", () => {
    expect(job("gate")).toContain("github.repository == 'omnesis-dev/Omnesis'");
    expect(job("gate")).toContain("github.ref == 'refs/heads/main'");
    expect(job("build")).toMatch(/needs: gate\n/u);
    expect(job("sign")).toMatch(/needs: \[gate, build\]/u);
  });

  test("only the signing job can request an identity token", () => {
    expect(job("gate")).not.toContain("id-token");
    expect(job("build")).not.toContain("id-token");
    expect(job("sign")).toContain("id-token: write");
    expect(job("gate")).not.toContain("packages: write");
  });

  test("the signing job runs no repository code and signs the built digest", () => {
    const sign = job("sign");
    expect(sign).not.toContain("actions/checkout");
    expect(sign).not.toMatch(/npm |node scripts/u);
    expect(sign).toContain("needs.build.outputs.digest");
    expect(sign).toContain("dev.omnesis.source-sha=");
    expect(sign).toContain("--certificate-identity");
  });

  test("every action is pinned to a commit and cosign to a checksum", () => {
    for (const [, ref] of workflow.matchAll(/uses: [^@\s]+@(\S+)/gu)) {
      expect(ref).toMatch(/^[0-9a-f]{40}$/u);
    }
    expect(workflow).toMatch(/COSIGN_SHA256: [0-9a-f]{64}/u);
  });
});
