// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import { PROVIDER_PRESETS, getPreset, classifyModelRoles } from "@omnesis/core";
import {
  c,
  gatewayJson,
  gatewayFetch,
  withSpinner,
  CliError,
  EXIT_FAILURE,
  EXIT_USER_ERROR,
  pickGatewayExitCode,
} from "../utils.js";
import type { ModelsOverview } from "@omnesis/core";

interface OverviewResponse extends ModelsOverview {
  activeDownloads: unknown[];
}

async function getOverview(): Promise<OverviewResponse> {
  return gatewayJson<OverviewResponse>("/admin/models");
}

function isLoopbackInferenceUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1") {
      return true;
    }
    const parts = hostname.split(".").map((p) => Number.parseInt(p, 10));
    return parts.length === 4 && parts.every((p) => Number.isInteger(p)) && parts[0] === 127;
  } catch {
    return false;
  }
}

// ── backend list ─────────────────────────────────────────────────────

const backendListCommand = defineCommand({
  meta: { name: "list", description: "List configured inference backends" },
  async run() {
    const overview = await withSpinner("Loading backends", () => getOverview());
    const backends = overview.inference.backends;
    const keys = Object.keys(backends);

    if (keys.length === 0) {
      console.log("No backends configured.");
      return;
    }

    console.log();
    console.log(
      `${c.bold}${"NAME".padEnd(20)} ${"TYPE".padEnd(12)} ${"URL".padEnd(40)} ${"STATUS".padEnd(14)} ${"KEY".padEnd(6)} MODELS${c.reset}`,
    );
    for (const key of keys) {
      const b = backends[key];
      const url = b.url ?? "—";
      const statusColor =
        b.status === "ok" ? c.green : b.status === "unreachable" ? c.red : c.yellow;
      const status = `${statusColor}${b.status}${c.reset}`;
      const keyStatus = b.hasApiKey ? "yes" : "—";
      const models = b.models?.join(", ") ?? "—";
      console.log(
        `${key.padEnd(20)} ${b.type.padEnd(12)} ${url.padEnd(40)} ${status.padEnd(14 + statusColor.length + c.reset.length)} ${keyStatus.padEnd(6)} ${models}`,
      );
    }
    console.log();
  },
});

// ── backend add ──────────────────────────────────────────────────────

const backendAddCommand = defineCommand({
  meta: { name: "add", description: "Add an HTTP inference backend" },
  args: {
    name: {
      type: "positional",
      description: "Backend name (or a preset id like 'openai')",
      required: true,
    },
    url: {
      type: "positional",
      description: "OpenAI-compatible base URL (auto-filled from preset if omitted)",
      required: false,
    },
    key: { type: "string", description: "API key for the backend (Bearer token)" },
    preset: { type: "string", description: "Use a provider preset to auto-fill URL" },
    prefix: {
      type: "string",
      description:
        "API path prefix (e.g. /v1beta/openai); defaults to /v1, auto-filled from preset",
    },
    "allow-remote": {
      type: "boolean",
      description: "Also set inference.allowRemoteInference=true for LAN/cloud inference endpoints",
    },
  },
  async run(ctx) {
    const name = ctx.args.name;
    if (!name) {
      throw new CliError(
        `${c.red}Usage: backend add <name> [url] [--key <apiKey>]${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    // Resolve URL: explicit arg > --preset > auto-detect from name
    let url = ctx.args.url as string | undefined;
    const urlExplicit = !!url;
    const presetId = (ctx.args.preset as string | undefined) ?? name;
    const preset = getPreset(presetId);
    if (!url && preset) {
      url = preset.defaultUrl;
    }

    if (!url) {
      throw new CliError(
        `${c.red}Usage: backend add <name> <url> [--key <apiKey>]\n` +
          `No URL provided and "${name}" is not a known preset.\n` +
          `Known presets: ${PROVIDER_PRESETS.map((p) => p.id).join(", ")}${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    const RESERVED_BACKEND_NAMES = ["local", "anthropic", "codex", "replay"];
    if (RESERVED_BACKEND_NAMES.includes(name) || name.includes("/")) {
      throw new CliError(
        `${c.red}Backend name "${name}" is reserved or contains '/'.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    const apiKey = ctx.args.key as string | undefined;
    const allowRemote = ctx.args["allow-remote"] === true;
    const remoteUrl = !isLoopbackInferenceUrl(url);
    let remoteAlreadyAllowed = false;
    if (remoteUrl && !allowRemote) {
      try {
        remoteAlreadyAllowed = (await getOverview()).inference.allowRemoteInference === true;
      } catch {
        remoteAlreadyAllowed = false;
      }
    }
    const cfg: Record<string, unknown> = { type: "http", url };
    if (apiKey) cfg.apiKey = apiKey;
    // Carry the API path prefix from --prefix, else from the preset (but only
    // when the URL also came from the preset — an explicit URL is taken as-is).
    const apiPathPrefix =
      (ctx.args.prefix as string | undefined) ?? (urlExplicit ? undefined : preset?.apiPathPrefix);
    if (apiPathPrefix) cfg.apiPathPrefix = apiPathPrefix;

    const inferencePatch: Record<string, unknown> = { backends: { [name]: cfg } };
    if (allowRemote) inferencePatch.allowRemoteInference = true;

    const res = await gatewayFetch("/admin/config", {
      method: "PATCH",
      body: JSON.stringify({
        inference: inferencePatch,
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new CliError(
        `${c.red}Failed to add backend: ${res.status} ${txt}${c.reset}`,
        pickGatewayExitCode(res.status),
      );
    }

    console.log(
      `${c.green}✔${c.reset} Backend ${c.bold}${name}${c.reset} added (${url})${apiKey ? " with API key" : ""}`,
    );
    if (remoteUrl && allowRemote) {
      console.log(
        `${c.yellow}Remote HTTP inference enabled.${c.reset} Omnesis may send document chunks, search queries, agent prompts/tool context, OCR images, and API keys to this backend.`,
      );
    } else if (remoteUrl && !remoteAlreadyAllowed) {
      console.log(
        `${c.yellow}Remote HTTP inference is still disabled.${c.reset} This backend will not be probed or used until you set ${c.cyan}inference.allowRemoteInference=true${c.reset} or re-run with ${c.cyan}--allow-remote${c.reset}.`,
      );
    }
    console.log(`Test connectivity: ${c.cyan}cli backend test ${name}${c.reset}`);
  },
});

// ── backend remove ───────────────────────────────────────────────────

const backendRemoveCommand = defineCommand({
  meta: { name: "remove", description: "Remove an inference backend" },
  args: {
    name: { type: "positional", description: "Backend name", required: true },
  },
  async run(ctx) {
    const name = ctx.args.name;
    if (!name) {
      throw new CliError(`${c.red}Usage: backend remove <name>${c.reset}`, EXIT_USER_ERROR);
    }

    const res = await gatewayFetch("/admin/config", {
      method: "PATCH",
      body: JSON.stringify({
        inference: { backends: { [name]: null } },
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new CliError(
        `${c.red}Failed to remove backend: ${res.status} ${txt}${c.reset}`,
        pickGatewayExitCode(res.status),
      );
    }

    console.log(`${c.green}✔${c.reset} Backend ${c.bold}${name}${c.reset} removed`);
  },
});

// ── backend test ─────────────────────────────────────────────────────

interface ProbeResponse {
  ok: boolean;
  status: string;
  models?: string[];
  reason?: string;
}

const backendTestCommand = defineCommand({
  meta: { name: "test", description: "Probe a backend for connectivity and list its models" },
  args: {
    name: { type: "positional", description: "Backend name", required: true },
  },
  async run(ctx) {
    const name = ctx.args.name;
    if (!name) {
      throw new CliError(`${c.red}Usage: backend test <name>${c.reset}`, EXIT_USER_ERROR);
    }

    const probe = await withSpinner(`Probing ${name}`, () =>
      gatewayJson<ProbeResponse>(`/admin/inference/backends/${encodeURIComponent(name)}/probe`, {
        method: "POST",
      }),
    );

    if (!probe.ok) {
      console.log(
        `${c.red}✖${c.reset} ${name}: ${probe.status} — ${probe.reason ?? "unknown error"}`,
      );
      throw new CliError("", EXIT_FAILURE);
    }

    if (probe.status === "reachable") {
      // The host answered but couldn't list models — the backend can still
      // serve inference, so this isn't a failure, but auto-discovery is off:
      // the user has to name the model id when assigning it.
      console.log(
        `${c.yellow}⚠${c.reset} ${name}: reachable, but couldn't list models${probe.reason ? ` (${probe.reason})` : ""}.`,
      );
      console.log(
        `${c.dim}Assign a model id manually, e.g. cli model assign agent ${name}/<model-id>${c.reset}`,
      );
      return;
    }

    console.log(`${c.green}✔${c.reset} ${name}: reachable`);
    if (probe.models && probe.models.length > 0) {
      // /v1/models doesn't advertise purpose; the role tags are derived
      // from the model id (see classifyModelRoles) so you can tell which
      // capability each model fits before assigning it.
      console.log(`${c.bold}Models:${c.reset}`);
      for (const m of probe.models) {
        console.log(`  ${m}  ${c.dim}[${classifyModelRoles(m).join(", ")}]${c.reset}`);
      }
    } else {
      console.log(`${c.dim}No models reported.${c.reset}`);
    }
  },
});

// ── backend verify ───────────────────────────────────────────────────

interface VerifyResponse {
  role: string;
  model: string;
  supported: boolean;
  detail: string;
}

const backendVerifyCommand = defineCommand({
  meta: {
    name: "verify",
    description: "Behaviorally confirm a model serves a role (one minimal capability call)",
  },
  args: {
    name: { type: "positional", description: "Backend name", required: true },
    model: { type: "positional", description: "Model id to verify", required: true },
    role: {
      type: "string",
      description: "Capability role: embedder | agent",
      required: true,
    },
    force: { type: "boolean", description: "Bypass the cached verdict and re-probe" },
  },
  async run(ctx) {
    const { name, model, role } = ctx.args as { name?: string; model?: string; role?: string };
    if (!name || !model || !role) {
      throw new CliError(
        `${c.red}Usage: backend verify <name> <model> --role <embedder|agent>${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const verdict = await withSpinner(`Verifying ${model} as ${role}`, () =>
      gatewayJson<VerifyResponse>(`/admin/inference/backends/${encodeURIComponent(name)}/verify`, {
        method: "POST",
        body: JSON.stringify({ model, role, force: ctx.args.force === true }),
      }),
    );
    const mark = verdict.supported
      ? `${c.green}✔ supported${c.reset}`
      : `${c.red}✖ unsupported${c.reset}`;
    console.log(`${mark}  ${name}/${model} as ${role}`);
    console.log(`${c.dim}${verdict.detail}${c.reset}`);
    if (!verdict.supported) throw new CliError("", EXIT_FAILURE);
  },
});

// ── backend models ───────────────────────────────────────────────────

const backendModelsCommand = defineCommand({
  meta: { name: "models", description: "List models served by a backend" },
  args: {
    name: { type: "positional", description: "Backend name", required: true },
  },
  async run(ctx) {
    const name = ctx.args.name;
    if (!name) {
      throw new CliError(`${c.red}Usage: backend models <name>${c.reset}`, EXIT_USER_ERROR);
    }

    const probe = await withSpinner(`Querying ${name}`, () =>
      gatewayJson<ProbeResponse>(`/admin/inference/backends/${encodeURIComponent(name)}/probe`, {
        method: "POST",
      }),
    );

    if (!probe.ok) {
      throw new CliError(
        `${c.red}Cannot reach ${name}: ${probe.reason ?? probe.status}${c.reset}`,
        EXIT_FAILURE,
      );
    }

    if (!probe.models || probe.models.length === 0) {
      console.log(`${c.dim}No models reported by ${name}.${c.reset}`);
      return;
    }

    for (const m of probe.models) {
      console.log(m);
    }
  },
});

// ── backend key set ──────────────────────────────────────────────────

const backendKeySetCommand = defineCommand({
  meta: { name: "set", description: "Set an API key for a model provider" },
  args: {
    provider: {
      type: "positional",
      description: "Provider fileKey (e.g. anthropic)",
      required: true,
    },
  },
  async run(ctx) {
    const provider = ctx.args.provider;
    if (!provider) {
      throw new CliError(`${c.red}Usage: backend key set <provider>${c.reset}`, EXIT_USER_ERROR);
    }

    const prompts = await import("@clack/prompts");
    const apiKey = await prompts.password({
      message: `API key for ${provider}`,
    });
    if (prompts.isCancel(apiKey) || !apiKey) {
      prompts.cancel("Cancelled.");
      return;
    }

    const res = await gatewayFetch(`/admin/model-credentials/${encodeURIComponent(provider)}`, {
      method: "POST",
      body: JSON.stringify({ fields: { apiKey } }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new CliError(
        `${c.red}Failed to set key: ${res.status} ${txt}${c.reset}`,
        pickGatewayExitCode(res.status),
      );
    }

    console.log(`${c.green}✔${c.reset} API key saved for ${c.bold}${provider}${c.reset}`);
  },
});

// ── backend key clear ────────────────────────────────────────────────

const backendKeyClearCommand = defineCommand({
  meta: { name: "clear", description: "Remove an API key for a model provider" },
  args: {
    provider: {
      type: "positional",
      description: "Provider fileKey (e.g. anthropic)",
      required: true,
    },
  },
  async run(ctx) {
    const provider = ctx.args.provider;
    if (!provider) {
      throw new CliError(`${c.red}Usage: backend key clear <provider>${c.reset}`, EXIT_USER_ERROR);
    }

    const res = await gatewayFetch(`/admin/model-credentials/${encodeURIComponent(provider)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new CliError(
        `${c.red}Failed to clear key: ${res.status} ${txt}${c.reset}`,
        pickGatewayExitCode(res.status),
      );
    }

    console.log(`${c.green}✔${c.reset} API key cleared for ${c.bold}${provider}${c.reset}`);
  },
});

// ── backend key status ───────────────────────────────────────────────

interface CredentialEntry {
  fileKey: string;
  providerName: string;
  configured: boolean;
}

const backendKeyStatusCommand = defineCommand({
  meta: { name: "status", description: "Show API key status for all model providers" },
  async run() {
    const res = await withSpinner("Loading credentials", () =>
      gatewayJson<{ items: CredentialEntry[] }>("/admin/model-credentials"),
    );

    if (res.items.length === 0) {
      console.log("No model providers registered.");
      return;
    }

    console.log();
    console.log(`${c.bold}${"PROVIDER".padEnd(20)} STATUS${c.reset}`);
    for (const entry of res.items) {
      const status = entry.configured
        ? `${c.green}configured${c.reset}`
        : `${c.dim}not configured${c.reset}`;
      console.log(`${entry.providerName.padEnd(20)} ${status}`);
    }
    console.log();
  },
});

// ── backend key (group) ──────────────────────────────────────────────

const backendKeyCommand = defineCommand({
  meta: { name: "key", description: "Manage API keys for model providers" },
  subCommands: {
    set: backendKeySetCommand,
    clear: backendKeyClearCommand,
    status: backendKeyStatusCommand,
  },
});

// ── backend (group) ──────────────────────────────────────────────────

export const backendCommand = defineCommand({
  meta: { name: "backend", description: "Manage inference backends and API keys" },
  subCommands: {
    list: backendListCommand,
    add: backendAddCommand,
    remove: backendRemoveCommand,
    test: backendTestCommand,
    verify: backendVerifyCommand,
    models: backendModelsCommand,
    key: backendKeyCommand,
  },
  async run(ctx) {
    if (ctx.rawArgs.filter((a) => !a.startsWith("-")).length === 0) {
      const { runCommand } = await import("citty");
      await runCommand(backendListCommand, { rawArgs: [] });
    }
  },
});
