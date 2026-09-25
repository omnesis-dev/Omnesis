// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, test } from "vitest";
import { AccountId, SourceType } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createDevice, getDevice, updateDeviceCapabilities } from "./DeviceRepository.js";
import {
  addSourceMember,
  createSource,
  getSource,
  getSourceMemberConfigOverride,
  setSourceMemberConfigOverride,
} from "./SourceRepository.js";
import {
  deviceSupportsExistingSourceExecution,
  deviceSupportsPersistedSourceContract,
  getSourceMemberConfigContract,
} from "./SourceMemberConfigContractRepository.js";

let db: ReturnType<typeof createDatabase>;
let dir: string;
const type = SourceType("fixture-local");
const caps = (names: string[]) => ({
  hostableSourceTypes: [type],
  multiDeviceModes: { [type]: "partitioned" as const },
  memberScopedParams: { [type]: names },
  syncLease: true,
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-member-contract-"));
  db = createDatabase(join(dir, "gateway.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function pair(names: string[] = []) {
  const owner = createDevice(db, { name: "Owner", kind: "collector", capabilities: caps(names) });
  const sibling = createDevice(db, {
    name: "Sibling",
    kind: "collector",
    capabilities: caps(names),
  });
  const source = createSource(db, {
    type,
    accountId: AccountId("local"),
    deviceId: owner.id,
    multiDeviceMode: "partitioned",
    memberScopedParams: names,
    config: { params: { folder: "/fixture/shared", label: "shared" } },
  });
  addSourceMember(db, source.id, sibling.id);
  return { owner, sibling, source };
}

test("only unanimous members can extend the contract; overlays preserve effective values", () => {
  const { owner, sibling, source } = pair();
  setSourceMemberConfigOverride(db, source.id, sibling.id, {
    params: { folder: "/fixture/sibling" },
  });
  updateDeviceCapabilities(db, owner.id, caps(["folder"]));
  expect(getSourceMemberConfigContract(db, source.id)).toEqual([]);
  updateDeviceCapabilities(db, sibling.id, caps(["folder"]));
  expect(getSourceMemberConfigContract(db, source.id)).toEqual(["folder"]);
  expect(getSource(db, source.id)?.config.params).toEqual({ label: "shared" });
  expect(getSourceMemberConfigOverride(db, source.id, owner.id)).toEqual({
    params: { folder: "/fixture/shared" },
  });
  expect(getSourceMemberConfigOverride(db, source.id, sibling.id)).toEqual({
    params: { folder: "/fixture/sibling" },
  });
  updateDeviceCapabilities(db, owner.id, caps(["folder"]));
  expect(getSourceMemberConfigOverride(db, source.id, sibling.id)?.params).toEqual({
    folder: "/fixture/sibling",
  });
});

test("an absent member declaration blocks repinning", () => {
  const { owner, sibling, source } = pair();
  updateDeviceCapabilities(db, sibling.id, { hostableSourceTypes: [type] });
  updateDeviceCapabilities(db, owner.id, caps(["folder"]));
  expect(getSourceMemberConfigContract(db, source.id)).toEqual([]);
});

test("an existing member can execute an additive contract without repinning or authorizing joins", () => {
  const { owner, sibling, source } = pair(["folder"]);
  setSourceMemberConfigOverride(db, source.id, owner.id, {
    params: { folder: "/fixture/owner" },
  });
  setSourceMemberConfigOverride(db, source.id, sibling.id, {
    params: { folder: "/fixture/sibling" },
  });
  const before = getSource(db, source.id);
  updateDeviceCapabilities(db, sibling.id, caps(["cachePath", "folder"]));
  const upgraded = getDevice(db, sibling.id)!;
  const newcomer = createDevice(db, {
    name: "Newcomer",
    kind: "collector",
    capabilities: caps(["cachePath", "folder"]),
  });

  expect(deviceSupportsExistingSourceExecution(db, source, upgraded)).toBe(true);
  expect(deviceSupportsPersistedSourceContract(db, source, upgraded)).toBe(false);
  expect(deviceSupportsExistingSourceExecution(db, source, newcomer)).toBe(false);
  expect(getSourceMemberConfigContract(db, source.id)).toEqual(["folder"]);
  expect(getSource(db, source.id)).toEqual(before);
  expect(getSourceMemberConfigOverride(db, source.id, owner.id)).toEqual({
    params: { folder: "/fixture/owner" },
  });
  expect(getSourceMemberConfigOverride(db, source.id, sibling.id)).toEqual({
    params: { folder: "/fixture/sibling" },
  });
});

test.each([{ names: undefined }, { names: [] }, { names: ["cachePath"] }])(
  "execution still refuses a missing or contracted member declaration: $names",
  ({ names }) => {
    const { sibling, source } = pair(["folder"]);
    const capabilities = caps(names ?? []);
    updateDeviceCapabilities(db, sibling.id, {
      ...capabilities,
      memberScopedParams: names === undefined ? {} : capabilities.memberScopedParams,
    });
    expect(deviceSupportsExistingSourceExecution(db, source, getDevice(db, sibling.id)!)).toBe(
      false,
    );
  },
);

test("additive fields do not excuse an incompatible storage mode or replica policy", () => {
  const { sibling, source } = pair();
  updateDeviceCapabilities(db, sibling.id, {
    ...caps(["folder"]),
    multiDeviceModes: { [type]: "replicated" },
    replicaVersionPolicies: { [type]: "source-updated-at" },
  });
  const upgraded = getDevice(db, sibling.id)!;
  expect(deviceSupportsExistingSourceExecution(db, source, upgraded)).toBe(false);
  expect(
    deviceSupportsExistingSourceExecution(
      db,
      { ...source, multiDeviceMode: "replicated", replicaVersionPolicy: null },
      upgraded,
    ),
  ).toBe(false);
  expect(
    deviceSupportsExistingSourceExecution(
      db,
      { ...source, multiDeviceMode: "replicated", replicaVersionPolicy: "source-updated-at" },
      { ...upgraded, capabilities: { ...upgraded.capabilities, syncLease: false } },
    ),
  ).toBe(false);
});

test("a unanimous contraction cannot promote private member values to shared config", () => {
  const { owner, sibling, source } = pair(["folder"]);
  setSourceMemberConfigOverride(db, source.id, owner.id, {
    params: { folder: "/fixture/private" },
  });
  updateDeviceCapabilities(db, owner.id, caps([]));
  updateDeviceCapabilities(db, sibling.id, caps([]));
  expect(getSourceMemberConfigContract(db, source.id)).toEqual(["folder"]);
  expect(getSourceMemberConfigOverride(db, source.id, owner.id)?.params).toEqual({
    folder: "/fixture/private",
  });
});
