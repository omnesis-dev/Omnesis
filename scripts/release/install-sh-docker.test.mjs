// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Drives the real installer's `--docker` role against a fake `docker`.
 *
 * The seam here is that binary. Every effect the role has on this host goes
 * through it — the pre-flight, the pull, `up -d`, and the CLI itself, which in
 * this mode runs inside a container — so a recorder planted as `docker` sees
 * the whole run, and the CLI calls it makes land in the same log the other
 * installer suites read.
 *
 * Nothing is built and no container is started: what the role produces on this
 * host is a compose file, an image tag, a marker naming how this install runs,
 * and a wrapper — and those four artifacts are what these tests read.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  HAS_REAL_OPENSSL,
  callStartingWith,
  createFixture,
  destroyFixture,
  fixturePath,
  HAS_PTY,
  installUnresolvableLocalNames,
  installer,
  mintCert,
  plantGatewayCert,
  prepareHome,
  repoRoot,
  runInstaller as runInstallerRaw,
  runInstallerOnTty as runInstallerOnTtyRaw,
  writeExecutable,
} from "./installer-harness.mjs";

const GATEWAY_URL = "https://gateway.example.com:7600";
const GATEWAY_FP = "b".repeat(64);
const PAIRING_CODE = "R4TN8W2QJ6";

/**
 * The `docker` a Docker-role run sees. It records every invocation, answers
 * the pre-flight, and — when a compose command ends in `omnesis <args>` —
 * stands in for the CLI, appending those arguments to the same call log the
 * other suites assert against.
 */
const DOCKER_SHIM = `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$OMNESIS_TEST_DOCKER"
case "$1" in
  info) [ -z "\${OMNESIS_TEST_DOCKER_ROOT:-}" ] || printf '%s\\n' "$OMNESIS_TEST_DOCKER_ROOT"; exit 0 ;;
  context) printf 'unix:///var/run/docker.sock\\n'; exit 0 ;;
  manifest)
    case "\${OMNESIS_TEST_MANIFEST_MODE:-success}" in
      success) exit 0 ;;
      auth) echo 'unauthorized: authentication required' >&2; exit 1 ;;
      network) echo "\${OMNESIS_TEST_MANIFEST_ERROR:-dial tcp: connection refused}" >&2; exit 1 ;;
      missing) echo 'manifest unknown: manifest unknown' >&2; exit 1 ;;
      unsupported) echo 'docker: manifest inspect is not supported' >&2; exit 1 ;;
    esac ;;
  compose)
    if [ "$2" = version ]; then
      [ -z "\${OMNESIS_TEST_COMPOSE_VERSION:-}" ] || printf '%s\\n' "$OMNESIS_TEST_COMPOSE_VERSION"
      exit 0
    fi ;;
  run)
    # The gateway image's runtime, stood in for by this host's node — the real
    # one, when a test has hidden it from the installer.
    while [ "$#" -gt 0 ]; do
      if [ "$1" = -e ]; then shift; exec "\${OMNESIS_TEST_REAL_NODE:-node}" -e "$@"; fi
      shift
    done
    exit 0 ;;
  *) exit 0 ;;
esac

# Everything after the literal word \`omnesis\` is a CLI invocation. The compose
# file path also contains "omnesis", but as one path component of one argument,
# so an exact word match cannot confuse the two.
SEEN=0
CLI_ARGS=""
for ARG in "$@"; do
  if [ "$SEEN" = 1 ]; then CLI_ARGS="$CLI_ARGS $ARG"; continue; fi
  if [ "$ARG" = omnesis ]; then SEEN=1; fi
done

if [ "$SEEN" = 1 ]; then
  printf '%s\\n' "\${CLI_ARGS# }" >> "$OMNESIS_TEST_CALLS"
  # shellcheck disable=SC2086
  set -- $CLI_ARGS
  case "$1" in
    --version) echo "9.9.0" ;;
    model)
      if [ "$2" = catalog ]; then
        printf '{"default":"fast-embed","assignedId":"%s","entries":[{"id":"fast-embed","name":"Fast embed","sizeBytes":140000000,"embedDim":768},{"id":"wide-embed","name":"Wide embed","sizeBytes":600000000,"embedDim":1024}]}\\n' "\${OMNESIS_TEST_ASSIGNED_EMBEDDER:-}"
      fi
      ;;
    pair)
      if [ -t 0 ]; then printf 'pair stdin is a tty\n' >> "$OMNESIS_TEST_CALLS"; fi
      if [ -n "\${OMNESIS_TEST_PAIR_FAIL:-}" ]; then
        # The value is the exit status, so a test can drive the CLI's real
        # EXIT_GATEWAY_DOWN (64) and not only a generic refusal. "1" keeps its
        # existing meaning: a code the gateway saw and rejected.
        if [ "\${OMNESIS_TEST_PAIR_FAIL}" = 64 ]; then
          echo "Cannot reach the gateway. Check that it is running, and that its port is reachable from here." >&2
          exit 64
        fi
        echo "Invalid or expired pairing code." >&2
        exit 1
      fi
      # What the real command prints on success, bold name and all.
      printf 'Paired as \\033[1m%s\\033[0m (collector) id=0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a\\r\\n' "\${OMNESIS_TEST_PAIRED_NAME:-studio-northstar}"
      ;;
    *) : ;;
  esac
  exit 0
fi

for ARG in "$@"; do
  case "$ARG" in
    config)
      if [ -n "\${OMNESIS_TEST_OLD_SERVICES:-}" ]; then
        printf '%s\\n' "$OMNESIS_TEST_OLD_SERVICES"
      else
        awk '/^  [a-z-]+:/ { sub(/:$/, "", $1); print $1 }' "$3"
      fi
      exit 0 ;;
    pull)
      if [ -n "\${OMNESIS_TEST_PULL_FAIL:-}" ]; then
        [ -z "\${OMNESIS_TEST_PULL_ERROR:-}" ] || printf '%s\\n' "$OMNESIS_TEST_PULL_ERROR" >&2
        exit 1
      fi ;;
  esac
done
exit 0
`;

/** A CLI shim the Docker role never reaches — no npm install happens here. */
const UNUSED_CLI_SHIM = "#!/bin/sh\nexit 1\n";

const REGISTRY_CURL_SHIM = `#!/bin/sh
OUT=""
HEADERS=""
AUTH=""
URL=""
MAX_FILESIZE=""
FORMAT=""
printf '%s\\n' "$*" >> "$OMNESIS_TEST_CURL_LOG"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -D|-o|-w|-H|--max-time|--max-filesize|--data-urlencode)
      [ "$1" = -D ] && HEADERS="$2"
      [ "$1" = -o ] && OUT="$2"
      [ "$1" = -w ] && FORMAT="$2"
      [ "$1" = -H ] && AUTH="$2"
      [ "$1" = --max-filesize ] && MAX_FILESIZE="$2"
      shift 2 ;;
    --config)
      AUTH="$(sed -n 's/^header = "\\(.*\\)"$/\\1/p' "$2")"
      shift 2 ;;
    -*) shift ;;
    *) URL="$1"; shift ;;
  esac
done
case "$URL" in
  */token)
    [ "\${OMNESIS_TEST_REGISTRY_MODE:-challenge}" = token-fail ] && exit 7
    if [ "\${OMNESIS_TEST_OVERSIZE:-}" = token ] && [ -n "$MAX_FILESIZE" ]; then exit 63; fi
    if [ "\${OMNESIS_TEST_REGISTRY_MODE:-challenge}" = token-auth ]; then
      : > "$OUT"
      [ -z "$FORMAT" ] || printf 403
      exit 0
    fi
    if [ "\${OMNESIS_TEST_TOKEN_FIELD:-token}" = access_token ]; then
      TOKEN_BODY='{"access_token":"fixture-token"}'
    else
      TOKEN_BODY='{"token":"fixture-token"}'
    fi
    if [ -n "$OUT" ]; then printf '%s\\n' "$TOKEN_BODY" > "$OUT"; else printf '%s\\n' "$TOKEN_BODY"; fi
    [ -z "$FORMAT" ] || printf 200
    exit 0 ;;
  */v2/*/tags/list*)
    [ "\${OMNESIS_TEST_REGISTRY_MODE:-challenge}" = fail ] && exit 7
    [ "\${OMNESIS_TEST_OVERSIZE:-}" = tags ] && [ -n "$MAX_FILESIZE" ] && exit 63
    if [ "\${OMNESIS_TEST_REGISTRY_MODE:-challenge}" = direct-auth ]; then
      printf 'HTTP/1.1 403 Forbidden\\r\\n\\r\\n' > "$HEADERS"
      : > "$OUT"
      printf 403
      exit 0
    fi
    if [ "\${OMNESIS_TEST_REGISTRY_MODE:-challenge}" = direct-unauthorized ]; then
      printf 'HTTP/1.1 401 Unauthorized\\r\\n\\r\\n' > "$HEADERS"
      : > "$OUT"
      printf 401
      exit 0
    fi
    case "\${OMNESIS_TEST_REGISTRY_MODE:-challenge}" in
      challenge|authenticated-auth|token-auth|token-fail) NEED_CHALLENGE=1 ;;
      *) NEED_CHALLENGE=0 ;;
    esac
    if [ "$NEED_CHALLENGE" = 1 ] && [ "$AUTH" != "Authorization: Bearer fixture-token" ]; then
      TOKEN_REALM="\${OMNESIS_TEST_TOKEN_REALM:-https://auth.example.test/token}"
      SECOND_CHALLENGE=""
      [ -z "\${OMNESIS_TEST_SECOND_CHALLENGE:-}" ] || SECOND_CHALLENGE=', Basic realm="https://login.example.test/"'
      printf 'HTTP/1.1 401 Unauthorized\\r\\nWWW-Authenticate: Bearer realm="%s",service="registry.example.test"%s\\r\\n\\r\\n' "$TOKEN_REALM" "$SECOND_CHALLENGE" > "$HEADERS"
      : > "$OUT"
      printf 401
      exit 0
    fi
    if [ "\${OMNESIS_TEST_REGISTRY_MODE:-challenge}" = authenticated-auth ]; then
      printf 'HTTP/1.1 401 Unauthorized\\r\\n\\r\\n' > "$HEADERS"
      : > "$OUT"
      printf 401
      exit 0
    fi
    TAGS="$OMNESIS_TEST_REGISTRY_TAGS"
    case "$URL" in
      */omnesis-gateway/tags/list*) [ -z "\${OMNESIS_TEST_GATEWAY_TAGS:-}" ] || TAGS="$OMNESIS_TEST_GATEWAY_TAGS" ;;
      */omnesis-collector/tags/list*) [ -z "\${OMNESIS_TEST_COLLECTOR_TAGS:-}" ] || TAGS="$OMNESIS_TEST_COLLECTOR_TAGS" ;;
      */omnesis-updater/tags/list*) [ -z "\${OMNESIS_TEST_UPDATER_TAGS:-}" ] || TAGS="$OMNESIS_TEST_UPDATER_TAGS" ;;
    esac
    LINK=""
    case "$URL" in
      */omnesis-gateway/tags/list*last=*) TAGS="$OMNESIS_TEST_REGISTRY_TAGS_PAGE_2" ;;
      */omnesis-gateway/tags/list*) LINK="\${OMNESIS_TEST_REGISTRY_LINK:-}" ;;
    esac
    if [ -n "\${OMNESIS_TEST_ENDLESS_PAGES:-}" ]; then
      PAGE="$(grep -c 'omnesis-gateway/tags/list' "$OMNESIS_TEST_CURL_LOG")"
      LINK="/v2/omnesis-dev/omnesis-gateway/tags/list?n=1000&last=$PAGE"
    fi
    if [ -n "$LINK" ]; then
      if [ "\${OMNESIS_TEST_LINK_REL:-quoted}" = unquoted ]; then
        printf 'HTTP/1.1 200 OK\\r\\nLink: <%s>; rel=next\\r\\n\\r\\n' "$LINK" > "$HEADERS"
      elif [ "\${OMNESIS_TEST_LINK_REL:-quoted}" = invalid ]; then
        printf 'HTTP/1.1 200 OK\\r\\nLink: <%s>; rel=previous\\r\\n\\r\\n' "$LINK" > "$HEADERS"
      else
        printf 'HTTP/1.1 200 OK\\r\\nLink: <%s>; rel="next"\\r\\n\\r\\n' "$LINK" > "$HEADERS"
      fi
    else
      printf 'HTTP/1.1 200 OK\\r\\n\\r\\n' > "$HEADERS"
    fi
    printf '%s\\n' "$TAGS" > "$OUT"
    printf 200
    exit 0 ;;
  *) exit "\${OMNESIS_TEST_CURL_EXIT:-0}" ;;
esac
`;

/** Where this suite's fake `docker` writes what it was asked to do. */
function dockerLog(home) {
  return join(home, "docker-calls.log");
}

function withDockerEnv(home, extra) {
  return { OMNESIS_TEST_DOCKER: dockerLog(home), ...extra };
}

function readDockerCalls(home) {
  const path = dockerLog(home);
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

/**
 * A single run of the Docker role. The home is prepared first so the fake
 * `docker` has a log to append to before the installer starts.
 */
function runInstaller(name, args, extraEnv = {}) {
  const home = prepareHome(name);
  const run = runInstallerRaw(name, args, withDockerEnv(home, extraEnv));
  return { ...run, docker: readDockerCalls(run.home) };
}

function runInstallerOnTty(name, args, answers, extraEnv = {}) {
  const home = prepareHome(name);
  const run = runInstallerOnTtyRaw(name, args, answers, withDockerEnv(home, extraEnv));
  return { ...run, docker: readDockerCalls(run.home) };
}

const composeAt = (run) => readFileSync(join(run.configDir, "docker-compose.yml"), "utf8");

beforeEach(() => {
  createFixture({ name: "docker", versions: ["9.9.0"], cliShim: UNUSED_CLI_SHIM });
  writeExecutable(fixturePath("fake-bin", "docker"), DOCKER_SHIM);
});

afterEach(destroyFixture);

/** The flags every non-interactive Docker run here shares. */
const QUIET = ["--docker", "--no-model", "--no-keyring", "--version", "9.9.0"];

describe("install.sh --docker: what it puts on this host", () => {
  test.each(["--combined", "--gateway-only"])(
    "%s removes only the prior separate collector",
    (flag) => {
      const name = `transition-${flag}`;
      const home = prepareHome(name);
      const configDir = join(home, ".config", "omnesis");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "docker-compose.yml"),
        "name: old-project\nservices:\n  gateway: {}\n  collector: {}\n",
      );
      const run = runInstaller(name, [...QUIET, flag], {
        OMNESIS_TEST_OLD_SERVICES: "gateway\ncollector",
      });
      expect(run.status).toBe(0);
      expect(run.docker.filter((call) => / (stop|rm) /.test(call))).toEqual([
        `docker compose -f ${configDir}/docker-compose.yml stop -t 90 collector`,
        `docker compose -f ${configDir}/docker-compose.yml rm -f collector`,
      ]);
      expect(parseYaml(composeAt(run)).services.collector).toBeUndefined();
    },
  );

  test("refuses to change a collector-only config into a gateway", () => {
    const home = prepareHome("refuse-role-move");
    const configDir = join(home, ".config", "omnesis");
    mkdirSync(configDir, { recursive: true });
    const previous = "services:\n  collector: {}\n";
    writeFileSync(join(configDir, "docker-compose.yml"), previous);
    const run = runInstaller("refuse-role-move", QUIET, { OMNESIS_TEST_OLD_SERVICES: "collector" });
    expect(run.status).toBe(1);
    expect(run.output).toContain("separate OMNESIS_CONFIG_DIR");
    expect(composeAt(run)).toBe(previous);
    expect(run.docker.some((call) => / (stop|rm) /.test(call))).toBe(false);
  });

  test("a root installer keeps daemons unprivileged without recursively changing state", () => {
    writeExecutable(
      fixturePath("fake-bin", "id"),
      '#!/bin/sh\ncase "$1" in -u|-g) echo 0 ;; *) echo root ;; esac\n',
    );
    writeExecutable(
      fixturePath("fake-bin", "chown"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$OMNESIS_TEST_CHOWN"\n',
    );
    const ownershipLog = fixturePath("ownership.log");
    const run = runInstaller("root-install", QUIET, { OMNESIS_TEST_CHOWN: ownershipLog });
    expect(run.status).toBe(0);
    const compose = parseYaml(composeAt(run));
    expect(compose.services.gateway.user).toBe("10001:10001");
    expect(compose.services.collector.user).toBe("10001:10001");
    expect(compose.services.updater.user).toBe("0:0");
    const ownership = readFileSync(ownershipLog, "utf8");
    expect(ownership).toContain(`-h 10001:10001 ${run.configDir}`);
    expect(ownership).not.toMatch(/(^|\s)-[a-zA-Z]*[Rr]/);
  });

  test("a root re-install keeps an existing root project's daemons on root", () => {
    // Earlier root installs ran every service as 0:0, so their databases,
    // token and keys are root's, and the installer never re-owns them.
    writeExecutable(
      fixturePath("fake-bin", "id"),
      '#!/bin/sh\ncase "$1" in -u|-g) echo 0 ;; *) echo root ;; esac\n',
    );
    writeExecutable(
      fixturePath("fake-bin", "chown"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$OMNESIS_TEST_CHOWN"\n',
    );
    const ownershipLog = fixturePath("ownership.log");
    const home = prepareHome("root-reinstall");
    const configDir = join(home, ".config", "omnesis");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "docker-compose.yml"),
      'services:\n  gateway:\n    user: "0:0"\n  collector:\n    user: "0:0"\n  updater:\n    user: "0:0"\n',
    );
    const run = runInstaller("root-reinstall", QUIET, {
      OMNESIS_TEST_CHOWN: ownershipLog,
      OMNESIS_TEST_OLD_SERVICES: "gateway\ncollector\nupdater",
    });
    expect(run.status).toBe(0);
    const compose = parseYaml(composeAt(run));
    expect(compose.services.gateway.user).toBe("0:0");
    expect(compose.services.collector.user).toBe("0:0");
    expect(readFileSync(ownershipLog, "utf8")).not.toContain("10001");

    // A project already on the unprivileged account, beside its root updater, stays there.
    writeFileSync(
      join(configDir, "docker-compose.yml"),
      'services:\n  gateway:\n    user: "10001:10001"\n  collector:\n    user: "10001:10001"\n  updater:\n    user: "0:0"\n',
    );
    const again = runInstaller("root-reinstall", QUIET, {
      OMNESIS_TEST_CHOWN: ownershipLog,
      OMNESIS_TEST_OLD_SERVICES: "gateway\ncollector\nupdater",
    });
    expect(again.status).toBe(0);
    expect(parseYaml(composeAt(again)).services.gateway.user).toBe("10001:10001");
  });

  test("combined topology runs both daemons in the gateway service", () => {
    const run = runInstaller("combined", [...QUIET, "--combined", "--build"]);
    expect(run.status).toBe(0);
    const compose = parseYaml(composeAt(run));
    expect(Object.keys(compose.services)).toEqual(["gateway", "updater"]);
    expect(compose.services.gateway.image).toContain("/omnesis-combined:");
    expect(compose.services.gateway.build.target).toBe("combined-runtime");
    expect(compose.services.gateway.stop_grace_period).toBe("120s");
    expect(compose.services.gateway.environment).toContain(
      "OMNESIS_GATEWAY_URL=https://localhost:7600",
    );
    expect(compose.services.gateway.ports).toContain("127.0.0.1:3000:3000");
    expect(compose.services.updater.environment).toContain(
      "OMNESIS_GATEWAY_URL=https://gateway:7600",
    );
    expect(run.docker.some((call) => / up -d collector$/.test(call))).toBe(false);
  });

  test("gateway-only omits the collector", () => {
    const run = runInstaller("gateway-only", [...QUIET, "--gateway-only"]);
    expect(run.status).toBe(0);
    expect(Object.keys(parseYaml(composeAt(run)).services)).toEqual(["gateway", "updater"]);
    expect(run.docker.some((call) => / up -d collector$/.test(call))).toBe(false);
  });

  test("host networking publishes the configured gateway port directly", () => {
    const run = runInstaller("host-network", [
      ...QUIET,
      "--docker-network",
      "host",
      "--port",
      "17600",
    ]);
    expect(run.status).toBe(0);
    const compose = parseYaml(composeAt(run));
    expect(compose.services.gateway.network_mode).toBe("host");
    expect(compose.services.collector.network_mode).toBe("host");
    for (const service of [compose.services.gateway, compose.services.collector]) {
      expect(service.init).toBe(true);
      expect(service.cap_drop).toEqual(["ALL"]);
      expect(service.security_opt).toEqual(["no-new-privileges:true"]);
    }
    expect(compose.services.updater.network_mode).toBe("host");
    expect(compose.services.gateway.ports).toBeUndefined();
    expect(compose.services.collector.ports).toBeUndefined();
    expect(compose.services.gateway.environment).toContain("OMNESIS_GATEWAY_PORT=17600");
    expect(compose.services.gateway.environment).toContain("OMNESIS_OAUTH_CALLBACK_HOST=127.0.0.1");
    expect(compose.services.collector.environment).toContain(
      "OMNESIS_OAUTH_CALLBACK_HOST=127.0.0.1",
    );
    expect(compose.services.collector.environment).toContain(
      "OMNESIS_GATEWAY_URL=https://localhost:17600",
    );
    expect(compose.services.gateway.healthcheck.test.at(-1)).toBe("https://localhost:17600/health");
  });

  test.skipIf(!HAS_PTY)("never offers native Codex or Claude Code setup", () => {
    writeExecutable(fixturePath("fake-bin", "codex"), "#!/bin/sh\nexit 0\n");
    writeExecutable(fixturePath("fake-bin", "claude"), "#!/bin/sh\nexit 0\n");
    const run = runInstallerOnTty("docker-codex", QUIET, []);

    expect(run.status).toBe(0);
    expect(run.output).not.toContain(["Set up the agent with Codex", "Luna"].join(" "));
    expect(run.output).not.toContain(["Set up the agent with Claude", "Code"].join(" "));
  });

  test("a gateway that never becomes healthy fails the install and shows its compose log", () => {
    const run = runInstaller("stack-unhealthy", QUIET, {
      OMNESIS_TEST_CURL_EXIT: "7",
      OMNESIS_GATEWAY_WAIT_SECONDS: "1",
    });
    expect(run.status).toBe(1);
    expect(run.docker.some((call) => / compose .* logs .*gateway$/.test(call))).toBe(true);
    expect(run.output).toContain("The gateway is not running, so Omnesis is not ready.");
    expect(run.output).not.toContain("Omnesis is running in Docker.");
  });

  test("writes a compose file, the image tag, a marker and a wrapper", () => {
    const run = runInstaller("stack", QUIET);
    expect(run.status).toBe(0);

    const compose = composeAt(run);
    expect(compose).toContain('image: "ghcr.io/omnesis-dev/omnesis-gateway:${OMNESIS_IMAGE_TAG}"');
    expect(compose).toContain(
      'image: "ghcr.io/omnesis-dev/omnesis-collector:${OMNESIS_IMAGE_TAG}"',
    );
    expect(compose).toContain('image: "ghcr.io/omnesis-dev/omnesis-updater:${OMNESIS_IMAGE_TAG}"');
    // The config directory is mounted at the path it already has, so a path
    // this run records means one thing on both sides of the boundary.
    expect(compose).toContain(`- ${run.configDir}:${run.configDir}`);
    expect(compose).toContain(`- OMNESIS_CONFIG_DIR=${run.configDir}`);
    // A provider redirects a browser at these, so they stay published.
    for (const port of ["3000:3000", "3001:3001", "3002:3002", "3003:3003"]) {
      expect(compose).toContain(`- "127.0.0.1:${port}"`);
    }
    // The socket is the updater's alone, and the updater never starts with the
    // rest of the stack.
    expect(compose).toContain('profiles: ["update"]');
    expect(compose).toContain("- /var/run/docker.sock:/var/run/docker.sock");
    expect(compose.slice(0, compose.indexOf("  updater:"))).not.toContain("docker.sock");

    expect(run.envFile()).toContain("OMNESIS_IMAGE_TAG=9.9.0");
    expect(readFileSync(join(run.configDir, "install-method"), "utf8").trim()).toBe("docker");
  });

  test("the collector shares the gateway's config directory, as it does natively", () => {
    // That is where the bootstrap token it self-pairs with, the certificate it
    // verifies and the keyring wiring all are; a directory of its own would
    // leave it with none of them.
    const run = runInstaller("shared-config", QUIET);
    expect(run.status).toBe(0);
    const collector = composeAt(run).slice(
      composeAt(run).indexOf("  collector:"),
      composeAt(run).indexOf("  updater:"),
    );
    expect(collector).toContain(`- OMNESIS_CONFIG_DIR=${run.configDir}\n`);
    expect(collector).toContain(`- ${run.configDir}:${run.configDir}`);
    expect(collector).not.toContain(`${run.configDir}/collector`);
  });

  test("the wrapper runs the CLI in the container, and the update beside it", () => {
    const run = runInstaller("wrapper", QUIET);
    expect(run.status).toBe(0);
    const wrapper = readFileSync(run.wrapper, "utf8");
    const composeFile = join(run.configDir, "docker-compose.yml");

    expect(wrapper).toContain(`COMPOSE_FILE='${composeFile}'`);
    expect(wrapper).toContain("SERVICE='gateway'");
    // Commands run in the live container when there is one...
    expect(wrapper).toContain('exec docker compose -f "$COMPOSE_FILE" exec $TTY_FLAG "$@"');
    // ...and in a throwaway one when there is not.
    expect(wrapper).toContain(
      'exec docker compose -f "$COMPOSE_FILE" run --rm --no-deps $TTY_FLAG "$@"',
    );
    // `update` moves the containers themselves, so it is the one command that
    // runs beside them rather than inside one.
    expect(wrapper).toContain('if [ "${1:-}" = update ]; then UPDATE=1; fi');
    expect(wrapper).toContain('--profile update run --rm --no-deps $TTY_FLAG "$@"');
    // The container's own paths, URL and port never come from the host's
    // environment.
    expect(wrapper).toContain("OMNESIS_CONFIG_DIR|OMNESIS_GATEWAY_URL|OMNESIS_GATEWAY_PORT");
  });

  test("pulls the tag it resolved, then starts the gateway before the collector", () => {
    const run = runInstaller("order", QUIET);
    expect(run.status).toBe(0);
    const pull = run.docker.findIndex((call) => call.includes(" pull"));
    const gateway = run.docker.findIndex((call) => call.includes("up -d gateway"));
    const collector = run.docker.findIndex((call) => call.includes("up -d collector"));
    expect(pull).toBeGreaterThanOrEqual(0);
    expect(gateway).toBeGreaterThan(pull);
    expect(collector).toBeGreaterThan(gateway);
  });

  test("registers no service and installs nothing on this host", () => {
    const run = runInstaller("no-host-install", QUIET);
    expect(run.status).toBe(0);
    expect(run.calls.some((call) => call.startsWith("service install"))).toBe(false);
    expect(run.docker.some((call) => call.includes("--profile update pull"))).toBe(true);
  });

  test("with no version named, the highest stable registry tag decides the tag", () => {
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    const log = fixturePath("registry-curl.log");
    writeFileSync(log, "");
    const run = runInstaller("resolve-tag", ["--docker", "--no-model", "--no-keyring"], {
      OMNESIS_TEST_CURL_LOG: log,
      OMNESIS_TEST_REGISTRY_TAGS:
        '{"name":"omnesis-dev/omnesis-gateway","tags":["7.3.1","main","10.2.0","10.10.0","10.10","11.0.0-beta.1","01.0.0","sha-deadbeef"]}',
    });
    expect(run.status).toBe(0);
    expect(run.envFile()).toContain("OMNESIS_IMAGE_TAG=10.10.0");
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("https://ghcr.io/v2/omnesis-dev/omnesis-gateway/tags/list?n=1000");
    expect(calls).toContain("scope=repository:omnesis-dev/omnesis-gateway:pull");
    expect(calls).toContain("scope=repository:omnesis-dev/omnesis-collector:pull");
    expect(calls).toContain("scope=repository:omnesis-dev/omnesis-updater:pull");
    expect(run.output).not.toContain("fixture-token");
  });

  test("chooses the highest stable tag shared by every image in the stack", () => {
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    const log = fixturePath("complete-release-curl.log");
    writeFileSync(log, "");
    const run = runInstaller("complete-release", ["--docker", "--no-model", "--no-keyring"], {
      OMNESIS_TEST_CURL_LOG: log,
      OMNESIS_TEST_REGISTRY_MODE: "direct",
      OMNESIS_TEST_REGISTRY_TAGS: '{"tags":["3.0.0","3.1.0"]}',
      OMNESIS_TEST_UPDATER_TAGS: '{"tags":["3.0.0"]}',
    });
    expect(run.status).toBe(0);
    expect(run.envFile()).toContain("OMNESIS_IMAGE_TAG=3.0.0");
  });

  test.each([
    ["relative", "/v2/omnesis-dev/omnesis-gateway/tags/list?n=1000&last=4.0.0", "quoted"],
    [
      "absolute",
      "https://ghcr.io/v2/omnesis-dev/omnesis-gateway/tags/list?n=1000&last=4.0.0",
      "unquoted",
    ],
  ])("follows a %s same-origin pagination link", (name, link, relation) => {
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    const log = fixturePath(`${name}-pagination-curl.log`);
    writeFileSync(log, "");
    const run = runInstaller(`${name}-pagination`, ["--docker", "--no-model", "--no-keyring"], {
      OMNESIS_TEST_CURL_LOG: log,
      OMNESIS_TEST_REGISTRY_MODE: "direct",
      OMNESIS_TEST_REGISTRY_TAGS: '{"tags":["4.0.0"]}',
      OMNESIS_TEST_COLLECTOR_TAGS: '{"tags":["4.0.0","4.2.0"]}',
      OMNESIS_TEST_UPDATER_TAGS: '{"tags":["4.0.0","4.2.0"]}',
      OMNESIS_TEST_REGISTRY_TAGS_PAGE_2: '{"tags":["4.2.0"]}',
      OMNESIS_TEST_REGISTRY_LINK: link,
      OMNESIS_TEST_LINK_REL: relation,
    });
    expect(run.status).toBe(0);
    expect(run.envFile()).toContain("OMNESIS_IMAGE_TAG=4.2.0");
    expect(readFileSync(log, "utf8")).toContain(
      "https://ghcr.io/v2/omnesis-dev/omnesis-gateway/tags/list?n=1000&last=4.0.0",
    );
  });

  test.each([
    ["off-origin", "https://other.example.test/v2/omnesis-dev/omnesis-gateway/tags/list?n=1000"],
    ["repeated", "/v2/omnesis-dev/omnesis-gateway/tags/list?n=1000"],
  ])("rejects a %s pagination link", (name, link) => {
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    const log = fixturePath(`${name}-pagination-curl.log`);
    writeFileSync(log, "");
    const run = runInstaller(`${name}-pagination`, ["--docker", "--no-model", "--no-keyring"], {
      OMNESIS_TEST_CURL_LOG: log,
      OMNESIS_TEST_REGISTRY_MODE: "direct",
      OMNESIS_TEST_REGISTRY_TAGS: '{"tags":["4.0.0"]}',
      OMNESIS_TEST_REGISTRY_LINK: link,
    });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("--version X.Y.Z");
    expect(existsSync(join(run.configDir, "docker-compose.yml"))).toBe(false);
    expect(readFileSync(log, "utf8")).not.toContain("other.example.test/v2");
  });

  test("rejects a Link header that is not a next-page relation", () => {
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    const log = fixturePath("invalid-relation-curl.log");
    writeFileSync(log, "");
    const run = runInstaller("invalid-relation", ["--docker", "--no-model", "--no-keyring"], {
      OMNESIS_TEST_CURL_LOG: log,
      OMNESIS_TEST_REGISTRY_MODE: "direct",
      OMNESIS_TEST_REGISTRY_TAGS: '{"tags":["4.0.0"]}',
      OMNESIS_TEST_REGISTRY_LINK: "/v2/omnesis-dev/omnesis-gateway/tags/list?n=1000&last=4.0.0",
      OMNESIS_TEST_LINK_REL: "invalid",
    });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("--version X.Y.Z");
  });

  test("stops a registry that never ends pagination", () => {
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    const log = fixturePath("endless-pagination-curl.log");
    writeFileSync(log, "");
    const run = runInstaller("endless-pagination", ["--docker", "--no-model", "--no-keyring"], {
      OMNESIS_TEST_CURL_LOG: log,
      OMNESIS_TEST_REGISTRY_MODE: "direct",
      OMNESIS_TEST_REGISTRY_TAGS: '{"tags":["4.0.0"]}',
      OMNESIS_TEST_REGISTRY_TAGS_PAGE_2: '{"tags":["4.0.0"]}',
      OMNESIS_TEST_REGISTRY_LINK: "start",
      OMNESIS_TEST_ENDLESS_PAGES: "1",
    });
    expect(run.status).not.toBe(0);
    const registryCalls = readFileSync(log, "utf8")
      .split("\n")
      .filter((call) => call.includes("omnesis-gateway/tags/list"));
    expect(registryCalls).toHaveLength(10);
    expect(run.output).toContain("--version X.Y.Z");
  });

  test("a custom image repository drives both discovery and image references", () => {
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    const log = fixturePath("custom-registry-curl.log");
    writeFileSync(log, "");
    const run = runInstaller("custom-registry", ["--docker", "--no-model", "--no-keyring"], {
      OMNESIS_IMAGE_REPO: "registry.example.test/team/releases",
      OMNESIS_TEST_CURL_LOG: log,
      OMNESIS_TEST_REGISTRY_MODE: "direct",
      OMNESIS_TEST_REGISTRY_TAGS: '{"tags":["2.4.0","2.11.0"]}',
    });
    expect(run.status).toBe(0);
    expect(readFileSync(log, "utf8")).toContain(
      "https://registry.example.test/v2/team/releases/omnesis-gateway/tags/list?n=1000",
    );
    expect(composeAt(run)).toContain(
      'image: "registry.example.test/team/releases/omnesis-gateway:${OMNESIS_IMAGE_TAG}"',
    );
    expect(run.envFile()).toContain("OMNESIS_IMAGE_TAG=2.11.0");
  });

  test.each([
    ["userinfo", "localhost:5000@registry.example.test/team"],
    ["malformed IPv6", "[::1:5000/team"],
    ["unbracketed IPv6", "2001:db8::1/team"],
    ["nonnumeric port", "registry.example.test:https/team"],
    ["bracketed non-IPv6 host", "[deadbeef]/team"],
  ])("rejects an image repository with %s before contacting it", (_name, repository) => {
    const run = runInstaller("invalid-image-repository", QUIET, {
      OMNESIS_IMAGE_REPO: repository,
    });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("Invalid image repository");
    expect(run.docker.some((call) => call.startsWith("docker manifest"))).toBe(false);
    expect(run.docker.some((call) => call.includes(" pull"))).toBe(false);
    expect(existsSync(join(run.configDir, "docker-compose.yml"))).toBe(false);
  });

  test("a shorthand repository resolves through registry-1.docker.io", () => {
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    const log = fixturePath("docker-hub-curl.log");
    writeFileSync(log, "");
    const run = runInstaller("docker-hub", ["--docker", "--no-model", "--no-keyring"], {
      OMNESIS_IMAGE_REPO: "example-team/releases",
      OMNESIS_TEST_CURL_LOG: log,
      OMNESIS_TEST_REGISTRY_MODE: "direct",
      OMNESIS_TEST_REGISTRY_TAGS: '{"tags":["2.12.0"]}',
    });
    expect(run.status).toBe(0);
    expect(readFileSync(log, "utf8")).toContain(
      "https://registry-1.docker.io/v2/example-team/releases/omnesis-gateway/tags/list?n=1000",
    );
    expect(composeAt(run)).toContain(
      'image: "example-team/releases/omnesis-gateway:${OMNESIS_IMAGE_TAG}"',
    );
  });

  test("shorthand registry authentication uses Docker's default login target", () => {
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    const log = fixturePath("docker-hub-auth-curl.log");
    writeFileSync(log, "");
    const run = runInstaller("docker-hub-auth", ["--docker", "--no-model", "--no-keyring"], {
      OMNESIS_IMAGE_REPO: "example-team/releases",
      OMNESIS_TEST_CURL_LOG: log,
      OMNESIS_TEST_REGISTRY_MODE: "direct-auth",
      OMNESIS_TEST_REGISTRY_TAGS: '{"tags":["9.9.0"]}',
    });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("  docker login\n");
    expect(run.output).not.toContain("docker login docker.io");
  });

  test("an explicit registry API hostname remains the login target", () => {
    const run = runInstaller("docker-hub-api-auth", QUIET, {
      OMNESIS_IMAGE_REPO: "registry-1.docker.io/example-team/releases",
      OMNESIS_TEST_MANIFEST_MODE: "auth",
    });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("docker login registry-1.docker.io");
  });

  test("an explicit docker.io prefix resolves the implicit library namespace", () => {
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    const log = fixturePath("docker-hub-library-curl.log");
    writeFileSync(log, "");
    const run = runInstaller("docker-hub-library", ["--docker", "--no-model", "--no-keyring"], {
      OMNESIS_IMAGE_REPO: "docker.io",
      OMNESIS_TEST_CURL_LOG: log,
      OMNESIS_TEST_REGISTRY_MODE: "direct",
      OMNESIS_TEST_REGISTRY_TAGS: '{"tags":["2.12.0"]}',
    });
    expect(run.status).toBe(0);
    expect(readFileSync(log, "utf8")).toContain(
      "https://registry-1.docker.io/v2/library/omnesis-gateway/tags/list?n=1000",
    );
    expect(composeAt(run)).toContain('image: "docker.io/omnesis-gateway:${OMNESIS_IMAGE_TAG}"');
  });

  test("a host-only custom registry resolves root-level image repositories", () => {
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    const log = fixturePath("root-registry-curl.log");
    writeFileSync(log, "");
    const run = runInstaller("root-registry", ["--docker", "--no-model", "--no-keyring"], {
      OMNESIS_IMAGE_REPO: "registry.example.test",
      OMNESIS_TEST_CURL_LOG: log,
      OMNESIS_TEST_REGISTRY_MODE: "direct",
      OMNESIS_TEST_REGISTRY_TAGS: '{"tags":["2.12.0"]}',
    });
    expect(run.status).toBe(0);
    expect(readFileSync(log, "utf8")).toContain(
      "https://registry.example.test/v2/omnesis-gateway/tags/list?n=1000",
    );
    expect(composeAt(run)).toContain(
      'image: "registry.example.test/omnesis-gateway:${OMNESIS_IMAGE_TAG}"',
    );
  });

  test("IPv6 loopback supports an HTTP bearer realm and access_token response", () => {
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    const log = fixturePath("ipv6-registry-curl.log");
    writeFileSync(log, "");
    const run = runInstaller("ipv6-registry", ["--docker", "--no-model", "--no-keyring"], {
      OMNESIS_IMAGE_REPO: "[::1]:5000",
      OMNESIS_TEST_CURL_LOG: log,
      OMNESIS_TEST_REGISTRY_TAGS: '{"tags":["2.12.0"]}',
      OMNESIS_TEST_TOKEN_FIELD: "access_token",
      OMNESIS_TEST_TOKEN_REALM: "http://[::1]:5001/token",
    });
    expect(run.status).toBe(0);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("http://[::1]:5000/v2/omnesis-gateway/tags/list?n=1000");
    expect(calls).toContain("http://[::1]:5001/token");
    expect(calls).not.toContain("fixture-token");
    const compose = parseYaml(composeAt(run));
    expect(compose.services.gateway.image).toBe("[::1]:5000/omnesis-gateway:${OMNESIS_IMAGE_TAG}");
    expect(compose.services.collector.image).toBe(
      "[::1]:5000/omnesis-collector:${OMNESIS_IMAGE_TAG}",
    );
  });

  test("a later Basic challenge cannot replace the Bearer realm", () => {
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    const log = fixturePath("combined-challenge-curl.log");
    writeFileSync(log, "");
    const run = runInstaller("combined-challenge", ["--docker", "--no-model", "--no-keyring"], {
      OMNESIS_TEST_CURL_LOG: log,
      OMNESIS_TEST_REGISTRY_TAGS: '{"tags":["2.12.0"]}',
      OMNESIS_TEST_SECOND_CHALLENGE: "1",
    });
    expect(run.status).toBe(0);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("https://auth.example.test/token");
    expect(calls).not.toContain("login.example.test");
    expect(calls).not.toContain("fixture-token");
  });

  test("rejects a remote plain-HTTP bearer realm before requesting a token", () => {
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    const log = fixturePath("plain-http-realm-curl.log");
    writeFileSync(log, "");
    const run = runInstaller("plain-http-realm", ["--docker", "--no-model", "--no-keyring"], {
      OMNESIS_TEST_CURL_LOG: log,
      OMNESIS_TEST_REGISTRY_TAGS: '{"tags":["2.12.0"]}',
      OMNESIS_TEST_TOKEN_REALM: "http://auth.example.test/token",
    });
    expect(run.status).not.toBe(0);
    expect(readFileSync(log, "utf8")).not.toContain("http://auth.example.test/token");
    expect(existsSync(join(run.configDir, "docker-compose.yml"))).toBe(false);
  });

  test("the portable numeric sort fallback still selects semantic version order", () => {
    const systemSort = spawnSync("sh", ["-c", "command -v sort"], {
      encoding: "utf8",
    }).stdout.trim();
    expect(systemSort).not.toBe("");
    writeExecutable(
      fixturePath("fake-bin", "sort"),
      '#!/bin/sh\nif [ "$1" = -V ]; then exit 2; fi\nexec "$OMNESIS_TEST_SYSTEM_SORT" "$@"\n',
    );
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    const log = fixturePath("portable-sort-curl.log");
    writeFileSync(log, "");
    const run = runInstaller("portable-sort", ["--docker", "--no-model", "--no-keyring"], {
      OMNESIS_TEST_CURL_LOG: log,
      OMNESIS_TEST_REGISTRY_MODE: "direct",
      OMNESIS_TEST_REGISTRY_TAGS: '{"tags":["10.2.0","10.10.0"]}',
      OMNESIS_TEST_SYSTEM_SORT: systemSort,
    });
    expect(run.status).toBe(0);
    expect(run.envFile()).toContain("OMNESIS_IMAGE_TAG=10.10.0");
  });

  test.each([
    ["no stable tag", '{"tags":["main","2.0","3.0.0-beta.1"]}'],
    ["malformed JSON", '"999.0.0"'],
  ])("a registry response with %s fails before writing compose state", (name, body) => {
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    const log = fixturePath(`${name.replaceAll(" ", "-")}-curl.log`);
    writeFileSync(log, "");
    const run = runInstaller(
      name.replaceAll(" ", "-"),
      ["--docker", "--no-model", "--no-keyring"],
      {
        OMNESIS_TEST_CURL_LOG: log,
        OMNESIS_TEST_REGISTRY_MODE: "direct",
        OMNESIS_TEST_REGISTRY_TAGS: body,
      },
    );
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("--version X.Y.Z");
    expect(existsSync(join(run.configDir, "docker-compose.yml"))).toBe(false);
  });

  test("ignores semantic versions outside the tags array", () => {
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    const log = fixturePath("scoped-tags-curl.log");
    writeFileSync(log, "");
    const run = runInstaller("scoped-tags", ["--docker", "--no-model", "--no-keyring"], {
      OMNESIS_TEST_CURL_LOG: log,
      OMNESIS_TEST_REGISTRY_MODE: "direct",
      OMNESIS_TEST_REGISTRY_TAGS: '{"errors":["999.0.0"],"tags":["1.0.0"]}',
    });
    expect(run.status).toBe(0);
    expect(run.envFile()).toContain("OMNESIS_IMAGE_TAG=1.0.0");
  });

  test.each(["token", "tags"])("bounds an oversized %s response", (response) => {
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    const log = fixturePath(`oversized-${response}-curl.log`);
    writeFileSync(log, "");
    const run = runInstaller(`oversized-${response}`, ["--docker", "--no-model", "--no-keyring"], {
      OMNESIS_TEST_CURL_LOG: log,
      OMNESIS_TEST_OVERSIZE: response,
      OMNESIS_TEST_REGISTRY_TAGS: '{"tags":["2.12.0"]}',
    });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("--version X.Y.Z");
    expect(run.output).not.toContain("fixture-token");
    expect(existsSync(join(run.configDir, "docker-compose.yml"))).toBe(false);
  });

  test("an unreachable registry stops before anything is written and names the escape", () => {
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    const log = fixturePath("failed-registry-curl.log");
    writeFileSync(log, "");
    const run = runInstaller("resolve-fails", ["--docker", "--no-model", "--no-keyring"], {
      OMNESIS_TEST_CURL_LOG: log,
      OMNESIS_TEST_REGISTRY_MODE: "fail",
      OMNESIS_TEST_REGISTRY_TAGS: '{"tags":[]}',
    });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("Could not resolve the newest release");
    expect(run.output).toContain("--version X.Y.Z");
    expect(run.output).toContain("ghcr.io/omnesis-dev/omnesis-gateway");
    expect(run.output).toContain("network connection");
    expect(run.output).not.toContain("docker login");
    expect(existsSync(join(run.configDir, "docker-compose.yml"))).toBe(false);
  });

  test.each([
    ["the token endpoint", "token-auth"],
    ["the authenticated tag request", "authenticated-auth"],
    ["a direct tag request", "direct-auth"],
    ["a direct unauthorized request", "direct-unauthorized"],
  ])("a registry denial from %s explains private image authentication", (_name, mode) => {
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    const log = fixturePath(`${mode}-curl.log`);
    writeFileSync(log, "");
    const run = runInstaller(`registry-${mode}`, ["--docker", "--no-model", "--no-keyring"], {
      OMNESIS_IMAGE_REPO: "registry.example.test/team/releases",
      OMNESIS_TEST_CURL_LOG: log,
      OMNESIS_TEST_REGISTRY_MODE: mode,
      OMNESIS_TEST_REGISTRY_TAGS: '{"tags":["9.9.0"]}',
    });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("docker login registry.example.test");
    expect(run.output).toContain("permission to read the package");
    expect(run.output).toContain("Never pass the token to this installer");
    expect(run.output).toContain("--version X.Y.Z");
    expect(run.output).not.toContain("fixture-token");
    expect(run.docker.some((call) => call.startsWith("docker login"))).toBe(false);
    expect(existsSync(join(run.configDir, "docker-compose.yml"))).toBe(false);
  });

  test("a token endpoint transport failure remains a network error", () => {
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    const log = fixturePath("token-network-curl.log");
    writeFileSync(log, "");
    const run = runInstaller("token-network", ["--docker", "--no-model", "--no-keyring"], {
      OMNESIS_TEST_CURL_LOG: log,
      OMNESIS_TEST_REGISTRY_MODE: "token-fail",
      OMNESIS_TEST_REGISTRY_TAGS: '{"tags":["9.9.0"]}',
    });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("network connection");
    expect(run.output).not.toContain("docker login");
  });

  test("--version remains exact and bypasses registry discovery", () => {
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    const log = fixturePath("pinned-registry-curl.log");
    writeFileSync(log, "");
    const run = runInstaller("pinned-bypass", QUIET, {
      OMNESIS_TEST_CURL_LOG: log,
      OMNESIS_TEST_REGISTRY_MODE: "fail",
    });
    expect(run.status).toBe(0);
    expect(run.envFile()).toContain("OMNESIS_IMAGE_TAG=9.9.0");
    const calls = readFileSync(log, "utf8");
    expect(calls).not.toContain("/v2/");
    expect(calls).not.toContain("/token");
  });

  test("asks Docker to inspect every pinned image", () => {
    const run = runInstaller("manifest-preflight", QUIET);
    expect(run.status).toBe(0);
    const manifests = run.docker.filter((call) => call.startsWith("docker manifest inspect"));
    expect(manifests).toEqual([
      "docker manifest inspect ghcr.io/omnesis-dev/omnesis-gateway:9.9.0",
      "docker manifest inspect ghcr.io/omnesis-dev/omnesis-collector:9.9.0",
      "docker manifest inspect ghcr.io/omnesis-dev/omnesis-updater:9.9.0",
    ]);
  });

  test("classifies a pinned manifest authentication failure before writing compose state", () => {
    const run = runInstaller("manifest-auth", QUIET, { OMNESIS_TEST_MANIFEST_MODE: "auth" });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("docker login ghcr.io");
    expect(run.output).toContain("authentication required");
    expect(run.output).toContain("re-run the same installer command");
    expect(run.output).not.toContain("--version X.Y.Z");
    expect(existsSync(join(run.configDir, "docker-compose.yml"))).toBe(false);
    expect(run.docker.some((call) => call.includes(" pull"))).toBe(false);
  });

  test.each(["network", "missing"])(
    "lets the daemon's pull decide after a manifest %s failure",
    (mode) => {
      const run = runInstaller(`manifest-${mode}-pull-succeeds`, QUIET, {
        OMNESIS_TEST_MANIFEST_MODE: mode,
      });
      expect(run.status).toBe(0);
      expect(run.output).not.toContain("docker login");
      expect(run.docker.some((call) => call.includes("--profile update pull"))).toBe(true);
    },
  );

  test("keeps a network permission denial out of authentication guidance", () => {
    const run = runInstaller("manifest-network-policy", QUIET, {
      OMNESIS_TEST_MANIFEST_MODE: "network",
      OMNESIS_TEST_MANIFEST_ERROR: "dial tcp 203.0.113.7:443: connect: permission denied",
    });
    expect(run.status).toBe(0);
    expect(run.output).not.toContain("docker login");
    expect(run.docker.some((call) => call.includes("--profile update pull"))).toBe(true);
  });

  test("quotes an IPv6 registry in authentication guidance", () => {
    const run = runInstaller("manifest-ipv6-auth", QUIET, {
      OMNESIS_IMAGE_REPO: "[::1]:5000/team",
      OMNESIS_TEST_MANIFEST_MODE: "auth",
    });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("docker login '[::1]:5000'");
  });

  test("a custom private registry works after login when an exact version is named", () => {
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    const log = fixturePath("private-pinned-curl.log");
    writeFileSync(log, "");
    const run = runInstaller(
      "private-pinned",
      ["--docker", "--no-model", "--no-keyring", "--version", "8.7.6"],
      {
        OMNESIS_IMAGE_REPO: "registry.example.test/team/releases",
        OMNESIS_TEST_CURL_LOG: log,
        OMNESIS_TEST_REGISTRY_MODE: "fail",
      },
    );
    expect(run.status).toBe(0);
    const curlCalls = readFileSync(log, "utf8");
    expect(curlCalls).not.toContain("/v2/");
    expect(curlCalls).not.toContain("/token");
    expect(run.envFile()).toContain("OMNESIS_IMAGE_TAG=8.7.6");
    expect(run.docker.filter((call) => call.startsWith("docker manifest inspect"))).toEqual([
      "docker manifest inspect registry.example.test/team/releases/omnesis-gateway:8.7.6",
      "docker manifest inspect registry.example.test/team/releases/omnesis-collector:8.7.6",
      "docker manifest inspect registry.example.test/team/releases/omnesis-updater:8.7.6",
    ]);
    expect(composeAt(run)).toContain(
      'image: "registry.example.test/team/releases/omnesis-gateway:${OMNESIS_IMAGE_TAG}"',
    );
    expect(run.docker.some((call) => call.includes("--profile update pull"))).toBe(true);
    expect(run.docker.some((call) => call.includes("up -d gateway"))).toBe(true);
  });

  test.each([
    ["docker-before-edge", ["--docker", "--edge"], {}],
    ["edge-before-docker", ["--edge", "--docker"], {}],
    ["edge-from-environment", ["--docker"], { OMNESIS_INSTALL_EDGE: "1" }],
  ])(
    "refuses --edge under --docker (%s) before writing or contacting Docker",
    (name, args, env) => {
      const run = runInstaller(name, args, env);
      expect(run.status).not.toBe(0);
      expect(run.output).toContain("installer resolves images cut at releases");
      expect(run.output).toContain("--version X.Y.Z");
      expect(run.output).toContain("dispatch the 'docker' workflow");
      expect(run.output).toContain("https://omnesis.dev/docs/install#docker");
      expect(existsSync(join(run.configDir, "docker-compose.yml"))).toBe(false);
      expect(run.docker).toEqual([]);
    },
  );

  test("a refused edge rerun preserves an existing Docker installation", () => {
    const name = "edge-preserves-existing-install";
    const home = prepareHome(name);
    const configDir = join(home, ".config", "omnesis");
    const wrapper = join(home, ".local", "bin", "omnesis");
    const curlLog = fixturePath("edge-preserves-existing-curl.log");
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    writeFileSync(curlLog, "");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const sentinels = [
      [join(configDir, "docker-compose.yml"), "existing compose\n"],
      [join(configDir, ".env"), "OMNESIS_IMAGE_TAG=8.7.6\n"],
      [join(configDir, "install-method"), "docker\n"],
      [wrapper, "existing wrapper\n"],
    ];
    for (const [path, contents] of sentinels) writeFileSync(path, contents);

    const run = runInstaller(name, ["--docker", "--edge"], {
      OMNESIS_TEST_CURL_LOG: curlLog,
    });
    expect(run.status).not.toBe(0);
    for (const [path, contents] of sentinels) expect(readFileSync(path, "utf8")).toBe(contents);
    expect(run.calls).toEqual([]);
    expect(run.docker).toEqual([]);
    expect(readFileSync(curlLog, "utf8")).toBe("");
  });

  test("an invalid edge environment value keeps its validation error under --docker", () => {
    const run = runInstaller("invalid-edge-environment", ["--docker"], {
      OMNESIS_INSTALL_EDGE: "yes",
    });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("OMNESIS_INSTALL_EDGE must be 0 or 1");
    expect(run.output).not.toContain("--edge cannot be used with --docker");
    expect(existsSync(join(run.configDir, "docker-compose.yml"))).toBe(false);
    expect(run.docker).toEqual([]);
  });

  test("a pull the registry refuses stops the install and names --build", () => {
    const run = runInstaller("pull-fails", QUIET, { OMNESIS_TEST_PULL_FAIL: "1" });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("Could not pull");
    expect(run.output).toContain("--build");
    // Nothing is started on a host that has no images, and nothing is built
    // behind the operator's back.
    expect(run.docker.some((call) => call.includes("up -d"))).toBe(false);
    expect(run.docker.some((call) => call.includes(" build"))).toBe(false);
  });

  test("a pull authentication failure is actionable when manifest inspection is unavailable", () => {
    const run = runInstaller("pull-auth", QUIET, {
      OMNESIS_TEST_MANIFEST_MODE: "unsupported",
      OMNESIS_TEST_PULL_FAIL: "1",
      OMNESIS_TEST_PULL_ERROR: "unauthorized: authentication required",
    });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("docker login ghcr.io");
    expect(run.output).toContain("re-run the same installer command");
    expect(run.output).not.toContain("--version X.Y.Z");
    expect(run.output).not.toContain("fixture-token");
    expect(run.docker.some((call) => call.startsWith("docker login"))).toBe(false);
    expect(run.docker.some((call) => call.includes("up -d"))).toBe(false);
  });

  test("pull authentication still classifies when FIFO streaming is unavailable", () => {
    writeExecutable(fixturePath("fake-bin", "mkfifo"), "#!/bin/sh\nexit 1\n");
    const run = runInstaller("pull-auth-no-fifo", QUIET, {
      OMNESIS_TEST_MANIFEST_MODE: "unsupported",
      OMNESIS_TEST_PULL_FAIL: "1",
      OMNESIS_TEST_PULL_ERROR: "unauthorized: authentication required",
    });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("docker login ghcr.io");
    expect(run.output).toContain("authentication required");
  });

  test("a pull missing-image failure does not blame whichever image was inspected last", () => {
    const run = runInstaller("pull-missing", QUIET, {
      OMNESIS_TEST_MANIFEST_MODE: "unsupported",
      OMNESIS_TEST_PULL_FAIL: "1",
      OMNESIS_TEST_PULL_ERROR: "manifest unknown: manifest unknown",
    });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("the required ghcr.io/omnesis-dev images at tag 9.9.0");
    expect(run.output).not.toContain("omnesis-updater:9.9.0");
    expect(run.output).not.toContain("docker login");
  });

  test("--build builds the images from the checkout instead of pulling", () => {
    const run = runInstaller("build", [...QUIET, "--build"]);
    expect(run.status).toBe(0);
    expect(run.docker.some((call) => call.includes("--profile update build"))).toBe(true);
    expect(run.docker.some((call) => call.includes("--profile update pull"))).toBe(false);
    expect(composeAt(run)).toContain("target: gateway-runtime");
    expect(composeAt(run)).toContain("target: collector-runtime");
    expect(composeAt(run)).toContain("target: updater");
  });

  test("--build is refused before any build when Docker's storage is short of space", () => {
    // The requirement is stated rather than the disk faked: the real df reads
    // this run's own directory, which can hold 1 GB and cannot hold a petabyte.
    const short = runInstaller("build-disk-short", [...QUIET, "--build"], {
      OMNESIS_TEST_DOCKER_ROOT: repoRoot,
      OMNESIS_DOCKER_BUILD_DISK_GB: "1000000",
    });
    expect(short.status).not.toBe(0);
    expect(short.output).toContain(
      `Building the images needs about 1000000 GB free where Docker stores them (${repoRoot})`,
    );
    expect(short.output).toContain("Nothing was built.");
    expect(short.docker.some((call) => call.includes("--profile update build"))).toBe(false);
    const roomy = runInstaller("build-disk-roomy", [...QUIET, "--build"], {
      OMNESIS_TEST_DOCKER_ROOT: repoRoot,
      OMNESIS_DOCKER_BUILD_DISK_GB: "1",
    });
    expect(roomy.status).toBe(0);
    expect(roomy.docker.some((call) => call.includes("--profile update build"))).toBe(true);
  });

  test("--dry-run --build names the checkout and performs no Docker work", () => {
    const run = runInstaller("dry-build", [...QUIET, "--build", "--dry-run"]);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain(`Delivery:  containers built from ${repoRoot}`);
    expect(run.docker).toEqual([]);
    expect(existsSync(run.configDir)).toBe(false);
  });

  test("--dry-run reports a Docker collector without resolving images", () => {
    const run = runInstaller("dry-collector", [
      ...QUIET,
      "--collector",
      "--gateway-url",
      GATEWAY_URL,
      "--code",
      PAIRING_CODE,
      "--dry-run",
    ]);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("Role:      Docker collector");
    expect(run.output).toContain("published containers; release 9.9.0");
    expect(run.docker).toEqual([]);
  });

  test("a piped --dry-run --build refuses the missing checkout", () => {
    const home = prepareHome("dry-build-piped");
    const proc = spawnSync(
      "sh",
      ["-s", "--", "--docker", "--build", "--dry-run", "--no-model", "--no-keyring"],
      {
        input: readFileSync(installer),
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          PATH: `${fixturePath("fake-bin")}:${process.env.PATH}`,
          OMNESIS_DOCKER_BUILD_CONTEXT: "",
        },
      },
    );
    const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
    expect(proc.status).toBe(1);
    expect(output).toContain("--build needs the checkout this script came from");
  });

  test("the compose project derives from the config directory it lives in", () => {
    // Compose commands act on a project, not on a file. The default directory
    // keeps the plain name an operator expects to see in `docker ps`; a second
    // install anywhere else gets its own, so neither can tear the other down.
    const home = runInstaller("project-default", QUIET);
    expect(home.status).toBe(0);
    expect(composeAt(home)).toContain("name: omnesis\n");

    const elsewhere = join(fixturePath(), "second-instance");
    const other = runInstaller("project-elsewhere", QUIET, {
      OMNESIS_CONFIG_DIR: elsewhere,
    });
    expect(other.status).toBe(0);
    expect(readFileSync(join(elsewhere, "docker-compose.yml"), "utf8")).toMatch(
      /^name: omnesis-[0-9]+$/mu,
    );
  });

  test("the OAuth callback ports can be published on ports the kernel picks", () => {
    const run = runInstaller("ephemeral-oauth", QUIET, {
      OMNESIS_OAUTH_HOST_PORTS: "ephemeral",
    });
    expect(run.status).toBe(0);
    const compose = composeAt(run);
    for (const port of [3000, 3001, 3002, 3003]) {
      expect(compose).toContain(`- "127.0.0.1:0:${port}"`);
      expect(compose).not.toContain(`- "${port}:${port}"`);
    }
  });

  test("a pull-based install carries no build section", () => {
    // One left in the compose file would let a later `docker compose up`
    // silently compile the daemons from whatever is in that checkout by then.
    const run = runInstaller("no-build-section", QUIET);
    expect(run.status).toBe(0);
    expect(composeAt(run)).not.toContain("build:");
  });

  test("the banner names what a container cannot do", () => {
    const run = runInstaller("banner", QUIET);
    expect(run.output).toContain("Omnesis is running in Docker.");
    expect(run.output).toContain("Pair a phone (optional)");
    expect(run.output).toContain("Connect your browser (optional)");
    // The container's CLI cannot provision a certificate; the host issues one.
    expect(run.output).toContain("serves a self-signed");
    expect(run.output).toContain("re-run with --tls-cert/--tls-key");
    expect(run.output).not.toContain("omnesis tls provision");
    expect(run.output).toContain(
      "Connecting AI agents — this gateway has no Tailscale certificate",
    );
    expect(run.output).toContain("https://omnesis.dev/docs/install#docker-tls");
    expect(run.output).toContain("read macOS databases");
    expect(run.output).toContain("Multicast does not cross the Docker bridge");
    expect(run.output).toContain("no OS keyring");
  });
});

describe("install.sh --docker: another machine joins a gateway on its own certificate", () => {
  const HOST_NAMES = "studio-northstar,studio-northstar.local,192.0.2.47,2001:db8::47";

  /**
   * This host as the installer sees it: a hostname, and the same interfaces
   * through Linux's `ip` and through `ifconfig`, whichever the platform reads —
   * a loopback, a link-local, a temporary and a container-bridge address among
   * them, none of which another machine can use.
   */
  function installHostNames() {
    writeExecutable(
      fixturePath("fake-bin", "hostname"),
      '#!/bin/sh\nif [ "${1:-}" = -s ]; then echo Studio-Northstar; else echo Studio-Northstar.example.com; fi\n',
    );
    writeExecutable(
      fixturePath("fake-bin", "ip"),
      `#!/bin/sh
cat <<'EOF'
2: eth0    inet 192.0.2.47/24 brd 192.0.2.255 scope global dynamic eth0\\       valid_lft 86000sec preferred_lft 86000sec
2: eth0    inet6 2001:db8::47/64 scope global dynamic mngtmpaddr \\       valid_lft 86000sec preferred_lft 14000sec
2: eth0    inet6 2001:db8::9f/64 scope global temporary dynamic \\       valid_lft 86000sec preferred_lft 14000sec
3: docker0    inet 198.51.100.1/24 brd 198.51.100.255 scope global docker0\\       valid_lft forever preferred_lft forever
EOF
`,
    );
    writeExecutable(
      fixturePath("fake-bin", "ifconfig"),
      `#!/bin/sh
cat <<'EOF'
lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
	inet 127.0.0.1 netmask 0xff000000
	inet6 ::1 prefixlen 128
	inet6 fe80::1%lo0 prefixlen 64 scopeid 0x1
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
	inet6 fe80::1c2b:3aff:fe4d:5e6f%en0 prefixlen 64 secured scopeid 0x4
	inet 192.0.2.47 netmask 0xffffff00 broadcast 192.0.2.255
	inet6 2001:db8::47 prefixlen 64 autoconf secured
	inet6 2001:db8::9f prefixlen 64 autoconf temporary
bridge100: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
	inet 203.0.113.1 netmask 0xffffff00 broadcast 203.0.113.255
EOF
`,
    );
  }

  const services = (run) => parseYaml(composeAt(run)).services;

  test("the gateway is told this host's names, and the banner joins by one its certificate covers", () => {
    installHostNames();
    // Where the booted gateway writes the certificate it minted with those names.
    const fingerprint = plantGatewayCert(
      "self-signed-join",
      "DNS:localhost, DNS:gateway, DNS:studio-northstar.local, IP:192.0.2.47",
    );
    const run = runInstaller("self-signed-join", QUIET);
    expect(run.status, run.output).toBe(0);

    const { gateway, collector, updater } = services(run);
    expect(gateway.environment).toContain(`OMNESIS_TLS_EXTRA_NAMES=${HOST_NAMES}`);
    for (const service of [collector, updater]) {
      expect(service.environment.some((line) => line.startsWith("OMNESIS_TLS_EXTRA_NAMES="))).toBe(
        false,
      );
    }
    // The collector beside the gateway still dials the service name.
    expect(collector.environment).toContain("OMNESIS_GATEWAY_URL=https://gateway:7600");

    expect(run.output).toContain(
      "--collector \\\n" +
        "        --gateway-url https://studio-northstar.local:7600 \\\n" +
        `        --trust-fingerprint sha256:${fingerprint}\n`,
    );
    expect(run.output).not.toContain("Studio-Northstar.example.com");
    expect(run.output).not.toContain("does not cover");
  });

  test("a certificate minted before the gateway knew this host's names is kept, and the banner says so", () => {
    installHostNames();
    const fingerprint = plantGatewayCert("stale-self-signed");
    const run = runInstaller("stale-self-signed", QUIET);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain(`--trust-fingerprint sha256:${fingerprint}`);
    expect(run.output).toContain("does not cover studio-northstar.local");
    expect(run.output).toContain("omnesis tls renew --force");
    expect(run.output).toContain("re-pair every");
  });

  // A stock Linux server resolves no `.local` name, and advertises none either.
  test.skipIf(process.platform !== "linux")(
    "a host that does not resolve .local names is joined by its LAN address",
    () => {
      installHostNames();
      installUnresolvableLocalNames();
      const fingerprint = plantGatewayCert(
        "self-signed-join-ip",
        "DNS:localhost, DNS:studio-northstar.local, IP:192.0.2.47",
      );
      const run = runInstaller("self-signed-join-ip", QUIET);
      expect(run.status, run.output).toBe(0);
      expect(run.output).toContain(
        "        --gateway-url https://192.0.2.47:7600 \\\n" +
          `        --trust-fingerprint sha256:${fingerprint}\n`,
      );
      expect(run.output).not.toContain("does not cover");
    },
  );
});

describe("install.sh --docker: the wrapper it leaves behind", () => {
  /**
   * A `docker` that writes one argument per line, so a test can see what the
   * wrapper actually passed rather than what a joined string suggests.
   */
  const ARGV_SHIM = `#!/bin/sh
for ARG in "$@"; do printf '%s\\n' "$ARG" >> "$OMNESIS_TEST_DOCKER"; done
printf -- '--\\n' >> "$OMNESIS_TEST_DOCKER"
exit 0
`;

  test("an argument keeps its whitespace, and a hostile one stays one argument", () => {
    const run = runInstaller("wrapper-argv", QUIET);
    expect(run.status).toBe(0);
    writeExecutable(fixturePath("fake-bin", "docker"), ARGV_SHIM);

    const log = join(run.home, "wrapper-argv.log");
    writeFileSync(log, "");
    const hostile = "b'; touch " + join(run.home, "pwned") + "; #";
    const proc = spawnSync(run.wrapper, ["search", "foo  bar", "line1\nline2", "", hostile], {
      env: {
        PATH: `${fixturePath("fake-bin")}:${process.env.PATH ?? ""}`,
        HOME: run.home,
        OMNESIS_TEST_DOCKER: log,
        // Forwarded into the container; the container's own config dir is
        // deliberately not, because a host path is not mounted there.
        OMNESIS_LOG_LEVEL: "debug",
        OMNESIS_CONFIG_DIR: "/nowhere",
        OMNESIS_GATEWAY_URL: "https://localhost:7600",
      },
      encoding: "utf8",
    });
    expect(proc.status).toBe(0);
    const args = readFileSync(log, "utf8").split("\n");
    // Every argument survives as itself: the interior double space, the
    // newline, the empty string, and the quote-and-semicolon.
    expect(args).toContain("foo  bar");
    expect(args).toContain("line1");
    expect(args).toContain("line2");
    expect(args).toContain(hostile);
    expect(args).toContain("OMNESIS_LOG_LEVEL=debug");
    // The container's own paths and URL are the compose file's; a host value
    // for one of them names nothing inside the container.
    for (const shadowed of ["OMNESIS_CONFIG_DIR=", "OMNESIS_GATEWAY_URL="]) {
      expect(args.some((a) => a.startsWith(shadowed))).toBe(false);
    }
    // Order, not just membership: the flags belong before the service name and
    // the caller's own arguments after the command.
    const service = args.indexOf("gateway");
    expect(service).toBeGreaterThan(args.indexOf("--env"));
    expect(args.indexOf("omnesis")).toBe(service + 1);
    expect(args.indexOf("search")).toBe(service + 2);
    expect(existsSync(join(run.home, "pwned"))).toBe(false);
  });
});

describe("install.sh --docker --collector", () => {
  const CODED = [
    "--docker",
    "--collector",
    "--no-keyring",
    "--gateway-url",
    GATEWAY_URL,
    "--code",
    PAIRING_CODE,
    "--version",
    "9.9.0",
  ];

  test.skipIf(!HAS_PTY)("--no-prompt isolates the container CLI from terminal input", () => {
    const run = runInstallerOnTty("collector-no-prompt-stdin", [...CODED, "--no-prompt"], []);
    expect(run.status, run.output).toBe(0);
    expect(run.calls).not.toContain("pair stdin is a tty");
  });

  test("unpinned collector-only installs resolve collector and updater tags over local HTTP", () => {
    writeExecutable(fixturePath("fake-bin", "curl"), REGISTRY_CURL_SHIM);
    const log = fixturePath("collector-registry-curl.log");
    writeFileSync(log, "");
    const run = runInstaller(
      "collector-registry",
      [
        "--docker",
        "--collector",
        "--no-keyring",
        "--gateway-url",
        GATEWAY_URL,
        "--code",
        PAIRING_CODE,
      ],
      {
        OMNESIS_IMAGE_REPO: "localhost:5000",
        OMNESIS_TEST_CURL_LOG: log,
        OMNESIS_TEST_REGISTRY_MODE: "direct",
        OMNESIS_TEST_REGISTRY_TAGS: '{"tags":["5.0.0"]}',
      },
    );
    expect(run.status).toBe(0);
    expect(run.output).not.toContain("Pair a phone");
    expect(run.output).not.toContain("Connect your browser");
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("http://localhost:5000/v2/omnesis-collector/tags/list?n=1000");
    expect(calls).toContain("http://localhost:5000/v2/omnesis-updater/tags/list?n=1000");
    expect(calls).not.toContain("omnesis-gateway/tags/list");
    expect(run.envFile()).toContain("OMNESIS_IMAGE_TAG=5.0.0");
  });

  test("runs a collector container against a gateway elsewhere, and no gateway of its own", () => {
    const run = runInstaller("collector", [
      ...CODED,
      "--trust-fingerprint",
      `sha256:${GATEWAY_FP}`,
    ]);
    expect(run.status).toBe(0);

    const compose = composeAt(run);
    expect(compose).not.toContain("  gateway:");
    expect(compose).toContain(
      'image: "ghcr.io/omnesis-dev/omnesis-collector:${OMNESIS_IMAGE_TAG}"',
    );
    // With no gateway beside it, this collector keeps a directory of its own —
    // mounted through the parent so the keyring passphrase is reachable.
    expect(compose).toContain(`- OMNESIS_CONFIG_DIR=${run.configDir}/collector`);
    expect(compose).toContain(`- ${run.configDir}:${run.configDir}`);
    expect(compose).toContain(`- OMNESIS_GATEWAY_URL=${GATEWAY_URL}`);
    expect(compose).toContain(`- OMNESIS_TRUST_FINGERPRINT=sha256:${GATEWAY_FP}`);

    // The token lands in the collector's own config directory — the one its
    // daemon reads — and the wrapper runs the CLI in the collector container.
    expect(callStartingWith(run.calls, "pair ")).toBe(
      `pair ${PAIRING_CODE} --gateway-url ${GATEWAY_URL} ` +
        `--trust-fingerprint sha256:${GATEWAY_FP} ` +
        `--save ${join(run.configDir, "collector", "collector-token")}`,
    );
    expect(readFileSync(run.wrapper, "utf8")).toContain("SERVICE='collector'");
    expect(run.docker.some((call) => call.includes("up -d collector"))).toBe(true);
    expect(run.docker.some((call) => call.includes("up -d gateway"))).toBe(false);
  });

  test("a failed pairing starts nothing", () => {
    const run = runInstaller("pair-fails", CODED, { OMNESIS_TEST_PAIR_FAIL: "1" });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("Pairing failed");
    expect(run.docker.some((call) => call.includes("up -d"))).toBe(false);
  });

  test("an unreachable gateway is not blamed on the pairing code", () => {
    const run = runInstaller("pair-gateway-down", CODED, { OMNESIS_TEST_PAIR_FAIL: "64" });
    expect(run.status).not.toBe(0);
    // The redeem never reached the gateway, so the code was not consumed.
    // Advising a fresh one sends the operator round in a circle, re-minting
    // codes while the port stays shut.
    expect(run.output).toContain("could not be reached");
    expect(run.output).toContain("your code was not used");
    expect(run.output).not.toContain("single-use and short-lived");
    expect(run.docker.some((call) => call.includes("up -d"))).toBe(false);
  });

  test("refuses to pair without a code rather than sending an empty one", () => {
    const run = runInstaller("no-code", [
      "--docker",
      "--collector",
      "--no-keyring",
      "--gateway-url",
      GATEWAY_URL,
      "--version",
      "9.9.0",
    ]);
    expect(run.status).not.toBe(0);
    // Refused before the pull, with the flag that supplies one.
    expect(run.output).toContain("No terminal to ask what this install needs to know");
    expect(run.output).toContain("--code <code>");
    expect(run.calls.some((call) => call.startsWith("pair"))).toBe(false);
    expect(run.docker.some((call) => call.includes(" pull"))).toBe(false);
  });

  test("refuses to browse a LAN the container cannot see", () => {
    const run = runInstaller("no-url", [
      "--docker",
      "--collector",
      "--no-keyring",
      "--code",
      PAIRING_CODE,
    ]);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("--docker --collector needs --gateway-url");
    expect(run.output).toContain("multicast does not cross the Docker bridge");
  });
});

describe("install.sh --docker: a certificate the operator supplies", () => {
  const NAME = "gateway.example-tailnet.ts.net";

  /**
   * A pair minted into the run's config directory — the one path the
   * containers see. The self-signed fixture is its own CA: handed over with
   * `--tls-ca` it is a private CA; trusted through `SSL_CERT_FILE` it stands
   * in for a publicly chained certificate.
   */
  function supplyCertificate(name, subjectAltName = `DNS:localhost, DNS:${NAME}`) {
    const home = prepareHome(name);
    const configDir = join(home, ".config", "omnesis");
    mkdirSync(join(configDir, "tls"), { recursive: true });
    const minted = mintCert(`${name}-tls`, subjectAltName);
    const certPath = join(configDir, "tls", "gateway.crt");
    const keyPath = join(configDir, "tls", "gateway.key");
    const caPath = join(configDir, "tls", "rootCA.pem");
    writeFileSync(certPath, minted.pem);
    copyFileSync(fixturePath(`${name}-tls.key`), keyPath);
    writeFileSync(caPath, minted.pem);
    return { certPath, keyPath, caPath, fingerprint: minted.fingerprint, configDir };
  }

  const services = (run) => parseYaml(composeAt(run)).services;
  const pair = (tls) => ["--tls-cert", tls.certPath, "--tls-key", tls.keyPath];
  const publicChain = (tls) => ({ SSL_CERT_FILE: tls.certPath });
  const COLLECTOR_ARGS = [
    "--docker",
    "--collector",
    "--no-keyring",
    "--gateway-url",
    GATEWAY_URL,
    "--code",
    PAIRING_CODE,
    "--version",
    "9.9.0",
  ];

  test.skipIf(!HAS_REAL_OPENSSL)(
    "the gateway container serves it, and the collector dials the name it carries",
    () => {
      // `openssl verify` has to honour SSL_CERT_FILE for a fixture certificate to
      // stand in for a public chain; the system LibreSSL on macOS ignores it.
      const tls = supplyCertificate("supplied");
      const run = runInstaller(
        "supplied",
        [...QUIET, "--port", "7601", ...pair(tls)],
        publicChain(tls),
      );
      expect(run.status, run.output).toBe(0);
      // A publicly chained certificate: the browser step has no provisioning detour.
      expect(run.output).toContain("Connect your browser (optional)");
      expect(run.output).not.toContain("serves a self-signed");
      expect(run.output).not.toContain("issuing CA is installed");

      const { gateway, collector, updater } = services(run);
      // The certificate covers the operator's name, not the service name, so
      // the gateway answers to that name on the compose network and every
      // container dials it — verifying the name as any client would.
      expect(gateway.networks.default.aliases).toEqual([NAME]);
      expect(collector.environment).toContain(`OMNESIS_GATEWAY_URL=https://${NAME}:7600`);
      expect(updater.environment).toContain(`OMNESIS_GATEWAY_URL=https://${NAME}:7600`);
      for (const service of [gateway, collector, updater]) {
        expect(service.environment.some((line) => line.startsWith("NODE_EXTRA_CA_CERTS="))).toBe(
          false,
        );
      }
      // The gateway reads the pair from the config directory's .env, as a
      // native gateway would. Inside the containers the gateway is port 7600;
      // the pairing origin phones verify is the published port.
      const env = run.envFile();
      expect(env).toContain(`OMNESIS_TLS_CERT=${tls.certPath}\n`);
      expect(env).toContain(`OMNESIS_TLS_KEY=${tls.keyPath}\n`);
      expect(env).toContain(`OMNESIS_GATEWAY_URL=https://${NAME}:7600\n`);
      expect(env).toContain(`OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN=https://${NAME}:7601\n`);
      expect(env).not.toContain("OMNESIS_TLS_CA=");
      expect(run.output).toContain(`sha256:${tls.fingerprint}`);
      expect(run.output).toContain(`https://${NAME}:7601/portal/`);
      expect(run.output).toContain("omnesis tls reload");
    },
  );

  test.skipIf(!HAS_REAL_OPENSSL)(
    "on the default HTTPS port the pairing origin carries no port",
    () => {
      // `openssl verify` has to honour SSL_CERT_FILE for a fixture certificate to
      // stand in for a public chain; the system LibreSSL on macOS ignores it.
      const tls = supplyCertificate("port-443");
      const run = runInstaller(
        "port-443",
        [...QUIET, "--port", "443", ...pair(tls)],
        publicChain(tls),
      );
      expect(run.status, run.output).toBe(0);
      expect(run.envFile()).toContain(`OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN=https://${NAME}\n`);
    },
  );

  test("a private CA is handed to every container, and earns no system-trust origin", () => {
    const tls = supplyCertificate("private-ca");
    const run = runInstaller("private-ca", [...QUIET, ...pair(tls), "--tls-ca", tls.caPath]);
    expect(run.status, run.output).toBe(0);
    const { gateway, collector, updater } = services(run);
    for (const service of [gateway, collector, updater]) {
      expect(service.environment).toContain(`NODE_EXTRA_CA_CERTS=${tls.caPath}`);
    }
    const env = run.envFile();
    expect(env).toContain(`OMNESIS_TLS_CA=${tls.caPath}\n`);
    expect(env).not.toContain("OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN=");
    // A private CA: the browser trusts the certificate once the CA is installed in it.
    expect(run.output).toContain(`issuing CA is installed in it: ${tls.caPath}`);
    expect(run.output).not.toContain("serves a self-signed");
    // Another machine joins by the certificate's own name; the host names a
    // self-signed certificate would need are neither passed nor printed.
    expect(gateway.environment.some((line) => line.startsWith("OMNESIS_TLS_EXTRA_NAMES="))).toBe(
      false,
    );
    expect(run.output).toContain(`--collector \\\n        --gateway-url https://${NAME}:7600\n`);
    expect(run.output).not.toContain("does not cover");
  });

  test("a certificate nobody on this host trusts is refused unless its CA is named", () => {
    const tls = supplyCertificate("untrusted");
    const run = runInstaller("untrusted", [...QUIET, ...pair(tls)]);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("chains to no root this host trusts");
    expect(existsSync(join(run.configDir, "docker-compose.yml"))).toBe(false);

    // A CA that did not issue it is refused the same way.
    writeFileSync(tls.caPath, mintCert("untrusted-other-ca").pem);
    const wrong = runInstaller("untrusted", [...QUIET, ...pair(tls), "--tls-ca", tls.caPath]);
    expect(wrong.status).not.toBe(0);
    expect(wrong.output).toContain(`did not issue ${tls.certPath}`);
  });

  test("a re-run without the flags keeps the recorded certificate, even without Node", () => {
    const tls = supplyCertificate("kept");
    const first = runInstaller("kept", [...QUIET, ...pair(tls), "--tls-ca", tls.caPath]);
    expect(first.status, first.output).toBe(0);
    // A Docker host has no Node; the record is read all the same.
    writeExecutable(fixturePath("fake-bin", "node"), "#!/bin/sh\nexit 127\n");
    const again = runInstaller("kept", QUIET);
    expect(again.status, again.output).toBe(0);
    expect(again.output).toContain(`Keeping the certificate at ${tls.certPath}`);
    const { gateway, collector } = services(again);
    expect(gateway.networks.default.aliases).toEqual([NAME]);
    expect(collector.environment).toContain(`NODE_EXTRA_CA_CERTS=${tls.caPath}`);
    expect(again.envFile()).toContain(`OMNESIS_TLS_CERT=${tls.certPath}\n`);
  });

  test("a flagged re-run that drops the CA is refused rather than passed off as public", () => {
    const tls = supplyCertificate("dropped-ca");
    expect(
      runInstaller("dropped-ca", [...QUIET, ...pair(tls), "--tls-ca", tls.caPath]).status,
    ).toBe(0);
    const again = runInstaller("dropped-ca", [...QUIET, ...pair(tls)]);
    expect(again.status).not.toBe(0);
    expect(again.output).toContain("chains to no root this host trusts");
  });

  test("a record whose files vanished stops the re-run; one removed from .env clears what went with it", () => {
    const tls = supplyCertificate("vanished");
    {
      const first = runInstaller("vanished", [...QUIET, ...pair(tls), "--tls-ca", tls.caPath]);
      expect(first.status, first.output).toBe(0);
    }
    rmSync(tls.certPath);
    const gone = runInstaller("vanished", QUIET);
    expect(gone.status).not.toBe(0);
    expect(gone.output).toContain(
      `names a certificate at ${tls.certPath} that is no longer readable`,
    );

    // Following the remedy: the pair's lines go, and the next run clears the
    // gateway URL, CA and pairing origin that only made sense beside them.
    const envPath = join(tls.configDir, ".env");
    writeFileSync(
      envPath,
      readFileSync(envPath, "utf8")
        .split("\n")
        .filter((line) => !/^OMNESIS_TLS_(CERT|KEY)=/.test(line))
        .join("\n"),
    );
    const back = runInstaller("vanished", QUIET);
    expect(back.status, back.output).toBe(0);
    const env = back.envFile();
    for (const key of [
      "OMNESIS_TLS_CA",
      "OMNESIS_GATEWAY_URL",
      "OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN",
    ]) {
      expect(env).not.toContain(`${key}=`);
    }
    expect(services(back).gateway.networks).toBeUndefined();
    expect(services(back).collector.environment).toContain(
      "OMNESIS_GATEWAY_URL=https://gateway:7600",
    );
  });

  test("without openssl the gateway image's own runtime reads the pair, as this user", () => {
    const tls = supplyCertificate("no-openssl");
    writeExecutable(fixturePath("fake-bin", "openssl"), "#!/bin/sh\nexit 127\n");
    const noCa = runInstaller("no-openssl", [...QUIET, ...pair(tls)]);
    expect(noCa.status).not.toBe(0);
    expect(noCa.output).toContain("needs openssl on this host to check what it chains to");

    const run = runInstaller("no-openssl", [...QUIET, ...pair(tls), "--tls-ca", tls.caPath]);
    expect(run.status, run.output).toBe(0);
    expect(services(run).gateway.networks.default.aliases).toEqual([NAME]);
    expect(run.output).toContain(`sha256:${tls.fingerprint}`);
    const read = run.docker.find((call) => call.startsWith("docker run "));
    expect(read).toContain(`--user ${process.getuid()}:${process.getgid()}`);
    expect(read).toContain(`-v ${tls.configDir}:${tls.configDir}:ro`);

    writeFileSync(tls.caPath, mintCert("no-openssl-other-ca").pem);
    const wrong = runInstaller("no-openssl", [...QUIET, ...pair(tls), "--tls-ca", tls.caPath]);
    expect(wrong.status).not.toBe(0);
    expect(wrong.output).toContain(`did not issue ${tls.certPath}`);
  });

  test("a host that only collects takes the CA alone, and keeps it on a re-run", () => {
    const home = prepareHome("collector-ca");
    const configDir = join(home, ".config", "omnesis");
    mkdirSync(join(configDir, "tls"), { recursive: true });
    const caPath = join(configDir, "tls", "rootCA.pem");
    writeFileSync(caPath, mintCert("collector-ca-tls").pem);
    const run = runInstaller("collector-ca", [...COLLECTOR_ARGS, "--tls-ca", caPath]);
    expect(run.status, run.output).toBe(0);
    expect(services(run).collector.environment).toContain(`NODE_EXTRA_CA_CERTS=${caPath}`);
    expect(services(run).collector.environment).toContain(`OMNESIS_GATEWAY_URL=${GATEWAY_URL}`);
    expect(run.envFile()).toContain(`OMNESIS_TLS_CA=${caPath}\n`);

    const again = runInstaller("collector-ca", COLLECTOR_ARGS);
    expect(again.status, again.output).toBe(0);
    expect(again.output).toContain(`Keeping the CA at ${caPath}`);
    expect(services(again).collector.environment).toContain(`NODE_EXTRA_CA_CERTS=${caPath}`);
  });

  test("what it refuses, before anything is written", () => {
    const tls = supplyCertificate("refusals");
    const outside = fixturePath("refusals-tls-cert.pem");
    const linked = join(tls.configDir, "tls", "linked.crt");
    symlinkSync(outside, linked);
    writeFileSync(join(tls.configDir, "tls", "cert.pem"), readFileSync(tls.certPath));
    copyFileSync(tls.keyPath, join(tls.configDir, "tls", "key.pem"));
    const cases = [
      [["--tls-cert", tls.certPath], "--tls-cert and --tls-key go together"],
      [["--tls-ca", tls.caPath], "nothing for it to vouch for"],
      [["--tls-cert", outside, "--tls-key", tls.keyPath], `is outside ${tls.configDir}`],
      [["--tls-cert", "tls/gateway.crt", "--tls-key", tls.keyPath], "not an absolute path"],
      [["--tls-cert", linked, "--tls-key", tls.keyPath], "is a symbolic link"],
      [
        ["--tls-cert", `${tls.configDir}/tls/../tls/gateway.crt`, "--tls-key", tls.keyPath],
        "steps out of its directory",
      ],
      [
        ["--tls-cert", join(tls.configDir, "tls", "missing.crt"), "--tls-key", tls.keyPath],
        "does not exist or cannot be read",
      ],
      [
        [
          "--tls-cert",
          join(tls.configDir, "tls", "cert.pem"),
          "--tls-key",
          join(tls.configDir, "tls", "key.pem"),
        ],
        "the gateway's own self-signed pair",
      ],
    ];
    for (const [flags, message] of cases) {
      const run = runInstaller("refusals", [...QUIET, ...flags]);
      expect(run.status, flags.join(" ")).not.toBe(0);
      expect(run.output, flags.join(" ")).toContain(message);
      expect(existsSync(join(run.configDir, "docker-compose.yml")), flags.join(" ")).toBe(false);
    }
  });

  test("a certificate that covers no name the collector could dial is refused", () => {
    const tls = supplyCertificate("localhost-only", "DNS:localhost, IP:127.0.0.1");
    const run = runInstaller("localhost-only", [...QUIET, ...pair(tls), "--tls-ca", tls.caPath]);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("covers no DNS name other than localhost");
    expect(existsSync(join(run.configDir, "docker-compose.yml"))).toBe(false);

    const wildcard = supplyCertificate("wildcard-only", "DNS:*.example-tailnet.ts.net");
    const star = runInstaller("wildcard-only", [
      ...QUIET,
      ...pair(wildcard),
      "--tls-ca",
      wildcard.caPath,
    ]);
    expect(star.status).not.toBe(0);
    expect(star.output).toContain("covers only a wildcard name");
  });

  test("a key that does not belong to the certificate is refused", () => {
    const tls = supplyCertificate("mismatch");
    mintCert("mismatch-other");
    copyFileSync(fixturePath("mismatch-other.key"), tls.keyPath);
    const run = runInstaller("mismatch", [...QUIET, ...pair(tls), "--tls-ca", tls.caPath]);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("the pair does not belong together");
  });

  test("invalid TLS preserves the running split topology during a combined transition", () => {
    const tls = supplyCertificate("transition-invalid-tls");
    mintCert("transition-other-key");
    copyFileSync(fixturePath("transition-other-key.key"), tls.keyPath);
    const previous = "services:\n  gateway: {}\n  collector: {}\n";
    writeFileSync(join(tls.configDir, "docker-compose.yml"), previous);
    const run = runInstaller("transition-invalid-tls", [...QUIET, "--combined", ...pair(tls)], {
      OMNESIS_TEST_OLD_SERVICES: "gateway\ncollector",
    });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("the pair does not belong together");
    expect(composeAt(run)).toBe(previous);
    expect(run.docker.some((call) => / (stop|rm) /.test(call))).toBe(false);
  });

  test("a native install is told where its own certificate goes instead", () => {
    const run = runInstallerRaw("native-tls", ["--tls-cert", "/x.crt", "--tls-key", "/x.key"]);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("OMNESIS_TLS_CERT and OMNESIS_TLS_KEY in");
  });

  test("a collector host is told the certificate is the gateway's to serve", () => {
    const run = runInstaller("collector-cert", [
      ...COLLECTOR_ARGS,
      "--tls-cert",
      "/tmp/x.crt",
      "--tls-key",
      "/tmp/x.key",
    ]);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("this host only collects");
  });
});

describe("install.sh --docker: the flags it refuses", () => {
  const cases = [
    [["--combined"], "only meaningful with --docker"],
    [["--gateway-only"], "only meaningful with --docker"],
    [["--docker-network", "bridge"], "only meaningful with --docker"],
    [["--docker", "--combined", "--collector"], "--combined cannot"],
    [["--docker", "--combined", "--gateway-only"], "--combined cannot"],
    [["--docker", "--gateway-only", "--collector"], "--gateway-only cannot"],
    [["--docker", "--docker-network", "invalid"], "must be host or bridge"],
    [["--docker", "--client-only"], "One role per invocation"],
    [["--docker", "--method", "package"], "--method selects how the CLI is installed"],
    [["--docker", "--source-dir", "/tmp/x"], "--source-dir is where a source install"],
    [["--docker", "--channel", "beta"], "--channel selects an npm dist-tag"],
    [
      ["--docker", "--registry", "https://registry.example.com"],
      "--registry selects the npm registry",
    ],
    [["--docker", "--no-tls"], "The gateway container always mints its own"],
    [["--docker", "--force"], "--version is all a downgrade needs"],
    [["--docker", "--mkcert"], "re-run with --tls-cert, --tls-key and --tls-ca"],
    [["--docker", "--no-service"], "the containers restart themselves"],
    [["--build"], "only meaningful with --docker"],
    // A harness plugin runs inside the harness process, so no container of
    // ours can hold it.
    [["--docker", "--openclaw"], "there is no container for it"],
    [["--docker", "--hermes"], "there is no container for it"],
  ];
  for (const [args, message] of cases) {
    test(`${args.join(" ")}`, () => {
      const run = runInstaller(`refuse-${args.join("-").replaceAll(/[^a-z]+/g, "-")}`, args);
      expect(run.status).not.toBe(0);
      expect(run.output).toContain(message);
    });
  }
});

describe("install.sh: the recorded install method", () => {
  test("a native install clears a marker an earlier Docker install left here", () => {
    const home = prepareHome("native-clears");
    const configDir = join(home, ".config", "omnesis");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "install-method"), "docker\n");

    const run = runInstallerRaw("native-clears", [
      "--client-only",
      "--no-keyring",
      "--method",
      "source",
    ]);
    expect(run.status).toBe(0);
    expect(existsSync(join(run.configDir, "install-method"))).toBe(false);
  });
});

describe.skipIf(!HAS_PTY)("install.sh --docker: the questions it asks", () => {
  test("the model question is answered from the catalog in the image", () => {
    const run = runInstallerOnTty(
      "model-question",
      ["--docker", "--no-keyring", "--version", "9.9.0"],
      ["2"],
    );
    expect(run.status).toBe(0);
    expect(run.output).toContain("Which embedding model should power semantic search?");
    expect(callStartingWith(run.calls, "model install")).toBe("model install wide-embed");
  });

  test("a container has no OS keyring, so the passphrase backend is the offer", () => {
    const run = runInstallerOnTty(
      "keyring-question",
      ["--docker", "--no-model", "--version", "9.9.0"],
      ["2"],
    );
    expect(run.status).toBe(0);
    expect(run.output).toContain("A container has no OS keyring");
    expect(run.output).toContain("Arm a passphrase keyring now");
    expect(existsSync(join(run.configDir, "keyring.pass"))).toBe(true);
    expect(callStartingWith(run.calls, "keyring init")).toBe("keyring init --backend passphrase");
    expect(run.envFile()).toContain("OMNESIS_SECRET_STORE=passphrase");
  });
});

describe("the wrapper's uninstall, on the host", () => {
  /** Run the installed wrapper with the fake docker, as the operator would. */
  function runWrapper(run, args, extraEnv = {}) {
    return spawnSync(run.wrapper, args, {
      env: {
        PATH: `${fixturePath("fake-bin")}:/usr/bin:/bin`,
        HOME: run.home,
        OMNESIS_TEST_DOCKER: dockerLog(run.home),
        ...extraEnv,
      },
      input: "",
      encoding: "utf8",
    });
  }

  function profileWithPathLine(run) {
    const profile = join(run.home, ".zshrc");
    writeFileSync(
      profile,
      `export EDITOR=vim\n\n# Added by the Omnesis installer\nexport PATH="${run.home}/.local/bin:$PATH"\n`,
    );
    return profile;
  }

  test("takes the containers and images down and removes the launcher, keeping the data", () => {
    const run = runInstaller("uninstall-keep", QUIET);
    expect(run.status).toBe(0);
    const profile = profileWithPathLine(run);
    writeFileSync(join(run.configDir, "omnesis.db"), "fictional corpus");
    const composeFile = join(run.configDir, "docker-compose.yml");

    const proc = runWrapper(run, ["uninstall", "--yes"]);

    expect(proc.status, proc.stderr).toBe(0);
    expect(readDockerCalls(run.home)).toContain(
      `docker compose -f ${composeFile} --profile update down --rmi all --remove-orphans`,
    );
    expect(existsSync(composeFile)).toBe(false);
    expect(existsSync(join(run.configDir, "install-method"))).toBe(false);
    expect(existsSync(run.wrapper)).toBe(false);
    expect(readFileSync(join(run.configDir, "omnesis.db"), "utf8")).toBe("fictional corpus");
    expect(readFileSync(profile, "utf8")).toBe("export EDITOR=vim\n");
    expect(proc.stdout).toContain("Your data stays in");
  });

  test("--purge deletes the config directory too", () => {
    const run = runInstaller("uninstall-purge", QUIET);
    const proc = runWrapper(run, ["uninstall", "--yes", "--purge"]);
    expect(proc.status, proc.stderr).toBe(0);
    expect(existsSync(run.configDir)).toBe(false);
    expect(existsSync(run.wrapper)).toBe(false);
  });

  test("--dry-run and a refused confirmation change nothing", () => {
    const run = runInstaller("uninstall-dry", QUIET);
    const before = readDockerCalls(run.home).length;
    const dry = runWrapper(run, ["uninstall", "--dry-run", "--purge"]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("Dry run: nothing was changed.");
    const unconfirmed = runWrapper(run, ["uninstall"]);
    expect(unconfirmed.status).toBe(2);
    expect(unconfirmed.stderr).toContain("--yes");
    expect(readDockerCalls(run.home)).toHaveLength(before);
    expect(existsSync(run.wrapper)).toBe(true);
    expect(existsSync(join(run.configDir, "docker-compose.yml"))).toBe(true);
  });

  test("refuses to remove one part of the stack", () => {
    const run = runInstaller("uninstall-part", QUIET);
    const proc = runWrapper(run, ["uninstall", "collector", "--yes"]);
    expect(proc.status).toBe(2);
    expect(proc.stderr).toContain("removed as a whole");
    expect(existsSync(run.wrapper)).toBe(true);
  });

  test("a failed compose down removes nothing else", () => {
    const run = runInstaller("uninstall-fail", QUIET);
    writeExecutable(
      fixturePath("fake-bin", "docker"),
      "#!/bin/sh\necho 'daemon unreachable' >&2\nexit 1\n",
    );
    const proc = runWrapper(run, ["uninstall", "--yes"]);
    expect(proc.status).toBe(1);
    expect(existsSync(run.wrapper)).toBe(true);
    expect(existsSync(join(run.configDir, "docker-compose.yml"))).toBe(true);
  });

  test("the PATH line stays when other programs share ~/.local/bin", () => {
    const run = runInstaller("uninstall-shared-bin", QUIET);
    const profile = profileWithPathLine(run);
    writeExecutable(join(run.home, ".local", "bin", "uv"), "#!/bin/sh\n");
    expect(runWrapper(run, ["uninstall", "--yes"]).status).toBe(0);
    expect(readFileSync(profile, "utf8")).toContain("# Added by the Omnesis installer");
  });

  test("a profile that had no newline at its end gets none back", () => {
    const run = runInstaller("uninstall-bare-profile", QUIET);
    const profile = join(run.home, ".bash_profile");
    // What the installer's append leaves in a profile whose last line had no newline.
    writeFileSync(
      profile,
      `export EDITOR=vim\n# Added by the Omnesis installer\nexport PATH="${run.home}/.local/bin:$PATH"\n`,
    );
    expect(runWrapper(run, ["uninstall", "--yes"]).status).toBe(0);
    expect(readFileSync(profile, "utf8")).toBe("export EDITOR=vim");
  });

  test("uninstalls after the compose file is already gone", () => {
    const run = runInstaller("uninstall-orphan", QUIET);
    rmSync(join(run.configDir, "docker-compose.yml"));
    const proc = runWrapper(run, ["uninstall", "--yes"]);
    expect(proc.status, proc.stderr).toBe(0);
    expect(existsSync(run.wrapper)).toBe(false);
  });
});

/**
 * A Docker host as it usually is: no Node of its own. The fake `node` fails,
 * as a missing one would, and the fake `docker run` reaches the real one to
 * stand in for the Node inside the image.
 */
function hideHostNode() {
  writeExecutable(fixturePath("fake-bin", "node"), "#!/bin/sh\nexit 127\n");
  return { OMNESIS_TEST_REAL_NODE: process.execPath };
}

describe("install.sh --docker: a compose plugin too old for the project", () => {
  test("an older Compose is refused before anything is written", () => {
    const run = runInstaller("compose-old", QUIET, { OMNESIS_TEST_COMPOSE_VERSION: "v2.23.3" });
    expect(run.status).toBe(1);
    expect(run.output).toContain("Compose v2.24.0 or later");
    expect(run.output).toContain("this host has v2.23.3");
    expect(existsSync(join(run.configDir, "docker-compose.yml"))).toBe(false);
    expect(run.docker.some((call) => call.includes(" pull"))).toBe(false);
  });

  test.each(["2.24.0", "v2.29.7", "2.40.3-desktop.1", "dev-build"])(
    "Compose %s is accepted",
    (version) => {
      const run = runInstaller(`compose-${version.replaceAll(/[^a-z0-9]+/g, "-")}`, QUIET, {
        OMNESIS_TEST_COMPOSE_VERSION: version,
      });
      expect(run.status, run.output).toBe(0);
    },
  );
});

describe("install.sh --docker: without a terminal", () => {
  test("every unanswered question is named before anything is pulled", () => {
    const run = runInstaller("unattended-missing", ["--docker", "--version", "9.9.0"]);
    expect(run.status).toBe(1);
    expect(run.output).toContain("No terminal to ask what this install needs to know");
    expect(run.output).toContain("--embedder <id>");
    expect(run.output).toContain("--no-model");
    expect(run.output).toContain(`--keyring-passphrase-file ${run.configDir}/keyring.pass`);
    expect(run.output).toContain("--no-keyring");
    expect(run.docker.some((call) => call.includes(" pull"))).toBe(false);
    expect(existsSync(join(run.configDir, "docker-compose.yml"))).toBe(false);
  });

  test("a collector-only host is also asked for its pairing code up front", () => {
    const run = runInstaller("unattended-collector", [
      "--docker",
      "--collector",
      "--gateway-url",
      GATEWAY_URL,
      "--version",
      "9.9.0",
    ]);
    expect(run.status).toBe(1);
    expect(run.output).toContain("--code <code>");
    expect(run.output).toContain("--no-keyring");
    // A collector installs no model, so there is nothing to choose there.
    expect(run.output).not.toContain("--embedder <id>");
    expect(run.docker.some((call) => call.includes(" pull"))).toBe(false);
  });

  test("the flags answer every question, with no Node on the host", () => {
    const home = prepareHome("unattended-answered");
    const configDir = join(home, ".config", "omnesis");
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const passphrase = join(configDir, "keyring.pass");
    writeFileSync(passphrase, "fictional-passphrase-for-a-test\n", { mode: 0o600 });
    const run = runInstaller(
      "unattended-answered",
      [
        "--docker",
        "--embedder",
        "wide-embed",
        "--keyring-passphrase-file",
        passphrase,
        "--version",
        "9.9.0",
      ],
      hideHostNode(),
    );
    expect(run.status, run.output).toBe(0);
    expect(callStartingWith(run.calls, "keyring init")).toBe("keyring init --backend passphrase");
    expect(callStartingWith(run.calls, "model install")).toBe("model install wide-embed");
  });

  test("a re-run whose model is served from elsewhere has nothing to ask", () => {
    expect(runInstaller("unattended-rerun", QUIET).status).toBe(0);
    const run = runInstaller(
      "unattended-rerun",
      ["--docker", "--no-keyring", "--version", "9.9.0"],
      {
        OMNESIS_TEST_ASSIGNED_EMBEDDER: "local-http/embed-large",
      },
    );
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("local-http/embed-large is already assigned");
    expect(run.calls.some((call) => call.startsWith("model install"))).toBe(false);
  });
});

describe("install.sh --docker: what the compose file names", () => {
  function plantHostname() {
    writeExecutable(
      fixturePath("fake-bin", "hostname"),
      '#!/bin/sh\nif [ "${1:-}" = -s ]; then echo Studio_Northstar; else echo Studio_Northstar.example.com; fi\n',
    );
  }

  test("the collector container answers to this host's name, so its device keeps one", () => {
    plantHostname();
    const run = runInstaller("collector-hostname", QUIET);
    expect(run.status).toBe(0);
    const compose = parseYaml(composeAt(run));
    expect(compose.services.collector.hostname).toBe("studio-northstar");
    // The collector dials the gateway by the name its certificate covers.
    expect(compose.services.gateway.hostname).toBe("gateway");
  });

  test("host networking shares the host's own name, so none is set", () => {
    plantHostname();
    const run = runInstaller("collector-hostname-host", [...QUIET, "--docker-network", "host"]);
    expect(run.status).toBe(0);
    expect(parseYaml(composeAt(run)).services.collector.hostname).toBeUndefined();
  });

  test("the combined container starts under its own tini, with no init in front of it", () => {
    const run = runInstaller("combined-init", [...QUIET, "--combined"]);
    expect(run.status).toBe(0);
    expect(parseYaml(composeAt(run)).services.gateway.init).toBeUndefined();
  });
});

describe("install.sh --docker --collector: the closing banner", () => {
  test("sends source and status commands to the gateway host, and names the real gateway", () => {
    const run = runInstaller("collector-banner", [
      "--docker",
      "--collector",
      "--no-keyring",
      "--gateway-url",
      GATEWAY_URL,
      "--trust-fingerprint",
      `sha256:${GATEWAY_FP}`,
      "--code",
      PAIRING_CODE,
      "--version",
      "9.9.0",
    ]);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("Collector container is running.");
    // The name the gateway gave the device when the code was redeemed.
    expect(run.output).toContain("Device:   studio-northstar\n");
    expect(run.output).toContain(`on the gateway host, or in the portal at ${GATEWAY_URL}/portal/`);
    expect(run.output).toContain("omnesis sources add --device 'studio-northstar'");
    expect(run.output).not.toContain("    omnesis status");
    expect(run.output).not.toContain("omnesis sources add gmail");
    // A collector on a Mac joins the same gateway, not this host, which runs none.
    expect(run.output).toContain(`--gateway-url ${GATEWAY_URL}`);
    expect(run.output).toContain(`--trust-fingerprint sha256:${GATEWAY_FP}`);
    expect(run.output).not.toContain("<this-host>");
    expect(run.output).not.toContain("pair it with this gateway");
  });
});

describe.skipIf(!HAS_PTY)("install.sh --docker: questions on a host with no Node", () => {
  test("the model question is a numbered choice read with the image's Node", () => {
    const run = runInstallerOnTty(
      "model-question-no-node",
      ["--docker", "--no-keyring", "--version", "9.9.0"],
      ["2"],
      hideHostNode(),
    );
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("Which embedding model should power semantic search?");
    expect(run.output).not.toContain("Could not read the model catalog");
    expect(callStartingWith(run.calls, "model install")).toBe("model install wide-embed");
    expect(
      run.docker.some((call) =>
        call.startsWith("docker run --rm -i --pull never --network none --entrypoint node"),
      ),
    ).toBe(true);
  });

  test("the generated passphrase is written without a broken pipe", () => {
    const run = runInstallerOnTty(
      "keyring-question-no-node",
      ["--docker", "--no-model", "--version", "9.9.0"],
      ["2"],
      hideHostNode(),
    );
    expect(run.status, run.output).toBe(0);
    expect(run.output).not.toContain("Broken pipe");
    expect(readFileSync(join(run.configDir, "keyring.pass"), "utf8")).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("the wrapper's uninstall on a host that only collects", () => {
  function runWrapper(run, args) {
    return spawnSync(run.wrapper, args, {
      env: {
        PATH: `${fixturePath("fake-bin")}:/usr/bin:/bin`,
        HOME: run.home,
        OMNESIS_TEST_DOCKER: dockerLog(run.home),
      },
      input: "",
      encoding: "utf8",
    });
  }
  const COLLECTOR = [
    "--docker",
    "--collector",
    "--no-keyring",
    "--gateway-url",
    GATEWAY_URL,
    "--code",
    PAIRING_CODE,
    "--version",
    "9.9.0",
  ];
  const REMINDER = "omnesis devices revoke <device> --forget";

  test("leaves the same reminder a native collector's does, in the plan and after", () => {
    const run = runInstaller("uninstall-collector", COLLECTOR);
    expect(run.status, run.output).toBe(0);
    const dry = runWrapper(run, ["uninstall", "--dry-run"]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("Afterwards");
    expect(dry.stdout).toContain(REMINDER);
    const done = runWrapper(run, ["uninstall", "--yes"]);
    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout).toContain(REMINDER);
  });

  test("a gateway host has no gateway elsewhere to clean up", () => {
    const run = runInstaller("uninstall-gateway-no-reminder", QUIET);
    const done = runWrapper(run, ["uninstall", "--yes"]);
    expect(done.status).toBe(0);
    expect(done.stdout).not.toContain(REMINDER);
  });
});
