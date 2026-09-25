// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { runRelayAdminCommand, type RelayAdminIo } from "./admin.js";
import { digestSecret, RelayStore } from "./store.js";
import type { RelayTarget } from "./types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
    writeFileSync(secretPath, `${set.credential}\n`, { mode: 0o600 });

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
    writeFileSync(secretPath, set.credential, { mode: 0o600 });
    chmodSync(secretPath, 0o644);
    expect(
      runRelayAdminCommand(["revoke", "--db", set.dbPath, "--secret-file", secretPath], set.io),
    ).toBe(1);
    expect(set.stderr.at(-1)).toContain("must not be accessible");

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
