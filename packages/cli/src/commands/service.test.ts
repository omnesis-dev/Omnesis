// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Contract guard for the `omnesis service` CLI surface plus unit coverage
 * for its pure flag parsers. The supervision logic itself is exercised in
 * `../service/supervisor.test.ts` against mocked exec seams.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "@omnesis/cli-shared";
import {
  collectEnvFlags,
  collectorAfterUnit,
  collectorGatewayUrl,
  collectorFdaNote,
  fdaOpenCommands,
  openFdaGrant,
  parseComponentSelection,
  parseEnvFlags,
  parseInstanceFlag,
  parseLinesFlag,
  needsPairingNotice,
  rejectHardenedIncompatibleFlags,
  rejectHardenedKeyringFlags,
  requireHardenedGatewaySelection,
  requireHardenedPlatform,
  resolveKeyringWiring,
  resolveSudoUserHome,
  serviceCommand,
  uninstallLegacyRunnerService,
  warnOnUnsupportedCredential,
} from "./service.js";
import type { InstallRootKeyState, inspectInstallRootKey } from "@omnesis/core";

describe("service command surface", () => {
  it("is named service", async () => {
    const meta = (await serviceCommand.meta) as { name?: string; description?: string };
    expect(meta?.name).toBe("service");
  });

  it("wires the full verb set", () => {
    const sub = serviceCommand.subCommands as Record<string, unknown>;
    expect(Object.keys(sub).sort()).toEqual([
      "install",
      "logs",
      "restart",
      "start",
      "status",
      "stop",
      "uninstall",
    ]);
  });

  it("each subcommand carries its own meta", async () => {
    const sub = serviceCommand.subCommands as Record<string, { meta?: unknown }>;
    for (const name of Object.keys(sub)) {
      const cmd = sub[name];
      const meta = typeof cmd.meta === "function" ? await (cmd.meta as () => unknown)() : cmd.meta;
      expect((meta as { name?: string })?.name).toBe(name);
    }
  });
});

describe("retired runner cleanup", () => {
  it("removes a legacy systemd user unit without restoring runner as a component", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-retired-runner-"));
    const unitDir = join(home, ".config", "systemd", "user");
    const unit = join(unitDir, "omnesis-runner.service");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(unit, "[Service]\nExecStart=/fictional/omnesis-runner\n");
    const calls: Array<[string, string[]]> = [];
    await expect(
      uninstallLegacyRunnerService({
        platform: "linux",
        home,
        exec: async (command, args) => {
          calls.push([command, args]);
          if (args.includes("is-active")) {
            return { code: 3, stdout: "inactive\n", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      }),
    ).resolves.toBe(true);
    expect(existsSync(unit)).toBe(false);
    expect(calls).toEqual([
      ["systemctl", ["--user", "disable", "--now", "omnesis-runner.service"]],
      ["systemctl", ["--user", "is-active", "omnesis-runner.service"]],
      ["systemctl", ["--user", "daemon-reload"]],
    ]);
    expect(() => parseComponentSelection("runner", [])).toThrow(/Unknown component/);
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps a Linux unit file when stop verification says the runner is active", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-retired-runner-active-"));
    const unitDir = join(home, ".config", "systemd", "user");
    const unit = join(unitDir, "omnesis-runner.service");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(unit, "[Service]\nExecStart=/fictional/omnesis-runner\n");

    await expect(
      uninstallLegacyRunnerService({
        platform: "linux",
        home,
        exec: async (_command, args) =>
          args.includes("is-active")
            ? { code: 0, stdout: "active\n", stderr: "" }
            : { code: 1, stdout: "", stderr: "fictional stop failure" },
      }),
    ).rejects.toThrow(/Could not verify.*stopped/);
    expect(existsSync(unit)).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps a launchd plist when the retired runner is still loaded", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-retired-runner-loaded-"));
    const unitDir = join(home, "Library", "LaunchAgents");
    const plist = join(unitDir, "dev.omnesis.runner.plist");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(plist, "<plist></plist>\n");

    await expect(
      uninstallLegacyRunnerService({
        platform: "darwin",
        home,
        uid: 501,
        exec: async (_command, args) =>
          args.includes("print")
            ? { code: 0, stdout: "state = running\n", stderr: "" }
            : { code: 1, stdout: "", stderr: "fictional bootout failure" },
      }),
    ).rejects.toThrow(/Could not verify.*stopped/);
    expect(existsSync(plist)).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("hardened mode guards", () => {
  it("install and uninstall expose a --hardened flag", async () => {
    const sub = serviceCommand.subCommands as Record<string, { args?: Record<string, unknown> }>;
    for (const name of ["install", "uninstall"]) {
      const cmd = sub[name];
      const args = typeof cmd.args === "function" ? await (cmd.args as () => unknown)() : cmd.args;
      expect(Object.keys(args as Record<string, unknown>)).toContain("hardened");
    }
  });

  it("start/stop/restart do not expose --hardened", async () => {
    const sub = serviceCommand.subCommands as Record<string, { args?: Record<string, unknown> }>;
    for (const name of ["start", "stop", "restart"]) {
      const cmd = sub[name];
      const args = typeof cmd.args === "function" ? await (cmd.args as () => unknown)() : cmd.args;
      expect(Object.keys(args as Record<string, unknown>)).not.toContain("hardened");
    }
  });

  it("is Linux-only, with a Docker pointer on macOS that does not equate the two", () => {
    expect(() => requireHardenedPlatform("linux")).not.toThrow();
    expect(() => requireHardenedPlatform("darwin")).toThrow(/macOS.*Docker/s);
    expect(() => requireHardenedPlatform("darwin")).toThrow(/not the same protection/);
    expect(() => requireHardenedPlatform("darwin")).not.toThrow(/same isolation/);
    expect(() => requireHardenedPlatform("win32")).toThrow(CliError);
  });

  it("requires the gateway to be named explicitly", () => {
    expect(() => requireHardenedGatewaySelection("gateway", "install")).not.toThrow();
    // The collector must stay as the login user; a bare/all selection could
    // silently include it, so both are rejected with the exact command to run.
    expect(() => requireHardenedGatewaySelection("collector", "install")).toThrow(/gateway only/);
    expect(() => requireHardenedGatewaySelection("all", "install")).toThrow(CliError);
    expect(() => requireHardenedGatewaySelection(undefined, "install")).toThrow(
      /service install gateway --hardened/,
    );
    expect(() => requireHardenedGatewaySelection(undefined, "uninstall")).toThrow(
      /service uninstall gateway --hardened/,
    );
  });

  it("rejects --instance and --config-dir combinations", () => {
    expect(() => rejectHardenedIncompatibleFlags({})).not.toThrow();
    expect(() => rejectHardenedIncompatibleFlags({ instance: "staging" })).toThrow(/--instance/);
    expect(() => rejectHardenedIncompatibleFlags({ "config-dir": "/srv/omnesis" })).toThrow(
      /--config-dir/,
    );
  });

  it("rejects the keyring wirings a dynamic user cannot reach", () => {
    // A file the dynamic uid can open is a file every local account can read,
    // so the credential form is the only safe one. The error has to name it:
    // silently dropping the flag leaves a unit that looks installed and cannot
    // open its keys.
    expect(() =>
      rejectHardenedKeyringFlags({ "keyring-passphrase-file": "/etc/omnesis/keyring.pass" }),
    ).toThrow(/--keyring-passphrase-credential/);
    expect(() => rejectHardenedKeyringFlags({ "secret-store": "secret-service" })).toThrow(
      /session bus/,
    );
    expect(() => rejectHardenedKeyringFlags({ "secret-store": "macos-keychain" })).toThrow(
      /Linux-only/,
    );
  });

  it("accepts the wirings it can serve", () => {
    for (const store of ["passphrase", "file"]) {
      expect(() => rejectHardenedKeyringFlags({ "secret-store": store })).not.toThrow();
    }
    // `auto` is what passing nothing means — the daemon chooses at boot — so
    // refusing it would refuse the default install along with it.
    expect(() => rejectHardenedKeyringFlags({ "secret-store": "auto" })).not.toThrow();
    expect(() => rejectHardenedKeyringFlags({})).not.toThrow();
  });

  it("leaves the keyring flags to the install gate", () => {
    // The shared gate also guards `uninstall`, which reads no keys and does not
    // declare these flags. Failing one over a wiring flag would answer it with
    // install-shaped advice for a command that installs nothing.
    const uninstallArgs: Record<string, unknown> = {
      "secret-store": "secret-service",
      "keyring-passphrase-file": "/etc/omnesis/keyring.pass",
    };
    expect(() => rejectHardenedIncompatibleFlags(uninstallArgs)).not.toThrow();
  });
});

describe("collectorFdaNote", () => {
  const NODE = "/opt/homebrew/Cellar/node@24/24.15.0/bin/node";

  it("tells a macOS collector to grant its node binary full-disk access", () => {
    const note = collectorFdaNote("collector", "darwin", NODE);
    expect(note).not.toBeNull();
    // Names the accessing binary (Node, not the omnesis wrapper) and the grant,
    // as the numbered procedure a refused source later repeats.
    expect(note).toContain(`executable: ${NODE}`);
    expect(note).toMatch(/full disk access is required/i);
    expect(note).toMatch(/1\. open system settings › privacy & security › full disk access\./i);
    expect(note).toContain("3. Restart the collector: omnesis service restart collector");
  });

  it("puts the grant within a drag: reveal the binary, open the pane", () => {
    expect(fdaOpenCommands(NODE)).toEqual([
      ["open", ["-R", NODE]],
      ["open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"]],
    ]);
  });

  it("opens the windows only for an operator at a terminal who did not opt out", async () => {
    const calls: string[][] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: "", stderr: "" };
    };
    expect(await openFdaGrant(NODE, { isTTY: false, noOpen: false }, run)).toBe(false);
    expect(await openFdaGrant(NODE, { isTTY: true, noOpen: true }, run)).toBe(false);
    expect(calls).toEqual([]);
    expect(await openFdaGrant(NODE, { isTTY: true, noOpen: false }, run)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("reports that the windows did not open when an open fails, and never throws", async () => {
    const failing = async () => ({ code: 1, stdout: "", stderr: "no display" });
    expect(await openFdaGrant(NODE, { isTTY: true, noOpen: false }, failing)).toBe(false);
  });

  it("says nothing on Linux — full-disk access is a macOS TCC concept", () => {
    expect(collectorFdaNote("collector", "linux", NODE)).toBeNull();
  });

  it("says nothing for the gateway — it does not read the user's Apple data", () => {
    expect(collectorFdaNote("gateway", "darwin", NODE)).toBeNull();
  });
});

describe("resolveSudoUserHome", () => {
  const passwd = [
    "root:x:0:0:root:/root:/bin/bash",
    "maya:x:1000:1000::/srv/homes/maya:/bin/zsh",
    "jamie:x:1001:1001::/home/jamie:/bin/bash",
  ].join("\n");

  it("resolves the home from the passwd entry (covers non-standard home dirs)", () => {
    expect(resolveSudoUserHome("maya", passwd)).toBe("/srv/homes/maya");
    expect(resolveSudoUserHome("jamie", passwd)).toBe("/home/jamie");
  });

  it("falls back to /home/<user> when the entry is missing or passwd is unreadable", () => {
    expect(resolveSudoUserHome("sasha", passwd)).toBe("/home/sasha");
    expect(resolveSudoUserHome("maya", null)).toBe("/home/maya");
  });
});

describe("parseComponentSelection", () => {
  it("falls back to the verb default when absent", () => {
    expect(parseComponentSelection(undefined, ["gateway", "collector"])).toEqual([
      "gateway",
      "collector",
    ]);
    expect(parseComponentSelection("", ["gateway"])).toEqual(["gateway"]);
  });

  it("expands all to every component", () => {
    expect(parseComponentSelection("all", ["gateway"])).toEqual(["gateway", "collector"]);
  });

  it("accepts a single component", () => {
    expect(parseComponentSelection("collector", ["gateway"])).toEqual(["collector"]);
  });

  it("rejects unknown components", () => {
    expect(() => parseComponentSelection("portal", ["gateway"])).toThrow(CliError);
  });
});

describe("parseEnvFlags", () => {
  it("returns empty for no flags", () => {
    expect(parseEnvFlags(undefined)).toEqual({});
  });

  it("parses a single KEY=VAL string", () => {
    expect(parseEnvFlags("OMNESIS_GATEWAY_PORT=17600")).toEqual({
      OMNESIS_GATEWAY_PORT: "17600",
    });
  });

  it("parses repeated flags (array at runtime)", () => {
    expect(parseEnvFlags(["A=1", "B=two words"])).toEqual({ A: "1", B: "two words" });
  });

  it("keeps = characters inside the value", () => {
    expect(parseEnvFlags("QUERY=a=b=c")).toEqual({ QUERY: "a=b=c" });
  });

  it("allows an empty value", () => {
    expect(parseEnvFlags("EMPTY=")).toEqual({ EMPTY: "" });
  });

  it("rejects entries without =, empty keys, and non-identifier keys", () => {
    expect(() => parseEnvFlags("NOVALUE")).toThrow(CliError);
    expect(() => parseEnvFlags("=val")).toThrow(CliError);
    expect(() => parseEnvFlags("BAD-KEY=val")).toThrow(CliError);
    expect(() => parseEnvFlags("1LEADING=val")).toThrow(CliError);
  });

  it("rejects a value that would break out of its Environment= line", () => {
    // The value is rendered into one unit line, and under --hardened that unit
    // is owned by root: a newline lets whatever follows be read as further
    // directives, and a trailing backslash splices the next line onto it.
    expect(() => parseEnvFlags("A=one\nUser=root")).toThrow(/control characters/);
    expect(() => parseEnvFlags("A=trailing\\")).toThrow(/backslash/);
    // Ordinary values, including spaces and =, keep working.
    expect(parseEnvFlags(["A=two words", "B=a=b"])).toEqual({ A: "two words", B: "a=b" });
  });
});

describe("collectEnvFlags", () => {
  it("collects every --env occurrence from rawArgs (citty string args are last-wins)", () => {
    expect(
      collectEnvFlags(["install", "gateway", "--env", "A=1", "--instance", "x", "--env", "B=2"]),
    ).toEqual(["A=1", "B=2"]);
  });

  it("supports --env=KEY=VAL form", () => {
    expect(collectEnvFlags(["--env=A=1", "--env", "B=2"])).toEqual(["A=1", "B=2"]);
  });

  it("returns empty when absent", () => {
    expect(collectEnvFlags(["install", "gateway"])).toEqual([]);
  });
});

describe("parseInstanceFlag", () => {
  it("is undefined when absent or empty", () => {
    expect(parseInstanceFlag(undefined)).toBeUndefined();
    expect(parseInstanceFlag("")).toBeUndefined();
  });

  it("accepts letters, digits, and dashes", () => {
    expect(parseInstanceFlag("e2e-tmp")).toBe("e2e-tmp");
    expect(parseInstanceFlag("Staging2")).toBe("Staging2");
  });

  it("rejects names that would corrupt a unit name", () => {
    expect(() => parseInstanceFlag("has space")).toThrow(CliError);
    expect(() => parseInstanceFlag("dots.bad")).toThrow(CliError);
    expect(() => parseInstanceFlag("-leading")).toThrow(CliError);
  });
});

describe("parseLinesFlag", () => {
  it("defaults to 100", () => {
    expect(parseLinesFlag(undefined)).toBe(100);
    expect(parseLinesFlag("")).toBe(100);
  });

  it("parses positive integers", () => {
    expect(parseLinesFlag("25")).toBe(25);
  });

  it("rejects zero, negatives, and non-numeric input", () => {
    expect(() => parseLinesFlag("0")).toThrow(CliError);
    expect(() => parseLinesFlag("-5")).toThrow(CliError);
    expect(() => parseLinesFlag("ten")).toThrow(CliError);
    expect(() => parseLinesFlag("12abc")).toThrow(CliError);
  });
});

describe("resolveKeyringWiring", () => {
  const dirs: string[] = [];
  // An empty config dir → no armed root key → auto-detect stays quiet.
  function emptyConfigDir(): string {
    const d = mkdtempSync(join(tmpdir(), "omnesis-svc-cfg-"));
    dirs.push(d);
    return d;
  }
  function passFile(contents = "hunter2\n"): string {
    const d = mkdtempSync(join(tmpdir(), "omnesis-svc-pass-"));
    dirs.push(d);
    const p = join(d, "keyring.pass");
    writeFileSync(p, contents, { mode: 0o600 });
    return p;
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("install exposes the keyring flags", async () => {
    const sub = serviceCommand.subCommands as Record<string, { args?: Record<string, unknown> }>;
    const cmd = sub.install;
    const args = typeof cmd.args === "function" ? await (cmd.args as () => unknown)() : cmd.args;
    const keys = Object.keys(args as Record<string, unknown>);
    expect(keys).toContain("secret-store");
    expect(keys).toContain("keyring-passphrase-credential");
    expect(keys).toContain("keyring-passphrase-file");
  });

  it("wires the passphrase backend + a credential source on Linux", async () => {
    const p = passFile();
    const w = await resolveKeyringWiring(
      { secretStore: "passphrase", credential: p },
      emptyConfigDir(),
      "linux",
    );
    expect(w).toEqual({ secretStore: "passphrase", passphraseCredentialPath: p });
  });

  it("wires the passphrase backend + a file source", async () => {
    const p = passFile();
    const w = await resolveKeyringWiring(
      { secretStore: "passphrase", file: p },
      emptyConfigDir(),
      "darwin",
    );
    expect(w).toEqual({ secretStore: "passphrase", passphraseFilePath: p });
  });

  it("requires a source for the passphrase backend", async () => {
    await expect(
      resolveKeyringWiring({ secretStore: "passphrase" }, emptyConfigDir(), "linux"),
    ).rejects.toThrow(/needs a source/);
  });

  it("rejects both a credential and a file", async () => {
    const p = passFile();
    await expect(
      resolveKeyringWiring(
        { secretStore: "passphrase", credential: p, file: p },
        emptyConfigDir(),
        "linux",
      ),
    ).rejects.toThrow(/only one/i);
  });

  it("rejects a systemd credential on macOS", async () => {
    const p = passFile();
    await expect(
      resolveKeyringWiring(
        { secretStore: "passphrase", credential: p },
        emptyConfigDir(),
        "darwin",
      ),
    ).rejects.toThrow(/systemd-only/i);
  });

  it("rejects a relative, empty, or unreadable passphrase source", async () => {
    const cfg = emptyConfigDir();
    await expect(
      resolveKeyringWiring(
        { secretStore: "passphrase", file: "relative/keyring.pass" },
        cfg,
        "linux",
      ),
    ).rejects.toThrow(/absolute/i);
    await expect(
      resolveKeyringWiring({ secretStore: "passphrase", file: passFile("\n") }, cfg, "linux"),
    ).rejects.toThrow(/empty/i);
    await expect(
      resolveKeyringWiring(
        { secretStore: "passphrase", file: "/no/such/keyring.pass" },
        cfg,
        "linux",
      ),
    ).rejects.toThrow(/not readable/i);
  });

  it("rejects a passphrase path a unit line cannot carry", async () => {
    // The path is rendered into a unit line. A newline ends that line and lets
    // the rest be read as further directives; a trailing backslash splices the
    // next line onto the value. No escaping survives either, so both are
    // refused rather than rendered.
    const cfg = emptyConfigDir();
    for (const bad of ["/etc/omnesis/keyring.pass\nUser=root", "/etc/omnesis/keyring.pass\\"]) {
      await expect(
        resolveKeyringWiring({ secretStore: "passphrase", file: bad }, cfg, "linux"),
      ).rejects.toThrow(/control characters or end in a backslash/i);
    }
  });

  it("a passphrase-sealed keyring is not auto-selected, so a re-install still registers", async () => {
    // Detection must never pick the passphrase backend: selecting it demands a
    // source flag this run was never given, and the install then refuses to
    // register services while reporting success. That is every re-run on a
    // headless box — they all arm a passphrase keyring — and the rescue path
    // after a failed update, where the machine is already sealed.
    const sealed = {
      store: { backend: "passphrase" as const },
      valid: true,
    } as unknown as InstallRootKeyState;
    const inspectRootKey: typeof inspectInstallRootKey = () => Promise.resolve(sealed);

    await expect(
      resolveKeyringWiring({}, emptyConfigDir(), "linux", { inspectRootKey }),
    ).resolves.toEqual({});
  });

  it("a system unit detects no backend — the caller's keyring is not its own", async () => {
    // Detection probes whoever runs the CLI: the `secret-service` backend
    // answers from their login keyring regardless of the config dir handed to
    // it. For a unit that will run under another identity that answer is about
    // the wrong keyring, and baking it in would hand the daemon the very
    // backend the hardened install refuses.
    const armed = {
      store: { backend: "secret-service" as const },
      valid: true,
    } as unknown as InstallRootKeyState;
    let probed = 0;
    const counting: typeof inspectInstallRootKey = () => {
      probed += 1;
      return Promise.resolve(armed);
    };

    expect(
      await resolveKeyringWiring({}, emptyConfigDir(), "linux", {
        unitRunsAs: "system",
        inspectRootKey: counting,
      }),
    ).toEqual({});
    expect(probed).toBe(0);

    // The same armed keyring is exactly what a unit running as the caller
    // should pick up, so the skip has to be about identity, not about the
    // probe being broken.
    expect(
      await resolveKeyringWiring({}, emptyConfigDir(), "linux", { inspectRootKey: counting }),
    ).toEqual({ secretStore: "secret-service" });
    expect(probed).toBe(1);
  });

  // Root bypasses file modes, so the unreadable fixture cannot be built there.
  const asUnprivilegedUser = (process.getuid?.() ?? 0) !== 0;

  it.skipIf(!asUnprivilegedUser)(
    "a system unit accepts a credential the caller cannot read",
    async () => {
      // The whole point of a credential: the service manager reads it as root.
      // Requiring the caller to read it too would rule out the owner-only file
      // that makes the mechanism worth using.
      const p = passFile();
      chmodSync(p, 0o000);
      const w = await resolveKeyringWiring(
        { secretStore: "passphrase", credential: p },
        emptyConfigDir(),
        "linux",
        { unitRunsAs: "system" },
      );
      expect(w).toEqual({ secretStore: "passphrase", passphraseCredentialPath: p });
      // A unit that runs as the caller has no such excuse.
      await expect(
        resolveKeyringWiring(
          { secretStore: "passphrase", credential: p },
          emptyConfigDir(),
          "linux",
        ),
      ).rejects.toThrow(/not readable/i);
    },
  );

  it("still rejects a credential path that does not exist at all", async () => {
    await expect(
      resolveKeyringWiring(
        { secretStore: "passphrase", credential: "/no/such/keyring.pass" },
        emptyConfigDir(),
        "linux",
        { unitRunsAs: "system" },
      ),
    ).rejects.toThrow(/not readable/i);
  });

  it("rejects a passphrase source no backend will read", async () => {
    // The mirror image of the missing-source error, and just as silent: only
    // the passphrase backend reads a passphrase, so a source given to any
    // other backend rides into the unit and is never consulted.
    const p = passFile();
    const cfg = emptyConfigDir();
    await expect(
      resolveKeyringWiring({ secretStore: "file", credential: p }, cfg, "linux"),
    ).rejects.toThrow(/only applies to the passphrase keyring/);
    await expect(
      resolveKeyringWiring({ secretStore: "file", file: p }, cfg, "linux"),
    ).rejects.toThrow(/only applies to the passphrase keyring/);
    // Naming no backend at all is the same trap, since `auto` never picks it.
    await expect(
      resolveKeyringWiring({ file: p }, cfg, "linux", { unitRunsAs: "system" }),
    ).rejects.toThrow(/only applies to the passphrase keyring/);
  });

  it("rejects an invalid backend name", async () => {
    await expect(
      resolveKeyringWiring({ secretStore: "bogus" }, emptyConfigDir(), "linux"),
    ).rejects.toThrow(/OMNESIS_SECRET_STORE|Expected one of/);
  });

  it("no flags on an unarmed config dir wires nothing", async () => {
    const w = await resolveKeyringWiring({}, emptyConfigDir(), "linux");
    expect(w).toEqual({});
  });
});

describe("warnOnUnsupportedCredential", () => {
  const credential = { passphraseCredentialPath: "/etc/omnesis/keyring.pass" };

  it("warns when this host's systemd would ignore the credential it just wired", async () => {
    const exec = async () => ({ code: 0, stdout: "systemd 245 (245.4-4ubuntu3)\n", stderr: "" });
    expect(await warnOnUnsupportedCredential(credential, "linux", exec)).toMatch(/245/);
  });

  it("says nothing without a credential, off Linux, or on a supported systemd", async () => {
    const old = async () => ({ code: 0, stdout: "systemd 245 (245.4)\n", stderr: "" });
    const current = async () => ({ code: 0, stdout: "systemd 255 (255.4)\n", stderr: "" });
    // No credential: nothing was wired that could be ignored.
    expect(await warnOnUnsupportedCredential({}, "linux", old)).toBeNull();
    // launchd has no credential concept, so the systemd version is irrelevant.
    expect(await warnOnUnsupportedCredential(credential, "darwin", old)).toBeNull();
    expect(await warnOnUnsupportedCredential(credential, "linux", current)).toBeNull();
  });

  it("says nothing when systemctl is absent", async () => {
    // The runner reports a missing binary as a non-zero exit with empty output
    // rather than rejecting, so an install on a non-systemd host stays quiet.
    const missing = async () => ({ code: 127, stdout: "", stderr: "not found" });
    expect(await warnOnUnsupportedCredential(credential, "linux", missing)).toBeNull();
  });
});

describe("collectorGatewayUrl", () => {
  // A collector on the gateway's own machine must not depend on the address the
  // install recorded for other machines (OMNESIS_GATEWAY_URL in .env), which may
  // not resolve here. Its unit names loopback, which wins over the .env value.
  const base = {
    component: "collector" as const,
    installingAlongsideGateway: false,
    gatewayAlreadyInstalled: false,
    extraEnv: {} as Record<string, string>,
    configEnvContent: undefined as string | undefined,
    // No certificate minted there yet: the gateway's self-signed one names localhost.
    configDir: join(tmpdir(), "omnesis-collector-gateway-url-unminted"),
  };

  it("a collector installed with its gateway dials loopback on the default port", () => {
    expect(collectorGatewayUrl({ ...base, installingAlongsideGateway: true })).toBe(
      "https://localhost:7600",
    );
  });

  it("a gateway already on this host counts the same, on every platform's collector", () => {
    expect(collectorGatewayUrl({ ...base, gatewayAlreadyInstalled: true })).toBe(
      "https://localhost:7600",
    );
  });

  it("the port comes from --env, then the config .env", () => {
    expect(
      collectorGatewayUrl({
        ...base,
        installingAlongsideGateway: true,
        configEnvContent:
          "OMNESIS_GATEWAY_URL=https://omnesis.local:7443\nOMNESIS_GATEWAY_PORT=7443\n",
      }),
    ).toBe("https://localhost:7443");
    expect(
      collectorGatewayUrl({
        ...base,
        installingAlongsideGateway: true,
        extraEnv: { OMNESIS_GATEWAY_PORT: "7601" },
        configEnvContent: "OMNESIS_GATEWAY_PORT=7443\n",
      }),
    ).toBe("https://localhost:7601");
  });

  it("an operator's --env OMNESIS_GATEWAY_URL is kept as given", () => {
    expect(
      collectorGatewayUrl({
        ...base,
        installingAlongsideGateway: true,
        extraEnv: { OMNESIS_GATEWAY_URL: "https://gateway.example.org:7600" },
      }),
    ).toBeUndefined();
  });

  // A tailnet certificate from `omnesis tls provision`, or an operator's own,
  // names only its host; loopback would fail its check, so the recorded
  // address in the config .env stays in charge.
  it("a certificate served without localhost leaves the unit alone", () => {
    const seen: Array<{ dir: string; cert: string | undefined }> = [];
    expect(
      collectorGatewayUrl({
        ...base,
        installingAlongsideGateway: true,
        configDir: "/fictional/config",
        configEnvContent:
          "OMNESIS_TLS_CERT=/fictional/config/tls/tailscale.crt\nOMNESIS_TLS_KEY=/fictional/config/tls/tailscale.key\n",
        coversLocalhost: (dir, env) => {
          seen.push({ dir, cert: env?.OMNESIS_TLS_CERT });
          return false;
        },
      }),
    ).toBeUndefined();
    expect(seen).toEqual([
      { dir: "/fictional/config", cert: "/fictional/config/tls/tailscale.crt" },
    ]);
  });

  it("certificate settings passed with --env win over the config .env ones", () => {
    const seen: Array<string | undefined> = [];
    expect(
      collectorGatewayUrl({
        ...base,
        installingAlongsideGateway: true,
        configEnvContent: "OMNESIS_TLS_CERT=/fictional/a.crt\nOMNESIS_TLS_KEY=/fictional/a.key\n",
        extraEnv: { OMNESIS_TLS_CERT: "/fictional/b.crt", OMNESIS_TLS_KEY: "/fictional/b.key" },
        coversLocalhost: (_dir, env) => {
          seen.push(env?.OMNESIS_TLS_CERT);
          return true;
        },
      }),
    ).toBe("https://localhost:7600");
    expect(seen).toEqual(["/fictional/b.crt"]);
  });

  it("no gateway on this host, or not a collector, leaves the unit alone", () => {
    expect(collectorGatewayUrl(base)).toBeUndefined();
    expect(
      collectorGatewayUrl({ ...base, component: "gateway", installingAlongsideGateway: true }),
    ).toBeUndefined();
  });
});

describe("collectorAfterUnit", () => {
  const base = {
    platform: "linux" as const,
    component: "collector" as const,
    installingAlongsideGateway: false,
    gatewayAlreadyInstalled: false,
    gatewayUnitName: "omnesis-gateway.service",
  };

  it("orders after a gateway installed in the same command", () => {
    expect(collectorAfterUnit({ ...base, installingAlongsideGateway: true })).toBe(
      "omnesis-gateway.service",
    );
  });

  // A host that got its gateway unit first and a collector in a second
  // `service install collector` still orders the two: the decision is about
  // what is on the host, not about what one command happened to name.
  it("orders after a gateway unit installed by an earlier invocation", () => {
    expect(collectorAfterUnit({ ...base, gatewayAlreadyInstalled: true })).toBe(
      "omnesis-gateway.service",
    );
  });

  it("has nothing to order after on a host with no gateway unit", () => {
    expect(collectorAfterUnit(base)).toBeUndefined();
  });

  it("never orders the gateway itself, and never orders on launchd", () => {
    expect(
      collectorAfterUnit({ ...base, component: "gateway", gatewayAlreadyInstalled: true }),
    ).toBeUndefined();
    expect(
      collectorAfterUnit({ ...base, platform: "darwin", gatewayAlreadyInstalled: true }),
    ).toBeUndefined();
  });
});

describe("needsPairingNotice", () => {
  it("says nothing while the collector is paired", () => {
    expect(
      needsPairingNotice({
        state: "paired",
        deviceName: "workstation-collector",
        gatewayUrl: "https://gateway.example.com:7600",
        repairCommand: null,
      }),
    ).toEqual([]);
  });

  // A supervisor only reports that the process stopped. The reason and the
  // whole recovery come from the file the collector wrote on its way out.
  it("names the device, the gateway and every step of the recovery", () => {
    const out = needsPairingNotice({
      state: "needs-pairing",
      deviceName: "workstation-collector",
      gatewayUrl: "https://gateway.example.com:7600",
      repairCommand: "omnesis devices repair workstation-collector",
    }).join("\n");
    expect(out).toContain("workstation-collector");
    expect(out).toContain("https://gateway.example.com:7600");
    expect(out).toContain("omnesis devices repair workstation-collector");
    expect(out).toContain("omnesis pair <code>");
    expect(out).toContain("omnesis service start collector");
  });

  it("falls back to a derived repair command when the record has none", () => {
    const out = needsPairingNotice({
      state: "needs-pairing",
      deviceName: "workstation-collector",
      gatewayUrl: "https://gateway.example.com:7600",
      repairCommand: null,
    }).join("\n");
    expect(out).toContain("omnesis devices repair workstation-collector");
  });
});
