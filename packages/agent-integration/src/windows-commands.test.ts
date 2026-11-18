// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { beforeEach, expect, it, vi } from "vitest";
import type { WindowsCommandOptions, WindowsCommandProcess } from "./windows-commands.js";

const runtime = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./windows-files.js", () => ({ loadWindowsPlatformRuntime: runtime.load }));

beforeEach(() => {
  vi.resetModules();
  runtime.load.mockReset();
});

const options: WindowsCommandOptions = { env: {}, completion: "root", startupTimeoutMs: 30_000 };

it.each([undefined, 0, "1"])(
  "refuses an archive without joined-control ABI before spawning (%s)",
  async (protocol) => {
    const spawn = vi.fn();
    runtime.load.mockReturnValue({
      WINDOWS_JOB_CONTROL_PROTOCOL: protocol,
      spawnWindowsJob: spawn,
    });
    const { spawnWindowsIntegrationCommand } = await import("./windows-commands.js");
    expect(() => spawnWindowsIntegrationCommand("invented.exe", [], options)).toThrow(
      /invalid private process runtime/u,
    );
    expect(spawn).not.toHaveBeenCalled();
  },
);

it("forwards literal argv only after validating a canonical joined transport and reuses its loader", async () => {
  const child = {
    jobReady: Promise.resolve(),
    jobClosed: Promise.resolve(),
  } as unknown as WindowsCommandProcess;
  const spawn = vi.fn(() => child);
  runtime.load.mockReturnValue({ WINDOWS_JOB_CONTROL_PROTOCOL: 1, spawnWindowsJob: spawn });
  const { spawnWindowsIntegrationCommand } = await import("./windows-commands.js");
  const args = ["literal & $() argument", "tail\\", ""];
  expect(spawnWindowsIntegrationCommand("invented.exe", args, options)).toBe(child);
  expect(spawnWindowsIntegrationCommand("invented.exe", [], options)).toBe(child);
  expect(spawn).toHaveBeenNthCalledWith(1, "invented.exe", args, options);
  expect(runtime.load).toHaveBeenCalledExactlyOnceWith("windows-job");
});
