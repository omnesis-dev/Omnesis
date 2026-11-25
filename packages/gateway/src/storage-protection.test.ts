// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { captureGatewayStorageProtection } from "./storage-protection.js";

function evidence() {
  return {
    keyringStatus: vi.fn(async () => ({
      requestedBackend: "macos-keychain" as const,
      backend: "macos-keychain" as const,
      available: true,
      secure: true,
      detail: "Fixture keyring",
    })),
    secretsRequired: () => true,
    storesRequired: () => true,
  };
}

test("encrypted remote admission requires active keyed stores and both required policies", async () => {
  const deps = evidence();
  expect(await captureGatewayStorageProtection("/fixture", true, deps)).toEqual({
    version: 1,
    atRest: "encrypted",
  });
  expect(await captureGatewayStorageProtection("/fixture", false, deps)).toEqual({
    version: 1,
    atRest: "unprotected",
  });
  expect(
    await captureGatewayStorageProtection("/fixture", true, {
      ...deps,
      secretsRequired: () => false,
    }),
  ).toEqual({ version: 1, atRest: "unprotected" });
  expect(
    await captureGatewayStorageProtection("/fixture", true, {
      ...deps,
      storesRequired: () => false,
    }),
  ).toEqual({ version: 1, atRest: "unprotected" });
});

test("plaintext root files cannot masquerade as protected storage", async () => {
  const deps = evidence();
  deps.keyringStatus.mockResolvedValue({
    requestedBackend: "macos-keychain",
    backend: "macos-keychain",
    available: true,
    secure: false,
    detail: "Fixture insecure backend",
  });
  expect(await captureGatewayStorageProtection("/fixture", true, deps)).toEqual({
    version: 1,
    atRest: "unprotected",
  });
});

test("unavailable or failed keyring evidence is explicitly unknown, without private details", async () => {
  const deps = evidence();
  deps.keyringStatus.mockRejectedValue(new Error("fictional-private-keyring-detail"));
  expect(await captureGatewayStorageProtection("/fixture", true, deps)).toEqual({
    version: 1,
    atRest: "unavailable",
  });
});
