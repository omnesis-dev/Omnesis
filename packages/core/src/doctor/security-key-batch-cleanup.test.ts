// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { inspectInstallRootKey } from "../secret-store.js";
import {
  inspectStorageKey,
  storageEncryptionRequired,
  storageKeyNamesForHost,
  type StorageKeyState,
} from "../storage-keys.js";
import { SecretPathUnreadableError } from "../security-files.js";
import { collectWindowsPermissionData } from "./windows-permissions.js";
import { collectSecurityData } from "./security.js";

vi.mock("../secret-store.js", async (original) => ({
  ...(await original<typeof import("../secret-store.js")>()),
  inspectInstallRootKey: vi.fn(),
}));
vi.mock("../storage-keys.js", async (original) => ({
  ...(await original<typeof import("../storage-keys.js")>()),
  inspectStorageKey: vi.fn(),
  storageEncryptionRequired: vi.fn(),
}));
vi.mock("./windows-permissions.js", () => ({ collectWindowsPermissionData: vi.fn() }));

afterEach(() => vi.resetAllMocks());
function ordinary() {
  return new SecretPathUnreadableError(
    "fictional-keyring",
    new Error("Invented joined access refusal"),
  );
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), "doctor-key-join-"));
  vi.mocked(inspectInstallRootKey).mockRejectedValueOnce(ordinary());
  vi.mocked(storageEncryptionRequired).mockReturnValue(false);
  vi.mocked(collectWindowsPermissionData).mockResolvedValue({
    permissionModel: "windows-acl",
    permissionEntries: [],
    permissionScanCount: 0,
    permissionScanTruncated: false,
  });
  const collect = () =>
    collectSecurityData({
      configDir: root,
      homeDir: root,
      hardenedUnitPath: join(root, "absent.service"),
      component: "collector",
      platform: "linux",
      fixPermissions: true,
      inContainer: true,
      runCommand: async () => ({ code: 1, stdout: "", stderr: "" }),
    });
  return { root, collect };
}

test.each([false, true])(
  "a late sibling receipt dominates an earlier ordinary failure after every key joins (nested:%s)",
  async (nested) => {
    const { root, collect } = setup();
    const marker = { cleanupFailure: undefined };
    const failure = nested
      ? new SecretPathUnreadableError(
          "fictional-keyring",
          new Error("Invented nested refusal", { cause: marker }),
        )
      : Object.assign(ordinary(), marker);
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let rejectHeld!: (error: unknown) => void;
    const held = new Promise<StorageKeyState>((_resolve, reject) => {
      rejectHeld = reject;
    });
    let calls = 0;
    vi.mocked(inspectStorageKey).mockImplementation(async (keyName) => {
      if (++calls === 1) throw ordinary();
      if (calls === 2) {
        enter();
        return held;
      }
      return {
        keyName,
        path: join(root, "fictional-key"),
        present: false,
        valid: false,
        encrypted: false,
      };
    });
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    let settled = false;
    const result = collect().then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    try {
      await entered;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(collectWindowsPermissionData).not.toHaveBeenCalled();
      rejectHeld(failure);
      const outcome = await result;
      expect("error" in outcome ? outcome.error : undefined).toBe(failure);
      expect(inspectStorageKey).toHaveBeenCalledTimes(storageKeyNamesForHost("collector").length);
      expect(collectWindowsPermissionData).not.toHaveBeenCalled();
    } finally {
      rejectHeld(failure);
      await result;
      Object.defineProperty(process, "platform", descriptor);
      // Only injected key-reader promises were held; every one is now joined.
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("joined ordinary key failures still yield a blocked report", async () => {
  const { root, collect } = setup();
  vi.mocked(inspectStorageKey).mockRejectedValue(ordinary());
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    const report = await collect();
    expect(report.keyringAccess.readable).toBe(false);
    expect(report.databaseEncryption.status).toBe("blocked");
    expect(inspectStorageKey).toHaveBeenCalledTimes(storageKeyNamesForHost("collector").length);
    expect(collectWindowsPermissionData).toHaveBeenCalledExactlyOnceWith(
      root,
      true,
      expect.any(Number),
    );
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    rmSync(root, { recursive: true, force: true });
  }
});
