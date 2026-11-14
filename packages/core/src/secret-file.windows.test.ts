// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  clearSecretFileKeyCacheForTests,
  migrateSecretTextFile,
  readSecretTextFile,
  readSecretTextFileSync,
  writeSecretTextFile,
  writeSecretTextFileSync,
} from "./secret-file.js";
import { SecretPathUnreadableError } from "./security-files.js";
import { execWindowsJob } from "./windows-job-exec.js";
import { windowsPowerShellExecutable } from "./windows-process-tree.js";

test.runIf(process.platform === "win32")(
  "unsafe existing secret ACLs cannot be read, migrated or silently rewritten",
  async () => {
    clearSecretFileKeyCacheForTests();
    const dir = mkdtempSync(join(tmpdir(), "windows-secret-file-"));
    const path = join(dir, "provider.secret");
    const opts = { backend: "file" as const, configDir: dir };
    try {
      await writeSecretTextFile(path, "invented private value", opts);
      await execWindowsJob(
        windowsPowerShellExecutable(),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$path=$env:OMNESIS_SECRET_ACL_TEST;
$acl=[System.IO.File]::GetAccessControl($path);
$rule=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]'S-1-1-0',[System.Security.AccessControl.FileSystemRights]::Read,[System.Security.AccessControl.AccessControlType]::Allow);
$acl.AddAccessRule($rule);[System.IO.File]::SetAccessControl($path,$acl);`,
        ],
        { env: { ...process.env, OMNESIS_SECRET_ACL_TEST: path }, timeout: 20_000 },
      );
      await expect(readSecretTextFile(path, opts)).rejects.toBeInstanceOf(
        SecretPathUnreadableError,
      );
      expect(() => readSecretTextFileSync(path, opts)).toThrow(SecretPathUnreadableError);
      await expect(migrateSecretTextFile(path, opts)).rejects.toBeInstanceOf(
        SecretPathUnreadableError,
      );
      await expect(writeSecretTextFile(path, "replacement", opts)).rejects.toBeInstanceOf(
        SecretPathUnreadableError,
      );
      expect(() => writeSecretTextFileSync(path, "replacement", opts)).toThrow(
        SecretPathUnreadableError,
      );
      expect(readFileSync(path, "utf8")).toBe("invented private value");
    } finally {
      clearSecretFileKeyCacheForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
