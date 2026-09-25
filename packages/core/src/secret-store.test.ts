// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  OMNESIS_INSTALL_ROOT_KEY,
  PassphraseMismatchError,
  createSecretStore,
  ensureInstallRootKey,
  generateInstallRootKey,
  inspectInstallRootKey,
  isInstallRootKey,
  parseSecretStoreBackend,
  KEYRING_ENV_KEYS,
  readInstallRootKey,
  readInstallRootKeySync,
  writeInstallRootKey,
  type SecretCommandRunner,
} from "./secret-store.js";
import {
  createRecoveryEnvelope,
  generateRecoveryCode,
  openRecoveryEnvelope,
} from "./recovery-envelope.js";

const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("writeInstallRootKey", () => {
  test("writes a specific value and reads it back", async () => {
    const configDir = tmp("omnesis-root-write-");
    const value = generateInstallRootKey();
    await writeInstallRootKey(value, { backend: "file", configDir });
    expect(await readInstallRootKey({ backend: "file", configDir })).toBe(value);
  });

  test("refuses a malformed value", async () => {
    const configDir = tmp("omnesis-root-write-bad-");
    await expect(
      writeInstallRootKey("not-a-root-key", { backend: "file", configDir }),
    ).rejects.toThrow(/unknown format/i);
  });

  test("refuses to clobber an existing key unless overwrite is set", async () => {
    const configDir = tmp("omnesis-root-write-guard-");
    const first = generateInstallRootKey();
    await writeInstallRootKey(first, { backend: "file", configDir });
    await expect(
      writeInstallRootKey(generateInstallRootKey(), { backend: "file", configDir }),
    ).rejects.toThrow(/already exists/i);
    // Original is untouched by the refused write.
    expect(await readInstallRootKey({ backend: "file", configDir })).toBe(first);
    // overwrite replaces it.
    const second = generateInstallRootKey();
    await writeInstallRootKey(second, { backend: "file", configDir, overwrite: true });
    expect(await readInstallRootKey({ backend: "file", configDir })).toBe(second);
  });

  test("recovery round-trip: envelope from host A restores the root key on host B", async () => {
    const hostA = tmp("omnesis-recov-a-");
    const hostB = tmp("omnesis-recov-b-");
    // Host A has a root key; escrow it under a recovery code.
    await ensureInstallRootKey({ backend: "file", configDir: hostA });
    const original = await readInstallRootKey({ backend: "file", configDir: hostA });
    expect(original).not.toBeNull();
    const code = generateRecoveryCode();
    const envelope = createRecoveryEnvelope(original as string, code);

    // Host B is fresh; recover from the envelope + code.
    expect(await readInstallRootKey({ backend: "file", configDir: hostB })).toBeNull();
    const recovered = openRecoveryEnvelope(envelope, code);
    await writeInstallRootKey(recovered, { backend: "file", configDir: hostB });
    expect(await readInstallRootKey({ backend: "file", configDir: hostB })).toBe(original);
  });
});

describe("install root keys", () => {
  test("generates versioned 256-bit root keys", () => {
    const key = generateInstallRootKey();
    expect(isInstallRootKey(key)).toBe(true);
    expect(key).toMatch(/^omn_root_v1_/);
  });

  test("rejects malformed root keys", () => {
    expect(isInstallRootKey("")).toBe(false);
    expect(isInstallRootKey("omn_root_v1_short")).toBe(false);
    expect(isInstallRootKey(`omn_root_v1_${"a".repeat(44)}`)).toBe(false);
  });
});

describe("file secret store", () => {
  test("stores secrets under owner-only paths when explicitly selected", async () => {
    const configDir = tmp("omnesis-secret-file-");
    chmodSync(configDir, 0o700);
    const store = createSecretStore({ backend: "file", configDir });

    await store.write("demo", "secret-value");
    expect(await store.read("demo")).toBe("secret-value");

    const secretPath = join(configDir, "keyring", "dev.omnesis", "ZGVtbw.secret");
    expect(statSync(join(configDir, "keyring")).mode & 0o777).toBe(0o700);
    expect(statSync(join(configDir, "keyring", "dev.omnesis")).mode & 0o777).toBe(0o700);
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);

    await store.delete("demo");
    expect(await store.read("demo")).toBeNull();
  });

  test("ensureInstallRootKey is idempotent", async () => {
    const configDir = tmp("omnesis-secret-root-");
    const first = await ensureInstallRootKey({ backend: "file", configDir });
    const second = await ensureInstallRootKey({ backend: "file", configDir });
    const state = await inspectInstallRootKey({ backend: "file", configDir });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(state).toMatchObject({ present: true, valid: true });
  });

  test("does not overwrite an unknown existing root key", async () => {
    const configDir = tmp("omnesis-secret-invalid-");
    const store = createSecretStore({ backend: "file", configDir });
    await store.write(OMNESIS_INSTALL_ROOT_KEY, "legacy-or-corrupt");

    await expect(ensureInstallRootKey({ backend: "file", configDir })).rejects.toThrow(
      /unknown format/,
    );
    expect(await store.read(OMNESIS_INSTALL_ROOT_KEY)).toBe("legacy-or-corrupt");
  });
});

describe("platform adapters", () => {
  test("Linux Secret Service writes through stdin rather than argv", async () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = [];
    const runner: SecretCommandRunner = async (cmd, args, options) => {
      calls.push({ cmd, args, input: options?.input });
      if (cmd === "busctl" && args.at(-1) === "Collections") {
        return {
          code: 0,
          stdout: 'ao 1 "/org/freedesktop/secrets/collection/login"\n',
          stderr: "",
        };
      }
      if (cmd === "busctl" && args.at(-1) === "Locked") {
        return { code: 0, stdout: "b false\n", stderr: "" };
      }
      if (args[0] === "lookup") return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };

    const result = await ensureInstallRootKey({
      backend: "secret-service",
      runCommand: runner,
    });

    const storeCall = calls.find((c) => c.args[0] === "store");
    expect(result.created).toBe(true);
    expect(storeCall?.input).toMatch(/^omn_root_v1_[A-Za-z0-9_-]{43}\n$/);
    expect(storeCall?.args).toContain("--collection=login");
    expect(storeCall?.args.join(" ")).not.toContain("omn_root_v1_");
  });

  test("Linux Secret Service status catches DBus/keyring failures", async () => {
    const runner: SecretCommandRunner = async (_cmd, args) => {
      expect(args[0]).toBe("lookup");
      return {
        code: 1,
        stdout: "",
        stderr: "secret-tool: The name org.freedesktop.secrets was not provided",
      };
    };

    const state = await inspectInstallRootKey({
      backend: "secret-service",
      runCommand: runner,
    });

    expect(state.store.backend).toBe("secret-service");
    expect(state.store.available).toBe(false);
    expect(state.store.detail).toMatch(/not reachable/);
    expect(state.present).toBe(false);
  });

  test("Linux Secret Service status does not require secret-tool --version", async () => {
    const runner: SecretCommandRunner = async (cmd, args) => {
      if (args[0] === "--version") throw new Error("status must not call --version");
      if (cmd === "busctl" && args.at(-1) === "Collections") {
        return {
          code: 0,
          stdout: 'ao 1 "/org/freedesktop/secrets/collection/login"\n',
          stderr: "",
        };
      }
      if (cmd === "busctl" && args.at(-1) === "Locked") {
        return { code: 0, stdout: "b false\n", stderr: "" };
      }
      if (args[0] === "lookup") return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };

    const state = await inspectInstallRootKey({
      backend: "secret-service",
      runCommand: runner,
    });

    expect(state.store.available).toBe(true);
    expect(state.present).toBe(false);
  });

  test("Linux Secret Service explains missing persistent login collection", async () => {
    const runner: SecretCommandRunner = async (cmd, args) => {
      if (args[0] === "lookup") return { code: 1, stdout: "", stderr: "" };
      if (cmd === "busctl" && args.at(-1) === "Collections") {
        return {
          code: 0,
          stdout: 'ao 1 "/org/freedesktop/secrets/collection/session"\n',
          stderr: "",
        };
      }
      return {
        code: 1,
        stdout: "",
        stderr:
          "secret-tool: Object does not exist at path “/org/freedesktop/secrets/collection/login”",
      };
    };

    await expect(
      ensureInstallRootKey({ backend: "secret-service", runCommand: runner }),
    ).rejects.toThrow(/persistent login collection/);
  });

  test("Linux Secret Service status reports a locked persistent login collection", async () => {
    const runner: SecretCommandRunner = async (cmd, args) => {
      if (args[0] === "lookup") return { code: 1, stdout: "", stderr: "" };
      if (cmd === "busctl" && args.at(-1) === "Collections") {
        return {
          code: 0,
          stdout: 'ao 1 "/org/freedesktop/secrets/collection/login"\n',
          stderr: "",
        };
      }
      if (cmd === "busctl" && args.at(-1) === "Locked") {
        return { code: 0, stdout: "b true\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const state = await inspectInstallRootKey({
      backend: "secret-service",
      runCommand: runner,
    });

    expect(state.store.available).toBe(false);
    expect(state.store.detail).toMatch(/persistent login collection is locked/);
  });

  test("macOS Keychain adapter records the unavoidable argv write exposure", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: SecretCommandRunner = async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === "-h") return { code: 0, stdout: "security help\n", stderr: "" };
      if (args[0] === "find-generic-password") return { code: 44, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };

    const result = await ensureInstallRootKey({
      backend: "macos-keychain",
      runCommand: runner,
    });

    const addCall = calls.find((c) => c.args[0] === "add-generic-password");
    expect(result.store.writeExposure).toBe("process-argv");
    expect(result.created).toBe(true);
    expect(addCall?.args).toContain("-w");
    expect(addCall?.args.at(-1)).toMatch(/^omn_root_v1_/);
  });

  test("macOS Keychain write failures explain locked SSH sessions", async () => {
    const runner: SecretCommandRunner = async (_cmd, args) => {
      if (args[0] === "-h") return { code: 0, stdout: "security help\n", stderr: "" };
      if (args[0] === "find-generic-password") return { code: 44, stdout: "", stderr: "" };
      return {
        code: 1,
        stdout: "",
        stderr: "security: SecKeychainItemCreateFromContent: User interaction is not allowed.",
      };
    };

    await expect(
      ensureInstallRootKey({ backend: "macos-keychain", runCommand: runner }),
    ).rejects.toThrow(/unlocked local login session/);
  });

  test("auto selects the native backend by platform", async () => {
    const mac = createSecretStore({ backend: "auto", platform: "darwin" });
    const linux = createSecretStore({ backend: "auto", platform: "linux" });
    const other = createSecretStore({ backend: "auto", platform: "freebsd" });

    expect(mac.backend).toBe("macos-keychain");
    expect(linux.backend).toBe("secret-service");
    expect(other.backend).toBe("unavailable");
  });

  test("parseSecretStoreBackend validates environment values", () => {
    expect(parseSecretStoreBackend(undefined)).toBe("auto");
    expect(parseSecretStoreBackend("file")).toBe("file");
    expect(() => parseSecretStoreBackend("plain")).toThrow(/Invalid OMNESIS_SECRET_STORE/);
  });
});

describe("passphrase backend", () => {
  // The declared list, not a copy of it: the tests below exercise one source
  // per key, so a source added to the resolver and to `KEYRING_ENV_KEYS` is
  // isolated here without anyone remembering to update a second list.
  const ENV_KEYS = KEYRING_ENV_KEYS;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("round-trips the install root key under an env passphrase", async () => {
    const configDir = tmp("omnesis-passphrase-env-");
    process.env.OMNESIS_KEYRING_PASSPHRASE = "correct horse battery staple";

    const result = await ensureInstallRootKey({ backend: "passphrase", configDir });
    expect(result.created).toBe(true);
    expect(result.store.secure).toBe(true);

    const value = await readInstallRootKey({ backend: "passphrase", configDir });
    expect(value).not.toBeNull();
    expect(isInstallRootKey(value ?? "")).toBe(true);
    // The sealed entry on disk never contains the key material.
    const entries = readdirSync(join(configDir, "keyring", "passphrase"));
    expect(entries.length).toBe(1);
    const raw = readFileSync(join(configDir, "keyring", "passphrase", entries[0]), "utf8");
    expect(raw).not.toContain((value ?? "").slice("omn_root_v1_".length));
    expect(raw).toContain("omnesis.passphrase-secret");
  });

  test("sources the passphrase from a file, stripping one trailing newline", async () => {
    const configDir = tmp("omnesis-passphrase-file-");
    const passFile = join(configDir, "pass.txt");
    writeFileSync(passFile, "file-sourced passphrase\n");
    process.env.OMNESIS_KEYRING_PASSPHRASE_FILE = passFile;

    await ensureInstallRootKey({ backend: "passphrase", configDir });
    const value = await readInstallRootKey({ backend: "passphrase", configDir });
    expect(isInstallRootKey(value ?? "")).toBe(true);
  });

  test("sources the passphrase from a systemd credentials directory", async () => {
    const configDir = tmp("omnesis-passphrase-cred-");
    const credDir = tmp("omnesis-passphrase-creddir-");
    writeFileSync(join(credDir, "omnesis-keyring-passphrase"), "cred passphrase\n");
    process.env.CREDENTIALS_DIRECTORY = credDir;

    await ensureInstallRootKey({ backend: "passphrase", configDir });
    const value = await readInstallRootKey({ backend: "passphrase", configDir });
    expect(isInstallRootKey(value ?? "")).toBe(true);
    // The sync read path resolves the same credential source.
    expect(readInstallRootKeySync({ backend: "passphrase", configDir })).toBe(value);
  });

  test("a wrong passphrase fails loud on read and inspects as present-but-invalid", async () => {
    const configDir = tmp("omnesis-passphrase-wrong-");
    process.env.OMNESIS_KEYRING_PASSPHRASE = "original passphrase";
    await ensureInstallRootKey({ backend: "passphrase", configDir });

    process.env.OMNESIS_KEYRING_PASSPHRASE = "different passphrase";
    await expect(readInstallRootKey({ backend: "passphrase", configDir })).rejects.toThrow(
      PassphraseMismatchError,
    );
    expect(() => readInstallRootKeySync({ backend: "passphrase", configDir })).toThrow(
      PassphraseMismatchError,
    );

    const state = await inspectInstallRootKey({ backend: "passphrase", configDir });
    expect(state.present).toBe(true);
    expect(state.valid).toBe(false);
  });

  test("is unavailable with an actionable detail when no passphrase is configured", async () => {
    const configDir = tmp("omnesis-passphrase-none-");
    const store = createSecretStore({ backend: "passphrase", configDir });
    const status = await store.status();
    expect(status.available).toBe(false);
    expect(status.detail).toContain("OMNESIS_KEYRING_PASSPHRASE");
    await expect(store.write("x", "y")).rejects.toThrow(/passphrase/i);
    // Reads of absent entries stay null (no passphrase needed to say "missing").
    await expect(store.read(OMNESIS_INSTALL_ROOT_KEY)).resolves.toBeNull();
  });

  test("auto never resolves to the passphrase backend", async () => {
    process.env.OMNESIS_KEYRING_PASSPHRASE = "should not matter";
    const linux = createSecretStore({ backend: "auto", platform: "linux", configDir: tmp("a-") });
    expect(linux.backend).toBe("secret-service");
    const darwin = createSecretStore({ backend: "auto", platform: "darwin", configDir: tmp("b-") });
    expect(darwin.backend).toBe("macos-keychain");
  });

  test("entries are bound to their name — a renamed entry file refuses to open", async () => {
    const configDir = tmp("omnesis-passphrase-aad-");
    process.env.OMNESIS_KEYRING_PASSPHRASE = "binding test";
    const store = createSecretStore({ backend: "passphrase", configDir });
    await store.write("first-name", "secret value");

    const dir = join(configDir, "keyring", "passphrase");
    const from = join(dir, `${Buffer.from("first-name", "utf8").toString("base64url")}.json`);
    const to = join(dir, `${Buffer.from("second-name", "utf8").toString("base64url")}.json`);
    renameSync(from, to);

    await expect(store.read("second-name")).rejects.toThrow(PassphraseMismatchError);
  });

  test("a recovery envelope cannot masquerade as a passphrase store entry", async () => {
    const configDir = tmp("omnesis-passphrase-marker-");
    process.env.OMNESIS_KEYRING_PASSPHRASE = "marker separation";
    const store = createSecretStore({ backend: "passphrase", configDir });
    // Seal a recovery envelope with the SAME passphrase and drop it in place
    // of the root-key entry: the protocol marker + AAD must reject it.
    const envelope = createRecoveryEnvelope("omn_root_v1_x".padEnd(55, "A"), "marker separation");
    const dir = join(configDir, "keyring", "passphrase");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${Buffer.from(OMNESIS_INSTALL_ROOT_KEY, "utf8").toString("base64url")}.json`),
      JSON.stringify(envelope),
    );

    await expect(store.read(OMNESIS_INSTALL_ROOT_KEY)).rejects.toThrow(PassphraseMismatchError);
  });
});
