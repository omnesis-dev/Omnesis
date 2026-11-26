// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { sourcePermissionScopeDigest } from "@omnesis/core";
import { expect, test, vi } from "vitest";
import { AccountId, DeviceId, SourceId, SourceType } from "@omnesis/types";
import { SourcePermissionsService } from "./SourcePermissionsService.js";
import type { DeviceService } from "./DeviceService.js";
import type { SourceService } from "./SourceService.js";
import type { DeviceWsServer } from "../../ws.js";

function fixture() {
  const getById = vi.fn<DeviceService["getById"]>();
  const settingsForAdmin = vi.fn<SourceService["settingsForAdmin"]>();
  // Only the identity/retirement fields are inspected by this service.
  getById.mockReturnValue({
    id: DeviceId("00000000-0000-4000-8000-000000000901"),
    revokedAt: null,
    capabilities: { sourcePermissions: true },
  } as NonNullable<ReturnType<DeviceService["getById"]>>);
  settingsForAdmin.mockReturnValue({
    source: {
      id: SourceId("fixture:local"),
      type: SourceType("fixture"),
      accountId: AccountId("local"),
      account: null,
      deviceId: DeviceId("00000000-0000-4000-8000-000000000901"),
      config: {},
      enabled: true,
      multiDeviceMode: "exclusive",
      replicaVersionPolicy: null,
      createdAt: 1,
      updatedAt: 1,
    },
    revision: "a".repeat(64),
  });
  const sendCommand = vi.fn<DeviceWsServer["sendCommand"]>().mockResolvedValue({
    descriptorId: "fixture",
    sourceId: "fixture:local",
    checkedAt: new Date().toISOString(),
    scopeDigest: sourcePermissionScopeDigest("fixture", "local", {}),
    status: "not-required",
    requirements: [],
    target: "unverified",
  });
  return {
    getById,
    settingsForAdmin,
    sendCommand,
    service: new SourcePermissionsService(
      { settingsForAdmin },
      { getById },
      { sendCommand: sendCommand as DeviceWsServer["sendCommand"] },
    ),
  };
}
test("permission checks require an actual paired target before dispatch", async () => {
  const f = fixture();
  f.getById.mockReturnValue(null);
  await expect(
    f.service.check("00000000-0000-4000-8000-000000000901", { descriptorId: "fixture" }),
  ).rejects.toThrow("unavailable");
  expect(f.sendCommand).not.toHaveBeenCalled();
  f.getById.mockReturnValue({
    id: DeviceId("00000000-0000-4000-8000-000000000901"),
    revokedAt: 1,
  } as NonNullable<ReturnType<DeviceService["getById"]>>);
  await expect(
    f.service.check("00000000-0000-4000-8000-000000000901", { descriptorId: "fixture" }),
  ).rejects.toThrow("needs pairing");
});
test("a configured source must belong to that exact member, descriptor and account", async () => {
  const f = fixture();
  f.settingsForAdmin.mockReturnValueOnce(null);
  await expect(
    f.service.check("00000000-0000-4000-8000-000000000901", {
      descriptorId: "fixture",
      sourceId: "fixture:local",
    }),
  ).rejects.toThrow("not hosted");
  await expect(
    f.service.check("00000000-0000-4000-8000-000000000901", {
      descriptorId: "other",
      sourceId: "fixture:local",
    }),
  ).rejects.toThrow("does not match");
  await expect(
    f.service.check("00000000-0000-4000-8000-000000000901", {
      descriptorId: "fixture",
      sourceId: "fixture:local",
      accountId: "different",
    }),
  ).rejects.toThrow("does not match");
  expect(f.sendCommand).not.toHaveBeenCalled();
});
test("the response is bound to the exact requested device and source, never a global FDA grant", async () => {
  const f = fixture();
  const response = await f.service.check("00000000-0000-4000-8000-000000000901", {
    descriptorId: "fixture",
    sourceId: "fixture:local",
  });
  expect(response.deviceId).toBe("00000000-0000-4000-8000-000000000901");
  expect(response.target).toBe("unverified");
  expect(f.sendCommand).toHaveBeenCalledWith(
    "00000000-0000-4000-8000-000000000901",
    "source.permissions",
    {
      descriptorId: "fixture",
      sourceId: "fixture:local",
      accountId: "local",
      expectedScopeDigest: sourcePermissionScopeDigest("fixture", "local", {}),
    },
    25_000,
  );
  f.sendCommand.mockResolvedValueOnce({ ...response, descriptorId: "other" });
  await expect(
    f.service.check("00000000-0000-4000-8000-000000000901", {
      descriptorId: "fixture",
      sourceId: "fixture:local",
    }),
  ).rejects.toThrow("does not match");
});

test("configured parameters cannot be overridden and stale collector scope cannot imply access", async () => {
  const f = fixture();
  await expect(
    f.service.check("00000000-0000-4000-8000-000000000901", {
      descriptorId: "fixture",
      sourceId: "fixture:local",
      params: { folder: "/example/other" },
    }),
  ).rejects.toThrow("omit candidate");
  expect(f.sendCommand).not.toHaveBeenCalled();
  f.sendCommand.mockResolvedValueOnce({
    descriptorId: "fixture",
    sourceId: "fixture:local",
    checkedAt: new Date().toISOString(),
    scopeDigest: "b".repeat(64),
    status: "not-required",
    requirements: [],
    target: "unverified",
  });
  await expect(
    f.service.check("00000000-0000-4000-8000-000000000901", {
      descriptorId: "fixture",
      sourceId: "fixture:local",
    }),
  ).rejects.toThrow("awaiting current");
});

test("legacy collectors report unknown support rather than a fictitious no-permission success", async () => {
  const f = fixture();
  f.getById.mockReturnValue({
    id: DeviceId("00000000-0000-4000-8000-000000000901"),
    revokedAt: null,
    capabilities: {},
  } as NonNullable<ReturnType<DeviceService["getById"]>>);
  const result = await f.service.check("00000000-0000-4000-8000-000000000901", {
    descriptorId: "fixture",
  });
  expect(result.status).toBe("unsupported");
  expect(result.requirements).toBeUndefined();
  expect(result.publicationGuard).toBeUndefined();
  expect(f.sendCommand).not.toHaveBeenCalled();
});

test("gateway forwards only publication evidence actually returned by the selected collector", async () => {
  const f = fixture();
  const observation = {
    descriptorId: "fixture",
    sourceId: "fixture:local",
    checkedAt: new Date().toISOString(),
    scopeDigest: sourcePermissionScopeDigest("fixture", "local", {}),
    status: "unsupported" as const,
    requirements: [
      {
        id: "local-store",
        kind: "protected-files" as const,
        summary: "Allow selected store access",
        scope: "Selected local store",
        blocking: true,
        actions: [{ kind: "retry-access" as const }],
      },
    ],
    target: "unverified" as const,
  };
  f.sendCommand.mockResolvedValueOnce({ ...observation, publicationGuard: "managed-v1" });
  const guarded = await f.service.check("00000000-0000-4000-8000-000000000901", {
    descriptorId: "fixture",
    sourceId: "fixture:local",
  });
  expect(guarded.publicationGuard).toBe("managed-v1");
  f.sendCommand.mockResolvedValueOnce(observation);
  const ordinary = await f.service.check("00000000-0000-4000-8000-000000000901", {
    descriptorId: "fixture",
    sourceId: "fixture:local",
  });
  expect(ordinary.publicationGuard).toBeUndefined();
});
