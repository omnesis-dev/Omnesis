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
