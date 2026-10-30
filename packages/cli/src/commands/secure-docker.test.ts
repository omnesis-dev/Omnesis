// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis secure` inside a Docker install, against real temp config
 * directories laid out the way the installer lays them out: the passphrase
 * file it generates and records where the containers read it, the order of
 * the steps around it, the restart it leaves to the host launcher (or names
 * when there is none), a host that only collects, and the refusals that keep
 * the daemons from being handed a keyring they cannot open.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  acquireGatewayLock,
  clearSecretFileKeyCacheForTests,
  inspectInstallRootKey,
  isEncryptedSecretFile,
  readSecretTextFile,
} from "@omnesis/core";
import { detectDockerContext } from "../docker-install.js";
import { runSecure, runVerify, type SecureDeps } from "./secure.js";
import {
  dockerSecureBackend,
  dockerSecureContext,
  planDockerPassphrase,
  SECURE_RESTART_REQUEST_FILE,
} from "./secure-docker.js";

const ENV_KEYS = [
  "OMNESIS_SECRET_STORE",
  "OMNESIS_KEYRING_PASSPHRASE_FILE",
  "OMNESIS_KEYRING_PASSPHRASE",
  "OMNESIS_DOCKER_HOST_RESTART",
] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;
const dirs: string[] = [];

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  clearSecretFileKeyCacheForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  clearSecretFileKeyCacheForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const GATEWAY_AND_COLLECTOR = `name: omnesis
services:
  gateway:
    image: "ghcr.io/omnesis-dev/omnesis-gateway:\${OMNESIS_IMAGE_TAG}"
  collector:
    image: "ghcr.io/omnesis-dev/omnesis-collector:\${OMNESIS_IMAGE_TAG}"
  updater:
    profiles: ["update"]
`;
const COMBINED = `name: omnesis
services:
  gateway:
    image: "ghcr.io/omnesis-dev/omnesis-combined:\${OMNESIS_IMAGE_TAG}"
  updater:
    profiles: ["update"]
`;
const COLLECTOR_ONLY = `name: omnesis
services:
  collector:
    image: "ghcr.io/omnesis-dev/omnesis-collector:\${OMNESIS_IMAGE_TAG}"
  updater:
    profiles: ["update"]
`;

/** A Docker install's config directory, as the installer leaves it. */
function dockerProject(compose: string): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-secure-docker-"));
  dirs.push(dir);
  writeFileSync(join(dir, "install-method"), "docker\n");
  writeFileSync(join(dir, "docker-compose.yml"), compose);
  writeFileSync(join(dir, ".env"), "OMNESIS_IMAGE_TAG=9.9.0\n");
  return dir;
}

function plaintextDb(path: string): void {
  const db = new Database(path);
  db.exec("CREATE TABLE items (val TEXT)");
  db.prepare("INSERT INTO items (val) VALUES (?)").run("alpha");
  db.close();
}

/** What a booted gateway leaves after encrypting: no SQLite header. */
function encryptedLookingDb(path: string): void {
  writeFileSync(path, Buffer.alloc(4096, 7));
}

/** A gateway host's directory: corpus, admin token, a collector beside it, a credential. */
function gatewayHost(compose = GATEWAY_AND_COLLECTOR): string {
  const dir = dockerProject(compose);
  plaintextDb(join(dir, "omnesis.db"));
  writeFileSync(join(dir, "token"), "omn_fictional_admin_token", { mode: 0o600 });
  writeFileSync(join(dir, "collector-token"), "omn_fictional_collector_token", { mode: 0o600 });
  writeFileSync(join(dir, "example-credentials.json"), '{"client_id":"fictional-client"}', {
    mode: 0o600,
  });
  return dir;
}

function deps(configDir: string, overrides: Partial<SecureDeps> = {}): SecureDeps {
  const docker = dockerSecureContext(configDir);
  return {
    configDir,
    backend: dockerSecureBackend(undefined),
    docker,
    gatewayHealthy: async () => false,
    onlineBackup: vi.fn(async () => {}),
    restartService: vi.fn(async () => "restarted" as const),
    now: () => new Date("2026-06-01T10:00:00.000Z"),
    log: () => {},
    ...overrides,
  };
}

const stepIds = (steps: Array<{ id: string }>) => steps.map((s) => s.id);
const step = (steps: Array<{ id: string; status: string; detail: string }>, id: string) =>
  steps.find((s) => s.id === id);

describe("secure under Docker: the launcher restarts the containers", () => {
  test("generates the passphrase file, records it, seals everything, and asks for the restart", async () => {
    const configDir = gatewayHost();
    process.env.OMNESIS_DOCKER_HOST_RESTART = "1";
    const d = deps(configDir);
    expect(d.backend).toBe("passphrase");

    const summary = await runSecure(d, { dryRun: false, skipBackup: false });

    // Native's safety order: the backup first, then the passphrase is
    // recorded where the containers read it, before anything is sealed.
    expect(stepIds(summary.steps)).toEqual([
      "backup",
      "passphrase",
      "root-key",
      "escrow",
      "migrate",
      "storage-keys",
      "restart",
    ]);
    const passFile = join(configDir, "keyring.pass");
    expect(statSync(passFile).mode & 0o777).toBe(0o600);
    // The installer's format: 32 random bytes, base64url.
    expect(readFileSync(passFile, "utf8")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const envFile = readFileSync(join(configDir, ".env"), "utf8");
    expect(envFile).toContain("OMNESIS_IMAGE_TAG=9.9.0");
    expect(envFile).toContain("OMNESIS_SECRET_STORE=passphrase");
    expect(envFile).toContain(`OMNESIS_KEYRING_PASSPHRASE_FILE=${passFile}`);

    expect(summary.backupDir).toBeTruthy();
    expect(summary.recoveryCode).toBeTruthy();
    await expect(
      inspectInstallRootKey({ backend: "passphrase", configDir }),
    ).resolves.toMatchObject({ valid: true });
    for (const name of ["token", "collector-token", "example-credentials.json"]) {
      expect(isEncryptedSecretFile(readFileSync(join(configDir, name), "utf8"))).toBe(true);
    }
    await expect(
      readSecretTextFile(join(configDir, "example-credentials.json"), { configDir }),
    ).resolves.toContain("fictional-client");

    // The restart is the host's: both containers read the new keyring.
    expect(readFileSync(join(configDir, SECURE_RESTART_REQUEST_FILE), "utf8")).toBe(
      "gateway\ncollector\n",
    );
    expect(step(summary.steps, "restart")?.status).toBe("planned");
    expect(d.restartService).not.toHaveBeenCalled();
  });

  test("a dry run describes that plan and writes nothing", async () => {
    const configDir = gatewayHost();
    process.env.OMNESIS_DOCKER_HOST_RESTART = "1";
    const before = readFileSync(join(configDir, ".env"), "utf8");

    const summary = await runSecure(deps(configDir), { dryRun: true, skipBackup: false });

    expect(step(summary.steps, "passphrase")?.detail).toContain(
      `generate ${join(configDir, "keyring.pass")} (owner-only)`,
    );
    expect(step(summary.steps, "root-key")).toMatchObject({ status: "planned" });
    expect(step(summary.steps, "restart")?.detail).toBe(
      "restart gateway and collector from this machine, then verify the databases are encrypted",
    );
    expect(existsSync(join(configDir, "keyring.pass"))).toBe(false);
    expect(existsSync(join(configDir, "keyring"))).toBe(false);
    expect(existsSync(join(configDir, "backups"))).toBe(false);
    expect(existsSync(join(configDir, SECURE_RESTART_REQUEST_FILE))).toBe(false);
    expect(readFileSync(join(configDir, ".env"), "utf8")).toBe(before);
  });

  test("a combined container is one service to restart", async () => {
    const configDir = gatewayHost(COMBINED);
    process.env.OMNESIS_DOCKER_HOST_RESTART = "1";
    await runSecure(deps(configDir), { dryRun: false, skipBackup: true });
    expect(readFileSync(join(configDir, SECURE_RESTART_REQUEST_FILE), "utf8")).toBe("gateway\n");
  });

  test("a re-run over a secured install changes nothing and restarts nothing", async () => {
    const configDir = gatewayHost();
    process.env.OMNESIS_DOCKER_HOST_RESTART = "1";
    await runSecure(deps(configDir), { dryRun: false, skipBackup: true });
    rmSync(join(configDir, SECURE_RESTART_REQUEST_FILE));
    const passphrase = readFileSync(join(configDir, "keyring.pass"), "utf8");
    encryptedLookingDb(join(configDir, "omnesis.db"));
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.OMNESIS_DOCKER_HOST_RESTART = "1";
    clearSecretFileKeyCacheForTests();
    // The CLI loads the .env the first run wrote, as every process does.
    process.env.OMNESIS_SECRET_STORE = "passphrase";
    process.env.OMNESIS_KEYRING_PASSPHRASE_FILE = join(configDir, "keyring.pass");

    const again = await runSecure(deps(configDir), { dryRun: false, skipBackup: true });

    expect(step(again.steps, "passphrase")?.status).toBe("skipped");
    expect(step(again.steps, "restart")).toMatchObject({
      status: "skipped",
      detail: "encryption at rest is already in effect",
    });
    expect(again.recoveryCode).toBeUndefined();
    expect(readFileSync(join(configDir, "keyring.pass"), "utf8")).toBe(passphrase);
    expect(existsSync(join(configDir, SECURE_RESTART_REQUEST_FILE))).toBe(false);
  });

  test("a passphrase file left by an earlier run is used, not replaced", async () => {
    const configDir = gatewayHost();
    writeFileSync(join(configDir, "keyring.pass"), "fictional-earlier-passphrase", {
      mode: 0o600,
    });
    expect(planDockerPassphrase(detectDockerContext(configDir)!, configDir)).toEqual({
      kind: "reuse",
      file: join(configDir, "keyring.pass"),
    });
    await runSecure(deps(configDir), { dryRun: false, skipBackup: true });
    expect(readFileSync(join(configDir, "keyring.pass"), "utf8")).toBe(
      "fictional-earlier-passphrase",
    );
    expect(readFileSync(join(configDir, ".env"), "utf8")).toContain(
      "OMNESIS_SECRET_STORE=passphrase",
    );
  });
});

describe("secure under Docker: a gateway that is still starting", () => {
  test("is waited for, and backed up online, rather than copied under its feet", async () => {
    const configDir = gatewayHost();
    // The lock names another live process, as a booting gateway's does: a
    // record naming this test's own process reads as a stale one.
    const gateway = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      stdio: "ignore",
    });
    const lock = await acquireGatewayLock(configDir, { pid: gateway.pid });
    try {
      let probes = 0;
      const d = deps(configDir, { gatewayHealthy: async () => ++probes > 2 });
      const summary = await runSecure(d, {
        dryRun: false,
        skipBackup: false,
        startWaitMs: 30_000,
      });
      expect(d.onlineBackup).toHaveBeenCalledWith("pre-secure");
      expect(step(summary.steps, "backup")?.detail).toContain("online backup");
    } finally {
      lock.release();
      gateway.kill();
    }
  });

  test("a backup failure leaves what the containers read untouched", async () => {
    const configDir = gatewayHost();
    const before = readFileSync(join(configDir, ".env"), "utf8");
    const d = deps(configDir, {
      gatewayHealthy: async () => true,
      onlineBackup: vi.fn(async () => {
        throw new Error("fictional backup failure");
      }),
    });
    await expect(runSecure(d, { dryRun: false, skipBackup: false })).rejects.toThrow(
      "fictional backup failure",
    );
    expect(readFileSync(join(configDir, ".env"), "utf8")).toBe(before);
    expect(existsSync(join(configDir, "keyring"))).toBe(false);
  });
});

describe("secure under Docker: a launcher that predates the restart", () => {
  test("names the exact host command and the check that follows it", async () => {
    const configDir = gatewayHost();

    const summary = await runSecure(deps(configDir), { dryRun: false, skipBackup: true });

    expect(step(summary.steps, "restart")).toMatchObject({
      status: "action-required",
      detail:
        `restart gateway and collector from this machine with ` +
        `\`docker compose -f ${join(configDir, "docker-compose.yml")} restart gateway collector\`, ` +
        "then check with `omnesis secure --verify`",
    });
    expect(existsSync(join(configDir, SECURE_RESTART_REQUEST_FILE))).toBe(false);
    // Everything before the restart happened all the same.
    expect(readFileSync(join(configDir, ".env"), "utf8")).toContain(
      "OMNESIS_SECRET_STORE=passphrase",
    );
    expect(summary.recoveryCode).toBeTruthy();
  });
});

describe("secure under Docker: a host that only collects", () => {
  test("keeps the passphrase beside the compose file and restarts the collector", async () => {
    const projectDir = dockerProject(COLLECTOR_ONLY);
    const configDir = join(projectDir, "collector");
    mkdirSync(configDir, { mode: 0o700 });
    writeFileSync(join(configDir, "collector-token"), "omn_fictional_collector_token", {
      mode: 0o600,
    });
    process.env.OMNESIS_DOCKER_HOST_RESTART = "1";
    const d = deps(configDir);
    expect(d.docker).toMatchObject({ projectDir, collectorOnly: true, services: ["collector"] });

    const summary = await runSecure(d, { dryRun: false, skipBackup: false });

    const passFile = join(projectDir, "keyring.pass");
    expect(existsSync(passFile)).toBe(true);
    // The collector container loads its own directory's .env; the compose
    // directory's carries it too, as the installer writes it.
    for (const envDir of [configDir, projectDir]) {
      expect(readFileSync(join(envDir, ".env"), "utf8")).toContain(
        `OMNESIS_KEYRING_PASSPHRASE_FILE=${passFile}`,
      );
    }
    expect(step(summary.steps, "backup")?.status).toBe("skipped");
    expect(isEncryptedSecretFile(readFileSync(join(configDir, "collector-token"), "utf8"))).toBe(
      true,
    );
    expect(readFileSync(join(projectDir, SECURE_RESTART_REQUEST_FILE), "utf8")).toBe("collector\n");
  });
});

describe("secure under Docker: what the containers could not read is refused", () => {
  test("a passphrase file outside the mounted config directory", async () => {
    const configDir = gatewayHost();
    const elsewhere = mkdtempSync(join(tmpdir(), "omnesis-elsewhere-"));
    dirs.push(elsewhere);
    writeFileSync(join(elsewhere, "pass"), "fictional", { mode: 0o600 });
    process.env.OMNESIS_KEYRING_PASSPHRASE_FILE = join(elsewhere, "pass");
    await expect(runSecure(deps(configDir), { dryRun: false, skipBackup: true })).rejects.toThrow(
      /outside .*the one directory the containers see/u,
    );
    expect(existsSync(join(configDir, "keyring"))).toBe(false);
  });

  test("an inline passphrase exported for this one command", async () => {
    const configDir = gatewayHost();
    process.env.OMNESIS_KEYRING_PASSPHRASE = "fictional-inline";
    await expect(runSecure(deps(configDir), { dryRun: true, skipBackup: true })).rejects.toThrow(
      /reaches this command only/u,
    );
  });

  test("a passphrase file inside it is recorded where the containers read it", async () => {
    const configDir = gatewayHost();
    const own = join(configDir, "my.pass");
    writeFileSync(own, "fictional-operator-passphrase", { mode: 0o600 });
    process.env.OMNESIS_KEYRING_PASSPHRASE_FILE = own;
    await runSecure(deps(configDir), { dryRun: false, skipBackup: true });
    expect(existsSync(join(configDir, "keyring.pass"))).toBe(false);
    expect(readFileSync(join(configDir, ".env"), "utf8")).toContain(
      `OMNESIS_KEYRING_PASSPHRASE_FILE=${own}`,
    );
  });
});

describe("secure --verify", () => {
  test("passes once the gateway is back with encrypted databases, and names what is left otherwise", async () => {
    const configDir = gatewayHost();
    process.env.OMNESIS_DOCKER_HOST_RESTART = "1";
    await runSecure(deps(configDir), { dryRun: false, skipBackup: true });

    // The gateway has not restarted: its database is still plaintext.
    const early = await runVerify(deps(configDir, { gatewayHealthy: async () => true }), {});
    expect(early.verified).toBe(false);
    expect(step(early.steps, "restart")?.detail).toContain(
      `docker compose -f ${join(configDir, "docker-compose.yml")} logs -f gateway`,
    );

    encryptedLookingDb(join(configDir, "omnesis.db"));
    const done = await runVerify(deps(configDir, { gatewayHealthy: async () => true }), {});
    expect(done.verified).toBe(true);
    expect(step(done.steps, "restart")?.status).toBe("done");

    // A credential written by something that bypassed the keyring.
    writeFileSync(join(configDir, "other-credentials.json"), '{"client_id":"fictional"}');
    const leak = await runVerify(deps(configDir, { gatewayHealthy: async () => true }), {});
    expect(leak.verified).toBe(false);
    expect(step(leak.steps, "migrate")?.detail).toContain("other-credentials.json");
  });

  test("a gateway that never answers is not verified", async () => {
    const configDir = gatewayHost();
    await runSecure(deps(configDir), { dryRun: false, skipBackup: true });
    const result = await runVerify(deps(configDir), { timeoutMs: 1 });
    expect(result.verified).toBe(false);
    expect(step(result.steps, "restart")?.detail).toContain("did not answer in time");
  });
});

describe("the Docker install a config directory belongs to", () => {
  test("a gateway host's own directory, and a collector-only host's subdirectory", () => {
    const gateway = dockerProject(GATEWAY_AND_COLLECTOR);
    expect(detectDockerContext(gateway)).toMatchObject({
      projectDir: gateway,
      services: ["gateway", "collector"],
      collectorOnly: false,
    });
    const collectorProject = dockerProject(COLLECTOR_ONLY);
    expect(detectDockerContext(join(collectorProject, "collector"))).toMatchObject({
      projectDir: collectorProject,
      services: ["collector"],
      collectorOnly: true,
    });
  });

  test("any other install is not one", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-native-"));
    dirs.push(dir);
    expect(detectDockerContext(dir)).toBeNull();
    writeFileSync(join(dir, "install-method"), "docker\n");
    // A marker without its compose file is a removed install.
    expect(detectDockerContext(dir)).toBeNull();
  });

  test("the backend: the one asked for, else the one configured, else the passphrase", () => {
    expect(dockerSecureBackend("file", {})).toBe("file");
    expect(dockerSecureBackend(undefined, { OMNESIS_SECRET_STORE: "file" })).toBe("file");
    expect(dockerSecureBackend(undefined, { OMNESIS_SECRET_STORE: "auto" })).toBe("passphrase");
    expect(dockerSecureBackend(undefined, {})).toBe("passphrase");
  });
});
