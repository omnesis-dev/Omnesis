// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A Docker install and a native collector on one machine — the setup the
 * Docker banner recommends on a Mac, where the Apple sources need a native
 * collector beside a Docker gateway.
 *
 * Both halves run the real installer in one home: `--docker` against a fake
 * `docker` (which also stands in for the CLI inside the containers), and
 * `--collector` as a source install against the fixture remote and a
 * recording CLI shim. What is asserted is ownership: each install keeps its
 * own command, config directory, device token and service, a pairing code is
 * minted with the local Docker gateway, and removing either leaves the other
 * as it was. The reverse order — a native install first — is refused before
 * the Docker install could take its command and directory over.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  callStartingWith,
  createFixture,
  destroyFixture,
  fixturePath,
  HAS_PTY,
  plantGatewayCert,
  prepareHome,
  runInstaller as runInstallerRaw,
  runInstallerOnTty as runInstallerOnTtyRaw,
  writeExecutable,
} from "./installer-harness.mjs";

const MINTED_CODE = "M1NT3DC0DE";
const TYPED_CODE = "K7QX2M9ZB4";
const NATIVE_DEVICE = "field-station";

/**
 * The containers' side. Every call is logged to OMNESIS_TEST_DOCKER; a compose
 * command ending in `omnesis <args>` is the CLI inside a container, logged to
 * the same call log the native CLI shim writes, prefixed `[docker]`.
 */
const DOCKER_SHIM = `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$OMNESIS_TEST_DOCKER"
case "$1" in
  info|context|manifest) exit 0 ;;
  compose) [ "$2" != version ] || exit 0 ;;
  *) exit 0 ;;
esac
COMPOSE_DIR="$(dirname "$3")"
SEEN=0
CLI_ARGS=""
for ARG in "$@"; do
  if [ "$SEEN" = 1 ]; then CLI_ARGS="$CLI_ARGS $ARG"; continue; fi
  if [ "$ARG" = omnesis ]; then SEEN=1; fi
done
if [ "$SEEN" = 1 ]; then
  printf '[docker] %s\\n' "\${CLI_ARGS# }" >> "$OMNESIS_TEST_CALLS"
  # shellcheck disable=SC2086
  set -- $CLI_ARGS
  case "$1" in
    --version) echo "9.9.0" ;;
    sources)
      # The first add of a folder source leaves the request the CLI leaves
      # for a folder the container cannot see; the resumed one names it.
      if [ "$2" = add ] && [ "$#" = 3 ] && [ -n "\${OMNESIS_TEST_SHARE_PATH:-}" ]; then
        printf 'path=%s\narg=sources\narg=add\narg=%s\narg=%s\narg=--device\narg=dev-1\n' \
          "$OMNESIS_TEST_SHARE_PATH" "$3" "$OMNESIS_TEST_SHARE_PATH" > "$COMPOSE_DIR/share-request"
        exit 1
      fi ;;
    devices)
      if [ "$2 \${3:-} \${4:-} \${5:-}" = "pair --kind collector --json" ]; then
        printf '{"pairingCode":"${MINTED_CODE}","kind":"collector","scopes":["collector"],"expiresAt":1}\\n'
      fi ;;
  esac
  exit 0
fi
for ARG in "$@"; do
  case "$ARG" in
    config) awk '/^  [a-z-]+:/ { sub(/:$/, "", $1); print $1 }' "$3"; exit 0 ;;
  esac
done
exit 0
`;

/**
 * The native CLI. `pair` writes the token where it was told to save it, and
 * `service install` stands in for the daemon by writing the pairing record into
 * the config directory the CLI was pointed at — so a collector that wrote into
 * the Docker install's directory would show up there.
 */
const CLI_SHIM = `#!/bin/sh
shift 2>/dev/null || true
printf '%s\\n' "$*" >> "$OMNESIS_TEST_CALLS"
printf 'config-dir %s launcher %s\\n' "\${OMNESIS_CONFIG_DIR:-unset}" "\${OMNESIS_LAUNCHER:-unset}" >> "$OMNESIS_TEST_CALLS.env"
CONFIG="\${OMNESIS_CONFIG_DIR:-$HOME/.config/omnesis}"
case "$1" in
  --version) echo "9.9.0" ;;
  pair)
    SAVE=""
    while [ "$#" -gt 0 ]; do [ "$1" = --save ] && SAVE="$2"; shift; done
    mkdir -p "$(dirname "$SAVE")"
    printf 'native-device-token\\n' > "$SAVE" ;;
  service)
    if [ "$2" = install ]; then
      mkdir -p "$CONFIG"
      printf '{"state":"paired","deviceName":"${NATIVE_DEVICE}","gatewayUrl":"%s","tokenFingerprint":"0123456789abcdef","lastAuthenticatedAt":1,"unauthorizedAt":null,"repairCommand":null}\\n' \\
        "$OMNESIS_TEST_GATEWAY_URL" > "$CONFIG/collector-pairing-state.json"
      case "$(uname -s)" in
        Darwin) mkdir -p "$HOME/Library/LaunchAgents"; : > "$HOME/Library/LaunchAgents/dev.omnesis.collector.plist" ;;
        *) mkdir -p "$HOME/.config/systemd/user"; : > "$HOME/.config/systemd/user/omnesis-collector.service" ;;
      esac
    fi
    if [ "$2" = uninstall ]; then
      rm -f "$HOME/Library/LaunchAgents/dev.omnesis.collector.plist" "$HOME/.config/systemd/user/omnesis-collector.service"
    fi ;;
esac
exit 0
`;

const LOCAL_GATEWAY = "https://localhost:7600";

function dockerLog(home) {
  return join(home, "docker-calls.log");
}

function env(home, extra = {}) {
  return {
    OMNESIS_TEST_DOCKER: dockerLog(home),
    OMNESIS_DOCKER_PULL_RETRY_SECONDS: "0",
    OMNESIS_TEST_GATEWAY_URL: LOCAL_GATEWAY,
    ...extra,
  };
}

function withPaths(run) {
  const home = run.home;
  return {
    ...run,
    dockerDir: join(home, ".config", "omnesis"),
    nativeDir: join(home, ".config", "omnesis-collector"),
    launcher: join(home, ".local", "bin", "omnesis"),
    shim: join(home, ".local", "bin", "omnesis-collector"),
    innerLauncher: join(home, ".local", "lib", "omnesis-collector", "omnesis"),
    docker: existsSync(dockerLog(home))
      ? readFileSync(dockerLog(home), "utf8").split("\n").filter(Boolean)
      : [],
    envCalls: existsSync(join(home, "cli-calls.log.env"))
      ? readFileSync(join(home, "cli-calls.log.env"), "utf8").split("\n").filter(Boolean)
      : [],
  };
}

function run(name, args, extra = {}) {
  const home = prepareHome(name);
  return withPaths(runInstallerRaw(name, args, env(home, extra)));
}

function runOnTty(name, args, answers, extra = {}) {
  const home = prepareHome(name);
  return withPaths(runInstallerOnTtyRaw(name, args, answers, env(home, extra)));
}

/** A Docker gateway and collector on this machine, on its own certificate. */
function dockerGateway(name, flags = []) {
  plantGatewayCert(name);
  const docker = run(name, [
    "--docker",
    "--no-model",
    "--no-keyring",
    "--version",
    "9.9.0",
    ...flags,
  ]);
  expect(docker.status, docker.output).toBe(0);
  return docker;
}

/** Run a host command as the operator would: the fakes first on PATH. */
function host(runResult, command, args, extra = {}) {
  return spawnSync(command, args, {
    env: {
      PATH: `${fixturePath("fake-bin")}:${fixturePath("host-tools")}:/usr/bin:/bin`,
      HOME: runResult.home,
      OMNESIS_TEST_DOCKER: dockerLog(runResult.home),
      OMNESIS_TEST_CALLS: join(runResult.home, "cli-calls.log"),
      ...extra,
    },
    input: "",
    encoding: "utf8",
  });
}

const read = (path) => readFileSync(path, "utf8");

beforeEach(() => {
  createFixture({ name: "docker-native", versions: ["9.9.0"], cliShim: CLI_SHIM });
  writeExecutable(fixturePath("fake-bin", "docker"), DOCKER_SHIM);
});

afterEach(destroyFixture);

describe("a native collector after a Docker install on the same machine", () => {
  test("keeps the Docker launcher and config, and gets its own command, directory and token", () => {
    const docker = dockerGateway("beside");
    const launcherBefore = read(docker.launcher);
    writeFileSync(join(docker.dockerDir, "collector-token"), "container-device-token\n");

    const native = run("beside", ["--collector", "--no-keyring", "--code", TYPED_CODE]);
    expect(native.status, native.output).toBe(0);

    // The command and directory of the Docker install are exactly as they were.
    expect(read(native.launcher)).toBe(launcherBefore);
    expect(read(join(native.dockerDir, "install-method"))).toBe("docker\n");
    expect(read(join(native.dockerDir, "collector-token"))).toBe("container-device-token\n");
    expect(existsSync(join(native.dockerDir, "collector-pairing-state.json"))).toBe(false);

    // The collector's own: a token, a pairing record and a source launcher of
    // its own, behind the omnesis-collector command.
    expect(read(join(native.nativeDir, "collector-token"))).toBe("native-device-token\n");
    expect(existsSync(join(native.nativeDir, "collector-pairing-state.json"))).toBe(true);
    const shim = read(native.shim);
    expect(shim.split("\n")[1]).toBe(
      "# Omnesis native collector beside a Docker install — written by install.sh.",
    );
    expect(shim).toContain(`CONFIG_DIR='${native.nativeDir}'`);
    expect(shim).toContain(`LAUNCHER='${native.innerLauncher}'`);
    expect(read(native.innerLauncher)).toContain(`DEFAULT_CONFIG_DIR='${native.nativeDir}'`);
    // The checkout the run named (macOS reads a temp path through /private).
    expect(read(native.innerLauncher)).toMatch(/^SOURCE_ROOT='[^']*\/checkout-beside'$/mu);

    // Pairing and the service point at this collector alone.
    expect(callStartingWith(native.calls, "pair ")).toBe(
      `pair ${TYPED_CODE} --gateway-url ${LOCAL_GATEWAY} ` +
        `--trust-fingerprint ${callStartingWith(native.calls, "pair ").match(/sha256:[0-9a-f]{64}/u)[0]} ` +
        `--save ${join(native.nativeDir, "collector-token")}`,
    );
    expect(callStartingWith(native.calls, "service install")).toBe(
      `service install collector --env OMNESIS_GATEWAY_URL=${LOCAL_GATEWAY} --exec ${native.shim}`,
    );
    // Every CLI call this run made saw the collector's directory.
    expect(native.envCalls.length).toBeGreaterThan(0);
    for (const line of native.envCalls) {
      expect(line).toContain(`config-dir ${native.nativeDir} `);
    }

    expect(native.output).toContain("beside the Docker install");
    expect(native.output).toContain("omnesis-collector service status|logs|restart");
    expect(native.output).toContain(`omnesis sources add --device '${NATIVE_DEVICE}'`);
    expect(native.output).toContain("omnesis-collector uninstall");
  });

  test("the omnesis-collector command runs the CLI against its own directory", () => {
    dockerGateway("shim-run");
    const native = run("shim-run", ["--collector", "--no-keyring", "--code", TYPED_CODE]);
    expect(native.status, native.output).toBe(0);
    writeFileSync(join(native.home, "cli-calls.log.env"), "");

    const status = host(native, native.shim, ["service", "status"], {
      OMNESIS_CONFIG_DIR: "/somewhere/else",
    });
    expect(status.status, status.stderr).toBe(0);
    const seen = read(join(native.home, "cli-calls.log.env")).trim();
    expect(seen).toBe(`config-dir ${native.nativeDir} launcher ${native.innerLauncher}`);
  });

  test.skipIf(!HAS_PTY)(
    "on a terminal, the pairing code is minted with the local Docker gateway",
    () => {
      dockerGateway("mint");
      const native = runOnTty("mint", ["--collector", "--no-keyring"], []);
      expect(native.status, native.output).toBe(0);
      expect(native.calls).toContain("[docker] devices pair --kind collector --json");
      expect(callStartingWith(native.calls, "pair ")).toContain(`pair ${MINTED_CODE} `);
      expect(native.output).not.toContain("Mint a pairing code on the gateway host");
    },
  );

  test("without a terminal, names the command that mints the code on this machine", () => {
    dockerGateway("no-tty");
    const native = run("no-tty", ["--collector", "--no-keyring"]);
    expect(native.status).not.toBe(0);
    expect(native.output).toContain("This machine's Docker gateway mints one");
    expect(native.output).toContain("omnesis devices pair --kind collector");
    expect(native.calls.some((call) => call.startsWith("pair "))).toBe(false);
  });

  test("a gateway URL on the command line is used as given", () => {
    dockerGateway("named-url");
    const url = "https://studio-northstar.example.com:7600";
    const native = run(
      "named-url",
      ["--collector", "--no-keyring", "--code", TYPED_CODE, "--gateway-url", url],
      { OMNESIS_TEST_GATEWAY_URL: url },
    );
    expect(native.status, native.output).toBe(0);
    expect(callStartingWith(native.calls, "pair ")).toBe(
      `pair ${TYPED_CODE} --gateway-url ${url} --save ${join(native.nativeDir, "collector-token")}`,
    );
  });

  test("a re-run keeps the same directory, command and launcher", () => {
    const docker = dockerGateway("rerun");
    const launcherBefore = read(docker.launcher);
    expect(run("rerun", ["--collector", "--no-keyring", "--code", TYPED_CODE]).status).toBe(0);
    const again = run("rerun", ["--collector", "--no-keyring", "--code", TYPED_CODE]);
    expect(again.status, again.output).toBe(0);
    expect(read(again.launcher)).toBe(launcherBefore);
    expect(read(join(again.nativeDir, "collector-token"))).toBe("native-device-token\n");
  });

  test("a Docker re-run beside it keeps the collector and its command", () => {
    dockerGateway("docker-rerun");
    const native = run("docker-rerun", ["--collector", "--no-keyring", "--code", TYPED_CODE]);
    expect(native.status, native.output).toBe(0);
    const shimBefore = read(native.shim);

    const docker = run("docker-rerun", [
      "--docker",
      "--no-model",
      "--no-keyring",
      "--version",
      "9.9.0",
    ]);
    expect(docker.status, docker.output).toBe(0);
    expect(read(docker.shim)).toBe(shimBefore);
    expect(read(join(docker.nativeDir, "collector-token"))).toBe("native-device-token\n");
  });

  test.each([
    ["a native gateway", []],
    ["a client-only CLI", ["--client-only"]],
  ])("refuses %s, which would replace the Docker install's command", (_label, flags) => {
    const docker = dockerGateway(`refuse-${flags.length}`);
    const before = read(docker.launcher);
    const native = run(`refuse-${flags.length}`, ["--no-keyring", ...flags]);
    expect(native.status).not.toBe(0);
    expect(native.output).toContain("runs Omnesis in Docker");
    expect(native.output).toContain("installs beside it with --collector");
    expect(read(native.launcher)).toBe(before);
    expect(existsSync(native.shim)).toBe(false);
  });

  test("refuses to share the Docker install's config directory", () => {
    const docker = dockerGateway("same-dir");
    const native = run("same-dir", ["--collector", "--no-keyring", "--code", TYPED_CODE], {
      OMNESIS_CONFIG_DIR: docker.dockerDir,
    });
    expect(native.status).not.toBe(0);
    expect(native.output).toContain("keeps a directory of its own");
  });
});

describe("removing one install leaves the other", () => {
  test("omnesis-collector uninstall removes the collector, never the Docker install", () => {
    const docker = dockerGateway("native-uninstall");
    const launcherBefore = read(docker.launcher);
    const native = run("native-uninstall", ["--collector", "--no-keyring", "--code", TYPED_CODE]);
    expect(native.status, native.output).toBe(0);

    const dry = host(native, native.shim, ["uninstall", "--dry-run"]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain("its omnesis command and its data are not touched.");
    expect(dry.stdout).toContain(`omnesis devices revoke '${NATIVE_DEVICE}' --forget`);
    expect(existsSync(native.shim)).toBe(true);

    const refused = host(native, native.shim, ["uninstall"]);
    expect(refused.status).toBe(2);

    const done = host(native, native.shim, ["uninstall", "--yes", "--purge"]);
    expect(done.status, done.stderr).toBe(0);
    expect(read(join(native.home, "cli-calls.log"))).toContain("service uninstall collector");
    expect(existsSync(native.shim)).toBe(false);
    expect(existsSync(native.innerLauncher)).toBe(false);
    expect(existsSync(native.nativeDir)).toBe(false);
    // The install in Docker is exactly as it was.
    expect(read(native.launcher)).toBe(launcherBefore);
    expect(read(join(native.dockerDir, "install-method"))).toBe("docker\n");
    expect(existsSync(join(native.dockerDir, "docker-compose.yml"))).toBe(true);
  });

  test("omnesis uninstall of the Docker install leaves the native collector beside it", () => {
    dockerGateway("docker-uninstall");
    const native = run("docker-uninstall", ["--collector", "--no-keyring", "--code", TYPED_CODE]);
    expect(native.status, native.output).toBe(0);
    const shimBefore = read(native.shim);

    const done = host(native, native.launcher, ["uninstall", "--yes", "--purge"]);
    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout).toContain("The native collector beside this install stays");
    expect(done.stdout).toContain("omnesis-collector uninstall");
    expect(existsSync(native.dockerDir)).toBe(false);
    expect(existsSync(native.launcher)).toBe(false);
    expect(read(native.shim)).toBe(shimBefore);
    expect(read(join(native.nativeDir, "collector-token"))).toBe("native-device-token\n");
    expect(existsSync(native.innerLauncher)).toBe(true);
  });
});

describe("a Docker install after a native one", () => {
  test("is refused while a native collector service runs the omnesis command", () => {
    const native = run(
      "native-first",
      [
        "--collector",
        "--no-keyring",
        "--code",
        TYPED_CODE,
        "--gateway-url",
        "https://gateway.example.com:7600",
      ],
      { OMNESIS_TEST_GATEWAY_URL: "https://gateway.example.com:7600" },
    );
    expect(native.status, native.output).toBe(0);
    const launcherBefore = read(native.launcher);
    const tokenBefore = read(join(native.dockerDir, "collector-token"));

    const docker = run("native-first", [
      "--docker",
      "--no-model",
      "--no-keyring",
      "--version",
      "9.9.0",
    ]);
    expect(docker.status).not.toBe(0);
    expect(docker.output).toContain("runs a native Omnesis install");
    expect(docker.output).toContain("omnesis uninstall");
    expect(read(docker.launcher)).toBe(launcherBefore);
    expect(read(join(docker.dockerDir, "collector-token"))).toBe(tokenBefore);
    expect(existsSync(join(docker.dockerDir, "docker-compose.yml"))).toBe(false);
    expect(docker.docker.some((call) => call.includes(" up -d"))).toBe(false);
  });

  test("is refused over a native collector's leftover device token", () => {
    const home = prepareHome("leftover-token");
    const dir = join(home, ".config", "omnesis");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "collector-token"), "old-native-token\n");

    const docker = run("leftover-token", [
      "--docker",
      "--no-model",
      "--no-keyring",
      "--version",
      "9.9.0",
    ]);
    expect(docker.status).not.toBe(0);
    expect(docker.output).toContain("holds a native collector's device token");
    expect(read(join(dir, "collector-token"))).toBe("old-native-token\n");
    expect(existsSync(join(dir, "docker-compose.yml"))).toBe(false);
  });
});

describe("host folders the collector's container reads", () => {
  const QUIET = ["--docker", "--no-model", "--no-keyring", "--version", "9.9.0"];
  const composeOf = (r) => read(join(r.dockerDir, "docker-compose.yml"));
  /** The lines of one service's block in the compose file. */
  function serviceBlock(compose, name) {
    const lines = compose.split("\n");
    const start = lines.indexOf(`  ${name}:`);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^ {2}[a-z]/u.test(line));
    return rest.slice(0, end === -1 ? undefined : end).join("\n");
  }

  test("the compose file gives the collector the host home and an empty shared block", () => {
    const docker = dockerGateway("compose-split");
    const compose = composeOf(docker);
    const collector = serviceBlock(compose, "collector");
    expect(collector).toContain("      # shared-folders:begin\n      # shared-folders:end");
    expect(collector).toContain(`      - OMNESIS_HOST_HOME=${docker.home}`);
    // The gateway container hosts the CLI, which reads ~ the same way, but it
    // runs no collector and mounts no shared folder.
    const gateway = serviceBlock(compose, "gateway");
    expect(gateway).toContain(`      - OMNESIS_HOST_HOME=${docker.home}`);
    expect(gateway).not.toContain("shared-folders:begin");
  });

  test("a combined container mounts them in the gateway service, which runs the collector", () => {
    const docker = dockerGateway("compose-combined", ["--combined"]);
    expect(serviceBlock(composeOf(docker), "gateway")).toContain("      # shared-folders:begin");
  });

  test("share, list and unshare, from the host, recreating the collector each time", () => {
    const docker = dockerGateway("share-cli");
    const vault = join(docker.home, "Documents", "field-notes");
    mkdirSync(vault, { recursive: true });
    const compose = join(docker.dockerDir, "docker-compose.yml");
    writeFileSync(dockerLog(docker.home), "");

    const shared = host(docker, docker.launcher, ["folders", "share", "~/Documents/field-notes/"]);
    expect(shared.status, shared.stderr).toBe(0);
    expect(shared.stdout).toContain(`Shared ${vault} with the collector, read-only`);
    expect(read(join(docker.dockerDir, "shared-folders"))).toBe(`${vault}\n`);
    expect(serviceBlock(read(compose), "collector")).toContain(
      `      # shared-folders:begin\n      - '${vault}:${vault}:ro'\n      # shared-folders:end`,
    );
    expect(read(dockerLog(docker.home))).toContain(
      `compose -f ${compose} up -d --no-deps collector`,
    );

    // A folder inside one already shared is visible as it is.
    mkdirSync(join(vault, "Research"));
    const inner = host(docker, docker.launcher, ["folders", "share", join(vault, "Research")]);
    expect(inner.status).toBe(0);
    expect(inner.stdout).toContain("is already shared");
    expect(read(join(docker.dockerDir, "shared-folders"))).toBe(`${vault}\n`);

    expect(host(docker, docker.launcher, ["folders"]).stdout).toBe(`${vault}\n`);

    const removed = host(docker, docker.launcher, ["folders", "unshare", vault]);
    expect(removed.status, removed.stderr).toBe(0);
    expect(read(join(docker.dockerDir, "shared-folders"))).toBe("");
    expect(read(compose)).not.toContain(`'${vault}:`);
  });

  test.each([
    [
      "a folder that does not exist",
      (home) => join(home, "nowhere"),
      "does not exist on this machine",
    ],
    ["a colon in the path", (home) => join(home, "a:b"), "a compose file cannot mount"],
    ["the whole filesystem", () => "/", "refusing to share the whole filesystem"],
  ])("refuses %s, changing nothing", (_label, pathOf, message) => {
    const docker = dockerGateway("share-refuse");
    const path = pathOf(docker.home);
    if (path.includes(":")) mkdirSync(path, { recursive: true });
    const before = composeOf(docker);
    const proc = host(docker, docker.launcher, ["folders", "share", path]);
    expect(proc.status).toBe(1);
    expect(proc.stderr).toContain(message);
    expect(composeOf(docker)).toBe(before);
  });

  test("an installer re-run, and an update that rewrites nothing, keep every share", () => {
    const docker = dockerGateway("share-rerun");
    const vault = join(docker.home, "Vault");
    mkdirSync(vault);
    expect(host(docker, docker.launcher, ["folders", "share", vault]).status).toBe(0);

    const again = run("share-rerun", QUIET);
    expect(again.status, again.output).toBe(0);
    expect(serviceBlock(composeOf(again), "collector")).toContain(`      - '${vault}:${vault}:ro'`);
  });

  test("a compose file from before shares gets the block where the config directory is mounted", () => {
    const docker = dockerGateway("share-legacy");
    const compose = join(docker.dockerDir, "docker-compose.yml");
    const legacy = read(compose)
      .split("\n")
      .filter(
        (line) =>
          !line.includes("shared-folders") &&
          !line.includes("Host folders shared") &&
          !line.includes("(omnesis folders share)"),
      )
      .join("\n");
    writeFileSync(compose, legacy);
    const vault = join(docker.home, "Vault");
    mkdirSync(vault);

    const proc = host(docker, docker.launcher, ["folders", "share", vault]);
    expect(proc.status, proc.stderr).toBe(0);
    const collector = serviceBlock(read(compose), "collector");
    expect(collector).toContain(
      `      - ${docker.dockerDir}:${docker.dockerDir}\n      # Host folders shared with the collector`,
    );
    expect(collector).toContain(`      - '${vault}:${vault}:ro'`);
    expect(serviceBlock(read(compose), "gateway")).not.toContain(vault);
  });

  test("a sources command tells the CLI where the operator is on this machine", () => {
    const docker = dockerGateway("sources-env");
    writeFileSync(dockerLog(docker.home), "");
    const proc = spawnSync(docker.launcher, ["sources", "list"], {
      cwd: docker.home,
      env: {
        PATH: `${fixturePath("fake-bin")}:/usr/bin:/bin`,
        HOME: docker.home,
        OMNESIS_TEST_DOCKER: dockerLog(docker.home),
        OMNESIS_TEST_CALLS: join(docker.home, "cli-calls.log"),
        OMNESIS_HOST_HOME: "/forged",
      },
      input: "",
      encoding: "utf8",
    });
    expect(proc.status, proc.stderr).toBe(0);
    const call = read(dockerLog(docker.home))
      .split("\n")
      .find((line) => line.includes("sources list"));
    // The working directory as the shell reports it: macOS names a temp
    // directory through /private.
    expect(call).toContain(
      `--env OMNESIS_HOST_HOME=${docker.home} --env OMNESIS_HOST_CWD=${realpathSync(docker.home)}`,
    );
    expect(call).not.toContain("/forged");
    // Without a terminal there is nobody to offer a share to.
    expect(call).not.toContain("OMNESIS_DOCKER_SHARE_REQUEST");
  });

  test.skipIf(!HAS_PTY)(
    "on a terminal, a folder the container cannot see is offered, shared, and the add resumes",
    () => {
      const docker = dockerGateway("share-offer");
      const vault = join(docker.home, "Documents", "field-notes");
      mkdirSync(vault, { recursive: true });
      writeFileSync(dockerLog(docker.home), "");
      writeFileSync(join(docker.home, "cli-calls.log"), "");
      const quote = (word) => `'${word.replaceAll("'", `'\\''`)}'`;
      const command = [
        "env",
        `PATH=${fixturePath("fake-bin")}:/usr/bin:/bin`,
        `HOME=${docker.home}`,
        `OMNESIS_TEST_DOCKER=${dockerLog(docker.home)}`,
        `OMNESIS_TEST_CALLS=${join(docker.home, "cli-calls.log")}`,
        `OMNESIS_TEST_SHARE_PATH=${vault}`,
        docker.launcher,
        "sources",
        "add",
        "obsidian-notes",
      ]
        .map(quote)
        .join(" ");
      const proc = spawnSync("script", ["-qec", command, "/dev/null"], {
        env: { ...process.env, SHELL: "/bin/sh" },
        input: "y\n",
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(proc.status, proc.stdout).toBe(0);
      expect(proc.stdout).toContain(`Share ${vault} with the collector, read-only? [Y/n]`);
      expect(read(join(docker.dockerDir, "shared-folders"))).toBe(`${vault}\n`);
      expect(existsSync(join(docker.dockerDir, "share-request"))).toBe(false);
      const calls = read(join(docker.home, "cli-calls.log")).split("\n").filter(Boolean);
      expect(calls).toEqual([
        "[docker] sources add obsidian-notes",
        `[docker] sources add obsidian-notes ${vault} --device dev-1`,
      ]);
      const log = read(dockerLog(docker.home));
      expect(log).toContain("--env OMNESIS_DOCKER_SHARE_REQUEST=1");
      // The resumed add waits for the recreated collector to reconnect.
      expect(log).toContain("--env OMNESIS_ADD_WAIT_SECONDS=120");
      expect(log.indexOf("up -d --no-deps collector")).toBeLessThan(log.lastIndexOf("sources add"));
    },
  );

  test.skipIf(!HAS_PTY)(
    "declining the offer shares nothing and names the command for later",
    () => {
      const docker = dockerGateway("share-decline");
      const vault = join(docker.home, "Vault");
      mkdirSync(vault);
      const quote = (word) => `'${word.replaceAll("'", `'\\''`)}'`;
      const command = [
        "env",
        `PATH=${fixturePath("fake-bin")}:/usr/bin:/bin`,
        `HOME=${docker.home}`,
        `OMNESIS_TEST_DOCKER=${dockerLog(docker.home)}`,
        `OMNESIS_TEST_CALLS=${join(docker.home, "cli-calls.log")}`,
        `OMNESIS_TEST_SHARE_PATH=${vault}`,
        docker.launcher,
        "sources",
        "add",
        "obsidian-notes",
      ]
        .map(quote)
        .join(" ");
      const proc = spawnSync("script", ["-qec", command, "/dev/null"], {
        env: { ...process.env, SHELL: "/bin/sh" },
        input: "n\n",
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(proc.status).toBe(1);
      expect(proc.stdout).toContain(`omnesis folders share '${vault}'`);
      expect(existsSync(join(docker.dockerDir, "shared-folders"))).toBe(false);
    },
  );
});
