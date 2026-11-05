// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { runCommand } from "citty";
import { isDefaultGatewayTrustExempt } from "../trust-preflight.js";
import { visibleSubCommands } from "../subcommands.js";
import { runCloudIdentityCommand, decideCloudPairing, cloudCommand } from "./cloud.js";

const { runRelayCommand, gatewayJson } = vi.hoisted(() => ({
  runRelayCommand: vi.fn(),
  gatewayJson: vi.fn(),
}));
vi.mock("@omnesis/cloud-relay/runtime", () => ({ runRelayCommand }));
vi.mock("../utils.js", () => ({ gatewayJson }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  runRelayCommand.mockReset();
  gatewayJson.mockReset();
});

test("Google cloud commands are hidden and refused unless explicitly experimental", async () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
  expect(visibleSubCommands()).not.toHaveProperty("cloud");
  await expect(runCloudIdentityCommand("google-login")).rejects.toThrow("EXPERIMENTAL");
  expect(runRelayCommand).not.toHaveBeenCalled();
});

test("installed CLI dispatches Google login, gateway registration and device pairing without dialing a default gateway", async () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(visibleSubCommands()).toHaveProperty("cloud");
  for (const [subcommand, operation] of [
    ["login", "google-login"],
    ["register", "register-gateway"],
    ["pair", "pair-device"],
    ["register-key", "register-key"],
    ["prepare-owner", "prepare-owner"],
    ["issue-invite", "issue-invite"],
    ["link-google", "link-google"],
    ["unlink-google", "unlink-google"],
  ]) {
    expect(isDefaultGatewayTrustExempt(["cloud", subcommand])).toBe(true);
    await runCommand(cloudCommand, { rawArgs: [subcommand] });
    expect(runRelayCommand).toHaveBeenLastCalledWith(operation, process.env);
  }
});

test("credential parser and OAuth errors are never printed by the CLI", async () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  runRelayCommand.mockRejectedValue(new Error("fictional-sensitive-refresh-token"));
  await expect(runCloudIdentityCommand("google-login")).rejects.not.toThrow(
    "fictional-sensitive-refresh-token",
  );
});

const requestId = "00000000-0000-4000-8000-000000000001";
const verificationCode = "AAAA-BBBB-CCCC-DDDD-EEEE";
function pending(extra = {}) {
  return {
    requestId,
    name: "Fictional phone",
    kind: "ios",
    status: "pending",
    expiresAt: Date.now() + 60_000,
    verificationCode,
    ...extra,
  };
}

test("owner requests and decisions use the trusted gateway and require the new device's exact comparison code", async () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  gatewayJson.mockResolvedValue({ items: [pending({ name: "Fictional\u001b[31mphone" })] });
  expect(isDefaultGatewayTrustExempt(["cloud", "requests"])).toBe(false);
  expect(isDefaultGatewayTrustExempt(["cloud", "approve", requestId])).toBe(false);
  expect(isDefaultGatewayTrustExempt(["cloud", "deny", requestId])).toBe(false);
  await runCommand(cloudCommand, { rawArgs: ["requests"] });
  expect(output).toHaveBeenLastCalledWith(expect.stringContaining("\\u001b"));
  expect(output).not.toHaveBeenLastCalledWith(expect.stringContaining("\u001b"));
  await runCommand(cloudCommand, {
    rawArgs: ["approve", requestId, "--code", verificationCode.toLowerCase()],
  });
  expect(gatewayJson).toHaveBeenLastCalledWith("/admin/cloud-pairing/decision", {
    method: "POST",
    body: JSON.stringify({ requestId, approve: true }),
  });
  await runCommand(cloudCommand, { rawArgs: ["deny", requestId] });
  expect(gatewayJson).toHaveBeenLastCalledWith("/admin/cloud-pairing/decision", {
    method: "POST",
    body: JSON.stringify({ requestId, approve: false }),
  });
});

test("owner approval refuses mismatched, absent, expired and already decided requests without a write", async () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  for (const row of [undefined, pending({ status: "approved" }), pending({ expiresAt: 1 })]) {
    gatewayJson.mockResolvedValue({ items: row ? [row] : [] });
    await expect(decideCloudPairing("approve", requestId, verificationCode)).rejects.toThrow(
      "No current pending",
    );
  }
  gatewayJson.mockResolvedValue({ items: [pending()] });
  for (const code of [undefined, "wrong"])
    await expect(decideCloudPairing("approve", requestId, code)).rejects.toThrow("does not match");
  expect(gatewayJson.mock.calls.every((call) => call[0] === "/admin/cloud-pairing/requests")).toBe(
    true,
  );
  await expect(decideCloudPairing("deny", "not-a-uuid")).rejects.toThrow();
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
  await expect(decideCloudPairing("list")).rejects.toThrow("EXPERIMENTAL");
});

test("prepare-owner preserves the runtime public JSON output without a success suffix", async () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await runCloudIdentityCommand("prepare-owner");
  expect(output).not.toHaveBeenCalled();
  expect(runRelayCommand).toHaveBeenCalledWith("prepare-owner", process.env);
});

test("installed cloud command exposes six explicit offline/local recovery operations without unrelated gateway calls", async () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  for (const operation of [
    "recovery-create-authority",
    "recovery-sign-receipt",
    "recovery-sign-policy",
    "recovery-policy-digest",
    "recovery-rotate-session-key",
    "recovery-request",
  ]) {
    expect(isDefaultGatewayTrustExempt(["cloud", operation])).toBe(true);
    await runCommand(cloudCommand, { rawArgs: [operation] });
    expect(runRelayCommand).toHaveBeenLastCalledWith(operation, process.env);
  }
  expect(gatewayJson).not.toHaveBeenCalled();
});

test("pair flags select the component and approval name without modifying operator environment", async () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await runCommand(cloudCommand, {
    rawArgs: ["pair", "--kind", "collector", "--name", "Chosen collector"],
  });
  expect(runRelayCommand).toHaveBeenLastCalledWith(
    "pair-device",
    expect.objectContaining({
      OMNESIS_CLOUD_RELAY_DEVICE_KIND: "collector",
      OMNESIS_CLOUD_RELAY_DEVICE_NAME: "Chosen collector",
    }),
  );
  await runCloudIdentityCommand("pair-device", { name: "Named CLI" });
  expect(runRelayCommand).toHaveBeenLastCalledWith(
    "pair-device",
    expect.objectContaining({ OMNESIS_CLOUD_RELAY_DEVICE_NAME: "Named CLI" }),
  );
  await runCloudIdentityCommand("pair-device", { kind: "cli" });
  const before = runRelayCommand.mock.calls.length;
  for (const options of [{ kind: "phone" }, { name: " " }, { name: "x".repeat(81) }])
    await expect(runCloudIdentityCommand("pair-device", options)).rejects.toThrow();
  expect(runRelayCommand).toHaveBeenCalledTimes(before);
  for (const code of ["GOOGLE_DESKTOP_UNAVAILABLE", "CLOUD_CLIENT_TOKEN_COLLISION"]) {
    runRelayCommand.mockRejectedValueOnce({ code, message: "sensitive-provider-detail" });
    await expect(runCloudIdentityCommand("pair-device")).rejects.not.toThrow(
      "sensitive-provider-detail",
    );
  }
  runRelayCommand.mockRejectedValueOnce(null);
  await expect(runCloudIdentityCommand("pair-device")).rejects.toThrow("Cloud registration");
  runRelayCommand.mockRejectedValueOnce({ code: "UNKNOWN" });
  await expect(runCloudIdentityCommand("pair-device")).rejects.toThrow("Cloud registration");
});
