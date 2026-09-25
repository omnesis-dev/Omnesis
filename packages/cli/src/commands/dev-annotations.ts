// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import {
  c,
  formatTimeAgoMs,
  gw,
  isJSON,
  withSpinner,
  CliError,
  EXIT_USER_ERROR,
  pickGatewayExitCode,
} from "../utils.js";

/**
 * `omnesis dev-annotations` — read and triage the developer-annotations
 * channel (operator → engineer data-quality feedback). The gateway surface is
 * gated behind `OMNESIS_DEV_MODE`; when it is off, the endpoints 404 and these
 * commands print a hint rather than an opaque error.
 */

interface DevAnnotation {
  id: string;
  targetType: string;
  targetId: string | null;
  note: string;
  context: Record<string, unknown> | null;
  deepLink: string | null;
  client: string | null;
  status: "open" | "resolved";
  createdAt: number;
  resolvedAt: number | null;
  resolvedNote: string | null;
}

const DEV_MODE_OFF_HINT =
  "developer mode is off — start the gateway with OMNESIS_DEV_MODE=1 to use developer annotations.";

/**
 * Map a failed gateway response to a CliError. A 404 has two distinct
 * meanings on this surface: the gate middleware 404s with the body message
 * `developer mode is disabled` when the whole surface is off, versus a genuine
 * "annotation <id> not found" on resolve/rm. Only the former earns the
 * dev-mode hint; the latter is surfaced verbatim so a bad id isn't mistaken
 * for a config problem.
 */
function gatewayError(status: number, body: string): CliError {
  let message = body;
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string") message = parsed.error;
  } catch {
    // Non-JSON body — fall back to the raw text.
  }
  if (status === 404 && message.toLowerCase().includes("developer mode")) {
    return new CliError(`${c.yellow}${DEV_MODE_OFF_HINT}${c.reset}`, EXIT_USER_ERROR);
  }
  return new CliError(
    `${c.red}Failed: ${status} ${message}${c.reset}`,
    pickGatewayExitCode(status),
  );
}

function contextLabel(a: DevAnnotation): string {
  const label = a.context?.label;
  return typeof label === "string" && label.length > 0 ? label : "";
}

/**
 * Client/version bits for the list view, read from the annotation's context
 * snapshot — mobile clients file `platform` + `appVersion`/`appBuild`, the
 * portal files `platform` + `userAgent`. Exported for tests.
 */
export function clientMetaBits(a: Pick<DevAnnotation, "client" | "context">): string[] {
  const bits: string[] = [];
  if (a.client) bits.push(`via ${a.client}`);
  const ctx = a.context ?? {};
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const platform = str(ctx.platform);
  if (!a.client && platform) bits.push(`via ${platform}`);
  const appVersion = str(ctx.appVersion);
  const appBuild = str(ctx.appBuild);
  if (appVersion || appBuild) bits.push(`app ${appVersion ?? "?"} (${appBuild ?? "?"})`);
  const userAgent = str(ctx.userAgent);
  if (userAgent) bits.push(userAgent);
  return bits;
}

const listCommand = defineCommand({
  meta: { name: "list", description: "List developer annotations (open by default)" },
  args: {
    all: { type: "boolean", description: "Include resolved annotations" },
    type: { type: "string", description: "Filter by target type (document, brief, open_loop, …)" },
  },
  async run(ctx) {
    const params = new URLSearchParams();
    params.set("status", ctx.args.all ? "all" : "open");
    if (typeof ctx.args.type === "string" && ctx.args.type) params.set("targetType", ctx.args.type);

    const res = await withSpinner("Loading developer annotations", () =>
      gw(`/dev/annotations?${params.toString()}`),
    );
    if (!res.ok) throw gatewayError(res.status, await res.text());
    const { annotations } = (await res.json()) as { annotations: DevAnnotation[] };

    if (isJSON) {
      console.log(JSON.stringify(annotations, null, 2));
      return;
    }

    if (annotations.length === 0) {
      console.log(ctx.args.all ? "No developer annotations." : "No open developer annotations.");
      return;
    }

    console.log();
    for (const a of annotations) {
      const target = a.targetId ? `${a.targetType} ${a.targetId}` : a.targetType;
      const status = a.status === "resolved" ? `${c.dim}[resolved]${c.reset}` : "";
      console.log(`${c.bold}● ${target}${c.reset} ${status}`);
      console.log(`  ${a.note}`);
      const label = contextLabel(a);
      if (label) console.log(`  ${c.dim}context:${c.reset} ${label}`);
      if (a.deepLink) console.log(`  ${c.dim}link:${c.reset} ${a.deepLink}`);
      const meta = [formatTimeAgoMs(a.createdAt), ...clientMetaBits(a), `id ${a.id}`].filter(
        Boolean,
      );
      console.log(`  ${c.dim}${meta.join(" · ")}${c.reset}`);
      if (a.resolvedNote) console.log(`  ${c.dim}resolution:${c.reset} ${a.resolvedNote}`);
      console.log();
    }
  },
});

const resolveCommand = defineCommand({
  meta: { name: "resolve", description: "Mark a developer annotation resolved" },
  args: {
    id: { type: "positional", description: "annotation id", required: true },
    note: { type: "string", description: "Optional note on what was done" },
  },
  async run(ctx) {
    const id = ctx.args.id;
    if (!id) {
      throw new CliError(
        `${c.red}Usage: omnesis dev-annotations resolve <id> [--note "..."]${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const res = await withSpinner(`Resolving ${id}`, () =>
      gw(`/dev/annotations/${encodeURIComponent(id)}/resolve`, {
        method: "POST",
        body: JSON.stringify({ note: typeof ctx.args.note === "string" ? ctx.args.note : null }),
      }),
    );
    if (!res.ok) throw gatewayError(res.status, await res.text());
    console.log(`Resolved developer annotation ${id}.`);
  },
});

const rmCommand = defineCommand({
  meta: { name: "rm", description: "Delete a developer annotation" },
  args: {
    id: { type: "positional", description: "annotation id", required: true },
  },
  async run(ctx) {
    const id = ctx.args.id;
    if (!id) {
      throw new CliError(
        `${c.red}Usage: omnesis dev-annotations rm <id>${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const res = await withSpinner(`Deleting ${id}`, () =>
      gw(`/dev/annotations/${encodeURIComponent(id)}`, { method: "DELETE" }),
    );
    if (!res.ok) throw gatewayError(res.status, await res.text());
    console.log(`Deleted developer annotation ${id}.`);
  },
});

export const devAnnotationsCommand = defineCommand({
  meta: {
    name: "dev-annotations",
    description: "Read and triage developer annotations (requires gateway OMNESIS_DEV_MODE)",
  },
  subCommands: {
    list: listCommand,
    resolve: resolveCommand,
    rm: rmCommand,
  },
  // Default to `list` when no subcommand is given.
  async run(ctx) {
    const positionals = ctx.rawArgs.filter((a) => !a.startsWith("-"));
    if (positionals.length === 0) {
      const { runCommand } = await import("citty");
      await runCommand(listCommand, { rawArgs: ctx.rawArgs });
    }
  },
});
