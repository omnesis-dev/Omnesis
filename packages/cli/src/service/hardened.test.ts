// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "@omnesis/cli-shared";
import {
  HARDENED_CONFIG_DIR,
  HARDENED_STATE_DIR,
  HARDENED_UNIT_NAME,
  HARDENED_UNIT_PATH,
  buildHardenedGatewaySpec,
  generateHardenedSystemdUnit,
  hardenedKeyringInitCommand,
  codeWritableByNonRoot,
  assertRootControlledCode,
  homeDependentPaths,
  installHardenedGateway,
  uninstallHardenedGateway,
  type HardenedGatewaySpec,
} from "./hardened.js";
import type { ExecResult, ExecRunner } from "./supervisor.js";

const tempDirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Records every exec call; replies from the first matching argv prefix. */
function makeExec(responses: Array<{ prefix: string[]; result: Partial<ExecResult> }> = []) {
  const calls: string[][] = [];
  const exec: ExecRunner = (cmd, args) => {
    const argv = [cmd, ...args];
    calls.push(argv);
    for (const { prefix, result } of responses) {
      if (prefix.every((token, i) => argv[i] === token)) {
        return Promise.resolve({ code: 0, stdout: "", stderr: "", ...result });
      }
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  return { calls, exec };
}

function spec(overrides: Partial<HardenedGatewaySpec> = {}): HardenedGatewaySpec {
  return {
    exec: ["/usr/local/bin/omnesis", "gateway", "serve"],
    env: {
      OMNESIS_CONFIG_DIR: HARDENED_CONFIG_DIR,
      PATH: "/usr/local/bin:/usr/bin:/bin",
    },
    ...overrides,
  };
}

describe("buildHardenedGatewaySpec", () => {
  const base = {
    exec: ["/usr/local/bin/omnesis", "gateway", "serve"],
    extraEnv: {},
    nodeBinDir: "/usr/local/bin",
  };

  it("pins OMNESIS_CONFIG_DIR to the state directory and bakes a PATH", () => {
    const s = buildHardenedGatewaySpec(base);
    expect(s.env.OMNESIS_CONFIG_DIR).toBe("/var/lib/omnesis-gateway");
    expect(s.env.PATH.startsWith("/usr/local/bin:")).toBe(true);
  });

  it("passes extra env through (e.g. the gateway port)", () => {
    const s = buildHardenedGatewaySpec({
      ...base,
      extraEnv: { OMNESIS_GATEWAY_PORT: "7600" },
    });
    expect(s.env.OMNESIS_GATEWAY_PORT).toBe("7600");
  });

  it("rejects an OMNESIS_CONFIG_DIR override", () => {
    expect(() =>
      buildHardenedGatewaySpec({ ...base, extraEnv: { OMNESIS_CONFIG_DIR: "/srv/other" } }),
    ).toThrow(CliError);
  });

  it("rejects DB/log path env pointing outside the state directory", () => {
    expect(() =>
      buildHardenedGatewaySpec({ ...base, extraEnv: { OMNESIS_DB_PATH: "/srv/omnesis.db" } }),
    ).toThrow(CliError);
    expect(() =>
      buildHardenedGatewaySpec({
        ...base,
        extraEnv: { OMNESIS_LOG_FILE: "/home/maya/gateway.log" },
      }),
    ).toThrow(CliError);
  });

  it("accepts DB path env inside the state directory", () => {
    const s = buildHardenedGatewaySpec({
      ...base,
      extraEnv: { OMNESIS_DB_PATH: `${HARDENED_CONFIG_DIR}/omnesis.db` },
    });
    expect(s.env.OMNESIS_DB_PATH).toBe("/var/lib/omnesis-gateway/omnesis.db");
  });

  it("copies the exec array", () => {
    const exec = ["/usr/local/bin/omnesis", "gateway", "serve"];
    const s = buildHardenedGatewaySpec({ ...base, exec });
    exec.push("mutated");
    expect(s.exec).toEqual(["/usr/local/bin/omnesis", "gateway", "serve"]);
  });

  it("bakes the secret-store backend into the unit env", () => {
    const s = buildHardenedGatewaySpec({ ...base, secretStore: "passphrase" });
    expect(s.env.OMNESIS_SECRET_STORE).toBe("passphrase");
  });

  it("an explicit --env OMNESIS_SECRET_STORE still wins over --secret-store", () => {
    const s = buildHardenedGatewaySpec({
      ...base,
      secretStore: "passphrase",
      extraEnv: { OMNESIS_SECRET_STORE: "file" },
    });
    expect(s.env.OMNESIS_SECRET_STORE).toBe("file");
  });

  it("carries the passphrase credential, and none when unset", () => {
    const s = buildHardenedGatewaySpec({
      ...base,
      secretStore: "passphrase",
      passphraseCredentialPath: "/etc/omnesis/keyring.pass",
    });
    expect(s.credentials).toEqual([
      { name: "omnesis-keyring-passphrase", path: "/etc/omnesis/keyring.pass" },
    ]);
    expect(buildHardenedGatewaySpec(base).credentials).toBeUndefined();
  });
});

describe("homeDependentPaths", () => {
  it("is empty for a fully system-installed setup", () => {
    expect(homeDependentPaths(spec())).toEqual([]);
  });

  it("detects a home-installed executable", () => {
    const s = spec({ exec: ["/home/maya/.npm-global/bin/omnesis", "gateway", "serve"] });
    expect(homeDependentPaths(s)).toEqual(["/home/maya/.npm-global/bin/omnesis"]);
  });

  it("detects a home-based PATH entry (nvm-style node)", () => {
    const s = spec({
      env: {
        OMNESIS_CONFIG_DIR: HARDENED_CONFIG_DIR,
        PATH: "/home/maya/.nvm/versions/node/bin:/usr/bin:/bin",
      },
    });
    expect(homeDependentPaths(s)).toEqual(["/home/maya/.nvm/versions/node/bin"]);
  });

  it("classifies by realpath: a system-path symlink into a home directory is detected", () => {
    // e.g. /usr/local/bin/omnesis → ~/.npm-global/… — ExecStart names the
    // system path but execution follows the symlink into the home tree.
    const realpath = (path: string) =>
      path === "/usr/local/bin/omnesis" ? "/home/maya/.npm-global/bin/omnesis" : path;
    expect(homeDependentPaths(spec(), realpath)).toEqual(["/home/maya/.npm-global/bin/omnesis"]);
  });

  it("keeps the literal form too: a home-based symlink to a system target still counts", () => {
    const realpath = (path: string) => (path === "/home/maya/bin" ? "/opt/toolchain/bin" : path);
    const s = spec({
      env: { OMNESIS_CONFIG_DIR: HARDENED_CONFIG_DIR, PATH: "/home/maya/bin:/usr/bin" },
    });
    expect(homeDependentPaths(s, realpath)).toEqual(["/home/maya/bin"]);
  });

  it("an unresolvable path classifies by its literal form (default realpath fallback)", () => {
    const s = spec({ exec: ["/home/maya/.local/bin/omnesis", "gateway", "serve"] });
    expect(homeDependentPaths(s)).toEqual(["/home/maya/.local/bin/omnesis"]);
  });
});

describe("codeWritableByNonRoot", () => {
  const same = (path: string) => path;
  const rootOwned = (mode = 0o755) => ({ uid: 0, mode });

  it("passes a chain that root owns and nobody else can write", () => {
    expect(codeWritableByNonRoot(spec(), same, () => rootOwned())).toEqual([]);
  });

  it("names a file another account owns", () => {
    const stat = (path: string) =>
      path === "/usr/local/bin/omnesis" ? { uid: 1000, mode: 0o755 } : rootOwned();
    expect(codeWritableByNonRoot(spec(), same, stat)).toEqual(["/usr/local/bin/omnesis"]);
  });

  it("names the nearest group-writable directory, once", () => {
    const stat = (path: string) => (path === "/usr/local" ? rootOwned(0o2775) : rootOwned());
    expect(codeWritableByNonRoot(spec(), same, stat)).toEqual(["/usr/local"]);
  });

  it("follows a symlink into a directory another account owns", () => {
    const realpath = (path: string) =>
      path === "/usr/local/bin/omnesis" ? "/srv/maya/omnesis/bin/omnesis" : path;
    const stat = (path: string) =>
      path.startsWith("/srv/maya") ? { uid: 1000, mode: 0o755 } : rootOwned();
    expect(codeWritableByNonRoot(spec(), realpath, stat)).toEqual([
      "/srv/maya/omnesis/bin/omnesis",
    ]);
  });

  it("walks past a path it cannot read to the directories above it", () => {
    const stat = (path: string) => (path === "/usr/local/bin/omnesis" ? null : rootOwned());
    expect(codeWritableByNonRoot(spec(), same, stat)).toEqual([]);
  });
});

describe("assertRootControlledCode", () => {
  const same = (path: string) => path;
  const rootOwned = () => ({ uid: 0, mode: 0o755 });

  it("accepts a release only root can change", () => {
    const s = spec({
      exec: ["/opt/omnesis-gateway/current/scripts/hardened-gateway-exec.sh", "gateway", "serve"],
    });
    expect(() => assertRootControlledCode(s, same, rootOwned)).not.toThrow();
  });

  it("refuses code under a home directory, which the dedicated account cannot enter", () => {
    const s = spec({ exec: ["/home/maya/.local/bin/omnesis", "gateway", "serve"] });
    expect(() => assertRootControlledCode(s, same, rootOwned)).toThrow(CliError);
    expect(() => assertRootControlledCode(s, same, rootOwned)).toThrow(
      /home directory \(\/home\/maya\/\.local\/bin\/omnesis\)/,
    );
  });

  it("refuses code another account can change, naming the path", () => {
    const stat = (path: string) => (path === "/usr/local" ? { uid: 0, mode: 0o775 } : rootOwned());
    expect(() => assertRootControlledCode(spec(), same, stat)).toThrow(
      /other than root can change code.*\(\/usr\/local\)/,
    );
  });
});

describe("generateHardenedSystemdUnit", () => {
  it("renders the dedicated-user directives", () => {
    const unit = generateHardenedSystemdUnit(spec());
    expect(unit).toContain("DynamicUser=yes");
    expect(unit).toContain(`StateDirectory=${HARDENED_STATE_DIR}`);
    expect(unit).toContain("StateDirectoryMode=0700");
    expect(unit).toContain("Environment=OMNESIS_CONFIG_DIR=/var/lib/omnesis-gateway");
  });

  it("carries both halves of a passphrase wiring into one unit", () => {
    // The contract the install path composes: naming the backend without the
    // credential (or the reverse) produces a unit that starts and then cannot
    // open its keys, and nothing downstream catches that.
    const unit = generateHardenedSystemdUnit(
      buildHardenedGatewaySpec({
        exec: ["/usr/local/bin/omnesis", "gateway", "serve"],
        extraEnv: {},
        nodeBinDir: "/usr/local/bin",
        secretStore: "passphrase",
        passphraseCredentialPath: "/etc/omnesis/keyring.pass",
      }),
    );
    expect(unit).toContain("Environment=OMNESIS_SECRET_STORE=passphrase");
    expect(unit).toContain("LoadCredential=omnesis-keyring-passphrase:/etc/omnesis/keyring.pass");
  });

  it("doubles a % in the credential path and quotes nothing else", () => {
    // `%` is a systemd specifier introducer, so an unescaped one silently names
    // a different file in a unit that root owns. Quoting, though, would be
    // wrong: `LoadCredential=` splits on the first `:` and takes the rest of
    // the line verbatim — it never unquotes — so a quoted path with a space
    // would keep its quote characters and name a file that does not exist.
    const line = (path: string) =>
      generateHardenedSystemdUnit(
        spec({ credentials: [{ name: "omnesis-keyring-passphrase", path }] }),
      )
        .split("\n")
        .find((l) => l.startsWith("LoadCredential="));

    expect(line("/etc/omn%is/key.pass")).toBe(
      "LoadCredential=omnesis-keyring-passphrase:/etc/omn%%is/key.pass",
    );
    expect(line("/etc/omnesis dir/key.pass")).toBe(
      "LoadCredential=omnesis-keyring-passphrase:/etc/omnesis dir/key.pass",
    );
  });

  it("renders the keyring passphrase as a LoadCredential, and omits it when unset", () => {
    // The credential is what makes an armed keyring reachable at all under
    // DynamicUser: systemd reads the file as root and hands it to this
    // service alone, so the passphrase never depends on the dynamic uid.
    const unit = generateHardenedSystemdUnit(
      spec({
        credentials: [{ name: "omnesis-keyring-passphrase", path: "/etc/omnesis/keyring.pass" }],
      }),
    );
    expect(unit).toContain("LoadCredential=omnesis-keyring-passphrase:/etc/omnesis/keyring.pass");
    expect(generateHardenedSystemdUnit(spec())).not.toContain("LoadCredential=");
  });

  it("carries every hardening directive the user-level unit has", () => {
    const unit = generateHardenedSystemdUnit(spec());
    expect(unit).toContain("UMask=0077");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).toContain("PrivateTmp=true");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK");
    expect(unit).toContain("CapabilityBoundingSet=");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=2");
  });

  it("has no ReadWritePaths — the state directory is the only writable location", () => {
    expect(generateHardenedSystemdUnit(spec())).not.toContain("ReadWritePaths=");
  });

  it("hides home directories entirely", () => {
    expect(generateHardenedSystemdUnit(spec())).toContain("ProtectHome=yes");
  });

  it("is a system unit: installs into multi-user.target", () => {
    const unit = generateHardenedSystemdUnit(spec());
    expect(unit).toContain("[Install]");
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(unit).not.toContain("WantedBy=default.target");
  });

  it("renders ExecStart and extra Environment lines with systemd escaping", () => {
    const unit = generateHardenedSystemdUnit(
      spec({
        exec: ["/opt/my tools/omnesis", "gateway", "serve"],
        env: { OMNESIS_CONFIG_DIR: HARDENED_CONFIG_DIR, OMNESIS_QUOTA: "80%" },
      }),
    );
    expect(unit).toContain('ExecStart="/opt/my tools/omnesis" gateway serve');
    expect(unit).toContain("Environment=OMNESIS_QUOTA=80%%");
  });

  it("ends with a trailing newline", () => {
    expect(generateHardenedSystemdUnit(spec()).endsWith("\n")).toBe(true);
  });
});

describe("installHardenedGateway", () => {
  it("writes the unit 0600, reloads, enables --now, and polls the unit to active", async () => {
    const etcDir = makeDir("omnesis-hardened-etc-");
    const unitPath = join(etcDir, HARDENED_UNIT_NAME);
    const { calls, exec } = makeExec([
      { prefix: ["systemctl", "is-active"], result: { stdout: "active\n" } },
    ]);
    const sleeps: number[] = [];

    const result = await installHardenedGateway(spec(), {
      exec,
      unitPath,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });

    expect(result).toEqual({ unitPath });
    expect(readFileSync(unitPath, "utf8")).toContain(`StateDirectory=${HARDENED_STATE_DIR}`);
    expect(statSync(unitPath).mode & 0o777).toBe(0o600);
    expect(calls).toEqual([
      ["systemctl", "daemon-reload"],
      ["systemctl", "enable", "--now", HARDENED_UNIT_NAME],
      ["systemctl", "is-active", HARDENED_UNIT_NAME],
    ]);
    expect(sleeps).toEqual([1_000]);
  });

  it("fails loud with a journalctl hint when the unit never becomes active", async () => {
    // `systemctl enable --now` exits 0 even when the exec dies immediately —
    // the poll is what distinguishes "installed" from "actually running".
    const etcDir = makeDir("omnesis-hardened-etc-");
    const unitPath = join(etcDir, HARDENED_UNIT_NAME);
    const { calls, exec } = makeExec([
      { prefix: ["systemctl", "is-active"], result: { code: 3, stdout: "activating\n" } },
    ]);
    const sleeps: number[] = [];

    await expect(
      installHardenedGateway(spec(), {
        exec,
        unitPath,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(/did not become active.*activating.*journalctl -u omnesis-gateway\.service/s);

    // Exhausted the full poll window (5 × 1s) before giving up.
    expect(sleeps).toEqual([1_000, 1_000, 1_000, 1_000, 1_000]);
    expect(calls.filter((argv) => argv[1] === "is-active")).toHaveLength(5);
    // The unit stays installed — the error is about liveness, not the write.
    expect(existsSync(unitPath)).toBe(true);
  });

  it("surfaces a systemctl failure", async () => {
    const etcDir = makeDir("omnesis-hardened-etc-");
    const { exec } = makeExec([
      {
        prefix: ["systemctl", "enable"],
        result: { code: 1, stderr: "Failed to enable unit" },
      },
    ]);

    await expect(
      installHardenedGateway(spec(), {
        exec,
        unitPath: join(etcDir, HARDENED_UNIT_NAME),
      }),
    ).rejects.toThrow(/enable --now.*Failed to enable/s);
  });

  it("defaults the unit path to /etc/systemd/system", () => {
    expect(HARDENED_UNIT_PATH).toBe("/etc/systemd/system/omnesis-gateway.service");
  });
});

describe("uninstallHardenedGateway", () => {
  function installedUnit(): string {
    const etcDir = makeDir("omnesis-hardened-etc-");
    const unitPath = join(etcDir, HARDENED_UNIT_NAME);
    writeFileSync(unitPath, generateHardenedSystemdUnit(spec()), { mode: 0o600 });
    return unitPath;
  }

  it("points either account at the admin command when it installed the gateway", async () => {
    for (const isRoot of [false, true]) {
      const unitPath = installedUnit();
      const { calls, exec } = makeExec();

      const result = await uninstallHardenedGateway({
        exec,
        isRoot,
        adminInstalled: true,
        unitPath,
      });

      expect(result).toEqual({
        applied: false,
        existed: true,
        unitPath,
        commands: ["sudo omnesis-gateway-admin uninstall"],
      });
      // The releases go with the unit, so nothing is removed from here.
      expect(calls).toEqual([]);
      expect(existsSync(unitPath)).toBe(true);
    }
  });

  it("non-root: returns sudo commands without touching the unit or systemctl", async () => {
    const unitPath = installedUnit();
    const { calls, exec } = makeExec();

    const result = await uninstallHardenedGateway({
      exec,
      isRoot: false,
      adminInstalled: false,
      unitPath,
    });

    expect(result.applied).toBe(false);
    expect(result.existed).toBe(true);
    if (result.applied) throw new Error("unreachable");
    expect(result.commands).toEqual([
      `sudo systemctl disable --now ${HARDENED_UNIT_NAME}`,
      `sudo rm -f ${unitPath}`,
      "sudo systemctl daemon-reload",
    ]);
    expect(calls).toEqual([]);
    expect(existsSync(unitPath)).toBe(true);
  });

  it("root: disables, removes the unit file, and reloads", async () => {
    const unitPath = installedUnit();
    const { calls, exec } = makeExec();

    const result = await uninstallHardenedGateway({
      exec,
      isRoot: true,
      adminInstalled: false,
      unitPath,
    });

    expect(result).toEqual({ applied: true, existed: true, unitPath });
    expect(existsSync(unitPath)).toBe(false);
    expect(calls).toEqual([
      ["systemctl", "disable", "--now", HARDENED_UNIT_NAME],
      ["systemctl", "daemon-reload"],
    ]);
  });

  it("is idempotent when the unit is already gone", async () => {
    const etcDir = makeDir("omnesis-hardened-etc-");
    const unitPath = join(etcDir, HARDENED_UNIT_NAME);
    const { exec } = makeExec();

    const result = await uninstallHardenedGateway({
      exec,
      isRoot: true,
      adminInstalled: false,
      unitPath,
    });

    expect(result.applied).toBe(true);
    expect(result.existed).toBe(false);
  });
});

describe("the keyring root key is created before the gateway starts", () => {
  it("a passphrase credential gets a pre-start keyring init with the same backend", () => {
    const unit = generateHardenedSystemdUnit(
      spec({
        env: { ...spec().env, OMNESIS_SECRET_STORE: "passphrase" },
        credentials: [
          {
            name: "omnesis-keyring-passphrase",
            path: "/etc/omnesis-gateway/keyring.pass",
          },
        ],
      }),
    );
    const lines = unit.split("\n");
    const pre = lines.indexOf(
      "ExecStartPre=/usr/local/bin/omnesis keyring init --backend passphrase",
    );
    const start = lines.indexOf("ExecStart=/usr/local/bin/omnesis gateway serve");
    expect(pre).toBeGreaterThan(-1);
    // Before the gateway, so its first store opens against the key.
    expect(pre).toBeLessThan(start);
    expect(unit).toContain(
      "LoadCredential=omnesis-keyring-passphrase:/etc/omnesis-gateway/keyring.pass",
    );
  });

  it("the file backend gets it too, and a unit with no backend that can hold a key gets none", () => {
    expect(
      hardenedKeyringInitCommand(spec({ env: { ...spec().env, OMNESIS_SECRET_STORE: "file" } })),
    ).toEqual(["/usr/local/bin/omnesis", "keyring", "init", "--backend", "file"]);
    expect(hardenedKeyringInitCommand(spec())).toBeNull();
    expect(
      hardenedKeyringInitCommand(spec({ env: { ...spec().env, OMNESIS_SECRET_STORE: "auto" } })),
    ).toBeNull();
    expect(generateHardenedSystemdUnit(spec())).not.toContain("ExecStartPre=");
  });

  it("an explicit --env backend is the one the key is created with", () => {
    const built = buildHardenedGatewaySpec({
      exec: ["/usr/local/bin/omnesis", "gateway", "serve"],
      extraEnv: { OMNESIS_SECRET_STORE: "file" },
      nodeBinDir: "/usr/local/bin",
      secretStore: "passphrase",
    });
    expect(hardenedKeyringInitCommand(built)).toEqual([
      "/usr/local/bin/omnesis",
      "keyring",
      "init",
      "--backend",
      "file",
    ]);
  });

  it("runs the same CLI the gateway does, even through a runtime and an entry file", () => {
    expect(
      hardenedKeyringInitCommand(
        spec({
          exec: ["/usr/bin/node", "/opt/omnesis/cli/dist/index.js", "gateway", "serve"],
          env: { ...spec().env, OMNESIS_SECRET_STORE: "passphrase" },
        }),
      ),
    ).toEqual([
      "/usr/bin/node",
      "/opt/omnesis/cli/dist/index.js",
      "keyring",
      "init",
      "--backend",
      "passphrase",
    ]);
  });

  it("refuses an exec that does not end with the gateway's own arguments", () => {
    expect(() =>
      hardenedKeyringInitCommand(
        spec({
          exec: ["/usr/local/bin/omnesis"],
          env: { ...spec().env, OMNESIS_SECRET_STORE: "passphrase" },
        }),
      ),
    ).toThrow(/must end with "gateway serve"/);
  });
});

describe("code the dedicated account runs that another account can change", () => {
  const rootOwned = { uid: 0, mode: 0o40755 };
  const statOf = (table: Record<string, { uid: number; mode: number }>) => (path: string) =>
    table[path] ?? rootOwned;

  it("a system-wide install owned by root raises nothing", () => {
    expect(codeWritableByNonRoot(spec(), (p) => p, statOf({}))).toEqual([]);
  });

  it("an executable in a home directory is named, once, at the nearest offending path", () => {
    const flagged = codeWritableByNonRoot(
      spec({ exec: ["/home/maya/.local/bin/omnesis", "gateway", "serve"] }),
      (p) => p,
      statOf({
        "/home/maya/.local/bin/omnesis": { uid: 1000, mode: 0o100755 },
        "/home/maya/.local/bin": { uid: 1000, mode: 0o40755 },
        "/home/maya": { uid: 1000, mode: 0o40750 },
      }),
    );
    expect(flagged).toEqual(["/home/maya/.local/bin/omnesis"]);
  });

  it("a root-owned file in a directory others can write is named by that directory", () => {
    expect(
      codeWritableByNonRoot(
        spec({ exec: ["/opt/tools/bin/omnesis", "gateway", "serve"] }),
        (p) => p,
        statOf({ "/opt/tools": { uid: 0, mode: 0o40777 } }),
      ),
    ).toEqual(["/opt/tools"]);
  });

  it("a root-owned symlink resolving into a home directory is caught through its target, and so is a PATH entry", () => {
    const flagged = codeWritableByNonRoot(
      spec({
        exec: ["/usr/local/bin/omnesis", "gateway", "serve"],
        env: { ...spec().env, PATH: "/home/maya/.nvm/bin:/usr/bin" },
      }),
      (p) => (p === "/usr/local/bin/omnesis" ? "/home/maya/.npm-global/bin/omnesis" : p),
      statOf({
        "/home/maya/.npm-global/bin/omnesis": { uid: 1000, mode: 0o100755 },
        "/home/maya/.nvm/bin": { uid: 1000, mode: 0o40755 },
      }),
    );
    expect(flagged).toEqual(["/home/maya/.npm-global/bin/omnesis", "/home/maya/.nvm/bin"]);
  });
});
