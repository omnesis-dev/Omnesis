// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { formatVerdict, fullCiVerdict } from "./ci-verdict.mjs";

const sha = "a".repeat(40);
const run = (overrides = {}) => ({
  id: 42,
  head_sha: sha,
  event: "schedule",
  status: "completed",
  conclusion: "success",
  created_at: "2026-09-08T04:00:00Z",
  html_url: "https://github.com/example/repo/actions/runs/42",
  ...overrides,
});

test("accepts a green scheduled run for the exact commit", () => {
  expect(fullCiVerdict([run()], sha)).toMatchObject({ ok: true, state: "green", runId: 42 });
});

test("accepts a green manual run for the exact commit", () => {
  expect(
    fullCiVerdict(
      [
        run({
          event: "workflow_dispatch",
          display_title: "full-validation (workflow_dispatch, lanes: all)",
        }),
      ],
      sha,
    ).ok,
  ).toBe(true);
});

test.each(["push", "pull_request"])("a %s run cannot bless a release commit", (event) => {
  expect(fullCiVerdict([run({ event })], sha)).toEqual({
    ok: false,
    state: "missing",
  });
});

test("another commit's run cannot bless a release commit", () => {
  expect(fullCiVerdict([run({ head_sha: "b".repeat(40) })], sha)).toEqual({
    ok: false,
    state: "missing",
  });
});

test.each(["failure", "cancelled", "timed_out"])("rejects a %s run", (conclusion) => {
  expect(fullCiVerdict([run({ conclusion })], sha)).toMatchObject({
    ok: false,
    state: conclusion,
  });
});

test("reports a run still in progress", () => {
  expect(fullCiVerdict([run({ status: "in_progress", conclusion: null })], sha)).toMatchObject({
    ok: false,
    state: "running",
  });
});

test("a green run counts even when a later rerun was cancelled", () => {
  const later = run({ id: 43, conclusion: "cancelled", created_at: "2026-09-09T04:00:00Z" });
  expect(fullCiVerdict([later, run()], sha)).toMatchObject({ ok: true, runId: 42 });
});

test("formats the run link", () => {
  expect(formatVerdict(fullCiVerdict([run()], sha))).toBe(
    "✔ full-validation: green — https://github.com/example/repo/actions/runs/42",
  );
});

// Linux-only push success cannot substitute for the release's macOS checks.
test("a green push does not mask a failed full run", () => {
  const failed = run({ conclusion: "failure" });
  const push = run({ id: 43, event: "push", created_at: "2026-09-09T04:00:00Z" });
  expect(fullCiVerdict([push, failed], sha)).toMatchObject({
    ok: false,
    state: "failure",
    runId: 42,
  });
});

test.each([undefined, "full-validation", "full-validation (workflow_dispatch, lanes: linux)"])(
  "a manual run without all-lanes evidence cannot bless a release commit: %s",
  (display_title) => {
    expect(fullCiVerdict([run({ event: "workflow_dispatch", display_title })], sha)).toEqual({
      ok: false,
      state: "missing",
    });
  },
);
