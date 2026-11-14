// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invocation: vi.fn(), run: vi.fn(), sync: vi.fn() }));
vi.mock("./windows-job.js", () => ({ windowsFilesystemInvocation: mocks.invocation }));
vi.mock("./windows-owned-process.js", () => ({
  runWindowsOwnedProcess: mocks.run,
  runWindowsOwnedProcessSync: mocks.sync,
}));
import {
  snapshotWindowsProcesses,
  snapshotWindowsProcessesSync,
  killWindowsProcesses,
  killWindowsProcessesSync,
} from "./windows-process.js";
const row = { pid: 123, parentPid: 12, birth: "638999999999999991" };
const success = () => ({
  exitCode: 0,
  signal: null,
  stdout: Buffer.from(JSON.stringify([row])),
  stderr: "",
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.invocation.mockReturnValue({ command: "native-worker.exe", args: ["filesystem"] });
  mocks.run.mockResolvedValue(success());
  mocks.sync.mockReturnValue(success());
});
function metadata(mock = mocks.run) {
  const frame = mock.mock.calls.at(-1)![1] as Buffer;
  expect(frame.readUInt32LE()).toBe(frame.length - 4);
  return JSON.parse(frame.subarray(4).toString("utf8"));
}
it("preserves exact 100 ns identity and sends only explicit metadata over framed stdin", async () => {
  expect(await snapshotWindowsProcesses([123])).toEqual([row]);
  expect(metadata()).toEqual({ action: "process-snapshot", roots: [123] });
  await killWindowsProcesses([{ ...row, privateCommand: "never serialize" } as typeof row]);
  expect(metadata()).toEqual({
    action: "process-kill",
    targets: [{ pid: row.pid, birth: row.birth }],
  });
  expect(mocks.run.mock.calls[0]![0].args).toEqual(["filesystem"]);
});
it("uses the same exact identity protocol for synchronous exit cleanup", () => {
  expect(snapshotWindowsProcessesSync([123])).toEqual([row]);
  expect(metadata(mocks.sync)).toEqual({ action: "process-snapshot", roots: [123] });
  killWindowsProcessesSync([row]);
  expect(metadata(mocks.sync)).toEqual({
    action: "process-kill",
    targets: [{ pid: 123, birth: row.birth }],
  });
});
it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER])(
  "refuses invalid PID %s before invoking native code",
  async (pid) => {
    await expect(snapshotWindowsProcesses([pid])).rejects.toThrow("Invalid owned");
    expect(mocks.invocation).not.toHaveBeenCalled();
  },
);
it.each(["-1", "9223372036854775808", "1.5", "1e9"])(
  "refuses invalid birth %s before invoking native code",
  async (birth) => {
    await expect(killWindowsProcesses([{ pid: 123, birth }])).rejects.toThrow("Invalid owned");
    expect(mocks.invocation).not.toHaveBeenCalled();
  },
);
it.each([
  { ...row, birth: Number(row.birth) },
  { ...row, command: "unexpected" },
  { ...row, parentPid: -1 },
])("rejects malformed native identity output %#", async (invalid) => {
  mocks.run.mockResolvedValue({ ...success(), stdout: Buffer.from(JSON.stringify([invalid])) });
  await expect(snapshotWindowsProcesses([123])).rejects.toThrow("Invalid Windows process identity");
});
it("reports a bounded native error without exposing arbitrary worker output", async () => {
  mocks.run.mockResolvedValue({
    ...success(),
    exitCode: 1,
    stderr: "private text EPRIVATE:process-snapshot:5 more private text",
  });
  await expect(snapshotWindowsProcesses([123])).rejects.toThrow(
    /^Owned Windows process operation EPRIVATE:process-snapshot:5$/,
  );
});

it("does not bootstrap or launch native code for empty ownership sets", async () => {
  expect(await snapshotWindowsProcesses([])).toEqual([]);
  expect(snapshotWindowsProcessesSync([])).toEqual([]);
  await killWindowsProcesses([]);
  killWindowsProcessesSync([]);
  expect(mocks.invocation).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.sync).not.toHaveBeenCalled();
});
