// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { inspectInstallRootKey } from "../secret-store.js";
import { storageEncryptionRequired } from "../storage-keys.js";
import { SecretPathUnreadableError } from "../security-files.js";
import { collectWindowsPermissionData } from "./windows-permissions.js";
import { collectSecurityData } from "./security.js";

vi.mock("../secret-store.js", async (original) => ({
  ...(await original<typeof import("../secret-store.js")>()),
  inspectInstallRootKey: vi.fn(),
}));
vi.mock("../storage-keys.js", async (original) => ({
  ...(await original<typeof import("../storage-keys.js")>()),
  storageEncryptionRequired: vi.fn(),
}));
vi.mock("./windows-permissions.js", () => ({ collectWindowsPermissionData: vi.fn() }));

const roots: string[] = [];
beforeEach(() => {
  vi.mocked(collectWindowsPermissionData).mockResolvedValue({
    permissionModel: "windows-acl",
    permissionEntries: [],
    permissionScanCount: 0,
    permissionScanTruncated: false,
  });
});
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function ordinaryUnreadable() {
  return new SecretPathUnreadableError(
    "fictional-keyring",
    Object.assign(new Error("Invented access refusal"), { code: "EACCES" }),
  );
}
async function collect() {
  const configDir = mkdtempSync(join(tmpdir(), "doctor-join-proof-"));
  roots.push(configDir);
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    return await collectSecurityData({
      configDir,
      homeDir: configDir,
      hardenedUnitPath: join(configDir, "absent-hardening.service"),
      fixPermissions: true,
      platform: "linux",
      component: "collector",
      inContainer: true,
      runCommand: async () => ({ code: 1, stdout: "", stderr: "" }),
    });
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

test.each([
  { phase: "root", nested: false },
  { phase: "root", nested: true },
  { phase: "storage", nested: false },
  { phase: "storage", nested: true },
])(
  "unjoined $phase key inspection cannot become a report or authorize repair ($nested)",
  async ({ phase, nested }) => {
    const error = nested
      ? new SecretPathUnreadableError("fictional-keyring", { cleanupFailure: undefined })
      : Object.assign(ordinaryUnreadable(), { cleanupFailure: undefined });
    vi.mocked(inspectInstallRootKey).mockRejectedValueOnce(
      phase === "root" ? error : ordinaryUnreadable(),
    );
    vi.mocked(storageEncryptionRequired).mockImplementation(() => {
      throw error;
    });
    await expect(collect()).rejects.toBe(error);
    expect(collectWindowsPermissionData).not.toHaveBeenCalled();
    if (phase === "root") expect(storageEncryptionRequired).not.toHaveBeenCalled();
    else expect(storageEncryptionRequired).toHaveBeenCalledOnce();
  },
);

test("ordinary unreadable key material still produces a blocked report and permits requested inspection", async () => {
  vi.mocked(inspectInstallRootKey).mockRejectedValueOnce(ordinaryUnreadable());
  vi.mocked(storageEncryptionRequired).mockImplementation(() => {
    throw ordinaryUnreadable();
  });
  const data = await collect();
  expect(data.keyringAccess.readable).toBe(false);
  expect(data.databaseEncryption.status).toBe("blocked");
  expect(data.keyring.valid).toBe(false);
  expect(collectWindowsPermissionData).toHaveBeenCalledExactlyOnceWith(
    roots[0],
    true,
    expect.any(Number),
  );
});
