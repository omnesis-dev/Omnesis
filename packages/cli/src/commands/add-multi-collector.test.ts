// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseSourceKey } from "@omnesis/core";
import type { SerializedDescriptor } from "../utils.js";
import type { UnionDescriptor } from "../device-picker.js";

const mocks = vi.hoisted(() => ({
  fetchDescriptors: vi.fn(),
  fetchSourcesSnapshot: vi.fn(),
  gatewayJson: vi.fn(),
  pickDeviceForDescriptor: vi.fn(),
}));

vi.mock("../device-picker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../device-picker.js")>()),
  pickDeviceForDescriptor: mocks.pickDeviceForDescriptor,
}));

vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  fetchDescriptors: mocks.fetchDescriptors,
  fetchSourcesSnapshot: mocks.fetchSourcesSnapshot,
  gatewayJson: mocks.gatewayJson,
  withSpinner: (_label: string, operation: (spin: { message(value: string): void }) => unknown) =>
    operation({ message: () => undefined }),
}));

function descriptor(id: string, name: string): SerializedDescriptor {
  return {
    id,
    name,
    description: `${name} source`,
    provider: { id: "google", name: "Google" },
    authType: "none",
    unitName: "items",
    hasAuthFlow: false,
    hasDiscover: false,
  } as unknown as SerializedDescriptor;
}

describe("multi-collector source add", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    mocks.pickDeviceForDescriptor.mockResolvedValue({ id: "device-1", name: "Local" });
    const items = [descriptor("gmail", "Gmail"), descriptor("google-calendar", "Calendar")];
    mocks.fetchDescriptors.mockResolvedValue({
      deviceId: "device-1",
      collectorHostname: "local.example",
      items,
    });
    mocks.fetchSourcesSnapshot.mockResolvedValue({ configured: {} });
    mocks.gatewayJson.mockResolvedValue({ sourceIds: ["gmail:local"] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("keeps the descriptor selected from a provider alias after choosing its device", async () => {
    const select = vi.fn().mockResolvedValueOnce("gmail").mockResolvedValueOnce("google-calendar");
    const prompts = {
      select,
      isCancel: () => false,
      cancel: () => undefined,
    } as unknown as typeof import("@clack/prompts");
    const { runMultiCollectorAddFlow } = await import("./add.js");
    const union = [
      { ...descriptor("gmail", "Gmail"), devices: [{ id: "device-1", name: "Local" }] },
      {
        ...descriptor("google-calendar", "Calendar"),
        devices: [{ id: "device-1", name: "Local" }],
      },
    ] as unknown as UnionDescriptor[];

    await runMultiCollectorAddFlow(union, { sources: [], devices: [] }, "google", undefined, {
      prompts,
      resolve,
      join,
      parseSourceKey,
      joinConfirmation: "assume-yes",
    });

    expect(select).toHaveBeenCalledTimes(1);
    const addCall = mocks.gatewayJson.mock.calls.find(([path]) => path === "/admin/sources/add");
    expect(JSON.parse(String(addCall?.[1]?.body))).toMatchObject({ descriptorId: "gmail" });
  });
});
