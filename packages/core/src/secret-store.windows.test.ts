// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createSecretStore,
  generateInstallRootKey,
  OMNESIS_INSTALL_ROOT_KEY,
  readInstallRootKey,
  readInstallRootKeySync,
} from "./secret-store.js";
import { SecretPathUnreadableError, ensurePrivateDirs } from "./security-files.js";
import { execWindowsJob } from "./windows-job-exec.js";
import { windowsPowerShellExecutable } from "./windows-process-tree.js";
import { atomicWriteFile } from "./atomic-write.js";
import { deleteWindowsPrivateFileExact } from "./windows-private-file.js";

const roots: string[] = [];
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "windows-file-keyring-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe.skipIf(process.platform !== "win32")("Windows existing file keyring", () => {
  test.each(["file", "passphrase"] as const)(
    "%s keys that collided under Windows case-folding stay distinct through deletion",
    async (backend) => {
      vi.stubEnv("OMNESIS_KEYRING_PASSPHRASE", "invented test passphrase for the sealed backend");
      const store = createSecretStore({ backend, configDir: scratch() });
      await store.write('A" ', "invented first value");
      await store.write("B\u0206", "invented second value");
      expect(await store.read('A" ')).toBe("invented first value");
      expect(await store.read("B\u0206")).toBe("invented second value");
      await store.delete('A" ');
      expect(await store.read('A" ')).toBeNull();
      expect(await store.read("B\u0206")).toBe("invented second value");
    },
    60_000,
  );

  test("case-distinct and Windows-forbidden custom service identities stay separate", async () => {
    const configDir = scratch();
    const stores = ["Example", "example", "service:with?characters"].map((service) =>
      createSecretStore({ backend: "file", service, configDir }),
    );
    for (const [index, store] of stores.entries())
      await store.write("same-key", `invented service value ${index}`);
    for (const [index, store] of stores.entries())
      expect(await store.read("same-key")).toBe(`invented service value ${index}`);
    await stores[0]!.delete("same-key");
    expect(await stores[0]!.read("same-key")).toBeNull();
    expect(await stores[1]!.read("same-key")).toBe("invented service value 1");
    expect(await stores[2]!.read("same-key")).toBe("invented service value 2");
  }, 60_000);

  test("legacy service names must match stored directory spelling before reads or retirement", async () => {
    const configDir = scratch();
    const keyring = join(configDir, "keyring");
    const legacyDirectory = join(keyring, "Example");
    await ensurePrivateDirs([keyring, legacyDirectory]);
    const legacy = join(legacyDirectory, `${Buffer.from("same-key").toString("base64url")}.secret`);
    await atomicWriteFile(legacy, "invented legacy service value", { mode: 0o600 });
    const first = createSecretStore({ backend: "file", service: "Example", configDir });
    const second = createSecretStore({ backend: "file", service: "example", configDir });
    expect(await first.read("same-key")).toBe("invented legacy service value");
    expect(await second.read("same-key")).toBeNull();
    await second.write("same-key", "invented second service value");
    expect(await first.read("same-key")).toBe("invented legacy service value");
    await first.write("same-key", "invented migrated service value");
    expect(readdirSync(legacyDirectory)).toEqual([]);
    expect(await first.read("same-key")).toBe("invented migrated service value");
    expect(await second.read("same-key")).toBe("invented second service value");
  }, 60_000);

  test.each(["file", "passphrase"] as const)(
    "%s legacy entries migrate without reading or retiring a differently cased key",
    async (backend) => {
      vi.stubEnv("OMNESIS_KEYRING_PASSPHRASE", "invented test passphrase for the sealed backend");
      const configDir = scratch();
      const store = createSecretStore({ backend, configDir });
      await store.write('A" ', "invented legacy value");
      const extension = backend === "file" ? ".secret" : ".json";
      const directory = join(
        configDir,
        "keyring",
        backend === "file" ? "dev.omnesis" : "passphrase",
      );
      const canonical = readdirSync(directory).find((name) => name.endsWith(extension))!;
      await atomicWriteFile(
        join(directory, `QSIg${extension}`),
        readFileSync(join(directory, canonical)),
        { mode: 0o600 },
      );
      await deleteWindowsPrivateFileExact(join(directory, canonical), { exactBasename: canonical });
      expect(await store.read('A" ')).toBe("invented legacy value");
      expect(await store.read("B\u0206")).toBeNull();
      await store.write("B\u0206", "invented second value");
      expect(await store.read('A" ')).toBe("invented legacy value");
      expect(readdirSync(directory)).toContain(`QSIg${extension}`);
      await store.write('A" ', "invented migrated value");
      expect(readdirSync(directory)).not.toContain(`QSIg${extension}`);
      expect(await store.read('A" ')).toBe("invented migrated value");
      expect(await store.read("B\u0206")).toBe("invented second value");
    },
    60_000,
  );

  test("roundtrips secrets larger than the authority-key read bound", async () => {
    const configDir = scratch();
    const store = createSecretStore({ backend: "file", configDir });
    const value = "invented secret value\n".repeat(1600);
    expect(Buffer.byteLength(value)).toBeGreaterThan(16_384);
    await store.write("large-example", value);
    expect(await store.status()).toMatchObject({
      available: true,
      writeExposure: "owner-only-file",
    });
    expect(await store.read("large-example")).toBe(value);
  }, 60_000);

  test("unsafe existing key material cannot become an absent key or an owner-only status", async () => {
    const configDir = scratch();
    const store = createSecretStore({ backend: "file", configDir });
    await store.write(OMNESIS_INSTALL_ROOT_KEY, generateInstallRootKey());
    const directory = join(configDir, "keyring", "dev.omnesis");
    const file = join(
      directory,
      readdirSync(directory).find((name) => name.endsWith(".secret"))!,
    );
    await execWindowsJob(
      windowsPowerShellExecutable(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `
$ErrorActionPreference='Stop'
$path=$env:OMNESIS_KEYRING_ACL_TEST
$acl=[System.IO.File]::GetAccessControl($path)
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]'S-1-1-0',[System.Security.AccessControl.FileSystemRights]::Read,[System.Security.AccessControl.AccessControlType]::Allow))
[System.IO.File]::SetAccessControl($path,$acl)
`,
      ],
      { env: { ...process.env, OMNESIS_KEYRING_ACL_TEST: file }, timeout: 20_000 },
    );
    await expect(store.status()).rejects.toBeInstanceOf(SecretPathUnreadableError);
    await expect(store.read(OMNESIS_INSTALL_ROOT_KEY)).rejects.toBeInstanceOf(
      SecretPathUnreadableError,
    );
    await expect(readInstallRootKey({ backend: "file", configDir })).rejects.toBeInstanceOf(
      SecretPathUnreadableError,
    );
    expect(() => readInstallRootKeySync({ backend: "file", configDir })).toThrow(
      SecretPathUnreadableError,
    );
  }, 60_000);
});
