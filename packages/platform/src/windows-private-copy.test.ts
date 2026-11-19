// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { beforeEach, expect, test, vi } from "vitest";
import type { WindowsJobResult } from "./windows-owned-process.js";

const owned = vi.hoisted(() => ({ run: vi.fn(), invocation: vi.fn() }));
vi.mock("./windows-owned-process.js", () => ({
  runWindowsOwnedProcess: owned.run,
  runWindowsOwnedProcessSync: vi.fn(),
}));
vi.mock("./windows-job.js", () => ({ windowsFilesystemInvocation: owned.invocation }));
import { copyWindowsPrivateFile } from "./windows-private-file.js";

beforeEach(() => {
  owned.run.mockReset();
  owned.invocation.mockReset().mockReturnValue({
    command: "C:\\Windows\\native-worker.exe",
    args: ["filesystem"],
  });
});

test("asynchronous private copy frames literal paths and waits for owned native completion", async () => {
  const completion = Promise.withResolvers<WindowsJobResult>();
  owned.run.mockReturnValue(completion.promise);
  const source = "C:\\invented folder\\literal & $().db";
  const destination = "C:\\private folder\\backup.db";
  let finished = false;
  const copy = copyWindowsPrivateFile(source, destination).then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  const [run, input, options] = owned.run.mock.calls[0]!;
  const length = input.readUInt32LE();
  expect(JSON.parse(input.subarray(4, length + 4).toString("utf8"))).toEqual({
    action: "copy-private",
    source,
    path: destination,
  });
  expect(input.length).toBe(length + 4);
  expect(run.args).not.toContain(source);
  expect(run.args).not.toContain(destination);
  expect(options.timeoutMs).toBeUndefined();
  completion.resolve({ exitCode: 0, signal: null, stdout: Buffer.alloc(0), stderr: "" });
  await copy;
  expect(finished).toBe(true);
});

test("asynchronous private copy reports native failure and refuses invalid paths before launch", async () => {
  const source = "C:\\invented\\source.db";
  const destination = "C:\\private\\backup.db";
  owned.run.mockResolvedValue({
    exitCode: 1,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: "EPRIVATE:copy-source:5\n",
  });
  await expect(copyWindowsPrivateFile(source, destination)).rejects.toMatchObject({
    code: "EPRIVATE",
    stage: "copy-source",
    nativeCode: 5,
  });
  owned.run.mockClear();
  await expect(copyWindowsPrivateFile(source, source)).rejects.toThrow("must differ");
  await expect(copyWindowsPrivateFile(source + "\0", destination)).rejects.toThrow(
    "Invalid private file path",
  );
  expect(owned.run).not.toHaveBeenCalled();
});
