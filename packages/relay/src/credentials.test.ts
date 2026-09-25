// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateRelayCredentialFiles } from "./credentials.js";
import type { RelayConfig } from "./config.js";

const tempDirectories: string[] = [];
afterEach(() => {
  for (const path of tempDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

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
  writeFileSync(apnsPath, apns, { mode: 0o600 });
  writeFileSync(
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
  });

  it("fails before startup when a credential file is broadly readable", () => {
    const set = fixture();
    chmodSync(set.fcmPath, 0o644);
    expect(() => validateRelayCredentialFiles(set.config)).toThrow(
      "FCM service-account file must not be accessible by group or other users",
    );
  });

  it("fails before startup when a credential cannot be parsed", () => {
    const set = fixture();
    writeFileSync(set.apnsPath, "not a private key", { mode: 0o600 });
    expect(() => validateRelayCredentialFiles(set.config)).toThrow(
      "APNs key is not a valid private key",
    );

    const second = fixture();
    writeFileSync(second.fcmPath, "{}", { mode: 0o600 });
    expect(() => validateRelayCredentialFiles(second.config)).toThrow(
      "FCM service-account file is missing or has invalid required fields",
    );
  });
});
