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

const ghWith =
  (...runs) =>
  () => ({ code: 0, stdout: JSON.stringify({ workflow_runs: runs }), stderr: "" });

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

test("passes only the exact clean origin/main commit with an unused tag", () => {
  const check = vi.fn();
  const gh = vi.fn(ghWith(run()));
  expect(preflightTag("/repo", "v0.3.0", fakeGit(), check, gh)).toBe("abc123");
  expect(check).toHaveBeenCalledWith("/repo", "v0.3.0");
  expect(gh.mock.calls[0][1].join(" ")).toContain(
    "actions/workflows/full-validation.yml/runs?head_sha=abc123",
  );
});

test("refuses a checkout that is not exact origin/main", () => {
  const git = fakeGit({ "rev-parse HEAD": { code: 0, stdout: "different\n", stderr: "" } });
  expect(() => preflightTag("/repo", "v0.3.0", git, vi.fn(), ghWith(run()))).toThrow(
    /exact fetched origin\/main/u,
  );
});

test("refuses a commit with no full-validation run, naming how to start one", () => {
  expect(() => preflightTag("/repo", "v0.3.0", fakeGit(), vi.fn(), ghWith())).toThrow(
    /No full-validation run for abc123.*gh workflow run full-validation\.yml --ref main/u,
  );
});

test("a pull-request run does not count for the release commit", () => {
  expect(() =>
    preflightTag("/repo", "v0.3.0", fakeGit(), vi.fn(), ghWith(run({ event: "pull_request" }))),
  ).toThrow(/No full-validation run/u);
});

test("refuses a commit whose validation failed, naming the run", () => {
  expect(() =>
    preflightTag("/repo", "v0.3.0", fakeGit(), vi.fn(), ghWith(run({ conclusion: "failure" }))),
  ).toThrow(/ended as failure.*actions\/runs\/42/u);
});

test("waits for a run still in progress", () => {
  const running = run({ status: "in_progress", conclusion: null });
  expect(() => preflightTag("/repo", "v0.3.0", fakeGit(), vi.fn(), ghWith(running))).toThrow(
    /still running/u,
  );
});

test("names an unreadable run listing", () => {
  const gh = () => ({ code: 1, stdout: "", stderr: "HTTP 401" });
  expect(() => preflightTag("/repo", "v0.3.0", fakeGit(), vi.fn(), gh)).toThrow(/HTTP 401/u);
});

test("refuses existing local or remote tags", () => {
  const local = fakeGit({
    "show-ref --verify --quiet refs/tags/v0.3.0": { code: 0, stdout: "", stderr: "" },
  });
  expect(() => preflightTag("/repo", "v0.3.0", local, vi.fn(), ghWith(run()))).toThrow(
    /Local tag/u,
  );
  const remote = fakeGit({
    "ls-remote --tags --refs origin refs/tags/v0.3.0": {
      code: 0,
      stdout: "abc\trefs/tags/v0.3.0\n",
      stderr: "",
    },
  });
  expect(() => preflightTag("/repo", "v0.3.0", remote, vi.fn(), ghWith(run()))).toThrow(
    /Remote tag/u,
  );
});
