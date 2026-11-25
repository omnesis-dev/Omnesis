// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { purgeConfigDirKeyring, type KeyringPurgeDeps } from "./keyring-purge.js";

const HOME = process.platform === "win32" ? String.raw`C:\AuditFixture\Home` : "/Users/maya";
const COLLECTOR = join(HOME, ".config", "omnesis-collector");
const DOCKER = join(HOME, ".config", "omnesis");

function deps(files: Record<string, string>, entries = ["omnesis", "omnesis-collector", "other"]) {
  const calls: string[] = [];
  const d: KeyringPurgeDeps = {
    listConfigParent: () => entries,
    exists: (path) => path in files,
    readText: (path) => files[path] ?? null,
    clearMarker: (kind, opts) => {
      calls.push(`marker ${kind} ${opts.configDir}`);
      return Promise.resolve();
    },
    deleteRootKey: () => {
      calls.push("root-key");
      return Promise.resolve(true);
    },
  };
  return { d, calls };
}

afterEach(() => vi.unstubAllEnvs());

describe("purgeConfigDirKeyring", () => {
  // The machine the coexistence was built for: a Docker install in ~/.config/omnesis
  // (passphrase keyring in its own directory) and the native collector.
  test("deletes the collector's markers and the root key, never counting the Docker install", async () => {
    const { d, calls } = deps({
      [join(DOCKER, "omnesis.json")]: "{}",
      [join(DOCKER, "keyring")]: "",
      [join(DOCKER, "install-method")]: "docker\n",
      [join(COLLECTOR, "keyring")]: "",
    });
    const result = await purgeConfigDirKeyring(HOME, COLLECTOR, d);
    expect(result.rootKey).toBe("deleted");
    expect(calls).toEqual([
      `marker storage-encryption ${COLLECTOR}`,
      `marker secret-files ${COLLECTOR}`,
      "root-key",
    ]);
  });

  test("keeps the root key while another native install uses it", async () => {
    const native = join(HOME, ".config", "omnesis-lab");
    const { d, calls } = deps(
      { [join(native, "omnesis.db")]: "", [join(COLLECTOR, "keyring")]: "" },
      ["omnesis-lab", "omnesis-collector"],
    );
    const result = await purgeConfigDirKeyring(HOME, COLLECTOR, d);
    expect(result).toMatchObject({ rootKey: "kept", keptFor: [native] });
    expect(calls).not.toContain("root-key");
    expect(calls).toContain(`marker secret-files ${COLLECTOR}`);
  });

  test("a directory without Omnesis files does not keep the key", async () => {
    const { d } = deps({}, ["omnesis-empty"]);
    expect((await purgeConfigDirKeyring(HOME, COLLECTOR, d)).rootKey).toBe("deleted");
  });

  test("a keyring that refuses is reported, not thrown", async () => {
    const { d } = deps({});
    d.deleteRootKey = () => Promise.reject(new Error("the keychain is locked"));
    const result = await purgeConfigDirKeyring(HOME, COLLECTOR, d);
    expect(result.rootKey).toBe("kept");
    expect(result.notes.join(" ")).toContain("the keychain is locked");
  });

  test("keeps an unowned custom service root while clearing only its markers", async () => {
    vi.stubEnv("OMNESIS_SECRET_SERVICE", "dev.omnesis.desktop.example");
    const { d, calls } = deps({});
    const services: Array<string | undefined> = [];
    d.clearMarker = (_kind, options) => {
      services.push(options.service);
      return Promise.resolve();
    };
    const result = await purgeConfigDirKeyring(HOME, COLLECTOR, d);
    expect(result.rootKey).toBe("kept");
    expect(services).toEqual(["dev.omnesis.desktop.example", "dev.omnesis.desktop.example"]);
    expect(calls).not.toContain("root-key");
  });

  test("an exclusively owned custom scope can purge without touching a headless key", async () => {
    const { d } = deps({ [join(DOCKER, "omnesis.json")]: "{}" });
    const deleted: Array<string | undefined> = [];
    d.deleteRootKey = async (options) => {
      deleted.push(options.service);
      return true;
    };
    const result = await purgeConfigDirKeyring(HOME, COLLECTOR, d, {
      service: "dev.omnesis.desktop.example",
      exclusiveService: true,
    });
    expect(result.rootKey).toBe("deleted");
    expect(deleted).toEqual(["dev.omnesis.desktop.example"]);
  });
});
