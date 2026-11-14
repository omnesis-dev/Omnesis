// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
const native = vi.hoisted(() => ({
  read: vi.fn(),
  readSync: vi.fn(),
  inspect: vi.fn(),
  remove: vi.fn(),
  removeSync: vi.fn(),
}));
vi.mock("@omnesis/platform/windows-private-file", async (actual) => ({
  ...(await actual<typeof import("@omnesis/platform/windows-private-file")>()),
  readWindowsPrivateFileContents: native.read,
  readWindowsPrivateFileContentsSync: native.readSync,
  inspectWindowsPrivatePaths: native.inspect,
  deleteWindowsPrivateFileExact: native.remove,
  deleteWindowsPrivateFileExactSync: native.removeSync,
}));
import {
  readPrivateSecretText,
  readPrivateSecretTextSync,
  verifyWindowsSecretFiles,
} from "./secret-store-files.js";
import { SecretPathUnreadableError } from "./security-files.js";
import {
  deleteSecretEntry,
  deleteSecretEntrySync,
  retireLegacySecretEntrySync,
} from "./secret-store-entry.js";

const roots: string[] = [];
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "secret-store-private-state-"));
  roots.push(root);
  return root;
}
function onPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}
afterEach(() => {
  for (const mock of Object.values(native)) mock.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("existing private secret files", () => {
  const uncertaintyShapes = [
    { nested: false, failure: undefined },
    { nested: true, failure: undefined },
    { nested: false, failure: new Error("Invented join refusal") },
    { nested: true, failure: new Error("Invented join refusal") },
  ];
  function unjoinedMissing({ nested, failure }: (typeof uncertaintyShapes)[number]): Error {
    const marker = Object.assign(new Error("Invented unjoined operation"), {
      cleanupFailure: failure,
    });
    return Object.assign(
      new Error("Invented absent file", nested ? { cause: marker } : undefined),
      {
        code: "ENOENT",
        ...(nested ? {} : { cleanupFailure: failure }),
      },
    );
  }
  test.each(uncertaintyShapes)(
    "an unjoined missing read cannot become absence: $nested/$failure",
    async (shape) => {
      const failure = unjoinedMissing(shape);
      native.read.mockRejectedValue(failure);
      native.readSync.mockImplementation(() => {
        throw failure;
      });
      const result = await onPlatform("win32", () => readPrivateSecretText("example.secret")).catch(
        (error: unknown) => error,
      );
      expect(result).toBeInstanceOf(SecretPathUnreadableError);
      expect(result).toHaveProperty("cause", failure);
      expect(() => onPlatform("win32", () => readPrivateSecretTextSync("example.secret"))).toThrow(
        SecretPathUnreadableError,
      );
      expect(native.read).toHaveBeenCalledOnce();
      expect(native.readSync).toHaveBeenCalledOnce();
    },
  );
  test.each(uncertaintyShapes)(
    "an unjoined missing deletion cannot authorize legacy cleanup: $nested/$failure",
    async (shape) => {
      const paths = {
        path: "current.secret",
        legacy: {
          path: "legacy/old.secret",
          exactBasename: "old.secret",
          exactParentBasename: "legacy",
        },
      };
      const failure = unjoinedMissing(shape);
      native.remove.mockRejectedValue(failure);
      native.removeSync.mockImplementation(() => {
        throw failure;
      });
      await expect(onPlatform("win32", () => deleteSecretEntry(paths))).rejects.toMatchObject({
        cause: failure,
      });
      expect(native.remove).toHaveBeenCalledOnce();
      expect(() => onPlatform("win32", () => deleteSecretEntrySync(paths))).toThrow(
        SecretPathUnreadableError,
      );
      expect(native.removeSync).toHaveBeenCalledOnce();
      native.removeSync.mockClear();
      expect(() => onPlatform("win32", () => retireLegacySecretEntrySync(paths))).toThrow(
        SecretPathUnreadableError,
      );
      expect(native.removeSync).toHaveBeenCalledOnce();
    },
  );
  test("Windows only treats native ENOENT as absent in async and sync reads", async () => {
    const error = Object.assign(new Error("Unsafe existing key"), { code: "EPRIVATE" });
    native.read.mockRejectedValue(error);
    native.readSync.mockImplementation(() => {
      throw error;
    });
    await expect(
      onPlatform("win32", () => readPrivateSecretText("example.secret")),
    ).rejects.toBeInstanceOf(SecretPathUnreadableError);
    expect(() => onPlatform("win32", () => readPrivateSecretTextSync("example.secret"))).toThrow(
      SecretPathUnreadableError,
    );
    const absent = Object.assign(new Error("Absent"), { code: "ENOENT" });
    native.read.mockRejectedValue(absent);
    native.readSync.mockImplementation(() => {
      throw absent;
    });
    expect(await onPlatform("win32", () => readPrivateSecretText("example.secret"))).toBeNull();
    expect(onPlatform("win32", () => readPrivateSecretTextSync("example.secret"))).toBeNull();
  });

  test("Windows whole-file reads do not request an authority-key size bound", async () => {
    const value = "invented-value".repeat(2000);
    native.read.mockResolvedValue(Buffer.from(value));
    native.readSync.mockReturnValue(Buffer.from(value));
    expect(await onPlatform("win32", () => readPrivateSecretText("large.secret"))).toBe(value);
    expect(onPlatform("win32", () => readPrivateSecretTextSync("large.secret"))).toBe(value);
    expect(native.read).toHaveBeenCalledExactlyOnceWith("large.secret", undefined);
    expect(native.readSync).toHaveBeenCalledExactlyOnceWith("large.secret", undefined);
  });

  test("Windows status refuses existing unsafe entries even when the directories are private", async () => {
    const root = scratch();
    const directory = join(root, "keyring", "example-service");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "example.secret"), "invented");
    native.inspect.mockResolvedValueOnce([
      { private: true, fixed: false },
      { private: true, fixed: false },
    ]);
    native.inspect.mockResolvedValueOnce([{ private: false, fixed: false }]);
    await expect(
      onPlatform("win32", () => verifyWindowsSecretFiles(root, "example-service")),
    ).rejects.toBeInstanceOf(SecretPathUnreadableError);
    expect(native.inspect).toHaveBeenCalledTimes(2);
  });

  test.each(["linux", "darwin"] as const)(
    "preserves %s file reads without native helpers",
    async (platform) => {
      const file = join(scratch(), "example.secret");
      writeFileSync(file, "invented-value");
      expect(await onPlatform(platform, () => readPrivateSecretText(file))).toBe("invented-value");
      expect(onPlatform(platform, () => readPrivateSecretTextSync(file))).toBe("invented-value");
      expect(native.read).not.toHaveBeenCalled();
      expect(native.readSync).not.toHaveBeenCalled();
    },
  );
});
