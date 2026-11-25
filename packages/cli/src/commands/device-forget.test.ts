// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  gatewayJson: vi.fn(),
  gatewayFetch: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("../utils.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  gatewayJson: mocks.gatewayJson,
  gatewayFetch: mocks.gatewayFetch,
  withSpinner: async (_message: string, action: () => unknown) => action(),
}));
vi.mock("@clack/prompts", () => ({
  select: mocks.select,
  confirm: mocks.confirm,
  isCancel: (v: unknown) => typeof v === "symbol",
}));
import { deviceForgetPath, forgetDeviceFromCli } from "./device-forget.js";

beforeEach(() => {
  mocks.gatewayJson.mockReset().mockResolvedValue({
    sources: [{ id: "fictional:local", deleteScope: "partition" }],
    fingerprint: "reviewed",
  });
  mocks.gatewayFetch.mockReset().mockResolvedValue(new Response("{}"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

test("encodes the device id and explicit reviewed choice", () => {
  expect(deviceForgetPath("phone/old", "delete", "hash&value")).toBe(
    "/admin/devices/phone%2Fold?forget=true&data=delete&impactFingerprint=hash%26value",
  );
});
test("unattended confirmation keeps historical data by default", async () => {
  await forgetDeviceFromCli("old", "Old phone", { yes: true });
  expect(mocks.gatewayFetch).toHaveBeenCalledExactlyOnceWith(
    "/admin/devices/old?forget=true&data=keep&impactFingerprint=reviewed",
    { method: "DELETE" },
  );
});
test("explicit deletion submits only the reviewed device", async () => {
  await forgetDeviceFromCli("old", "Old phone", { yes: true, data: "delete" });
  expect(mocks.gatewayFetch).toHaveBeenCalledExactlyOnceWith(
    "/admin/devices/old?forget=true&data=delete&impactFingerprint=reviewed",
    { method: "DELETE" },
  );
});
test("unknown disposition fails before fetching or deleting", async () => {
  await expect(
    forgetDeviceFromCli("old", "Old phone", { data: "unknown", yes: true }),
  ).rejects.toThrow("--data must be keep or delete");
  expect(mocks.gatewayJson).not.toHaveBeenCalled();
  expect(mocks.gatewayFetch).not.toHaveBeenCalled();
});
test("a stale review is refused without automatically repeating deletion", async () => {
  mocks.gatewayFetch.mockResolvedValue(new Response("{}", { status: 409 }));
  await expect(
    forgetDeviceFromCli("old", "Old phone", { yes: true, data: "delete" }),
  ).rejects.toThrow("sources changed");
  expect(mocks.gatewayFetch).toHaveBeenCalledTimes(1);
});

async function withInteractiveTerminal(action: () => Promise<void>): Promise<void> {
  const input = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const output = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  try {
    await action();
  } finally {
    if (input) Object.defineProperty(process.stdin, "isTTY", input);
    else Reflect.deleteProperty(process.stdin, "isTTY");
    if (output) Object.defineProperty(process.stdout, "isTTY", output);
    else Reflect.deleteProperty(process.stdout, "isTTY");
  }
}

test("interactive forgetting starts with keep history and confirms that choice", async () => {
  mocks.select.mockReset().mockResolvedValue("keep");
  mocks.confirm.mockReset().mockResolvedValue(true);
  await withInteractiveTerminal(async () => {
    await forgetDeviceFromCli("old", "Old phone", {});
  });
  expect(mocks.select).toHaveBeenCalledWith(expect.objectContaining({ initialValue: "keep" }));
  expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
  expect(mocks.gatewayFetch).toHaveBeenCalledExactlyOnceWith(
    "/admin/devices/old?forget=true&data=keep&impactFingerprint=reviewed",
    { method: "DELETE" },
  );
});

test("cancelling an interactive deletion never sends DELETE", async () => {
  mocks.select.mockReset().mockResolvedValue("delete");
  mocks.confirm.mockReset().mockResolvedValue(false);
  await withInteractiveTerminal(async () => {
    await expect(forgetDeviceFromCli("old", "Old phone", {})).rejects.toThrow("Cancelled");
  });
  expect(mocks.confirm).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining("cannot be undone") }),
  );
  expect(mocks.gatewayFetch).not.toHaveBeenCalled();
});
