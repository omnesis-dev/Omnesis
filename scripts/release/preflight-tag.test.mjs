// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { INVENTORY_VERSION, REQUIRED_LANES } from "../ci-admission/inventory.mjs";
import { preflightTag } from "./preflight-tag.mjs";

const LEDGER_SHOW = "show origin/ci-admission-state:ledger.json";

const ledgerRequest = (overrides = {}) => ({
  key: "daily:2026-09-08",
  targetSha: "abc123",
  state: "success",
  workflowRunId: 42,
  createdAt: "2026-09-08T04:00:00Z",
  manifest: {
    inventoryVersion: INVENTORY_VERSION,
    results: Object.fromEntries(REQUIRED_LANES.map((lane) => [lane, "success"])),
  },
  ...overrides,
});

const ledgerWith = (...requests) => ({
  code: 0,
  stdout: JSON.stringify({
    requests: Object.fromEntries(requests.map((request, index) => [`request-${index}`, request])),
  }),
  stderr: "",
});

function fakeGit(overrides = {}) {
  return (_root, args) => {
    const command = args.join(" ");
    if (overrides[command]) return overrides[command];
    if (command === "rev-parse HEAD" || command === "rev-parse origin/main") {
      return { code: 0, stdout: "abc123\n", stderr: "" };
    }
    if (command.startsWith("show-ref ")) return { code: 1, stdout: "", stderr: "" };
    if (command === LEDGER_SHOW) return ledgerWith(ledgerRequest());
    return { code: 0, stdout: "", stderr: "" };
  };
}

test("passes only the exact clean origin/main commit with an unused tag", () => {
  const check = vi.fn();
  expect(preflightTag("/repo", "v0.3.0", fakeGit(), check)).toBe("abc123");
  expect(check).toHaveBeenCalledWith("/repo", "v0.3.0");
});

test("refuses a checkout that is not exact origin/main", () => {
  const git = fakeGit({ "rev-parse HEAD": { code: 0, stdout: "different\n", stderr: "" } });
  expect(() => preflightTag("/repo", "v0.3.0", git, vi.fn())).toThrow(
    /exact fetched origin\/main/u,
  );
});

test("refuses a commit with no full-validation verdict yet", () => {
  const git = fakeGit({ [LEDGER_SHOW]: ledgerWith() });
  expect(() => preflightTag("/repo", "v0.3.0", git, vi.fn())).toThrow(
    /No full-validation verdict for abc123 yet/u,
  );
});

test("refuses a commit whose validation failed, naming the run", () => {
  const git = fakeGit({ [LEDGER_SHOW]: ledgerWith(ledgerRequest({ state: "failure" })) });
  expect(() => preflightTag("/repo", "v0.3.0", git, vi.fn())).toThrow(
    /ended as failure.*Actions run 42/u,
  );
});

test("refuses a commit validated under an older lane inventory", () => {
  const git = fakeGit({
    [LEDGER_SHOW]: ledgerWith(
      ledgerRequest({ manifest: { inventoryVersion: "old", results: {} } }),
    ),
  });
  expect(() => preflightTag("/repo", "v0.3.0", git, vi.fn())).toThrow(/older lane inventory/u);
});

test("refuses existing local or remote tags", () => {
  const local = fakeGit({
    "show-ref --verify --quiet refs/tags/v0.3.0": { code: 0, stdout: "", stderr: "" },
  });
  expect(() => preflightTag("/repo", "v0.3.0", local, vi.fn())).toThrow(/Local tag/u);
  const remote = fakeGit({
    "ls-remote --tags --refs origin refs/tags/v0.3.0": {
      code: 0,
      stdout: "abc\trefs/tags/v0.3.0\n",
      stderr: "",
    },
  });
  expect(() => preflightTag("/repo", "v0.3.0", remote, vi.fn())).toThrow(/Remote tag/u);
});
