// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { INVENTORY_VERSION, REQUIRED_LANES } from "../ci-admission/inventory.mjs";
import { formatVerdict, fullCiVerdict } from "./ci-verdict.mjs";

const sha = "a".repeat(40);
const request = (overrides = {}) => ({
  key: "daily:2026-09-08",
  targetSha: sha,
  state: "success",
  workflowRunId: 42,
  createdAt: "2026-09-08T04:00:00Z",
  manifest: {
    inventoryVersion: INVENTORY_VERSION,
    results: Object.fromEntries(REQUIRED_LANES.map((lane) => [lane, "success"])),
  },
  ...overrides,
});

test("accepts a current complete full manifest for the exact target", () => {
  expect(fullCiVerdict({ requests: { one: request() } }, sha)).toMatchObject({
    ok: true,
    state: "green",
    runId: 42,
  });
});

test("a descendant verdict cannot bless a release target", () => {
  expect(fullCiVerdict({ requests: { one: request({ targetSha: "b".repeat(40) }) } }, sha)).toEqual(
    { ok: false, state: "missing" },
  );
});

test.each(["failure", "cancelled", "infrastructure_error", "unavailable"])(
  "rejects a %s request",
  (state) => expect(fullCiVerdict({ requests: { one: request({ state }) } }, sha).ok).toBe(false),
);

test("rejects missing lanes and an obsolete inventory", () => {
  const missing = request();
  delete missing.manifest.results[REQUIRED_LANES[0]];
  expect(fullCiVerdict({ requests: { missing } }, sha).ok).toBe(false);
  const obsolete = request({ manifest: { inventoryVersion: "old", results: {} } });
  expect(fullCiVerdict({ requests: { obsolete } }, sha).state).toBe("stale-inventory");
});

test("formats the request identity and run", () => {
  expect(formatVerdict(fullCiVerdict({ requests: { one: request() } }, sha))).toBe(
    "✔ full-validation: green (daily:2026-09-08) — Actions run 42",
  );
});
