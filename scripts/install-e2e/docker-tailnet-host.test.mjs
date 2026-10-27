// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateHost, stopMailbox } from "./docker-tailnet-host.mjs";
const env = {
  CI: "true",
  GITHUB_ACTIONS: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
  RUNNER_OS: "Linux",
  HOME: "/home/runner",
  ImageOS: "ubuntu24",
  RUNNER_TEMP: "/home/runner/work/_temp",
  GITHUB_WORKSPACE: "/home/runner/work/project/project",
};
const fs = { realpathSync: (p) => p, lstatSync: () => ({ isSymbolicLink: () => false }) };
it("admits canonical hosted paths and rejects self-hosted, outside scratch and symlink ancestors", () => {
  const args = [env.RUNNER_TEMP + "/t3", env.GITHUB_WORKSPACE, "linux"];
  expect(validateHost(env, ...args, { platform: "linux", fs })).toBe(true);
  for (const bad of [
    { RUNNER_ENVIRONMENT: "self-hosted" },
    { HOME: "/home/operator" },
    { GITHUB_WORKSPACE: "/tmp/project" },
  ])
    expect(() => validateHost({ ...env, ...bad }, ...args, { platform: "linux", fs })).toThrow();
  expect(() => validateHost(env, "/tmp/t3", args[1], "linux", { platform: "linux", fs })).toThrow();
  expect(() =>
    validateHost(env, ...args, {
      platform: "linux",
      fs: { ...fs, lstatSync: () => ({ isSymbolicLink: () => true }) },
    }),
  ).toThrow();
});
it("validates the hosted Darwin branch without Linux process APIs", () => {
  const mac = {
    ...env,
    HOME: "/Users/runner",
    RUNNER_OS: "macOS",
    ImageOS: "macos15",
    RUNNER_TEMP: "/Users/runner/work/_temp",
    GITHUB_WORKSPACE: "/Users/runner/work/project/project",
  };
  const args = [mac.RUNNER_TEMP + "/t3", mac.GITHUB_WORKSPACE, "mac"];
  expect(validateHost(mac, ...args, { platform: "darwin", fs })).toBe(true);
  expect(() => validateHost(mac, ...args, { platform: "linux", fs })).toThrow();
  expect(() =>
    validateHost({ ...mac, RUNNER_ENVIRONMENT: "self-hosted" }, ...args, {
      platform: "darwin",
      fs,
    }),
  ).toThrow();
});
it("both shell entrypoints refuse non-hosted execution before creating scratch or invoking mutators", () => {
  const root = mkdtempSync(join(tmpdir(), "t3-guard-"));
  try {
    for (const script of ["docker-tailnet-gateway.sh", "tailnet-collector.sh"]) {
      const work = join(root, script);
      const result = spawnSync("bash", [new URL(script, import.meta.url).pathname], {
        env: {
          ...process.env,
          CI: "true",
          GITHUB_ACTIONS: "true",
          RUNNER_ENVIRONMENT: "self-hosted",
          E2E_MODE: "docker",
          E2E_FIXTURE_DIR: root,
          E2E_GATEWAY_HOST: "fictional",
          E2E_WORK: work,
        },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(existsSync(work)).toBe(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it.skipIf(process.platform !== "linux")(
  "never signals a stale birth, but retires the actual owned child",
  async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const closed = new Promise((done) => child.once("close", done));
    try {
      const fields = readFileSync(`/proc/${child.pid}/stat`, "utf8").split(") ")[1].split(" ");
      const record = { pid: child.pid, started: fields[19] };
      await stopMailbox({ ...record, started: "0" });
      expect(child.exitCode).toBe(null);
      process.kill(child.pid, 0);
      await stopMailbox(record);
      await closed;
      expect(child.signalCode).toBe("SIGTERM");
      await expect(stopMailbox({ pid: child.pid, started: 1 })).rejects.toThrow();
    } finally {
      if (!child.signalCode && child.exitCode === null) child.kill();
    }
  },
);
