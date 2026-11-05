// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { runCommand } from "citty";
import { cloudManagementCommands, manageCloud } from "./cloud-management.js";
const { gatewayJson } = vi.hoisted(() => ({
  gatewayJson: vi.fn(async () => ({ enabled: false })),
}));
vi.mock("../utils.js", () => ({ gatewayJson }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  gatewayJson.mockClear();
});
test("management refuses before reading invitations or accessing a default gateway unless explicitly enabled", async () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
  await expect(manageCloud("status")).rejects.toThrow("EXPERIMENTAL");
  expect(gatewayJson).not.toHaveBeenCalled();
});
test("all controls use authenticated common admin API and print only public status", async () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  for (const action of [
    "status",
    "configure",
    "enable",
    "disable",
    "reconnect",
    "renew",
  ] as const) {
    if (action === "configure") {
      await runCommand(cloudManagementCommands.configure, {
        rawArgs: [
          "--relay",
          "https://relay.example.test",
          "--origin",
          "https://custom.test",
          "--acme-directory",
          "https://ca.test/directory",
          "--accept-terms",
        ],
      });
    } else if (action === "enable") {
      await runCommand(cloudManagementCommands.enable, { rawArgs: [] });
    } else {
      await runCommand(cloudManagementCommands[action], { rawArgs: [] });
    }
    expect(gatewayJson).toHaveBeenLastCalledWith(
      `/admin/cloud-relay${action === "status" ? "" : `/${action}`}`,
      action === "status" ? {} : { method: "POST", body: expect.any(String) },
    );
  }
  await manageCloud("disable");
  expect(output).toHaveBeenCalledWith('{\n  "enabled": false\n}\n');
});
test("enrollment reads bounded private invitation JSON, never a token in command history or output", async () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const directory = await mkdtemp(join(tmpdir(), "cloud-management-cli-")),
    file = join(directory, "invitation.json");
  try {
    await writeFile(file, JSON.stringify({ enrollmentToken: "private-one-use-token" }));
    await runCommand(cloudManagementCommands.enable, { rawArgs: ["--invitation-file", file] });
    expect(gatewayJson).toHaveBeenLastCalledWith("/admin/cloud-relay/enable", {
      method: "POST",
      body: JSON.stringify({ invitation: "private-one-use-token" }),
    });
    expect(output.mock.calls.flat().join()).not.toContain("private-one-use-token");
    for (const value of [
      "x",
      "null",
      "{}",
      '{"enrollmentToken":1}',
      '{"enrollmentToken":""}',
      JSON.stringify({ enrollmentToken: "a".repeat(4097) }),
      "a".repeat(9000),
    ]) {
      await writeFile(file, value);
      await expect(
        runCommand(cloudManagementCommands.enable, { rawArgs: ["--invitation-file", file] }),
      ).rejects.toThrow("Invalid enrollment invitation file");
    }
    await expect(
      runCommand(cloudManagementCommands.enable, {
        rawArgs: ["--invitation-file", join(directory, "missing")],
      }),
    ).rejects.toThrow("Invalid enrollment invitation file");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("normal configure uses the gateway installation service without a relay argument", async () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await runCommand(cloudManagementCommands.configure, { rawArgs: [] });
  expect(gatewayJson).toHaveBeenLastCalledWith("/admin/cloud-relay/configure", {
    method: "POST",
    body: JSON.stringify({ termsAccepted: false }),
  });
});
