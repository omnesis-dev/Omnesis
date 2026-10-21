// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import {
  verifiedCollectionCreateRetries,
  verifiedConcurrentCreateRetries,
} from "./briefs-concurrency-retries.js";
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

function refreshedCreate(): ExecutedTool[] {
  const steps = recovered().slice(0, 3);
  steps[1]!.args.docs = ["source"];
  steps[2]!.result = { kind: "structured", data: { loops: [] } };
  steps.push({
    tool: "open_loop_create",
    args: { ...steps[1]!.args },
    result: {
      kind: "structured",
      data: { loop: { id: "created", title: "Confirm observatory access" } },
    },
  });
  return steps;
}

test("verifies a fresh same-query read and identical successful create after a collection CAS refusal", () => {
  expect([...verifiedCollectionCreateRetries(refreshedCreate())]).toEqual([1]);
});

test("accounts for every refused attempt in a repeated fresh-read CAS recovery", () => {
  const steps = refreshedCreate();
  steps.splice(3, 0, structuredClone(steps[1]!), structuredClone(steps[2]!));
  expect([...verifiedCollectionCreateRetries(steps)]).toEqual([1, 3]);
});

test.each([
  "missing read",
  "missing reread",
  "changed query",
  "changed intent",
  "existing owner",
  "intervening mutation",
  "stale initial read",
  "wrong failure",
  "unrecovered failure",
] as const)("does not excuse a collection retry with %s", (fault) => {
  const steps = refreshedCreate();
  if (fault === "missing read") steps.shift();
  if (fault === "missing reread") steps.splice(2, 1);
  if (fault === "changed query") steps[2]!.args.query = "other";
  if (fault === "changed intent") steps[3]!.args.docs = ["other-source"];
  if (fault === "existing owner") steps[2]!.result = recovered()[2]!.result;
  if (fault === "intervening mutation")
    steps.splice(3, 0, { tool: "open_loop_update", args: {}, result: { kind: "structured" } });
  if (fault === "stale initial read")
    steps.splice(1, 0, { tool: "open_loop_update", args: {}, result: { kind: "structured" } });
  if (fault === "wrong failure") steps[1]!.result!.code = "invalid_arguments";
  if (fault === "unrecovered failure") steps.pop();
  expect([...verifiedCollectionCreateRetries(steps)]).toEqual([]);
});

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
