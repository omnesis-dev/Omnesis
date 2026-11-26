// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { expect, test } from "vitest";
import {
  sourcePermissionScopeDigest,
  sourcePermissionRequirementSchema,
  sourcePermissionsRequestSchema,
  sourcePermissionsResponseSchema,
} from "./source-permissions.js";
import { syncRemediationSchema } from "./sync-remediation.js";

const requirement = {
  id: "local-store",
  kind: "protected-files",
  summary: "Allow access to the selected store",
  scope: "Selected local store",
  blocking: true,
  actions: [{ kind: "retry-access" }],
};
test("permission requirements and actions are bounded and never executable instructions", () => {
  expect(sourcePermissionRequirementSchema.parse(requirement)).toEqual(requirement);
  for (const action of [
    { kind: "run", command: "fixture" },
    { kind: "open-system-settings", category: "arbitrary" },
    { kind: "retry-access", url: "https://example.com" },
  ]) {
    expect(
      sourcePermissionRequirementSchema.safeParse({ ...requirement, actions: [action] }).success,
    ).toBe(false);
  }
  expect(
    sourcePermissionRequirementSchema.safeParse({ ...requirement, scope: "x\nraw" }).success,
  ).toBe(false);
  expect(
    sourcePermissionsRequestSchema.safeParse({
      descriptorId: "fixture",
      params: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), "x"])),
    }).success,
  ).toBe(false);
});
test("unknown requirements stay absent while explicit empty requirements remain distinguishable", () => {
  const response = {
    descriptorId: "fixture",
    checkedAt: new Date().toISOString(),
    scopeDigest: "a".repeat(64),
    status: "unsupported",
    target: "unverified",
  };
  expect(sourcePermissionsResponseSchema.parse(response).requirements).toBeUndefined();
  expect(
    sourcePermissionsResponseSchema.parse({ ...response, status: "not-required", requirements: [] })
      .requirements,
  ).toEqual([]);
  expect(
    sourcePermissionsResponseSchema.safeParse({ ...response, target: "Omnesis.app" }).success,
  ).toBe(false);
});
test("typed actions add affordances without altering older remediation text contracts", () => {
  const base = {
    summary: "Collection access is needed",
    steps: ["Review the selected source."],
    restartRequired: false,
  };
  expect(syncRemediationSchema.parse(base)).toEqual(base);
  expect(
    syncRemediationSchema.parse({ ...base, actions: [{ kind: "retry-access" }] }).actions,
  ).toEqual([{ kind: "retry-access" }]);
});

test("scope identity is deterministic without exposing account or configured paths", () => {
  const first = sourcePermissionScopeDigest("fixture", "example-account", {
    roots: ["/example/private"],
    mode: "local",
  });
  expect(first).toMatch(/^[a-f0-9]{64}$/u);
  expect(first).toBe(
    sourcePermissionScopeDigest("fixture", "example-account", {
      mode: "local",
      roots: ["/example/private"],
    }),
  );
  expect(first).not.toBe(
    sourcePermissionScopeDigest("fixture", "another-account", {
      roots: ["/example/private"],
      mode: "local",
    }),
  );
  expect(first).not.toBe(
    sourcePermissionScopeDigest("fixture", "example-account", {
      roots: ["/example/changed"],
      mode: "local",
    }),
  );
});

test("publication protection is an optional exact collector capability, never a requested permission", () => {
  const observation = {
    descriptorId: "fixture",
    checkedAt: new Date().toISOString(),
    scopeDigest: "a".repeat(64),
    status: "unsupported",
    target: "unverified",
  };
  expect(sourcePermissionsResponseSchema.parse(observation).publicationGuard).toBeUndefined();
  expect(
    sourcePermissionsResponseSchema.parse({
      ...observation,
      requirements: [requirement],
      publicationGuard: "managed-v1",
    }).publicationGuard,
  ).toBe("managed-v1");
  for (const requirements of [undefined, [], [{ ...requirement, blocking: false }]])
    expect(
      sourcePermissionsResponseSchema.safeParse({
        ...observation,
        requirements,
        publicationGuard: "managed-v1",
      }).success,
    ).toBe(false);
  for (const publicationGuard of [true, "headless", "managed-v2"])
    expect(
      sourcePermissionsResponseSchema.safeParse({ ...observation, publicationGuard }).success,
    ).toBe(false);
  expect(
    sourcePermissionsRequestSchema.safeParse({
      descriptorId: "fixture",
      publicationGuard: "managed-v1",
    }).success,
  ).toBe(false);
});
