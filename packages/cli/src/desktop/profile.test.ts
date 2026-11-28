// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { desktopEnvironment, desktopProfile, recommendDesktopResources } from "./profile.js";
import { desktopExecutableDirectories, initializeDesktopEnvironment } from "./environment.js";

describe("desktop isolation", () => {
  it("selects the managed directory before configuration modules load", () => {
    const env = {
      OMNESIS_CONFIG_DIR: "/unrelated/headless",
      OMNESIS_TOKEN: "unrelated-headless-token",
      OMNESIS_INSECURE_TLS: "1",
      NODE_USE_SYSTEM_CA: "1",
      NODE_EXTRA_CA_CERTS: "/unrelated/headless/tls/cert.pem",
      NODE_OPTIONS: "--require /unrelated/loader.cjs",
      OPENAI_API_KEY: "unrelated-inference-key",
      PATH: "/fictional/bin",
    } as NodeJS.ProcessEnv;
    const profile = initializeDesktopEnvironment(env, "/fictional/home");
    expect(env.OMNESIS_CONFIG_DIR).toBe(profile.configDir);
    expect(env.OMNESIS_DESKTOP_MANAGED).toBe("1");
    expect(env.OMNESIS_TOKEN).toBeUndefined();
    expect(env.OMNESIS_INSECURE_TLS).toBeUndefined();
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(env.NODE_USE_SYSTEM_CA).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OMNESIS_SECRET_SERVICE).toBe(profile.secretService);
    expect(env.PATH?.split(delimiter)).toEqual([dirname(process.execPath), "/fictional/bin"]);
  });
  it("does not inherit proxy interception of loopback credentials or foreign loaders", () => {
    const keys = [
      "NODE_USE_ENV_PROXY",
      "CODEX_HOME",
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_AUTH_TOKEN",
      "OPENSSL_CONF",
      "OPENSSL_MODULES",
      "NODE_COMPILE_CACHE",
      "NODE_PATH",
      "NODE_REPL_EXTERNAL_MODULE",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "DYLD_INSERT_LIBRARIES",
      "INVENTED_API_KEY",
    ];
    const parent: NodeJS.ProcessEnv = Object.fromEntries(
      keys.map((key) => [key, "inherited-authority"]),
    );
    parent.HERDR_PANE_ID = "fixture-pane";
    const env = desktopEnvironment(desktopProfile("/fictional/home"), parent);
    for (const key of keys) expect(env[key]).toBeUndefined();
    initializeDesktopEnvironment(parent, "/fictional/home");
    for (const key of keys) expect(parent[key]).toBeUndefined();
    expect(parent.HERDR_PANE_ID).toBe("fixture-pane");
  });

  it("uses a stable exclusive namespace for each home", () => {
    const first = desktopProfile("/fictional/first");
    expect(first).toEqual(desktopProfile("/fictional/first/../first"));
    const second = desktopProfile("/fictional/second");
    expect(first.configDir).not.toContain(".config/omnesis");
    expect(first.instance).not.toEqual(second.instance);
    expect(first.secretService).not.toEqual(second.secretService);
  });

  it("discards inherited headless identity and authority while preserving host admission", () => {
    const profile = desktopProfile("/fictional/home");
    const env = desktopEnvironment(profile, {
      PATH: "/example/bin",
      HERDR_PANE_ID: "test-pane",
      OMNESIS_TOKEN: "headless-credential",
      OMNESIS_CONFIG_DIR: "/unrelated",
      OMNESIS_GATEWAY_URL: "https://headless.example.org",
      OMNESIS_CLOUD_RELAY_DEVICE_FILE: "/unrelated/device.json",
      OMNESIS_KEYRING_PASSPHRASE: "unrelated-passphrase",
      OMNESIS_TEST_SCHEDULER: "0",
    });
    expect(env.OMNESIS_TOKEN).toBeUndefined();
    expect(env.OMNESIS_GATEWAY_URL).toBeUndefined();
    expect(env.OMNESIS_KEYRING_PASSPHRASE).toBeUndefined();
    expect(env.OMNESIS_CLOUD_RELAY_DEVICE_FILE).toBeUndefined();
    expect(env.OMNESIS_TEST_SCHEDULER).toBeUndefined();
    expect(env.OMNESIS_SECRET_SERVICE).toBe(profile.secretService);
    expect(env.OMNESIS_CONFIG_DIR).toBe(profile.configDir);
    expect(env.HERDR_PANE_ID).toBe("test-pane");
    expect(env.PATH?.split(delimiter)).toEqual([dirname(process.execPath), "/example/bin"]);
  });
});

describe("desktop resource recommendation", () => {
  it("keeps a bounded fraction of system memory and selects a small local model", () => {
    const small = recommendDesktopResources(2 * 1024 ** 3);
    const large = recommendDesktopResources(64 * 1024 ** 3);
    expect(small.memoryLimitMb).toBe(512);
    expect(large.memoryLimitMb).toBe(4096);
    expect(small.embedder.minRamGb).toBeLessThanOrEqual(0.5);
    expect(small.embedder.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(large.embedder.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(small.embedder.sizeBytes).toBeLessThan(large.embedder.sizeBytes);
    expect(large.embedder.recommended).toBe(true);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 512 * 1024 ** 2])(
    "refuses an unusable memory reading %s",
    (memory) => expect(() => recommendDesktopResources(memory)).toThrow(/memory/),
  );
});

it("only a complete packaged launcher layout puts guarded env-node before the raw binary", () => {
  const root = mkdtempSync(join(tmpdir(), "omnesis-guard-path-"));
  const bin = join(root, "bin");
  try {
    mkdirSync(bin);
    writeFileSync(join(bin, "node"), "guarded node shim");
    expect(desktopExecutableDirectories(join(root, "node"))).toEqual([root]);
    writeFileSync(join(root, "runtime-exec"), "native launcher fixture");
    expect(desktopExecutableDirectories(join(root, "node"))).toEqual([bin, root]);
    rmSync(join(bin, "node"));
    expect(desktopExecutableDirectories(join(root, "node"))).toEqual([root]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
