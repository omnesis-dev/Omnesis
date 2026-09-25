// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Real third-party loader checks for the nightly harness conformance lanes. */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import { gatewayBootBudgetMs } from "./gateway-env.js";
import { killSubprocessGroup, registerSubprocessGroup } from "./subprocess-reaper.js";
import type { ManagedHarness } from "./managed-integration-enrollment.js";

const execFileAsync = promisify(execFile);

export const EXPECTED_HARNESS_TOOLS = [
  "omnesis_answer",
  "omnesis_subscription_answer",
  "omnesis_subscriptions",
] as const;

interface HarnessRuntimeConformanceOptions {
  harness: ManagedHarness;
  repositoryRoot: string;
  home: string;
  environment: NodeJS.ProcessEnv;
}

export async function assertHarnessRuntimeConformance(
  options: HarnessRuntimeConformanceOptions,
): Promise<void> {
  if (options.harness === "openclaw") {
    await assertOpenClawConformance(options);
    return;
  }
  await assertHermesConformance(options);
}

async function assertOpenClawConformance(options: HarnessRuntimeConformanceOptions): Promise<void> {
  const executable = join(options.repositoryRoot, "node_modules", ".bin", "openclaw");
  const inspectionResult = await execFileAsync(
    executable,
    ["plugins", "inspect", "omnesis-integration", "--runtime", "--json"],
    {
      cwd: options.repositoryRoot,
      env: options.environment,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  let inspection: {
    plugin?: { status?: unknown; toolNames?: unknown };
    diagnostics?: unknown;
  };
  try {
    inspection = JSON.parse(inspectionResult.stdout) as typeof inspection;
  } catch (error) {
    throw new Error(`OpenClaw runtime inspection was not JSON: ${inspectionResult.stdout}`, {
      cause: error,
    });
  }
  if (inspection.plugin?.status !== "loaded") {
    throw new Error(`OpenClaw did not load Omnesis: ${JSON.stringify(inspection)}`);
  }
  assertExactTools("OpenClaw", inspection.plugin.toolNames);
  if (!Array.isArray(inspection.diagnostics) || inspection.diagnostics.length !== 0) {
    throw new Error(`OpenClaw reported loader diagnostics: ${JSON.stringify(inspection)}`);
  }

  const marker = join(options.home, "omnesis", "integration.sqlite");
  rmSync(marker, { force: true });
  const port = await unusedPort();
  await startHarnessAndWait({
    label: "OpenClaw",
    command: executable,
    args: [
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
    cwd: options.repositoryRoot,
    env: options.environment,
    ready: (output) =>
      existsSync(marker) &&
      output.includes("[gateway] ready") &&
      ![
        "failed during register",
        "plugin service failed",
        "plugin services failed to start",
        "update available",
      ].some((diagnostic) => output.includes(diagnostic)),
    settleMs: 250,
  });
}

async function assertHermesConformance(options: HarnessRuntimeConformanceOptions): Promise<void> {
  const executable = requiredAbsoluteExecutable("OMNESIS_HERMES_BIN");
  const python = requiredAbsoluteExecutable("OMNESIS_HERMES_PYTHON");
  const pluginDir = join(options.home, "plugins", "omnesis-integration");

  // Plugin Doctor is Hermes's public, runtime-backed compatibility boundary:
  // it uses the real scanner, manifest parser, importer and registries while
  // blocking network access. Run the CLI first so its exit contract is covered.
  const doctor = await execFileAsync(executable, ["plugins", "doctor", pluginDir, "--ci"], {
    cwd: options.repositoryRoot,
    env: options.environment,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const doctorOutput = `${doctor.stdout}\n${doctor.stderr}`;
  if (doctorOutput.includes("WARN:") || !doctorOutput.includes("registrations: 3 tool(s)")) {
    throw new Error(`Hermes Plugin Doctor did not accept the exact contract:\n${doctorOutput}`);
  }

  // The public report also exposes the names. This makes missing, renamed,
  // duplicated, and extra tools fail directly rather than trusting a count.
  const reportScript = [
    "import json, sys",
    "from hermes_cli.plugin_dev import doctor_plugin",
    "report = doctor_plugin(sys.argv[1])",
    "print(json.dumps({'ok': report.ok, 'findings': [[item.level, item.message] for item in report.findings], 'tools': list(report.registered_tools)}))",
  ].join("; ");
  const reportResult = await execFileAsync(python, ["-c", reportScript, pluginDir], {
    cwd: options.repositoryRoot,
    env: options.environment,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const reportLine = reportResult.stdout.trim().split("\n").at(-1) ?? "";
  const report = JSON.parse(reportLine) as {
    ok?: unknown;
    findings?: unknown;
    tools?: unknown;
  };
  if (report.ok !== true || !Array.isArray(report.findings) || report.findings.length !== 0) {
    throw new Error(`Hermes rejected the Omnesis plugin: ${JSON.stringify(report)}`);
  }
  assertExactTools("Hermes", report.tools);

  // Doctor proves the registration API. A short foreground gateway boot also
  // proves that the installed platform can be materialized in the real host
  // with no model credentials and no inference request.
  const marker = join(options.home, "omnesis", "integration.sqlite");
  rmSync(marker, { force: true });
  const startup = await startHarnessAndWait({
    label: "Hermes",
    command: executable,
    args: ["gateway", "run", "--no-supervise", "-v"],
    cwd: options.environment.TMPDIR ?? options.home,
    env: options.environment,
    ready: (output) =>
      existsSync(marker) && /INFO gateway\.run: Press Ctrl\+C to stop/u.test(output),
    initialSignal: "SIGINT",
    requireCleanExit: true,
  });
  const expectedRegistrations = [
    "Plugin omnesis-integration registered tool: omnesis_answer",
    "Plugin omnesis-integration registered tool: omnesis_subscription_answer",
    "Plugin omnesis-integration registered tool: omnesis_subscriptions",
    "Plugin omnesis-integration registered platform: omnesis",
    "registered: 3 tool(s), 0 hook(s), 0 middleware, 0 slash command(s), 0 CLI command(s)",
  ];
  for (const registration of expectedRegistrations) {
    if (startup.split(registration).length !== 2) {
      throw new Error(
        `Hermes did not report exactly one '${registration}' registration:\n${startup}`,
      );
    }
  }
  for (const forbidden of [
    "Failed to load plugin 'omnesis-integration'",
    "tirith not found — downloading",
    "Installing edge-tts",
  ]) {
    if (startup.includes(forbidden)) {
      throw new Error(`Hermes startup performed forbidden work '${forbidden}':\n${startup}`);
    }
  }
}

function requiredAbsoluteExecutable(name: string): string {
  const value = process.env[name];
  if (!value || !isAbsolute(value)) {
    throw new Error(`${name} must name the absolute executable from the pinned Hermes checkout`);
  }
  return value;
}

function assertExactTools(label: string, value: unknown): void {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
    throw new Error(`${label} did not report a string tool inventory: ${JSON.stringify(value)}`);
  }
  const actual = [...value].sort();
  const expected = [...EXPECTED_HARNESS_TOOLS].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} tool inventory changed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("could not allocate a harness probe port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function startHarnessAndWait(options: {
  label: string;
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  ready(output: string): boolean;
  initialSignal?: NodeJS.Signals;
  requireCleanExit?: boolean;
  settleMs?: number;
}): Promise<string> {
  const chunks: string[] = [];
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  registerSubprocessGroup(child);
  const capture = (chunk: unknown): void => {
    chunks.push(String(chunk));
    if (chunks.length > 300) chunks.splice(0, chunks.length - 300);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  let primaryError: unknown;
  try {
    await waitForReady(options.label, child, () => chunks.join("").slice(-40_000), options.ready);
    await new Promise<void>((resolve) => setTimeout(resolve, options.settleMs ?? 250));
    const settledOutput = chunks.join("").slice(-40_000);
    if (!options.ready(settledOutput)) {
      throw new Error(`${options.label} did not remain ready after startup:\n${settledOutput}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${options.label} exited immediately after startup:\n${chunks.join("")}`);
    }
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await killSubprocessGroup(child, { initialSignal: options.initialSignal });
    } catch (cleanupError) {
      primaryError ??= cleanupError;
    }
  }
  const output = chunks.join("");
  if (primaryError) throw primaryError;
  if (options.requireCleanExit && child.exitCode !== 0) {
    throw new Error(
      `${options.label} did not stop cleanly (exit ${child.exitCode}, signal ${child.signalCode}):\n${output}`,
    );
  }
  return output;
}

async function waitForReady(
  label: string,
  child: ChildProcess,
  output: () => string,
  ready: (output: string) => boolean,
): Promise<void> {
  const timeoutMs = gatewayBootBudgetMs();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const recent = output();
    if (ready(recent)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${label} exited before its plugin started:\n${recent}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `${label} did not start its Omnesis plugin within ${Math.ceil(timeoutMs / 1000)} seconds:\n${output()}`,
  );
}

/** Put the selected pinned harness first while exposing no ambient model keys. */
export function isolatedHarnessEnvironment(options: {
  harness: ManagedHarness;
  repositoryRoot: string;
  home: string;
  osHome: string;
  tempDir: string;
}): NodeJS.ProcessEnv {
  const inheritedPath = process.env.PATH;
  if (!inheritedPath) throw new Error("PATH is required for the harness conformance lane");
  const harnessBin =
    options.harness === "hermes"
      ? dirname(requiredAbsoluteExecutable("OMNESIS_HERMES_BIN"))
      : join(options.repositoryRoot, "node_modules", ".bin");
  const environment: NodeJS.ProcessEnv = {
    PATH: `${harnessBin}:${inheritedPath}`,
    HOME: options.osHome,
    TMPDIR: options.tempDir,
    TZ: "UTC",
    LANG: "C.UTF-8",
    CI: "1",
    NO_COLOR: "1",
  };
  if (options.harness === "openclaw") {
    environment.OPENCLAW_STATE_DIR = options.home;
    environment.OPENCLAW_CONFIG_PATH = join(options.home, "openclaw.json");
    environment.OPENCLAW_NO_AUTO_UPDATE = "1";
  } else {
    // actions/setup-python's Linux interpreter relies on its paired shared
    // library directory. Dropping this while starting from an empty env can
    // make (for example) Python 3.12.14 load the host's 3.12.3 libpython and
    // segfault before Hermes can report a loader diagnostic.
    if (process.env.LD_LIBRARY_PATH) {
      environment.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH;
    }
    environment.HERMES_HOME = options.home;
    environment.HERMES_DISABLE_LAZY_INSTALLS = "1";
    environment.HERMES_STARTUP_WARMUP_TIMEOUT = "0";
    environment.HERMES_PLUGINS_DEBUG = "1";
    environment.PYTHONUNBUFFERED = "1";
    environment.TIRITH_ENABLED = "0";
  }
  return environment;
}
