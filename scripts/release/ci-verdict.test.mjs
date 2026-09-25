// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { formatVerdict, fullCiVerdict } from "./ci-verdict.mjs";

const sha = "a".repeat(40);
const run = (overrides = {}) => ({
  id: 42,
  head_sha: sha,
  event: "push",
  status: "completed",
  conclusion: "success",
  created_at: "2026-09-08T04:00:00Z",
  html_url: "https://github.com/example/repo/actions/runs/42",
  ...overrides,
});

test("accepts a green push run for the exact commit", () => {
  expect(fullCiVerdict([run()], sha)).toMatchObject({ ok: true, state: "green", runId: 42 });
});

test("accepts a green manual run for the exact commit", () => {
  expect(fullCiVerdict([run({ event: "workflow_dispatch" })], sha).ok).toBe(true);
});

test("a pull-request run cannot bless a release commit", () => {
  expect(fullCiVerdict([run({ event: "pull_request" })], sha)).toEqual({
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
