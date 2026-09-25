// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    gatewayJson: vi.fn(),
    withSpinner: (_label: string, operation: () => unknown) => operation(),
    buildCliFx: vi.fn().mockResolvedValue({}),
    iconFor: () => "",
  };
});

import { gatewayJson } from "../utils.js";
import { sourcesListCommand } from "./sources.js";

function run(): Promise<void> {
  return (sourcesListCommand as { run: () => Promise<void> }).run();
}

describe("sources list", () => {
  let logged: string[];
  let registered: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2030-01-01T12:00:00.000Z"));
    vi.clearAllMocks();
    logged = [];
    registered = [
      {
        id: "notes-synth:local",
        type: "notes-synth",
        accountId: "local",
        deviceId: "dev-laptop",
        enabled: true,
        members: ["dev-laptop", "dev-mini"],
        multiDeviceMode: "replicated",
        leaseHolder: null,
        pushBased: false,
      },
    ];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logged.push(line);
    });
    (gatewayJson as Mock).mockImplementation((path: string): Promise<unknown> => {
      switch (path) {
        case "/admin/sources":
          return Promise.resolve({ items: registered });
        case "/admin/devices":
          return Promise.resolve({
            items: [
              {
                id: "dev-laptop",
                name: "Maya-Laptop",
                kind: "collector",
                online: true,
              },
              { id: "dev-mini", name: "Studio-Mini", kind: "collector", online: false },
            ],
          });
        case "/admin/sync/status":
          return Promise.resolve({
            items: [
              {
                sourceId: "notes-synth:local",
                state: "synced",
                members: [
                  {
                    sourceId: "notes-synth:local",
                    deviceId: "dev-laptop",
                    state: "synced",
                    lastSyncAt: "2030-01-01T11:55:00.000Z",
                  },
                  {
                    sourceId: "notes-synth:local",
                    deviceId: "dev-mini",
                    state: "synced",
                    lastSyncAt: "2030-01-01T11:00:00.000Z",
                  },
                ],
              },
            ],
          });
        default:
          return Promise.reject(new Error(`unexpected path ${path}`));
      }
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("shows a multi-device source's mode, every member and each sync age", async () => {
    await run();

    expect((gatewayJson as Mock).mock.calls.map(([path]) => path)).toEqual([
      "/admin/sources",
      "/admin/devices",
      "/admin/sync/status",
    ]);
    const output = logged.join("\n");
    expect(output).toContain("notes-synth:local");
    expect(output).toContain("(replicated)");
    expect(output).toContain("Maya-Laptop");
    expect(output).toContain("synced 5m ago");
    expect(output).toContain("Studio-Mini");
    expect(output).toContain("synced 1h ago");
  });

  test("lists an exclusive source returned by a gateway that predates membership fields", async () => {
    registered = [
      {
        id: "notes-synth:legacy",
        type: "notes-synth",
        accountId: "legacy",
        deviceId: "dev-laptop",
        enabled: true,
        pushBased: false,
      },
    ];

    await run();

    const output = logged.join("\n");
    expect(output).toContain("notes-synth:legacy");
    expect(output).toContain("Maya-Laptop");
  });
});
