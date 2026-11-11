// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis decision` — set up the Decision model: the providers that serve
 * decision models, a backend's decision API, verifying a model, and
 * calibrating it onto Jev's scale. Backends themselves are managed with
 * `omnesis backend`, and the role is assigned with `omnesis model assign`.
 */

import { setTimeout as delay } from "node:timers/promises";
import { defineCommand } from "citty";
import {
  c,
  gatewayFetch,
  gatewayJson,
  withSpinner,
  CliError,
  EXIT_FAILURE,
  EXIT_USER_ERROR,
  pickGatewayExitCode,
} from "../utils.js";
import {
  buildDecisionDisablePatch,
  buildDecisionEnablePatch,
  describeCalibration,
  parseParams,
} from "./backend-patch.js";
import type { DecisionCalibration, ModelsOverview } from "@omnesis/core";

async function overview(): Promise<ModelsOverview> {
  return gatewayJson<ModelsOverview>("/admin/models");
}

async function patchConfig(body: unknown, what: string): Promise<void> {
  const res = await gatewayFetch("/admin/config", { method: "PATCH", body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new CliError(
      `${c.red}Failed to ${what}: ${res.status} ${txt}${c.reset}`,
      pickGatewayExitCode(res.status),
    );
  }
}

function userError(err: unknown): CliError {
  return new CliError(
    `${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`,
    EXIT_USER_ERROR,
  );
}

const presetsCommand = defineCommand({
  meta: { name: "presets", description: "List the providers that serve decision models" },
  async run() {
    const o = await withSpinner("Loading providers", () => overview());
    for (const preset of o.presets) {
      if (!preset.decision) continue;
      const tag = preset.builtIn ? "built in" : preset.defaultUrl ? "also chat" : preset.kind;
      console.log(
        `${c.bold}${preset.id}${c.reset}  ${preset.name} ${c.dim}(${tag}, ${preset.decision.url})${c.reset}`,
      );
      const models = preset.decision.models.slice(0, 8).map((m) => m.id);
      if (models.length)
        console.log(
          `  ${c.dim}${models.join(", ")}${preset.decision.models.length > 8 ? ", …" : ""}${c.reset}`,
        );
    }
  },
});

/** The assigned Decision model and the backends that serve decision models. */
const statusCommand = defineCommand({
  meta: { name: "status", description: "Show the Decision model and the backends with decisions" },
  async run() {
    const o = await withSpinner("Loading the Decision model", () => overview());
    const assigned = o.inference.assignments.decision;
    const label =
      assigned.kind === "decision" || assigned.kind === "typesafe"
        ? `${assigned.kind === "decision" ? assigned.backendKey : "typesafe"}/${assigned.model}`
        : assigned.kind;
    const state =
      "available" in assigned && assigned.available
        ? `${c.green}available${c.reset}`
        : `${c.red}unavailable${c.reset}`;
    console.log(`Decision model: ${c.bold}${label}${c.reset} (${state})`);
    if ("reason" in assigned && assigned.reason)
      console.log(`  ${c.dim}${assigned.reason}${c.reset}`);
    if (assigned.kind === "decision") {
      const calibration =
        o.inference.backends[assigned.backendKey]?.decision?.calibrations[assigned.model];
      console.log(`  ${describeCalibration(calibration)}`);
    }
    const withDecisions = Object.entries(o.inference.backends).filter(([, b]) => b.decision);
    if (!withDecisions.length) {
      console.log(
        `${c.dim}No backend serves decision models. Add one with "omnesis backend add <preset>", or enable them on an existing backend with "omnesis decision enable <backend>".${c.reset}`,
      );
      return;
    }
    console.log();
    for (const [key, b] of withDecisions) {
      const d = b.decision!;
      console.log(
        `${c.bold}${key.padEnd(16)}${c.reset} ${(b.preset ?? "custom").padEnd(14)} ${d.url} ${d.hasApiKey ? "key" : c.dim + "no key" + c.reset}${d.apiKeySecretError ? ` ${c.red}${d.apiKeySecretError}${c.reset}` : ""}`,
      );
    }
  },
});

const enableCommand = defineCommand({
  meta: {
    name: "enable",
    description: "Add its preset's decision API to an existing backend, with the backend's key",
  },
  args: {
    backend: { type: "positional", description: "Backend name", required: true },
    preset: { type: "string", description: "Preset whose decision API to use" },
    url: { type: "string", description: "Decision endpoint URL, for a server no preset describes" },
    param: {
      type: "string",
      description: "A preset URL value, key=value (repeatable), e.g. account=…",
    },
    model: { type: "string", description: "Also assign this model to the Decision role" },
  },
  async run(ctx) {
    const backend = String(ctx.args.backend ?? "");
    const status = (await overview()).inference.backends[backend];
    if (!status || status.type !== "http") {
      throw userError(`No backend "${backend}". Add it with "omnesis backend add".`);
    }
    let built;
    try {
      built = buildDecisionEnablePatch({
        backend,
        ...(status.preset ? { backendPreset: status.preset } : {}),
        ...(ctx.args.preset ? { presetId: String(ctx.args.preset) } : {}),
        ...(ctx.args.url ? { decisionUrl: String(ctx.args.url) } : {}),
        params: parseParams(ctx.args.param as string | string[] | undefined),
        ...(ctx.args.model ? { model: String(ctx.args.model) } : {}),
      });
    } catch (err) {
      throw userError(err);
    }
    await patchConfig(built.patch, "enable decision models");
    console.log(
      `${c.green}✔${c.reset} ${c.bold}${backend}${c.reset} serves decision models at ${built.url}, with its own key`,
    );
    if (ctx.args.model)
      console.log(
        `Assigned ${c.bold}${backend}/${ctx.args.model}${c.reset} to the Decision model.`,
      );
    console.log(
      `Next: ${c.cyan}omnesis decision verify ${backend} <model>${c.reset}, then ${c.cyan}omnesis decision calibrate${c.reset}.`,
    );
  },
});

const disableCommand = defineCommand({
  meta: {
    name: "disable",
    description: "Remove a backend's decision API, keeping its OpenAI-compatible API",
  },
  args: { backend: { type: "positional", description: "Backend name", required: true } },
  async run(ctx) {
    const backend = String(ctx.args.backend ?? "");
    const o = await overview();
    const status = o.inference.backends[backend];
    if (!status?.decision) throw userError(`"${backend}" serves no decision models.`);
    const assigned = o.inference.assignments.decision;
    let patch;
    try {
      patch = buildDecisionDisablePatch({
        backend,
        servesChat: status.url !== undefined,
        decisionAssigned: assigned.kind === "decision" && assigned.backendKey === backend,
      });
    } catch (err) {
      throw userError(err);
    }
    await patchConfig(patch, "disable decision models");
    console.log(
      `${c.green}✔${c.reset} ${c.bold}${backend}${c.reset} no longer serves decision models`,
    );
  },
});

const modelsCommand = defineCommand({
  meta: { name: "models", description: "List the decision models a backend offers" },
  args: { name: { type: "positional", description: "Backend name", required: true } },
  async run(ctx) {
    const name = String(ctx.args.name);
    const [o, probe] = await withSpinner(`Asking ${name}`, () =>
      Promise.all([
        overview(),
        gatewayJson<{ ok: boolean; models: string[]; listed: boolean; reason?: string }>(
          `/admin/inference/backends/${encodeURIComponent(name)}/decision/probe`,
          { method: "POST" },
        ),
      ]),
    );
    const backend = o.inference.backends[name];
    const offered = o.presets.find((p) => p.id === backend?.preset)?.decision?.models ?? [];
    if (!probe.ok) console.log(`${c.yellow}⚠${c.reset} ${probe.reason}`);
    const ids = new Set([...probe.models, ...offered.map((m) => m.id)]);
    for (const id of ids) {
      const facts = offered.find((m) => m.id === id);
      const note = [
        probe.models.includes(id) ? "installed" : "",
        facts?.contextTokens ? `${Math.round(facts.contextTokens / 1024)}k context` : "",
        facts?.inputCostPerMillion !== undefined ? `$${facts.inputCostPerMillion}/M input` : "",
      ].filter(Boolean);
      console.log(`${id}${note.length ? `  ${c.dim}${note.join(", ")}${c.reset}` : ""}`);
    }
  },
});

const verifyCommand = defineCommand({
  meta: { name: "verify", description: "Ask a model one test decision" },
  args: {
    name: {
      type: "positional",
      description: "Backend name, or 'typesafe'",
      required: true,
    },
    model: { type: "positional", description: "Model id", required: true },
  },
  async run(ctx) {
    const name = String(ctx.args.name);
    const model = String(ctx.args.model);
    const path =
      name === "typesafe"
        ? "/admin/inference/typesafe/verify"
        : `/admin/inference/backends/${encodeURIComponent(name)}/decision/verify`;
    const result = await withSpinner(`Asking ${name}/${model}`, () =>
      gatewayJson<{ ok: boolean; answeredBy?: string; latencyMs?: number; reason?: string }>(path, {
        method: "POST",
        body: JSON.stringify({ model }),
      }),
    );
    if (!result.ok) {
      console.log(`${c.red}✖${c.reset} ${name}/${model}: ${result.reason}`);
      throw new CliError("", EXIT_FAILURE);
    }
    console.log(
      `${c.green}✔${c.reset} ${name}/${model} answered in ${result.latencyMs} ms${result.answeredBy && result.answeredBy !== model ? ` (as ${result.answeredBy})` : ""}`,
    );
  },
});

interface CalibrationStatus {
  state: "idle" | "running" | "done" | "failed" | "cancelled";
  assignment?: string;
  done: number;
  total: number;
  failed: number;
  result?: DecisionCalibration;
  error?: string;
}

const calibrateCommand = defineCommand({
  meta: {
    name: "calibrate",
    description: "Calibrate the assigned Decision model onto Jev's scale",
  },
  args: {
    detach: { type: "boolean", description: "Start the calibration and return without waiting" },
    cancel: { type: "boolean", description: "Cancel a running calibration" },
  },
  async run(ctx) {
    if (ctx.args.cancel) {
      const status = await gatewayJson<CalibrationStatus>("/admin/models/decision/calibration", {
        method: "DELETE",
      });
      console.log(`Calibration ${status.state}.`);
      return;
    }
    const res = await gatewayFetch("/admin/models/decision/calibration", { method: "POST" });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        message?: string;
      } | null;
      throw new CliError(
        `${c.red}${body?.message ?? body?.error ?? `HTTP ${res.status}`}${c.reset}`,
        pickGatewayExitCode(res.status),
      );
    }
    let status = (await res.json()) as CalibrationStatus;
    console.log(
      `Calibrating ${c.bold}${status.assignment}${c.reset} on ${status.total} invented reference emails…`,
    );
    if (ctx.args.detach) {
      console.log(
        `${c.dim}Follow it with "omnesis decision status" or cancel with "omnesis decision calibrate --cancel".${c.reset}`,
      );
      return;
    }
    while (status.state === "running") {
      await delay(2000);
      status = await gatewayJson<CalibrationStatus>("/admin/models/decision/calibration");
      if (process.stdout.isTTY)
        process.stdout.write(
          `\r  ${status.done}/${status.total}${status.failed ? ` (${status.failed} failed)` : ""}   `,
        );
    }
    if (process.stdout.isTTY) process.stdout.write("\n");
    if (status.state !== "done") {
      console.log(
        `${c.red}✖${c.reset} Calibration ${status.state}${status.error ? `: ${status.error}` : ""}`,
      );
      throw new CliError("", EXIT_FAILURE);
    }
    console.log(`${c.green}✔${c.reset} ${describeCalibration(status.result)}`);
  },
});

export const decisionCommand = defineCommand({
  meta: {
    name: "decision",
    description: "Set up the Decision model: providers, decision APIs, verify, calibrate",
  },
  subCommands: {
    status: statusCommand,
    presets: presetsCommand,
    enable: enableCommand,
    disable: disableCommand,
    models: modelsCommand,
    verify: verifyCommand,
    calibrate: calibrateCommand,
  },
  async run(ctx) {
    if (ctx.rawArgs.filter((a) => !a.startsWith("-")).length === 0) {
      const { runCommand } = await import("citty");
      await runCommand(statusCommand, { rawArgs: [] });
    }
  },
});
