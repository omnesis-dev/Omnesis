// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  closeSync,
  openSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runWindowsJob } from "./windows-job.js";
import { windowsPowerShellExecutable } from "./windows-powershell.js";
import {
  createWindowsPrivateFile,
  secureWindowsPrivatePathSync,
  readWindowsPrivateFile,
  readWindowsPrivateFileSync,
  readWindowsRegularFilePrefix,
} from "./windows-private-file.js";

test.runIf(process.platform === "win32")(
  "held-parent native reads preserve source ACLs and refuse junctions, directories and alternate streams",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "regular-source-read-"));
    try {
      const folder = join(root, "mail");
      mkdirSync(folder);
      const file = join(folder, "invented [$&] 雪.eml");
      const bytes = Buffer.from([0, 255, 10, 13, 65]);
      // A source file need not have the product's protected secret-file DACL.
      writeFileSync(file, bytes);
      for (const limit of [0, 3, 32 * 1024 * 1024, 64 * 1024 * 1024]) {
        expect(await readWindowsRegularFilePrefix(file, limit)).toEqual({
          bytes: bytes.subarray(0, limit),
          size: BigInt(bytes.length),
        });
      }
      expect(readFileSync(file)).toEqual(bytes);
      symlinkSync(folder, join(root, "alias"), "junction");
      await expect(
        readWindowsRegularFilePrefix(join(root, "alias", "invented [$&] 雪.eml"), 3),
      ).rejects.toThrow();
      await expect(readWindowsRegularFilePrefix(folder, 3)).rejects.toThrow();
      writeFileSync(`${file}:invented-stream`, "invented excluded stream");
      await expect(readWindowsRegularFilePrefix(`${file}:invented-stream`, 3)).rejects.toThrow();
      await expect(readWindowsRegularFilePrefix(join(folder, "missing"), 3)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  45_000,
);

// Mark the owned file sparse before growing it so the fixture writes only its small prefix.
// https://learn.microsoft.com/windows/win32/api/winioctl/ni-winioctl-fsctl_set_sparse
const sparseFixture = String.raw`
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class OmnesisReadBoundSparse {
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DeviceIoControl(SafeFileHandle file,uint code,IntPtr input,uint inputLength,IntPtr output,uint outputLength,out uint returned,IntPtr overlap);
  public static void Create(string path,long length) {
    using(FileStream file=new FileStream(path,FileMode.Open,FileAccess.ReadWrite,FileShare.ReadWrite|FileShare.Delete)) {
      uint returned;
      if(!DeviceIoControl(file.SafeFileHandle,0x900C4U,IntPtr.Zero,0U,IntPtr.Zero,0U,out returned,IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
      file.SetLength(length);file.Flush(true);
    }
    if((File.GetAttributes(path)&FileAttributes.SparseFile)==0) throw new InvalidDataException();
  }
}
`;

test.runIf(process.platform === "win32")(
  "explicit 64 MiB native reads handle a valid sparse file and preserve smaller whole-file limits",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "read-bound-sparse-")),
      file = join(root, "invented-registry.json"),
      maximum = 64 * 1024 * 1024;
    const marker = Buffer.from([0, 255, 65]);
    try {
      secureWindowsPrivatePathSync(root, "directory");
      await createWindowsPrivateFile(file, marker);
      const sparse = await runWindowsJob(
        windowsPowerShellExecutable(),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference='Stop';$source=[Console]::In.ReadToEnd();Add-Type -TypeDefinition $source;[OmnesisReadBoundSparse]::Create($env:OMNESIS_BOUND_FILE,[long]$env:OMNESIS_BOUND_LENGTH);",
        ],
        {
          env: { ...process.env, OMNESIS_BOUND_FILE: file, OMNESIS_BOUND_LENGTH: String(maximum) },
          input: Buffer.from(sparseFixture),
          timeoutMs: 30_000,
        },
      );
      expect(sparse.failure, sparse.stderr).toBeUndefined();
      expect(Object.hasOwn(sparse, "cleanupFailure")).toBe(false);
      expect(sparse.exitCode, sparse.stderr).toBe(0);
      const check = (bytes: Buffer) => {
        expect(bytes).toHaveLength(maximum);
        expect(bytes.subarray(0, marker.length)).toEqual(marker);
        expect(bytes[maximum - 1]).toBe(0);
      };
      check(await readWindowsPrivateFile(file, maximum));
      check(readWindowsPrivateFileSync(file, maximum));
      const regular = await readWindowsRegularFilePrefix(file, maximum);
      check(regular.bytes);
      expect(regular.size).toBe(BigInt(maximum));
      await expect(readWindowsPrivateFile(file)).rejects.toMatchObject({ code: "EPRIVATE" });
      const descriptor = openSync(file, "r+");
      try {
        ftruncateSync(descriptor, maximum + 1);
      } finally {
        closeSync(descriptor);
      }
      const refused = await readWindowsPrivateFile(file, maximum).catch((error: unknown) => error);
      expect(refused).toMatchObject({ code: "EPRIVATE", stage: "validate" });
      if (refused === null || typeof refused !== "object")
        throw new Error("Expected native read bound refusal");
      expect(Object.hasOwn(refused, "cleanupFailure")).toBe(false);
      expect(() => readWindowsPrivateFileSync(file, maximum)).toThrow();
      expect(await readWindowsRegularFilePrefix(file, 0)).toEqual({
        bytes: Buffer.alloc(0),
        size: BigInt(maximum + 1),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  45_000,
);
