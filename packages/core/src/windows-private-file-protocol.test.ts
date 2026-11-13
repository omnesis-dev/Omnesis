// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
  spawnSync: mocks.spawnSync,
}));
import {
  createWindowsPrivateFileSync,
  inspectWindowsPrivatePathSync,
  secureWindowsPrivatePathSync,
  writeWindowsPrivateFileAtomicSync,
} from "./windows-private-file.js";

beforeEach(() => {
  vi.stubEnv("SystemRoot", "C:\\Windows");
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
  const outerLength = options.input.readUInt32LE();
  const outer = JSON.parse(options.input.subarray(4, outerLength + 4).toString("utf8")) as {
    command: string;
    args: string[];
  };
  const input = options.input.subarray(outerLength + 4),
    length = input.readUInt32LE();
  return {
    metadata: JSON.parse(input.subarray(4, length + 4).toString("utf8")),
    bytes: input.subarray(length + 4),
    ...outer,
  };
}
describe("Windows private native protocol", () => {
  it("declares and frames arbitrary binary payloads larger than authority keys without shell interpolation", () => {
    const bytes = Buffer.alloc(96 * 1024, 255),
      path = "C:\\example folder\\literal & $().key";
    createWindowsPrivateFileSync(path, bytes);
    const run = frame();
    expect(run.metadata).toEqual({ action: "create", path, length: bytes.length, readOnly: false });
    expect(run.bytes).toEqual(bytes);
    expect(run.args).not.toContain(path);
    expect(
      run.command.length + 3 + run.args.reduce((size, arg) => size + arg.length + 3, 0),
    ).toBeLessThanOrEqual(32767);
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
