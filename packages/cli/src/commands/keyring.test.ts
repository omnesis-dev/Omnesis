// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { runCommand } from "citty";
import { afterEach, describe, expect, test } from "vitest";
import {
  ensureInstallRootKey,
  inspectStorageKey,
  readConfigSecretRefSync,
  type StorageKeyName,
} from "@omnesis/core";
import {
  collectSecretFileCandidates,
  keyringCommand,
  migrateInlineConfigApiKeys,
} from "./keyring.js";

const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function touch(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "secret\n", { mode: 0o600 });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("keyring command", () => {
  test("registers security-management subcommands", async () => {
    const sub = (await keyringCommand.subCommands) as Record<string, unknown>;
    expect(sub.migrate).toBeDefined();
    expect(sub["storage-status"]).toBeDefined();
    expect(sub["storage-init"]).toBeDefined();
  });

  test("collectSecretFileCandidates scans known credential and token paths", () => {
    const dir = tmp("omnesis-keyring-scan-");
    touch(join(dir, "token"));
    touch(join(dir, "collector-token"));
    touch(join(dir, "google-credentials.json"));
    touch(join(dir, "config-secrets", "aW5mZXJlbmNl.secret"));
    touch(join(dir, "google", "maya@example.com", "tokens.json"));
    touch(join(dir, "strava", "athlete-100", "tokens.json"));
    touch(join(dir, "plaid", "item-100", "item.json"));
    touch(join(dir, "enable-banking", "bank-100", "session.json"));
    touch(join(dir, "whatsapp", "+15550100001", "auth", "creds.json"));
    touch(join(dir, "whatsapp", "+15550100001", "auth", "session-user.json"));
    touch(join(dir, "notes", "not-a-secret.json"));
    // A pasted per-account credential — discovered by shape, not by a
    // hardcoded provider list, so a provider the list forgot is still secured.
    touch(join(dir, "granola", "maya.reeves@example.com", "credentials.json"));

    const rel = collectSecretFileCandidates(dir).map((p) => relative(dir, p).split("/").join("/"));

    expect(rel).toEqual([
      "collector-token",
      "config-secrets/aW5mZXJlbmNl.secret",
      "enable-banking/bank-100/session.json",
      "google-credentials.json",
      "google/maya@example.com/tokens.json",
      "granola/maya.reeves@example.com/credentials.json",
      "plaid/item-100/item.json",
      "strava/athlete-100/tokens.json",
      "token",
      "whatsapp/+15550100001/auth/creds.json",
      "whatsapp/+15550100001/auth/session-user.json",
    ]);
  });

  test("migrateInlineConfigApiKeys rewrites legacy HTTP backend apiKey values", async () => {
    const dir = tmp("omnesis-keyring-config-migrate-");
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    writeFileSync(
      join(dir, "omnesis.json"),
      JSON.stringify(
        {
          inference: {
            backends: {
              openai: {
                type: "http",
                url: "https://api.example.com",
                apiKey: "sk-inline",
              },
            },
          },
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );

    const result = migrateInlineConfigApiKeys(dir, { backend: "file" });
    expect(result).toEqual({
      configPresent: true,
      createdSecrets: 1,
      removedInlineKeys: 1,
    });

    const raw = readFileSync(join(dir, "omnesis.json"), "utf8");
    expect(raw).not.toContain("sk-inline");
    const parsed = JSON.parse(raw) as {
      inference?: { backends?: { openai?: { apiKey?: string; apiKeySecret?: string } } };
    };
    const backend = parsed.inference?.backends?.openai;
    expect(backend?.apiKey).toBeUndefined();
    expect(backend?.apiKeySecret).toMatch(/^config-secret:inference\.backend\./);
    expect(
      readConfigSecretRefSync(backend!.apiKeySecret!, { backend: "file", configDir: dir }),
    ).toBe("sk-inline");
  });

  test("migrateInlineConfigApiKeys tolerates loadable legacy configs with unknown keys", async () => {
    const dir = tmp("omnesis-keyring-config-legacy-");
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    writeFileSync(
      join(dir, "omnesis.json"),
      JSON.stringify(
        {
          removedTopLevelKnob: true,
          inference: {
            removedInferenceKnob: true,
            backends: {
              legacy: {
                type: "http",
                url: "https://models.example.com/v1",
                apiKey: "sk-legacy",
              },
            },
          },
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );

    const result = migrateInlineConfigApiKeys(dir, { backend: "file" });
    expect(result.removedInlineKeys).toBe(1);

    const raw = readFileSync(join(dir, "omnesis.json"), "utf8");
    expect(raw).not.toContain("removedTopLevelKnob");
    expect(raw).not.toContain("removedInferenceKnob");
    expect(raw).not.toContain("sk-legacy");
    const parsed = JSON.parse(raw) as {
      inference?: { backends?: { legacy?: { apiKeySecret?: string } } };
    };
    expect(parsed.inference?.backends?.legacy?.apiKeySecret).toMatch(/^config-secret:/);
  });
});

describe("keyring storage-init --host", () => {
  const presentKeys = async (dir: string, names: readonly StorageKeyName[]) => {
    const states = await Promise.all(
      names.map((name) => inspectStorageKey(name, { configDir: dir })),
    );
    return states.filter((state) => state.present).map((state) => state.keyName);
  };
  const ALL: readonly StorageKeyName[] = [
    "main-db",
    "index-db",
    "analytics-db",
    "watch2-db",
    "whatsapp-store",
    "imessage-transcripts",
  ];

  async function storageInit(dir: string, extra: string[]) {
    const prior = {
      config: process.env.OMNESIS_CONFIG_DIR,
      store: process.env.OMNESIS_SECRET_STORE,
    };
    process.env.OMNESIS_CONFIG_DIR = dir;
    process.env.OMNESIS_SECRET_STORE = "file";
    const log = console.log;
    console.log = () => {};
    try {
      await runCommand(keyringCommand, {
        rawArgs: ["storage-init", "--backend", "file", ...extra],
      });
    } finally {
      console.log = log;
      if (prior.config === undefined) delete process.env.OMNESIS_CONFIG_DIR;
      else process.env.OMNESIS_CONFIG_DIR = prior.config;
      if (prior.store === undefined) delete process.env.OMNESIS_SECRET_STORE;
      else process.env.OMNESIS_SECRET_STORE = prior.store;
    }
  }

  test("--host collector mints only the collector's provider-store keys", async () => {
    const dir = tmp("omnesis-keyring-host-");
    await storageInit(dir, ["--host", "collector"]);
    expect(await presentKeys(dir, ALL)).toEqual(["whatsapp-store", "imessage-transcripts"]);
  });

  test("a directory a collector has paired in is a collector host by default", async () => {
    const dir = tmp("omnesis-keyring-detect-");
    touch(join(dir, "collector-token"));
    await storageInit(dir, []);
    expect(await presentKeys(dir, ALL)).toEqual(["whatsapp-store", "imessage-transcripts"]);
  });

  test("a directory that serves nothing yet gets every key", async () => {
    const dir = tmp("omnesis-keyring-fresh-");
    await storageInit(dir, []);
    expect(await presentKeys(dir, ALL)).toEqual([...ALL]);
  });

  test("an unknown host is refused before any key is minted", async () => {
    const dir = tmp("omnesis-keyring-badhost-");
    await expect(storageInit(dir, ["--host", "phone"])).rejects.toThrow(/Invalid --host/u);
    expect(await presentKeys(dir, ALL)).toEqual([]);
  });
});
