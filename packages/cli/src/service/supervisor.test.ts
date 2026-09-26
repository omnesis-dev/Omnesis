// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "@omnesis/cli-shared";
import {
  LaunchdSupervisor,
  SystemdSupervisor,
  createSupervisor,
  launchdPlistEnvValue,
  mapSystemdActiveState,
  parseLaunchctlPrint,
  type ExecResult,
  type ExecRunner,
  type LaunchdDeps,
  type StreamRunner,
} from "./supervisor.js";
import {
  darwinLogsDir,
  generateLaunchdPlist,
  launchdLogPaths,
  systemdWritablePaths,
} from "./units.js";
import type { GatewayLockHolder } from "@omnesis/core";
import type { ServiceSpec } from "./types.js";

const tempDirs: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-service-test-"));
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

function makeStream() {
  const calls: string[][] = [];
  const stream: StreamRunner = (cmd, args) => {
    calls.push([cmd, ...args]);
    return Promise.resolve(0);
  };
  return { calls, stream };
}

function spec(home: string, overrides: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    component: "gateway",
    configDir: join(home, ".config", "omnesis"),
    exec: ["/usr/local/bin/omnesis", "gateway", "serve"],
    env: { OMNESIS_CONFIG_DIR: join(home, ".config", "omnesis") },
    logsDir: darwinLogsDir(home),
    ...overrides,
  };
}

// ── systemd backend ────────────────────────────────────────────────────

describe("SystemdSupervisor", () => {
  function make(responses: Array<{ prefix: string[]; result: Partial<ExecResult> }> = []) {
    const home = makeHome();
    const { calls, exec } = makeExec(responses);
    const { calls: streamCalls, stream } = makeStream();
    const sup = new SystemdSupervisor({ exec, stream, home, username: "maya" });
    return { home, sup, calls, streamCalls };
  }

  it("install writes the unit file, daemon-reloads, enables --now, and enables linger", async () => {
    const { home, sup, calls } = make();
    await sup.install(spec(home));
    const unitPath = join(home, ".config", "systemd", "user", "omnesis-gateway.service");
    expect(existsSync(unitPath)).toBe(true);
    expect(readFileSync(unitPath, "utf8")).toContain(
      "ExecStart=/usr/local/bin/omnesis gateway serve",
    );
    expect(statSync(unitPath).mode & 0o777).toBe(0o600);
    expect(calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "omnesis-gateway.service"],
      ["loginctl", "enable-linger", "maya"],
    ]);
  });

  it("install creates every directory the unit will name in ReadWritePaths", async () => {
    // systemd refuses to build the service's mount namespace when a
    // ReadWritePaths entry is missing: the unit dies with 226/NAMESPACE before
    // its command ever runs, and Restart=on-failure turns that into a crash
    // loop the operator sees as a gateway that never came up. Seen on Fedora
    // 42, where the state/logs directory did not exist yet.
    const { home, sup } = make();
    const built = spec(home);
    const writable = systemdWritablePaths(built);
    expect(writable.every((path) => !existsSync(path))).toBe(true);

    await sup.install(built);

    const unit = readFileSync(
      join(home, ".config", "systemd", "user", "omnesis-gateway.service"),
      "utf8",
    );
    const listed = unit.split("\n").find((line) => line.startsWith("ReadWritePaths="));
    expect(listed).toBeTruthy();
    for (const path of writable) {
      expect(listed).toContain(path);
      expect(existsSync(path), `${path} must exist before the unit starts`).toBe(true);
    }
  });

  it("install leaves no scratch file beside the unit", async () => {
    // The unit goes through the atomic, fsync-backed write: a power cut right
    // after an install used to leave it zero-length, and systemd then reports
    // the unit masked with nothing running at boot.
    const { home, sup } = make();
    await sup.install(spec(home));
    const unitDir = join(home, ".config", "systemd", "user");
    expect(readdirSync(unitDir).filter((name) => name.includes(".omnesis-"))).toEqual([]);
    expect(readdirSync(unitDir)).toContain("omnesis-gateway.service");
  });

  it("install does not fail when enable-linger is denied (needs sudo)", async () => {
    const { home, sup } = make([
      { prefix: ["loginctl", "enable-linger"], result: { code: 1, stderr: "Access denied" } },
    ]);
    await expect(sup.install(spec(home))).resolves.toBeUndefined();
  });

  it("install threads afterUnit into the unit file", async () => {
    const { home, sup } = make();
    await sup.install(spec(home, { component: "collector" }), {
      afterUnit: "omnesis-gateway.service",
    });
    const unit = readFileSync(sup.unitPath("collector"), "utf8");
    expect(unit).toContain("After=omnesis-gateway.service");
  });

  it("install surfaces a systemctl failure", async () => {
    const { home, sup } = make([
      {
        prefix: ["systemctl", "--user", "enable"],
        result: { code: 1, stderr: "Failed to connect to bus" },
      },
    ]);
    await expect(sup.install(spec(home))).rejects.toThrow(/enable --now.*Failed to connect/s);
  });

  it("reload makes systemd reread the unit before restarting", async () => {
    const { home, sup, calls } = make();
    await sup.install(spec(home));
    calls.length = 0;
    await sup.reload("gateway");
    expect(calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "restart", "omnesis-gateway.service"],
    ]);
  });

  it("loadDefinition makes systemd reread the unit and leaves the daemon running", async () => {
    const { home, sup, calls } = make();
    await sup.install(spec(home));
    calls.length = 0;
    await expect(sup.loadDefinition("gateway")).resolves.toBe(true);
    expect(calls).toEqual([["systemctl", "--user", "daemon-reload"]]);
  });

  it("inspects the effective fragment, drop-ins, and manager environment", async () => {
    const home = makeHome();
    const path = join(home, ".config", "systemd", "user", "omnesis-gateway.service");
    const { calls, exec } = makeExec([
      {
        prefix: ["systemctl", "--user", "show", "-p", "FragmentPath"],
        result: { stdout: `${path}\n` },
      },
      {
        prefix: ["systemctl", "--user", "show", "-p", "DropInPaths"],
        result: { stdout: "/etc/systemd/user/omnesis-gateway.service.d/override.conf\n" },
      },
      {
        prefix: ["systemctl", "--user", "show-environment"],
        result: { stdout: "PATH=/usr/bin\nOMNESIS_GATEWAY_PORT=17600\n" },
      },
    ]);
    const { stream } = makeStream();
    const sup = new SystemdSupervisor({ exec, stream, home, username: "maya" });

    await expect(sup.inspectDefinition("gateway")).resolves.toEqual({
      fragmentPath: path,
      overridePaths: ["/etc/systemd/user/omnesis-gateway.service.d/override.conf"],
      inheritedEnvironment: ["OMNESIS_GATEWAY_PORT"],
      inheritedEnvironmentText: "PATH=/usr/bin\nOMNESIS_GATEWAY_PORT=17600\n",
    });
    expect(calls).toEqual([
      ["systemctl", "--user", "show", "-p", "FragmentPath", "--value", "omnesis-gateway.service"],
      ["systemctl", "--user", "show", "-p", "DropInPaths", "--value", "omnesis-gateway.service"],
      ["systemctl", "--user", "show-environment"],
    ]);
  });

  it("uninstall disables, removes the unit file, and daemon-reloads", async () => {
    const { home, sup, calls } = make();
    await sup.install(spec(home));
    calls.length = 0;
    await sup.uninstall("gateway");
    expect(existsSync(sup.unitPath("gateway"))).toBe(false);
    expect(calls).toEqual([
      ["systemctl", "--user", "disable", "--now", "omnesis-gateway.service"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
  });

  it("uninstall is idempotent when nothing is installed", async () => {
    const { sup } = make([
      { prefix: ["systemctl", "--user", "disable"], result: { code: 1, stderr: "not loaded" } },
    ]);
    await expect(sup.uninstall("gateway")).resolves.toBeUndefined();
  });

  it("instance-suffixed units land in instance-suffixed files", async () => {
    const { home, sup } = make();
    await sup.install(spec(home, { instance: "staging" }));
    expect(
      existsSync(join(home, ".config", "systemd", "user", "omnesis-gateway-staging.service")),
    ).toBe(true);
    expect(sup.isInstalled("gateway", "staging")).toBe(true);
    expect(sup.isInstalled("gateway")).toBe(false);
  });

  it("start/stop/restart shell out to systemctl --user", async () => {
    const { home, sup, calls } = make();
    await sup.install(spec(home));
    calls.length = 0;
    await sup.start("gateway");
    await sup.stop("gateway");
    await sup.restart("gateway");
    expect(calls).toEqual([
      ["systemctl", "--user", "start", "omnesis-gateway.service"],
      ["systemctl", "--user", "stop", "omnesis-gateway.service"],
      ["systemctl", "--user", "restart", "omnesis-gateway.service"],
    ]);
  });

  it("start on a missing unit is a user error", async () => {
    const { sup } = make();
    await expect(sup.start("gateway")).rejects.toThrow(CliError);
  });

  it("status reports not-installed without shelling out", async () => {
    const { sup, calls } = make();
    const status = await sup.status("gateway");
    expect(status).toEqual({
      component: "gateway",
      unit: "omnesis-gateway.service",
      installed: false,
      state: "not-installed",
      pid: null,
    });
    expect(calls).toEqual([]);
  });

  it("status parses is-active + MainPID for a running unit", async () => {
    const { home, sup } = make([
      { prefix: ["systemctl", "--user", "is-active"], result: { stdout: "active\n" } },
      { prefix: ["systemctl", "--user", "show"], result: { stdout: "4242\n" } },
    ]);
    await sup.install(spec(home));
    const status = await sup.status("gateway");
    expect(status.state).toBe("running");
    expect(status.pid).toBe(4242);
  });

  it("status maps failed units and skips the pid lookup", async () => {
    const { home, sup, calls } = make([
      {
        prefix: ["systemctl", "--user", "is-active"],
        result: { code: 3, stdout: "failed\n" },
      },
    ]);
    await sup.install(spec(home));
    calls.length = 0;
    const status = await sup.status("gateway");
    expect(status.state).toBe("failed");
    expect(status.pid).toBeNull();
    expect(calls).toEqual([["systemctl", "--user", "is-active", "omnesis-gateway.service"]]);
  });

  it("logs builds a journalctl argv with one -u per component", async () => {
    const { home, sup, streamCalls } = make();
    await sup.install(spec(home));
    await sup.install(spec(home, { component: "collector" }));
    await sup.logs(["gateway", "collector"], undefined, { follow: true, lines: 25 });
    expect(streamCalls).toEqual([
      [
        "journalctl",
        "--user",
        "-u",
        "omnesis-gateway.service",
        "-u",
        "omnesis-collector.service",
        "-n",
        "25",
        "-f",
      ],
    ]);
  });

  it("postInstallHint suggests linger when Linger=no", async () => {
    const { sup } = make([{ prefix: ["loginctl"], result: { stdout: "Linger=no\n" } }]);
    const hint = await sup.postInstallHint();
    expect(hint).toMatch(/enable-linger maya/);
  });

  it("postInstallHint is null when linger is already on", async () => {
    const { sup } = make([{ prefix: ["loginctl"], result: { stdout: "Linger=yes\n" } }]);
    expect(await sup.postInstallHint()).toBeNull();
  });
});

describe("mapSystemdActiveState", () => {
  it("maps the documented states", () => {
    expect(mapSystemdActiveState("active")).toBe("running");
    expect(mapSystemdActiveState("activating")).toBe("starting");
    expect(mapSystemdActiveState("failed")).toBe("failed");
    expect(mapSystemdActiveState("inactive")).toBe("stopped");
    expect(mapSystemdActiveState("deactivating")).toBe("stopped");
    expect(mapSystemdActiveState("banana")).toBe("unknown");
  });
});

// ── launchd backend ────────────────────────────────────────────────────

describe("LaunchdSupervisor", () => {
  /** Unless a test says otherwise, launchd reports the job as not registered. */
  const NOT_LOADED = {
    prefix: ["launchctl", "print"],
    result: { code: 113, stderr: "Could not find service" },
  };
  const LOADED = {
    prefix: ["launchctl", "print"],
    result: { code: 0, stdout: "state = running\n" },
  };

  function make(
    responses: Array<{ prefix: string[]; result: Partial<ExecResult> }> = [],
    deps: Partial<
      Pick<LaunchdDeps, "stopTimeoutMs" | "gatewayHolder" | "signal" | "orphanExitTimeoutMs">
    > = {},
  ) {
    const home = makeHome();
    const replies = [...responses, NOT_LOADED];
    const { calls, exec } = makeExec(replies);
    const { calls: streamCalls, stream } = makeStream();
    const sup = new LaunchdSupervisor({
      exec,
      stream,
      home,
      uid: 501,
      sleep: () => Promise.resolve(),
      ...deps,
    });
    return { home, sup, calls, streamCalls, replies };
  }

  it("install writes the plist, creates the logs dir, bootstraps, and kickstarts", async () => {
    const { home, sup, calls } = make();
    await sup.install(spec(home));
    const plistPath = join(home, "Library", "LaunchAgents", "dev.omnesis.gateway.plist");
    expect(existsSync(plistPath)).toBe(true);
    expect(existsSync(darwinLogsDir(home))).toBe(true);
    expect(readFileSync(plistPath, "utf8")).toContain("<string>dev.omnesis.gateway</string>");
    expect(statSync(plistPath).mode & 0o777).toBe(0o600);
    expect(statSync(darwinLogsDir(home)).mode & 0o777).toBe(0o700);
    expect(calls).toEqual([
      ["launchctl", "bootout", "gui/501/dev.omnesis.gateway"],
      ["launchctl", "print", "gui/501/dev.omnesis.gateway"],
      ["launchctl", "bootstrap", "gui/501", plistPath],
      // RunAtLoad spawns are not reliable outside a real GUI login context
      // (SSH installs leave the job pended) — install always kickstarts.
      ["launchctl", "kickstart", "-k", "gui/501/dev.omnesis.gateway"],
    ]);
  });

  it("install leaves no scratch file beside the plist", async () => {
    // Same durability as the systemd unit: the plist is written atomically and
    // fsynced, so a power cut cannot leave launchd a zero-length job definition.
    const { home, sup } = make();
    await sup.install(spec(home));
    const agents = join(home, "Library", "LaunchAgents");
    expect(readdirSync(agents).filter((name) => name.includes(".omnesis-"))).toEqual([]);
    expect(readdirSync(agents)).toContain("dev.omnesis.gateway.plist");
  });

  it("install waits for the previous registration to unload before bootstrapping", async () => {
    let printsUntilGone = 2;
    const exec: ExecRunner = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === "print") {
        printsUntilGone -= 1;
        return Promise.resolve(
          printsUntilGone >= 0
            ? { code: 0, stdout: "state = running\n", stderr: "" }
            : { code: 113, stdout: "", stderr: "Could not find service" },
        );
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const calls: string[][] = [];
    const home = makeHome();
    const sup = new LaunchdSupervisor({
      exec,
      stream: makeStream().stream,
      home,
      uid: 501,
      sleep: () => Promise.resolve(),
    });
    await sup.install(spec(home));
    expect(calls.map((c) => c[1])).toEqual([
      "bootout",
      "print",
      "print",
      "print",
      "bootstrap",
      "kickstart",
    ]);
  });

  it("install tolerates the pre-bootstrap bootout failing (fresh install)", async () => {
    const { home, sup } = make([
      { prefix: ["launchctl", "bootout"], result: { code: 3, stderr: "No such service" } },
    ]);
    await expect(sup.install(spec(home))).resolves.toBeUndefined();
  });

  it("install surfaces a bootstrap failure", async () => {
    const { home, sup } = make([
      { prefix: ["launchctl", "bootstrap"], result: { code: 5, stderr: "Input/output error" } },
    ]);
    await expect(sup.install(spec(home))).rejects.toThrow(/bootstrap failed \(5\)/);
  });

  it("uninstall boots out and removes the plist", async () => {
    const { home, sup, calls } = make();
    await sup.install(spec(home));
    calls.length = 0;
    await sup.uninstall("gateway");
    expect(existsSync(sup.unitPath("gateway"))).toBe(false);
    expect(calls).toEqual([
      ["launchctl", "bootout", "gui/501/dev.omnesis.gateway"],
      ["launchctl", "print", "gui/501/dev.omnesis.gateway"],
    ]);
  });

  it("start and restart register an unloaded job before kickstarting it", async () => {
    const { home, sup, calls } = make();
    await sup.install(spec(home));
    calls.length = 0;
    await sup.start("gateway");
    await sup.restart("gateway");
    expect(calls).toEqual([
      ["launchctl", "print", "gui/501/dev.omnesis.gateway"],
      ["launchctl", "bootstrap", "gui/501", sup.unitPath("gateway")],
      ["launchctl", "kickstart", "-k", "gui/501/dev.omnesis.gateway"],
      ["launchctl", "print", "gui/501/dev.omnesis.gateway"],
      ["launchctl", "bootstrap", "gui/501", sup.unitPath("gateway")],
      ["launchctl", "kickstart", "-k", "gui/501/dev.omnesis.gateway"],
    ]);
  });

  it("start and restart only kickstart a job launchd already has", async () => {
    const { home, sup, calls, replies } = make();
    await sup.install(spec(home));
    replies.unshift(LOADED);
    calls.length = 0;
    await sup.start("gateway");
    await sup.restart("gateway");
    expect(calls).toEqual([
      ["launchctl", "print", "gui/501/dev.omnesis.gateway"],
      ["launchctl", "kickstart", "-k", "gui/501/dev.omnesis.gateway"],
      ["launchctl", "print", "gui/501/dev.omnesis.gateway"],
      ["launchctl", "kickstart", "-k", "gui/501/dev.omnesis.gateway"],
    ]);
  });

  it("stop unloads the job and returns once launchd no longer lists it", async () => {
    const { home, sup, calls } = make();
    await sup.install(spec(home));
    calls.length = 0;
    await sup.stop("gateway");
    expect(calls).toEqual([
      ["launchctl", "bootout", "gui/501/dev.omnesis.gateway"],
      ["launchctl", "print", "gui/501/dev.omnesis.gateway"],
    ]);
  });

  it("stop reports a job that outlives the wait instead of claiming it stopped", async () => {
    const { home, sup, replies } = make([], { stopTimeoutMs: 0 });
    await sup.install(spec(home));
    replies.unshift(LOADED);
    await expect(sup.stop("gateway")).rejects.toThrow(/still running .* after launchctl bootout/);
  });

  it("reload unloads, waits, re-registers the existing plist and restarts", async () => {
    const { home, sup, calls } = make();
    await sup.install(spec(home));
    calls.length = 0;
    await sup.reload("gateway");
    expect(calls).toEqual([
      ["launchctl", "bootout", "gui/501/dev.omnesis.gateway"],
      ["launchctl", "print", "gui/501/dev.omnesis.gateway"],
      ["launchctl", "bootstrap", "gui/501", sup.unitPath("gateway")],
      ["launchctl", "kickstart", "-k", "gui/501/dev.omnesis.gateway"],
    ]);
  });

  describe("a gateway the job left behind", () => {
    // The job's tsx launcher died and its gateway child did not: launchd
    // reparented the gateway (ppid 1) and started a replacement (pid 4100)
    // that waits on the orphan's config-dir lock.
    const ORPHAN: GatewayLockHolder = {
      pid: 3963,
      processStart: "start-3963",
      hostname: "mac.local",
      startedAt: "2026-09-26T11:32:53.736Z",
    };
    const JOB_RUNNING = {
      prefix: ["launchctl", "print"],
      result: { code: 0, stdout: "state = running\npid = 4100\n" },
    };
    const psRow = (ppid: number, env: string) => ({
      prefix: ["ps"],
      result: {
        code: 0,
        stdout: `    ${ppid} /opt/homebrew/bin/node --require preflight.cjs index.ts gateway serve PATH=/usr/bin ${env} OMNESIS_SERVICE_MANAGER=launchd-user\n`,
      },
    });
    const FROM_JOB = "XPC_SERVICE_NAME=dev.omnesis.gateway";

    function withOrphan(
      responses: Array<{ prefix: string[]; result: Partial<ExecResult> }>,
      opts: { exitsOn?: NodeJS.Signals | null; orphanExitTimeoutMs?: number } = {},
    ) {
      let holder: GatewayLockHolder | null = null;
      const signals: Array<[number, NodeJS.Signals]> = [];
      const exitsOn = opts.exitsOn === undefined ? "SIGTERM" : opts.exitsOn;
      const made = make(responses, {
        gatewayHolder: () => holder,
        signal: (pid, sig) => {
          signals.push([pid, sig]);
          if (sig === exitsOn) holder = null;
        },
        ...(opts.orphanExitTimeoutMs !== undefined
          ? { orphanExitTimeoutMs: opts.orphanExitTimeoutMs }
          : {}),
      });
      return {
        ...made,
        signals,
        /** After install: the orphan holds the lock, and the job runs as pid 4100. */
        orphanNow: (h: GatewayLockHolder = ORPHAN, jobRunning = true) => {
          if (jobRunning) made.replies.unshift(JOB_RUNNING);
          holder = h;
        },
      };
    }

    it("restart stops it before kickstarting the job", async () => {
      const { home, sup, calls, signals, orphanNow } = withOrphan([psRow(1, FROM_JOB)]);
      await sup.install(spec(home));
      orphanNow();
      calls.length = 0;
      await sup.restart("gateway");
      expect(signals).toEqual([[3963, "SIGTERM"]]);
      expect(calls).toEqual([
        ["launchctl", "print", "gui/501/dev.omnesis.gateway"],
        ["ps", "-E", "-ww", "-o", "ppid=,command=", "-p", "3963"],
        ["launchctl", "print", "gui/501/dev.omnesis.gateway"],
        ["launchctl", "kickstart", "-k", "gui/501/dev.omnesis.gateway"],
      ]);
    });

    it("stop stops it after unloading the job", async () => {
      const { home, sup, signals, orphanNow } = withOrphan([psRow(1, FROM_JOB)]);
      await sup.install(spec(home));
      orphanNow(ORPHAN, false);
      await sup.stop("gateway");
      expect(signals).toEqual([[3963, "SIGTERM"]]);
    });

    it("SIGKILLs one that outlives the shutdown budget", async () => {
      const { home, sup, signals, orphanNow } = withOrphan([psRow(1, FROM_JOB)], {
        exitsOn: "SIGKILL",
        orphanExitTimeoutMs: 0,
      });
      await sup.install(spec(home));
      orphanNow();
      await sup.restart("gateway");
      expect(signals).toEqual([
        [3963, "SIGTERM"],
        [3963, "SIGKILL"],
      ]);
    });

    it("reports one that survives SIGKILL instead of restarting beside it", async () => {
      const { home, sup, calls, orphanNow } = withOrphan([psRow(1, FROM_JOB)], {
        exitsOn: null,
        orphanExitTimeoutMs: 0,
      });
      await sup.install(spec(home));
      orphanNow();
      calls.length = 0;
      await expect(sup.restart("gateway")).rejects.toThrow(/PID 3963.*still holds/);
      expect(calls.some((call) => call[1] === "kickstart")).toBe(false);
    });

    it("leaves the job's own gateway alone", async () => {
      const { home, sup, calls, signals, orphanNow } = withOrphan([]);
      await sup.install(spec(home));
      orphanNow({ ...ORPHAN, pid: 4100 });
      calls.length = 0;
      await sup.restart("gateway");
      expect(signals).toEqual([]);
      expect(calls.some((call) => call[0] === "ps")).toBe(false);
    });

    it("leaves a gateway alone while the launcher that started it is alive", async () => {
      // tsx under the job: the gateway's parent is the job's process.
      const { home, sup, signals, orphanNow } = withOrphan([psRow(4100, FROM_JOB)]);
      await sup.install(spec(home));
      orphanNow();
      await sup.restart("gateway");
      expect(signals).toEqual([]);
    });

    it("stops one whose own launcher is still alive but no longer the job's", async () => {
      // A launcher launchd lost track of: the gateway's parent lives on, yet the
      // job now runs pid 4100.
      const { home, sup, signals, orphanNow } = withOrphan([psRow(3960, FROM_JOB)]);
      await sup.install(spec(home));
      orphanNow();
      await sup.restart("gateway");
      expect(signals).toEqual([[3963, "SIGTERM"]]);
    });

    it("leaves a gateway someone runs by hand alone", async () => {
      const { home, sup, signals, orphanNow } = withOrphan([
        psRow(1, "XPC_SERVICE_NAME=application.com.apple.Terminal.1234"),
      ]);
      await sup.install(spec(home));
      orphanNow();
      await sup.restart("gateway");
      expect(signals).toEqual([]);
    });

    it("never looks for one behind the collector", async () => {
      const { home, sup, calls, signals, orphanNow } = withOrphan([psRow(1, FROM_JOB)]);
      await sup.install(spec(home, { component: "collector" }));
      orphanNow();
      calls.length = 0;
      await sup.restart("collector");
      expect(signals).toEqual([]);
      expect(calls.some((call) => call[0] === "ps")).toBe(false);
    });
  });

  it("reads a plist environment value back as generated, escapes and all", () => {
    const home = makeHome();
    const configDir = join(home, "a <b> & 'c' \"d\"");
    const plist = generateLaunchdPlist(spec(home, { env: { OMNESIS_CONFIG_DIR: configDir } }));
    expect(launchdPlistEnvValue(plist, "OMNESIS_CONFIG_DIR")).toBe(configDir);
    expect(launchdPlistEnvValue(plist, "OMNESIS_MISSING")).toBeNull();
  });

  it("loadDefinition cannot load a plist without restarting the job, and says so", async () => {
    const { home, sup, calls } = make();
    await sup.install(spec(home));
    calls.length = 0;
    await expect(sup.loadDefinition("gateway")).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it("inspects launchd's inherited migration environment", async () => {
    const { sup, calls } = make([
      {
        prefix: ["launchctl", "export"],
        result: { stdout: "PATH=/usr/bin; export PATH;\nOMNESIS_GATEWAY_PORT=17600;\n" },
      },
    ]);
    await expect(sup.inspectDefinition("gateway")).resolves.toEqual({
      fragmentPath: sup.unitPath("gateway"),
      overridePaths: [],
      inheritedEnvironment: ["OMNESIS_GATEWAY_PORT"],
      inheritedEnvironmentText: "PATH=/usr/bin; export PATH;\nOMNESIS_GATEWAY_PORT=17600;\n",
    });
    expect(calls).toEqual([["launchctl", "export"]]);
  });

  it("start on a missing unit is a user error", async () => {
    const { sup } = make();
    await expect(sup.start("gateway")).rejects.toThrow(CliError);
  });

  it("status parses launchctl print output", async () => {
    const { home, sup, replies } = make();
    await sup.install(spec(home));
    replies.unshift({
      prefix: ["launchctl", "print"],
      result: { stdout: "gui/501/dev.omnesis.gateway = {\n\tstate = running\n\tpid = 743\n}\n" },
    });
    const status = await sup.status("gateway");
    expect(status.state).toBe("running");
    expect(status.pid).toBe(743);
  });

  it("status reports stopped when the agent is not registered", async () => {
    const { home, sup } = make([
      { prefix: ["launchctl", "print"], result: { code: 113, stderr: "Could not find service" } },
    ]);
    await sup.install(spec(home));
    const status = await sup.status("gateway");
    expect(status.state).toBe("stopped");
    expect(status.installed).toBe(true);
  });

  it("logs tails only existing log files", async () => {
    const { home, sup, streamCalls } = make();
    const logsDir = darwinLogsDir(home);
    mkdirSync(logsDir, { recursive: true });
    const { out } = launchdLogPaths(logsDir, "gateway");
    writeFileSync(out, "hello\n");
    await sup.logs(["gateway", "collector"], undefined, { follow: false, lines: 50 });
    expect(streamCalls).toEqual([["tail", "-n", "50", out]]);
  });

  it("logs errors when no log files exist yet", async () => {
    const { sup } = make();
    await expect(sup.logs(["gateway"], undefined, { follow: false, lines: 50 })).rejects.toThrow(
      /No log files/,
    );
  });
});

describe("parseLaunchctlPrint", () => {
  it("extracts a running state and pid", () => {
    const parsed = parseLaunchctlPrint("foo = {\n\tstate = running\n\tpid = 12\n}");
    expect(parsed).toEqual({ state: "running", pid: 12 });
  });

  it("maps non-running states to stopped", () => {
    expect(parseLaunchctlPrint("\tstate = not running\n").state).toBe("stopped");
    expect(parseLaunchctlPrint("\tstate = waiting\n").state).toBe("stopped");
  });

  it("is unknown when no state line is present", () => {
    expect(parseLaunchctlPrint("garbage").state).toBe("unknown");
  });
});

// ── factory ────────────────────────────────────────────────────────────

describe("createSupervisor", () => {
  it("picks launchd on darwin and systemd on linux", () => {
    expect(createSupervisor("darwin").platform).toBe("darwin");
    expect(createSupervisor("linux").platform).toBe("linux");
  });

  it("rejects unsupported platforms", () => {
    expect(() => createSupervisor("win32")).toThrow(/not supported/);
  });
});
