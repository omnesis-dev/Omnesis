// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  chmodSync,
  closeSync,
  openSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runWindowsJob } from "./windows-job.js";
import { WINDOWS_PRIVATE_FILE_NATIVE_SOURCE } from "./native/windows-private-file-source.js";
import { execWindowsJob } from "./windows-job-exec.js";
import { windowsPowerShellExecutable } from "./windows-powershell.js";
import {
  createWindowsPrivateFile,
  inspectWindowsPrivatePaths,
  readWindowsPrivateFile,
  writeWindowsPrivateFileAtomic,
  deleteWindowsPrivateFileExact,
} from "./windows-private-file.js";

async function acl(
  path: string,
  broaden = false,
  directory = false,
  writable = false,
): Promise<string> {
  const { stdout } = await execWindowsJob(
    windowsPowerShellExecutable(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `
$path=$env:OMNESIS_TRAVERSAL_FIXTURE;
$sections=[System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group;
$directory=$env:OMNESIS_TRAVERSAL_DIRECTORY -eq '1';
$acl=if($directory){[System.IO.Directory]::GetAccessControl($path,$sections)}else{[System.IO.File]::GetAccessControl($path,$sections)};
if($env:OMNESIS_TRAVERSAL_BROAD -eq '1') {
 $rights=if($env:OMNESIS_TRAVERSAL_WRITABLE -eq '1'){[System.Security.AccessControl.FileSystemRights]::FullControl}else{[System.Security.AccessControl.FileSystemRights]::Read};
 if($directory) {
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]'S-1-1-0',$rights,[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow));
  [System.IO.Directory]::SetAccessControl($path,$acl);
 } else {
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]'S-1-1-0',$rights,[System.Security.AccessControl.AccessControlType]::Allow));
  [System.IO.File]::SetAccessControl($path,$acl);
 }
 $acl=if($directory){[System.IO.Directory]::GetAccessControl($path,$sections)}else{[System.IO.File]::GetAccessControl($path,$sections)};
}
[Console]::Out.Write($acl.GetSecurityDescriptorSddlForm($sections));
`,
    ],
    {
      env: {
        ...process.env,
        OMNESIS_TRAVERSAL_FIXTURE: path,
        OMNESIS_TRAVERSAL_BROAD: broaden ? "1" : "0",
        OMNESIS_TRAVERSAL_DIRECTORY: directory ? "1" : "0",
        OMNESIS_TRAVERSAL_WRITABLE: writable ? "1" : "0",
      },
      timeout: 20_000,
    },
  );
  return stdout.trim();
}

test.runIf(process.platform === "win32")(
  "batch repair refuses every junction ancestor without touching unrelated files and still repairs owned entries",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "private traversal batch-"));
    const owned = join(root, "owned"),
      external = join(root, "external"),
      externalDir = join(external, "externalDir");
    mkdirSync(owned);
    mkdirSync(externalDir, { recursive: true });
    const outside = join(externalDir, "invented.txt"),
      regular = join(owned, "regular.txt"),
      privateOutside = join(externalDir, "private.txt");
    const bytes = Buffer.from("invented unrelated retained bytes");
    try {
      await createWindowsPrivateFile(outside, bytes);
      await createWindowsPrivateFile(privateOutside, bytes);
      await createWindowsPrivateFile(regular, Buffer.from("invented owned bytes"));
      const prepared = await inspectWindowsPrivatePaths(
        [
          { path: owned, kind: "directory" },
          { path: externalDir, kind: "directory" },
        ],
        { repair: true, protect: true },
      );
      expect(prepared.every((status) => status.private)).toBe(true);
      const outsideAcl = await acl(outside, true);
      await acl(regular, true);
      expect(
        (await inspectWindowsPrivatePaths([{ path: outside, kind: "file" }]))[0]?.private,
      ).toBe(false);
      symlinkSync(external, join(owned, "junction"), "junction");
      const aliased = join(owned, "junction", "externalDir", "invented.txt");
      // Models the exact native batch left by an enumerated directory that
      // became a junction: a failed first entry must not permit a deeper repair.
      const result = await inspectWindowsPrivatePaths(
        [
          { path: join(owned, "junction"), kind: "directory" },
          { path: aliased, kind: "file" },
          { path: regular, kind: "file" },
        ],
        { repair: true, protect: true },
      );
      expect(result).toEqual([
        { private: false, fixed: false, error: "EPRIVATE" },
        { private: false, fixed: false, error: "EPRIVATE" },
        { private: true, fixed: true },
      ]);
      expect(await acl(outside)).toBe(outsideAcl);
      expect(readFileSync(outside)).toEqual(bytes);
      expect(readFileSync(regular, "utf8")).toBe("invented owned bytes");
      const privateAlias = join(owned, "junction", "externalDir", "private.txt");
      await expect(readWindowsPrivateFile(privateAlias)).rejects.toMatchObject({
        code: "EPRIVATE",
      });
      await expect(
        writeWindowsPrivateFileAtomic(privateAlias, Buffer.from("must not publish")),
      ).rejects.toMatchObject({ code: "EPRIVATE" });
      await expect(
        deleteWindowsPrivateFileExact(privateAlias, { exactBasename: "private.txt" }),
      ).rejects.toMatchObject({ code: "EPRIVATE" });
      expect(await readWindowsPrivateFile(privateOutside)).toEqual(bytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);

const reparseCreationFixture = String.raw`
public static partial class OmnesisPrivateFile {
  static Action FixtureCreate;
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DeviceIoControl(SafeFileHandle file,uint code,byte[] input,int inputSize,IntPtr output,int outputSize,out int returned,IntPtr overlapped);
  public static string FixtureRetargetCreate(string directory,string outside) {
    byte[] substitute=Encoding.Unicode.GetBytes(@"\??\"+outside),print=Encoding.Unicode.GetBytes(outside);
    byte[] data=new byte[16+substitute.Length+2+print.Length+2];
    Buffer.BlockCopy(BitConverter.GetBytes(0xA0000003U),0,data,0,4);
    Buffer.BlockCopy(BitConverter.GetBytes((ushort)(data.Length-8)),0,data,4,2);
    Buffer.BlockCopy(BitConverter.GetBytes((ushort)substitute.Length),0,data,10,2);
    Buffer.BlockCopy(BitConverter.GetBytes((ushort)(substitute.Length+2)),0,data,12,2);
    Buffer.BlockCopy(BitConverter.GetBytes((ushort)print.Length),0,data,14,2);
    Buffer.BlockCopy(substitute,0,data,16,substitute.Length);
    Buffer.BlockCopy(print,0,data,18+substitute.Length,print.Length);
    byte[] remove=new byte[8];Buffer.BlockCopy(BitConverter.GetBytes(0xA0000003U),0,remove,0,4);
    bool retargeted=false;int reparseError=0,createError=0;
    using(SafeFileHandle actor=CreateFile(directory,0x40000080U,7,IntPtr.Zero,3,0x2200000U,IntPtr.Zero)) {
      if(actor.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
      FixtureCreate=delegate {
        int returned;retargeted=DeviceIoControl(actor,0x900A4U,data,data.Length,IntPtr.Zero,0,out returned,IntPtr.Zero);
        if(!retargeted)reparseError=Marshal.GetLastWin32Error();
      };
      try {
        WriteInput(Path.Combine(directory,"created.bin"),3,false,false,"",false,true,new MemoryStream(new byte[]{1,2,3}),false,null);
      } catch(Win32Exception error) {createError=error.NativeErrorCode;}
        catch(UnauthorizedAccessException) {createError=5;}
      finally {
        FixtureCreate=null;
        if(retargeted) {int returned;Check(DeviceIoControl(actor,0x900ACU,remove,remove.Length,IntPtr.Zero,0,out returned,IntPtr.Zero));}
      }
    }
    return (retargeted?"retargeted":"blocked")+":"+reparseError+":"+createError;
  }
}
`;

test.runIf(process.platform === "win32")(
  "private creation never follows an in-place parent reparse change through an already-open writer handle",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "private reparse creation-"));
    const parent = join(root, "owned"),
      outside = join(root, "unrelated");
    mkdirSync(parent);
    mkdirSync(outside);
    try {
      const prepared = await inspectWindowsPrivatePaths(
        [
          { path: parent, kind: "directory" },
          { path: outside, kind: "directory" },
        ],
        { repair: true, protect: true },
      );
      expect(prepared.every((status) => status.private)).toBe(true);
      // Only the fixture injects a callback at this exact creation boundary;
      // the production WriteInput body and its actual native creation are used.
      const boundary = 'Stage="create";';
      expect(WINDOWS_PRIVATE_FILE_NATIVE_SOURCE.split(boundary)).toHaveLength(2);
      const instrumented = WINDOWS_PRIVATE_FILE_NATIVE_SOURCE.replace(
        boundary,
        boundary + "if(FixtureCreate!=null)FixtureCreate();",
      );
      const result = await runWindowsJob(
        windowsPowerShellExecutable(),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference='Stop';$source=[Console]::In.ReadToEnd();Add-Type -TypeDefinition $source;[Console]::Out.Write([OmnesisPrivateFile]::FixtureRetargetCreate($env:OMNESIS_REPARSE_PARENT,$env:OMNESIS_REPARSE_OUTSIDE));",
        ],
        {
          env: { ...process.env, OMNESIS_REPARSE_PARENT: parent, OMNESIS_REPARSE_OUTSIDE: outside },
          input: Buffer.from(instrumented + reparseCreationFixture, "utf8"),
          timeoutMs: 60_000,
        },
      );
      expect(result.failure, result.stderr).toBeUndefined();
      expect(result.exitCode, result.stderr).toBe(0);
      const [state, reparseError, createError] = Buffer.from(result.stdout)
        .toString("utf8")
        .split(":");
      expect(["blocked", "retargeted"]).toContain(state);
      if (state === "blocked") expect([5, 32]).toContain(Number(reparseError));
      expect(existsSync(join(outside, "created.bin"))).toBe(false);
      if (createError === "0") {
        expect(readFileSync(join(parent, "created.bin"))).toEqual(Buffer.from([1, 2, 3]));
        expect(
          (
            await inspectWindowsPrivatePaths([{ path: join(parent, "created.bin"), kind: "file" }])
          )[0]?.private,
        ).toBe(true);
      } else {
        expect(state).toBe("retargeted");
        expect(existsSync(join(parent, "created.bin"))).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  90_000,
);

test.runIf(process.platform === "win32")(
  "repairs only selected objects, preserves outside hardlinks and readonly attributes, and protects future children",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "private hardlink repair-"));
    const owned = join(root, "owned"),
      external = join(root, "external");
    mkdirSync(owned);
    mkdirSync(external);
    const outside = join(external, "public.txt"),
      linked = join(owned, "linked.txt");
    const bytes = Buffer.from("invented outside hardlink bytes");
    try {
      const prepared = await inspectWindowsPrivatePaths(
        [
          { path: owned, kind: "directory" },
          { path: external, kind: "directory" },
        ],
        { repair: true, protect: true },
      );
      expect(prepared.every((status) => status.private)).toBe(true);
      await acl(external, true, true);
      writeFileSync(outside, bytes);
      linkSync(outside, linked);
      await acl(owned, true, true);
      const before = await acl(outside);
      expect(statSync(outside).nlink).toBe(2);
      expect(before).not.toMatch(/D:[^()]*P/);
      expect(
        (await inspectWindowsPrivatePaths([{ path: outside, kind: "file" }]))[0]?.private,
      ).toBe(false);
      expect(
        await inspectWindowsPrivatePaths([{ path: owned, kind: "directory" }], {
          repair: true,
          protect: true,
        }),
      ).toEqual([{ private: true, fixed: true }]);
      expect(await acl(outside)).toBe(before);
      expect(
        await inspectWindowsPrivatePaths([{ path: linked, kind: "file" }], {
          repair: true,
          protect: true,
        }),
      ).toEqual([{ private: false, fixed: false, error: "EPRIVATE" }]);
      expect(await acl(outside)).toBe(before);
      expect(readFileSync(outside)).toEqual(bytes);
      const future = join(owned, "future.txt");
      writeFileSync(future, "invented future bytes");
      expect(await inspectWindowsPrivatePaths([{ path: future, kind: "file" }])).toEqual([
        { private: true, fixed: false },
      ]);

      const readonlyOutside = join(external, "readonly.key"),
        replacement = join(owned, "replacement.key");
      await createWindowsPrivateFile(readonlyOutside, bytes);
      linkSync(readonlyOutside, replacement);
      chmodSync(readonlyOutside, 0o400);
      const readonlyAcl = await acl(readonlyOutside);
      await expect(
        deleteWindowsPrivateFileExact(replacement, { exactBasename: "replacement.key" }),
      ).rejects.toMatchObject({ code: "EPRIVATE" });
      expect(readFileSync(readonlyOutside)).toEqual(bytes);
      expect(readFileSync(replacement)).toEqual(bytes);
      expect(statSync(readonlyOutside).mode & 0o200).toBe(0);
      await writeWindowsPrivateFileAtomic(replacement, Buffer.from("invented replacement"));
      expect(readFileSync(replacement, "utf8")).toBe("invented replacement");
      expect(readFileSync(readonlyOutside)).toEqual(bytes);
      expect(statSync(readonlyOutside).mode & 0o200).toBe(0);
      expect(await acl(readonlyOutside)).toBe(readonlyAcl);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  90_000,
);

const hardlinkRepairFixture = String.raw`
public static partial class OmnesisPrivateFile {
  static Action FixtureRepair;
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateHardLink(string name,string existing,IntPtr security);
  public static string FixtureLinkRepair(string path,string alias) {
    bool linked=false;int error=0;
    FixtureRepair=delegate {
      linked=CreateHardLink(alias,path,IntPtr.Zero);
      if(!linked)error=Marshal.GetLastWin32Error();
    };
    try {return Inspect(path,false,true,true)+":"+(linked?"linked":"blocked")+":"+error;}
    finally {FixtureRepair=null;}
  }
}
`;

test.runIf(process.platform === "win32")(
  "an exclusive repair pin blocks a new outside hardlink before the DACL mutation",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "private hardlink pin-"));
    const target = join(root, "selected.txt"),
      alias = join(root, "unrelated.txt");
    const bytes = Buffer.from("invented held repair bytes");
    try {
      expect(
        await inspectWindowsPrivatePaths([{ path: root, kind: "directory" }], {
          repair: true,
          protect: true,
        }),
      ).toEqual([{ private: true, fixed: true }]);
      await createWindowsPrivateFile(target, bytes);
      await acl(target, true);
      const boundary = 'Stage="repair";Repair(mutation,false);';
      expect(WINDOWS_PRIVATE_FILE_NATIVE_SOURCE.split(boundary)).toHaveLength(2);
      const instrumented = WINDOWS_PRIVATE_FILE_NATIVE_SOURCE.replace(
        boundary,
        'Stage="repair";if(FixtureRepair!=null)FixtureRepair();Repair(mutation,false);',
      );
      const result = await runWindowsJob(
        windowsPowerShellExecutable(),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference='Stop';$source=[Console]::In.ReadToEnd();Add-Type -TypeDefinition $source;[Console]::Out.Write([OmnesisPrivateFile]::FixtureLinkRepair($env:OMNESIS_REPAIR_TARGET,$env:OMNESIS_REPAIR_ALIAS));",
        ],
        {
          env: { ...process.env, OMNESIS_REPAIR_TARGET: target, OMNESIS_REPAIR_ALIAS: alias },
          input: Buffer.from(instrumented + hardlinkRepairFixture, "utf8"),
          timeoutMs: 60_000,
        },
      );
      expect(result.failure, result.stderr).toBeUndefined();
      expect(result.exitCode, result.stderr).toBe(0);
      expect(Buffer.from(result.stdout).toString("utf8")).toBe("fixed:blocked:32");
      expect(existsSync(alias)).toBe(false);
      expect(readFileSync(target)).toEqual(bytes);
      expect(await inspectWindowsPrivatePaths([{ path: target, kind: "file" }])).toEqual([
        { private: true, fixed: false },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  90_000,
);

test.runIf(process.platform === "win32")(
  "already protected private files remain verifiable while an owned read-write handle is live",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "private live file-"));
    const target = join(root, "active.sqlite");
    const bytes = Buffer.from("invented active file bytes");
    let descriptor: number | undefined;
    try {
      await inspectWindowsPrivatePaths([{ path: root, kind: "directory" }], {
        repair: true,
        protect: true,
      });
      await createWindowsPrivateFile(target, bytes);
      const before = await acl(target);
      descriptor = openSync(target, "r+");
      expect(
        await inspectWindowsPrivatePaths([{ path: target, kind: "file" }], {
          repair: true,
          protect: true,
        }),
      ).toEqual([{ private: true, fixed: false }]);
      expect(await acl(target)).toBe(before);
      expect(readFileSync(target)).toEqual(bytes);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);

test.runIf(process.platform === "win32")(
  "missing private reads preserve ENOENT below an unsafe parent while existing files remain refused",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "private missing leaf-"));
    const target = join(root, "existing.env");
    const bytes = Buffer.from("INVENTED_KEY=unchanged\n");
    try {
      await inspectWindowsPrivatePaths([{ path: root, kind: "directory" }], {
        repair: true,
        protect: true,
      });
      await createWindowsPrivateFile(target, bytes);
      await acl(root, true, true, true);
      await expect(readWindowsPrivateFile(join(root, "missing.env"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readWindowsPrivateFile(target)).rejects.toMatchObject({ code: "EPRIVATE" });
      expect(readFileSync(target)).toEqual(bytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);
