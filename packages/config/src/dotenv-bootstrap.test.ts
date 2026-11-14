// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
const native = vi.hoisted(() => ({ read: vi.fn(), secure: vi.fn() }));
vi.mock("@omnesis/platform/windows-private-file", () => ({
  readWindowsPrivateFileContentsSync: native.read,
  secureWindowsPrivatePathSync: native.secure,
}));
import {
  loadBootstrapDotEnv,
  DotEnvBootstrapError,
  repairBootstrapDotEnvAccess,
} from "./dotenv-bootstrap.js";

const roots: string[] = [];
afterEach(() => {
  native.read.mockReset();
  native.secure.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "dotenv-bootstrap-"));
  roots.push(root);
  return root;
}
function onPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

describe("dotenv bootstrap security", () => {
  test("bootstrap repair delegates protected file replacement without exposing env bytes to the loader", () => {
    const dir = scratch();
    const path = join(dir, ".env");
    const error = new DotEnvBootstrapError(path, new Error("Unsafe ACL"));
    onPlatform("win32", () => repairBootstrapDotEnvAccess(error));
    expect(native.secure.mock.calls).toEqual([
      [dir, "directory"],
      [path, "file"],
    ]);
    expect(native.read).not.toHaveBeenCalled();
  });

  test("Windows consumes only the protected reader's complete bytes, without an authority-key size cap", () => {
    const dir = scratch();
    const value = "invented-value".repeat(3000);
    native.read.mockReturnValue(Buffer.from(`EXAMPLE=${value}\n`));
    const env: NodeJS.ProcessEnv = {};
    const result = onPlatform("win32", () => loadBootstrapDotEnv({ dir, env }));
    expect(native.read).toHaveBeenCalledExactlyOnceWith(join(dir, ".env"));
    expect(result?.keys).toEqual(["EXAMPLE"]);
    expect(env.EXAMPLE).toBe(value);
  });

  test.each(["EPRIVATE", "EACCES", "EIO"])(
    "Windows refuses unsafe or unreadable config (%s)",
    (code) => {
      const error = Object.assign(new Error("Config was not verified"), { code });
      native.read.mockImplementation(() => {
        throw error;
      });
      const env: NodeJS.ProcessEnv = { RETAINED: "invented" };
      expect(() => onPlatform("win32", () => loadBootstrapDotEnv({ dir: scratch(), env }))).toThrow(
        DotEnvBootstrapError,
      );
      expect(env).toEqual({ RETAINED: "invented" });
    },
  );

  test("Windows treats only a proven absent file as a missing bootstrap", () => {
    native.read.mockImplementation(() => {
      throw Object.assign(new Error("Missing"), { code: "ENOENT" });
    });
    expect(onPlatform("win32", () => loadBootstrapDotEnv({ dir: scratch(), env: {} }))).toBeNull();
  });

  test.each(["linux", "darwin"] as const)(
    "preserves the existing %s dotenv behavior",
    (platform) => {
      const dir = scratch();
      writeFileSync(join(dir, ".env"), "EXAMPLE=fictional\n");
      const env: NodeJS.ProcessEnv = {};
      onPlatform(platform, () => loadBootstrapDotEnv({ dir, env }));
      expect(env.EXAMPLE).toBe("fictional");
      expect(native.read).not.toHaveBeenCalled();
      expect(
        onPlatform(platform, () => loadBootstrapDotEnv({ dir: join(dir, "absent"), env: {} })),
      ).toBeNull();
    },
  );
});
