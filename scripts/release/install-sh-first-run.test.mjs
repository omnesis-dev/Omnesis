// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Drives the real installer end to end against fakes: a local git remote
 * carrying two release tags, an `npm` that writes a recording CLI shim instead
 * of installing anything, a `curl` that reports the gateway healthy, and a
 * `tailscale` the test decides the answers for.
 *
 * The seam is the shim: a source install always runs the CLI through
 * `<checkout>/node_modules/.bin/tsx`, so a recorder written there sees every
 * command the installer issues, with its arguments.
 *
 * Two run modes:
 *   - `runInstaller` gives the script no controlling terminal (`detached`), so
 *     it exercises what a systemd unit or a container build sees.
 *   - `runInstallerOnTty` runs it under `script(1)` and feeds the prompts.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  callStartingWith,
  createFixture,
  destroyFixture,
  fixturePath,
  HAS_PTY,
  installAbsentTailscale,
  installDenyingTailscale,
  installFakeMkcert,
  installFakeSudo,
  installer,
  installFakeTailscale,
  mintCert,
  tagRelease,
  plantGatewayCert,
  prepareHome,
  repoRoot,
  runInstaller as runInstallerRaw,
  runInstallerOnTty as runInstallerOnTtyRaw,
  writeExecutable,
  installUnresolvableLocalNames,
} from "./installer-harness.mjs";

const EMBED_IDS = [
  "nomic-embed-text-v1.5.Q8_0",
  "bge-small-en-v1.5.Q8_0",
  "qwen3-embedding-0.6b.Q8_0",
];
const MKCERT_HOST_LOCAL = "studio-northstar.local";

function installDeterministicMkcertHost(name, { ipv4 = "192.0.2.60", ipv6 = "2001:db8::60" } = {}) {
  const preload = fixturePath(`mkcert-${name}-network.cjs`);
  writeFileSync(
    preload,
    `const os = require("node:os");
os.networkInterfaces = () => ({
  loopback: [
    { address: "127.0.0.1", family: "IPv4", internal: true },
    { address: "::1", family: "IPv6", internal: true },
  ],
  ethernet: [
    { address: ${JSON.stringify(ipv4)}, family: "IPv4", internal: false },
    { address: ${JSON.stringify(ipv6)}, family: "IPv6", internal: false },
    { address: "fe80::60", family: "IPv6", internal: false },
    { address: "fe90::60", family: "IPv6", internal: false },
    { address: "2001:db8::61%eth0", family: "IPv6", internal: false },
  ],
  duplicate: [{ address: ${JSON.stringify(ipv4)}, family: "IPv4", internal: false }],
  malformed: [{ address: "not-an-address;touch-never", family: "IPv4", internal: false }],
});
`,
  );
  writeExecutable(
    fixturePath("fake-bin", "hostname"),
    "#!/bin/sh\nprintf 'Studio-Northstar.example.org\\n'\n",
  );
  const mkcert = installFakeMkcert(
    name,
    [
      "DNS:localhost",
      "DNS:studio-northstar.local",
      "IP:127.0.0.1",
      "IP:::1",
      `IP:${ipv4}`,
      `IP:${ipv6}`,
    ].join(", "),
  );
  return { ...mkcert, nodeOptions: `--require=${preload}` };
}

function installFailingTailscale(dnsName) {
  writeExecutable(
    fixturePath("fake-bin", "tailscale"),
    `#!/bin/sh
case "$1" in
  status)
    if [ "$2" = "--json" ]; then printf '{"BackendState":"Running","Self":{"DNSName":"${dnsName}."}}\\n'; fi
    exit 0 ;;
  cert) exit 1 ;;
esac
exit 1
`,
  );
}

function installTailscaleWithoutMagicDns() {
  writeExecutable(
    fixturePath("fake-bin", "tailscale"),
    `#!/bin/sh
case "$1" in
  status)
    if [ "$2" = "--json" ]; then printf '{"BackendState":"Running","Self":{}}\\n'; fi
    exit 0 ;;
esac
exit 1
`,
  );
}

/** What the fake `omnesis model catalog --role embed --json` answers. */
const CATALOG_FIXTURE = {
  role: "embed",
  default: EMBED_IDS[0],
  entries: [
    {
      id: EMBED_IDS[0],
      name: "nomic-embed-text v1.5 (Q8_0)",
      kind: "gguf",
      roles: ["embed"],
      author: "Nomic AI",
      license: "Apache-2.0",
      description: "Default embedder.",
      sizeBytes: 145_000_000,
      params: "137M",
      embedDim: 768,
      recommended: true,
      assigned: false,
    },
    {
      id: EMBED_IDS[1],
      name: "bge-small-en v1.5 (Q8_0)",
      kind: "gguf",
      roles: ["embed"],
      author: "BAAI",
      license: "MIT",
      description: "Small embedder.",
      sizeBytes: 36_000_000,
      params: "33M",
      embedDim: 384,
      recommended: false,
      assigned: false,
    },
    {
      id: EMBED_IDS[2],
      name: "qwen3-embedding 0.6b (Q8_0)",
      kind: "gguf",
      roles: ["embed"],
      author: "Qwen",
      license: "Apache-2.0",
      description: "Larger embedder.",
      sizeBytes: 609_000_000,
      params: "600M",
      embedDim: 1024,
      recommended: false,
      assigned: false,
    },
  ],
};

/**
 * The recording CLI shim. Invoked as `<shim> <entry.ts> <cli args...>` through
 * the wrapper the installer writes, so the first argument is dropped.
 */
const CLI_SHIM = `#!/bin/sh
shift 2>/dev/null || true
printf '%s\\n' "$*" >> "$OMNESIS_TEST_CALLS"
if [ "$1 $2" = "\${OMNESIS_TEST_FAIL:-__no_failure__}" ] && [ "\${3:-}" != --help ]; then
  echo "simulated failure of: $1 $2" >&2
  exit 1
fi
case "$1" in
  --version) echo "0.10.0" ;;
  keyring)
    case "$2" in
      status)
        case "\${OMNESIS_TEST_KEYRING:-locked}" in
          ready|refuses) echo '{"store":{"available":true,"secure":true}}' ;;
          *) echo '{"store":{"available":false,"secure":false,"detail":"no usable keyring"}}' ;;
        esac
        ;;
      init)
        if [ "\${OMNESIS_TEST_KEYRING:-locked}" = refuses ] && [ "\${3:-}" != --backend ]; then
          echo "macOS Keychain refused the noninteractive write." >&2
          exit 1
        fi
        ;;
      export-recovery) echo "recovery code: TEST-CODE-0000-1111" ;;
      *) : ;;
    esac
    ;;
  model)
    case "$2" in
      catalog)
        if [ "\${4:-}" = agent ]; then
          if [ -s "$HOME/fake-agent-assignment" ]; then
            assignment=$(cat "$HOME/fake-agent-assignment")
            printf '{"role":"agent","assignedId":"%s","default":null,"entries":[]}' "$assignment"
          else
            printf '{"role":"agent","assignedId":%s,"default":null,"entries":[]}' "\${OMNESIS_TEST_AGENT_ASSIGNMENT_JSON:-null}"
          fi
        else
          cat "$OMNESIS_TEST_CATALOG"
        fi
        ;;
      *) : ;;
    esac
    ;;
  codex)
    if [ "\${3:-}" = --help ]; then
      [ "\${OMNESIS_TEST_CODEX_SETUP_SUPPORT:-ready}" = ready ] || exit 2
      case "$2" in
        login) printf '%s\n' '  --wait    Wait for device login and verify the live model catalog' ;;
        setup-agent) printf '%s\n' 'USAGE setup-agent [OPTIONS] <MODEL>' ;;
        *) exit 2 ;;
      esac
      exit 0
    fi
    case "$2" in
      refresh)
        if [ "\${OMNESIS_TEST_CODEX_ALREADY_LOGGED_IN:-0}" = 1 ] || [ -f "$HOME/fake-codex-logged-in" ]; then
          if [ -n "\${OMNESIS_TEST_CODEX_READY_STATUS:-}" ]; then
            printf '%s' "$OMNESIS_TEST_CODEX_READY_STATUS"
          else
            printf '%s' '{"type":"codex","configured":true,"status":"ok","loggedIn":true,"models":["gpt-5.6-luna"]}'
          fi
        else
          printf '%s' '{"type":"codex","configured":false,"status":"unreachable","loggedIn":false,"models":[],"reason":"Codex is not configured."}'
        fi
        ;;
      login)
        [ "\${3:-}" = --wait ] || exit 2
        [ "\${OMNESIS_TEST_CODEX_LOGIN_EXIT:-0}" = 0 ] || exit "$OMNESIS_TEST_CODEX_LOGIN_EXIT"
        : > "$HOME/fake-codex-logged-in"
        if [ -n "\${OMNESIS_TEST_ASSIGN_DURING_LOGIN:-}" ]; then
          printf '%s' "$OMNESIS_TEST_ASSIGN_DURING_LOGIN" > "$HOME/fake-agent-assignment"
        fi
        printf 'Codex login complete\n'
        ;;
      setup-agent)
        [ -n "\${3:-}" ] || exit 2
        printf 'codex/%s' "$3" > "$HOME/fake-agent-assignment"
        printf 'Agent assignment complete\n'
        ;;
    esac
    ;;
  config)
    if [ "$2" = get ]; then
      if [ -s "$HOME/fake-agent-assignment" ]; then
        assignment=$(cat "$HOME/fake-agent-assignment")
        printf '{"inference":{"assignments":{"agent":"%s"}}}' "$assignment"
      elif [ -n "\${OMNESIS_TEST_AGENT_ASSIGNMENT_JSON:-}" ] && [ "$OMNESIS_TEST_AGENT_ASSIGNMENT_JSON" != null ]; then
        printf '{"inference":{"assignments":{"agent":%s}}}' "$OMNESIS_TEST_AGENT_ASSIGNMENT_JSON"
      else
        printf '{}'
      fi
    fi
    ;;
  devices)
    if [ "$2 \${3:-}" = "list --json" ]; then
      [ -n "\${OMNESIS_TEST_DEVICES_JSON:-}" ] || exit 1
      printf '%s' "$OMNESIS_TEST_DEVICES_JSON"
    fi
    ;;
  service)
    case "$2" in
      status)
        [ "\${OMNESIS_TEST_SERVICE_STATE:-}" = running ] &&
          printf '{"items":[{"component":"gateway","state":"running"}]}'
        ;;
      *) : ;;
    esac
    ;;
  *) : ;;
esac
exit 0
`;

/**
 * Every run in this suite reads the model catalog, which is this suite's
 * fixture rather than the harness's; a test that wants a different catalog
 * overrides the variable.
 */
const runInstaller = (name, args, extraEnv = {}, options = {}) =>
  runInstallerRaw(
    name,
    args,
    { OMNESIS_TEST_CATALOG: fixturePath("catalog.json"), ...extraEnv },
    options,
  );
const runInstallerOnTty = (name, args, answers, extraEnv = {}) =>
  runInstallerOnTtyRaw(name, args, answers, {
    OMNESIS_TEST_CATALOG: fixturePath("catalog.json"),
    ...extraEnv,
  });

beforeEach(() => {
  createFixture({ name: "run", versions: ["0.9.0", "0.10.0"], cliShim: CLI_SHIM });
  writeFileSync(fixturePath("catalog.json"), `${JSON.stringify(CATALOG_FIXTURE, null, 2)}\n`);
});

function installCodexSignal() {
  writeExecutable(fixturePath("fake-bin", "codex"), "#!/bin/sh\nexit 0\n");
}

function simulateMissingBuildTools() {
  const marker = fixturePath("build-tools-installed");
  for (const tool of ["make", "cc", "c++", "python3"]) {
    writeExecutable(
      fixturePath("fake-bin", tool),
      `#!/bin/sh
if [ "$1" = --version ] && [ -f '${marker}' ]; then echo '${tool} ready'; exit 0; fi
exit 127
`,
    );
  }
  writeExecutable(
    fixturePath("fake-bin", "apt-get"),
    `#!/bin/sh
printf 'apt-get %s\\n' "$*" >> "$OMNESIS_TEST_CALLS"
if [ "$1" = install ] && [ "$4" = build-essential ] && [ "$5" = python3 ]; then
  touch '${marker}'
fi
`,
  );
}

afterEach(destroyFixture);

describe("install.sh unattended runs", () => {
  // `ensure_source_build_tools` returns immediately unless PLATFORM is linux,
  // so off Linux these assert on a branch that never ran and fail for anyone
  // running the suite on a Mac.
  test.skipIf(process.platform !== "linux")(
    "a Linux source install supplies missing native build tools before npm",
    () => {
      simulateMissingBuildTools();
      installFakeSudo();
      const run = runInstaller("build-tools", [
        "--no-service",
        "--no-model",
        "--no-tls",
        "--no-keyring",
        "--no-prompt",
      ]);
      expect(run.status, run.output).toBe(0);
      expect(run.calls).toContain("sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -qq");
      expect(run.calls).toContain(
        "sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential python3",
      );
      expect(run.calls.indexOf("apt-get install -y -qq build-essential python3")).toBeLessThan(
        run.calls.indexOf("npm ci"),
      );
    },
  );

  test.skipIf(process.platform !== "linux")(
    "a source install stops before checkout if build tools cannot be installed",
    () => {
      simulateMissingBuildTools();
      const home = prepareHome("build-tools-refused");
      const marker = join(home, ".config", "omnesis", "install-method");
      mkdirSync(join(home, ".config", "omnesis"), { recursive: true });
      writeFileSync(marker, "docker\n");
      const run = runInstaller("build-tools-refused", [
        "--no-service",
        "--no-model",
        "--no-tls",
        "--no-keyring",
      ]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("Could not install build-essential and Python 3");
      expect(run.calls).not.toContain("npm ci");
      expect(existsSync(fixturePath("checkout-build-tools-refused"))).toBe(false);
      expect(readFileSync(marker, "utf8")).toBe("docker\n");
    },
  );

  test("--dry-run prints a truthful plan without creating install state", () => {
    const run = runInstaller("dry-run", ["--dry-run"]);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("Install plan");
    expect(run.output).toContain("Role:      gateway and collector");
    expect(run.output).toContain("newest stable source release (resolved during install)");
    expect(run.output).toContain("Dry run:   yes; no machine changes will be made");
    expect(run.calls).toEqual([]);
    expect(existsSync(fixturePath("checkout-dry-run"))).toBe(false);
    expect(existsSync(run.configDir)).toBe(false);
  });

  test.each([
    ["client", ["--client-only"], "CLI only", false],
    [
      "collector",
      ["--collector", "--gateway-url", "https://gateway.example.com:7600", "--code", "A1B2C3D4"],
      "collector for another gateway",
      false,
    ],
    ["package", ["--client-only", "--method", "package", "--version", "1.2.3"], "CLI only", false],
    ["auto", ["--client-only", "--method", "auto"], "CLI only", false],
    ["edge", ["--client-only", "--method", "auto", "--edge"], "CLI only", false],
  ])("--dry-run reports the %s plan without touching the machine", (name, args, role, gateway) => {
    const run = runInstaller(`dry-run-${name}`, ["--dry-run", ...args]);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain(`Role:      ${role}`);
    if (name === "package") expect(run.output).toContain("npm package; version 1.2.3");
    if (name === "auto") {
      expect(run.output).toContain("auto: package when the registry serves it, otherwise source");
    }
    if (name === "edge") expect(run.output).toContain("source; current main branch");
    expect(run.output.includes("Gateway:   ")).toBe(gateway);
    expect(run.calls).toEqual([]);
    expect(existsSync(fixturePath(`checkout-dry-run-${name}`))).toBe(false);
  });

  test.each([
    [["--dry-run", "--replace-source-wrapper"], "--replace-source-wrapper needs a package install"],
    [["--dry-run", "--edge", "--version", "1.2.3"], "--edge and --version cannot be used together"],
    [
      ["--dry-run", "--method", "auto", "--edge", "--replace-source-wrapper"],
      "--replace-source-wrapper needs a package install",
    ],
    [
      ["--dry-run", "--method", "auto", "--edge", "--channel", "beta"],
      "--channel beta selects an npm dist-tag and needs --method package",
    ],
    [
      ["--dry-run", "--method", "auto", "--edge", "--registry", "https://packages.example.org"],
      "--registry selects an npm registry and needs --method package",
    ],
  ])("--dry-run rejects a deterministic invalid source request", (args, message) => {
    const run = runInstaller(`dry-run-invalid-${message.length}`, args);
    expect(run.status).toBe(1);
    expect(run.output).toContain(message);
    expect(run.calls).toEqual([]);
  });

  test.skipIf(!HAS_PTY)("--no-prompt takes headless safety branches even on a terminal", () => {
    const run = runInstallerOnTty("no-prompt", ["--no-prompt", "--no-tls"], []);
    expect(run.status).toBe(1);
    expect(run.output).toContain("No terminal to ask which embedding model");
    expect(run.output).toContain("--embedder <id>");
    expect(run.calls).toEqual([]);
    expect(existsSync(fixturePath("checkout-no-prompt"))).toBe(false);
  });

  test.skipIf(!HAS_PTY)("--no-prompt takes safe optional defaults on a terminal", () => {
    const run = runInstallerOnTty(
      "no-prompt-explicit",
      ["--no-prompt", "--no-model", "--no-tls", "--no-keyring"],
      [],
    );
    expect(run.status, run.output).toBe(0);
    expect(run.output).not.toContain("Which account should run the gateway?");
    expect(run.output).toContain("Prompts:   disabled");
  });

  test("rejects an invalid shared network timeout before changing the machine", () => {
    const run = runInstaller("network-timeout", ["--dry-run"], {
      OMNESIS_NETWORK_TIMEOUT_SECONDS: "forever",
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain(
      "OMNESIS_NETWORK_TIMEOUT_SECONDS must be a positive whole number of seconds",
    );
    expect(run.calls).toEqual([]);
    expect(existsSync(fixturePath("checkout-network-timeout"))).toBe(false);
  });

  test("rejects a network timeout too large for bounded npm arithmetic", () => {
    const run = runInstaller("network-timeout-large", ["--dry-run"], {
      OMNESIS_NETWORK_TIMEOUT_SECONDS: "99999999999999999999",
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain("OMNESIS_NETWORK_TIMEOUT_SECONDS must not exceed 86400 seconds");
    expect(run.calls).toEqual([]);
    expect(existsSync(fixturePath("checkout-network-timeout-large"))).toBe(false);
  });

  test("a fully explicit run needs no terminal and asks nothing", () => {
    // The shape a container image or a provisioning script uses: every choice
    // is declined or supplied, so there is nothing to fail closed on.
    const run = runInstaller("unattended", [
      "--no-service",
      "--no-model",
      "--no-tls",
      "--no-keyring",
    ]);
    expect(run.status).toBe(0);
    expect(run.calls.some((c) => c.startsWith("service install"))).toBe(false);
    expect(run.calls.some((c) => c.startsWith("model install"))).toBe(false);
    expect(run.calls.some((c) => c.startsWith("keyring"))).toBe(false);
    expect(run.output).toContain("Omnesis is installed");
  });

  test("warns when an earlier PATH entry shadows the fresh command", () => {
    writeExecutable(
      fixturePath("fake-bin", "omnesis"),
      "#!/bin/sh\nprintf 'stale installer fixture\\n'\n",
    );
    const run = runInstaller("path-shadow", [
      "--no-service",
      "--no-model",
      "--no-tls",
      "--no-keyring",
    ]);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("ahead of the freshly installed command");
    expect(run.output).toContain(fixturePath("fake-bin", "omnesis"));
    expect(run.output).toContain(join(run.home, ".local", "bin", "omnesis"));
  });

  test("applies the shared native network budget to Git and npm", () => {
    const run = runInstaller(
      "network-budget",
      ["--no-service", "--no-model", "--no-tls", "--no-keyring"],
      {
        OMNESIS_NETWORK_TIMEOUT_SECONDS: "17",
        OMNESIS_TEST_RECORD_NETWORK_ENV: "1",
      },
    );
    expect(run.status, run.output).toBe(0);
    expect(run.calls).toContain(
      "network env git-limit=1 git-time=17 npm-retries=3 npm-timeout=17000",
    );
  });

  test("preserves explicit Git and npm network settings", () => {
    const run = runInstaller(
      "network-budget-override",
      ["--no-service", "--no-model", "--no-tls", "--no-keyring"],
      {
        OMNESIS_NETWORK_TIMEOUT_SECONDS: "17",
        OMNESIS_TEST_RECORD_NETWORK_ENV: "1",
        GIT_HTTP_LOW_SPEED_LIMIT: "7",
        GIT_HTTP_LOW_SPEED_TIME: "8",
        NPM_CONFIG_FETCH_RETRIES: "9",
        NPM_CONFIG_FETCH_TIMEOUT: "10",
      },
    );
    expect(run.status, run.output).toBe(0);
    expect(run.calls).toContain("network env git-limit=7 git-time=8 npm-retries=9 npm-timeout=10");
  });

  test("an unattended run that names its model still installs it", () => {
    const run = runInstaller("unattended-model", [
      "--no-tls",
      "--no-keyring",
      "--embedder",
      EMBED_IDS[1],
    ]);
    expect(run.status).toBe(0);
    expect(run.calls).toContain(`model install ${EMBED_IDS[1]}`);
    expect(callStartingWith(run.calls, "service install")).toContain("--exec");
  });
});

describe.skipIf(!HAS_PTY)("install.sh Codex agent offer", () => {
  const args = ["--no-tls", "--embedder", EMBED_IDS[0]];
  const baseEnv = { OMNESIS_TEST_KEYRING: "ready" };

  test("does not offer the cloud backend when its system command is absent", () => {
    const run = runInstallerOnTty("codex-absent", args, [], baseEnv);

    expect(run.status).toBe(0);
    expect(run.output).not.toContain(["Set up Omnesis", "Agent"].join(" "));
    expect(run.calls).not.toContain("codex refresh");
    expect(run.calls).not.toContain("codex login --wait");
    expect(run.calls.some((call) => call.startsWith("codex setup-agent gpt-"))).toBe(false);
  });

  test("declining the cloud offer changes neither login nor inference config", () => {
    installCodexSignal();
    const run = runInstallerOnTty("codex-decline", args, ["n"], baseEnv);

    expect(run.status).toBe(0);
    expect(run.output).toContain("relevant Omnesis data and tool results to OpenAI");
    expect(run.calls).not.toContain("codex refresh --json");
    expect(run.calls).not.toContain("codex login --wait");
    expect(run.calls.some((call) => call.startsWith("codex setup-agent gpt-"))).toBe(false);
  });

  test("logs into the isolated runtime and atomically enables Luna", () => {
    installCodexSignal();
    const run = runInstallerOnTty("codex-accept", args, ["y"], baseEnv);

    expect(run.status).toBe(0);
    expect(run.calls.filter((call) => call === "codex refresh --json")).toHaveLength(2);
    expect(run.calls).toContain("codex login --wait");
    expect(run.calls).toContain("codex setup-agent gpt-5.6-luna");
    expect(run.output).toContain(["Omnesis", "Agent is ready with Codex gpt-5.6-luna"].join(" "));
  });

  test("reuses an already healthy isolated cloud login", () => {
    installCodexSignal();
    const run = runInstallerOnTty("codex-reuse", args, ["y"], {
      ...baseEnv,
      OMNESIS_TEST_CODEX_ALREADY_LOGGED_IN: "1",
    });

    expect(run.status).toBe(0);
    expect(run.calls).toContain("codex refresh --json");
    expect(run.calls).not.toContain("codex login --wait");
    expect(run.calls).toContain("codex setup-agent gpt-5.6-luna");
  });

  test("preserves every existing agent assignment without prompting", () => {
    installCodexSignal();
    const run = runInstallerOnTty("codex-existing-agent", args, [], {
      ...baseEnv,
      OMNESIS_TEST_AGENT_ASSIGNMENT_JSON: JSON.stringify("studio-northstar/model-one"),
    });

    expect(run.status).toBe(0);
    expect(run.output).not.toContain(["Set up Omnesis", "Agent"].join(" "));
    expect(run.calls).not.toContain("codex refresh --json");
    expect(run.calls).not.toContain("codex login --wait");
    expect(run.calls.some((call) => call.startsWith("codex setup-agent gpt-"))).toBe(false);
  });

  test("a model unavailable to the account leaves remote inference untouched", () => {
    installCodexSignal();
    const run = runInstallerOnTty("codex-no-luna", args, ["y"], {
      ...baseEnv,
      OMNESIS_TEST_CODEX_ALREADY_LOGGED_IN: "1",
      OMNESIS_TEST_CODEX_READY_STATUS: JSON.stringify({
        type: "codex",
        configured: true,
        status: "ok",
        loggedIn: true,
        models: ["gpt-fictional-account-model"],
      }),
    });

    expect(run.status).toBe(0);
    expect(run.output).toContain("gpt-5.6-luna is not available");
    expect(run.calls.some((call) => call.startsWith("codex setup-agent gpt-"))).toBe(false);
  });

  test("a failed device login is non-fatal and leaves the agent unconfigured", () => {
    installCodexSignal();
    const run = runInstallerOnTty("codex-login-fails", args, ["y"], {
      ...baseEnv,
      OMNESIS_TEST_CODEX_LOGIN_EXIT: "1",
    });

    expect(run.status).toBe(0);
    expect(run.output).toContain("Codex login did not complete");
    expect(run.calls.some((call) => call.startsWith("codex setup-agent gpt-"))).toBe(false);
  });

  test("an assignment made during browser login wins", () => {
    installCodexSignal();
    const run = runInstallerOnTty("codex-assignment-race", args, ["y"], {
      ...baseEnv,
      OMNESIS_TEST_ASSIGN_DURING_LOGIN: "local/fictional-agent-model",
    });

    expect(run.status).toBe(0);
    expect(run.output).toContain("leaving it unchanged");
    expect(run.calls.some((call) => call.startsWith("codex setup-agent gpt-"))).toBe(false);
  });

  test("a config write failure cannot leave a half-applied setup", () => {
    installCodexSignal();
    const run = runInstallerOnTty("codex-config-fails", args, ["y"], {
      ...baseEnv,
      OMNESIS_TEST_CODEX_ALREADY_LOGGED_IN: "1",
      OMNESIS_TEST_FAIL: "codex setup-agent",
    });

    expect(run.status).toBe(0);
    expect(run.calls.filter((call) => call === "codex setup-agent gpt-5.6-luna")).toHaveLength(1);
    expect(run.output).toContain("agent assignment was not saved");
  });
});

describe("install.sh unattended Codex behavior", () => {
  test("a system Codex command never makes a headless install interactive", () => {
    installCodexSignal();
    const run = runInstaller("codex-headless", ["--no-tls", "--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
    });

    expect(run.status).toBe(0);
    expect(run.calls.some((call) => call.startsWith("codex "))).toBe(false);
    expect(run.calls.some((call) => call.startsWith("codex setup-agent gpt-"))).toBe(false);
  });

  test.skipIf(!HAS_PTY)("an older stable CLI skips an offer it cannot complete", () => {
    installCodexSignal();
    const run = runInstallerOnTty("codex-cli-skew", ["--no-tls", "--embedder", EMBED_IDS[0]], [], {
      OMNESIS_TEST_KEYRING: "ready",
      OMNESIS_TEST_CODEX_SETUP_SUPPORT: "missing",
    });

    expect(run.status).toBe(0);
    expect(run.output).toContain("assisted Agent setup needs a newer Omnesis release");
    expect(run.output).not.toContain(["Set up the agent with Codex", "Luna"].join(" "));
    expect(run.calls).not.toContain("codex refresh");
  });

  test("a no-service install never offers or configures the Codex agent", () => {
    installCodexSignal();
    const run = runInstaller("codex-no-service", [
      "--no-service",
      "--no-model",
      "--no-tls",
      "--no-keyring",
    ]);

    expect(run.status).toBe(0);
    expect(run.calls.some((call) => call.startsWith("codex "))).toBe(false);
  });
});

describe("install.sh wording", () => {
  test("the operator is told about encryption at rest, never end-to-end encryption", () => {
    // The gateway holds the key because it indexes the data, so "end to end"
    // would be a promise Omnesis does not make.
    for (const path of [installer, join(repoRoot, "website", "docs", "install.html")]) {
      const text = readFileSync(path, "utf8");
      expect(text).toContain("encryption at rest");
      expect(text.toLowerCase()).not.toContain("end to end");
      expect(text.toLowerCase()).not.toContain("end-to-end");
    }
  });
});

describe("install.sh service registration", () => {
  test("registers the units with the wrapper's absolute path and puts the command on PATH", () => {
    const run = runInstaller("exec", ["--no-tls", "--embedder", EMBED_IDS[1]], {
      OMNESIS_TEST_KEYRING: "ready",
    });

    expect(run.status).toBe(0);
    // ~/.local/bin was never on PATH in this run — registration must not care.
    expect(callStartingWith(run.calls, "service install")).toBe(
      `service install --exec ${run.wrapper}`,
    );
    const bin = join(run.home, ".local", "bin");
    const profile = join(run.home, ".zshrc");
    const line = `export PATH="${bin}:$PATH"`;
    expect(readFileSync(profile, "utf8")).toContain(`# Added by the Omnesis installer\n${line}\n`);
    expect(run.output).toContain(`${bin} is on PATH through ${profile}`);
    expect(run.output).toContain(`To use it in this terminal, run: ${line}`);
    expect(run.output).not.toContain("is not on your PATH");
  });

  test("a re-run finds the PATH line it added instead of adding it again", () => {
    const args = ["--no-tls", "--embedder", EMBED_IDS[1]];
    const env = { OMNESIS_TEST_KEYRING: "ready" };
    expect(runInstaller("exec-rerun", args, env).status).toBe(0);
    const run = runInstaller("exec-rerun", args, env);
    expect(run.status).toBe(0);
    const line = `export PATH="${join(run.home, ".local", "bin")}:$PATH"`;
    const profile = readFileSync(join(run.home, ".zshrc"), "utf8");
    expect(profile.split("\n").filter((l) => l === line)).toHaveLength(1);
  });

  // Registering a service leaves a running one on its build (systemd's
  // `enable --now`), so a re-run that moves the checkout has to restart both
  // daemons and wait for the gateway to report the version it just built.
  test("a re-run that moves the source checkout restarts the services on the new build", () => {
    const args = ["--no-tls", "--embedder", EMBED_IDS[1]];
    const env = {
      OMNESIS_TEST_KEYRING: "ready",
      OMNESIS_TEST_HEALTH_BODY: '{"status":"ok","version":"0.10.0"}',
    };
    const restarts = (run) => run.calls.filter((c) => c.startsWith("service restart"));

    expect(runInstaller("rerun-moves", [...args, "--version", "0.9.0"], env).status).toBe(0);
    const same = runInstaller("rerun-moves", [...args, "--version", "0.9.0"], env);
    expect(same.status).toBe(0);
    expect(restarts(same)).toEqual([]);

    const moved = runInstaller("rerun-moves", args, env);
    expect(moved.status).toBe(0);
    expect(restarts(moved)).toEqual(["service restart gateway", "service restart collector"]);
    expect(moved.output).toContain("Restarting the gateway on the build this run installed");

    // A gateway still answering from the previous build is not the one this run installed.
    const stale = runInstaller("rerun-stale", [...args, "--version", "0.9.0"], env);
    expect(stale.status).toBe(0);
    const staleRerun = runInstaller("rerun-stale", args, {
      ...env,
      OMNESIS_TEST_HEALTH_BODY: '{"status":"ok","version":"0.9.0"}',
      OMNESIS_GATEWAY_WAIT_SECONDS: "2",
    });
    expect(staleRerun.status).not.toBe(0);
    expect(staleRerun.output).toContain("Gateway did not answer /health");
  });

  // A machine this installer set up is updated in place by a plain re-run: the
  // recorded checkout moves and is rebuilt, the registered services restart on
  // it, and nothing about how the machine is set up is asked or redone.
  describe("re-running on an existing install", () => {
    const firstArgs = ["--no-tls", "--embedder", EMBED_IDS[1], "--version", "0.9.0"];
    const env = {
      OMNESIS_TEST_KEYRING: "ready",
      OMNESIS_TEST_HEALTH_BODY: '{"status":"ok","version":"0.10.0"}',
    };
    const updates = (run) => run.calls.filter((c) => c.startsWith("update "));
    const restarts = (run) => run.calls.filter((c) => c.startsWith("service restart"));
    const setUp = (run) =>
      run.calls.filter((c) => /^(service install|model install|pair |keyring )/.test(c));
    // The unit files `omnesis service install` would have written.
    const registerServices = (home, names = ["gateway", "collector"]) => {
      for (const name of names) {
        const unit = join(home, ".config", "systemd", "user", `omnesis-${name}.service`);
        const plist = join(home, "Library", "LaunchAgents", `dev.omnesis.${name}.plist`);
        for (const path of [unit, plist]) {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, "");
        }
      }
    };
    const checkoutGit = (name, ...args) =>
      execFileSync("git", args, { cwd: fixturePath(`checkout-${name}`), encoding: "utf8" }).trim();
    const installFirst = (name, args = firstArgs, services) => {
      const first = runInstaller(name, args, env);
      expect(first.status, first.output).toBe(0);
      registerServices(first.home, services);
      return first;
    };

    test("hands the update to the machine's own updater and sets nothing up again", () => {
      installFirst("update-in-place");
      // A checkout cloned from one tag fetches only that tag until the installer repairs it.
      checkoutGit(
        "update-in-place",
        "config",
        "--replace-all",
        "remote.origin.fetch",
        "+refs/tags/v0.9.0:refs/tags/v0.9.0",
      );

      const updated = runInstaller("update-in-place", [], env);
      expect(updated.status, updated.output).toBe(0);
      expect(updated.output).toContain("update of this machine's existing install");
      expect(updated.output).toContain("Omnesis is up to date.");
      expect(updates(updated)).toEqual(["update --yes"]);
      expect(setUp(updated)).toEqual([]);
      expect(restarts(updated)).toEqual([]);
      expect(checkoutGit("update-in-place", "config", "--get-all", "remote.origin.fetch")).toBe(
        "+refs/heads/main:refs/remotes/origin/main",
      );
    });

    test("passes --version and --edge through to the updater", () => {
      installFirst("update-flags");
      const pinned = runInstaller("update-flags", ["--version", "0.10.0"], env);
      expect(pinned.status, pinned.output).toBe(0);
      expect(updates(pinned)).toEqual(["update --yes --target-version 0.10.0"]);
      const edge = runInstaller("update-flags", ["--edge"], env);
      expect(edge.status, edge.output).toBe(0);
      expect(updates(edge)).toEqual(["update --yes --edge"]);
    });

    test("forces an updater older than 0.5.6 toward a release that is not older", () => {
      tagRelease("0.5.5");
      installFirst("update-old", ["--no-tls", "--embedder", EMBED_IDS[1], "--version", "0.5.5"]);
      const updated = runInstaller("update-old", [], env);
      expect(updated.status, updated.output).toBe(0);
      expect(updates(updated)).toEqual(["update --yes --force"]);
    });

    test("never forces an old updater toward an older release", () => {
      tagRelease("0.5.5");
      installFirst("update-old-pin", [
        "--no-tls",
        "--embedder",
        EMBED_IDS[1],
        "--version",
        "0.5.5",
      ]);
      const pinned = runInstaller("update-old-pin", ["--version", "0.5.0"], env);
      expect(pinned.status, pinned.output).toBe(0);
      expect(updates(pinned)).toEqual(["update --yes --target-version 0.5.0"]);
      const forced = runInstaller("update-old-pin", ["--version", "0.5.0", "--force"], env);
      expect(forced.status, forced.output).toBe(0);
      expect(updates(forced)).toEqual(["update --yes --target-version 0.5.0 --force"]);
    });

    test("judges an interrupted update by the build it returns to", () => {
      tagRelease("0.5.5");
      const first = installFirst("update-interrupted", [
        "--no-tls",
        "--embedder",
        EMBED_IDS[1],
        "--version",
        "0.5.5",
      ]);
      const statePath = join(first.home, ".config", "omnesis", "update-state.json");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      const interrupt = () => {
        checkoutGit("update-interrupted", "checkout", "-q", "--detach", "v0.10.0");
        writeFileSync(
          statePath,
          JSON.stringify({
            ...state,
            phase: "applying",
            targetCommit: checkoutGit("update-interrupted", "rev-parse", "HEAD"),
            lastCompletedCommit: state.commit,
          }),
        );
      };
      interrupt();
      const resumed = runInstaller("update-interrupted", [], env);
      expect(resumed.status, resumed.output).toBe(0);
      expect(updates(resumed)).toEqual(["update --yes --force"]);
      // The record holds the checkout's physical path. A run that names the
      // checkout through a symlink, as a macOS temporary directory under /var
      // is, reads the same record.
      interrupt();
      const linked = fixturePath("linked-checkout");
      symlinkSync(fixturePath("checkout-update-interrupted"), linked);
      const viaLink = runInstaller("update-interrupted", ["--source-dir", linked], env, {
        sourceDir: false,
      });
      expect(viaLink.status, viaLink.output).toBe(0);
      expect(updates(viaLink)).toEqual(["update --yes --force"]);
    });

    test("a record the updater cannot use runs the full install", () => {
      const first = installFirst("update-bad-record");
      const statePath = join(first.home, ".config", "omnesis", "update-state.json");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      writeFileSync(statePath, JSON.stringify({ ...state, commit: "not-a-commit" }));
      const again = runInstaller("update-bad-record", ["--no-tls", "--no-model"], env);
      expect(again.status, again.output).toBe(0);
      expect(updates(again)).toEqual([]);
    });

    test("a dry run names the update and changes nothing", () => {
      installFirst("update-dry");
      const dry = runInstaller("update-dry", ["--dry-run"], env);
      expect(dry.status, dry.output).toBe(0);
      expect(dry.output).toContain("update of this machine's existing install");
      expect(dry.output).not.toContain("Gateway:");
      expect(updates(dry)).toEqual([]);
    });

    test("leaves a checkout that already fetches its branches alone", () => {
      installFirst("update-heads");
      checkoutGit(
        "update-heads",
        "config",
        "--replace-all",
        "remote.origin.fetch",
        "+refs/heads/*:refs/remotes/origin/*",
      );
      const updated = runInstaller("update-heads", [], env);
      expect(updated.status, updated.output).toBe(0);
      expect(checkoutGit("update-heads", "config", "--get-all", "remote.origin.fetch")).toBe(
        "+refs/heads/*:refs/remotes/origin/*",
      );
    });

    test("a failed update fails the installer and says so", () => {
      installFirst("update-fails");
      const failed = runInstaller("update-fails", [], {
        ...env,
        OMNESIS_TEST_FAIL: "update --yes",
      });
      expect(failed.status).not.toBe(0);
      expect(failed.output).toContain("The update did not finish (exit 1)");
      expect(failed.output).not.toContain("Omnesis is up to date.");
    });

    test("a repeated --collector updates a collector machine without pairing again", () => {
      installFirst("update-collector", firstArgs, ["collector"]);
      const updated = runInstaller("update-collector", ["--collector"], env);
      expect(updated.status, updated.output).toBe(0);
      expect(updates(updated)).toEqual(["update --yes"]);
      expect(setUp(updated)).toEqual([]);
    });

    test("a repeated --client-only updates a machine that runs no services", () => {
      installFirst("update-client", ["--client-only", "--no-keyring", "--version", "0.9.0"], []);
      const updated = runInstaller("update-client", ["--client-only"], env);
      expect(updated.status, updated.output).toBe(0);
      expect(updates(updated)).toEqual(["update --yes"]);
    });

    test("a plain re-run updates a collector machine too", () => {
      installFirst("update-collector-plain", firstArgs, ["collector"]);
      const updated = runInstaller("update-collector-plain", [], env);
      expect(updated.status, updated.output).toBe(0);
      expect(updates(updated)).toEqual(["update --yes"]);
    });

    test("a flag that sets a kept choice, or another checkout, runs the full install", () => {
      installFirst("update-flagged");
      const port = runInstaller(
        "update-flagged",
        ["--no-tls", "--no-model", "--port", "7700"],
        env,
      );
      expect(port.status, port.output).toBe(0);
      expect(updates(port)).toEqual([]);
      expect(port.calls.some((c) => c.startsWith("service install"))).toBe(true);

      const elsewhere = runInstaller(
        "update-flagged",
        ["--source-dir", fixturePath("checkout-update-elsewhere"), "--no-tls", "--no-model"],
        env,
      );
      expect(elsewhere.status, elsewhere.output).toBe(0);
      expect(updates(elsewhere)).toEqual([]);
      expect(existsSync(fixturePath("checkout-update-elsewhere", ".git"))).toBe(true);
    });

    test("finds the recorded checkout when the re-run names none", () => {
      installFirst("update-recorded");
      checkoutGit(
        "update-recorded",
        "config",
        "--replace-all",
        "remote.origin.fetch",
        "+refs/tags/v0.9.0:refs/tags/v0.9.0",
      );
      const updated = runInstaller("update-recorded", [], env, { sourceDir: false });
      expect(updated.status, updated.output).toBe(0);
      expect(updates(updated)).toEqual(["update --yes"]);
      // The installer names the checkout by its resolved path (macOS keeps its
      // temporary directory behind the /var -> /private/var link).
      expect(updated.output).toContain(
        `Checkout:  ${realpathSync(fixturePath("checkout-update-recorded"))}`,
      );
      expect(checkoutGit("update-recorded", "config", "--get-all", "remote.origin.fetch")).toBe(
        "+refs/heads/main:refs/remotes/origin/main",
      );
      expect(existsSync(join(updated.home, "omnesis"))).toBe(false);
    });

    test("a different role on a machine with services runs the full install", () => {
      installFirst("update-demote");
      const client = runInstaller("update-demote", ["--client-only", "--no-keyring"], env);
      expect(client.status, client.output).toBe(0);
      expect(updates(client)).toEqual([]);
      expect(client.output).not.toContain("update of this machine's existing install");

      const collector = runInstaller("update-demote", ["--collector"], env);
      expect(updates(collector)).toEqual([]);
      expect(collector.output).not.toContain("update of this machine's existing install");
    });

    test("a first install that never registered its services runs in full again", () => {
      const first = runInstaller("update-unfinished", firstArgs, env);
      expect(first.status, first.output).toBe(0);
      const again = runInstaller("update-unfinished", ["--no-tls", "--no-model"], env);
      expect(again.status, again.output).toBe(0);
      expect(updates(again)).toEqual([]);
      expect(again.calls.some((c) => c.startsWith("service install"))).toBe(true);
    });

    test("a role change runs the full install for the new role", () => {
      installFirst("update-role", ["--client-only", "--no-keyring", "--version", "0.9.0"], []);
      const gateway = runInstaller("update-role", ["--no-tls", "--no-model"], env);
      expect(gateway.status, gateway.output).toBe(0);
      expect(updates(gateway)).toEqual([]);
      expect(gateway.calls.some((c) => c.startsWith("service install"))).toBe(true);
    });

    test("--reconfigure runs the full install and restarts the services it had", () => {
      installFirst("update-reconfigure");
      const full = runInstaller(
        "update-reconfigure",
        ["--reconfigure", "--no-tls", "--no-model", "--version", "0.9.0"],
        env,
      );
      expect(full.status, full.output).toBe(0);
      expect(full.output).not.toContain("update of this machine's existing install");
      expect(updates(full)).toEqual([]);
      expect(full.calls.some((c) => c.startsWith("service install"))).toBe(true);
      expect(full.output).toContain("Restarting the gateway on its refreshed service definition");
      expect(restarts(full)).toEqual(["service restart gateway", "service restart collector"]);
    });

    // Every device paired on another machine stored the old port, and a
    // remote collector's unit carries it: moving the gateway strands them
    // unless the operator is told which, and what points each at the new one.
    describe("--port moving a gateway with paired devices", () => {
      const device = (id, kind, name, extra = {}) => ({
        id: `00000000-0000-4000-8000-00000000000${id}`,
        kind,
        name,
        revokedAt: null,
        online: false,
        ...extra,
      });
      const devices = {
        items: [
          device(1, "cli", "bootstrap"),
          device(2, "collector", "studio-northstar-collector", { online: true }),
          device(3, "collector", "riverside-collector", { online: true }),
          device(4, "collector", "retired-collector", { revokedAt: 1 }),
          device(5, "portal", "portal-session"),
          device(6, "ios", "Maya's iPhone"),
        ],
      };
      const moveArgs = ["--no-tls", "--no-model", "--port", "7601", "--version", "0.9.0"];
      const installWithCollector = (name) => {
        const first = installFirst(name);
        writeFileSync(
          join(first.configDir, "collector-pairing-state.json"),
          JSON.stringify({ state: "paired", deviceName: "studio-northstar-collector" }),
        );
        return first;
      };

      test("names each one before the move, and the banner says how to bring it back", () => {
        installWithCollector("port-move");
        const moved = runInstaller("port-move", moveArgs, {
          ...env,
          OMNESIS_TEST_DEVICES_JSON: JSON.stringify(devices),
        });
        expect(moved.status, moved.output).toBe(0);
        const out = moved.output;
        // Read while the gateway still answers on its old port.
        expect(moved.calls.indexOf("devices list --json")).toBeLessThan(
          moved.calls.findIndex((c) => c.startsWith("service install")),
        );
        expect(out).toContain(
          "Moving the gateway from port 7600 to 7601. These paired devices keep dialling port 7600",
        );
        expect(out).toContain(`riverside-collector (collector, ${devices.items[2].id})`);
        expect(out).toContain(`Maya's iPhone (ios, ${devices.items[5].id})`);
        // Not this machine's own collector, which follows; not a CLI token, a
        // portal session, or a device already revoked.
        for (const name of [
          "bootstrap",
          "studio-northstar-collector",
          "retired-collector",
          "portal-session",
        ]) {
          expect(out).not.toContain(`${name} (`);
          expect(out).not.toContain(`Collector ${name}`);
        }
        expect(out).toContain("Point paired devices at port 7601");
        expect(out).toContain("Collector riverside-collector");
        expect(out).toContain(`omnesis devices repair ${devices.items[2].id}\n`);
        expect(out).toMatch(
          /sh -s -- --collector \\\n\s+--gateway-url https:\/\/[^\s]+:7601 \\\n(\s+--trust-fingerprint sha256:[0-9a-f]{64} \\\n)?\s+--code <repair code>/,
        );
        expect(out).toMatch(
          new RegExp(
            `omnesis devices repair ${devices.items[5].id} --gateway-url https://\\S+:7601`,
          ),
        );
      });

      test("says so when the device list cannot be read", () => {
        installWithCollector("port-move-unread");
        const moved = runInstaller("port-move-unread", moveArgs, env);
        expect(moved.status, moved.output).toBe(0);
        expect(moved.output).toContain("Its paired devices could not be listed");
        expect(moved.output).toContain("omnesis devices repair <device> --gateway-url");
      });

      test("says nothing when no other device is paired, or the port does not change", () => {
        installWithCollector("port-move-alone");
        const alone = runInstaller("port-move-alone", moveArgs, {
          ...env,
          OMNESIS_TEST_DEVICES_JSON: JSON.stringify({ items: devices.items.slice(0, 2) }),
        });
        expect(alone.status, alone.output).toBe(0);
        expect(alone.output).not.toContain("Moving the gateway");
        expect(alone.output).not.toContain("Point paired devices");

        const again = runInstaller("port-move-alone", moveArgs, {
          ...env,
          OMNESIS_TEST_DEVICES_JSON: JSON.stringify(devices),
        });
        expect(again.status, again.output).toBe(0);
        expect(again.calls).not.toContain("devices list --json");
        expect(again.output).not.toContain("Point paired devices");
      });
    });
  });

  test("--no-modify-path prints the PATH line and leaves the shell profile alone", () => {
    const run = runInstaller(
      "exec-no-modify",
      ["--no-tls", "--no-modify-path", "--embedder", EMBED_IDS[1]],
      {
        OMNESIS_TEST_KEYRING: "ready",
      },
    );
    expect(run.status).toBe(0);
    const bin = join(run.home, ".local", "bin");
    expect(run.output).toContain(`${bin} is not on your PATH`);
    expect(run.output).toContain(
      `echo 'export PATH="${bin}:$PATH"' >> ${join(run.home, ".zshrc")}`,
    );
    expect(existsSync(join(run.home, ".zshrc"))).toBe(false);
  });

  test("a supervisor that refuses leaves the operator with working instructions", () => {
    const run = runInstaller("exec-degrade", ["--no-tls", "--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
      OMNESIS_TEST_FAIL: "service install",
    });
    expect(run.status).toBe(0);
    expect(run.output).toContain("Service registration failed");
    expect(run.output).toContain("omnesis gateway serve");
    expect(run.calls.some((c) => c.startsWith("model install"))).toBe(false);
  });

  test("wires the passphrase keyring into the unit when one was armed", () => {
    const passFile = fixturePath("keyring.pass");
    writeFileSync(passFile, "test-passphrase\n");
    const run = runInstaller(
      "passphrase",
      ["--no-tls", "--embedder", EMBED_IDS[0], "--keyring-passphrase-file", passFile],
      { OMNESIS_TEST_KEYRING: "locked" },
    );

    expect(run.status).toBe(0);
    const install = callStartingWith(run.calls, "service install");
    expect(install).toContain("--secret-store passphrase");
    expect(install).toContain(passFile);
    expect(run.calls).toContain("keyring init --backend passphrase");
    // The operator's own CLI has to reach the same passphrase.
    expect(run.envFile()).toContain("OMNESIS_SECRET_STORE=passphrase");
    expect(run.envFile()).toContain(`OMNESIS_KEYRING_PASSPHRASE_FILE=${passFile}`);
  });
});

describe("install.sh workspace build", () => {
  test("gives the build a heap sized from the machine rather than Node's guess", () => {
    // `tsc --build` across every project reference outgrows the ~2 GB Node
    // settles on when it cannot see the real memory, and dies on a host that
    // had plenty. Three machines, stated rather than inherited from whichever
    // one runs the suite.
    const sized = (name, memoryMb) => {
      const run = runInstaller(name, ["--no-tls", "--embedder", EMBED_IDS[0]], {
        OMNESIS_TEST_KEYRING: "ready",
        OMNESIS_BUILD_MEMORY_MB: String(memoryMb),
      });
      expect(run.status).toBe(0);
      return callStartingWith(run.calls, "build NODE_OPTIONS=").replace("build NODE_OPTIONS=", "");
    };

    // A 4 GB host still gets the 3 GB the build needs to finish, and pages.
    expect(sized("build-heap-small", 4096)).toBe("--max-old-space-size=3072");
    // The reported case — a container with room the build never claimed.
    expect(sized("build-heap-container", 8192)).toBe("--max-old-space-size=4096");
    // A workstation: capped, not half of everything.
    expect(sized("build-heap-large", 131_072)).toBe("--max-old-space-size=8192");
  });

  test("a machine too small to build from source is refused before anything is installed", () => {
    const run = runInstaller("build-too-small", ["--no-tls", "--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
      OMNESIS_BUILD_MEMORY_MB: "2048",
    });
    expect(run.status).toBe(1);
    expect(run.output).toMatch(
      /building omnesis from source needs about 3\.5 gb of memory, and this machine can use 2048 mb\./i,
    );
    expect(run.output).toContain("OMNESIS_BUILD_MEMORY_MB=4096");
    expect(run.calls.some((c) => c.startsWith("build NODE_OPTIONS="))).toBe(false);
    expect(existsSync(join(run.home, "omnesis"))).toBe(false);
  });

  // npm's own downloads and install scripts fail now and then on their own
  // (a dropped connection, an install-script binary still open for writing).
  test("a dependency install that fails once is retried, and the build still runs", () => {
    const run = runInstaller("npm-ci-retry", ["--no-tls", "--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
      OMNESIS_TEST_NPM_CI_FAILURES: "1",
    });
    expect(run.status).toBe(0);
    expect(run.calls.filter((c) => c === "npm ci")).toHaveLength(2);
    expect(run.calls.some((c) => c.startsWith("build NODE_OPTIONS="))).toBe(true);
    expect(run.output).toMatch(/installing dependencies failed.*trying once more/i);
  });

  // A first attempt that died part-way leaves a tree a second `npm ci` does not
  // fully replace: it reports success while packages are left without the
  // declaration files their tarballs ship, so the build fails TS7016 and fails
  // the same way on every later run (meth-042). The build-failure message
  // tells the operator to remove node_modules by hand; the retry should not need
  // to be told. Observed for real on 17 Sep: `npm ci` took a SIGBUS core dump and
  // the installer retried straight into the wreckage.
  // The other half of the same wreckage, and the one forge I21 hit on 24 Sep:
  // the interrupted run was a *previous* invocation, so this run's `npm ci`
  // finds the tree complete enough to leave alone and the build fails TS7016
  // on a package missing the files its tarball ships. Re-running the installer
  // is the documented recovery, so it has to be one.
  test("a build that fails on an inherited tree reinstalls it and builds again", () => {
    const run = runInstaller("build-retry", ["--no-tls", "--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
      OMNESIS_TEST_NPM_BUILD_FAILURES: "1",
    });
    expect(run.status).toBe(0);
    // One npm ci for the install, a second because the build failed on it.
    expect(run.calls.filter((c) => c === "npm ci")).toHaveLength(2);
    expect(run.calls.filter((c) => c.startsWith("build NODE_OPTIONS="))).toHaveLength(2);
    expect(run.output).toMatch(/reinstalling them from scratch and building once more/i);
  });

  test("a build that fails again after a clean reinstall stops, and says it is not the tree", () => {
    const run = runInstaller("build-retry-twice", ["--no-tls", "--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
      OMNESIS_TEST_NPM_BUILD_FAILURES: "2",
    });
    expect(run.status).not.toBe(0);
    // Exactly one extra attempt: a loop here would reinstall for ever.
    expect(run.calls.filter((c) => c === "npm ci")).toHaveLength(2);
    expect(run.calls.filter((c) => c.startsWith("build NODE_OPTIONS="))).toHaveLength(2);
    expect(run.output).toMatch(/reinstalled from scratch first/i);
    expect(run.output).toMatch(/this is the code or this machine/i);
  });

  // A run whose own `npm ci` already rebuilt the tree from empty has nothing
  // left to try, and must not reinstall a second time on a build failure.
  test("a build failure after the dependency retry does not reinstall again", () => {
    const run = runInstaller(
      "build-retry-after-ci-retry",
      ["--no-tls", "--embedder", EMBED_IDS[0]],
      {
        OMNESIS_TEST_KEYRING: "ready",
        OMNESIS_TEST_NPM_CI_FAILURES: "1",
        OMNESIS_TEST_NPM_BUILD_FAILURES: "1",
      },
    );
    expect(run.status).not.toBe(0);
    expect(run.calls.filter((c) => c === "npm ci")).toHaveLength(2);
    expect(run.calls.filter((c) => c.startsWith("build NODE_OPTIONS="))).toHaveLength(1);
    expect(run.output).not.toMatch(/reinstalling them from scratch/i);
  });

  test("the dependency retry starts from an empty node_modules", () => {
    const run = runInstaller("npm-ci-retry-clears", ["--no-tls", "--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
      OMNESIS_TEST_NPM_CI_FAILURES: "1",
    });
    expect(run.status).toBe(0);
    expect(run.calls.filter((c) => c === "npm ci")).toHaveLength(2);
    // The failing attempt planted this; a retry that cleared the tree removed it.
    const partial = join(
      fixturePath(`checkout-npm-ci-retry-clears`),
      "node_modules",
      ".omnesis-partial-tree",
    );
    expect(existsSync(partial)).toBe(false);
    // And the tree the successful attempt built is there.
    expect(
      existsSync(join(fixturePath(`checkout-npm-ci-retry-clears`), "node_modules", ".bin", "tsx")),
    ).toBe(true);
  });

  test("a dependency install that fails twice stops with what failed and that re-running continues", () => {
    const run = runInstaller("npm-ci-fails", ["--no-tls", "--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
      OMNESIS_TEST_NPM_CI_FAILURES: "2",
    });
    expect(run.status).toBe(1);
    expect(run.calls.filter((c) => c === "npm ci")).toHaveLength(2);
    expect(run.calls.some((c) => c.startsWith("build NODE_OPTIONS="))).toBe(false);
    expect(run.output).toMatch(/installing dependencies failed twice/i);
    expect(run.output).toMatch(
      /re-run this installer and it continues from the checkout it already made/i,
    );
  });

  // The kernel's out-of-memory kill leaves no error of its own to read.
  test("a build the kernel killed says the machine most likely ran out of memory", () => {
    const run = runInstaller("build-killed", ["--no-tls", "--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
      OMNESIS_TEST_NPM_BUILD_EXIT: "137",
    });
    expect(run.status).toBe(1);
    expect(run.output).toMatch(
      /the build was killed, most likely because this machine ran out of memory/i,
    );
    expect(run.output).toMatch(
      /stop the omnesis collector and gateway if they run here, add swap/i,
    );
    expect(run.output).not.toContain("its error is above");
  });

  test("a dependency install killed twice says the same, and a build that fails on its own does not", () => {
    const killed = runInstaller("npm-ci-killed", ["--no-tls", "--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
      OMNESIS_TEST_NPM_CI_FAILURES: "2",
      OMNESIS_TEST_NPM_CI_EXIT: "137",
    });
    expect(killed.status).toBe(1);
    expect(killed.output).toMatch(
      /installing dependencies was killed, most likely because this machine ran out of memory/i,
    );

    const failed = runInstaller("build-fails", ["--no-tls", "--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
      OMNESIS_TEST_NPM_BUILD_EXIT: "2",
    });
    expect(failed.status).toBe(1);
    expect(failed.output).toContain("The build failed — its error is above.");
    expect(failed.output).not.toMatch(/ran out of memory/i);
    // A killed `npm ci` leaves a node_modules that a later `npm ci` does not
    // fully replace: it reports success while the tree stays incomplete, so a
    // build fails here and fails the same way on every re-run. Removing the
    // tree is the repair, and the installer now performs it rather than
    // printing it — so a build that keeps failing has already had that done.
    expect(failed.output).toMatch(/reinstalling them from scratch/i);
    expect(failed.output).toMatch(/reinstalled from scratch first/i);
    expect(failed.output).not.toMatch(/remove .*node_modules/i);
  });

  test("an operator's own heap setting is left exactly as they wrote it", () => {
    const run = runInstaller("build-heap-operator", ["--no-tls", "--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
      NODE_OPTIONS: "--max-old-space-size=512",
    });
    expect(run.status).toBe(0);
    expect(run.calls).toContain("build NODE_OPTIONS=--max-old-space-size=512");
  });
});

describe("install.sh gateway URL", () => {
  test("a Tailscale certificate wins over localhost on a non-default port", () => {
    installFakeTailscale("workstation.example-tailnet.ts.net");
    const run = runInstaller("tailscale", ["--port", "8443", "--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
    });

    expect(run.status).toBe(0);
    expect(run.output).toContain("Certificate installed");
    expect(run.output).not.toContain("A Tailscale certificate needs MagicDNS");
    expect(run.output).not.toContain("Nothing on your tailnet was changed");
    const env = run.envFile();
    expect(env).toContain("OMNESIS_GATEWAY_PORT=8443");
    expect(env).toContain("OMNESIS_GATEWAY_URL=https://workstation.example-tailnet.ts.net:8443");
    expect(env).toContain(
      "OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN=https://workstation.example-tailnet.ts.net:8443",
    );
    expect(env).not.toContain("https://localhost:8443");
  });

  test("a Tailscale origin on the default HTTPS port is canonical", () => {
    installFakeTailscale("workstation.example-tailnet.ts.net");
    const run = runInstaller(
      "tailscale-https-port",
      ["--port", "443", "--embedder", EMBED_IDS[0]],
      {
        OMNESIS_TEST_KEYRING: "ready",
      },
    );

    expect(run.status).toBe(0);
    expect(run.envFile()).toContain(
      "OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN=https://workstation.example-tailnet.ts.net\n",
    );
    expect(run.envFile()).toContain(
      "OMNESIS_GATEWAY_URL=https://workstation.example-tailnet.ts.net\n",
    );
    expect(run.envFile()).not.toContain(":443");
  });

  test("a certificate minted on a later run replaces the URL the earlier one wrote", () => {
    // First install: no tailnet, so .env names localhost.
    installAbsentTailscale();
    const first = runInstaller("url-rerun", ["--port", "8443", "--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
    });
    expect(first.status).toBe(0);
    expect(first.envFile()).toContain("OMNESIS_GATEWAY_URL=https://localhost:8443");

    // Re-run with Tailscale up: the certificate now covers only the MagicDNS
    // name, so the stale localhost URL would fail the handshake.
    installFakeTailscale("workstation.example-tailnet.ts.net");
    const second = runInstaller("url-rerun", ["--port", "8443", "--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
    });
    expect(second.status).toBe(0);
    expect(second.envFile()).toContain(
      "OMNESIS_GATEWAY_URL=https://workstation.example-tailnet.ts.net:8443",
    );
    expect(second.envFile()).toContain(
      "OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN=https://workstation.example-tailnet.ts.net:8443",
    );
    expect(second.envFile()).not.toContain("https://localhost:8443");
    // Rewriting one key must not take the rest of the file with it.
    expect(second.envFile()).toContain("OMNESIS_GATEWAY_PORT=8443");
    expect(second.envFile()).toContain("OMNESIS_TLS_CERT=");
  });

  test("a port change keeps the installer-owned Tailscale trust origin aligned", () => {
    installFakeTailscale("workstation.example-tailnet.ts.net");
    const first = runInstaller("tailscale-port-rerun", ["--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
    });
    expect(first.status).toBe(0);

    installAbsentTailscale();
    const rerun = runInstaller(
      "tailscale-port-rerun",
      ["--port", "8443", "--embedder", EMBED_IDS[0]],
      { OMNESIS_TEST_KEYRING: "ready" },
    );
    expect(rerun.status).toBe(0);
    const env = rerun.envFile();
    expect(env).toContain("OMNESIS_GATEWAY_URL=https://workstation.example-tailnet.ts.net:8443");
    expect(env).toContain(
      "OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN=https://workstation.example-tailnet.ts.net:8443",
    );
    expect(env).not.toContain("https://workstation.example-tailnet.ts.net:7600");
    expect(rerun.output).toContain(
      "Tailscale is unavailable — keeping the existing Tailscale certificate",
    );
  });

  test("a temporary Tailscale outage preserves the proven origin", () => {
    installFakeTailscale("workstation.example-tailnet.ts.net");
    const first = runInstaller("tailscale-offline-rerun", ["--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
    });
    expect(first.status).toBe(0);

    installAbsentTailscale();
    const rerun = runInstaller("tailscale-offline-rerun", ["--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
    });
    expect(rerun.status).toBe(0);
    expect(rerun.envFile()).toContain(
      "OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN=https://workstation.example-tailnet.ts.net:7600",
    );
    expect(rerun.output).toContain(
      "Tailscale is unavailable — keeping the existing Tailscale certificate",
    );
    expect(rerun.output).not.toContain("will use its self-signed certificate");
  });

  test("a failed Tailscale renewal preserves the previously proven origin", () => {
    installFakeTailscale("workstation.example-tailnet.ts.net");
    const first = runInstaller("tailscale-renewal-rerun", ["--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
    });
    expect(first.status).toBe(0);

    installFailingTailscale("workstation.example-tailnet.ts.net");
    const rerun = runInstaller("tailscale-renewal-rerun", ["--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
    });
    expect(rerun.status).toBe(0);
    expect(rerun.envFile()).toContain(
      "OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN=https://workstation.example-tailnet.ts.net:7600",
    );
    expect(rerun.output).toContain("tailscale cert renewal failed");
    expect(rerun.output).toContain("Keeping the existing Tailscale certificate");
    expect(rerun.output).toContain("Nothing on your tailnet was changed");
    expect(rerun.output).not.toContain("A Tailscale certificate needs MagicDNS");
    expect(rerun.output).not.toContain("Continuing with the self-signed cert");
  });

  test("a self-signed fallback removes stale installer-owned system trust", () => {
    installFakeTailscale("workstation.example-tailnet.ts.net");
    const first = runInstaller("tailscale-removed-rerun", ["--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
    });
    expect(first.status).toBe(0);
    const envPath = join(first.configDir, ".env");
    writeFileSync(
      envPath,
      first
        .envFile()
        .split("\n")
        .filter((line) => !line.startsWith("OMNESIS_TLS_"))
        .join("\n"),
    );

    installAbsentTailscale();
    const rerun = runInstaller("tailscale-removed-rerun", ["--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
    });
    expect(rerun.status).toBe(0);
    expect(rerun.envFile()).not.toContain("OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN");
    expect(rerun.output).toContain("will use its self-signed certificate");
  });

  test("a first Tailscale certificate failure removes stale system trust", () => {
    installAbsentTailscale();
    const first = runInstaller("tailscale-first-failure", ["--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
    });
    const envPath = join(first.configDir, ".env");
    writeFileSync(
      envPath,
      `${first.envFile()}OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN=https://stale.example.org:7600\n`,
    );

    installFailingTailscale("workstation.example-tailnet.ts.net");
    const rerun = runInstaller("tailscale-first-failure", ["--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
    });
    expect(rerun.status).toBe(0);
    expect(rerun.envFile()).not.toContain("OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN");
    expect(rerun.output).toContain("Continuing with the self-signed cert");
    expect(rerun.output).not.toContain("A Tailscale certificate needs MagicDNS");
    // The fix is the operator's: tailnet settings, and on Linux the operator permission.
    expect(rerun.output).toContain("Nothing on your tailnet was changed");
    expect(rerun.output).toContain("Then run: omnesis tls provision");
    if (process.platform === "linux") {
      expect(rerun.output).toContain("sudo tailscale set --operator=$USER");
    }
  });

  // tailscaled issues certificates only to root or to the account named as this
  // machine's Tailscale operator. The gateway runs as the installing account and
  // renews the certificate itself, so the permission — not a one-off sudo — is
  // what makes a tailnet certificate work past its first 90 days. The installer
  // takes it only on Linux, the one platform where tailscaled asks for it.
  test.skipIf(process.platform !== "linux")(
    "a certificate refused for want of the operator permission is taken once, then minted",
    () => {
      installFakeSudo();
      const { operatorFlag } = installDenyingTailscale("workstation.example-tailnet.ts.net");
      const run = runInstaller("tailscale-operator", ["--embedder", EMBED_IDS[0]], {
        OMNESIS_TEST_KEYRING: "ready",
      });

      expect(run.status).toBe(0);
      expect(run.output).toContain("asking for the Tailscale operator permission on this machine");
      expect(run.output).toContain("nothing on your tailnet changed");
      expect(run.output).toContain("Certificate installed");
      // Taken for the account that runs the gateway, and taken exactly once.
      const granted = run.calls.filter((call) => call.startsWith("sudo tailscale set --operator="));
      expect(granted).toEqual([`sudo tailscale set --operator=${userInfo().username}`]);
      expect(readFileSync(operatorFlag, "utf8")).toBe(userInfo().username);
      const env = run.envFile();
      expect(env).toContain("OMNESIS_TLS_CERT=");
      expect(env).toContain("OMNESIS_GATEWAY_URL=https://workstation.example-tailnet.ts.net:7600");
      expect(env).toContain(
        "OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN=https://workstation.example-tailnet.ts.net:7600",
      );
      expect(run.output).not.toContain("Nothing on your tailnet was changed");
    },
  );

  test("a certificate refused for any other reason is reported, not worked around", () => {
    installFakeSudo();
    installDenyingTailscale("workstation.example-tailnet.ts.net", "", {
      reason: "HTTPS is not enabled on your tailnet",
    });
    const run = runInstaller("tailscale-other-failure", ["--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
    });

    expect(run.status).toBe(0);
    // The reason tailscaled gave, not a guess at it.
    expect(run.output).toContain("tailscale cert failed: HTTPS is not enabled on your tailnet");
    expect(run.output).toContain("Continuing with the self-signed cert");
    expect(run.output).toContain("Nothing on your tailnet was changed");
    expect(run.calls.filter((call) => call.startsWith("sudo tailscale set"))).toEqual([]);
    expect(run.envFile()).not.toContain("OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN");
  });

  test.skipIf(process.platform !== "linux")(
    "without the privilege to take the permission, the installer names it and changes nothing",
    () => {
      // No installFakeSudo(): the fixture's default `sudo` refuses, as it does for
      // an account that cannot run it.
      installDenyingTailscale("workstation.example-tailnet.ts.net");
      const run = runInstaller("tailscale-no-sudo", ["--embedder", EMBED_IDS[0]], {
        OMNESIS_TEST_KEYRING: "ready",
      });

      expect(run.status).toBe(0);
      expect(run.output).toContain("Could not take the Tailscale operator permission");
      // Whatever sudo itself said has to reach the operator. Hiding its stderr
      // also hides its password prompt, and an installer waiting on a prompt
      // nobody can see reads as a hang on any machine whose sudo asks for one.
      expect(run.output).toContain("sudo: a password is required");
      expect(run.output).toContain("tailscale cert failed: Access denied: cert access denied");
      expect(run.output).toContain("Continuing with the self-signed cert");
      expect(run.output).toContain("Nothing on your tailnet was changed");
      expect(run.envFile()).not.toContain("tailscale.crt");
    },
  );

  test("a missing MagicDNS name removes stale system trust", () => {
    installAbsentTailscale();
    const first = runInstaller("tailscale-no-magicdns", ["--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
    });
    const envPath = join(first.configDir, ".env");
    writeFileSync(
      envPath,
      `${first.envFile()}OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN=https://stale.example.org:7600\n`,
    );

    installTailscaleWithoutMagicDns();
    const rerun = runInstaller("tailscale-no-magicdns", ["--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
    });
    expect(rerun.status).toBe(0);
    expect(rerun.envFile()).not.toContain("OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN");
    expect(rerun.output).toContain(
      "Tailscale reported no MagicDNS name — continuing with the self-signed certificate",
    );
    expect(rerun.output).toContain("A Tailscale certificate needs MagicDNS");
  });

  test("localhost is the fallback when no named certificate was minted", () => {
    installAbsentTailscale();
    const run = runInstaller("localhost", ["--port", "8443", "--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
    });

    expect(run.status).toBe(0);
    expect(run.envFile()).toContain("OMNESIS_GATEWAY_URL=https://localhost:8443");
    // What a trusted certificate would take is named; nothing is joined or changed for the user.
    expect(run.output).toContain("enable HTTPS certificates and MagicDNS");
    expect(run.output).toContain("The installer never joins a network or changes tailnet settings");
    // On the self-signed default the browser step says what to provision first.
    expect(run.output).toContain("Connect your browser (optional)");
    expect(run.output).toContain("serves a self-signed");
    expect(run.output).toContain("omnesis tls provision");
  });
});

describe("install.sh embedding model question", () => {
  test("--embedder and OMNESIS_EMBEDDER_ID skip the question", () => {
    const flag = runInstaller("embed-flag", ["--no-tls", "--embedder", EMBED_IDS[2]], {
      OMNESIS_TEST_KEYRING: "ready",
    });
    expect(flag.status).toBe(0);
    expect(flag.calls).toContain(`model install ${EMBED_IDS[2]}`);
    expect(flag.calls.some((c) => c.startsWith("model catalog"))).toBe(false);

    const env = runInstaller("embed-env", ["--no-tls"], {
      OMNESIS_TEST_KEYRING: "ready",
      OMNESIS_EMBEDDER_ID: EMBED_IDS[1],
    });
    expect(env.status).toBe(0);
    expect(env.calls).toContain(`model install ${EMBED_IDS[1]}`);
  });

  test("--no-model skips both the question and the download", () => {
    const run = runInstaller("embed-none", ["--no-tls", "--no-model"], {
      OMNESIS_TEST_KEYRING: "ready",
    });
    expect(run.status).toBe(0);
    expect(run.calls.some((c) => c.startsWith("model install"))).toBe(false);
    expect(run.output).toContain("--no-model");
  });

  test("--embedder contradicts --no-model", () => {
    const run = runInstaller("embed-conflict", ["--no-model", "--embedder", EMBED_IDS[0]]);
    expect(run.status).toBe(1);
    expect(run.output).toContain("cannot be combined with --no-model");
  });

  test("an exported model id loses quietly to a command line that wants none", () => {
    // The environment is ambient; the flag is a statement of intent. Only the
    // flag contradicts --no-model.
    const run = runInstaller("embed-env-clash", ["--client-only", "--no-keyring"], {
      OMNESIS_EMBEDDER_ID: EMBED_IDS[1],
    });
    expect(run.status).toBe(0);
    expect(run.calls.some((c) => c.startsWith("model install"))).toBe(false);
  });

  test.skipIf(!HAS_PTY)("an unreadable catalog says which model it fell back to", () => {
    writeFileSync(fixturePath("empty-catalog.json"), `${JSON.stringify({ entries: [] })}\n`);
    const run = runInstallerOnTty("embed-nocatalog", ["--no-tls"], [""], {
      OMNESIS_TEST_KEYRING: "ready",
      OMNESIS_TEST_CATALOG: fixturePath("empty-catalog.json"),
    });
    expect(run.status).toBe(0);
    expect(run.output).toContain("Could not read the model catalog");
    expect(run.output).toContain(EMBED_IDS[0]);
    expect(run.calls).toContain(`model install ${EMBED_IDS[0]}`);
  });

  test("an embedder served from elsewhere is left alone with no terminal to ask on", () => {
    // The question would have nothing to offer, so a headless run must not
    // refuse: there is no choice to make.
    writeFileSync(
      fixturePath("fake-bin", "omnesis"),
      `#!/bin/sh\nexec "${fixturePath("cli-shim.sh")}" entry.ts "$@"\n`,
    );
    chmodSync(fixturePath("fake-bin", "omnesis"), 0o755);
    writeFileSync(
      fixturePath("assigned-catalog.json"),
      `${JSON.stringify({ ...CATALOG_FIXTURE, assignedId: "local-backend/some-embedder" })}\n`,
    );
    const run = runInstaller("embed-assigned-notty", ["--no-tls"], {
      OMNESIS_TEST_KEYRING: "ready",
      OMNESIS_TEST_CATALOG: fixturePath("assigned-catalog.json"),
    });
    expect(run.status).toBe(0);
    expect(run.output).toContain("local-backend/some-embedder is already assigned");
    expect(run.calls.some((c) => c.startsWith("model install"))).toBe(false);
  });

  test.skipIf(!HAS_PTY)("an embedder served from elsewhere is left alone", () => {
    // The catalog reports an assignment it does not contain — a model served
    // by an HTTP backend. Nothing to download, nothing to ask.
    writeFileSync(
      fixturePath("assigned-catalog.json"),
      `${JSON.stringify({ ...CATALOG_FIXTURE, assignedId: "local-backend/some-embedder" })}\n`,
    );
    const run = runInstallerOnTty("embed-assigned", ["--no-tls"], [], {
      OMNESIS_TEST_KEYRING: "ready",
      OMNESIS_TEST_CATALOG: fixturePath("assigned-catalog.json"),
    });
    expect(run.status).toBe(0);
    expect(run.output).toContain("local-backend/some-embedder is already assigned");
    expect(run.output).not.toContain("Which embedding model");
    expect(run.calls.some((c) => c.startsWith("model install"))).toBe(false);
  });

  test.skipIf(!HAS_PTY)("the chosen model survives into the manual next step", () => {
    const run = runInstallerOnTty("embed-noservice", ["--no-tls", "--no-service"], ["2"], {
      OMNESIS_TEST_KEYRING: "ready",
    });
    expect(run.status).toBe(0);
    expect(run.output).toContain(`omnesis model install ${EMBED_IDS[1]}`);
    expect(run.calls.some((c) => c.startsWith("service install"))).toBe(false);
  });

  test("a run with no terminal refuses instead of picking a model for you", () => {
    const run = runInstaller("embed-notty", ["--no-tls"], { OMNESIS_TEST_KEYRING: "ready" });
    expect(run.status).toBe(1);
    expect(run.output).toContain("No terminal to ask which embedding model");
    expect(run.output).toContain("--embedder <id>");
    expect(run.output).toContain("--no-model");
    // It refused before spending minutes on the clone and build.
    expect(run.calls).toEqual([]);
  });

  test.skipIf(!HAS_PTY)("an empty answer takes the catalog's default", () => {
    const run = runInstallerOnTty("embed-default", ["--no-tls"], [""], {
      OMNESIS_TEST_KEYRING: "ready",
    });
    expect(run.status).toBe(0);
    expect(run.output).toContain("Which embedding model");
    expect(run.calls).toContain(`model install ${EMBED_IDS[0]}`);
  });

  test.skipIf(!HAS_PTY)("a numbered answer picks that catalog entry", () => {
    const run = runInstallerOnTty("embed-pick", ["--no-tls"], ["3"], {
      OMNESIS_TEST_KEYRING: "ready",
    });
    expect(run.status).toBe(0);
    expect(run.calls).toContain(`model install ${EMBED_IDS[2]}`);
  });

  test.skipIf(!HAS_PTY)("an answer outside the list is asked again", () => {
    const run = runInstallerOnTty("embed-retry", ["--no-tls"], ["nine", "99", "2"], {
      OMNESIS_TEST_KEYRING: "ready",
    });
    expect(run.status).toBe(0);
    expect(run.output).toContain("Enter a number between 1 and 3");
    expect(run.calls).toContain(`model install ${EMBED_IDS[1]}`);
  });

  test.skipIf(!HAS_PTY)("an already-installed CLI is asked before the clone", () => {
    // A re-run or an upgrade: the previous install's binary is on PATH, so the
    // catalog is readable up front.
    // The shim drops its first argument, which is the entry file the wrapper
    // passes to tsx; a binary called directly needs that placeholder.
    writeExecutable(
      fixturePath("fake-bin", "omnesis"),
      `#!/bin/sh\nexec "${fixturePath("cli-shim.sh")}" entry.ts "$@"\n`,
    );
    const run = runInstallerOnTty("embed-early", ["--no-tls"], [""], {
      OMNESIS_TEST_KEYRING: "ready",
    });
    expect(run.status).toBe(0);
    expect(run.output.indexOf("Which embedding model")).toBeGreaterThan(-1);
    expect(run.output.indexOf("Which embedding model")).toBeLessThan(
      run.output.indexOf("Cloning stable release"),
    );
  });
});

describe("install.sh second-machine banner", () => {
  test("prints both one-liners with this gateway's URL and fingerprint", () => {
    // Nothing else on the machine knows both, and an operator who has to
    // reconstruct the line by hand tends to reconstruct `install.sh` with no
    // flag at all — which installs a second gateway on the second machine.
    installAbsentTailscale();
    const fingerprint = plantGatewayCert(
      "banner",
      "DNS:localhost, DNS:omnesis.local, DNS:studio-northstar.local, IP:192.0.2.44",
    );
    const run = runInstaller("banner", ["--no-tls", "--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
    });

    expect(run.status).toBe(0);
    expect(run.output).toContain("--collector");
    // The harness line is the other machine this gateway can be joined from,
    // and its code is a different kind than the collector's.
    expect(run.output).toContain("--openclaw");
    expect(run.output).toContain("--hermes for Hermes");
    // `localhost` names no machine but this one; the self-signed certificate
    // covers `omnesis.local`, which is also the name the gateway advertises.
    expect(run.output).toContain("--gateway-url https://omnesis.local:7600");
    expect(run.output).toContain(`--trust-fingerprint sha256:${fingerprint}`);
    expect(run.output).toContain("omnesis devices pair --kind collector");
    expect(run.output).toContain("omnesis devices pair --kind agent");
    expect(run.output).toContain("Settings → Devices");
    // No controlling terminal means no new choice and no persisted override:
    // the existing mDNS fallback remains exactly as it was.
    expect(run.envFile()).not.toContain("OMNESIS_GATEWAY_URL=");
    expect(run.output).not.toContain("Which address should another machine use");
  });

  test.skipIf(!HAS_PTY)(
    "offers only certificate-covered remote addresses and records the pick",
    () => {
      installAbsentTailscale();
      const fingerprint = plantGatewayCert(
        "banner-san-pick",
        [
          "DNS:localhost",
          "DNS:studio.localhost",
          "DNS:gateway",
          "DNS:omnesis.local",
          "DNS:studio-northstar.local",
          "IP:127.0.0.1",
          "IP:192.0.2.44",
          "IP:::1",
          "IP:::ffff:127.0.0.1",
          "IP:::ffff:0.0.0.0",
          "IP:fe90::44",
          "IP:2001:db8::44",
        ].join(", "),
      );
      const run = runInstallerOnTty(
        "banner-san-pick",
        ["--no-tls", "--embedder", EMBED_IDS[0]],
        ["3"],
        { OMNESIS_TEST_KEYRING: "ready" },
      );

      expect(run.status).toBe(0);
      const menuStart = run.output.indexOf("Which address should another machine use");
      const menuEnd = run.output.indexOf("Second-machine address:");
      expect(menuStart).toBeGreaterThan(-1);
      expect(menuEnd).toBeGreaterThan(menuStart);
      const menu = run.output.slice(menuStart, menuEnd);
      expect(menu).toContain("1) https://omnesis.local:7600");
      expect(menu).toContain("2) https://studio-northstar.local:7600");
      expect(menu).toContain("3) https://192.0.2.44:7600");
      expect(menu).toContain("4) https://[2001:db8::44]:7600");
      expect(menu).not.toContain("https://localhost:");
      expect(menu).not.toContain("https://studio.localhost:");
      expect(menu).not.toContain("https://gateway:");
      expect(menu).not.toContain("https://127.0.0.1:");
      expect(menu).not.toContain("fe90");
      expect(menu.match(/\) https:\/\//g)).toHaveLength(4);
      expect(menu).toContain("direct IPs also work where mDNS does not");
      expect(run.envFile()).toContain("OMNESIS_GATEWAY_URL=https://192.0.2.44:7600");
      expect(run.output).toContain("--gateway-url https://192.0.2.44:7600");
      expect(run.output).toContain(`--trust-fingerprint sha256:${fingerprint}`);
    },
  );

  // A certificate minted without the machine's LAN addresses covers no IP, and
  // pairing by an address it does not cover fails the certificate check.
  test.skipIf(!HAS_PTY)("does not suggest direct IPs when the certificate covers none", () => {
    installAbsentTailscale();
    plantGatewayCert(
      "banner-san-no-ip",
      ["DNS:localhost", "DNS:omnesis.local", "DNS:studio-northstar.local", "IP:127.0.0.1"].join(
        ", ",
      ),
    );
    const run = runInstallerOnTty(
      "banner-san-no-ip",
      ["--no-tls", "--embedder", EMBED_IDS[0]],
      ["1"],
      { OMNESIS_TEST_KEYRING: "ready" },
    );

    expect(run.status).toBe(0);
    const menuStart = run.output.indexOf("Which address should another machine use");
    const menuEnd = run.output.indexOf("Second-machine address:");
    expect(menuStart).toBeGreaterThan(-1);
    const menu = run.output.slice(menuStart, menuEnd);
    expect(menu).toContain("1) https://omnesis.local:7600");
    expect(menu).toContain("(* is the default)");
    expect(menu).not.toContain("direct IPs");
  });

  test.skipIf(!HAS_PTY)("an empty self-signed address answer persists the safe default", () => {
    installAbsentTailscale();
    plantGatewayCert("banner-san-default", "DNS:localhost, DNS:omnesis.local, IP:192.0.2.45");
    const run = runInstallerOnTty(
      "banner-san-default",
      ["--no-tls", "--embedder", EMBED_IDS[0]],
      [""],
      { OMNESIS_TEST_KEYRING: "ready" },
    );

    expect(run.status).toBe(0);
    expect(run.envFile()).toContain("OMNESIS_GATEWAY_URL=https://omnesis.local:7600");
    expect(run.output).toContain("--gateway-url https://omnesis.local:7600");
  });

  // The recorded address is also where `omnesis` on this machine reaches the
  // gateway, so the default has to be one this machine resolves. A stock Linux
  // server resolves no `.local` name.
  test.skipIf(!HAS_PTY)(
    "a host that cannot resolve omnesis.local defaults to a direct address it can reach",
    () => {
      installAbsentTailscale();
      installUnresolvableLocalNames();
      plantGatewayCert(
        "banner-san-unresolvable",
        "DNS:localhost, DNS:omnesis.local, IP:192.0.2.47",
      );
      const run = runInstallerOnTty(
        "banner-san-unresolvable",
        ["--no-tls", "--embedder", EMBED_IDS[0]],
        [""],
        { OMNESIS_TEST_KEYRING: "ready" },
      );

      expect(run.status).toBe(0);
      expect(run.output).toMatch(/\*\s+\d+\) https:\/\/192\.0\.2\.47:7600/);
      expect(run.envFile()).toContain("OMNESIS_GATEWAY_URL=https://192.0.2.47:7600");
      expect(run.output).toContain("--gateway-url https://192.0.2.47:7600");
    },
  );

  test.skipIf(!HAS_PTY)(
    "choosing a name this host cannot resolve keeps the choice and warns that local commands will not reach it",
    () => {
      installAbsentTailscale();
      installUnresolvableLocalNames();
      plantGatewayCert(
        "banner-san-unresolvable-pick",
        "DNS:localhost, DNS:omnesis.local, IP:192.0.2.48",
      );
      const run = runInstallerOnTty(
        "banner-san-unresolvable-pick",
        ["--no-tls", "--embedder", EMBED_IDS[0]],
        ["1"],
        { OMNESIS_TEST_KEYRING: "ready" },
      );

      expect(run.status).toBe(0);
      expect(run.envFile()).toContain("OMNESIS_GATEWAY_URL=https://omnesis.local:7600");
      expect(run.output).toMatch(
        /cannot resolve omnesis\.local, so omnesis commands on it will not reach the gateway/i,
      );
    },
  );

  test.skipIf(!HAS_PTY)(
    "a rerun preserves the selected self-signed address without asking again",
    () => {
      installAbsentTailscale();
      plantGatewayCert(
        "banner-san-rerun",
        "DNS:localhost, DNS:omnesis.local, DNS:studio-northstar.local, IP:192.0.2.46",
      );
      const first = runInstallerOnTty(
        "banner-san-rerun",
        ["--no-tls", "--embedder", EMBED_IDS[0]],
        ["3"],
        { OMNESIS_TEST_KEYRING: "ready" },
      );
      expect(first.status).toBe(0);
      expect(first.envFile()).toContain("OMNESIS_GATEWAY_URL=https://192.0.2.46:7600");

      const rerun = runInstallerOnTty(
        "banner-san-rerun",
        ["--no-tls", "--embedder", EMBED_IDS[0]],
        [],
        { OMNESIS_TEST_KEYRING: "ready" },
      );
      expect(rerun.status).toBe(0);
      expect(rerun.output).not.toContain("Which address should another machine use");
      expect(rerun.envFile()).toContain("OMNESIS_GATEWAY_URL=https://192.0.2.46:7600");
      expect(rerun.output).toContain("--gateway-url https://192.0.2.46:7600");
    },
  );

  test.skipIf(!HAS_PTY)("an explicit port change moves the selected address", () => {
    installAbsentTailscale();
    plantGatewayCert(
      "banner-san-port-rerun",
      "DNS:localhost, DNS:omnesis.local, DNS:studio-northstar.local, IP:192.0.2.52",
    );
    const first = runInstallerOnTty(
      "banner-san-port-rerun",
      ["--no-tls", "--embedder", EMBED_IDS[0]],
      ["3"],
      { OMNESIS_TEST_KEYRING: "ready" },
    );
    expect(first.status).toBe(0);
    expect(first.envFile()).toContain("OMNESIS_GATEWAY_URL=https://192.0.2.52:7600");

    const rerun = runInstallerOnTty(
      "banner-san-port-rerun",
      ["--no-tls", "--port", "7601", "--embedder", EMBED_IDS[0]],
      [],
      { OMNESIS_TEST_KEYRING: "ready" },
    );
    expect(rerun.status).toBe(0);
    expect(rerun.output).not.toContain("Which address should another machine use");
    expect(rerun.envFile()).toContain("OMNESIS_GATEWAY_PORT=7601");
    expect(rerun.envFile()).toContain("OMNESIS_GATEWAY_URL=https://192.0.2.52:7601");
    expect(rerun.envFile()).not.toContain("https://192.0.2.52:7600");
    expect(rerun.envFile().match(/OMNESIS_GATEWAY_URL/g)).toHaveLength(1);
    expect(rerun.output).toContain("--gateway-url https://192.0.2.52:7601");
  });

  test.skipIf(!HAS_PTY)("preserves a quoted export-style remote URL", () => {
    const home = prepareHome("banner-san-export");
    plantGatewayCert("banner-san-export");
    writeFileSync(
      join(home, ".config", "omnesis", ".env"),
      'export OMNESIS_GATEWAY_URL="https://gateway.example.org:7600"\n',
    );
    installAbsentTailscale();
    const run = runInstallerOnTty(
      "banner-san-export",
      ["--no-tls", "--embedder", EMBED_IDS[0]],
      [],
      { OMNESIS_TEST_KEYRING: "ready" },
    );

    expect(run.status).toBe(0);
    expect(run.output).not.toContain("Which address should another machine use");
    expect(run.envFile()).toContain(
      'export OMNESIS_GATEWAY_URL="https://gateway.example.org:7600"',
    );
    expect(run.output).toContain("--gateway-url https://gateway.example.org:7600");
  });

  test("fingerprints a certificate configured with quoted export-style dotenv syntax", () => {
    const home = prepareHome("banner-cert-export");
    const fallbackFingerprint = plantGatewayCert("banner-cert-export");
    const { fingerprint, pem } = mintCert("banner-configured-cert", "DNS:gateway.example.org");
    const configuredCert = join(home, ".config", "omnesis", "tls", "configured cert.pem");
    writeFileSync(configuredCert, pem);
    writeFileSync(
      join(home, ".config", "omnesis", ".env"),
      [
        'export OMNESIS_GATEWAY_URL="https://gateway.example.org:7600"',
        `export OMNESIS_TLS_CERT="${configuredCert}"`,
        "",
      ].join("\n"),
    );
    installAbsentTailscale();
    const run = runInstaller("banner-cert-export", ["--no-tls", "--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
    });

    expect(run.status).toBe(0);
    expect(run.output).toContain(`--trust-fingerprint sha256:${fingerprint}`);
    expect(run.output).not.toContain(`--trust-fingerprint sha256:${fallbackFingerprint}`);
  });

  test.skipIf(!HAS_PTY)(
    "replaces non-HTTPS and dotenv loopback variants with the selected remote URL",
    () => {
      const cases = [
        ["ipv4", "https://127.0.1.1:7600", "192.0.2.47"],
        ["ipv6", "https://[0:0:0:0:0:0:0:1]:7600", "192.0.2.48"],
        ["localhost-dot", "https://localhost.:7600", "192.0.2.49"],
        ["subdomain-localhost-dot", "https://studio.localhost.:7600", "192.0.2.50"],
        ["http", "http://gateway.example.org:7600", "192.0.2.51"],
        ["mapped-unspecified", "https://[::ffff:0.0.0.0]:7600", "192.0.2.54"],
        ["link-local", "https://[fe90::60]:7600", "192.0.2.55"],
      ];
      for (const [suffix, loopbackUrl, selectedHost] of cases) {
        const name = `banner-san-loopback-${suffix}`;
        const home = prepareHome(name);
        plantGatewayCert(
          name,
          `DNS:localhost, DNS:omnesis.local, DNS:studio-northstar.local, IP:${selectedHost}`,
        );
        writeFileSync(
          join(home, ".config", "omnesis", ".env"),
          `  export OMNESIS_GATEWAY_URL = "${loopbackUrl}"\n`,
        );
        installAbsentTailscale();
        const run = runInstallerOnTty(name, ["--no-tls", "--embedder", EMBED_IDS[0]], ["3"], {
          OMNESIS_TEST_KEYRING: "ready",
        });

        expect(run.status).toBe(0);
        expect(run.output).toContain("Which address should another machine use");
        expect(run.envFile()).toContain(`OMNESIS_GATEWAY_URL=https://${selectedHost}:7600`);
        expect(run.envFile()).not.toContain(loopbackUrl);
        expect(run.envFile().match(/OMNESIS_GATEWAY_URL/g)).toHaveLength(1);
        expect(run.output).toContain(`--gateway-url https://${selectedHost}:7600`);
      }
    },
  );

  test("a Tailscale certificate makes the banner name the tailnet address", () => {
    // The provisioned certificate, not the gateway's self-signed one, is what
    // the second machine will be shown — .env names it and the banner reads
    // .env, so the fingerprint has to come from that file.
    const { fingerprint, pem } = mintCert("banner-ts-tailscale");
    installFakeTailscale("workstation.example-tailnet.ts.net", pem);
    plantGatewayCert("banner-ts");
    const run = runInstaller("banner-ts", ["--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
    });

    expect(run.status).toBe(0);
    expect(run.output).toContain("--gateway-url https://workstation.example-tailnet.ts.net:7600");
    expect(run.output).toContain(`--trust-fingerprint sha256:${fingerprint}`);
  });

  test.skipIf(!HAS_PTY)(
    "a Tailscale certificate never opens the self-signed address picker",
    () => {
      const { pem } = mintCert("banner-ts-no-picker", "DNS:workstation.example-tailnet.ts.net");
      installFakeTailscale("workstation.example-tailnet.ts.net", pem);
      plantGatewayCert("banner-ts-no-picker");
      const run = runInstallerOnTty("banner-ts-no-picker", ["--embedder", EMBED_IDS[0]], [], {
        OMNESIS_TEST_KEYRING: "ready",
      });

      expect(run.status).toBe(0);
      expect(run.output).not.toContain("Which address should another machine use");
      expect(run.envFile()).toContain(
        "OMNESIS_GATEWAY_URL=https://workstation.example-tailnet.ts.net:7600",
      );
    },
  );

  test("a port-only install still names a host another machine can reach", () => {
    // `--port` writes `https://localhost:<port>` into .env as the local
    // client's URL. localhost resolves everywhere and points at nothing but
    // this machine, so it must never be handed to a second one.
    installAbsentTailscale();
    plantGatewayCert("banner-port");
    const run = runInstaller(
      "banner-port",
      ["--no-tls", "--port", "7601", "--embedder", EMBED_IDS[0]],
      {
        OMNESIS_TEST_KEYRING: "ready",
      },
    );

    expect(run.status).toBe(0);
    expect(run.envFile()).toContain("OMNESIS_GATEWAY_URL=https://localhost:7601");
    expect(run.output).toContain("--gateway-url https://omnesis.local:7601");
    expect(run.output).not.toContain("--gateway-url https://localhost");
  });

  test("an mkcert install covers the host's remote interface addresses", () => {
    // The install remains deterministic across CI hosts: Node sees invented
    // interfaces, while the fake mkcert installs a real matching certificate.
    installAbsentTailscale();
    const mkcert = installDeterministicMkcertHost("banner-mkcert");
    const run = runInstaller("banner-mkcert", ["--mkcert", "--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
      NODE_OPTIONS: mkcert.nodeOptions,
    });

    expect(run.status).toBe(0);
    expect(readFileSync(mkcert.argsPath, "utf8").trim().split("\n").slice(4)).toEqual([
      "localhost",
      "127.0.0.1",
      "::1",
      "studio-northstar.local",
      "192.0.2.60",
      "2001:db8::60",
    ]);
    expect(run.output).toContain("--gateway-url https://studio-northstar.local:7600");
    expect(run.output).toContain(`--trust-fingerprint sha256:${mkcert.fingerprint}`);
    expect(run.output).toContain("Portal:  https://localhost:7600/portal/");
    // A gateway host is where phones pair; nothing asks for Apple or Google keys.
    expect(run.output).toContain("Pair a phone (optional)");
    expect(run.output).toContain("omnesis devices pair --kind ios");
    expect(run.output).toContain("omnesis push setup");
    // An mkcert certificate is one a browser trusts: the store step, no provisioning detour.
    expect(run.output).toContain("Connect your browser (optional)");
    expect(run.output).toContain(
      "https://chromewebstore.google.com/detail/omnesis-browser-capture/akojepkcdbncipjdonhnnfmjacknplmn",
    );
    expect(run.output).toContain("omnesis devices pair --kind browser");
    expect(run.output).not.toContain("serves a self-signed");
    expect(run.output).not.toContain("Which address should another machine use");
  });

  test.skipIf(process.platform !== "linux")(
    "an mkcert install on a host that cannot resolve its .local name records a direct address",
    () => {
      installAbsentTailscale();
      installUnresolvableLocalNames();
      const mkcert = installDeterministicMkcertHost("banner-mkcert-unresolvable");
      const run = runInstaller(
        "banner-mkcert-unresolvable",
        ["--mkcert", "--embedder", EMBED_IDS[0]],
        {
          OMNESIS_TEST_KEYRING: "ready",
          NODE_OPTIONS: mkcert.nodeOptions,
        },
      );

      expect(run.status).toBe(0);
      expect(run.envFile()).toContain("OMNESIS_GATEWAY_URL=https://192.0.2.60:7600");
      expect(run.output).toContain("--gateway-url https://192.0.2.60:7600");
    },
  );

  test("an mkcert install keeps its fixed names when interfaces cannot be read", () => {
    installAbsentTailscale();
    const preload = fixturePath("mkcert-network-failure.cjs");
    writeFileSync(
      preload,
      'const os = require("node:os");\nos.networkInterfaces = () => { throw new Error("unavailable"); };\n',
    );
    writeExecutable(
      fixturePath("fake-bin", "hostname"),
      "#!/bin/sh\nprintf 'studio-northstar\\n'\n",
    );
    const mkcert = installFakeMkcert(
      "banner-mkcert-network-failure",
      "DNS:localhost, DNS:studio-northstar.local, IP:127.0.0.1, IP:::1",
    );
    const run = runInstaller(
      "banner-mkcert-network-failure",
      ["--mkcert", "--embedder", EMBED_IDS[0]],
      { OMNESIS_TEST_KEYRING: "ready", NODE_OPTIONS: `--require=${preload}` },
    );

    expect(run.status).toBe(0);
    expect(readFileSync(mkcert.argsPath, "utf8").trim().split("\n").slice(4)).toEqual([
      "localhost",
      "127.0.0.1",
      "::1",
      "studio-northstar.local",
    ]);
  });

  test("an mkcert install accepts compressed IPv6 and falls back from an invalid hostname", () => {
    installAbsentTailscale();
    const preload = fixturePath("mkcert-compressed-ipv6.cjs");
    writeFileSync(
      preload,
      `const os = require("node:os");
os.networkInterfaces = () => ({
  ethernet: [{ address: "::ffff:192.0.2.62", family: "IPv6", internal: false }],
});
`,
    );
    writeExecutable(fixturePath("fake-bin", "hostname"), "#!/bin/sh\nprintf '_invalid-host\\n'\n");
    const mkcert = installFakeMkcert(
      "banner-mkcert-compressed-ipv6",
      "DNS:localhost, DNS:omnesis.local, IP:127.0.0.1, IP:::1, IP:::ffff:192.0.2.62",
    );
    const run = runInstaller(
      "banner-mkcert-compressed-ipv6",
      ["--mkcert", "--embedder", EMBED_IDS[0]],
      { OMNESIS_TEST_KEYRING: "ready", NODE_OPTIONS: `--require=${preload}` },
    );

    expect(run.status).toBe(0);
    expect(readFileSync(mkcert.argsPath, "utf8").trim().split("\n").slice(4)).toEqual([
      "localhost",
      "127.0.0.1",
      "::1",
      "omnesis.local",
      "::ffff:192.0.2.62",
    ]);
    expect(run.envFile()).toContain("OMNESIS_GATEWAY_URL=https://omnesis.local:7600");
  });

  test.skipIf(!HAS_PTY)("an mkcert install offers and records a covered direct IP", () => {
    installAbsentTailscale();
    const mkcert = installDeterministicMkcertHost("banner-mkcert-pick");
    const run = runInstallerOnTty(
      "banner-mkcert-pick",
      ["--mkcert", "--embedder", EMBED_IDS[0]],
      ["2"],
      { OMNESIS_TEST_KEYRING: "ready", NODE_OPTIONS: mkcert.nodeOptions },
    );

    expect(run.status).toBe(0);
    const menuStart = run.output.indexOf("Which address should another machine use");
    const menuEnd = run.output.indexOf("Second-machine address:");
    expect(menuStart).toBeGreaterThan(-1);
    expect(menuEnd).toBeGreaterThan(menuStart);
    const menu = run.output.slice(menuStart, menuEnd);
    expect(menu).toContain("1) https://studio-northstar.local:7600");
    expect(menu).toContain("2) https://192.0.2.60:7600");
    expect(menu).toContain("3) https://[2001:db8::60]:7600");
    expect(menu).not.toContain("https://127.0.0.1:");
    expect(menu).not.toContain("fe80");
    expect(run.envFile()).toContain("OMNESIS_GATEWAY_URL=https://192.0.2.60:7600");
    expect(run.output).toContain("--gateway-url https://192.0.2.60:7600");
    expect(run.output).toContain(`--trust-fingerprint sha256:${mkcert.fingerprint}`);

    const rerun = runInstallerOnTty(
      "banner-mkcert-pick",
      ["--mkcert", "--embedder", EMBED_IDS[0]],
      [],
      { OMNESIS_TEST_KEYRING: "ready", NODE_OPTIONS: mkcert.nodeOptions },
    );
    expect(rerun.status).toBe(0);
    expect(rerun.output).not.toContain("Which address should another machine use");
    expect(rerun.envFile()).toContain("OMNESIS_GATEWAY_URL=https://192.0.2.60:7600");
    expect(rerun.envFile().match(/OMNESIS_GATEWAY_URL/g)).toHaveLength(1);
  });

  test.skipIf(!HAS_PTY)("an mkcert rerun preserves a covered IPv6 choice across ports", () => {
    installAbsentTailscale();
    const mkcert = installDeterministicMkcertHost("banner-mkcert-ipv6-rerun");
    const first = runInstallerOnTty(
      "banner-mkcert-ipv6-rerun",
      ["--mkcert", "--embedder", EMBED_IDS[0]],
      ["3"],
      { OMNESIS_TEST_KEYRING: "ready", NODE_OPTIONS: mkcert.nodeOptions },
    );
    expect(first.status).toBe(0);
    expect(first.envFile()).toContain("OMNESIS_GATEWAY_URL=https://[2001:db8::60]:7600");

    const rerun = runInstaller(
      "banner-mkcert-ipv6-rerun",
      ["--mkcert", "--port", "7601", "--embedder", EMBED_IDS[0]],
      { OMNESIS_TEST_KEYRING: "ready", NODE_OPTIONS: mkcert.nodeOptions },
    );
    expect(rerun.status).toBe(0);
    expect(rerun.envFile()).toContain("OMNESIS_GATEWAY_URL=https://[2001:db8::60]:7601");
    expect(rerun.envFile().match(/OMNESIS_GATEWAY_URL/g)).toHaveLength(1);
  });

  test.skipIf(!HAS_PTY)("a later interactive mkcert run still offers a headless default", () => {
    installAbsentTailscale();
    const mkcert = installDeterministicMkcertHost("banner-mkcert-headless-then-tty");
    const first = runInstaller(
      "banner-mkcert-headless-then-tty",
      ["--mkcert", "--embedder", EMBED_IDS[0]],
      { OMNESIS_TEST_KEYRING: "ready", NODE_OPTIONS: mkcert.nodeOptions },
    );
    expect(first.status).toBe(0);
    expect(first.envFile()).toContain("OMNESIS_GATEWAY_URL=https://studio-northstar.local:7600");

    const rerun = runInstallerOnTty(
      "banner-mkcert-headless-then-tty",
      ["--mkcert", "--embedder", EMBED_IDS[0]],
      ["2"],
      { OMNESIS_TEST_KEYRING: "ready", NODE_OPTIONS: mkcert.nodeOptions },
    );
    expect(rerun.status).toBe(0);
    expect(rerun.output).toContain("Which address should another machine use");
    expect(rerun.envFile()).toContain("OMNESIS_GATEWAY_URL=https://192.0.2.60:7600");
  });

  test.skipIf(!HAS_PTY)("an mkcert rerun drops an address absent from the new certificate", () => {
    installAbsentTailscale();
    const firstHost = installDeterministicMkcertHost("banner-mkcert-address-removed");
    const first = runInstallerOnTty(
      "banner-mkcert-address-removed",
      ["--mkcert", "--embedder", EMBED_IDS[0]],
      ["2"],
      { OMNESIS_TEST_KEYRING: "ready", NODE_OPTIONS: firstHost.nodeOptions },
    );
    expect(first.status).toBe(0);

    const changedHost = installDeterministicMkcertHost("banner-mkcert-address-removed", {
      ipv4: "192.0.2.61",
      ipv6: "2001:db8::61",
    });
    const rerun = runInstaller(
      "banner-mkcert-address-removed",
      ["--mkcert", "--embedder", EMBED_IDS[0]],
      { OMNESIS_TEST_KEYRING: "ready", NODE_OPTIONS: changedHost.nodeOptions },
    );
    expect(rerun.status).toBe(0);
    expect(rerun.envFile()).toContain("OMNESIS_GATEWAY_URL=https://studio-northstar.local:7600");
    expect(rerun.envFile()).not.toContain("https://192.0.2.60:7600");
  });

  test.skipIf(!HAS_PTY)("a failed gateway restart cannot erase a covered mkcert choice", () => {
    installAbsentTailscale();
    const mkcert = installDeterministicMkcertHost("banner-mkcert-health-failure");
    const first = runInstallerOnTty(
      "banner-mkcert-health-failure",
      ["--mkcert", "--embedder", EMBED_IDS[0]],
      ["2"],
      { OMNESIS_TEST_KEYRING: "ready", NODE_OPTIONS: mkcert.nodeOptions },
    );
    expect(first.status).toBe(0);

    const rerun = runInstaller(
      "banner-mkcert-health-failure",
      ["--mkcert", "--embedder", EMBED_IDS[0]],
      {
        OMNESIS_TEST_KEYRING: "ready",
        NODE_OPTIONS: mkcert.nodeOptions,
        OMNESIS_TEST_CURL_EXIT: "7",
        OMNESIS_GATEWAY_WAIT_SECONDS: "1",
      },
    );
    expect(rerun.status).toBe(1);
    expect(rerun.output).toContain("Gateway did not answer /health");
    expect(rerun.envFile()).toContain("OMNESIS_GATEWAY_URL=https://192.0.2.60:7600");
  });

  test.skipIf(!HAS_PTY)("a mkcert upgrade replaces a selected self-signed address", () => {
    installAbsentTailscale();
    plantGatewayCert(
      "banner-mkcert-upgrade",
      "DNS:localhost, DNS:omnesis.local, DNS:studio-northstar.local, IP:192.0.2.53",
    );
    const first = runInstallerOnTty(
      "banner-mkcert-upgrade",
      ["--no-tls", "--embedder", EMBED_IDS[0]],
      ["3"],
      { OMNESIS_TEST_KEYRING: "ready" },
    );
    expect(first.status).toBe(0);
    expect(first.envFile()).toContain("OMNESIS_GATEWAY_URL=https://192.0.2.53:7600");

    const mkcert = installDeterministicMkcertHost("banner-mkcert-upgrade");
    const rerun = runInstaller("banner-mkcert-upgrade", ["--mkcert", "--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
      NODE_OPTIONS: mkcert.nodeOptions,
    });

    expect(rerun.status).toBe(0);
    expect(rerun.envFile()).toContain(`OMNESIS_GATEWAY_URL=https://${MKCERT_HOST_LOCAL}:7600`);
    expect(rerun.envFile()).not.toContain("https://192.0.2.53:7600");
    expect(rerun.envFile().match(/OMNESIS_GATEWAY_URL/g)).toHaveLength(1);
    expect(rerun.output).toContain(`--gateway-url https://${MKCERT_HOST_LOCAL}:7600`);
  });

  test("a mkcert upgrade replaces the complete Tailscale certificate configuration", () => {
    installFakeTailscale("workstation.example-tailnet.ts.net");
    const first = runInstaller("banner-mkcert-tailscale-upgrade", ["--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
    });
    expect(first.status).toBe(0);
    expect(first.envFile()).toContain("OMNESIS_TLS_CERT=");
    expect(first.envFile()).toContain("tailscale.crt");
    expect(first.envFile()).toContain("OMNESIS_TLS_KEY=");
    expect(first.envFile()).toContain("tailscale.key");

    installAbsentTailscale();
    const mkcert = installDeterministicMkcertHost("banner-mkcert-tailscale-upgrade");
    const rerun = runInstaller(
      "banner-mkcert-tailscale-upgrade",
      ["--mkcert", "--embedder", EMBED_IDS[0]],
      {
        OMNESIS_TEST_KEYRING: "ready",
        NODE_OPTIONS: mkcert.nodeOptions,
      },
    );

    expect(rerun.status).toBe(0);
    const env = rerun.envFile();
    expect(env).toContain("OMNESIS_TLS_CERT=");
    expect(env).toContain("mkcert.crt");
    expect(env).toContain("OMNESIS_TLS_KEY=");
    expect(env).toContain("mkcert.key");
    expect(env).toContain(`OMNESIS_GATEWAY_URL=https://${MKCERT_HOST_LOCAL}:7600`);
    expect(env).not.toContain("tailscale.crt");
    expect(env).not.toContain("tailscale.key");
    expect(env).not.toContain("OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN");
    expect(env.match(/OMNESIS_TLS_CERT/g)).toHaveLength(1);
    expect(env.match(/OMNESIS_TLS_KEY/g)).toHaveLength(1);
    expect(env.match(/OMNESIS_GATEWAY_URL/g)).toHaveLength(1);
  });

  test("automatic Tailscale provisioning preserves an operator-managed certificate", () => {
    const home = prepareHome("banner-custom-cert-rerun");
    const fingerprint = plantGatewayCert("banner-custom-cert-rerun", "DNS:gateway.example.org");
    const cert = join(home, ".config", "omnesis", "tls", "cert.pem");
    const key = join(home, ".config", "omnesis", "tls", "operator.key");
    writeFileSync(key, "fictional test key\n");
    writeFileSync(
      join(home, ".config", "omnesis", ".env"),
      [
        `OMNESIS_TLS_CERT=${cert}`,
        `OMNESIS_TLS_KEY=${key}`,
        "OMNESIS_GATEWAY_URL=https://gateway.example.org:7600",
        "OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN=https://workstation.example-tailnet.ts.net:7600",
        "",
      ].join("\n"),
    );
    installFakeTailscale("workstation.example-tailnet.ts.net");

    const run = runInstaller("banner-custom-cert-rerun", ["--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
    });

    expect(run.status).toBe(0);
    const env = run.envFile();
    expect(env).toContain(`OMNESIS_TLS_CERT=${cert}`);
    expect(env).toContain(`OMNESIS_TLS_KEY=${key}`);
    expect(env).toContain("OMNESIS_GATEWAY_URL=https://gateway.example.org:7600");
    expect(env).not.toContain("tailscale.crt");
    expect(env).not.toContain("tailscale.key");
    expect(env).not.toContain("OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN");
    expect(run.output).toContain("Existing operator-managed TLS configuration left unchanged");
    expect(run.output).toContain("--gateway-url https://gateway.example.org:7600");
    expect(run.output).toContain(`--trust-fingerprint sha256:${fingerprint}`);
  });

  test("a run with no certificate to fingerprint still prints a usable line", () => {
    installAbsentTailscale();
    const run = runInstaller("banner-nocert", ["--no-tls", "--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "ready",
    });
    expect(run.status).toBe(0);
    expect(run.output).toContain("--gateway-url https://omnesis.local:7600");
    expect(run.output).not.toContain("--trust-fingerprint");
    expect(run.output).toContain("certificate fingerprint to confirm");
  });

  test("a client-only install advertises no second machine", () => {
    const run = runInstaller("banner-client", ["--client-only", "--no-keyring"]);
    expect(run.status).toBe(0);
    expect(run.output).not.toContain("Add another machine");
  });
});

describe("install.sh gateway health", () => {
  test("a gateway that never becomes healthy fails the install and shows its last log lines", () => {
    const run = runInstaller("health-down", ["--no-tls", "--embedder", EMBED_IDS[1]], {
      OMNESIS_TEST_KEYRING: "ready",
      OMNESIS_TEST_CURL_EXIT: "7",
      OMNESIS_GATEWAY_WAIT_SECONDS: "1",
    });
    expect(run.status).toBe(1);
    expect(run.calls.some((c) => c.startsWith("service logs gateway"))).toBe(true);
    expect(run.calls.some((c) => c.startsWith("model install"))).toBe(false);
    expect(run.output).toContain("The gateway is not running, so Omnesis is not ready.");
    expect(run.output).toContain(`omnesis model install ${EMBED_IDS[1]}`);
    expect(run.output).toContain("re-run this installer");
    // No welcome banner of either kind over a gateway that is not serving.
    expect(run.output).not.toContain("Omnesis is running.");
    expect(run.output).not.toContain("Omnesis is installed");
    // Nothing reports it as merely slow: no supervisor says it is running.
    expect(run.output).not.toContain("still starting");
  });

  test("a gateway that is up but still starting is waited for, not failed", () => {
    const run = runInstaller("health-slow", ["--no-tls", "--embedder", EMBED_IDS[1]], {
      OMNESIS_TEST_KEYRING: "ready",
      // Silent for longer than the first wait, then healthy — a first boot
      // applying migrations on a small machine.
      OMNESIS_TEST_CURL_FAIL_TIMES: "4",
      OMNESIS_TEST_SERVICE_STATE: "running",
      OMNESIS_GATEWAY_WAIT_SECONDS: "2",
      OMNESIS_GATEWAY_STARTUP_MAX_SECONDS: "30",
      OMNESIS_GATEWAY_STARTUP_POLL_SECONDS: "1",
    });
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("still starting");
    expect(run.output).toContain("Gateway is healthy.");
    expect(run.output).not.toContain("The gateway is not running");
    expect(run.calls.some((c) => c.startsWith("model install"))).toBe(true);
  });

  test("a gateway that stays silent while running gives up once, after the longer wait", () => {
    const run = runInstaller("health-stuck", ["--no-tls", "--embedder", EMBED_IDS[1]], {
      OMNESIS_TEST_KEYRING: "ready",
      OMNESIS_TEST_CURL_EXIT: "7",
      OMNESIS_TEST_SERVICE_STATE: "running",
      OMNESIS_GATEWAY_WAIT_SECONDS: "1",
      OMNESIS_GATEWAY_STARTUP_MAX_SECONDS: "2",
      OMNESIS_GATEWAY_STARTUP_POLL_SECONDS: "1",
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain("still starting");
    // The message names what it really waited, not the first window alone.
    expect(run.output).toContain("did not answer /health within 3s");
    expect(run.output).toContain("The gateway is not running, so Omnesis is not ready.");
  });
});

describe("install.sh durability", () => {
  test("the installer flushes the files a power cut used to empty", () => {
    // The passphrase keyring is the flow that writes both files this is about:
    // the passphrase itself, and the .env lines that say where to find it.
    const passFile = fixturePath("durable.pass");
    writeFileSync(passFile, "test-passphrase\n");
    const run = runInstaller(
      "durable-writes",
      ["--no-tls", "--embedder", EMBED_IDS[0], "--keyring-passphrase-file", passFile],
      { OMNESIS_TEST_KEYRING: "refuses" },
    );
    expect(run.status, run.output).toBe(0);
    const synced = run.calls.filter((c) => c.startsWith("sync "));
    // An empty .env after a power cut left nothing able to start at boot, and an
    // empty passphrase file leaves the index openable only with the recovery code.
    // What the installer wrote, and the directory holding it. The passphrase file
    // here is the operator's own — the installer reads it and never writes it,
    // so it is not this run's to flush.
    expect(
      synced.some((c) => c.includes(".env")),
      synced.join(" | "),
    ).toBe(true);
    expect(
      synced.some((c) => c.endsWith("/.config/omnesis")),
      synced.join(" | "),
    ).toBe(true);
  });
});

describe("install.sh encryption-at-rest question", () => {
  test("a passphrase keyring that cannot be armed stops the install instead of going on unencrypted", () => {
    const passFile = fixturePath("arm-fails.pass");
    writeFileSync(passFile, "test-passphrase\n");
    const run = runInstaller(
      "keyring-pass-arm-fails",
      ["--no-tls", "--embedder", EMBED_IDS[0], "--keyring-passphrase-file", passFile],
      { OMNESIS_TEST_KEYRING: "locked", OMNESIS_TEST_FAIL: "keyring init" },
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain("The passphrase keyring could not be armed");
    expect(run.output).toContain("--no-keyring");
    expect(run.output).not.toContain("continuing without keyring-backed secret files");
    expect(run.calls.some((c) => c.startsWith("service install"))).toBe(false);
  });

  test("a keyring that refuses the root key, with no terminal, refuses instead of installing unencrypted", () => {
    const run = runInstaller("keyring-refused-notty", ["--no-tls", "--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "refuses",
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain("The OS keyring refused to store the install root key.");
    expect(run.output).toContain("--keyring-passphrase-file");
    expect(run.output).toContain("--no-keyring");
    expect(run.output).not.toContain("continuing without keyring-backed secret files");
    expect(run.calls.some((c) => c.startsWith("service install"))).toBe(false);
  });

  test("a keyring that refuses the root key arms the passphrase file the operator named", () => {
    const passFile = fixturePath("keyring-refused.pass");
    writeFileSync(passFile, "test-passphrase\n");
    const run = runInstaller(
      "keyring-refused-pass",
      ["--no-tls", "--embedder", EMBED_IDS[0], "--keyring-passphrase-file", passFile],
      { OMNESIS_TEST_KEYRING: "refuses" },
    );
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("The OS keyring refused to store the install root key.");
    expect(callStartingWith(run.calls, "keyring init --backend passphrase")).toBeDefined();
    expect(run.output).toContain("Passphrase keyring armed");
  });

  test.skipIf(!HAS_PTY)(
    "a keyring that refuses the root key offers the same choices on a terminal",
    () => {
      const run = runInstallerOnTty(
        "keyring-refused-tty",
        ["--no-tls", "--embedder", EMBED_IDS[0]],
        ["2"],
        { OMNESIS_TEST_KEYRING: "refuses" },
      );
      expect(run.status, run.output).toBe(0);
      expect(run.output).toContain("The OS keyring refused to store the install root key.");
      expect(run.output).toContain("Passphrase keyring armed");
    },
  );

  test("a run with no terminal refuses instead of silently skipping encryption", () => {
    const run = runInstaller("keyring-notty", ["--no-tls", "--embedder", EMBED_IDS[0]], {
      OMNESIS_TEST_KEYRING: "locked",
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain("--keyring-passphrase-file");
    expect(run.output).toContain("--no-keyring");
    expect(run.output).toContain("encryption at rest");
    expect(run.calls.some((c) => c.startsWith("service install"))).toBe(false);
  });

  test("--no-keyring installs without encryption at rest and says so", () => {
    const run = runInstaller(
      "keyring-off",
      ["--no-tls", "--no-keyring", "--embedder", EMBED_IDS[0]],
      { OMNESIS_TEST_KEYRING: "locked" },
    );
    expect(run.status).toBe(0);
    expect(run.calls.some((c) => c.startsWith("keyring init"))).toBe(false);
    expect(run.output).toContain("no encryption at rest");
  });

  test("a client-only run with no terminal only offers the flag it accepts", () => {
    const run = runInstaller("keyring-client", ["--client-only"], {
      OMNESIS_TEST_KEYRING: "locked",
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain("--no-keyring");
    // --keyring-passphrase-file is refused alongside --client-only, so naming
    // it here would send the operator into a second error.
    expect(run.output).not.toContain("--keyring-passphrase-file");
  });

  test("an exported passphrase path does not veto a client install", () => {
    const run = runInstaller("keyring-env-clash", ["--client-only", "--no-keyring"], {
      OMNESIS_KEYRING_PASSPHRASE_FILE: fixturePath("ambient.pass"),
    });
    expect(run.status).toBe(0);
  });

  test("registration keeps the passphrase reachable the way this platform does it", () => {
    const passFile = fixturePath("unit-wiring.pass");
    writeFileSync(passFile, "test-passphrase\n");
    const run = runInstaller(
      "keyring-wiring",
      ["--no-tls", "--embedder", EMBED_IDS[0], "--keyring-passphrase-file", passFile],
      { OMNESIS_TEST_KEYRING: "locked" },
    );
    expect(run.status).toBe(0);
    const install = callStartingWith(run.calls, "service install");
    // systemd reads the file as root and hands it to the unit alone; launchd
    // has no equivalent, so macOS points the daemon at the file itself.
    const expected =
      process.platform === "darwin"
        ? `--keyring-passphrase-file ${passFile}`
        : `--keyring-passphrase-credential ${passFile}`;
    expect(install).toContain(expected);
  });

  test.skipIf(!HAS_PTY)("choice 1 continues and points at omnesis secure", () => {
    const run = runInstallerOnTty(
      "keyring-continue",
      ["--no-tls", "--embedder", EMBED_IDS[0]],
      ["1"],
      { OMNESIS_TEST_KEYRING: "locked" },
    );
    expect(run.status).toBe(0);
    expect(run.output).toContain("Continuing without encryption at rest");
    expect(run.output).toContain("omnesis secure");
    expect(run.calls.some((c) => c.startsWith("keyring init"))).toBe(false);
    expect(callStartingWith(run.calls, "service install")).not.toContain("--secret-store");
  });

  test.skipIf(!HAS_PTY)(
    "choice 2 arms a passphrase keyring and shows the recovery code once",
    () => {
      const run = runInstallerOnTty(
        "keyring-arm",
        ["--no-tls", "--embedder", EMBED_IDS[0]],
        ["2"],
        { OMNESIS_TEST_KEYRING: "locked" },
      );
      expect(run.status).toBe(0);

      const passFile = join(run.configDir, "keyring.pass");
      expect(existsSync(passFile)).toBe(true);
      expect(statSync(passFile).mode & 0o777).toBe(0o600);
      expect(readFileSync(passFile, "utf8").length).toBeGreaterThan(20);

      expect(run.calls).toContain("keyring init --backend passphrase");
      expect(run.calls).toContain("keyring export-recovery --backend passphrase");
      expect(run.output).toContain("recovery code: TEST-CODE-0000-1111");

      const install = callStartingWith(run.calls, "service install");
      expect(install).toContain("--secret-store passphrase");
      expect(install).toContain(passFile);
      expect(run.envFile()).toContain("OMNESIS_SECRET_STORE=passphrase");
    },
  );

  test.skipIf(!HAS_PTY)("choice 3 stops with the unblock for this platform", () => {
    const run = runInstallerOnTty("keyring-stop", ["--no-tls", "--embedder", EMBED_IDS[0]], ["3"], {
      OMNESIS_TEST_KEYRING: "locked",
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain("Stopped before registering services");
    expect(run.output).toMatch(/login keyring|login keychain/);
    expect(run.calls.some((c) => c.startsWith("service install"))).toBe(false);
  });

  test.skipIf(!HAS_PTY)("an unrecognised answer is asked again", () => {
    const run = runInstallerOnTty(
      "keyring-retry",
      ["--no-tls", "--embedder", EMBED_IDS[0]],
      ["yes", "1"],
      { OMNESIS_TEST_KEYRING: "locked" },
    );
    expect(run.status).toBe(0);
    expect(run.output).toContain("Enter 1, 2, or 3");
  });
});

describe("install.sh on macOS without Node on PATH", () => {
  /**
   * A Mac as a command run over SSH sees it: `uname` says Darwin, no `node` or
   * `brew` is on PATH, and Homebrew lives in its prefix (named by
   * HOMEBREW_PREFIX). The fake `brew` records its calls; `install node@24`
   * links this test runner's own Node into the keg.
   */
  function macWithoutNodeOnPath(name, { homebrew = true, nodeKeg = false } = {}) {
    const prefix = fixturePath(`${name}-homebrew`);
    const keg = join(prefix, "opt", "node@24");
    const brewCalls = join(prefix, "brew-calls.log");
    const tools = fixturePath(`${name}-tools`);
    mkdirSync(tools, { recursive: true });
    writeExecutable(
      join(tools, "uname"),
      '#!/bin/sh\ncase "$1" in -m) echo arm64 ;; *) echo Darwin ;; esac\n',
    );
    if (homebrew) {
      mkdirSync(join(prefix, "bin"), { recursive: true });
      writeExecutable(
        join(prefix, "bin", "brew"),
        [
          "#!/bin/sh",
          `printf 'brew %s\\n' "$*" >> '${brewCalls}'`,
          'case "$1" in',
          `  --prefix) printf '%s\\n' '${keg}' ;;`,
          `  install) mkdir -p '${keg}/bin' && ln -sf '${process.execPath}' '${keg}/bin/node' ;;`,
          "esac",
          "",
        ].join("\n"),
      );
    }
    if (nodeKeg) {
      mkdirSync(join(keg, "bin"), { recursive: true });
      symlinkSync(process.execPath, join(keg, "bin", "node"));
    }
    const withoutNodeOrBrew = (process.env.PATH ?? "")
      .split(":")
      .filter((dir) => dir && !["node", "brew"].some((tool) => existsSync(join(dir, tool))));
    const env = {
      PATH: [tools, fixturePath("fake-bin"), ...withoutNodeOrBrew].join(":"),
      ...(homebrew ? { HOMEBREW_PREFIX: prefix } : {}),
      OMNESIS_TEST_KEYRING: "ready",
    };
    const calls = () => (existsSync(brewCalls) ? readFileSync(brewCalls, "utf8") : "");
    // git must survive dropping the directories that hold node or brew.
    const gitReachable = withoutNodeOrBrew.some((dir) => existsSync(join(dir, "git")));
    return { env, calls, gitReachable };
  }

  test("Homebrew that is installed but not on PATH still installs node@24", (ctx) => {
    const mac = macWithoutNodeOnPath("mac-brew-off-path");
    if (!mac.gitReachable) ctx.skip();
    const run = runInstaller("mac-brew-off-path", ["--client-only", "--no-keyring"], mac.env);
    expect(run.output).not.toContain("Homebrew was not found");
    expect(run.output).toMatch(/installing node 24 via homebrew/i);
    expect(mac.calls()).toContain("brew install node@24");
    expect(run.status, run.output).toBe(0);
  });

  test("an installed keg-only node@24 is used instead of installing it again", (ctx) => {
    const mac = macWithoutNodeOnPath("mac-node-keg", { nodeKeg: true });
    if (!mac.gitReachable) ctx.skip();
    const run = runInstaller("mac-node-keg", ["--client-only", "--no-keyring"], mac.env);
    expect(run.output).toMatch(/using homebrew's node@24 at/i);
    expect(mac.calls()).not.toContain("brew install");
    expect(run.status, run.output).toBe(0);
  });

  // A developer Mac has a real Homebrew in a standard prefix, which the
  // installer would find and use; this case only runs where there is none.
  test.skipIf(existsSync("/opt/homebrew/bin/brew") || existsSync("/usr/local/bin/brew"))(
    "without Homebrew the installer says where it looked and how to get Node",
    (ctx) => {
      const mac = macWithoutNodeOnPath("mac-no-brew", { homebrew: false });
      if (!mac.gitReachable) ctx.skip();
      const run = runInstaller("mac-no-brew", ["--client-only", "--no-keyring"], mac.env);
      expect(run.status).toBe(1);
      expect(run.output).toContain(
        "Homebrew was not found on PATH, in /opt/homebrew or in /usr/local",
      );
      expect(run.output).toContain("https://nodejs.org");
    },
  );
});
