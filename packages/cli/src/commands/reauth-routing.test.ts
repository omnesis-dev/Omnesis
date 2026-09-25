// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    fetchDescriptors: vi.fn(),
    fetchSourcesSnapshot: vi.fn(),
    gatewayJson: vi.fn(),
    withSpinner: (
      _label: string,
      operation: (spinner: { message: (message: string) => void }) => unknown,
    ) => operation({ message: () => undefined }),
  };
});

vi.mock("../auth-flow.js", () => ({ runAuthFlow: vi.fn() }));

import { runAuthFlow } from "../auth-flow.js";
import { fetchDescriptors, fetchSourcesSnapshot, gatewayJson } from "../utils.js";
import { reauthCommand } from "./reauth.js";

const sourceDescriptor = {
  id: "mail-synth",
  name: "mail-source",
  provider: { id: "mail-provider", name: "mail-provider" },
  hasAuthFlow: true,
};

const devices = [
  { id: "dev-alpha", name: "Alpha", kind: "collector", online: true },
  { id: "dev-beta", name: "Beta", kind: "collector", online: true },
  { id: "dev-gamma", name: "Gamma", kind: "collector", online: true },
];

function run(device?: string): Promise<void> {
  return (
    reauthCommand as unknown as {
      run(ctx: { args: { providerId: string; device?: string } }): Promise<void>;
    }
  ).run({ args: { providerId: "mail-provider:maya@example.org", device } });
}

describe("reauth member routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    (fetchDescriptors as Mock).mockImplementation((deviceId: string) =>
      Promise.resolve({
        deviceId,
        items: [sourceDescriptor],
        pageInfo: { hasMore: false, limit: 1 },
      }),
    );
    (fetchSourcesSnapshot as Mock).mockImplementation((deviceId: string) =>
      Promise.resolve({
        deviceId,
        configured: { "mail-synth:maya@example.org": { enabled: true } },
      }),
    );
    (runAuthFlow as Mock).mockResolvedValue("maya@example.org");
    (gatewayJson as Mock).mockImplementation((path: string) => {
      if (path === "/admin/devices") return Promise.resolve({ items: devices });
      if (path === "/admin/source-descriptors") {
        return Promise.resolve({
          items: [{ ...sourceDescriptor, devices: devices.slice(0, 2) }],
          pageInfo: { hasMore: false, limit: 1 },
        });
      }
      if (path === "/admin/sources") {
        return Promise.resolve({
          items: [
            {
              id: "mail-synth:maya@example.org",
              type: "mail-synth",
              accountId: "maya@example.org",
              deviceId: "dev-alpha",
              members: ["dev-alpha", "dev-beta"],
            },
          ],
        });
      }
      if (path === "/admin/sources/reauth-finalize") {
        return Promise.resolve({ sourceIds: ["mail-synth:maya@example.org"] });
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("the full member union is visible as an ambiguity before auth starts", async () => {
    await expect(run()).rejects.toThrow("Multiple devices host sources");
    expect(runAuthFlow).not.toHaveBeenCalled();
  });

  test("an explicit non-member is rejected before credentials are written", async () => {
    await expect(run("Gamma")).rejects.toThrow("does not host sources");
    expect(runAuthFlow).not.toHaveBeenCalled();
  });

  test("an explicit joined member drives both auth and finalize locally", async () => {
    await run("Beta");

    expect(runAuthFlow).toHaveBeenCalledWith(
      { deviceId: "dev-beta" },
      "mail-synth",
      {},
      expect.objectContaining({ accountId: "maya@example.org" }),
    );
    const finalize = (gatewayJson as Mock).mock.calls.find(
      ([path]) => path === "/admin/sources/reauth-finalize",
    );
    expect(JSON.parse(finalize?.[1]?.body as string)).toEqual({
      deviceId: "dev-beta",
      providerType: "mail-provider",
      accountId: "maya@example.org",
      sourceType: "mail-synth",
    });
  });
});
