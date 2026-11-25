// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { restoreInstallRootKeyIfAbsent } from "./root-key-recovery.js";
import { generateInstallRootKey, type SecretCommandRunner } from "./secret-store.js";

function fixture(initial: string | null = null, concurrent?: string) {
  let stored = initial;
  const run = vi.fn<SecretCommandRunner>((command, args) => {
    if (args[0] === "-h") return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    if (args[0] === "find-generic-password")
      return Promise.resolve({ code: stored === null ? 44 : 0, stdout: stored ?? "", stderr: "" });
    expect(command).toBe("/usr/bin/security");
    expect(args[0]).toBe("add-generic-password");
    expect(args).not.toContain("-U");
    if (concurrent) stored = concurrent;
    if (stored !== null) return Promise.resolve({ code: 45, stdout: "", stderr: "Duplicate item" });
    stored = args.at(-1) ?? null;
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  });
  return {
    run,
    stored: () => stored,
    options: {
      backend: "macos-keychain" as const,
      platform: "darwin" as const,
      configDir: "/tmp/omnesis-fictional-recovery-fixture",
      service: "dev.example.recovery.fixture",
      runCommand: run,
    },
  };
}

test("restores a supplied key atomically in the explicit existing reader namespace", async () => {
  const f = fixture();
  const key = generateInstallRootKey();
  await restoreInstallRootKeyIfAbsent(key, f.options);
  expect(f.stored()).toBe(key);
  const insertion = f.run.mock.calls.find(([, args]) => args[0] === "add-generic-password");
  expect(insertion?.[1]).toContain(f.options.service);
});

test.each(["valid", "malformed"])("never replaces an existing %s root entry", async (kind) => {
  const initial = kind === "valid" ? generateInstallRootKey() : "malformed fictional entry";
  const f = fixture(initial);
  await expect(restoreInstallRootKeyIfAbsent(generateInstallRootKey(), f.options)).rejects.toThrow(
    "will not replace",
  );
  expect(f.stored()).toBe(initial);
  expect(f.run.mock.calls.some(([, args]) => args[0] === "add-generic-password")).toBe(false);
});

test.each(["valid", "malformed"])(
  "concurrent %s insertion is refused without overwriting the winning entry",
  async (kind) => {
    const winner =
      kind === "valid" ? generateInstallRootKey() : "malformed concurrent fictional entry";
    const f = fixture(null, winner);
    await expect(
      restoreInstallRootKeyIfAbsent(generateInstallRootKey(), f.options),
    ).rejects.toThrow("never be replaced");
    expect(f.stored()).toBe(winner);
  },
);

test("unavailable or locked Keychain never falls back to a file", async () => {
  const f = fixture();
  f.run.mockImplementation((command, args) => {
    if (command === "/usr/bin/security")
      return Promise.resolve({ code: 36, stdout: "", stderr: "User interaction is not allowed" });
    return Promise.resolve({ code: args[0] === "-h" ? 0 : 44, stdout: "", stderr: "" });
  });
  await expect(restoreInstallRootKeyIfAbsent(generateInstallRootKey(), f.options)).rejects.toThrow(
    "Unlock your Mac",
  );
  expect(f.stored()).toBeNull();
});

test("invalid keys and implicit or non-macOS backends are refused before invoking tools", async () => {
  const f = fixture();
  await expect(restoreInstallRootKeyIfAbsent("not a key", f.options)).rejects.toThrow("format");
  await expect(
    restoreInstallRootKeyIfAbsent(generateInstallRootKey(), { ...f.options, backend: "file" }),
  ).rejects.toThrow("explicit macOS");
  expect(f.run).not.toHaveBeenCalled();
});

test("unavailable macOS Keychain refuses before any insertion", async () => {
  const f = fixture();
  f.run.mockImplementation(() => Promise.resolve({ code: 127, stdout: "", stderr: "Unavailable" }));
  await expect(restoreInstallRootKeyIfAbsent(generateInstallRootKey(), f.options)).rejects.toThrow(
    "Unlock the macOS Keychain",
  );
  expect(f.stored()).toBeNull();
  expect(f.run.mock.calls.some(([, args]) => args[0] === "add-generic-password")).toBe(false);
});
