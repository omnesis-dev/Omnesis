// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import {
  createSecretStore,
  confirmMacosKeychainEntriesAbsent,
  type SecretCommandRunner,
} from "./secret-store.js";
const options = { backend: "macos-keychain" as const, service: "dev.example.invented-keychain" };
test.each([
  [0, 44],
  [44, 44],
])(
  "delete exit%s confirms actual item absence, including idempotent not-found",
  async (removeCode, findCode) => {
    const calls: string[][] = [];
    const runCommand: SecretCommandRunner = async (_command, args) => {
      calls.push(args);
      return {
        code: args[0] === "delete-generic-password" ? removeCode : findCode,
        stdout: "",
        stderr: "",
      };
    };
    await expect(
      createSecretStore({ ...options, runCommand }).delete("invented-account"),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([
      ["delete-generic-password", "-a", "invented-account", "-s", options.service],
      ["find-generic-password", "-a", "invented-account", "-s", options.service],
    ]);
    expect(calls.flat()).not.toContain("-w");
  },
);
test.each([
  [36, 44],
  [1, 44],
  [0, 0],
  [0, 36],
])(
  "delete refusal%s or unverifiable absence%s never reports successful cleanup",
  async (removeCode, findCode) => {
    const runCommand: SecretCommandRunner = async (_command, args) => ({
      code: args[0] === "delete-generic-password" ? removeCode : findCode,
      stdout: "invented secret that must never be forwarded",
      stderr: "invented private system detail",
    });
    const error = await createSecretStore({ ...options, runCommand })
      .delete("invented-account")
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Unlock|remains/);
    expect((error as Error).message).not.toContain("invented");
  },
);
test("fresh-install absence checks require authoritative metadata not-found for every named account", async () => {
  const runCommand = vi.fn<SecretCommandRunner>(async (_command, args) => ({
    code: args[0] === "-h" ? 0 : 44,
    stdout: "",
    stderr: "",
  }));
  expect(
    await confirmMacosKeychainEntriesAbsent(["invented-root", "invented-marker"], {
      ...options,
      runCommand,
    }),
  ).toBe(true);
  expect(runCommand.mock.calls.flatMap(([, args]) => args)).not.toContain("-w");
  runCommand.mockImplementation(async (_command, args) => ({
    code: args[0] === "-h" ? 0 : args.includes("invented-marker") ? 0 : 44,
    stdout: "",
    stderr: "",
  }));
  expect(
    await confirmMacosKeychainEntriesAbsent(["invented-root", "invented-marker"], {
      ...options,
      runCommand,
    }),
  ).toBe(false);
  runCommand.mockImplementation(async (_command, args) => ({
    code: args[0] === "-h" ? 0 : 36,
    stdout: "",
    stderr: "locked",
  }));
  await expect(
    confirmMacosKeychainEntriesAbsent(["invented-root"], { ...options, runCommand }),
  ).rejects.toThrow("could not confirm absence");
  await expect(
    confirmMacosKeychainEntriesAbsent(["invented-root"], { backend: "file", runCommand }),
  ).rejects.toThrow("scoped macOS");
});
