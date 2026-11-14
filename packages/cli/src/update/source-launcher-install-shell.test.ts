// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { acquireUpdateLock, PRELOAD_SOURCE, UpdateLockBusyError } from "@omnesis/core";
import {
  prepareSourceRecoveryLauncher as prepareRealSourceRecoveryLauncher,
  sourceRecoveryLauncher,
} from "./source-launcher.js";

const { sourceLoaderFixture } = createRequire(import.meta.url)(
  "../../../../scripts/release/source-loader-fixture.mjs",
) as { sourceLoaderFixture: string };
const fixtureLoader =
  sourceLoaderFixture.split("<<'OMNESIS_TEST_LOADER'\n")[1].split("\nOMNESIS_TEST_LOADER")[0] +
  "\n";

function prepareSourceRecoveryLauncher(
  rootDir: string,
  configDir: string,
  homeDir: string,
): string {
  // Lifecycle tests substitute the CLI body behind a fixture Node preload.
  if (existsSync(join(rootDir, "node_modules/.bin/tsx"))) {
    mkdirSync(join(rootDir, "node_modules/tsx/dist"), { recursive: true });
    writeFileSync(join(rootDir, "node_modules/tsx/dist/loader.mjs"), fixtureLoader);
  }
  return prepareRealSourceRecoveryLauncher(rootDir, configDir, homeDir);
}

/** The installer functions render_source_wrapper calls for the trust preload. */
function trustHelpers(installer: string): string {
  return ["npm_trust_preload", "render_source_npm_trust", "render_source_daemon_recovery"]
    .map((name) => {
      const start = installer.indexOf(`${name}() {`);
      expect(start).toBeGreaterThan(0);
      return installer.slice(start, installer.indexOf("\nEOF\n}\n", start) + 7);
    })
    .join("\n");
}

const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});
describe("installed POSIX source launcher", () => {
  test("rendered source front door preserves a delayed graceful shutdown without a tsx supervisor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-signal-"));
    scratch.push(dir);
    const rootDir = join(dir, "owner's source #with?url");
    mkdirSync(join(rootDir, "node_modules"), { recursive: true });
    mkdirSync(join(rootDir, "packages/cli/src"), { recursive: true });
    writeFileSync(join(rootDir, "packages/cli/package.json"), JSON.stringify({ type: "module" }));
    symlinkSync(join(process.cwd(), "node_modules/tsx"), join(rootDir, "node_modules/tsx"), "dir");
    const ready = join(dir, "ready");
    const completed = join(dir, "completed");
    writeFileSync(
      join(rootDir, "packages/cli/src/index.ts"),
      `import {writeFileSync} from 'node:fs';
process.on('SIGTERM',()=>{const end=Date.now()+250;while(Date.now()<end){};writeFileSync(${JSON.stringify(completed)},'drained');process.exit(0)});
writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);
`,
    );
    const installer = readFileSync(join(process.cwd(), "scripts/install.sh"), "utf8");
    const start = installer.indexOf("render_source_wrapper() {");
    const quoteStart = installer.indexOf("shell_single_quote() {");
    const render = join(dir, "render.sh");
    writeFileSync(
      render,
      `${installer.slice(quoteStart, installer.indexOf("\n}\n", quoteStart) + 3)}\n${trustHelpers(installer)}\n${installer.slice(start, installer.indexOf("\nEOF\n}", start) + 6)}\nCONFIG_DIR="$1"\nUPDATE_LOCK_HELPER="$2"\nrender_source_wrapper "$3"\n`,
    );
    const launcher = join(dir, "omnesis");
    writeFileSync(
      launcher,
      execFileSync("sh", [render, join(dir, "config"), join(dir, "lock.cjs"), rootDir]),
      { mode: 0o755 },
    );
    const child = spawn(launcher, ["gateway", "serve"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, OMNESIS_CONFIG_DIR: join(dir, "config"), OMNESIS_UPDATE_LOCK_ID: "" },
    });
    const closed = once(child, "close");
    const groupRunning = (): boolean =>
      spawnSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8" })
        .stdout.split("\n")
        .some((line) => {
          const [group, state] = line.trim().split(/\s+/u);
          return Number(group) === child.pid && state !== undefined && !state.startsWith("Z");
        });
    const failures: unknown[] = [];
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(ready) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(ready)).toBe(true);
      // The wrapper must exec the daemon: there is no parent with tsx's 60ms
      // signal-forwarding deadline between the service manager and this PID.
      expect(Number(readFileSync(ready, "utf8"))).toBe(child.pid);
      process.kill(-child.pid!, "SIGTERM");
      const [code, signal] = await closed;
      expect({ code, signal }).toEqual({ code: 0, signal: null });
      expect(readFileSync(completed, "utf8")).toBe("drained");
      const deadlineGone = Date.now() + 2000;
      while (groupRunning() && Date.now() < deadlineGone)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(groupRunning()).toBe(false);
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        if (child.pid && groupRunning()) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failures.push(error);
      }
      try {
        await closed;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Source launcher proof or cleanup failed");
  }, 20_000);

  test("restores dependencies with npm and node-gyp under the trust preload, then removes it", () => {
    const launcher = sourceRecoveryLauncher("/srv/omnesis", "/srv/config", "/srv/lock.cjs");
    const install = launcher.slice(
      launcher.indexOf("install_source_dependencies() {"),
      launcher.indexOf("\n}\n", launcher.indexOf("install_source_dependencies() {")),
    );
    expect(install.match(/&& with_npm_trust npm ci \)/g)).toHaveLength(2);
    expect(install).not.toMatch(/&& npm ci/);
    expect(launcher).toContain('( cd "$1" && with_npm_trust node -e \'');
    // The launcher's own with_npm_trust, under a temporary directory whose
    // path holds a space (GNU mktemp follows TMPDIR), running a real node that
    // reads the preload back through the URL it was given.
    const bin = mkdtempSync(join(tmpdir(), "omnesis-npm-trust-"));
    scratch.push(bin);
    writeFileSync(
      join(bin, "mktemp"),
      `#!/bin/sh\nd='${bin}/with space #1/tmp'\nmkdir -p "$d" && printf '%s\\n' "$d"\n`,
      { mode: 0o755 },
    );
    const readBack =
      'const u = process.env.NODE_OPTIONS.split("--import=").pop(); ' +
      'process.stdout.write(process.env.NODE_OPTIONS + "\\n" + require("fs").readFileSync(new URL(u), "utf8"));';
    const start = launcher.indexOf("with_npm_trust() {");
    // Past the preload it embeds, whose own blocks also close with "}".
    const end = launcher.indexOf("\n}\n", launcher.indexOf("\nNPM_TRUST_EOF\n", start)) + 3;
    const definition = launcher.slice(start, end);
    const result = spawnSync(
      "sh",
      ["-c", `${definition}\nwith_npm_trust "${process.execPath}" -e '${readBack}'`],
      {
        encoding: "utf8",
        env: { PATH: `${bin}:${process.env.PATH ?? ""}`, NODE_OPTIONS: "--max-old-space-size=512" },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const [options = "", ...body] = result.stdout.split("\n");
    expect(options).toMatch(
      /^--max-old-space-size=512 --import=file:\/\/\S+\/distrust-roots\.mjs$/u,
    );
    expect(body.join("\n")).toBe(PRELOAD_SOURCE);
    expect(existsSync(fileURLToPath(options.replace(/^.*--import=/u, "")))).toBe(false);
  });

  test("stays byte-identical to the toolchain-free installer's renderer", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
    scratch.push(dir);
    const installer = readFileSync(join(process.cwd(), "scripts", "install.sh"), "utf8");
    const quoteStart = installer.indexOf("shell_single_quote() {");
    const quoteEnd = installer.indexOf("\n}\n", quoteStart) + 3;
    const rendererStart = installer.indexOf("render_source_wrapper() {");
    const rendererEnd = installer.indexOf("\nEOF\n}", rendererStart) + 6;
    expect(quoteStart).toBeGreaterThan(0);
    expect(rendererStart).toBeGreaterThan(0);
    const probe = join(dir, "render-launcher.sh");
    writeFileSync(
      probe,
      `${installer.slice(quoteStart, quoteEnd)}\n${trustHelpers(installer)}\n${installer.slice(rendererStart, rendererEnd)}\nCONFIG_DIR="$1"\nUPDATE_LOCK_HELPER="$2"\nrender_source_wrapper "$3"\n`,
    );
    const rootDir = "/tmp/owner's source";
    const configDir = "/tmp/config dir";
    const lockHelper = "/tmp/update-lock.cjs";
    const rendered = execFileSync("sh", [probe, configDir, lockHelper, rootDir], {
      encoding: "utf8",
    });
    expect(rendered).toBe(sourceRecoveryLauncher(rootDir, configDir, lockHelper));
  });

  describe("finds Homebrew's keg-only node@24", () => {
    function kegFixture(): { launcher: string; env: NodeJS.ProcessEnv; tsx: string; bin: string } {
      const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
      scratch.push(dir);
      const rootDir = join(dir, "source");
      const configDir = join(dir, "config");
      const brewPrefix = join(dir, "brew");
      const kegBin = join(brewPrefix, "opt", "node@24", "bin");
      const bin = join(dir, "bin");
      const tsx = join(rootDir, "node_modules", ".bin", "tsx");
      mkdirSync(join(rootDir, "node_modules", ".bin"), { recursive: true });
      mkdirSync(kegBin, { recursive: true });
      mkdirSync(bin);
      writeFileSync(tsx, "#!/usr/bin/env node\n", { mode: 0o755 });
      writeFileSync(
        join(kegBin, "node"),
        `#!/bin/sh\n[ "$1" != -e ] || exec ${JSON.stringify(process.execPath)} "$@"\nprintf "keg node:%s\\n" "$*"\n`,
        {
          mode: 0o755,
        },
      );
      const launcher = prepareSourceRecoveryLauncher(rootDir, configDir, join(dir, "home"));
      const env = { PATH: bin, HOMEBREW_PREFIX: brewPrefix, OMNESIS_CONFIG_DIR: configDir };
      return { launcher, env, tsx, bin };
    }

    test("when the caller's PATH has no node", () => {
      const { launcher, env, tsx } = kegFixture();
      const output = execFileSync(launcher, ["status"], { encoding: "utf8", env });
      expect(output).toBe(
        `keg node:--import ${pathToFileURL(join(dirname(dirname(tsx)), "tsx/dist/loader.mjs")).href} ${join(dirname(dirname(dirname(tsx))), "packages/cli/src/index.ts")} status\n`,
      );
    });

    test("when the caller's PATH has a Node older than 24", () => {
      const { launcher, env, tsx, bin } = kegFixture();
      writeFileSync(
        join(bin, "node"),
        '#!/bin/sh\n[ "$1" = --version ] && echo v20.11.1 && exit 0\necho old node\n',
        {
          mode: 0o755,
        },
      );
      const output = execFileSync(launcher, ["status"], { encoding: "utf8", env });
      expect(
        output.startsWith(
          `keg node:--import ${pathToFileURL(join(dirname(dirname(tsx)), "tsx/dist/loader.mjs")).href} `,
        ),
      ).toBe(true);
    });

    test("but keeps a Node 24 or newer that is already on PATH", () => {
      const { launcher, env, bin } = kegFixture();
      writeFileSync(
        join(bin, "node"),
        '#!/bin/sh\n[ "$1" = --version ] && echo v25.2.0 && exit 0\necho path node\n',
        {
          mode: 0o755,
        },
      );
      const output = execFileSync(launcher, ["status"], { encoding: "utf8", env });
      expect(output).toBe("path node\n");
    });
  });

  test("does not take a pre-CLI lock for an ordinary update or dry run", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
    scratch.push(dir);
    const rootDir = join(dir, "source");
    const homeDir = join(dir, "home");
    const configDir = join(dir, "config");
    const tsx = join(rootDir, "node_modules", ".bin", "tsx");
    mkdirSync(join(rootDir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(tsx, `#!/bin/sh\n[ ! -d ${JSON.stringify(join(configDir, "update.lock"))} ]\n`, {
      mode: 0o755,
    });
    const launcher = prepareSourceRecoveryLauncher(rootDir, configDir, homeDir);

    execFileSync(launcher, ["update", "--dry-run"], {
      env: { ...process.env, OMNESIS_CONFIG_DIR: configDir },
    });
    expect(existsSync(join(configDir, "update.lock"))).toBe(false);
  });

  test("standalone dependency recovery carries one live lock into the CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
    scratch.push(dir);
    const rootDir = join(dir, "source");
    const homeDir = join(dir, "home");
    const configDir = join(dir, "config");
    const fakeBin = join(dir, "bin");
    const fakeTsx = join(dir, "tsx");
    mkdirSync(rootDir);
    mkdirSync(fakeBin);
    writeFileSync(
      fakeTsx,
      `#!/bin/sh\n${JSON.stringify(process.execPath)} -e 'const fs = require("node:fs"); const owner = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (owner.id !== process.env.OMNESIS_UPDATE_LOCK_ID) process.exit(1);' "$OMNESIS_CONFIG_DIR/update.lock/owner.json"\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(fakeBin, "npm"),
      `#!/bin/sh\n${sourceLoaderFixture}mkdir -p node_modules/.bin\ncp "$FAKE_TSX" node_modules/.bin/tsx\nchmod 755 node_modules/.bin/tsx\n`,
      { mode: 0o755 },
    );
    const launcher = prepareSourceRecoveryLauncher(rootDir, configDir, homeDir);

    execFileSync(launcher, ["update"], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        FAKE_TSX: fakeTsx,
        OMNESIS_CONFIG_DIR: configDir,
        OMNESIS_UPDATE_LOCK_ID: "",
      },
    });
    expect(existsSync(join(configDir, "update.lock"))).toBe(false);
  });

  test("a loader URL encoding failure releases the dependency-recovery lock without running the CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
    scratch.push(dir);
    const rootDir = join(dir, "source");
    const configDir = join(dir, "config");
    const bin = join(dir, "bin");
    const ran = join(dir, "cli-ran");
    mkdirSync(rootDir);
    mkdirSync(bin);
    writeFileSync(
      join(bin, "node"),
      `#!/bin/sh\ncase "\${2:-}" in *pathToFileURL*) exit 37 ;; esac\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "npm"),
      `#!/bin/sh\n${sourceLoaderFixture}mkdir -p node_modules/.bin\nprintf '#!/bin/sh\\ntouch %s\\n' ${JSON.stringify(JSON.stringify(ran))} > node_modules/.bin/tsx\n`,
      { mode: 0o755 },
    );
    const launcher = prepareSourceRecoveryLauncher(rootDir, configDir, join(dir, "home"));
    const result = spawnSync(launcher, ["update"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        OMNESIS_CONFIG_DIR: configDir,
        OMNESIS_UPDATE_LOCK_ID: "",
      },
    });
    expect(result.status).toBe(1);
    expect(existsSync(ran)).toBe(false);
    expect(existsSync(join(configDir, "update.lock"))).toBe(false);
  });

  test("repairs a missing loader even when the old tsx executable remains", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
    scratch.push(dir);
    const rootDir = join(dir, "source");
    const configDir = join(dir, "config");
    const bin = join(dir, "bin");
    const installed = join(dir, "installed");
    mkdirSync(join(rootDir, "node_modules/.bin"), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(rootDir, "node_modules/.bin/tsx"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    writeFileSync(
      join(bin, "npm"),
      `#!/bin/sh\n${sourceLoaderFixture}printf '#!/bin/sh\\nexit 0\\n' > node_modules/.bin/tsx\ntouch ${JSON.stringify(installed)}\n`,
      { mode: 0o755 },
    );
    const launcher = prepareRealSourceRecoveryLauncher(rootDir, configDir, join(dir, "home"));
    const result = spawnSync(launcher, ["status"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        OMNESIS_CONFIG_DIR: configDir,
        OMNESIS_UPDATE_LOCK_ID: "",
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(installed)).toBe(true);
    expect(existsSync(join(rootDir, "node_modules/tsx/dist/loader.mjs"))).toBe(true);
    expect(existsSync(join(configDir, "update.lock"))).toBe(false);
  });

  test("a dependency install that fails over the existing tree is retried from an empty node_modules", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
    scratch.push(dir);
    const rootDir = join(dir, "source");
    const homeDir = join(dir, "home");
    const configDir = join(dir, "config");
    const fakeBin = join(dir, "bin");
    const ran = join(dir, "ran");
    mkdirSync(join(rootDir, "node_modules", "left-behind"), { recursive: true });
    mkdirSync(fakeBin);
    // An install over a tree it cannot reconcile fails; one from an empty
    // node_modules installs the CLI's runner.
    writeFileSync(
      join(fakeBin, "npm"),
      `#!/bin/sh\n[ -d node_modules/left-behind ] && exit 1\n${sourceLoaderFixture}mkdir -p node_modules/.bin\nprintf '#!/bin/sh\\ntouch %s\\n' ${JSON.stringify(JSON.stringify(ran))} > node_modules/.bin/tsx\nchmod 755 node_modules/.bin/tsx\n`,
      { mode: 0o755 },
    );
    const launcher = prepareSourceRecoveryLauncher(rootDir, configDir, homeDir);

    const result = spawnSync(launcher, ["status"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        OMNESIS_CONFIG_DIR: configDir,
        OMNESIS_UPDATE_LOCK_ID: "",
      },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "Installing dependencies failed; installing them again from an empty node_modules...",
    );
    expect(existsSync(join(rootDir, "node_modules", "left-behind"))).toBe(false);
    expect(existsSync(ran)).toBe(true);
  });

  test("dependency recovery does not install against a broken node-gyp header cache", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
    scratch.push(dir);
    const rootDir = join(dir, "source");
    const homeDir = join(dir, "home");
    const configDir = join(dir, "config");
    const fakeBin = join(dir, "bin");
    const devdir = join(dir, "node-gyp");
    const headers = join(devdir, process.versions.node);
    const seen = join(dir, "seen");
    mkdirSync(rootDir);
    mkdirSync(fakeBin);
    // What a header fetch killed part-way leaves: the stamp node-gyp trusts,
    // and a common.gypi that never got its bytes.
    mkdirSync(join(headers, "include", "node"), { recursive: true });
    writeFileSync(join(headers, "installVersion"), "11\n");
    writeFileSync(join(headers, "include", "node", "common.gypi"), "");
    writeFileSync(
      join(fakeBin, "npm"),
      `#!/bin/sh\n[ "$1" = ci ] || exit 0\nif [ -e ${JSON.stringify(headers)} ]; then echo present >> ${JSON.stringify(seen)}; else echo absent >> ${JSON.stringify(seen)}; fi\n${sourceLoaderFixture}mkdir -p node_modules/.bin\nprintf '#!/bin/sh\\n' > node_modules/.bin/tsx\nchmod 755 node_modules/.bin/tsx\n`,
      { mode: 0o755 },
    );
    const launcher = prepareSourceRecoveryLauncher(rootDir, configDir, homeDir);

    const result = spawnSync(launcher, ["status"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        npm_config_devdir: devdir,
        OMNESIS_CONFIG_DIR: configDir,
        OMNESIS_UPDATE_LOCK_ID: "",
      },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`The node-gyp headers for Node ${process.versions.node}`);
    // npm's own node-gyp is not known here, so npm ci fetches the headers
    // itself -- into an empty directory, not the broken one.
    expect(readFileSync(seen, "utf8")).toBe("absent\n");
  });

  test("dependency recovery releases its lock before a non-update daemon stays running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
    scratch.push(dir);
    const rootDir = join(dir, "source");
    const homeDir = join(dir, "home");
    const configDir = join(dir, "config");
    const fakeBin = join(dir, "bin");
    const fakeTsx = join(dir, "tsx");
    const started = join(dir, "started");
    const stop = join(dir, "stop");
    mkdirSync(rootDir);
    mkdirSync(fakeBin);
    writeFileSync(
      fakeTsx,
      '#!/bin/sh\n: > "$FAKE_STARTED"\nwhile [ ! -f "$FAKE_STOP" ]; do sleep 1; done\n',
      { mode: 0o755 },
    );
    writeFileSync(
      join(fakeBin, "npm"),
      `#!/bin/sh\n${sourceLoaderFixture}mkdir -p node_modules/.bin\ncp "$FAKE_TSX" node_modules/.bin/tsx\nchmod 755 node_modules/.bin/tsx\n`,
      { mode: 0o755 },
    );
    const launcher = prepareSourceRecoveryLauncher(rootDir, configDir, homeDir);
    const child = spawn(launcher, ["gateway", "serve"], {
      stdio: "ignore",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        FAKE_TSX: fakeTsx,
        FAKE_STARTED: started,
        FAKE_STOP: stop,
        OMNESIS_CONFIG_DIR: configDir,
        OMNESIS_UPDATE_LOCK_ID: "",
      },
    });
    const closed = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    try {
      for (let attempt = 0; attempt < 200 && !existsSync(started); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(started)).toBe(true);
      const update = acquireUpdateLock(configDir, { owner: "operator update" });
      update.release();
    } finally {
      writeFileSync(stop, "stop\n");
      await closed;
    }
  });

  test("surfaces a blocked wrapper release instead of reporting CLI success", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
    scratch.push(dir);
    const rootDir = join(dir, "source");
    const homeDir = join(dir, "home");
    const configDir = join(dir, "config");
    const fakeBin = join(dir, "bin");
    const fakeTsx = join(dir, "tsx");
    mkdirSync(rootDir);
    mkdirSync(fakeBin);
    writeFileSync(
      fakeTsx,
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({
        version: 1,
        state: "choosing",
        ticket: 0,
        pid: 2_147_483_647,
        processStart: null,
      })}' > "$OMNESIS_CONFIG_DIR/update.lock/.claim-blocked"\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(fakeBin, "npm"),
      `#!/bin/sh\n${sourceLoaderFixture}mkdir -p node_modules/.bin\ncp "$FAKE_TSX" node_modules/.bin/tsx\nchmod 755 node_modules/.bin/tsx\n`,
      { mode: 0o755 },
    );
    const launcher = prepareSourceRecoveryLauncher(rootDir, configDir, homeDir);

    const result = spawnSync(launcher, ["update"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        FAKE_TSX: fakeTsx,
        OMNESIS_CONFIG_DIR: configDir,
        OMNESIS_UPDATE_LOCK_ID: "",
      },
    });
    expect(result.status).toBe(73);
    expect(result.stderr).toContain("Could not release the source update lock");
    expect(existsSync(join(configDir, "update.lock"))).toBe(true);
  });

  test("an update that waited re-reads the source state instead of repairing a finished update", async () => {
    // Another update on this host was mid-apply when this one started. It
    // finished while this one waited, so there is nothing left to repair.
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
    scratch.push(dir);
    const rootDir = join(dir, "source");
    const homeDir = join(dir, "home");
    const configDir = join(dir, "config");
    const fakeBin = join(dir, "bin");
    const ran = join(dir, "cli-ran");
    mkdirSync(join(rootDir, "node_modules", ".bin"), { recursive: true });
    mkdirSync(fakeBin);
    mkdirSync(configDir, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git(
      "-c",
      "user.name=Example",
      "-c",
      "user.email=dev@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "base",
    );
    const commit = git("rev-parse", "HEAD");
    writeFileSync(
      join(rootDir, "node_modules", ".bin", "tsx"),
      `#!/bin/sh\n${JSON.stringify(process.execPath)} -e 'const fs = require("node:fs"); const owner = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (owner.id !== process.env.OMNESIS_UPDATE_LOCK_ID) process.exit(1); fs.writeFileSync(process.argv[2], "ran");' "$OMNESIS_CONFIG_DIR/update.lock/owner.json" ${JSON.stringify(ran)}\n`,
      { mode: 0o755 },
    );
    // A repair would run npm ci; this one fails loudly if it is ever reached.
    writeFileSync(join(fakeBin, "npm"), "#!/bin/sh\necho npm-was-run >&2\nexit 1\n", {
      mode: 0o755,
    });
    const statePath = join(configDir, "update-state.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        method: "source",
        rootDir,
        phase: "applying",
        targetCommit: commit,
        lastCompletedCommit: commit,
      }),
    );
    const launcher = prepareSourceRecoveryLauncher(rootDir, configDir, homeDir);
    const holder = acquireUpdateLock(configDir, { owner: "collector self-update" });
    try {
      const child = spawn(launcher, ["update", "--yes", "--wait-for-lock=1"], {
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          OMNESIS_CONFIG_DIR: configDir,
          OMNESIS_UPDATE_LOCK_ID: "",
        },
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const closed = once(child, "close");
      for (let attempt = 0; attempt < 500 && !stderr.includes("Waiting for"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(stderr).toContain("Waiting for collector self-update");
      writeFileSync(
        statePath,
        JSON.stringify({ version: 1, method: "source", rootDir, phase: "complete", commit }),
      );
      holder.release();
      const [code] = await closed;
      expect(stderr).not.toContain("Source update recovery");
      expect(stderr).not.toContain("npm-was-run");
      expect(code).toBe(0);
      expect(existsSync(ran)).toBe(true);
      expect(existsSync(join(configDir, "update.lock"))).toBe(false);
    } finally {
      holder.release();
    }
  }, 20_000);

  test("an inherited lock stays held while the source wrapper repairs dependencies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
    scratch.push(dir);
    const rootDir = join(dir, "source");
    const homeDir = join(dir, "home");
    const configDir = join(dir, "config");
    const fakeBin = join(dir, "bin");
    const ready = join(dir, "npm-ready");
    const proceed = join(dir, "npm-proceed");
    mkdirSync(join(rootDir, "node_modules", ".bin"), { recursive: true });
    mkdirSync(fakeBin);
    writeFileSync(
      join(rootDir, "node_modules", ".bin", "tsx"),
      '#!/bin/sh\nprintf "%s" "$OMNESIS_UPDATE_LOCK_ID"\n',
      { mode: 0o755 },
    );
    writeFileSync(
      join(fakeBin, "npm"),
      '#!/bin/sh\n: > "$READY_FILE"\nwhile [ ! -f "$PROCEED_FILE" ]; do sleep 0.01; done\n',
      { mode: 0o755 },
    );
    mkdirSync(join(rootDir, "node_modules/tsx/dist"), { recursive: true });
    writeFileSync(join(rootDir, "node_modules/tsx/dist/loader.mjs"), fixtureLoader);
    execFileSync("git", ["init", "-q", rootDir]);
    execFileSync("git", ["-C", rootDir, "config", "user.name", "fixture"]);
    execFileSync("git", ["-C", rootDir, "config", "user.email", "fixture@example.com"]);
    execFileSync("git", ["-C", rootDir, "add", "."]);
    execFileSync("git", ["-C", rootDir, "commit", "-qm", "fixture"]);
    const commit = execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    mkdirSync(configDir);
    writeFileSync(
      join(configDir, "update-state.json"),
      `${JSON.stringify({
        version: 1,
        method: "source",
        rootDir,
        phase: "applying",
        targetCommit: commit,
        lastCompletedCommit: commit,
      })}\n`,
    );
    const launcher = prepareSourceRecoveryLauncher(rootDir, configDir, homeDir);
    const helper = join(homeDir, ".local", "lib", "omnesis", "update-lock.cjs");
    const collector = acquireUpdateLock(configDir, { owner: "collector self-update" });
    const child = spawn(launcher, ["update"], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        READY_FILE: ready,
        PROCEED_FILE: proceed,
        OMNESIS_CONFIG_DIR: configDir,
        OMNESIS_UPDATE_LOCK_ID: collector.id,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
    let adopted = "";
    try {
      for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(ready), stderr).toBe(true);
      adopted = JSON.parse(readFileSync(join(configDir, "update.lock", "owner.json"), "utf8")).id;
      expect(adopted).not.toBe(collector.id);

      collector.release();
      expect(() => acquireUpdateLock(configDir, { owner: "racing update" })).toThrow(
        UpdateLockBusyError,
      );
      writeFileSync(proceed, "");
      expect(await closed).toBe(0);
      expect(stdout).toBe(adopted);
      expect(existsSync(join(configDir, "update.lock"))).toBe(false);
    } finally {
      child.kill("SIGKILL");
      collector.release();
      if (adopted) execFileSync(process.execPath, [helper, "release", configDir, adopted]);
    }
  });
  test("the rendered source wrapper has valid POSIX shell syntax", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-syntax-"));
    scratch.push(dir);
    const launcher = join(dir, "launcher");
    writeFileSync(launcher, sourceRecoveryLauncher("/tmp/owner's source", "/tmp/config dir"));
    execFileSync("sh", ["-n", launcher]);
  });
});
