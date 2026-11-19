// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensurePrivateDirSync, inspectWindowsPrivatePathSync } from "@omnesis/core";
import { RelayStore, digestSecret } from "./store.js";
let root: string;
const stores: RelayStore[] = [];
function open(path: string) {
  const store = new RelayStore(path);
  stores.push(store);
  return store;
}
function add(store: RelayStore) {
  store.createChallenge({
    id: "invented",
    target: { platform: "android", token: "invented carrier token", appId: "dev.example.app" },
    nonceHash: digestSecret("invented nonce"),
    createdAt: 1,
    expiresAt: 1000,
  });
}
function broaden(path: string) {
  execFileSync(
    join(process.env.SystemRoot!, "System32", "icacls.exe"),
    [path, "/grant", "*S-1-1-0:(R)"],
    { windowsHide: true, timeout: 10_000 },
  );
}
describe.runIf(process.platform === "win32")("RelayStore private Windows files", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "relay-storage-native-"));
    ensurePrivateDirSync(root);
  });
  afterEach(() => {
    for (const store of stores.splice(0)) if (store.db.open) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  it("creates a new dedicated suffix and private SQLite/WAL/shared-memory files", () => {
    const directory = join(root, "new", "state"),
      path = join(directory, "relay.db");
    const store = open(path);
    add(store);
    expect(store.challengePlatform("invented")).toBe("android");
    for (const suffix of ["", "-wal", "-shm"]) {
      expect(existsSync(path + suffix)).toBe(true);
      expect(inspectWindowsPrivatePathSync(path + suffix, "file").private).toBe(true);
    }
    store.close();
    expect(readdirSync(directory)).toEqual(["relay.db"]);
    const reopened = open(path);
    expect(reopened.challengePlatform("invented")).toBe("android");
  });
  it("refuses an existing broad database without changing bytes or revoking stored state", () => {
    const path = join(root, "relay.db"),
      first = open(path);
    add(first);
    first.close();
    broaden(path);
    const before = readFileSync(path);
    expect(() => new RelayStore(path)).toThrow("Existing relay database files require private");
    expect(readFileSync(path)).toEqual(before);
    expect(inspectWindowsPrivatePathSync(path, "file").private).toBe(false);
    expect(readdirSync(root)).toEqual(["relay.db"]);
  });
  it.each(["-wal", "-shm"])(
    "refuses an unsafe live %s companion without changing the active archive",
    (suffix) => {
      const path = join(root, "relay.db"),
        first = open(path);
      add(first);
      expect(existsSync(path + suffix)).toBe(true);
      broaden(path + suffix);
      const before = readFileSync(path + suffix);
      expect(() => new RelayStore(path)).toThrow("Existing relay database files require private");
      expect(readFileSync(path + suffix)).toEqual(before);
      expect(first.challengePlatform("invented")).toBe("android");
      expect(inspectWindowsPrivatePathSync(path + suffix, "file").private).toBe(false);
      expect(readdirSync(root).some((name) => name.startsWith(".omnesis-inheritance-"))).toBe(
        false,
      );
    },
  );
  it("refuses a database file symlink without opening or modifying its private target", () => {
    const path = join(root, "target.db"),
      first = open(path);
    add(first);
    first.close();
    const alias = join(root, "alias.db"),
      before = readFileSync(path);
    symlinkSync(path, alias, "file");
    expect(() => new RelayStore(alias)).toThrow("Existing relay database files require private");
    expect(readFileSync(path)).toEqual(before);
    expect(open(path).challengePlatform("invented")).toBe("android");
    const names = readdirSync(root);
    expect(names).toContain("alias.db");
    expect(names).toContain("target.db");
    expect(
      names.some(
        (name) => name.startsWith("alias.db-") || name.startsWith(".omnesis-inheritance-"),
      ),
    ).toBe(false);
  });
});
