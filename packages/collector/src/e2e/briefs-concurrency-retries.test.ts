// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { verifiedConcurrentCreateRetries } from "./briefs-concurrency-retries.js";
import type { ExecutedTool } from "./brain-bench/obs.js";

function recovered(): ExecutedTool[] {
  return [
    {
      tool: "open_loop_search",
      args: { query: "observatory" },
      result: { kind: "structured", data: { loops: [] } },
    },
    {
      tool: "open_loop_create",
      args: { title: "Confirm observatory access" },
      result: {
        kind: "error",
        code: "revision_conflict",
        message:
          "The reconciled collection changed or its read receipt is missing: loop. Repeat open_loop_search.",
      },
    },
    {
      tool: "open_loop_search",
      args: { query: "observatory" },
      result: {
        kind: "structured",
        data: {
          loops: [{ id: "winner", title: "Confirm observatory access" }],
        },
      },
    },
    {
      tool: "open_loop_ledger_append",
      args: { id: "winner" },
      result: { kind: "structured", data: {} },
    },
  ];
}

test("separately accounts for a proven concurrent-create retry that adopts its winner", () => {
  expect([...verifiedConcurrentCreateRetries(recovered(), new Set(["winner"]))]).toEqual([0]);
});

test.each([
  "missing initial read",
  "failed initial read",
  "already existing owner",
  "missing reread",
  "different query",
  "missing adoption",
  "failed adoption",
  "wrong owner",
  "duplicate create",
  "own earlier create",
  "owner revision conflict",
  "different refusal",
])("does not excuse %s", (fault) => {
  const steps = recovered();
  if (fault === "missing initial read") steps.shift();
  if (fault === "failed initial read") steps[0]!.result = { kind: "error" };
  if (fault === "already existing owner") steps[0]!.result = steps[2]!.result;
  if (fault === "missing reread") steps.splice(2, 1);
  if (fault === "different query") steps[2]!.args.query = "unrelated";
  if (fault === "missing adoption") steps.pop();
  if (fault === "failed adoption") steps[3]!.result = { kind: "error" };
  if (fault === "wrong owner") steps[3]!.args.id = "other";
  if (fault === "duplicate create" || fault === "own earlier create") {
    const duplicate = { ...steps[1]!, result: { kind: "structured", data: { id: "duplicate" } } };
    if (fault === "duplicate create") steps.push(duplicate);
    else steps.splice(1, 0, duplicate);
  }
  if (fault === "owner revision conflict") steps[1]!.result!.message = "Owner revision changed";
  if (fault === "different refusal") steps[1]!.result!.code = "invalid_arguments";
  expect([...verifiedConcurrentCreateRetries(steps, new Set(["winner"]))]).toEqual([]);
});

test("does not excuse blind repeated creates against the same stale search", () => {
  const steps = recovered();
  steps.splice(2, 0, { ...steps[1]! });
  expect([...verifiedConcurrentCreateRetries(steps, new Set(["winner"]))]).toEqual([0]);
});

test("returns failure ordinals without confusing unrelated refused creates", () => {
  const steps = recovered();
  steps.unshift({
    tool: "open_loop_create",
    args: {},
    result: { kind: "error", code: "invalid_arguments" },
  });
  expect([...verifiedConcurrentCreateRetries(steps, new Set(["winner"]))]).toEqual([1]);
});

test("requires deliberate concurrent fixture provenance, not newly visible search results alone", () => {
  expect([...verifiedConcurrentCreateRetries(recovered(), new Set())]).toEqual([]);
  const steps = recovered();
  steps[2]!.args.limit = 25;
  expect([...verifiedConcurrentCreateRetries(steps, new Set(["winner"]))]).toEqual([]);
});

test("does not classify a full initial result page as evidence of a new owner", () => {
  const steps = recovered();
  steps[0]!.args.limit = 1;
  steps[2]!.args.limit = 1;
  steps[0]!.result = {
    kind: "structured",
    data: { loops: [{ id: "other", title: "Other outcome" }] },
  };
  expect([...verifiedConcurrentCreateRetries(steps, new Set(["winner"]))]).toEqual([]);
});

test.each([
  "valid",
  "wrong target",
  "failed completion",
  "wrong read",
  "no fingerprint",
  "wrong source",
])("requires exact owner read and trusted source routing: %s", (fault) => {
  const steps = recovered().slice(0, 3);
  steps[1]!.args.docs = [fault === "wrong source" ? "other" : "observation"];
  steps.push({
    tool: "open_loop_fetch",
    args: { id: "winner" },
    result: {
      kind: "structured",
      data: {
        id: fault === "wrong read" ? "other" : "winner",
        title: "Confirm observatory access",
      },
    },
  });
  steps.push({
    tool: "knowledge_discovery_complete",
    args: {
      id: "source:observation",
      inputFingerprint: fault === "no fingerprint" ? "" : "revision",
      targets: [fault === "wrong target" ? "other" : "winner"],
    },
    result: fault === "failed completion" ? { kind: "error" } : { kind: "structured", data: {} },
  });
  expect([...verifiedConcurrentCreateRetries(steps, new Set(["winner"]))]).toEqual(
    fault === "valid" ? [0] : [],
  );
});
