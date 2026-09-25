// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Restart-surviving worker for a portal-approved fleet update. Its public
 * arguments identify an existing operation only. The release and the child
 * command are derived internally so an HTTP caller can never turn this into a
 * general process launcher.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { atomicWriteFileSync, type FleetUpdatePlan } from "@omnesis/core";
import {
  PORTAL_FLEET_UPDATE_OUTPUT_MAX_BYTES,
  acquirePortalFleetUpdateRunnerClaim,
  portalFleetUpdateOutputTail,
  readPortalFleetUpdateOperation,
  updatePortalFleetUpdateOperation,
  type PortalFleetUpdateOperation,
} from "@omnesis/core/portal-fleet-update";
import { isStableReleaseVersion } from "@omnesis/core/release-check";
import { defineCommand } from "citty";
import { CliError, EXIT_USER_ERROR, gatewayJson } from "../utils.js";
import { runFleetUpdate } from "../update/fleet.js";

export const PORTAL_FLEET_UPDATE_RUN_COMMAND = "_portal-fleet-update-run";

interface ChildSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

interface OutputCapture {
  write(text: string): void;
  end(): string;
}

export interface PortalFleetUpdateRunDeps {
  now(): Date;
  runChild(spec: ChildSpec): Promise<ChildResult>;
  cliEntry: string;
  execPath: string;
  execArgv: readonly string[];
  env: NodeJS.ProcessEnv;
}

function appendTail(current: string, chunk: string): string {
  return portalFleetUpdateOutputTail(current + chunk);
}

function secretValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(
      ([name, value]) =>
        Boolean(value) && /(?:TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|AUTH|_KEY$)/iu.test(name),
    )
    .map(([, value]) => value!);
}

function redactOutput(text: string, secrets: readonly string[]): string {
  let sanitized = text;
  for (const value of secrets) sanitized = sanitized.split(value).join("***");
  sanitized = sanitized.replace(/\b(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, "$1***@");
  sanitized = sanitized.replace(
    /\b(token|password|secret|authorization)(\s*[:=]\s*)(?:bearer\s+)?([^\s]+)/giu,
    "$1$2***",
  );
  return sanitized;
}

function safeOutputSplit(text: string, proposed: number, secrets: readonly string[]): number {
  let split = proposed;
  const spans: Array<readonly [number, number]> = [];
  for (const secret of secrets) {
    let from = 0;
    for (;;) {
      const start = text.indexOf(secret, from);
      if (start === -1) break;
      spans.push([start, start + secret.length]);
      from = start + 1;
    }
  }
  const patterns = [
    /\bhttps?:\/\/[^\s/@]+(?::[^\s/@]*)?@/giu,
    /\b(?:token|password|secret|authorization)(?:\s*[:=]\s*)(?:bearer\s+)?[^\s]+/giu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      spans.push([match.index, match.index + match[0].length]);
    }
  }
  for (;;) {
    const crossing = spans.find(([start, end]) => start < split && end > split);
    if (!crossing) return split;
    split = crossing[0];
  }
}

/**
 * Redact complete diagnostic segments before retaining their bounded tail.
 * The unfinished suffix is at least as long as the longest known secret, so
 * a value split across child-process chunks can never be emitted in pieces.
 * An unbroken oversized token is discarded rather than buffered or exposed.
 */
export function createPortalFleetUpdateOutputCapture(env: NodeJS.ProcessEnv): OutputCapture {
  const secrets = secretValues(env);
  const boundary = Math.max(512, ...secrets.map((value) => value.length));
  const maxPendingToken = Math.max(PORTAL_FLEET_UPDATE_OUTPUT_MAX_BYTES, boundary * 2);
  let pending = "";
  let output = "";
  let droppingToken = false;
  const append = (text: string): void => {
    output = appendTail(output, redactOutput(text, secrets));
  };
  const drain = (): void => {
    while (pending.length > boundary) {
      const searchEnd = pending.length - boundary;
      let split = -1;
      for (let index = searchEnd; index >= 0; index -= 1) {
        if (/\s/u.test(pending[index]!)) {
          split = index + 1;
          break;
        }
      }
      split = safeOutputSplit(pending, split, secrets);
      if (split > 0) {
        append(pending.slice(0, split));
        pending = pending.slice(split);
        continue;
      }
      if (pending.length <= maxPendingToken) return;
      append("[oversized diagnostic token redacted]");
      pending = "";
      droppingToken = true;
      return;
    }
  };
  return {
    write(text) {
      if (droppingToken) {
        const whitespace = text.search(/\s/u);
        if (whitespace === -1) return;
        droppingToken = false;
        pending += text.slice(whitespace);
      } else {
        pending += text;
      }
      drain();
    },
    end() {
      if (pending) append(pending);
      pending = "";
      return output;
    },
  };
}

/** Capture an interleaved, bounded stdout/stderr tail without inheriting a terminal. */
async function runChild(spec: ChildSpec): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = new StringDecoder("utf8");
    const stderr = new StringDecoder("utf8");
    const capture = createPortalFleetUpdateOutputCapture(spec.env);
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => capture.write(stdout.write(chunk)));
    child.stderr.on("data", (chunk: Buffer) => capture.write(stderr.write(chunk)));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      capture.write(stdout.end());
      capture.write(stderr.end());
      resolve({ code, signal, output: capture.end() });
    });
  });
}

function defaultDeps(): PortalFleetUpdateRunDeps {
  const cliEntry = process.argv[1];
  if (!cliEntry) throw new Error("Cannot resolve the current Omnesis CLI entry");
  return {
    now: () => new Date(),
    runChild: recordingE2ERunChild() ?? runChild,
    cliEntry,
    execPath: process.execPath,
    execArgv: process.execArgv,
    env: process.env,
  };
}

function recordingE2ERunChild(): PortalFleetUpdateRunDeps["runChild"] | null {
  if (
    process.env.OMNESIS_SYNTHETIC !== "1" ||
    process.env.OMNESIS_E2E_DISABLE_RELEASE_CHECK !== "1" ||
    process.env.OMNESIS_E2E_PORTAL_FLEET_UPDATE !== "1"
  ) {
    return null;
  }
  return async (spec) => {
    const configDir = spec.env.OMNESIS_CONFIG_DIR;
    if (!configDir || !isAbsolute(configDir)) throw new Error("E2E updater has no config dir");
    const operation = readPortalFleetUpdateOperation(configDir);
    if (!operation) throw new Error("E2E updater has no durable operation");
    const readyPath = join(configDir, "portal-updates", "e2e-updater-ready.json");
    const continuePath = join(configDir, "portal-updates", "e2e-host-updated");
    atomicWriteFileSync(
      readyPath,
      `${JSON.stringify({ operationId: operation.id, args: spec.args }, null, 2)}\n`,
      { ensureDir: true, mode: 0o600 },
    );
    const deadline = Date.now() + 120_000;
    while (!existsSync(continuePath)) {
      if (Date.now() >= deadline)
        throw new Error("Timed out waiting for the recording host update");
      await delay(50);
    }
    await runFleetUpdate({
      updateHost: () => Promise.resolve(),
      servedVersion: async () => (await gatewayJson<{ version: string }>("/health")).version,
      hostVersion: () => operation.targetVersion,
      plan: () => gatewayJson<FleetUpdatePlan>("/admin/fleet/update"),
      command: async (deviceIds) =>
        (
          await gatewayJson<{ devices: Array<{ id: string; name: string; state: string }> }>(
            "/admin/fleet/update",
            { method: "POST", body: JSON.stringify({ deviceIds }) },
          )
        ).devices,
      approve: () => Promise.resolve(true),
      log: () => undefined,
      now: () => Date.now(),
      sleep: (ms) => delay(ms),
    });
    return { code: 0, signal: null, output: "Recording updater completed.\n" };
  };
}

function transition(
  configDir: string,
  operationId: string,
  expected: PortalFleetUpdateOperation["state"],
  next: (current: PortalFleetUpdateOperation) => PortalFleetUpdateOperation,
): PortalFleetUpdateOperation {
  return updatePortalFleetUpdateOperation(configDir, (current) => {
    if (current.id !== operationId) throw new Error("Portal fleet update operation id changed");
    if (current.state !== expected) {
      throw new Error(`Portal fleet update operation is ${current.state}, expected ${expected}`);
    }
    return next(current);
  });
}

function failureDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.slice(0, 2_048) || "Unable to run the fleet update";
}

function sanitizedOutput(output: string, env: NodeJS.ProcessEnv): string {
  return portalFleetUpdateOutputTail(redactOutput(output, secretValues(env)));
}

/** Run the exact target already recorded by the gateway. */
export async function runPortalFleetUpdateOperation(
  input: { operationId: string; configDir: string },
  deps: PortalFleetUpdateRunDeps = defaultDeps(),
): Promise<PortalFleetUpdateOperation> {
  if (!isAbsolute(input.configDir))
    throw new Error("Portal fleet update config directory is not absolute");

  // This claim is deliberately separate from the host update lock the child
  // takes. It owns the durable operation for the wrapper's whole lifetime,
  // and the shared lock implementation reclaims it only after this exact PID
  // (including its process-start identity) is proven gone.
  const claim = acquirePortalFleetUpdateRunnerClaim(input.configDir);
  try {
    const queued = readPortalFleetUpdateOperation(input.configDir);
    if (!queued) throw new Error("Portal fleet update operation does not exist");
    if (queued.id !== input.operationId)
      throw new Error("Portal fleet update operation id does not match");
    if (queued.state === "succeeded" || queued.state === "failed") return queued;
    if (queued.state !== "queued") {
      throw new Error(`Portal fleet update operation is ${queued.state}, expected queued`);
    }
    if (!isStableReleaseVersion(queued.targetVersion)) {
      throw new Error("Portal fleet update target is not an exact stable release");
    }

    const runningAt = deps.now().toISOString();
    const running = transition(input.configDir, input.operationId, "queued", (current) => ({
      ...current,
      state: "running",
      updatedAt: runningAt,
      detail: "Updating the gateway host, then the fleet.",
    }));

    try {
      const result = await deps.runChild({
        command: deps.execPath,
        args: [
          ...deps.execArgv,
          deps.cliEntry,
          "update",
          "--yes",
          "--fleet",
          `--target-version=${running.targetVersion}`,
        ],
        env: { ...deps.env, OMNESIS_CONFIG_DIR: input.configDir },
      });
      const completedAt = deps.now().toISOString();
      const succeeded = result.code === 0 && result.signal === null;
      return transition(input.configDir, input.operationId, "running", (current) => ({
        ...current,
        state: succeeded ? "succeeded" : "failed",
        updatedAt: completedAt,
        completedAt,
        detail: succeeded
          ? "Gateway and fleet update completed."
          : result.signal
            ? `Fleet update terminated by ${result.signal}.`
            : `Fleet update exited with code ${result.code ?? "unknown"}.`,
        ...(result.output ? { output: sanitizedOutput(result.output, deps.env) } : {}),
      }));
    } catch (error) {
      const completedAt = deps.now().toISOString();
      return transition(input.configDir, input.operationId, "running", (current) => ({
        ...current,
        state: "failed",
        updatedAt: completedAt,
        completedAt,
        detail: failureDetail(error),
      }));
    }
  } finally {
    claim.release();
  }
}

export const portalFleetUpdateRunCommand = defineCommand({
  meta: {
    name: PORTAL_FLEET_UPDATE_RUN_COMMAND,
    description: "Run a previously approved portal fleet update",
    hidden: true,
  },
  args: {
    "operation-id": {
      type: "string",
      required: true,
      description: "Durable operation identifier",
    },
    "config-dir": {
      type: "string",
      required: true,
      description: "Absolute Omnesis configuration directory",
    },
  },
  async run(ctx) {
    const operationId = String(ctx.args["operation-id"] ?? "");
    const configDir = String(ctx.args["config-dir"] ?? "");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        operationId,
      )
    ) {
      throw new CliError("Invalid portal fleet update operation id", EXIT_USER_ERROR);
    }
    if (!isAbsolute(configDir)) {
      throw new CliError("Portal fleet update config directory must be absolute", EXIT_USER_ERROR);
    }
    if (Array.isArray(ctx.args._) && ctx.args._.length > 0) {
      throw new CliError(
        "Portal fleet update runner accepts no positional arguments",
        EXIT_USER_ERROR,
      );
    }
    await runPortalFleetUpdateOperation({ operationId, configDir });
  },
});
