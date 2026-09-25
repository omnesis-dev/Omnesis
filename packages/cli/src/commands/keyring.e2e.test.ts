// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      "secret-tool": "#!/bin/sh\nexit 127\n",
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
    const path = join(dir, name);
    writeFileSync(path, content);
    chmodSync(path, 0o755);
  }
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
    PATH: fakeBin ? `${fakeBin}:${process.env.PATH ?? ""}` : process.env.PATH,
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
  const { stdout, stderr } = await execFileAsync("npx", ["tsx", CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    env,
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
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
  return `#!/bin/sh
set -eu
store="\${FAKE_SECRET_STORE:?}"
cmd="\${1:-}"
if [ "$cmd" = "-h" ]; then exit 0; fi
account=""
service=""
value=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -a) account="$2"; shift 2 ;;
    -s) service="$2"; shift 2 ;;
    -w)
      if [ "$cmd" = "add-generic-password" ]; then value="$2"; shift 2; else shift 1; fi ;;
    *) shift 1 ;;
  esac
done
file="$store/$service.$account"
case "$cmd" in
  find-generic-password)
    [ -f "$file" ] || exit 44
    cat "$file"
    ;;
  add-generic-password)
    mkdir -p "$store"
    printf "%s" "$value" > "$file"
    ;;
  delete-generic-password)
    rm -f "$file"
    ;;
  *)
    exit 2
    ;;
esac
`;
}

function fakeSecretToolScript(): string {
  return `#!/bin/sh
set -eu
store="\${FAKE_SECRET_STORE:?}"
cmd="\${1:-}"
shift || true
account=""
service=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --collection=login) shift 1 ;;
    --label) shift 2 ;;
    service) service="$2"; shift 2 ;;
    account) account="$2"; shift 2 ;;
    *) shift 1 ;;
  esac
done
file="$store/$service.$account"
case "$cmd" in
  lookup)
    if [ "$account" = "__omnesis_status_probe__" ]; then exit 0; fi
    [ -f "$file" ] || exit 1
    cat "$file"
    ;;
  store)
    mkdir -p "$store"
    cat > "$file"
    ;;
  clear)
    rm -f "$file"
    ;;
  *)
    exit 2
    ;;
esac
`;
}

function fakeBusctlScript(): string {
  return `#!/bin/sh
set -eu
args="$*"
if echo "$args" | grep -q "Collections"; then
  if [ "\${FAKE_SECRET_COLLECTIONS:-login}" = "login" ]; then
    echo 'ao 1 "/org/freedesktop/secrets/collection/login"'
  else
    echo 'ao 1 "/org/freedesktop/secrets/collection/session"'
  fi
  exit 0
fi
if echo "$args" | grep -q "Locked"; then
  if [ "\${FAKE_SECRET_LOGIN_LOCKED:-false}" = "true" ]; then echo "b true"; else echo "b false"; fi
  exit 0
fi
exit 2
`;
}
