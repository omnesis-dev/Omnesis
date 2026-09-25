// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const openClawBin = join(
  repositoryRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "openclaw.cmd" : "openclaw",
);

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate a probe port");
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

async function waitForState(path, child, output, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    if (child.exitCode !== null) {
      throw new Error(`OpenClaw exited before starting Omnesis:\n${output()}`);
    }
    await delay(50);
  }
  throw new Error(`OpenClaw did not start Omnesis within ${timeoutMs}ms:\n${output()}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGINT");
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

const probeRoot = mkdtempSync(join(tmpdir(), "omnesis-openclaw-gateway-probe-"));
const inheritedRoot = mkdtempSync(join(tmpdir(), "omnesis-openclaw-inherited-config-"));
const inheritedConfigPath = join(inheritedRoot, "outside-openclaw.json");
const inheritedConfig = '{"fictionalOutsideConfig":"must remain untouched"}\n';
writeFileSync(inheritedConfigPath, inheritedConfig);
const stateDir = join(probeRoot, "state");
const configPath = join(stateDir, "openclaw.json");
let gateway;
let failure;

try {
  execFileSync(
    "npm",
    ["pack", "./packages/agent-integration", "--pack-destination", probeRoot, "--silent"],
    { cwd: repositoryRoot, stdio: "ignore" },
  );
  const archive = readdirSync(probeRoot).find((file) => file.endsWith(".tgz"));
  if (!archive) throw new Error("npm pack did not produce an OpenClaw plugin archive");

  const environment = {
    ...process.env,
    // Exercise the isolation guard on every run: an inherited explicit config
    // and plugin overrides must not influence or be mutated by this probe.
    OPENCLAW_CONFIG_PATH: inheritedConfigPath,
    OPENCLAW_PROFILE: "fictional-outside-profile",
    OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES: "1",
    OPENCLAW_PLUGIN_INSTALL_OVERRIDES: '{"omnesis-integration":"file:/fictional/outside"}',
    OPENCLAW_BUNDLED_PLUGINS_DIR: "/fictional/outside-bundled-plugins",
  };
  for (const key of [
    "OPENCLAW_AGENT_DIR",
    "OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES",
    "OPENCLAW_BUNDLED_PLUGINS_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_DEV_SOURCE_ROOT",
    "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
    "OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY",
    "OPENCLAW_DISABLE_PLUGIN_REGISTRY_MIGRATION",
    "OPENCLAW_DOCKER_PROFILE_ENV_ONLY",
    "OPENCLAW_FORCE_PLUGIN_REGISTRY_MIGRATION",
    "OPENCLAW_HOME",
    "OPENCLAW_PACKAGE_DIR",
    "OPENCLAW_PLUGIN_CATALOG_PATHS",
    "OPENCLAW_PLUGIN_INSTALL_OVERRIDES",
    "OPENCLAW_PLUGIN_STAGE_DIR",
    "OPENCLAW_PROFILE",
    "OPENCLAW_PROFILE_FILE",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_WORKSPACE_DIR",
  ]) {
    delete environment[key];
  }
  Object.assign(environment, {
    HOME: probeRoot,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_SKIP_UPDATE_CHECK: "1",
  });
  execFileSync(
    openClawBin,
    ["plugins", "install", "--force", `npm-pack:${join(probeRoot, archive)}`],
    { cwd: repositoryRoot, env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  const inspection = JSON.parse(
    execFileSync(
      openClawBin,
      ["plugins", "inspect", "omnesis-integration", "--runtime", "--json"],
      {
        cwd: repositoryRoot,
        env: environment,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  const expectedTools = [
    "omnesis_answer",
    "omnesis_subscription_answer",
    "omnesis_subscriptions",
  ].sort();
  const actualTools = Array.isArray(inspection.plugin?.toolNames)
    ? [...inspection.plugin.toolNames].sort()
    : [];
  if (
    inspection.plugin?.status !== "loaded" ||
    JSON.stringify(actualTools) !== JSON.stringify(expectedTools) ||
    !inspection.plugin.hookNames?.includes("omnesis-transcript-ingestion-nudge") ||
    !inspection.plugin.services?.includes("omnesis-integration") ||
    inspection.diagnostics?.length
  ) {
    throw new Error(`OpenClaw runtime inspection rejected Omnesis:\n${JSON.stringify(inspection)}`);
  }

  const integrationDir = join(stateDir, "omnesis");
  mkdirSync(integrationDir, { recursive: true });
  writeFileSync(
    join(integrationDir, "integration.json"),
    `${JSON.stringify({
      gatewayUrl: "http://127.0.0.1:1",
      deliveryToken: "omn_fictional_delivery",
      ingestionToken: "omn_fictional_ingestion",
      managementToken: "omn_fictional_management",
      oauth: {
        redirectUri: "http://127.0.0.1:48123/callback",
        clientInformation: { client_id: "client_fictional" },
        tokens: {
          access_token: "omn_oat_fictional",
          refresh_token: "omn_ort_fictional",
          token_type: "Bearer",
          scope: "omnesis:access offline_access",
        },
      },
      maxConcurrentRuns: 2,
    })}\n`,
    { mode: 0o600 },
  );

  const port = await unusedPort();
  const chunks = [];
  const capture = (chunk) => {
    chunks.push(chunk.toString());
    if (chunks.length > 200) chunks.splice(0, chunks.length - 200);
  };
  gateway = spawn(
    openClawBin,
    [
      "gateway",
      "run",
      "--port",
      String(port),
      "--allow-unconfigured",
      "--auth",
      "none",
      "--bind",
      "loopback",
    ],
    {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  gateway.stdout.on("data", capture);
  gateway.stderr.on("data", capture);
  const output = () => chunks.join("").slice(-20_000);

  await waitForState(join(integrationDir, "integration.sqlite"), gateway, output);
  await delay(200);
  const startup = output();
  if (startup.includes("failed during register") || startup.includes("plugin service failed")) {
    throw new Error(`OpenClaw rejected the Omnesis plugin:\n${startup}`);
  }

  process.stdout.write("OpenClaw managed-install runtime probe passed\n");
} catch (error) {
  failure = error;
} finally {
  if (gateway) await stop(gateway);
  const inheritedConfigAfter = existsSync(inheritedConfigPath)
    ? readFileSync(inheritedConfigPath, "utf8")
    : undefined;
  rmSync(probeRoot, { recursive: true, force: true });
  rmSync(inheritedRoot, { recursive: true, force: true });
  if (inheritedConfigAfter !== inheritedConfig) {
    failure = new Error(
      "OpenClaw probe mutated an inherited config outside its temporary state",
      failure === undefined ? undefined : { cause: failure },
    );
  }
}

if (failure !== undefined) throw failure;
