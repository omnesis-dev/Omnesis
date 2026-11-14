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
  nativeLauncherPath,
  prepareSourceRecoveryLauncher,
  sourceRecoveryLauncher,
  sourceUpdateLockHelper,
} from "./source-launcher.js";

const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});
describe("source recovery launcher", () => {
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

    expect(readFileSync(path, "utf8")).toContain("checkout --detach");
    mkdirSync(join(homeDir, ".local", "bin"), { recursive: true });
    writeFileSync(join(homeDir, ".local", "bin", "omnesis"), readFileSync(path));
    expect(prepareSourceRecoveryLauncher(rootDir, "/tmp/config dir", homeDir)).toBe(
      join(homeDir, ".local", "bin", "omnesis"),
    );
  });

  test("a collector beside a Docker install rewrites its own launcher, never the Docker one", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-source-launcher-"));
    scratch.push(dir);
    const homeDir = join(dir, "home");
    const rootDir = join(homeDir, "omnesis-collector");
    const configDir = join(homeDir, ".config", "omnesis-collector");
    const dockerLauncher = join(homeDir, ".local", "bin", "omnesis");
    const dockerText = "#!/bin/sh\n# Omnesis in Docker — written by install.sh --docker.\n";
    mkdirSync(join(homeDir, ".local", "bin"), { recursive: true });
    writeFileSync(dockerLauncher, dockerText);
    const own = join(homeDir, ".local", "lib", "omnesis-collector", "omnesis");
    mkdirSync(join(homeDir, ".local", "lib", "omnesis-collector"), { recursive: true });
    writeFileSync(own, sourceRecoveryLauncher(rootDir, configDir));

    const launcher = nativeLauncherPath({ OMNESIS_LAUNCHER: own }, homeDir);
    expect(prepareSourceRecoveryLauncher(rootDir, configDir, homeDir, launcher)).toBe(own);
    expect(readFileSync(own, "utf8")).toContain(rootDir);
    expect(readFileSync(dockerLauncher, "utf8")).toBe(dockerText);

    // Without the name, the Docker launcher is refused rather than replaced.
    expect(() => prepareSourceRecoveryLauncher(rootDir, configDir, homeDir)).toThrow(
      /is not this source checkout's Omnesis launcher/u,
    );
    expect(readFileSync(dockerLauncher, "utf8")).toBe(dockerText);
  });

  test("nativeLauncherPath defaults to ~/.local/bin/omnesis and ignores a relative name", () => {
    expect(nativeLauncherPath({}, "/home/maya")).toBe(
      join("/home/maya", ".local", "bin", "omnesis"),
    );
    expect(nativeLauncherPath({ OMNESIS_LAUNCHER: "omnesis" }, "/home/maya")).toBe(
      join("/home/maya", ".local", "bin", "omnesis"),
    );
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
    if (process.platform !== "win32") expect(statSync(launcher).mode & 0o777).toBe(0o755);
    const helper = join(homeDir, ".local", "lib", "omnesis", "update-lock.cjs");
    expect(readFileSync(helper, "utf8")).toBe(sourceUpdateLockHelper());
    if (process.platform !== "win32") expect(statSync(helper).mode & 0o777).toBe(0o755);
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
          if (require("node:path").basename(target) === "owner.json") {
            // OS signal handlers run after synchronous filesystem work unwinds.
            setImmediate(() => process.emit("SIGTERM"));
          }
        };
      }
      global.setInterval = (callback, interval) => {
        if (interval !== 5000) throw new Error("Unexpected heartbeat interval");
        process.on("message", (message) => {
          if (message === "stop") { process.emit("SIGTERM"); return; }
          callback(); process.send("renewed");
        });
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
      if (child.exitCode === null && child.signalCode === null && child.connected)
        child.send("stop");
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
