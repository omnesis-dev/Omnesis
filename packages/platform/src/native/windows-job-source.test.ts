// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { runWindowsOwnedProcessSync } from "../windows-owned-process.js";
import { windowsPowerShellExecutable } from "../windows-powershell.js";
import { WINDOWS_JOB_NATIVE_SOURCE, WINDOWS_JOB_POWERSHELL_SCRIPT } from "./windows-job-source.js";

describe("uncached Windows job bootstrap", () => {
  it("embeds the complete public native source in a lossless compressed bootstrap", () => {
    const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/u.exec(
      WINDOWS_JOB_POWERSHELL_SCRIPT,
    )?.[1];
    expect(encoded).toBeDefined();
    expect(gunzipSync(Buffer.from(encoded!, "base64")).toString("utf8")).toBe(
      WINDOWS_JOB_NATIVE_SOURCE,
    );
    expect(WINDOWS_JOB_POWERSHELL_SCRIPT).toContain("[IO.Compression.CompressionMode]::Decompress");
  });

  it("fits the Windows CreateProcess command line including executable, switches and NUL", () => {
    const executable = '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"';
    const encoded = Buffer.from(WINDOWS_JOB_POWERSHELL_SCRIPT, "utf16le").toString("base64");
    const commandLine = `${executable} -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}\0`;
    expect(commandLine.length).toBeLessThanOrEqual(32767);
  });
});

describe.runIf(process.platform === "win32")("raw PowerShell managed dispatch", () => {
  function run(
    args: string[],
    nonce?: string,
    command = process.execPath,
    input = Buffer.from([0, 255, 42]),
    env?: NodeJS.ProcessEnv,
  ) {
    const body = Buffer.from(
      JSON.stringify({
        command,
        args,
        parentPid: process.pid,
        ...(nonce ? { syncReceipt: nonce } : {}),
      }),
    );
    const length = Buffer.alloc(4);
    length.writeUInt32LE(body.length);
    return runWindowsOwnedProcessSync(
      {
        command: windowsPowerShellExecutable(),
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(WINDOWS_JOB_POWERSHELL_SCRIPT, "utf16le").toString("base64"),
        ],
      },
      Buffer.concat([length, body]),
      { input, timeoutMs: 30_000, ...(env ? { env } : {}) },
      nonce ? { nonce } : undefined,
    );
  }

  it("joins a target under a restricted host environment without a module discovery path", () => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      "PATH",
      "HOME",
      "SystemRoot",
      "WINDIR",
      "USERPROFILE",
      "LOCALAPPDATA",
      "TEMP",
      "TMP",
    ])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    const result = run(
      ["-e", 'process.stdout.write("trusted bootstrap")'],
      randomBytes(32).toString("hex"),
      process.execPath,
      Buffer.alloc(0),
      env,
    );
    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      stdout: Buffer.from("trusted bootstrap"),
      stderr: "",
    });
    expect(Object.hasOwn(result, "cleanupFailure")).toBe(false);
  }, 35_000);

  it.each([0, 7, 126, 127])(
    "preserves literal binary streams and joined target status %s without managed-null coercion",
    (status) => {
      const nonce = randomBytes(32).toString("hex");
      const result = run(
        [
          "-e",
          'const fs=require("node:fs");fs.writeSync(1,fs.readFileSync(0));fs.writeSync(2,process.argv[1]);process.exit(Number(process.argv[2]));',
          'literal & "quoted" argument',
          String(status),
        ],
        nonce,
      );
      expect(result).toEqual({
        exitCode: status,
        signal: null,
        stdout: Buffer.from([0, 255, 42]),
        stderr: 'literal & "quoted" argument',
      });
      expect(Object.hasOwn(result, "cleanupFailure")).toBe(false);
    },
    35_000,
  );

  it("retains the legacy no-receipt dispatch without passing PowerShell null strings", () => {
    const result = run([
      "-e",
      'require("node:fs").readFileSync(0);process.stdout.write("legacy target");process.exit(7)',
    ]);
    expect(result).toEqual({
      exitCode: 7,
      signal: null,
      stdout: Buffer.from("legacy target"),
      stderr: "",
    });
    expect(Object.hasOwn(result, "cleanupFailure")).toBe(false);
  }, 35_000);

  it("confirms an empty joined Job when native target creation is refused", () => {
    const result = run(
      [],
      randomBytes(32).toString("hex"),
      `${process.execPath}.missing`,
      Buffer.alloc(128 * 1024),
    );
    expect(result.failure).toBe("spawn");
    expect(result.failureMessage).toMatch(/ENOENT|EOF|EPIPE/u);
    expect(result.stdout).toEqual(Buffer.alloc(0));
    expect(result.stderr).toBe("");
    expect(Object.hasOwn(result, "cleanupFailure")).toBe(false);
  }, 35_000);
});
