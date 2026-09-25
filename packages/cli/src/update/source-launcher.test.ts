// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync, fork, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { acquireUpdateLock, adoptUpdateLock, UpdateLockBusyError } from "@omnesis/core";
import {
  prepareSourceRecoveryLauncher,
  sourceRecoveryLauncher,
  sourceUpdateLockHelper,
} from "./source-launcher.js";

const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("source recovery launcher", () => {
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
      `${installer.slice(quoteStart, quoteEnd)}\n${installer.slice(rendererStart, rendererEnd)}\nCONFIG_DIR="$1"\nUPDATE_LOCK_HELPER="$2"\nrender_source_wrapper "$3"\n`,
    );
    const rootDir = "/tmp/owner's source";
    const configDir = "/tmp/config dir";
    const lockHelper = "/tmp/update-lock.cjs";
    const rendered = execFileSync("sh", [probe, configDir, lockHelper, rootDir], {
      encoding: "utf8",
    });
    expect(rendered).toBe(sourceRecoveryLauncher(rootDir, configDir, lockHelper));
  });

  test("keeps the toolchain-free installer's lock helper identical", () => {
    const installer = readFileSync(join(process.cwd(), "scripts", "install.sh"), "utf8");
    const start = installer.indexOf("  cat > \"$UPDATE_LOCK_HELPER_TMP\" <<'EOF'\n");
    expect(start).toBeGreaterThan(0);
    const bodyStart = installer.indexOf("\n", start) + 1;
    const bodyEnd = installer.indexOf("\nEOF\n", bodyStart);
    expect(installer.slice(bodyStart, bodyEnd) + "\n").toBe(sourceUpdateLockHelper());
    const installSource = installer.slice(installer.indexOf("install_source() {"));
    expect(installSource.indexOf('INSTALL_UPDATE_LOCK_ID="$(node')).toBeLessThan(
      installSource.indexOf('info "Resolving the newest stable source release'),
    );
    expect(installSource.indexOf('node "$UPDATE_LOCK_HELPER" release')).toBeGreaterThan(
      installSource.indexOf('write_source_update_state "complete"'),
    );
  });

  test("renders shell-safe source and config paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
    scratch.push(dir);
    const path = join(dir, "launcher");
    const rootDir = "/tmp/owner's source";
    const homeDir = join(dir, "home");
    writeFileSync(path, sourceRecoveryLauncher(rootDir, "/tmp/config dir"));

    execFileSync("sh", ["-n", path]);
    expect(readFileSync(path, "utf8")).toContain("checkout --detach");
    mkdirSync(join(homeDir, ".local", "bin"), { recursive: true });
    writeFileSync(join(homeDir, ".local", "bin", "omnesis"), readFileSync(path));
    expect(prepareSourceRecoveryLauncher(rootDir, "/tmp/config dir", homeDir)).toBe(
      join(homeDir, ".local", "bin", "omnesis"),
    );
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
      writeFileSync(join(kegBin, "node"), '#!/bin/sh\nprintf "keg node:%s\\n" "$*"\n', {
        mode: 0o755,
      });
      const launcher = prepareSourceRecoveryLauncher(rootDir, configDir, join(dir, "home"));
      const env = { PATH: bin, HOMEBREW_PREFIX: brewPrefix, OMNESIS_CONFIG_DIR: configDir };
      return { launcher, env, tsx, bin };
    }

    test("when the caller's PATH has no node", () => {
      const { launcher, env, tsx } = kegFixture();
      const output = execFileSync(launcher, ["status"], { encoding: "utf8", env });
      expect(output).toBe(
        `keg node:${tsx} ${join(dirname(dirname(dirname(tsx))), "packages/cli/src/index.ts")} status\n`,
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
      expect(output.startsWith(`keg node:${tsx} `)).toBe(true);
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
      '#!/bin/sh\nmkdir -p node_modules/.bin\ncp "$FAKE_TSX" node_modules/.bin/tsx\nchmod 755 node_modules/.bin/tsx\n',
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
      '#!/bin/sh\nmkdir -p node_modules/.bin\ncp "$FAKE_TSX" node_modules/.bin/tsx\nchmod 755 node_modules/.bin/tsx\n',
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
      '#!/bin/sh\nmkdir -p node_modules/.bin\ncp "$FAKE_TSX" node_modules/.bin/tsx\nchmod 755 node_modules/.bin/tsx\n',
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

  test("the helper waits for a holder to finish when asked to", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
    scratch.push(dir);
    const configDir = join(dir, "config");
    const helper = join(dir, "update-lock.cjs");
    writeFileSync(helper, sourceUpdateLockHelper(), { mode: 0o755 });
    const holder = acquireUpdateLock(configDir, {
      owner: "collector self-update",
      currentStep: "building",
    });
    try {
      const child = spawn(
        process.execPath,
        [helper, "acquire", configDir, "source update", String(process.pid), "1"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const closed = once(child, "close");
      for (let attempt = 0; attempt < 500 && !stderr.includes("Waiting for"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(stderr).toMatch(/^Waiting for collector self-update \(PID \d+\) to finish\.\.\.$/mu);
      holder.release();
      const [code] = await closed;
      expect(code).toBe(0);
      const lock = adoptUpdateLock(configDir, stdout.trim(), { owner: "source update test" });
      lock.release();
    } finally {
      holder.release();
    }
  }, 20_000);

  test("without a wait the helper still refuses a held lock at once", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
    scratch.push(dir);
    const configDir = join(dir, "config");
    const helper = join(dir, "update-lock.cjs");
    writeFileSync(helper, sourceUpdateLockHelper(), { mode: 0o755 });
    const holder = acquireUpdateLock(configDir, { owner: "collector self-update" });
    try {
      const result = spawnSync(
        process.execPath,
        [helper, "acquire", configDir, "source update", String(process.pid)],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(73);
      expect(result.stderr).toMatch(
        /another omnesis update is running on this host: collector self-update/iu,
      );
      expect(result.stderr).not.toContain("Waiting for");
    } finally {
      holder.release();
    }
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

  test("atomically upgrades a legacy source wrapper before mutation", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
    scratch.push(dir);
    const rootDir = join(dir, "source");
    const homeDir = join(dir, "home");
    const launcher = join(homeDir, ".local", "bin", "omnesis");
    mkdirSync(join(homeDir, ".local", "bin"), { recursive: true });
    writeFileSync(
      launcher,
      `#!/bin/sh\nexec "${rootDir}/node_modules/.bin/tsx" "${rootDir}/packages/cli/src/index.ts" "$@"\n`,
    );
    chmodSync(launcher, 0o755);

    expect(
      prepareSourceRecoveryLauncher(rootDir, join(homeDir, ".config", "omnesis"), homeDir),
    ).toBe(launcher);

    const installed = readFileSync(launcher, "utf8");
    expect(installed).toContain("A source update did not finish");
    expect(installed).toContain(
      "If its build was killed for lack of memory, first stop the collector and gateway",
    );
    expect(installed).toContain(rootDir);
    expect(statSync(launcher).mode & 0o777).toBe(0o755);
    execFileSync("sh", ["-n", launcher]);
    const helper = join(homeDir, ".local", "lib", "omnesis", "update-lock.cjs");
    expect(readFileSync(helper, "utf8")).toBe(sourceUpdateLockHelper());
    expect(statSync(helper).mode & 0o777).toBe(0o755);
  });

  test("the stable helper and TypeScript runtime contend through the same lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
    scratch.push(dir);
    const helper = join(dir, "update-lock.cjs");
    const configDir = join(dir, "config");
    writeFileSync(helper, sourceUpdateLockHelper(), { mode: 0o755 });

    const id = execFileSync(
      process.execPath,
      [helper, "acquire", configDir, "source recovery", String(process.pid)],
      { encoding: "utf8" },
    );
    expect(() => acquireUpdateLock(configDir, { owner: "CLI update" })).toThrow(
      UpdateLockBusyError,
    );
    expect(() =>
      execFileSync(
        process.execPath,
        [helper, "adopt", configDir, "forged-owner", String(process.pid)],
        { stdio: "pipe" },
      ),
    ).toThrow(/hand-off is no longer valid/);
    execFileSync(process.execPath, [helper, "release", configDir, id]);

    const runtime = acquireUpdateLock(configDir, { owner: "collector self-update" });
    expect(() =>
      execFileSync(
        process.execPath,
        [helper, "acquire", configDir, "source recovery", String(process.pid)],
        { encoding: "utf8", stdio: "pipe" },
      ),
    ).toThrow(/collector self-update/);
    runtime.release();
  });

  async function heartbeatFixture({ stopDuringRenewal = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-heartbeat-"));
    scratch.push(dir);
    const helper = join(dir, "update-lock.cjs");
    const clock = join(dir, "clock.cjs");
    const configDir = join(dir, "config");
    const ownerPath = join(configDir, "update.lock", "owner.json");
    writeFileSync(helper, sourceUpdateLockHelper());
    // Drive each real heartbeat explicitly: no wall-clock race between the
    // test's ownership changes and the helper's next scheduled renewal.
    writeFileSync(
      clock,
      `
      if (${stopDuringRenewal}) {
        const fs = require("node:fs");
        const rename = fs.renameSync;
        fs.renameSync = (source, target) => {
          rename(source, target);
          if (target.endsWith("/owner.json")) process.kill(process.pid, "SIGTERM");
        };
      }
      global.setInterval = (callback, interval) => {
        if (interval !== 5000) throw new Error("Unexpected heartbeat interval");
        process.on("message", () => { callback(); process.send("renewed"); });
        process.send("ready");
      };
    `,
    );
    const id = execFileSync(
      process.execPath,
      [helper, "acquire", configDir, "source recovery", String(process.pid)],
      { encoding: "utf8" },
    );
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    owner.updatedAt = "2000-01-01T00:00:00.000Z";
    writeFileSync(ownerPath, JSON.stringify(owner));
    const child = fork(helper, ["heartbeat-loop", configDir, id], {
      execArgv: ["--require", clock],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    // A broken shutdown must fail the test without leaving a helper alive.
    const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const closed = once(child, "close").finally(() => clearTimeout(deadline));
    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await closed;
    };
    const message = () =>
      Promise.race([
        once(child, "message"),
        closed.then(() => {
          throw new Error(`Heartbeat exited unexpectedly: ${child.exitCode}`);
        }),
      ]);
    try {
      await message();
    } catch (error) {
      await stop();
      throw error;
    }
    return { child, closed, stop, message, owner, ownerPath };
  }

  test("the owned heartbeat process renews the lock and closes its pipes when stopped", async () => {
    const run = await heartbeatFixture();
    try {
      const renewed = run.message();
      run.child.send("tick");
      await renewed;
      const owner = JSON.parse(readFileSync(run.ownerPath, "utf8"));
      expect(owner).toMatchObject({ id: run.owner.id, pid: process.pid });
      expect(Date.parse(owner.updatedAt)).toBeGreaterThan(Date.parse(run.owner.updatedAt));
      await run.stop();
      expect(run.child.exitCode).toBe(0);
      // Stopping renewal does not release a lock the owning shell still holds.
      expect(JSON.parse(readFileSync(run.ownerPath, "utf8"))).toEqual(owner);
    } finally {
      await run.stop();
    }
  });

  test("a stop during renewal releases the mutation guard before exiting", async () => {
    const run = await heartbeatFixture({ stopDuringRenewal: true });
    try {
      run.child.send("tick");
      await run.closed;
      expect(run.child.exitCode).toBe(0);
      expect(readdirSync(dirname(run.ownerPath))).toEqual(["owner.json"]);
      expect(JSON.parse(readFileSync(run.ownerPath, "utf8")).updatedAt).not.toBe(
        run.owner.updatedAt,
      );
    } finally {
      await run.stop();
    }
  });

  test.each(["replaced", "exited", "reused"])(
    "the heartbeat stops without renewing a %s owner",
    async (state) => {
      const run = await heartbeatFixture();
      try {
        const owner = { ...run.owner };
        if (state === "replaced") owner.id = "successor-owner";
        if (state === "exited") owner.pid = 2_147_483_647;
        if (state === "reused") owner.processStart = "different-process-start";
        writeFileSync(run.ownerPath, JSON.stringify(owner));
        run.child.send("tick");
        await run.closed;
        expect(run.child.exitCode).toBe(73);
        expect(JSON.parse(readFileSync(run.ownerPath, "utf8"))).toEqual(owner);
      } finally {
        await run.stop();
      }
    },
  );

  test("the helper treats a future lease as live when another PID namespace is opaque", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
    scratch.push(dir);
    const helper = join(dir, "update-lock.cjs");
    const configDir = join(dir, "config");
    const lockDir = join(configDir, "update.lock");
    writeFileSync(helper, sourceUpdateLockHelper(), { mode: 0o755 });
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      `${JSON.stringify({
        version: 1,
        id: "opaque-live-owner",
        owner: "container update",
        pid: 2_147_483_647,
        processStart: "another-pid-namespace",
        startedAt: "2099-01-01T00:00:00.000Z",
        updatedAt: "2099-01-01T00:00:00.000Z",
        currentStep: "applying",
      })}\n`,
    );

    const result = spawnSync(
      process.execPath,
      [helper, "acquire", configDir, "second update", String(process.pid)],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(73);
    expect(result.stderr).toContain("container update");
    expect(JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"))).toMatchObject({
      id: "opaque-live-owner",
    });
  });

  test.skipIf(process.platform === "win32")(
    "the helper keeps a stale dead owner fenced while its detached apply group lives",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
      scratch.push(dir);
      const helper = join(dir, "update-lock.cjs");
      const configDir = join(dir, "config");
      const lockDir = join(configDir, "update.lock");
      writeFileSync(helper, sourceUpdateLockHelper(), { mode: 0o755 });
      mkdirSync(lockDir, { recursive: true });
      const apply = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
      });
      const closed = new Promise<void>((resolve) => apply.once("close", () => resolve()));
      await new Promise<void>((resolve, reject) => {
        apply.once("spawn", resolve);
        apply.once("error", reject);
      });
      const groupPid = apply.pid;
      expect(groupPid).toEqual(expect.any(Number));
      writeFileSync(
        join(lockDir, "owner.json"),
        `${JSON.stringify({
          version: 1,
          id: "dead-cli-owner",
          owner: "Omnesis update",
          pid: 2_147_483_647,
          processStart: "dead-cli",
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          currentStep: "installing",
          processGroupPid: groupPid,
          processGroupStart: "detached-apply",
        })}\n`,
      );
      try {
        const blocked = spawnSync(
          process.execPath,
          [helper, "acquire", configDir, "next update", String(process.pid)],
          { encoding: "utf8" },
        );
        expect(blocked.status).toBe(73);
        expect(blocked.stderr).toContain("Omnesis update");
      } finally {
        if (groupPid !== undefined) {
          try {
            process.kill(-groupPid, "SIGKILL");
          } catch {
            // The fixture process already exited.
          }
        }
        await closed;
      }

      const recovered = execFileSync(
        process.execPath,
        [helper, "acquire", configDir, "next update", String(process.pid)],
        { encoding: "utf8" },
      );
      execFileSync(process.execPath, [helper, "release", configDir, recovered]);
    },
  );

  test("the helper transfers an inherited lock before source recovery", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
    scratch.push(dir);
    const helper = join(dir, "update-lock.cjs");
    const configDir = join(dir, "config");
    writeFileSync(helper, sourceUpdateLockHelper(), { mode: 0o755 });
    const collector = acquireUpdateLock(configDir, { owner: "collector self-update" });

    const adopted = execFileSync(
      process.execPath,
      [helper, "adopt", configDir, collector.id, String(process.pid)],
      { encoding: "utf8" },
    );
    expect(adopted).not.toBe(collector.id);
    expect(
      JSON.parse(readFileSync(join(configDir, "update.lock", "owner.json"), "utf8")),
    ).toMatchObject({
      id: adopted,
      owner: "source update recovery",
      pid: process.pid,
      currentStep: "restoring source dependencies",
    });

    collector.release();
    expect(() => acquireUpdateLock(configDir, { owner: "second update" })).toThrow(
      UpdateLockBusyError,
    );
    execFileSync(process.execPath, [helper, "release", configDir, adopted]);
  });

  test("a helper handoff returns through the CLI to its original collector", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
    scratch.push(dir);
    const helper = join(dir, "update-lock.cjs");
    const configDir = join(dir, "config");
    writeFileSync(helper, sourceUpdateLockHelper(), { mode: 0o755 });
    const collector = acquireUpdateLock(configDir, { owner: "collector self-update" });
    const wrapperId = execFileSync(
      process.execPath,
      [helper, "adopt", configDir, collector.id, String(process.pid)],
      { encoding: "utf8" },
    );

    const cli = adoptUpdateLock(configDir, wrapperId, { owner: "Omnesis update" });
    cli.handBack();
    expect(
      JSON.parse(readFileSync(join(configDir, "update.lock", "owner.json"), "utf8")),
    ).toMatchObject({
      id: collector.id,
      owner: "collector self-update",
      currentStep: "finishing collector self-update",
    });

    collector.release();
    expect(existsSync(join(configDir, "update.lock"))).toBe(false);
  });

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

  test("two stale-lock reapers leave exactly one live successor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
    scratch.push(dir);
    const helper = join(dir, "update-lock.cjs");
    const configDir = join(dir, "config");
    const lockDir = join(configDir, "update.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(helper, sourceUpdateLockHelper(), { mode: 0o755 });
    writeFileSync(
      join(lockDir, "owner.json"),
      `${JSON.stringify({
        version: 1,
        id: "dead-owner",
        owner: "interrupted update",
        pid: 2_147_483_647,
        processStart: null,
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        currentStep: "applying",
      })}\n`,
    );

    const run = (label: string) =>
      new Promise<{ code: number | null; stdout: string }>((resolve) => {
        const child = spawn(
          process.execPath,
          [helper, "acquire", configDir, label, String(process.pid)],
          {
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.on("close", (code) => resolve({ code, stdout }));
      });
    const results = await Promise.all([run("reaper one"), run("reaper two")]);
    expect(results.map((result) => result.code).sort()).toEqual([0, 73]);
    const winner = results.find((result) => result.code === 0)?.stdout;
    expect(JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8")).id).toBe(winner);
    execFileSync(process.execPath, [helper, "release", configDir, winner!]);
  });

  test("the helper reports a blocked release instead of abandoning it", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
    scratch.push(dir);
    const helper = join(dir, "update-lock.cjs");
    const configDir = join(dir, "config");
    const claim = join(configDir, "update.lock", ".claim-crashed");
    writeFileSync(helper, sourceUpdateLockHelper(), { mode: 0o755 });
    const id = execFileSync(
      process.execPath,
      [helper, "acquire", configDir, "source recovery", String(process.pid)],
      { encoding: "utf8" },
    );
    writeFileSync(
      claim,
      `${JSON.stringify({
        version: 1,
        state: "choosing",
        ticket: 0,
        pid: 2_147_483_647,
        processStart: null,
      })}\n`,
    );

    expect(() =>
      execFileSync(process.execPath, [helper, "release", configDir, id], { stdio: "pipe" }),
    ).toThrow();
    expect(existsSync(join(configDir, "update.lock"))).toBe(true);

    const old = new Date(Date.now() - 60_000);
    utimesSync(claim, old, old);
    execFileSync(process.execPath, [helper, "release", configDir, id]);
    expect(existsSync(join(configDir, "update.lock"))).toBe(false);
  });

  test("refuses to overwrite an unrelated executable", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
    scratch.push(dir);
    const launcher = join(dir, ".local", "bin", "omnesis");
    mkdirSync(join(dir, ".local", "bin"), { recursive: true });
    writeFileSync(launcher, "#!/bin/sh\necho another-program\n");

    expect(() => prepareSourceRecoveryLauncher("/opt/omnesis", "/tmp/config", dir)).toThrow(
      /not this source checkout/u,
    );
  });

  test("does not mistake a sibling-prefix checkout for the owned legacy wrapper", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
    scratch.push(dir);
    const launcher = join(dir, ".local", "bin", "omnesis");
    mkdirSync(join(dir, ".local", "bin"), { recursive: true });
    writeFileSync(
      launcher,
      '#!/bin/sh\nexec "/opt/omnesis-old/node_modules/.bin/tsx" "/opt/omnesis-old/packages/cli/src/index.ts" "$@"\n',
    );

    expect(() => prepareSourceRecoveryLauncher("/opt/omnesis", "/tmp/config", dir)).toThrow(
      /not this source checkout/u,
    );
  });
});
