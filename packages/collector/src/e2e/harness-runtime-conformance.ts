// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Real third-party loader checks for the nightly harness conformance lanes. */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, dirname, isAbsolute, join } from "node:path";

import { FORWARDED_TOOL_NAMES, resolveHarnessCommand } from "@omnesis/agent-integration";
import { ownedProcessCleanupReceipt, windowsEnvironmentValue } from "@omnesis/core";
import { execE2EBufferedCommand } from "./e2e-buffered-command.js";
import { runEnrollmentTerminal } from "./enrollment-terminal-fixture.js";

import { gatewayBootBudgetMs } from "./gateway-env.js";
import { killSubprocessGroup, registerSubprocessGroup } from "./subprocess-reaper.js";
import type { ManagedHarness } from "./managed-integration-enrollment.js";

const ANSWER_AND_WATCH_TOOLS = [
  "omnesis_answer",
  "omnesis_subscription_answer",
  "omnesis_subscriptions",
] as const;

/**
 * The tools each host reports for the lane's Answer-only connection. OpenClaw
 * reports every tool the plugin manifest declares, including the Direct and
 * Notes tools it offers only to a connection granted them; Hermes registers
 * only the tools the connection is granted.
 */
const EXPECTED_HARNESS_TOOLS: Record<ManagedHarness, readonly string[]> = {
  openclaw: [...ANSWER_AND_WATCH_TOOLS, ...FORWARDED_TOOL_NAMES.map((name) => `omnesis_${name}`)],
  hermes: ANSWER_AND_WATCH_TOOLS,
};

/** Runs one named step of the check; the caller can time it. */
export type HarnessConformanceStep = <T>(name: string, run: () => Promise<T>) => Promise<T>;

interface HarnessRuntimeConformanceOptions {
  harness: ManagedHarness;
  repositoryRoot: string;
  home: string;
  environment: NodeJS.ProcessEnv;
  step?: HarnessConformanceStep;
}

const untimedStep: HarnessConformanceStep = (_name, run) => run();

/**
 * How long `openclaw plugins inspect --runtime` may run. Hosted Windows
 * runners take 17 to 21.4 s for it (Linux about 2 s): the OpenClaw CLI
 * starts helper processes synchronously and waits on worker threads, so a
 * warm compile cache does not shorten it. About three times the measured duration,
 * the limit the CLI itself gives `plugins inspect`, still stops a hung
 * command well inside the test's budget and names it.
 */
const OPENCLAW_INSPECT_TIMEOUT_MS = 60_000;

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
  const step = options.step ?? untimedStep;
  const executable = join(options.repositoryRoot, "node_modules", ".bin", "openclaw");
  const inspectionCommand = resolveHarnessCommand(
    executable,
    ["plugins", "inspect", "omnesis-integration", "--runtime", "--json"],
    { env: options.environment },
  );
  const inspectionResult = await step("plugins inspect", () =>
    execE2EBufferedCommand(inspectionCommand.command, inspectionCommand.args, {
      cwd: options.repositoryRoot,
      env: options.environment,
      timeout: OPENCLAW_INSPECT_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    }),
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
  assertExactTools("OpenClaw", inspection.plugin.toolNames, EXPECTED_HARNESS_TOOLS.openclaw);
  if (!Array.isArray(inspection.diagnostics) || inspection.diagnostics.length !== 0) {
    throw new Error(`OpenClaw reported loader diagnostics: ${JSON.stringify(inspection)}`);
  }

  const marker = join(options.home, "omnesis", "integration.sqlite");
  rmSync(marker, { force: true });
  const port = await unusedPort();
  const gatewayCommand = resolveHarnessCommand(
    executable,
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
    { env: options.environment },
  );
  await step("host start", () =>
    startHarnessAndWait({
      label: "OpenClaw",
      command: gatewayCommand.command,
      args: gatewayCommand.args,
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
    }),
  );
}

async function assertHermesConformance(options: HarnessRuntimeConformanceOptions): Promise<void> {
  const step = options.step ?? untimedStep;
  const executable = requiredAbsoluteExecutable("OMNESIS_HERMES_BIN");
  const python = requiredAbsoluteExecutable("OMNESIS_HERMES_PYTHON");
  const pluginDir = join(options.home, "plugins", "omnesis-integration");

  // Plugin Doctor is Hermes's public, runtime-backed compatibility boundary:
  // it uses the real scanner, manifest parser, importer and registries while
  // blocking network access. Run the CLI first so its exit contract is covered.
  const doctor = await step("plugins doctor", () =>
    execE2EBufferedCommand(executable, ["plugins", "doctor", pluginDir, "--ci"], {
      cwd: options.repositoryRoot,
      env: options.environment,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    }),
  );
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
  const reportResult = await step("doctor report", () =>
    execE2EBufferedCommand(python, ["-c", reportScript, pluginDir], {
      cwd: options.repositoryRoot,
      env: options.environment,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    }),
  );
  const reportLine = reportResult.stdout.trim().split("\n").at(-1) ?? "";
  const report = JSON.parse(reportLine) as {
    ok?: unknown;
    findings?: unknown;
    tools?: unknown;
  };
  if (report.ok !== true || !Array.isArray(report.findings) || report.findings.length !== 0) {
    throw new Error(`Hermes rejected the Omnesis plugin: ${JSON.stringify(report)}`);
  }
  assertExactTools("Hermes", report.tools, EXPECTED_HARNESS_TOOLS.hermes);

  // Doctor proves the registration API. A short foreground gateway boot also
  // proves that the installed platform can be materialized in the real host
  // with no model credentials and no inference request.
  const marker = join(options.home, "omnesis", "integration.sqlite");
  rmSync(marker, { force: true });
  const startup = await step("host start", () =>
    startHarnessAndWait({
      label: "Hermes",
      command: executable,
      args: ["gateway", "run", "--no-supervise", "-v"],
      cwd: options.environment.TMPDIR ?? options.home,
      env: options.environment,
      ready: (output) =>
        existsSync(marker) && /INFO gateway\.run: Press Ctrl\+C to stop/u.test(output),
      initialSignal: "SIGINT",
      requireCleanExit: true,
    }),
  );
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

function assertExactTools(label: string, value: unknown, expectedTools: readonly string[]): void {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
    throw new Error(`${label} did not report a string tool inventory: ${JSON.stringify(value)}`);
  }
  const actual = [...value].sort();
  const expected = [...expectedTools].sort();
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

interface HarnessStartupOptions {
  label: string;
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  ready(output: string): boolean;
  initialSignal?: NodeJS.Signals;
  requireCleanExit?: boolean;
  settleMs?: number;
}

async function startHarnessAndWait(options: HarnessStartupOptions): Promise<string> {
  if (process.platform === "win32" && options.initialSignal === "SIGINT") {
    return startHarnessInWindowsTerminal(options);
  }
  const chunks: string[] = [];
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const capture = (chunk: unknown): void => {
    chunks.push(String(chunk));
    if (chunks.length > 300) chunks.splice(0, chunks.length - 300);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  let primaryError: unknown;
  let failed = false;
  try {
    await registerSubprocessGroup(child);
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
    failed = true;
    primaryError = error;
  } finally {
    try {
      await killSubprocessGroup(child, { initialSignal: options.initialSignal });
    } catch (cleanupError) {
      const receipt = ownedProcessCleanupReceipt(cleanupError);
      primaryError = Object.assign(
        new AggregateError(
          [...(failed ? [primaryError] : []), cleanupError],
          "Harness closure is unconfirmed",
        ),
        { cleanupFailure: receipt ? receipt.failure : cleanupError },
      );
      failed = true;
    }
  }
  const output = chunks.join("");
  if (failed) throw primaryError;
  if (options.requireCleanExit && child.exitCode !== 0) {
    throw new Error(
      `${options.label} did not stop cleanly (exit ${child.exitCode}, signal ${child.signalCode}):\n${output}`,
    );
  }
  return output;
}

/** A console Ctrl+C lets Python run its shutdown handlers on Windows. */
async function startHarnessInWindowsTerminal(options: HarnessStartupOptions): Promise<string> {
  const terminal = runEnrollmentTerminal(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
  });
  const status = {
    get exitCode() {
      return terminal.proc.exitCode;
    },
    signalCode: null,
  };
  let failed = false;
  let primaryError: unknown;
  try {
    await waitForReady(options.label, status, terminal.stdout, options.ready);
    await new Promise<void>((resolve) => setTimeout(resolve, options.settleMs ?? 250));
    if (status.exitCode !== null || !options.ready(terminal.stdout())) {
      throw new Error(`${options.label} did not remain ready after startup:\n${terminal.stdout()}`);
    }
    await terminal.interrupt();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        terminal.exit,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${options.label} did not stop after Ctrl+C`)),
            5_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (options.requireCleanExit && status.exitCode !== 0) {
      throw new Error(
        `${options.label} did not stop cleanly (exit ${status.exitCode}):\n${terminal.stdout()}`,
      );
    }
  } catch (error) {
    failed = true;
    primaryError = error;
  } finally {
    try {
      await terminal.kill();
    } catch (cleanupError) {
      const receipt = ownedProcessCleanupReceipt(cleanupError);
      primaryError = Object.assign(
        new AggregateError(
          [...(failed ? [primaryError] : []), cleanupError],
          "Harness terminal closure is unconfirmed",
        ),
        { cleanupFailure: receipt ? receipt.failure : cleanupError },
      );
      failed = true;
    }
  }
  if (failed) throw primaryError;
  return terminal.stdout();
}

async function waitForReady(
  label: string,
  child: Pick<ChildProcess, "exitCode" | "signalCode">,
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
    PATH: `${harnessBin}${delimiter}${inheritedPath}`,
    HOME: options.osHome,
    TMPDIR: options.tempDir,
    TZ: "UTC",
    LANG: "C.UTF-8",
    CI: "1",
    NO_COLOR: "1",
  };
  if (process.platform === "win32") {
    for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      const value = windowsEnvironmentValue(name);
      if (value !== undefined) environment[name] = value;
    }
    environment.USERPROFILE = options.osHome;
    environment.APPDATA = join(options.osHome, "AppData", "Roaming");
    environment.LOCALAPPDATA = join(options.osHome, "AppData", "Local");
    environment.TEMP = options.tempDir;
    environment.TMP = options.tempDir;
  }
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
    environment.PYTHONUTF8 = "1";
    environment.PYTHONIOENCODING = "utf-8";
    environment.TIRITH_ENABLED = "0";
  }
  return environment;
}
