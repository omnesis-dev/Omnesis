// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  atomicWriteFileSync,
  ensurePrivateDirSync,
  inspectWindowsPrivatePathSync,
} from "@omnesis/core";

import { afterEach, describe, expect, it } from "vitest";

import { runRelayAdminCommand, type RelayAdminIo } from "./admin.js";
import { digestSecret, RelayStore } from "./store.js";
import type { RelayTarget } from "./types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writePrivateFixture(path: string, data: string, options: { mode: number }): void {
  if (process.platform === "win32") {
    ensurePrivateDirSync(dirname(path));
    atomicWriteFileSync(path, data, { mode: 0o600 });
  } else writeFileSync(path, data, options);
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-relay-admin-"));
  dirs.push(dir);
  const dbPath = join(dir, "relay.db");
  const credential = `omnrelay_v1_${"a".repeat(43)}`;
  const hash = digestSecret(credential);
  const target: RelayTarget = {
    platform: "android",
    token: "fictional-carrier-token",
    appId: "dev.omnesis.android",
  };
  const store = new RelayStore(dbPath);
  store.createChallenge({
    id: "challenge",
    target,
    nonceHash: digestSecret("nonce"),
    createdAt: 1,
    expiresAt: 1_000,
  });
  store.verifyChallengeAndCreateCredential({
    challengeId: "challenge",
    nonceHash: digestSecret("nonce"),
    credentialHash: hash,
    now: 2,
  });
  store.close();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: RelayAdminIo = {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
    env: {},
    now: () => 500,
  };
  return { dir, dbPath, credential, hash, target, stdout, stderr, io };
}

describe("relay offline administration", () => {
  it("revokes one credential from an owner-only secret file without carrier config", () => {
    const set = fixture();
    const secretPath = join(set.dir, "credential");
    writePrivateFixture(secretPath, `${set.credential}\n`, { mode: 0o600 });

    expect(
      runRelayAdminCommand(["revoke", "--db", set.dbPath, "--secret-file", secretPath], set.io),
    ).toBe(0);
    expect(set.stdout).toEqual(["Revoked one relay credential."]);
    expect(set.stderr).toEqual([]);
    const reopened = new RelayStore(set.dbPath);
    expect(reopened.lookupCredential(set.hash)).toBeNull();
    expect(
      reopened.db
        .prepare(
          "SELECT token, app_id, environment, revoked_at FROM relay_credentials WHERE credential_hash = ?",
        )
        .get(set.hash),
    ).toEqual({ token: "", app_id: "", environment: null, revoked_at: 500 });
    reopened.close();
  });

  it("accepts a SHA-256 digest and never requires the APNs or FCM environment", () => {
    const set = fixture();
    expect(
      runRelayAdminCommand(
        ["revoke", "--db", set.dbPath, "--digest", set.hash.toString("hex")],
        set.io,
      ),
    ).toBe(0);
    expect(set.stderr).toEqual([]);
  });

  it("rejects ambiguous input and a secret file readable by other users", () => {
    const set = fixture();
    const secretPath = join(set.dir, "credential");
    writePrivateFixture(secretPath, set.credential, { mode: 0o600 });
    if (process.platform === "win32")
      execFileSync(
        join(process.env.SystemRoot!, "System32", "icacls.exe"),
        [secretPath, "/grant", "*S-1-1-0:(R)"],
        { windowsHide: true, timeout: 10_000 },
      );
    else chmodSync(secretPath, 0o644);
    expect(
      runRelayAdminCommand(["revoke", "--db", set.dbPath, "--secret-file", secretPath], set.io),
    ).toBe(1);
    expect(set.stderr.at(-1)).toContain(
      process.platform === "win32" ? "trusted Windows owner and ACL" : "must not be accessible",
    );
    expect(readFileSync(secretPath, "utf8")).toBe(set.credential);
    if (process.platform === "win32")
      expect(inspectWindowsPrivatePathSync(secretPath, "file").private).toBe(false);
    const unchanged = new RelayStore(set.dbPath);
    try {
      expect(unchanged.lookupCredential(set.hash)).not.toBeNull();
    } finally {
      unchanged.close();
    }

    expect(
      runRelayAdminCommand(
        [
          "revoke",
          "--db",
          set.dbPath,
          "--secret-file",
          secretPath,
          "--digest",
          set.hash.toString("hex"),
        ],
        set.io,
      ),
    ).toBe(64);
  });
});
