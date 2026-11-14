// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { execWindowsJob } from "@omnesis/platform/windows-job-exec";
import { inspectWindowsPrivatePathSync } from "@omnesis/platform/windows-private-file";
import { windowsPowerShellExecutable } from "@omnesis/platform/windows-powershell";
import {
  createAppStoreConnectJwt,
  ensureAppIdPushCapability,
  renderFirebaseLocalPushProperties,
  writeFirebaseLocalPushProperties,
} from "./push-setup.js";

const credentials = {
  keyId: "ABC123DEFG",
  issuerId: "11111111-2222-4333-8444-555555555555",
  privateKeyPath: "/unused/AuthKey_ABC123DEFG.p8",
};
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const dirs: string[] = [];
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("App Store Connect push capability", () => {
  test("creates a short-lived ES256 token without exposing the private key", () => {
    const token = createAppStoreConnectJwt(
      credentials.keyId,
      credentials.issuerId,
      privateKeyPem,
      2_000_000,
    );
    const [encodedHeader, encodedClaims, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(encodedHeader!, "base64url").toString())).toMatchObject({
      alg: "ES256",
      kid: credentials.keyId,
    });
    expect(JSON.parse(Buffer.from(encodedClaims!, "base64url").toString())).toMatchObject({
      iss: credentials.issuerId,
      iat: 2_000,
      exp: 3_140,
      aud: "appstoreconnect-v1",
    });
    expect(Buffer.from(signature!, "base64url")).toHaveLength(64);
    expect(token).not.toContain("PRIVATE KEY");
  });

  test("finds the exact App ID and leaves an existing push capability unchanged", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "bundle-record" }] }))
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ attributes: { capabilityType: "PUSH_NOTIFICATIONS" } }] }),
      );

    await expect(
      ensureAppIdPushCapability(
        { bundleId: "dev.example.omnesis", credentials },
        {
          fetch: fetchFn,
          readPrivateKey: () => Promise.resolve(privateKeyPem),
          now: () => 2_000_000,
        },
      ),
    ).resolves.toBe("already-enabled");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0]?.[0].toString()).toContain(
      "filter%5Bidentifier%5D=dev.example.omnesis",
    );
  });

  test("enables push only on the exact App ID when it is absent", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "bundle-record" }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: "capability-record" } }, 201));

    await expect(
      ensureAppIdPushCapability(
        { bundleId: "dev.example.omnesis", credentials },
        { fetch: fetchFn, readPrivateKey: () => Promise.resolve(privateKeyPem) },
      ),
    ).resolves.toBe("enabled");
    const [, postInit] = fetchFn.mock.calls[2]!;
    expect(JSON.parse(postInit?.body as string)).toEqual({
      data: {
        type: "bundleIdCapabilities",
        attributes: { capabilityType: "PUSH_NOTIFICATIONS" },
        relationships: { bundleId: { data: { type: "bundleIds", id: "bundle-record" } } },
      },
    });
  });

  test("fails closed when the bundle lookup is missing or ambiguous", async () => {
    for (const data of [[], [{ id: "one" }, { id: "two" }]]) {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ data }));
      await expect(
        ensureAppIdPushCapability(
          { bundleId: "dev.example.omnesis", credentials },
          { fetch: fetchFn, readPrivateKey: () => Promise.resolve(privateKeyPem) },
        ),
      ).rejects.toThrow(/no App ID|multiple App IDs/);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }
  });
});

describe("Android local.push.properties", () => {
  const values = {
    packageId: "dev.example.omnesis",
    applicationId: "1:123456789:android:abcdef",
    apiKey: "fictional:key=value",
    projectId: "fictional-project",
    senderId: "123456789",
  };

  test("renders the package id and four Firebase client values with Java-properties escaping", () => {
    expect(renderFirebaseLocalPushProperties(values)).toBe(
      [
        "# Generated by `omnesis push setup`. Do not commit this file.",
        "OMNESIS_ANDROID_APPLICATION_ID=dev.example.omnesis",
        "OMNESIS_FIREBASE_APPLICATION_ID=1\\:123456789\\:android\\:abcdef",
        "OMNESIS_FIREBASE_API_KEY=fictional\\:key\\=value",
        "OMNESIS_FIREBASE_PROJECT_ID=fictional-project",
        "OMNESIS_FIREBASE_SENDER_ID=123456789",
        "",
      ].join("\n"),
    );
    expect(() => renderFirebaseLocalPushProperties({ ...values, apiKey: " " })).toThrow(/API_KEY/);
    expect(() =>
      renderFirebaseLocalPushProperties({ ...values, packageId: "bad package" }),
    ).toThrow(/package id/);
  });

  test("the Android build loads the generated file and git ignores it", () => {
    const gradle = readFileSync(join(repoRoot, "android/app/build.gradle.kts"), "utf8");
    const gitignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
    expect(gradle).toContain('rootProject.file("local.push.properties")');
    expect(gradle).toContain("localPushProperties.getProperty(name)");
    expect(gradle).toContain('localPushProperties.getProperty("OMNESIS_ANDROID_APPLICATION_ID")');
    const shortcuts = readFileSync(
      join(repoRoot, "android/app/src/main/shortcuts/shortcuts.xml"),
      "utf8",
    );
    expect(shortcuts).not.toContain('android:targetPackage="dev.omnesis.android"');
    expect(shortcuts).not.toContain('android:targetPackage="@string/');
    expect(shortcuts).toContain('android:targetPackage="__OMNESIS_APPLICATION_ID__"');
    expect(gradle).toContain("GenerateShortcutsResource");
    expect(gitignore.split(/\r?\n/)).toContain("android/local.push.properties");
  });

  test("writes an owner-only local file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-push-setup-"));
    dirs.push(dir);
    const path = join(dir, "local.push.properties");
    for (const projectId of [values.projectId, "fictional-project-replacement"]) {
      const next = { ...values, projectId };
      await writeFirebaseLocalPushProperties(path, next);
      expect(readFileSync(path, "utf8")).toBe(renderFirebaseLocalPushProperties(next));
      if (process.platform === "win32")
        expect(inspectWindowsPrivatePathSync(path, "file").private).toBe(true);
      else expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  test.runIf(process.platform === "win32")(
    "creates private properties under a readable parent and replaces exposed prior content",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "omnesis-push-setup-acl-"));
      dirs.push(dir);
      const path = join(dir, "local.push.properties");
      const expose = async (target: string, directory: boolean) => {
        await execWindowsJob(
          windowsPowerShellExecutable(),
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `
$ErrorActionPreference='Stop'
$path=$env:OMNESIS_PUSH_ACL_TEST_PATH
if ($env:OMNESIS_PUSH_ACL_TEST_DIRECTORY -eq '1') {
  $acl=[System.IO.Directory]::GetAccessControl($path)
  $rule=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]'S-1-1-0',[System.Security.AccessControl.FileSystemRights]::ReadAndExecute,[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  [System.IO.Directory]::SetAccessControl($path,$acl)
} else {
  $acl=[System.IO.File]::GetAccessControl($path)
  $rule=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]'S-1-1-0',[System.Security.AccessControl.FileSystemRights]::Read,[System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  [System.IO.File]::SetAccessControl($path,$acl)
}
`,
          ],
          {
            env: {
              ...process.env,
              OMNESIS_PUSH_ACL_TEST_PATH: target,
              OMNESIS_PUSH_ACL_TEST_DIRECTORY: directory ? "1" : "0",
            },
            timeout: 20_000,
          },
        );
      };
      await expose(dir, true);
      const unrelated = join(dir, "unrelated.properties");
      writeFileSync(unrelated, "preserve=true\n");
      expect(inspectWindowsPrivatePathSync(unrelated, "file").private).toBe(false);
      await writeFirebaseLocalPushProperties(path, values);
      expect(readFileSync(path, "utf8")).toBe(renderFirebaseLocalPushProperties(values));
      expect(inspectWindowsPrivatePathSync(path, "file").private).toBe(true);
      await expose(path, false);
      expect(inspectWindowsPrivatePathSync(path, "file").private).toBe(false);
      const changed = { ...values, projectId: "fictional-project-replacement" };
      await writeFirebaseLocalPushProperties(path, changed);
      expect(readFileSync(path, "utf8")).toBe(renderFirebaseLocalPushProperties(changed));
      expect(inspectWindowsPrivatePathSync(path, "file").private).toBe(true);
      expect(readFileSync(unrelated, "utf8")).toBe("preserve=true\n");
    },
    60_000,
  );

  test("refuses to follow an existing local-properties symlink", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-push-setup-"));
    dirs.push(dir);
    const target = join(dir, "unrelated.properties");
    const path = join(dir, "local.push.properties");
    writeFileSync(target, "preserve=true\n");
    symlinkSync(target, path);

    await expect(writeFirebaseLocalPushProperties(path, values)).rejects.toThrow(/symbolic-link/);
    expect(readFileSync(target, "utf8")).toBe("preserve=true\n");
  });
});
