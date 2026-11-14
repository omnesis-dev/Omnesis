// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn(), workerInvocation: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
  spawnSync: mocks.spawnSync,
}));
vi.mock("./windows-worker-cache.js", () => ({ windowsWorkerInvocation: mocks.workerInvocation }));
import {
  copyWindowsPrivateFileSync,
  createWindowsPrivateFileSync,
  readWindowsPrivateFileSync,
  readWindowsPrivateFileContentsSync,
  deleteWindowsPrivateFileExactSync,
  inspectWindowsPrivatePathSync,
  secureWindowsPrivatePathSync,
  writeWindowsPrivateFileAtomicSync,
} from "./windows-private-file.js";

beforeEach(() => {
  vi.stubEnv("SystemRoot", "C:\\Windows");
  mocks.workerInvocation.mockReset().mockImplementation((mode: string) => ({
    command: "C:\\Windows\\native-worker.exe",
    args: [mode],
  }));
  mocks.spawnSync.mockReset().mockReturnValue({
    status: 0,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from("OMNESIS_JOB:0\n"),
  });
});
afterEach(() => vi.unstubAllEnvs());
function frame(): { metadata: unknown; bytes: Buffer; command: string; args: string[] } {
  const options = mocks.spawnSync.mock.calls.at(-1)![2] as { input: Buffer };
  const length = options.input.readUInt32LE();
  return {
    metadata: JSON.parse(options.input.subarray(4, length + 4).toString("utf8")),
    bytes: options.input.subarray(length + 4),
    command: mocks.spawnSync.mock.calls.at(-1)![0] as string,
    args: mocks.spawnSync.mock.calls.at(-1)![1] as string[],
  };
}
describe("Windows private native protocol", () => {
  it("declares and frames arbitrary binary payloads larger than authority keys without shell interpolation", () => {
    const bytes = Buffer.alloc(96 * 1024, 255),
      path = "C:\\example folder\\literal & $().key";
    createWindowsPrivateFileSync(path, bytes);
    const run = frame();
    expect(run.metadata).toEqual({ action: "create", path, length: bytes.length, readOnly: false });
    expect(run.bytes.subarray(0, bytes.length)).toEqual(bytes);
    expect(run.bytes.subarray(bytes.length).toString("ascii")).toBe(
      "\0OMNESIS_PRIVATE_COMMIT_V1\0",
    );
    expect(run.args).not.toContain(path);
    expect(
      run.command.length + 3 + run.args.reduce((size, arg) => size + arg.length + 3, 0),
    ).toBeLessThanOrEqual(32767);
  });
  it("copies literal paths natively without transferring file contents through JavaScript", () => {
    const source = "C:\\example folder\\literal & $().db";
    const destination = "C:\\example folder\\private backup.db";
    copyWindowsPrivateFileSync(source, destination);
    const request = frame();
    expect(request.metadata).toEqual({ action: "copy-private", path: destination, source });
    expect(request.bytes).toEqual(Buffer.alloc(0));
    expect(request.args).not.toContain(source);
    expect(request.args).not.toContain(destination);
    expect(mocks.spawnSync.mock.calls.at(-1)![2].timeout).toBeUndefined();
    const calls = mocks.spawnSync.mock.calls.length;
    expect(() => copyWindowsPrivateFileSync(source, source)).toThrow("must differ");
    expect(() => copyWindowsPrivateFileSync(source + "\0", destination)).toThrow(
      "Invalid private file path",
    );
    expect(mocks.spawnSync).toHaveBeenCalledTimes(calls);
  });
  it("keeps synchronous credential reads bounded inside the native request", () => {
    const path = "C:\\Example\\pairing.json";
    expect(readWindowsPrivateFileSync(path, 65536)).toEqual(Buffer.alloc(0));
    expect(frame().metadata).toEqual({ action: "read", path, limit: 65536 });
    const calls = mocks.spawnSync.mock.calls.length;
    for (const limit of [-1, Infinity, 16 * 1024 * 1024 + 1])
      expect(() => readWindowsPrivateFileSync(path, limit)).toThrow("read bound");
    expect(mocks.spawnSync).toHaveBeenCalledTimes(calls);
  });
  it("publishes atomic/read-only intent inside the metadata frame", () => {
    writeWindowsPrivateFileAtomicSync("C:\\Example\\private.json", Buffer.from("invented"), {
      readOnly: true,
    });
    expect(frame().metadata).toEqual({
      action: "atomic",
      path: "C:\\Example\\private.json",
      length: 8,
      readOnly: true,
    });
  });
  it("validates ordered inspection responses and fails closed on unsafe repair", () => {
    mocks.spawnSync.mockReturnValue({
      status: 0,
      signal: null,
      stdout: Buffer.from('[{"private":false,"fixed":false,"error":"EPRIVATE"}]'),
      stderr: Buffer.from("OMNESIS_JOB:0\n"),
    });
    expect(inspectWindowsPrivatePathSync("C:\\Example\\private", "directory")).toEqual({
      private: false,
      fixed: false,
      error: "EPRIVATE",
    });
    expect(frame().metadata).toEqual({
      action: "inspect",
      paths: [{ path: "C:\\Example\\private", kind: "directory" }],
      repair: false,
    });
    expect(() => secureWindowsPrivatePathSync("C:\\Example\\private", "directory")).toThrow(
      "trusted Windows owner",
    );
    expect(frame().metadata).toEqual({
      action: "inspect",
      paths: [{ path: "C:\\Example\\private", kind: "directory" }],
      repair: true,
      protect: true,
    });
    mocks.spawnSync.mockReturnValue({
      status: 0,
      signal: null,
      stdout: Buffer.from('[{"private":"yes","fixed":false}]'),
      stderr: Buffer.from("OMNESIS_JOB:0\n"),
    });
    expect(() => inspectWindowsPrivatePathSync("C:\\Example\\private", "file")).toThrow(
      "Invalid private file inspection",
    );
  });
  it("frames exact legacy key and service names for whole reads and held-handle deletes", () => {
    readWindowsPrivateFileContentsSync("C:\\example\\QSIg", {
      exactBasename: "QSIg",
      exactParentBasename: "example",
    });
    expect(frame().metadata).toEqual({
      action: "read",
      path: "C:\\example\\QSIg",
      limit: -1,
      exactBasename: "QSIg",
      exactParentBasename: "example",
    });
    deleteWindowsPrivateFileExactSync("C:\\example\\QSIg", {
      exactBasename: "QSIg",
      exactParentBasename: "example",
    });
    expect(frame().metadata).toEqual({
      action: "delete",
      path: "C:\\example\\QSIg",
      exactBasename: "QSIg",
      exactParentBasename: "example",
    });
  });
  it("exposes only fixed native stage and numeric error diagnostics", () => {
    mocks.spawnSync.mockReturnValue({
      status: 1,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("OMNESIS_JOB:0\nEPRIVATE:rename:87"),
    });
    expect(() =>
      writeWindowsPrivateFileAtomicSync("C:\\example\\key", Buffer.from("invented secret")),
    ).toThrow("rename; native error 87");
    try {
      writeWindowsPrivateFileAtomicSync("C:\\example\\key", Buffer.from("invented secret"));
    } catch (error) {
      expect(error).toMatchObject({ code: "EPRIVATE", stage: "rename", nativeCode: 87 });
    }
  });
  it("preserves native publication and staging-cleanup failures together", () => {
    mocks.spawnSync.mockReturnValue({
      status: 1,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("OMNESIS_JOB:0\nOMNESIS_PRIVATE_CLEANUP_FAILED:32\nEEXIST:rename:183"),
    });
    let caught: unknown;
    try {
      writeWindowsPrivateFileAtomicSync("C:\\example\\key", Buffer.from("invented secret"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toMatchObject([
      { code: "EEXIST", stage: "rename", nativeCode: 183 },
      { code: "EPRIVATE", stage: "cleanup", nativeCode: 32 },
    ]);
    expect(String(caught)).not.toContain("invented secret");
    expect(String(caught)).not.toContain("example");
  });
  it("returns generic errors without secret material or private path content", () => {
    mocks.spawnSync.mockReturnValue({
      status: 1,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("OMNESIS_JOB:0\nEPRIVATE"),
    });
    let error: unknown;
    try {
      createWindowsPrivateFileSync(
        "C:\\Fictional-private-path\\key",
        Buffer.from("invented secret bytes"),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "EPRIVATE" });
    expect(String(error)).not.toContain("Fictional-private-path");
    expect(String(error)).not.toContain("invented secret bytes");
  });
});
