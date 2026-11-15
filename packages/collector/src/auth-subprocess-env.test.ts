// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import {
  clearSecretFileKeyCacheForTests,
  ensureInstallRootKey,
  execWindowsJob,
  KEYRING_ENV_KEYS,
  ownedProcessCleanupReceipt,
  writeSecretTextFile,
} from "@omnesis/core";
import { authSubprocessEnvironment } from "./auth-subprocess-env.js";

test.each(["LOCALAPPDATA", "USERPROFILE", "SystemRoot", "WINDIR", "TEMP", "TMP"])(
  "Windows authentication retains the host's %s location with case-insensitive keys",
  (key) => {
    const result = authSubprocessEnvironment(
      "invented-config",
      { [key.toLowerCase()]: "C:\\invented host\\location" },
      "win32",
    );
    expect(result[key]).toBe("C:\\invented host\\location");
    expect(Object.keys(result).filter((name) => name.toLowerCase() === key.toLowerCase())).toEqual([
      key,
    ]);
  },
);

test("POSIX authentication retains its host context and excludes unrelated secrets and preloads", () => {
  const environment = {
    PATH: "/invented/bin",
    HOME: "/invented/home",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/invented/bus",
    XDG_RUNTIME_DIR: "/invented/runtime",
    LOCALAPPDATA: "invented-windows-data",
    AWS_SECRET_ACCESS_KEY: "unrelated-secret",
    NODE_OPTIONS: "--require /invented/preload.cjs",
    LD_PRELOAD: "/invented/preload.so",
    OMNESIS_LOG_FILE: "/invented/provider.log",
    OMNESIS_CONFIG_DIR: "/invented/wrong-config",
    OMNESIS_GATEWAY_URL: "https://gateway.example.test",
    ...Object.fromEntries(KEYRING_ENV_KEYS.map((key) => [key, `invented-${key}`])),
  };
  const result = authSubprocessEnvironment("/invented/config", environment, "linux");
  expect(result).toEqual({
    PATH: environment.PATH,
    HOME: environment.HOME,
    DBUS_SESSION_BUS_ADDRESS: environment.DBUS_SESSION_BUS_ADDRESS,
    XDG_RUNTIME_DIR: environment.XDG_RUNTIME_DIR,
    OMNESIS_CONFIG_DIR: "/invented/config",
    OMNESIS_GATEWAY_URL: environment.OMNESIS_GATEWAY_URL,
    ...Object.fromEntries(KEYRING_ENV_KEYS.map((key) => [key, `invented-${key}`])),
  });
});

test.skipIf(process.platform !== "win32")(
  "the real Windows auth environment opens an existing encrypted provider credential",
  { timeout: 60_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "omnesis-auth-environment-"));
    const secret = join(directory, "fixture.secret");
    let retained = false;
    try {
      clearSecretFileKeyCacheForTests();
      const opts = { backend: "file" as const, configDir: directory };
      await ensureInstallRootKey(opts);
      await writeSecretTextFile(secret, "fixture-token", opts);
      const env = authSubprocessEnvironment(directory, {
        ...process.env,
        OMNESIS_SECRET_STORE: "file",
      });
      const module = "@omnesis/core";
      const program = `import {readSecretTextFile} from ${JSON.stringify(module)};process.stdout.write(await readSecretTextFile(${JSON.stringify(secret)},{configDir:process.env.OMNESIS_CONFIG_DIR,backend:'file'}));`;
      const require = createRequire(import.meta.url);
      const loader = pathToFileURL(require.resolve("tsx/esm")).href;
      const result = await execWindowsJob(
        process.execPath,
        ["--import", loader, "--input-type=module", "-e", program],
        { env, timeout: 30_000, maxBuffer: 1024 * 1024 },
      );
      expect(result.stdout).toBe("fixture-token");
    } catch (error) {
      retained = ownedProcessCleanupReceipt(error) !== undefined;
      throw error;
    } finally {
      clearSecretFileKeyCacheForTests();
      if (!retained) rmSync(directory, { recursive: true, force: true });
    }
  },
);
