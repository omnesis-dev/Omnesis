// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { WINDOWS_PRIVATE_FILE_NATIVE_SOURCE } from "./native/windows-private-file-source.js";
import { execWindowsJob } from "./windows-job-exec.js";
import { runWindowsJob } from "./windows-job.js";
import { windowsPowerShellExecutable } from "./windows-powershell.js";
import {
  createWindowsPrivateFile,
  inspectWindowsPrivatePaths,
  secureWindowsPrivatePathSync,
} from "./windows-private-file.js";

async function sddl(path: string): Promise<string> {
  const result = await execWindowsJob(
    windowsPowerShellExecutable(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$PSModuleAutoLoadingPreference='None';$s=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group;[Console]::Out.Write([IO.File]::GetAccessControl($env:OMNESIS_METADATA_FIXTURE,$s).GetSecurityDescriptorSddlForm($s));",
    ],
    { env: { ...process.env, OMNESIS_METADATA_FIXTURE: path }, timeout: 20_000 },
  );
  return result.stdout;
}
async function broaden(path: string): Promise<void> {
  await execWindowsJob(
    join(process.env.SystemRoot!, "System32", "icacls.exe"),
    [path, "/grant", "*S-1-1-0:(R)"],
    { timeout: 20_000 },
  );
}

const inspect = (path: string) =>
  inspectWindowsPrivatePaths([{ path, kind: "file" }], { repair: true, protect: true });

test.runIf(process.platform === "win32").each(["Zone.Identifier", "invented-empty"])(
  "unsafe repair refuses an existing %s stream without losing its data or changing the selected inode",
  async (streamName) => {
    const root = mkdtempSync(join(tmpdir(), "private-stream-metadata-"));
    const path = join(root, "selected-\u{1f9ed}.key");
    const stream = `${path}:${streamName}`;
    const bytes = Buffer.from("invented retained main stream");
    const marker =
      streamName === "Zone.Identifier"
        ? Buffer.from("[ZoneTransfer]\r\nZoneId=3\r\n")
        : Buffer.alloc(0);
    let descriptor: number | undefined;
    try {
      secureWindowsPrivatePathSync(root, "directory");
      await createWindowsPrivateFile(path, bytes);
      writeFileSync(stream, marker);
      const privateAcl = await sddl(path);
      descriptor = openSync(path, "r+");
      // Already-private files need no metadata rights, content pin or mutation.
      expect(await inspect(path)).toEqual([{ private: true, fixed: false }]);
      expect(await sddl(path)).toBe(privateAcl);
      closeSync(descriptor);
      descriptor = undefined;
      await execWindowsJob(
        join(process.env.SystemRoot!, "System32", "icacls.exe"),
        [path, "/inheritance:e"],
        { timeout: 20_000 },
      );
      expect(await inspect(path)).toEqual([{ private: true, fixed: true }]);
      await broaden(path);
      const originalAcl = await sddl(path);
      const original = statSync(path, { bigint: true });
      expect(await inspect(path)).toEqual([{ private: false, fixed: false, error: "EPRIVATE" }]);
      expect(await sddl(path)).toBe(originalAcl);
      expect(readFileSync(path)).toEqual(bytes);
      expect(readFileSync(stream)).toEqual(marker);
      const after = statSync(path, { bigint: true });
      expect(after.ino).toBe(original.ino);
      expect(after.mtimeNs).toBe(original.mtimeNs);
      expect(after.mode).toBe(original.mode);
      expect(readdirSync(root)).toEqual(["selected-\u{1f9ed}.key"]);
      // Removing metadata cannot make an unsafe DACL safe; refusal is unchanged.
      unlinkSync(stream);
      expect(readFileSync(path)).toEqual(bytes);
      expect(await inspect(path)).toEqual([{ private: false, fixed: false, error: "EPRIVATE" }]);
      expect(readFileSync(path)).toEqual(bytes);
      expect(statSync(path, { bigint: true }).ino).toBe(original.ino);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(root, { recursive: true, force: true });
    }
  },
  90_000,
);

const eaFixture = String.raw`
public static partial class OmnesisPrivateFile {
  [DllImport("ntdll.dll")] static extern int NtSetEaFile(SafeFileHandle file,out RenameIoStatus io,IntPtr data,uint length);
  [DllImport("ntdll.dll")] static extern int NtQueryEaFile(SafeFileHandle file,out RenameIoStatus io,IntPtr data,uint length,[MarshalAs(UnmanagedType.U1)]bool single,IntPtr list,uint listLength,IntPtr index,[MarshalAs(UnmanagedType.U1)]bool restart);
  public static string FixtureEa(string path,string operation) {
    using(PinnedParent parent=Parent(path))
    using(SafeFileHandle file=RelativeOpen(parent.Handle,parent.Leaf,false,0x120098U,7U)) {
      byte[] name=Encoding.ASCII.GetBytes("OMNESIS_TEST_META");
      if(operation=="set" || operation=="clear") {
        byte[] value=operation=="set"?Encoding.ASCII.GetBytes("invented retained EA"):new byte[0];
        byte[] record=new byte[8+name.Length+1+value.Length];record[5]=(byte)name.Length;
        Buffer.BlockCopy(BitConverter.GetBytes((ushort)value.Length),0,record,6,2);
        Buffer.BlockCopy(name,0,record,8,name.Length);Buffer.BlockCopy(value,0,record,9+name.Length,value.Length);
        IntPtr buffer=Marshal.AllocHGlobal(record.Length);
        try {
          Marshal.Copy(record,0,buffer,record.Length);RenameIoStatus io;
          int status=NtSetEaFile(file,out io,buffer,(uint)record.Length);
          if(status!=0) return "unavailable:"+RtlNtStatusToDosError(status);
          return "written";
        } finally {Marshal.FreeHGlobal(buffer);}
      }
      if(operation!="read") throw new InvalidDataException();
      IntPtr data=Marshal.AllocHGlobal(4096);
      try {
        RenameIoStatus io;int status=NtQueryEaFile(file,out io,data,4096U,true,IntPtr.Zero,0U,IntPtr.Zero,true);
        if(status!=0) throw new Win32Exception((int)RtlNtStatusToDosError(status));
        ulong length=io.information.ToUInt64();
        if(length<8 || length>4096 || Marshal.ReadInt32(data)!=0) throw new InvalidDataException();
        int nameLength=Marshal.ReadByte(data,5),valueLength=(ushort)Marshal.ReadInt16(data,6);
        if(nameLength!=name.Length || 9+nameLength+valueLength>(long)length) throw new InvalidDataException();
        byte[] actualName=new byte[nameLength],value=new byte[valueLength];
        Marshal.Copy(IntPtr.Add(data,8),actualName,0,nameLength);
        if(Encoding.ASCII.GetString(actualName)!="OMNESIS_TEST_META") throw new InvalidDataException();
        Marshal.Copy(IntPtr.Add(data,9+nameLength),value,0,valueLength);
        return Convert.ToBase64String(value);
      } finally {Marshal.FreeHGlobal(data);}
    }
  }
}
`;
async function ea(path: string, operation: "set" | "clear" | "read"): Promise<string> {
  const result = await runWindowsJob(
    windowsPowerShellExecutable(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop';$source=[Console]::In.ReadToEnd();Add-Type -TypeDefinition $source;[Console]::Out.Write([OmnesisPrivateFile]::FixtureEa($env:OMNESIS_METADATA_FIXTURE,$env:OMNESIS_METADATA_OPERATION));",
    ],
    {
      env: {
        ...process.env,
        OMNESIS_METADATA_FIXTURE: path,
        OMNESIS_METADATA_OPERATION: operation,
      },
      input: Buffer.from(WINDOWS_PRIVATE_FILE_NATIVE_SOURCE + eaFixture),
      timeoutMs: 60_000,
    },
  );
  expect(result.failure, result.stderr).toBeUndefined();
  expect(result.exitCode, result.stderr).toBe(0);
  return Buffer.from(result.stdout).toString("utf8");
}

test.runIf(process.platform === "win32")(
  "unsafe repair refuses an owned NTFS extended attribute without dropping its value or changing the file",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "private-ea-metadata-"));
    const path = join(root, "selected.key");
    const bytes = Buffer.from("invented retained EA base file");
    let descriptor: number | undefined;
    try {
      secureWindowsPrivatePathSync(root, "directory");
      await createWindowsPrivateFile(path, bytes);
      expect(await ea(path, "set"), "Owned NTFS extended-attribute capability is required").toBe(
        "written",
      );
      const originalValue = await ea(path, "read");
      expect(Buffer.from(originalValue, "base64").toString()).toBe("invented retained EA");
      descriptor = openSync(path, "r+");
      expect(await inspect(path)).toEqual([{ private: true, fixed: false }]);
      closeSync(descriptor);
      descriptor = undefined;
      await execWindowsJob(
        join(process.env.SystemRoot!, "System32", "icacls.exe"),
        [path, "/inheritance:e"],
        { timeout: 20_000 },
      );
      expect(await inspect(path)).toEqual([{ private: true, fixed: true }]);
      await broaden(path);
      const originalAcl = await sddl(path);
      const original = statSync(path, { bigint: true });
      expect(await inspect(path)).toEqual([{ private: false, fixed: false, error: "EPRIVATE" }]);
      expect(await ea(path, "read")).toBe(originalValue);
      expect(await sddl(path)).toBe(originalAcl);
      expect(readFileSync(path)).toEqual(bytes);
      expect(statSync(path, { bigint: true }).ino).toBe(original.ino);
      expect(statSync(path, { bigint: true }).mode).toBe(original.mode);
      expect(readdirSync(root)).toEqual(["selected.key"]);
      expect(await ea(path, "clear")).toBe("written");
      expect(await inspect(path)).toEqual([{ private: false, fixed: false, error: "EPRIVATE" }]);
      expect(readFileSync(path)).toEqual(bytes);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(root, { recursive: true, force: true });
    }
  },
  90_000,
);
