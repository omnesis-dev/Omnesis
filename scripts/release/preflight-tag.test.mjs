// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { preflightTag } from "./preflight-tag.mjs";

const run = (overrides = {}) => ({
  id: 42,
  head_sha: "abc123",
  event: "push",
  status: "completed",
  conclusion: "success",
  created_at: "2026-09-08T04:00:00Z",
  html_url: "https://github.com/example/repo/actions/runs/42",
  ...overrides,
});

const installRun = (overrides = {}) => ({
  id: 7,
  head_sha: "def456",
  head_branch: "main",
  event: "schedule",
  status: "completed",
  conclusion: "success",
  display_title: "Install e2e (schedule)",
  created_at: "2026-09-08T03:00:00Z",
  html_url: "https://github.com/example/repo/actions/runs/7",
  ...overrides,
});

const listing = (runs) => ({
  code: 0,
  stdout: JSON.stringify({ workflow_runs: runs }),
  stderr: "",
});

/**
 * A fake `gh api` serving the full-validation runs of the release commit and
 * the install/update lane runs on main, by the event each query asks for.
 */
const ghWith =
  (fullValidation, install = [installRun()]) =>
  (_root, args) => {
    const path = args[1];
    if (path.includes("full-validation.yml")) return listing(fullValidation);
    const event = /event=([a-z_]+)/u.exec(path)?.[1];
    return listing(install.filter((r) => r.event === event));
  };

function fakeGit(overrides = {}) {
  return (_root, args) => {
    const command = args.join(" ");
    if (overrides[command]) return overrides[command];
    if (command === "rev-parse HEAD" || command === "rev-parse origin/main") {
      return { code: 0, stdout: "abc123\n", stderr: "" };
    }
    if (command.startsWith("show-ref ")) return { code: 1, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
}

const preflight = (gh, options = {}) =>
  preflightTag("/repo", "v0.3.0", { git: fakeGit(), checkVersion: vi.fn(), gh, ...options });

test("passes only the exact clean origin/main commit with an unused tag", () => {
  const check = vi.fn();
  const gh = vi.fn(ghWith([run()]));
  const { sha, notes } = preflightTag("/repo", "v0.3.0", {
    git: fakeGit(),
    checkVersion: check,
    gh,
  });
  expect(sha).toBe("abc123");
  expect(check).toHaveBeenCalledWith("/repo", "v0.3.0");
  expect(gh.mock.calls[0][1].join(" ")).toContain(
    "actions/workflows/full-validation.yml/runs?head_sha=abc123",
  );
  expect(notes).toEqual([
    "✔ full-validation: green — https://github.com/example/repo/actions/runs/42",
    expect.stringMatching(/^✔ Install\/update lanes: green \(full run, .*runs\/7$/u),
  ]);
});

test("refuses a checkout that is not exact origin/main", () => {
  const git = fakeGit({ "rev-parse HEAD": { code: 0, stdout: "different\n", stderr: "" } });
  expect(() => preflight(ghWith([run()]), { git })).toThrow(/exact fetched origin\/main/u);
});

test("refuses a commit with no full-validation run, naming how to start one", () => {
  expect(() => preflight(ghWith([]))).toThrow(
    /No full-validation run for abc123.*gh workflow run full-validation\.yml --ref main/u,
  );
});

test("a pull-request run does not count for the release commit", () => {
  expect(() => preflight(ghWith([run({ event: "pull_request" })]))).toThrow(
    /No full-validation run/u,
  );
});

test("refuses a commit whose validation failed, naming the run", () => {
  expect(() => preflight(ghWith([run({ conclusion: "failure" })]))).toThrow(
    /ended as failure.*actions\/runs\/42/u,
  );
});

test("waits for a run still in progress", () => {
  const running = run({ status: "in_progress", conclusion: null });
  expect(() => preflight(ghWith([running]))).toThrow(/still running/u);
});

test("names an unreadable full-validation listing", () => {
  const gh = () => ({ code: 1, stdout: "", stderr: "HTTP 401" });
  expect(() => preflight(gh)).toThrow(/Could not read the full-validation runs: HTTP 401/u);
});

test("refuses existing local or remote tags", () => {
  const local = fakeGit({
    "show-ref --verify --quiet refs/tags/v0.3.0": { code: 0, stdout: "", stderr: "" },
  });
  expect(() => preflight(ghWith([run()]), { git: local })).toThrow(/Local tag/u);
  const remote = fakeGit({
    "ls-remote --tags --refs origin refs/tags/v0.3.0": {
      code: 0,
      stdout: "abc\trefs/tags/v0.3.0\n",
      stderr: "",
    },
  });
  expect(() => preflight(ghWith([run()]), { git: remote })).toThrow(/Remote tag/u);
});

test("refuses a validated commit while the newest full install/update run is red", () => {
  const red = installRun({ conclusion: "failure" });
  expect(() => preflight(ghWith([run()], [red]))).toThrow(
    /Install\/update lanes: failure[\s\S]*--allow-failed-install-e2e/u,
  );
});

test("refuses a validated commit while a push run newer than the full run is red", () => {
  const push = installRun({
    event: "push",
    conclusion: "failure",
    created_at: "2026-09-08T05:00:00Z",
  });
  expect(() => preflight(ghWith([run()], [installRun(), push]))).toThrow(
    /Install\/update lanes: failure \(push to main/u,
  );
});

test("passes over a cancelled install/update run to the one before it", () => {
  const cancelled = installRun({ conclusion: "cancelled", created_at: "2026-09-08T05:00:00Z" });
  const { notes } = preflight(ghWith([run()], [installRun(), cancelled]));
  expect(notes[1]).toMatch(/^✔ Install\/update lanes: green/u);
});

test("warns and proceeds with no full install/update run yet", () => {
  const { sha, notes } = preflight(ghWith([run()], []));
  expect(sha).toBe("abc123");
  expect(notes[1]).toMatch(/No completed full install\/update run on main yet/u);
});

test("refuses when the install/update runs cannot be read, naming the override", () => {
  const gh = (root, args) =>
    args[1].includes("install-e2e.yml")
      ? { code: 1, stdout: "", stderr: "HTTP 502" }
      : ghWith([run()])(root, args);
  expect(() => preflight(gh)).toThrow(
    /Could not read the install\/update lane runs: HTTP 502[\s\S]*--allow-failed-install-e2e/u,
  );
});

test("the override releases past red install/update lanes and says so", () => {
  const red = installRun({ conclusion: "failure" });
  const { sha, notes } = preflight(ghWith([run()], [red]), { allowFailedInstallE2e: true });
  expect(sha).toBe("abc123");
  expect(notes.join("\n")).toMatch(
    /! Install\/update lanes: failure[\s\S]*Releasing anyway: --allow-failed-install-e2e/u,
  );
});

test("the override never excuses a missing or red full validation", () => {
  expect(() =>
    preflight(ghWith([run({ conclusion: "failure" })]), { allowFailedInstallE2e: true }),
  ).toThrow(/ended as failure/u);
  expect(() => preflight(ghWith([]), { allowFailedInstallE2e: true })).toThrow(
    /No full-validation run/u,
  );
});
