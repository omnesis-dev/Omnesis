// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("./windows-worker-cache.js", () => ({
  windowsWorkerInvocation: () => ({
    command: "C:\\Windows\\native-worker.exe",
    args: ["filesystem"],
  }),
}));
vi.mock("./windows-owned-process.js", async (original) => ({
  ...(await original<typeof import("./windows-owned-process.js")>()),
  runWindowsOwnedProcess: mocks.run,
}));
import { readWindowsRegularFilePrefix } from "./windows-private-file.js";

function frame(size: bigint, bytes = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8);
  header.writeBigUInt64LE(size);
  return Buffer.concat([header, bytes]);
}
beforeEach(() => {
  vi.stubEnv("SystemRoot", "C:\\Windows");
  mocks.run
    .mockReset()
    .mockResolvedValue({ exitCode: 0, signal: null, stdout: frame(0n), stderr: "" });
});
afterEach(() => vi.unstubAllEnvs());

test("source prefixes preserve binary bytes and exact large file sizes without using secret ACL rules", async () => {
  const size = 9007199254740993n;
  const bytes = Buffer.from([0, 255, 10]);
  mocks.run.mockResolvedValue({
    exitCode: 0,
    signal: null,
    stdout: frame(size, bytes),
    stderr: "",
  });
  expect(await readWindowsRegularFilePrefix("C:\\example\\literal [$&].eml", 3)).toEqual({
    bytes,
    size,
  });
  const input = mocks.run.mock.calls[0]![1] as Buffer;
  const length = input.readUInt32LE();
  expect(JSON.parse(input.subarray(4, length + 4).toString("utf8"))).toEqual({
    action: "regular-prefix",
    path: "C:\\example\\literal [$&].eml",
    limit: 3,
  });
});

test("full supported messages retain their existing 32 MiB limit", async () => {
  expect(await readWindowsRegularFilePrefix("C:\\example\\message", 32 * 1024 * 1024)).toEqual({
    bytes: Buffer.alloc(0),
    size: 0n,
  });
});

test.each([-1, 0.5, NaN, Infinity, 32 * 1024 * 1024 + 1])(
  "rejects invalid prefix size %s before a native launch",
  async (limit) => {
    await expect(readWindowsRegularFilePrefix("C:\\example\\message", limit)).rejects.toThrow(
      "prefix limit",
    );
    expect(mocks.run).not.toHaveBeenCalled();
  },
);

test.each([
  Buffer.alloc(7),
  frame(0n, Buffer.from("x")),
  frame(10n, Buffer.alloc(4)),
  frame(0xffffffffffffffffn),
])("rejects an inconsistent native response %j", async (stdout) => {
  mocks.run.mockResolvedValue({ exitCode: 0, signal: null, stdout, stderr: "" });
  await expect(readWindowsRegularFilePrefix("C:\\example\\message", 3)).rejects.toThrow(
    "prefix response",
  );
});

test.each([
  [5, "EACCES"],
  [32, "EACCES"],
  [2, "ENOENT"],
])("failed native read %s cannot return captured bytes", async (nativeCode, code) => {
  mocks.run.mockResolvedValue({
    exitCode: 1,
    signal: null,
    stdout: frame(3n, Buffer.from("bad")),
    stderr: `${nativeCode === 2 ? "ENOENT" : "EPRIVATE"}:regular-leaf:${nativeCode}`,
  });
  await expect(readWindowsRegularFilePrefix("C:\\example\\message", 3)).rejects.toMatchObject({
    code,
  });
});
