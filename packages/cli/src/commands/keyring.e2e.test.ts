// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import {
  encryptArtifactFileInPlace,
  isEncryptedSecretFile,
  readConfigSecretRefSync,
} from "@omnesis/core";

const execFileAsync = promisify(execFile);
const TSX_ENTRY = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const REPO_ROOT = join(import.meta.dirname, "../../../..");
const CLI_ENTRY = "packages/cli/src/index.ts";
const CLI_TIMEOUT_MS = 30_000;

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("keyring CLI process coverage", () => {
  test("macOS Keychain backend can initialize and report a root key via fake security CLI", async () => {
    const configDir = tmp("omnesis-keyring-e2e-macos-");
    const fake = fakeBinDir({
      security: fakeSecurityScript(),
    });
    const env = cliEnv(configDir, fake, {
      OMNESIS_SECRET_STORE: "macos-keychain",
      FAKE_SECRET_STORE: join(configDir, "fake-keychain"),
    });

    const init = await runCli(["keyring", "init", "--json"], env);
    expect(init.exitCode, init.stderr).toBe(0);
    const initialized = JSON.parse(init.stdout) as { store: { backend: string }; valid: boolean };
    expect(initialized.store.backend).toBe("macos-keychain");
    expect(initialized.valid).toBe(true);

    const status = await runCli(["keyring", "status", "--json"], env);
    const state = JSON.parse(status.stdout) as { store: { secure: boolean }; valid: boolean };
    expect(state.store.secure).toBe(true);
    expect(state.valid).toBe(true);
  });

  test("Linux Secret Service backend initializes when a durable login collection exists", async () => {
    const configDir = tmp("omnesis-keyring-e2e-linux-");
    const fake = fakeBinDir({
      "secret-tool": fakeSecretToolScript(),
      busctl: fakeBusctlScript(),
    });
    const env = cliEnv(configDir, fake, {
      OMNESIS_SECRET_STORE: "secret-service",
      FAKE_SECRET_STORE: join(configDir, "fake-secret-service"),
      FAKE_SECRET_COLLECTIONS: "login",
      FAKE_SECRET_LOGIN_LOCKED: "false",
    });

    const init = await runCli(["keyring", "init", "--json"], env);
    expect(init.exitCode, init.stderr).toBe(0);
    const initialized = JSON.parse(init.stdout) as { store: { backend: string }; valid: boolean };
    expect(initialized.store.backend).toBe("secret-service");
    expect(initialized.valid).toBe(true);
  });

  test("Linux transient-only Secret Service refuses initialization", async () => {
    const configDir = tmp("omnesis-keyring-e2e-session-only-");
    const fake = fakeBinDir({
      "secret-tool": fakeSecretToolScript(),
      busctl: fakeBusctlScript(),
    });
    const env = cliEnv(configDir, fake, {
      OMNESIS_SECRET_STORE: "secret-service",
      FAKE_SECRET_STORE: join(configDir, "fake-secret-service"),
      FAKE_SECRET_COLLECTIONS: "session",
      FAKE_SECRET_LOGIN_LOCKED: "false",
    });

    const status = await runCli(["keyring", "status", "--json"], env);
    expect(status.exitCode, status.stderr).toBe(0);
    const state = JSON.parse(status.stdout) as {
      store: { available: boolean; detail: string };
      valid: boolean;
    };
    expect(state.store.available).toBe(false);
    expect(state.store.detail).toMatch(/persistent login collection/);
    expect(state.valid).toBe(false);

    const init = await execCli(["keyring", "init", "--json"], env).catch(errToCliResult);
    expect(init.exitCode).not.toBe(0);
    expect(init.stderr + init.stdout).toMatch(/persistent login collection/);
  });

  test("no-keyring Linux state reports unavailable without blocking status", async () => {
    const configDir = tmp("omnesis-keyring-e2e-none-");
    const fake = fakeBinDir({
      "secret-tool": "process.exit(127);\n",
    });
    const env = cliEnv(configDir, fake, { OMNESIS_SECRET_STORE: "secret-service" });

    const status = await runCli(["keyring", "status", "--json"], env);
    expect(status.exitCode, status.stderr).toBe(0);
    const state = JSON.parse(status.stdout) as {
      store: { available: boolean; secure: boolean };
      valid: boolean;
    };
    expect(state.store.available).toBe(false);
    expect(state.store.secure).toBe(false);
    expect(state.valid).toBe(false);
  });

  test("legacy plaintext migration encrypts token files and rewrites inline config API keys", async () => {
    const configDir = tmp("omnesis-keyring-e2e-migrate-");
    writeFileSync(join(configDir, "token"), "legacy-token\n", { mode: 0o600 });
    writeFileSync(
      join(configDir, "omnesis.json"),
      JSON.stringify(
        {
          inference: {
            backends: {
              example: {
                type: "http",
                url: "https://models.example.com/v1",
                apiKey: "sk-legacy-inline",
              },
            },
          },
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );

    const env = cliEnv(configDir, null, { OMNESIS_SECRET_STORE: "file" });
    expect((await runCli(["keyring", "init", "--json"], env)).exitCode).toBe(0);
    const migrate = await runCli(["keyring", "migrate", "--json"], env);
    expect(migrate.exitCode, migrate.stderr).toBe(0);
    const summary = JSON.parse(migrate.stdout) as {
      encrypted: number;
      inlineConfigApiKeysMigrated: number;
      inlineConfigApiKeysRemoved: number;
    };
    expect(summary.encrypted).toBeGreaterThanOrEqual(1);
    expect(summary.inlineConfigApiKeysMigrated).toBe(1);
    expect(summary.inlineConfigApiKeysRemoved).toBe(1);

    const tokenRaw = readFileSync(join(configDir, "token"), "utf8");
    expect(isEncryptedSecretFile(tokenRaw)).toBe(true);
    expect(tokenRaw).not.toContain("legacy-token");

    const configRaw = readFileSync(join(configDir, "omnesis.json"), "utf8");
    expect(configRaw).not.toContain("sk-legacy-inline");
    const config = JSON.parse(configRaw) as {
      inference?: { backends?: { example?: { apiKey?: string; apiKeySecret?: string } } };
    };
    const backend = config.inference?.backends?.example;
    expect(backend?.apiKey).toBeUndefined();
    expect(backend?.apiKeySecret).toMatch(/^config-secret:/);
    expect(readConfigSecretRefSync(backend!.apiKeySecret!, { backend: "file", configDir })).toBe(
      "sk-legacy-inline",
    );
  });

  test("artifact decrypt command restores encrypted backup/export files", async () => {
    const configDir = tmp("omnesis-keyring-e2e-artifact-");
    const env = cliEnv(configDir, null, { OMNESIS_SECRET_STORE: "file" });
    expect((await runCli(["keyring", "init", "--json"], env)).exitCode).toBe(0);

    const artifact = join(configDir, "documents.jsonl");
    writeFileSync(artifact, '{"title":"Example document"}\n', { mode: 0o600 });
    const encrypted = await encryptArtifactFileInPlace(artifact, {
      backend: "file",
      configDir,
      scope: "export:e2e-documents",
    });

    const decrypted = await runCli(["keyring", "decrypt-artifact", encrypted.path, "--json"], env);
    expect(decrypted.exitCode, decrypted.stderr).toBe(0);
    const summary = JSON.parse(decrypted.stdout) as { decrypted: number; outputs: string[] };
    expect(summary.decrypted).toBe(1);
    expect(summary.outputs).toEqual([artifact]);
    expect(readFileSync(artifact, "utf8")).toBe('{"title":"Example document"}\n');
  });
});

function fakeBinDir(scripts: Record<string, string>): string {
  const dir = tmp("omnesis-keyring-e2e-bin-");
  for (const [name, content] of Object.entries(scripts)) {
    writeFileSync(join(dir, `${name}.cjs`), content);
  }
  // Replace only the executable boundary, retaining the real secret-store
  // protocols and CLI process. Node fixtures work without an OS shell.
  writeFileSync(
    join(dir, "fixture-loader.mjs"),
    `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const fixtures = new Set(${JSON.stringify(Object.keys(scripts))});
const directory = ${JSON.stringify(dir)};
for (const method of ['spawn', 'spawnSync']) {
  const native = childProcess[method];
  childProcess[method] = function(command, args, options) {
    return fixtures.has(command)
      ? native(process.execPath, [join(directory, command + '.cjs'), ...args], options)
      : native(command, args, options);
  };
}
syncBuiltinESMExports();
`,
  );
  return dir;
}

function cliEnv(
  configDir: string,
  fakeBin: string | null,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    OMNESIS_CONFIG_DIR: configDir,
    NO_COLOR: "1",
    CI: "1",
    OMNESIS_KEYRING_TEST_FIXTURES: fakeBin ?? undefined,
  };
}

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  try {
    return await execCli(args, env);
  } catch (err) {
    const r = errToCliResult(err);
    throw new Error(
      `cli ${args.join(" ")} exited ${r.exitCode}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
      { cause: err },
    );
  }
}

async function execCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  const fixtureImports = env.OMNESIS_KEYRING_TEST_FIXTURES
    ? [
        "--import",
        pathToFileURL(join(env.OMNESIS_KEYRING_TEST_FIXTURES, "fixture-loader.mjs")).href,
      ]
    : [];
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["--import", TSX_ENTRY, ...fixtureImports, CLI_ENTRY, ...args],
    {
      cwd: REPO_ROOT,
      env,
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return { stdout, stderr, exitCode: 0 };
}

function errToCliResult(err: unknown): CliResult {
  const e = err as { stdout?: string; stderr?: string; code?: number | string };
  return {
    stdout: typeof e.stdout === "string" ? e.stdout : "",
    stderr: typeof e.stderr === "string" ? e.stderr : "",
    exitCode: typeof e.code === "number" ? e.code : Number(e.code ?? -1),
  };
}

function fakeSecurityScript(): string {
  return `const fs = require('node:fs'), path = require('node:path');
const [command, ...args] = process.argv.slice(2);
if (command === '-h') process.exit(0);
let account = '', service = '', value = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-a') account = args[++i];
  else if (args[i] === '-s') service = args[++i];
  else if (args[i] === '-w' && command === 'add-generic-password') value = args[++i];
}
const root = process.env.FAKE_SECRET_STORE;
const file = path.join(root, service + '.' + account);
if (command === 'find-generic-password') {
  if (!fs.existsSync(file)) process.exit(44);
  process.stdout.write(fs.readFileSync(file));
} else if (command === 'add-generic-password') {
  fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(file, value);
} else if (command === 'delete-generic-password') fs.rmSync(file, { force: true });
else process.exit(2);
`;
}

function fakeSecretToolScript(): string {
  return `const fs = require('node:fs'), path = require('node:path');
const [command, ...args] = process.argv.slice(2);
let account = '', service = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--label') i++;
  else if (args[i] === 'service') service = args[++i];
  else if (args[i] === 'account') account = args[++i];
}
const root = process.env.FAKE_SECRET_STORE;
const file = path.join(root, service + '.' + account);
if (command === 'lookup') {
  if (account === '__omnesis_status_probe__') process.exit(0);
  if (!fs.existsSync(file)) process.exit(1);
  process.stdout.write(fs.readFileSync(file));
} else if (command === 'store') {
  fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(file, fs.readFileSync(0));
} else if (command === 'clear') fs.rmSync(file, { force: true });
else process.exit(2);
`;
}

function fakeBusctlScript(): string {
  return `const args = process.argv.slice(2);
if (args.includes('Collections')) {
  const collection = process.env.FAKE_SECRET_COLLECTIONS === 'session' ? 'session' : 'login';
  process.stdout.write('ao 1 "/org/freedesktop/secrets/collection/' + collection + '"');
} else if (args.includes('Locked')) process.stdout.write('b ' + (process.env.FAKE_SECRET_LOGIN_LOCKED === 'true' ? 'true' : 'false'));
else process.exit(2);
`;
}
