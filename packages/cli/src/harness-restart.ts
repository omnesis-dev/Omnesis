// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Loading a changed Omnesis plugin into an agent harness, and saying whether
 * it took.
 *
 * A harness reads its config and plugins when it starts, so a plugin that
 * `omnesis connect` or `omnesis update` just installed does nothing until the
 * harness restarts. Omnesis does not supervise the harness — the harness owns
 * that surface — so the restart is the harness's own CLI command, asked for
 * first because it interrupts whatever run the agent is in the middle of.
 * When the command is missing or fails, the operator is told exactly what to
 * run instead.
 *
 * Whether the skill is ready is the harness's own judgement too, read from
 * its CLI rather than inferred from the files `connect` wrote: a skill can be
 * on disk and still disabled, blocked by an allowlist, or missing something
 * the harness requires.
 */

import { spawn } from "node:child_process";
import { assertNever } from "@omnesis/core";
import { harnessClientName } from "@omnesis/agent-integration";
import { SKILL_NAME, type Harness } from "./harness-skills.js";
import {
  formatCommandSpec,
  harnessCommandSpec,
  harnessRestartSpec,
  type CommandSpec,
} from "./update/detect.js";
import { c } from "./utils.js";

/** What one harness command ended with. */
export interface HarnessCommandResult {
  code: number;
  stdout: string;
}

/** Effects the restart and the skill check need — injected so tests can fake them. */
export interface HarnessRestartDeps {
  /** A skippable interruption: resolves true to go ahead, false to skip it. */
  approve(message: string): Promise<boolean>;
  /**
   * Run one command. `"inherit"` streams it to the terminal, `"capture"`
   * returns its stdout. A command that cannot be started resolves with a
   * non-zero code rather than rejecting.
   */
  run(spec: CommandSpec, mode: "inherit" | "capture"): Promise<HarnessCommandResult>;
}

/**
 * Which harness executable to run and the environment that points it at one
 * installation: the executable `resolveHarnessBinary` found, or null for the
 * bare name, and the variables that select the harness home `connect` used.
 */
export interface HarnessInvocation {
  binary: string | null;
  env?: Record<string, string>;
}

function invoked(spec: CommandSpec, invocation: HarnessInvocation): CommandSpec {
  if (!invocation.env) return spec;
  return { ...spec, env: { ...invocation.env, ...spec.env } };
}

/** The question asked before a restart. */
export function harnessRestartQuestion(harness: Harness): string {
  return `Restart ${harness} now? This interrupts any run it is in the middle of.`;
}

export type HarnessRestartOutcome =
  | { kind: "declined"; command: string }
  | { kind: "restarted"; command: string }
  | { kind: "failed"; command: string; code: number };

/**
 * Restart a harness after its plugin changed, having asked first. A declined
 * or failed restart is not an error: the plugin is installed, and the
 * operator is told the one command that loads it.
 */
export async function restartHarness(
  harness: Harness,
  invocation: HarnessInvocation,
  deps: HarnessRestartDeps,
): Promise<HarnessRestartOutcome> {
  const spec = invoked(harnessRestartSpec(harness, invocation.binary), invocation);
  const command = formatCommandSpec(spec);
  const manual =
    `Restart ${harness} to load the refreshed plugin (it reads its config and plugins at ` +
    `startup): ${command}`;
  if (!(await deps.approve(harnessRestartQuestion(harness)))) {
    console.log(`${c.dim}${manual}${c.reset}`);
    return { kind: "declined", command };
  }
  console.log(`${c.dim}$ ${command}${c.reset}`);
  const result = await deps.run(spec, "inherit");
  if (result.code !== 0) {
    const missing =
      invocation.binary === null
        ? ` No \`${harness}\` executable was found on PATH or where its installs usually put it.`
        : "";
    console.log(`${c.yellow}! Could not restart ${harness}.${missing} ${manual}${c.reset}`);
    return { kind: "failed", command, code: result.code };
  }
  return { kind: "restarted", command };
}

export type HarnessSkillState =
  | { kind: "ready" }
  | { kind: "not-ready"; reason: string; next: string }
  | { kind: "unchecked"; reason: string; next: string };

/** The harness command that reports on its skills. */
export function harnessSkillCheckSpec(
  harness: Harness,
  invocation: HarnessInvocation,
): CommandSpec {
  switch (harness) {
    case "openclaw":
      return invoked(
        harnessCommandSpec(harness, ["skills", "check", "--json"], invocation.binary),
        invocation,
      );
    case "hermes":
      return invoked(
        harnessCommandSpec(harness, ["skills", "list", "--source", "local"], invocation.binary),
        invocation,
      );
    default:
      return assertNever(harness);
  }
}

/** What an operator runs to look at the skill themselves. */
function skillInspectCommand(harness: Harness): string {
  switch (harness) {
    case "openclaw":
      return `openclaw skills info ${SKILL_NAME}`;
    case "hermes":
      return "hermes skills list";
    default:
      return assertNever(harness);
  }
}

function jsonObject(stdout: string): Record<string, unknown> | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Whether a `skills check --json` list names the skill, as a string or as `{ name }`. */
function listsSkill(report: Record<string, unknown>, key: string): boolean {
  const list = report[key];
  if (!Array.isArray(list)) return false;
  return list.some(
    (entry) =>
      entry === SKILL_NAME ||
      (entry !== null &&
        typeof entry === "object" &&
        (entry as { name?: unknown }).name === SKILL_NAME),
  );
}

function missingRequirements(report: Record<string, unknown>): string | null {
  const list = report.missingRequirements;
  if (!Array.isArray(list)) return null;
  const entry = list.find(
    (item): item is { name: string; missing?: Record<string, unknown> } =>
      item !== null && typeof item === "object" && (item as { name?: unknown }).name === SKILL_NAME,
  );
  if (!entry) return null;
  const missing = Object.entries(entry.missing ?? {})
    .flatMap(([kind, values]) =>
      Array.isArray(values) && values.length > 0 ? [`${kind} ${values.join(", ")}`] : [],
    )
    .join("; ");
  return missing ? `it is missing ${missing}` : "it is missing a requirement";
}

function openClawSkillState(stdout: string): HarnessSkillState {
  const next = skillInspectCommand("openclaw");
  const report = jsonObject(stdout);
  if (!report || !Array.isArray(report.eligible)) {
    return { kind: "unchecked", reason: "OpenClaw's skill report was not readable", next };
  }
  const reason = listsSkill(report, "disabled")
    ? "it is disabled in OpenClaw's config"
    : listsSkill(report, "blocked")
      ? "OpenClaw's skill allowlist blocks it"
      : listsSkill(report, "agentFiltered")
        ? "the agent's skill allowlist excludes it"
        : listsSkill(report, "notInjected")
          ? "it is hidden from the model's prompt"
          : (missingRequirements(report) ??
            (listsSkill(report, "eligible") ? null : "OpenClaw does not list it"));
  return reason === null ? { kind: "ready" } : { kind: "not-ready", reason, next };
}

/** The row of a `hermes skills list` table that names the skill, split into its cells. */
function hermesSkillRow(stdout: string): string[] | null {
  for (const line of stdout.split("\n")) {
    const cells = line
      .split(/[│┃|]/u)
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0);
    if (cells[0] === SKILL_NAME) return cells;
  }
  return null;
}

function hermesSkillState(stdout: string): HarnessSkillState {
  const next = skillInspectCommand("hermes");
  const row = hermesSkillRow(stdout);
  if (!row) return { kind: "not-ready", reason: "Hermes does not list it", next };
  if (row.some((cell) => /\bdisabled\b/iu.test(cell))) {
    return { kind: "not-ready", reason: "it is disabled in Hermes's config", next };
  }
  return { kind: "ready" };
}

/** Read the harness's answer about the skill. */
export function readHarnessSkillState(
  harness: Harness,
  spec: CommandSpec,
  result: HarnessCommandResult,
): HarnessSkillState {
  if (result.code !== 0) {
    return {
      kind: "unchecked",
      reason: `\`${formatCommandSpec(spec)}\` exited ${result.code}`,
      next: skillInspectCommand(harness),
    };
  }
  switch (harness) {
    case "openclaw":
      return openClawSkillState(result.stdout);
    case "hermes":
      return hermesSkillState(result.stdout);
    default:
      return assertNever(harness);
  }
}

/** Ask the harness whether the Omnesis skill is ready. */
export async function checkHarnessSkill(
  harness: Harness,
  invocation: HarnessInvocation,
  deps: HarnessRestartDeps,
): Promise<HarnessSkillState> {
  const spec = harnessSkillCheckSpec(harness, invocation);
  return readHarnessSkillState(harness, spec, await deps.run(spec, "capture"));
}

/**
 * Load what `connect` installed and report on it: restart the harness when its
 * plugin changed, then ask the harness whether the skill is ready, and say
 * what is left to do.
 */
export async function reloadConnectedHarness(
  harness: Harness,
  options: { pluginChanged: boolean },
  invocation: HarnessInvocation,
  deps: HarnessRestartDeps,
): Promise<{ restart: HarnessRestartOutcome | null; skill: HarnessSkillState }> {
  const label = harnessClientName(harness);
  const restart = options.pluginChanged ? await restartHarness(harness, invocation, deps) : null;
  if (restart?.kind === "restarted") console.log(`Restarted ${label} with the new plugin.`);
  const skill = await checkHarnessSkill(harness, invocation, deps);
  switch (skill.kind) {
    case "ready":
      console.log(`${c.green}✓${c.reset} ${label} reports the ${SKILL_NAME} skill ready.`);
      break;
    case "not-ready":
      console.log(
        `${c.yellow}! ${label} does not report the ${SKILL_NAME} skill ready: ${skill.reason}. ` +
          `See what it needs with ${c.bold}${skill.next}${c.reset}${c.yellow}.${c.reset}`,
      );
      break;
    case "unchecked":
      console.log(
        `${c.yellow}! Could not ask ${label} whether the ${SKILL_NAME} skill is ready ` +
          `(${skill.reason}). Check it with ${c.bold}${skill.next}${c.reset}${c.yellow}.${c.reset}`,
      );
      break;
    default:
      assertNever(skill);
  }
  if (skill.kind === "ready") {
    console.log(
      `${label} loads skills when a session starts, so a ${c.bold}new session${c.reset} picks it up.`,
    );
  }
  return { restart, skill };
}

/** How long a captured report may take before it counts as unanswered. */
const CAPTURE_TIMEOUT_MS = 60_000;

/**
 * Run a harness command as a child process. A command that cannot be started
 * — no such executable — resolves with exit code 127, as a shell reports it.
 * A captured report that outlives its budget is killed and counts as failed;
 * a streamed command, the restart, runs as long as the harness needs.
 */
export function spawnHarnessCommand(
  spec: CommandSpec,
  mode: "inherit" | "capture",
): Promise<HarnessCommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const settle = (result: HarnessCommandResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: mode === "capture" ? ["ignore", "pipe", "ignore"] : "inherit",
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const timer =
      mode === "capture"
        ? setTimeout(() => {
            child.kill("SIGKILL");
            settle({ code: 124, stdout });
          }, CAPTURE_TIMEOUT_MS)
        : null;
    timer?.unref();
    child.once("error", () => settle({ code: 127, stdout }));
    child.once("close", (code, signal) => settle({ code: code ?? (signal ? 1 : 0), stdout }));
  });
}
