// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis decision` — set up the Decision model: the providers it can use,
 * decision backends, verifying a model, and calibrating it onto Jev's scale.
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
import { buildDecisionBackendPatch, describeCalibration, parseParams } from "./decision-backend.js";
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

const presetsCommand = defineCommand({
  meta: { name: "presets", description: "List the decision model providers and their models" },
  async run() {
    const o = await withSpinner("Loading providers", () => overview());
    for (const preset of o.decisionPresets ?? []) {
      const tag = preset.builtIn ? "built in" : preset.kind;
      console.log(
        `${c.bold}${preset.id}${c.reset}  ${preset.name} ${c.dim}(${tag}, ${preset.url})${c.reset}`,
      );
      const models = preset.models.slice(0, 8).map((m) => m.id);
      if (models.length)
        console.log(
          `  ${c.dim}${models.join(", ")}${preset.models.length > 8 ? ", …" : ""}${c.reset}`,
        );
    }
  },
});

const listCommand = defineCommand({
  meta: { name: "list", description: "List decision backends and the assigned Decision model" },
  async run() {
    const o = await withSpinner("Loading decision backends", () => overview());
    const assigned = o.inference.assignments.decision;
    const backends = o.inference.decisionBackends ?? {};
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
      const calibration = backends[assigned.backendKey]?.calibrations[assigned.model];
      console.log(`  ${describeCalibration(calibration)}`);
    }
    const keys = Object.keys(backends);
    if (!keys.length) {
      console.log(
        `${c.dim}No decision backends. Add one with "omnesis decision add <name> --preset <id>".${c.reset}`,
      );
      return;
    }
    console.log();
    for (const key of keys) {
      const b = backends[key]!;
      console.log(
        `${c.bold}${key.padEnd(16)}${c.reset} ${(b.preset ?? "custom").padEnd(14)} ${b.url} ${b.hasApiKey ? "key" : c.dim + "no key" + c.reset}${b.apiKeySecretError ? ` ${c.red}${b.apiKeySecretError}${c.reset}` : ""}`,
      );
    }
  },
});

const addCommand = defineCommand({
  meta: { name: "add", description: "Add a decision backend from a preset or a URL" },
  args: {
    name: {
      type: "positional",
      description: "Backend name (a preset id like 'ollaya' picks that preset)",
      required: true,
    },
    preset: { type: "string", description: "Decision preset id (see `omnesis decision presets`)" },
    url: { type: "string", description: "Endpoint URL, for a server no preset describes" },
    param: {
      type: "string",
      description: "A preset URL value, key=value (repeatable), e.g. account=…",
    },
    key: { type: "string", description: "API key (stored in the gateway's secret store)" },
    model: { type: "string", description: "Also assign this model to the Decision role" },
    "allow-remote": {
      type: "boolean",
      description: "Allow inference off this host (needed for a cloud provider)",
    },
  },
  async run(ctx) {
    let built;
    try {
      built = buildDecisionBackendPatch({
        name: String(ctx.args.name ?? ""),
        ...(ctx.args.preset ? { presetId: String(ctx.args.preset) } : {}),
        ...(ctx.args.url ? { url: String(ctx.args.url) } : {}),
        params: parseParams(ctx.args.param as string | string[] | undefined),
        ...(ctx.args.key ? { apiKey: String(ctx.args.key) } : {}),
        ...(ctx.args.model ? { model: String(ctx.args.model) } : {}),
        allowRemote: ctx.args["allow-remote"] === true,
      });
    } catch (err) {
      throw new CliError(
        `${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    await patchConfig(built.patch, "add the decision backend");
    const name = String(ctx.args.name);
    console.log(
      `${c.green}✔${c.reset} Decision backend ${c.bold}${name}${c.reset} added (${built.url})`,
    );
    if (built.preset?.keyRequired && !ctx.args.key) {
      console.log(
        `${c.yellow}${built.preset.name} needs an API key:${c.reset} re-run with --key${built.preset.keyUrl ? ` (create one at ${built.preset.keyUrl})` : ""}.`,
      );
    }
    if (ctx.args.model)
      console.log(`Assigned ${c.bold}${name}/${ctx.args.model}${c.reset} to the Decision model.`);
    console.log(
      `Next: ${c.cyan}omnesis decision verify ${name} <model>${c.reset}, then ${c.cyan}omnesis decision calibrate${c.reset}.`,
    );
  },
});

const removeCommand = defineCommand({
  meta: { name: "remove", description: "Remove a decision backend" },
  args: { name: { type: "positional", description: "Backend name", required: true } },
  async run(ctx) {
    const name = String(ctx.args.name);
    const assigned = (await overview()).inference.assignments.decision;
    const inference: Record<string, unknown> = { decisionBackends: { [name]: null } };
    if (assigned.kind === "decision" && assigned.backendKey === name)
      inference.assignments = { decision: null };
    await patchConfig({ inference }, "remove the decision backend");
    console.log(`${c.green}✔${c.reset} Decision backend ${c.bold}${name}${c.reset} removed`);
  },
});

const modelsCommand = defineCommand({
  meta: { name: "models", description: "List the models a decision backend offers" },
  args: { name: { type: "positional", description: "Backend name", required: true } },
  async run(ctx) {
    const name = String(ctx.args.name);
    const [o, probe] = await withSpinner(`Asking ${name}`, () =>
      Promise.all([
        overview(),
        gatewayJson<{ ok: boolean; models: string[]; listed: boolean; reason?: string }>(
          `/admin/inference/decision-backends/${encodeURIComponent(name)}/probe`,
          { method: "POST" },
        ),
      ]),
    );
    const backend = o.inference.decisionBackends?.[name];
    const preset = o.decisionPresets?.find((p) => p.id === backend?.preset);
    if (!probe.ok) console.log(`${c.yellow}⚠${c.reset} ${probe.reason}`);
    const ids = new Set([...probe.models, ...(preset?.models.map((m) => m.id) ?? [])]);
    for (const id of ids) {
      const facts = preset?.models.find((m) => m.id === id);
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
      description: "Decision backend name, or 'typesafe'",
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
        : `/admin/inference/decision-backends/${encodeURIComponent(name)}/verify`;
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
        `${c.dim}Follow it with "omnesis decision list" or cancel with "omnesis decision calibrate --cancel".${c.reset}`,
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
    description: "Set up the Decision model: providers, backends, verify, calibrate",
  },
  subCommands: {
    presets: presetsCommand,
    list: listCommand,
    add: addCommand,
    remove: removeCommand,
    models: modelsCommand,
    verify: verifyCommand,
    calibrate: calibrateCommand,
  },
  async run(ctx) {
    if (ctx.rawArgs.filter((a) => !a.startsWith("-")).length === 0) {
      const { runCommand } = await import("citty");
      await runCommand(listCommand, { rawArgs: [] });
    }
  },
});
