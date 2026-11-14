// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";

import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  atomicWriteFileSync,
  ensurePrivateDirSync,
  inspectWindowsPrivatePathSync,
} from "@omnesis/core";

import { afterEach, describe, expect, it } from "vitest";

import { validateRelayCredentialFiles } from "./credentials.js";
import type { RelayConfig } from "./config.js";

const tempDirectories: string[] = [];
afterEach(() => {
  for (const path of tempDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function writePrivateFixture(path: string, data: string | Buffer, options: { mode: number }): void {
  if (process.platform === "win32") {
    ensurePrivateDirSync(dirname(path));
    atomicWriteFileSync(path, data, { mode: 0o600 });
  } else writeFileSync(path, data, options);
}
function broadenRead(path: string): void {
  if (process.platform === "win32")
    execFileSync(
      join(process.env.SystemRoot!, "System32", "icacls.exe"),
      [path, "/grant", "*S-1-1-0:(R)"],
      { windowsHide: true, timeout: 10_000 },
    );
  else chmodSync(path, 0o644);
}

function fixture(): { config: RelayConfig; apnsPath: string; fcmPath: string } {
  const directory = mkdtempSync(join(tmpdir(), "omnesis-relay-credentials-"));
  tempDirectories.push(directory);
  const apnsPath = join(directory, "AuthKey.p8");
  const fcmPath = join(directory, "service-account.json");
  const apns = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
    format: "pem",
    type: "pkcs8",
  });
  const fcm = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    format: "pem",
    type: "pkcs8",
  });
  writePrivateFixture(apnsPath, apns, { mode: 0o600 });
  writePrivateFixture(
    fcmPath,
    JSON.stringify({
      client_email: "relay@example.invalid",
      private_key: fcm.toString(),
      project_id: "fictional-project",
      token_uri: "https://oauth2.googleapis.com/token",
    }),
    { mode: 0o600 },
  );
  return {
    apnsPath,
    fcmPath,
    config: {
      host: "127.0.0.1",
      port: 8080,
      dbPath: join(directory, "relay.db"),
      apns: {
        keyPath: apnsPath,
        keyId: "AAAAAAAAAA",
        teamId: "BBBBBBBBBB",
        appIds: ["dev.omnesis.ios"],
      },
      fcm: {
        serviceAccountPath: fcmPath,
        appIds: ["dev.omnesis.android"],
      },
    },
  };
}

describe("relay credential startup validation", () => {
  it("accepts protected parseable APNs and FCM private credentials", () => {
    const set = fixture();
    expect(() => validateRelayCredentialFiles(set.config)).not.toThrow();
    if (process.platform === "win32")
      for (const path of [set.apnsPath, set.fcmPath])
        expect(inspectWindowsPrivatePathSync(path, "file").private).toBe(true);
  });

  it("fails before startup when a credential file is broadly readable", () => {
    const set = fixture();
    const before = readFileSync(set.fcmPath);
    broadenRead(set.fcmPath);
    expect(() => validateRelayCredentialFiles(set.config)).toThrow(
      process.platform === "win32"
        ? /trusted Windows owner and ACL/
        : "FCM service-account file must not be accessible by group or other users",
    );
    expect(readFileSync(set.fcmPath)).toEqual(before);
    if (process.platform === "win32")
      expect(inspectWindowsPrivatePathSync(set.fcmPath, "file").private).toBe(false);
  });

  it("fails before startup when a credential cannot be parsed", () => {
    const set = fixture();
    writePrivateFixture(set.apnsPath, "not a private key", { mode: 0o600 });
    expect(() => validateRelayCredentialFiles(set.config)).toThrow(
      "APNs key is not a valid private key",
    );

    const second = fixture();
    writePrivateFixture(second.fcmPath, "{}", { mode: 0o600 });
    expect(() => validateRelayCredentialFiles(second.config)).toThrow(
      "FCM service-account file is missing or has invalid required fields",
    );
  });
});
