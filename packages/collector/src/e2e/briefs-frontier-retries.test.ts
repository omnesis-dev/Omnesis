// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { expect, test } from "vitest";
import { verifiedFrontierRetries } from "./briefs-frontier-retries.js";
import type { ExecutedTool } from "./brain-bench/obs.js";

function recovered(): ExecutedTool[] {
  const item = (version: number) => ({
    id: "overview",
    inputFingerprint: `f${version}`,
    inputVersions: { "orientation:root": version },
    node: { revision: 8 },
  });
  const read = (version: number, done = false): ExecutedTool => ({
    tool: "knowledge_next_frontier",
    args: {},
    result: {
      kind: "structured",
      data: { batchId: "batch", done, items: done ? [] : [item(version)] },
    },
  });
  const save = (version: number): ExecutedTool => ({
    tool: "knowledge_save",
    args: {
      inputFingerprint: item(version).inputFingerprint,
      node: { id: "overview", expectedRevision: 8, inputVersions: item(version).inputVersions },
    },
    result: {
      kind: "structured",
      resultType: "knowledge_save",
      data: { node: { id: "overview", revision: 9 } },
    },
  });
  return [
    read(1),
    {
      ...save(1),
      result: {
        kind: "error",
        code: "revision_conflict",
        message: "Frontier inputs changed; request the next frontier again",
      },
    },
    read(2),
    save(2),
    read(2, true),
  ];
}
test("classifies only an observed fresh-frontier save followed by batch completion", () => {
  expect([...verifiedFrontierRetries(recovered())]).toEqual([0]);
});
test.each([
  "missing initial read",
  "wrong initial fingerprint",
  "unchanged frontier",
  "wrong batch",
  "failed retry",
  "wrong retry versions",
  "no completion",
  "other conflict",
  "structured refusal",
  "wrong returned node",
  "old returned revision",
])("keeps %s in malformed refusals", (fault) => {
  const steps = recovered();
  if (fault === "missing initial read") steps.splice(0, 1);
  if (fault === "wrong initial fingerprint") steps[1]!.args.inputFingerprint = "invented";
  if (fault === "unchanged frontier") steps[2] = structuredClone(steps[0]!);
  if (fault === "wrong batch") steps[2]!.result!.data!.batchId = "other";
  if (fault === "failed retry") steps[3]!.result = { kind: "error", code: "revision_conflict" };
  if (fault === "wrong retry versions")
    steps[3]!.args.node = {
      id: "overview",
      expectedRevision: 8,
      inputVersions: { "orientation:root": 1 },
    };
  if (fault === "no completion") steps.pop();
  if (fault === "structured refusal")
    steps[3]!.result = { kind: "structured", resultType: "record.not_saved", data: {} };
  if (fault === "wrong returned node") steps[3]!.result!.data!.node = { id: "other", revision: 9 };
  if (fault === "old returned revision")
    steps[3]!.result!.data!.node = { id: "overview", revision: 8 };
  if (fault === "other conflict") steps[1]!.result!.message = "Owner changed";
  expect([...verifiedFrontierRetries(steps)]).toEqual([]);
});

function continuation(): ExecutedTool {
  return {
    tool: "knowledge_next_frontier",
    args: {},
    result: {
      kind: "structured",
      data: { batchId: "batch", done: false, items: [], continuation: true },
    },
  };
}

test.each([1, 3])("classifies recovery across %i empty engine continuations", (count) => {
  const steps = recovered();
  steps.splice(2, 0, ...Array.from({ length: count }, continuation));
  expect([...verifiedFrontierRetries(steps)]).toEqual([0]);
});

test.each([
  "wrong batch",
  "missing continuation",
  "nonempty unrelated items",
  "intervening mutation",
  "mutation before continuation",
  "no fresh save",
  "interrupted continuation",
  "interrupted fresh offer",
  "interrupted completion",
])("keeps %s across continuations malformed", (fault) => {
  const steps = recovered();
  const empty = continuation();
  steps.splice(2, 0, empty);
  if (fault === "wrong batch") empty.result!.data!.batchId = "other";
  if (fault === "missing continuation") delete empty.result!.data!.continuation;
  if (fault === "nonempty unrelated items")
    empty.result!.data!.items = [
      { id: "other", inputFingerprint: "other", inputVersions: {}, node: { revision: 1 } },
    ];
  if (fault === "intervening mutation" || fault === "mutation before continuation")
    steps.splice(fault === "intervening mutation" ? 3 : 2, 0, {
      tool: "open_loop_update",
      args: { id: "other", state: "done" },
      result: { kind: "structured", data: {} },
    });
  if (fault === "no fresh save") steps.splice(4, 1);
  if (fault === "interrupted continuation") empty.result!.data!.interrupted = true;
  if (fault === "interrupted fresh offer") steps[3]!.result!.data!.interrupted = true;
  if (fault === "interrupted completion") steps.at(-1)!.result!.data!.interrupted = true;
  expect([...verifiedFrontierRetries(steps)]).toEqual([]);
});

test("an abandoned batch does not prove recovery even after a matching save", () => {
  const steps = recovered();
  steps.at(-1)!.result!.data!.interrupted = true;
  expect([...verifiedFrontierRetries(steps)]).toEqual([]);
});
