// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { runCommand } from "citty";
import { cloudRecoveryCommands, runCloudRecoveryCommand } from "./cloud-recovery.js";

const { runRelayCommand } = vi.hoisted(() => ({ runRelayCommand: vi.fn() }));
vi.mock("@omnesis/cloud-relay/runtime", () => ({ runRelayCommand }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  runRelayCommand.mockReset();
});

test("every recovery command is cloud-relay gated before importing or invoking runtime", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "0");
  for (const command of Object.values(cloudRecoveryCommands))
    await expect(runCommand(command, { rawArgs: [] })).rejects.toThrow(
      "OMNESIS_CLOUD_RELAY_ENABLED=1",
    );
  expect(runRelayCommand).not.toHaveBeenCalled();
});

test("all six commands preserve runtime public JSON output without adding a misleading success suffix", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  runRelayCommand.mockImplementation(async () => {
    process.stdout.write('{"publicResult":true}\n');
  });
  for (const [operation, command] of Object.entries(cloudRecoveryCommands)) {
    await runCommand(command, { rawArgs: [] });
    expect(runRelayCommand).toHaveBeenLastCalledWith(operation, process.env);
  }
  expect(output).toHaveBeenCalledTimes(6);
  expect(output.mock.calls.every(([text]) => text === '{"publicResult":true}\n')).toBe(true);
});

test("recovery authority, parser and filesystem failures expose no private paths or signing material", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  runRelayCommand.mockRejectedValue(new Error("private-signing-fixture /private/authority.key"));
  await expect(runCloudRecoveryCommand("recovery-sign-receipt")).rejects.toThrow(
    "check the local identity",
  );
  await expect(runCloudRecoveryCommand("recovery-sign-policy")).rejects.not.toThrow(
    "private-signing-fixture",
  );
  expect(output).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});
