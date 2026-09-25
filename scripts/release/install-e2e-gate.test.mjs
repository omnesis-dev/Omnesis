// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { OVERRIDE_FLAG, checkInstallE2eGate, installE2eVerdict } from "./install-e2e-gate.mjs";

let clock = Date.parse("2026-01-01T00:00:00Z");
function run(overrides = {}) {
  clock += 60_000;
  return {
    event: "schedule",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    display_title: "Install e2e (schedule)",
    created_at: new Date(clock).toISOString(),
    html_url: `https://github.example.invalid/runs/${clock}`,
    head_sha: "a".repeat(40),
    ...overrides,
  };
}
const dispatch = (lanes, overrides = {}) =>
  run({
    event: "workflow_dispatch",
    display_title: `Install e2e (workflow_dispatch, lanes: ${lanes})`,
    ...overrides,
  });

/** A fake `gh api` answering each event's query from one list of runs. */
function github(runs) {
  const asked = [];
  const gh = (_root, args) => {
    asked.push(args[1]);
    const event = /event=([a-z_]+)/.exec(args[1])?.[1];
    const own = runs.filter((r) => r.event === event);
    return { code: 0, stdout: JSON.stringify({ workflow_runs: own }), stderr: "" };
  };
  return { gh, asked };
}

describe("installE2eVerdict", () => {
  it("takes the newest completed full run, in any order", () => {
    const older = run({ conclusion: "failure" });
    const newer = run();
    expect(installE2eVerdict([newer, older])).toMatchObject({
      ok: true,
      state: "success",
      url: newer.html_url,
    });
    expect(installE2eVerdict([older, run({ conclusion: "timed_out" })])).toMatchObject({
      ok: false,
      state: "timed_out",
    });
  });

  it("passes over cancelled and unfinished runs, other branches and partial dispatches", () => {
    const red = run({ conclusion: "failure" });
    const verdict = installE2eVerdict([
      red,
      run({ conclusion: "cancelled" }),
      run({ head_branch: "feature" }),
      run({ status: "in_progress", conclusion: null }),
      dispatch("single-host"),
      run({ event: "workflow_dispatch", display_title: undefined }),
    ]);
    expect(verdict).toMatchObject({
      ok: false,
      state: "failure",
      url: red.html_url,
      kind: "full run",
    });
  });

  it("looks past a cancelled newest run to the one before it", () => {
    const green = run();
    expect(installE2eVerdict([green, run({ conclusion: "cancelled" })])).toMatchObject({
      ok: true,
      url: green.html_url,
    });
  });

  it("counts a dispatch of every lane as a full run", () => {
    const red = run({ conclusion: "failure" });
    const fixed = dispatch("all");
    expect(installE2eVerdict([red, fixed])).toMatchObject({ ok: true, url: fixed.html_url });
  });

  it("blocks on a red push run newer than a green full run, and not on an older one", () => {
    const oldPush = run({ event: "push", conclusion: "failure" });
    const full = run();
    expect(installE2eVerdict([oldPush, full])).toMatchObject({ ok: true, url: full.html_url });
    const newPush = run({ event: "push", conclusion: "failure" });
    expect(installE2eVerdict([oldPush, full, newPush])).toMatchObject({
      ok: false,
      kind: "push to main",
      url: newPush.html_url,
    });
    const greenPush = run({ event: "push" });
    expect(installE2eVerdict([oldPush, full, newPush, greenPush])).toMatchObject({
      ok: true,
      url: full.html_url,
    });
  });

  it("reports no evidence when there is no full run, unless a push run is red", () => {
    expect(installE2eVerdict([])).toEqual({ ok: true, state: "missing" });
    expect(installE2eVerdict([run({ event: "push" })])).toEqual({ ok: true, state: "missing" });
    expect(installE2eVerdict([run({ event: "push", conclusion: "failure" })])).toMatchObject({
      ok: false,
    });
  });
});

describe("checkInstallE2eGate", () => {
  it("lets a green run through and names it", () => {
    const lines = checkInstallE2eGate("/repo", github([run()]));
    expect(lines[0]).toMatch(/^✔ Install\/update lanes: green \(full run, /);
  });

  it("refuses a failed run with the way forward, and the override lets it through", () => {
    const { gh } = github([run({ conclusion: "failure" })]);
    expect(() => checkInstallE2eGate("/repo", { gh })).toThrow(
      new RegExp(`failure[\\s\\S]*lanes=all[\\s\\S]*${OVERRIDE_FLAG}`),
    );
    expect(checkInstallE2eGate("/repo", { gh, allowFailed: true }).join("\n")).toMatch(
      /Releasing anyway/,
    );
  });

  it("warns and proceeds with no run yet", () => {
    expect(checkInstallE2eGate("/repo", github([]))[0]).toMatch(/nothing to gate on/);
  });

  it("asks for each event separately, so push runs cannot crowd a full run off the page", () => {
    const { gh, asked } = github([]);
    checkInstallE2eGate("/repo", { gh });
    expect(asked).toHaveLength(3);
    for (const event of ["schedule", "workflow_dispatch", "push"]) {
      expect(
        asked.some((q) =>
          q.includes(`install-e2e.yml/runs?branch=main&event=${event}&status=completed`),
        ),
      ).toBe(true);
    }
  });

  it("refuses, naming the override, when the runs cannot be read", () => {
    const failing = () => ({ code: 1, stdout: "", stderr: "HTTP 502" });
    expect(() => checkInstallE2eGate("/repo", { gh: failing })).toThrow(
      /HTTP 502[\s\S]*--allow-failed-install-e2e/,
    );
    const garbled = () => ({ code: 0, stdout: "not json", stderr: "" });
    expect(() => checkInstallE2eGate("/repo", { gh: garbled })).toThrow(
      /not JSON[\s\S]*--allow-failed-install-e2e/,
    );
    const shapeless = () => ({ code: 0, stdout: "{}", stderr: "" });
    expect(() => checkInstallE2eGate("/repo", { gh: shapeless })).toThrow(
      /no run list[\s\S]*--allow-failed-install-e2e/,
    );
  });
});
