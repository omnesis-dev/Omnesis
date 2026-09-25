// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `cli model …` — install/activate/uninstall models for the gateway.
 *
 * Wraps the gateway's `/admin/models/*` and `/admin/system-info` routes. Live
 * download progress is polled rather than streamed so the CLI doesn't carry a
 * WebSocket dependency just for this command — /admin/models already includes
 * `activeDownloads[]`, which we poll at 1 Hz during `install`.
 *
 * `catalog` is the exception: it answers from the catalog bundled in
 * `@omnesis/core` plus the on-disk config, with no gateway involved, because
 * the installer asks for the model list before one exists.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import {
  assertNever,
  CATALOG,
  CATALOG_ROLE_CAPABILITY,
  catalogForRole,
  DEFAULT_CONFIG_DIR,
  MODEL_ROLES,
} from "@omnesis/core";
import {
  c,
  gatewayJson,
  gatewayFetch,
  formatSize,
  withSpinner,
  CliError,
  EXIT_FAILURE,
  EXIT_USER_ERROR,
  isJSON,
  pickGatewayExitCode,
} from "../utils.js";
import type {
  CapabilityMetadata,
  CatalogEntry,
  GgufCatalogEntry,
  ManifestEntry,
  ModelRole,
  ModelsOverview,
  ResolvedAssignment,
} from "@omnesis/core";

interface SystemInfo {
  platform: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  totalRamGb: number;
  freeRamGb: number;
  metalSupported: boolean;
  cudaSupported: boolean;
  modelsDir: string;
  modelsDirFreeGb: number;
}

interface ActiveDownload {
  downloadId: string;
  modelId: string;
  filename: string;
  progress: {
    downloadedBytes: number;
    totalBytes: number;
    speedBytesPerSec: number;
    etaMs: number;
  };
  startedAt: string;
}

interface OverviewResponse extends ModelsOverview {
  activeDownloads: ActiveDownload[];
}

async function getOverview(): Promise<OverviewResponse> {
  return gatewayJson<OverviewResponse>("/admin/models");
}

async function getSystemInfo(): Promise<SystemInfo> {
  return gatewayJson<SystemInfo>("/admin/system-info");
}

/** Extract the active catalog id from a resolved assignment. */
function resolvedActiveId(resolved: ResolvedAssignment): string | undefined {
  switch (resolved.kind) {
    case "local":
      return resolved.catalogId;
    case "anthropic":
      return resolved.catalogId;
    case "http":
      return undefined;
    case "disabled":
      return undefined;
    case "unresolved":
      return undefined;
    case "replay":
      return undefined;
    case "codex":
      return undefined;
    default:
      return assertNever(resolved);
  }
}

function activeMarker(resolved: ResolvedAssignment, id: string): string {
  const activeId = resolvedActiveId(resolved);
  if (activeId !== id) return " ";
  const available =
    resolved.kind !== "disabled" &&
    resolved.kind !== "unresolved" &&
    resolved.kind !== "replay" &&
    resolved.available;
  return available ? `${c.green}★${c.reset}` : `${c.yellow}★${c.reset}`;
}

function pctBar(d: ActiveDownload): string {
  const total = d.progress.totalBytes || 1;
  const pct = Math.min(100, Math.floor((d.progress.downloadedBytes / total) * 100));
  const speed = d.progress.speedBytesPerSec
    ? `${formatSize(Math.floor(d.progress.speedBytesPerSec))}/s`
    : "—";
  const eta = d.progress.etaMs > 0 ? `${Math.ceil(d.progress.etaMs / 1000)}s` : "—";
  const filled = Math.floor(pct / 4);
  const bar = "█".repeat(filled) + "░".repeat(25 - filled);
  return `${bar} ${pct}%  ${formatSize(d.progress.downloadedBytes)} / ${formatSize(d.progress.totalBytes)}  ${speed}  ETA ${eta}`;
}

/**
 * Returns true iff the gateway reports that a credentials file is on
 * disk for the given model-provider fileKey. We hit `/admin/model-credentials`
 * (the gateway-host endpoint) rather than reading the file directly,
 * since the CLI may be run on a different host than the gateway.
 */
async function readModelCredentialStatus(fileKey: string): Promise<boolean> {
  try {
    const res = await gatewayJson<{
      items: Array<{ fileKey: string; configured: boolean }>;
    }>("/admin/model-credentials");
    return Boolean(res.items.find((e) => e.fileKey === fileKey)?.configured);
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isGgufEntry(entry: CatalogEntry): entry is GgufCatalogEntry {
  return entry.kind === "gguf";
}

/**
 * The line `model install` prints once an entry is ready: the roles it already
 * serves, or the command that assigns it to the role it can fill.
 */
export function modelReadyHint(
  entry: CatalogEntry,
  assignments: Pick<
    ModelsOverview["inference"]["assignments"],
    "embedder" | "agent" | "transcriber"
  >,
): string {
  const byCapability: Record<string, ResolvedAssignment> = {
    embedder: assignments.embedder,
    agent: assignments.agent,
    transcriber: assignments.transcriber,
  };
  const capabilities = entry.roles.map((role) => CATALOG_ROLE_CAPABILITY[role]);
  const serving = capabilities.filter((capability) => {
    const resolved = byCapability[capability];
    return resolved !== undefined && resolvedActiveId(resolved) === entry.id;
  });
  if (serving.length > 0) return `Already assigned as the ${serving.join(" and ")}.`;
  const value = isGgufEntry(entry) ? `local/${entry.id}` : entry.id;
  const role = capabilities.length === 1 ? capabilities[0] : "<role>";
  return `Assign it with: ${c.cyan}omnesis model assign ${role} ${value}${c.reset}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Subcommand handlers
// ────────────────────────────────────────────────────────────────────────────

const modelListCommand = defineCommand({
  meta: { name: "list", description: "List installed (or available) models" },
  args: {
    available: {
      type: "boolean",
      description: "Show catalog entries even when not installed",
    },
    role: {
      type: "string",
      description: `Filter by what a model can do (${MODEL_ROLES.join(" | ")})`,
    },
  },
  async run(ctx) {
    const overview = await withSpinner("Loading models", () => getOverview());
    const showAvailable = Boolean(ctx.args.available);
    const rawRole = (ctx.args.role as string | undefined) || undefined;
    // These are model *capabilities* from the catalog, a different vocabulary
    // from the assignable capability roles `model assign` takes. Reject an
    // unknown value rather than silently matching nothing — passing
    // `embedder` here used to print "No models match", which reads as "you
    // have no embedding models" instead of "wrong word".
    if (rawRole !== undefined && !(MODEL_ROLES as readonly string[]).includes(rawRole)) {
      throw new CliError(
        `${c.red}Unknown --role: ${rawRole}. Models are tagged with ${MODEL_ROLES.join(", ")}.\n` +
          `To assign a capability role instead, see ${c.cyan}omnesis model assign --help${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const roleFilter = rawRole as ModelRole | undefined;

    const installedIds = new Set(overview.installed.map((m) => m.id));
    const visible = overview.catalog.filter((e) => {
      if (roleFilter && !e.roles.includes(roleFilter)) return false;
      if (showAvailable) return true;
      if (e.kind === "anthropic-api") return true; // always "installed" conceptually
      return installedIds.has(e.id);
    });

    if (visible.length === 0) {
      console.log("No models match. Pass --available to browse the catalog.");
      return;
    }

    console.log();
    console.log(
      `${c.bold}${"E".padEnd(2)} ${"A".padEnd(2)} ${"T".padEnd(2)} ${"ID".padEnd(38)} ${"NAME".padEnd(34)} ${"SIZE".padEnd(10)} ROLES${c.reset}`,
    );
    for (const e of visible) {
      const embedMark = e.roles.includes("embed")
        ? activeMarker(overview.inference.assignments.embedder, e.id)
        : " ";
      const agentMark = e.roles.includes("agent")
        ? activeMarker(overview.inference.assignments.agent, e.id)
        : " ";
      const transcribeMark = e.roles.includes("transcribe")
        ? activeMarker(overview.inference.assignments.transcriber, e.id)
        : " ";
      const size = isGgufEntry(e) ? formatSize(e.sizeBytes) : "API";
      const installedTag =
        isGgufEntry(e) && !installedIds.has(e.id) ? `${c.dim} (catalog)${c.reset}` : "";
      console.log(
        `${embedMark.padEnd(2)} ${agentMark.padEnd(2)} ${transcribeMark.padEnd(2)} ${e.id.padEnd(38)} ${e.name.padEnd(34)} ${size.padEnd(10)} ${e.roles.join(",")}${installedTag}`,
      );
    }

    // Sideloaded — manifest entries that aren't in the catalog.
    const sideloaded = overview.installed.filter(
      (m) => !overview.catalog.some((e) => e.id === m.id),
    );
    if (sideloaded.length > 0) {
      console.log();
      console.log(`${c.dim}Sideloaded (not in bundled catalog):${c.reset}`);
      for (const m of sideloaded) {
        console.log(`  ${m.id} (${formatSize(m.sizeBytes)})  ${c.dim}${m.filename}${c.reset}`);
      }
    }

    if (overview.activeDownloads.length > 0) {
      console.log();
      console.log(`${c.bold}Active downloads:${c.reset}`);
      for (const d of overview.activeDownloads) {
        console.log(`  ${d.modelId}  ${pctBar(d)}`);
      }
    }
    console.log();
  },
});

// ────────────────────────────────────────────────────────────────────────────
// `model catalog` — the bundled catalog, without a gateway
// ────────────────────────────────────────────────────────────────────────────

/**
 * One catalog entry, flattened to the fields a picker needs. `assigned` is
 * true for the model this install currently points a role at.
 */
export interface CatalogListingEntry {
  id: string;
  name: string;
  kind: CatalogEntry["kind"];
  roles: string[];
  author: string;
  license: string;
  description: string;
  sizeBytes: number | null;
  params: string | null;
  embedDim: number | null;
  recommended: boolean;
  assigned: boolean;
}

/**
 * What `model catalog` prints.
 *
 * `assignedId` is what this install currently points the role at, verbatim —
 * which may name something the catalog does not contain, such as a model
 * served by an HTTP backend or a sideloaded file. A caller deciding whether to
 * download anything has to read it: an install with a working remote embedder
 * needs no local weights, and `default` alone cannot say so.
 *
 * `default` is the id a picker should preselect: the assigned model when it is
 * a catalog entry for this role, and the recommended entry otherwise. Both are
 * null when no role was requested, because they are only meaningful per role.
 */
export interface CatalogListing {
  role: ModelRole | null;
  assignedId: string | null;
  default: string | null;
  entries: CatalogListingEntry[];
}

/**
 * The model id `omnesis.json` assigns to a role, read straight off disk.
 * Best-effort by design: this runs before the gateway exists, and a config
 * that is absent, unreadable, or malformed simply means "no assignment" —
 * never a failed install.
 */
export function readAssignedModelId(role: ModelRole, configDir: string): string | undefined {
  const path = join(configDir, "omnesis.json");
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const inference: unknown = (parsed as Record<string, unknown>).inference;
  if (typeof inference !== "object" || inference === null) return undefined;
  const assignments: unknown = (inference as Record<string, unknown>).assignments;
  if (typeof assignments !== "object" || assignments === null) return undefined;
  const value: unknown = (assignments as Record<string, unknown>)[CATALOG_ROLE_CAPABILITY[role]];
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Build the catalog listing for a role (or the whole catalog when `role` is
 * undefined). Pure — the caller supplies the assignment, so this is the same
 * function whether the id came from a config file or from a gateway.
 */
export function buildCatalogListing(
  role: ModelRole | undefined,
  assignedId: string | undefined,
): CatalogListing {
  const entries = role ? catalogForRole(role) : [...CATALOG];
  const listing = entries.map((e) => ({
    id: e.id,
    name: e.name,
    kind: e.kind,
    roles: [...e.roles],
    author: e.author,
    license: e.license,
    description: e.description,
    sizeBytes: e.kind === "gguf" ? e.sizeBytes : null,
    params: e.params ?? null,
    embedDim: e.embedDim ?? null,
    recommended: e.recommended === true,
    assigned: e.id === assignedId,
  }));
  const preselected =
    listing.find((e) => e.assigned) ?? listing.find((e) => e.recommended) ?? listing[0];
  return {
    role: role ?? null,
    assignedId: role ? (assignedId ?? null) : null,
    default: role && preselected ? preselected.id : null,
    entries: listing,
  };
}

const modelCatalogCommand = defineCommand({
  meta: {
    name: "catalog",
    description: "List the bundled model catalog — works before the gateway is running",
  },
  args: {
    role: {
      type: "string",
      description: `Only models that can serve this role (${MODEL_ROLES.join(" | ")})`,
    },
    json: { type: "boolean", description: "Machine-readable JSON output" },
  },
  run(ctx) {
    const rawRole = (ctx.args.role as string | undefined) || undefined;
    if (rawRole !== undefined && !(MODEL_ROLES as readonly string[]).includes(rawRole)) {
      throw new CliError(
        `${c.red}Unknown --role: ${rawRole}. Models are tagged with ${MODEL_ROLES.join(", ")}.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const role = rawRole as ModelRole | undefined;
    const configDir = process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
    const listing = buildCatalogListing(
      role,
      role ? readAssignedModelId(role, configDir) : undefined,
    );

    if (isJSON) {
      console.log(JSON.stringify(listing, null, 2));
      return;
    }

    console.log();
    console.log(
      `${c.bold}  ${"ID".padEnd(38)} ${"NAME".padEnd(34)} ${"SIZE".padEnd(10)} ROLES${c.reset}`,
    );
    for (const e of listing.entries) {
      const mark = e.id === listing.default ? `${c.green}★${c.reset} ` : "  ";
      const size = e.sizeBytes === null ? "API" : formatSize(e.sizeBytes);
      console.log(
        `${mark}${e.id.padEnd(38)} ${e.name.padEnd(34)} ${size.padEnd(10)} ${e.roles.join(",")}`,
      );
    }
    console.log();
  },
});

const modelShowCommand = defineCommand({
  meta: { name: "show", description: "Show full details for a catalog id" },
  args: {
    id: { type: "positional", description: "catalog id", required: true },
  },
  async run(ctx) {
    const id = ctx.args.id;
    if (!id) {
      throw new CliError(`${c.red}Usage: model show <id>${c.reset}`, EXIT_USER_ERROR);
    }
    const [overview, sys] = await Promise.all([getOverview(), getSystemInfo()]);
    const entry = overview.catalog.find((e) => e.id === id);
    if (!entry) {
      throw new CliError(`${c.red}Unknown catalog id: ${id}${c.reset}`, EXIT_USER_ERROR);
    }
    const installed = overview.installed.find((m) => m.id === id);
    console.log();
    console.log(`${c.bold}${entry.name}${c.reset}  ${c.dim}${entry.id}${c.reset}`);
    console.log(`  Kind:        ${entry.kind}`);
    console.log(`  Roles:       ${entry.roles.join(", ")}`);
    console.log(`  Author:      ${entry.author}`);
    console.log(`  License:     ${entry.license}`);
    if (entry.embedDim) console.log(`  Embed dim:   ${entry.embedDim}`);
    if (entry.contextLength) console.log(`  Context:     ${entry.contextLength} tokens`);
    if (entry.params) console.log(`  Params:      ${entry.params}`);
    if (isGgufEntry(entry)) {
      console.log(`  Quant:       ${entry.quant ?? "—"}`);
      console.log(`  Size:        ${formatSize(entry.sizeBytes)}`);
      console.log(
        `  Min RAM:     ${entry.minRamGb ?? "—"} GB  ${entry.recommendedRamGb ? `(recommended: ${entry.recommendedRamGb} GB)` : ""}`,
      );
      console.log(`  URL:         ${entry.downloadUrl}`);
      console.log(`  Installed:   ${installed ? `yes (${installed.downloadedAt})` : "no"}`);
      if (entry.minRamGb && sys.freeRamGb < entry.minRamGb) {
        console.log(
          `  ${c.yellow}⚠ Free RAM (${sys.freeRamGb} GB) is below this model's minimum (${entry.minRamGb} GB).${c.reset}`,
        );
      }
      if (sys.modelsDirFreeGb < entry.sizeBytes / 1024 ** 3) {
        console.log(
          `  ${c.yellow}⚠ Disk free in models dir (${sys.modelsDirFreeGb} GB) may not fit ${formatSize(entry.sizeBytes)}.${c.reset}`,
        );
      }
    } else {
      console.log(`  API model:   anthropic/${entry.apiModelId}`);
      const apiKeyStatus = await readModelCredentialStatus("anthropic");
      console.log(
        `  API key:     ${apiKeyStatus ? "configured" : c.yellow + "not configured (set via portal: Models tab)" + c.reset}`,
      );
    }
    console.log();
    console.log(`  ${entry.description}`);
    console.log();
  },
});

const modelInstallCommand = defineCommand({
  meta: { name: "install", description: "Download and install a GGUF catalog entry" },
  args: {
    id: { type: "positional", description: "catalog id", required: true },
  },
  async run(ctx) {
    const id = ctx.args.id;
    if (!id) {
      throw new CliError(`${c.red}Usage: model install <id>${c.reset}`, EXIT_USER_ERROR);
    }
    const overview = await getOverview();
    const entry = overview.catalog.find((e) => e.id === id);
    if (!entry) {
      throw new CliError(`${c.red}Unknown catalog id: ${id}${c.reset}`, EXIT_USER_ERROR);
    }
    if (!isGgufEntry(entry)) {
      console.log(
        `${entry.id} is an API model — no download required. ${modelReadyHint(entry, overview.inference.assignments)}`,
      );
      return;
    }

    // Kick the install
    const res = await gatewayFetch("/admin/models/install", {
      method: "POST",
      body: JSON.stringify({ id: entry.id }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new CliError(
        `${c.red}Install rejected: ${res.status} ${txt}${c.reset}`,
        pickGatewayExitCode(res.status),
      );
    }

    // Poll for progress. Render a single in-place line.
    console.log(
      `${c.dim}Downloading ${entry.filename} (${formatSize(entry.sizeBytes)})…${c.reset}`,
    );
    let lastLine = "";
    while (true) {
      const ov = await getOverview();
      const dl = ov.activeDownloads.find((d) => d.modelId === entry.id);
      if (!dl) {
        // Either completed or failed; check installed list.
        const m = ov.installed.find((x) => x.id === entry.id);
        if (m) {
          console.log(
            `\n${c.green}✔${c.reset} Installed ${entry.id} (${formatSize(m.sizeBytes)}, sha256=${m.sha256.slice(0, 12)}…)`,
          );
          console.log(modelReadyHint(entry, ov.inference.assignments));
        } else {
          throw new CliError(
            `\n${c.red}✖${c.reset} Download did not complete. Check gateway logs for details.`,
            EXIT_FAILURE,
          );
        }
        break;
      }
      const line = `\r${pctBar(dl)}`;
      if (line !== lastLine) {
        process.stdout.write(line);
        lastLine = line;
      }
      await sleep(500);
    }
  },
});

/**
 * The roles this gateway will accept an assignment for, fetched rather than
 * restated. Two reasons it is the served list and not `CAPABILITY_ROLES`:
 * the gateway withholds experimental capabilities outside experimental mode,
 * so a compile-time list would offer the operator roles their install hides;
 * and a CLI newer than its gateway would otherwise name roles that gateway
 * has never heard of.
 */
async function assignableRoles(): Promise<CapabilityMetadata[]> {
  const overview = await getOverview();
  return overview.capabilities;
}

/** `role` argument help: the roles this gateway exposes, grouped as the portal groups them. */
function roleListHelp(caps: CapabilityMetadata[]): string {
  const names = (section: "core" | "cognition") =>
    caps
      .filter((c) => c.section === section)
      .map((c) => c.role)
      .join(" | ");
  const cognition = names("cognition");
  return cognition.length > 0 ? `core: ${names("core")}; cognition: ${cognition}` : names("core");
}

const modelAssignCommand = defineCommand({
  meta: { name: "assign", description: "Assign a model to a capability role" },
  args: {
    role: {
      type: "positional",
      description: "Capability role (run `omnesis model status` for this gateway's list)",
      required: true,
    },
    value: {
      type: "positional",
      description:
        "Assignment: local/<id>, anthropic/<model>, codex/<model>, <backend>/<model>, replay, disabled",
      required: true,
    },
  },
  async run(ctx) {
    const role = ctx.args.role;
    const rawValue = ctx.args.value;
    if (!role || !rawValue) {
      throw new CliError(`${c.red}Usage: model assign <role> <value>${c.reset}`, EXIT_USER_ERROR);
    }
    const caps = await assignableRoles();
    if (!caps.some((cap) => cap.role === role)) {
      throw new CliError(
        `${c.red}Unknown role: ${role}. This gateway accepts — ${roleListHelp(caps)}${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const assignment = rawValue === "disabled" ? null : rawValue;

    // Embedder swap mode (#1011). Graceful (the default) keeps vector search
    // live on the current model while the new index rebuilds, then atomically
    // flips — zero downtime. Hard cutover stops the old model immediately and
    // drops to keyword-only search until the rebuild finishes. Only meaningful
    // when actually switching the embedder to a different model.
    let swapMode: "graceful" | "hard" = "graceful";
    if (role === "embedder" && assignment !== null) {
      const overview = await getOverview();
      const currentId = resolvedActiveId(overview.inference.assignments.embedder);
      if (currentId && !assignment.endsWith(currentId)) {
        const prompts = await import("@clack/prompts");
        // Graceful zero-downtime swaps now cover ALL four {local,http} target ×
        // {local,http} source transitions (epic #1011, option A): an HTTP target
        // re-embeds via a non-blocking HTTP client, a local target via an off-
        // main-thread build worker. So the graceful-vs-hard choice is offered for
        // every embedder switch regardless of backend kind.
        const choice = await prompts.select({
          message: "How should the embedding model switch?",
          options: [
            {
              value: "graceful",
              label: "Graceful (recommended)",
              hint: "search stays live, switches automatically when ready",
            },
            {
              value: "hard",
              label: "Hard cutover",
              hint: "stop the old model now; keyword-only search until the rebuild finishes",
            },
            { value: "cancel", label: "Cancel" },
          ],
          initialValue: "graceful",
        });
        if (prompts.isCancel(choice) || choice === "cancel") {
          prompts.cancel("Cancelled.");
          return;
        }
        swapMode = choice as "graceful" | "hard";
      }
    }

    const res = await gatewayFetch("/admin/config", {
      method: "PATCH",
      body: JSON.stringify({ inference: { assignments: { [role]: assignment } } }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new CliError(
        `${c.red}Assign rejected: ${res.status} ${txt}${c.reset}`,
        pickGatewayExitCode(res.status),
      );
    }
    console.log(`${c.green}✔${c.reset} Assigned ${role} = ${assignment ?? "(disabled)"}`);

    if (role === "embedder" && assignment !== null && swapMode === "hard") {
      // The config change above already kicked off a graceful swap; the hard
      // cutover request supersedes it (gateway newest-wins / bounded-to-two),
      // stopping the old model immediately and accepting keyword-only search.
      const rb = await gatewayFetch("/admin/index/rebuild", {
        method: "POST",
        body: JSON.stringify({ mode: "hard" }),
      });
      if (!rb.ok) {
        console.log(
          `${c.yellow}Hard cutover request failed (${rb.status}); the graceful swap is proceeding instead.${c.reset}`,
        );
      } else {
        console.log(
          `${c.dim}Hard cutover: stopped using the old embedder immediately — keyword-only search until the rebuild completes.${c.reset}`,
        );
      }
    }

    if (role === "transcriber" && assignment !== null) {
      // Transcription runs at sync time, so changing the model does not
      // reprocess audio already ingested — only future voice notes are
      // transcribed automatically. Resyncing a source re-transcribes its
      // existing voice notes with the newly-assigned model.
      console.log(
        `${c.dim}Note: existing voice notes are not re-transcribed automatically. Only voice notes synced from now on are transcribed. To reprocess already-ingested voice notes, resync the source.${c.reset}`,
      );
    }
  },
});

const modelUninstallCommand = defineCommand({
  meta: { name: "uninstall", description: "Remove an installed model from disk" },
  args: {
    id: { type: "positional", description: "catalog id", required: true },
  },
  async run(ctx) {
    const id = ctx.args.id;
    if (!id) {
      throw new CliError(`${c.red}Usage: model uninstall <id>${c.reset}`, EXIT_USER_ERROR);
    }
    const res = await gatewayFetch(`/admin/models/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new CliError(
        `${c.red}Uninstall rejected: ${res.status} ${txt}${c.reset}`,
        pickGatewayExitCode(res.status),
      );
    }
    console.log(`${c.green}✔${c.reset} Uninstalled ${id}`);
  },
});

const modelStatusCommand = defineCommand({
  meta: { name: "status", description: "One-line summary: active model per role + readiness" },
  async run() {
    const [overview, sys] = await Promise.all([getOverview(), getSystemInfo()]);
    console.log();
    console.log(`${c.bold}Active${c.reset}`);
    // Exactly the capabilities this gateway serves, grouped as the portal
    // groups them. An assignment the gateway did not report is skipped rather
    // than crashing a CLI that is a version ahead of it.
    for (const section of ["core", "cognition"] as const) {
      const roles = overview.capabilities.filter((cap) => cap.section === section);
      if (roles.length === 0) continue;
      if (section === "cognition") {
        console.log();
        console.log(`${c.bold}Cognition${c.reset}`);
      }
      for (const cap of roles) {
        const resolved = overview.inference.assignments[cap.role];
        if (!resolved) continue;
        printRoleLine(cap.role, resolved, overview.catalog, overview.installed);
      }
    }

    console.log();
    console.log(`${c.bold}System${c.reset}`);
    console.log(`  ${sys.platform}/${sys.arch}  ${sys.cpuModel}  cores=${sys.cpuCount}`);
    console.log(`  RAM:  ${sys.freeRamGb} GB free / ${sys.totalRamGb} GB total`);
    console.log(`  Disk: ${sys.modelsDirFreeGb} GB free in ${sys.modelsDir}`);
    console.log(
      `  Accel: ${sys.metalSupported ? "Metal" : sys.cudaSupported ? "CUDA" : "CPU only"}`,
    );

    if (overview.activeDownloads.length > 0) {
      console.log();
      console.log(`${c.bold}Active downloads${c.reset}`);
      for (const d of overview.activeDownloads) {
        console.log(`  ${d.modelId}  ${pctBar(d)}`);
      }
    }
    console.log();
  },
});

function printRoleLine(
  role: string,
  resolved: ResolvedAssignment,
  catalog: CatalogEntry[],
  installed: ManifestEntry[],
): void {
  const activeId = resolvedActiveId(resolved);
  const displayName = activeId
    ? (catalog.find((e) => e.id === activeId)?.name ?? activeId)
    : resolved.kind === "disabled"
      ? "(disabled)"
      : resolved.kind === "http"
        ? `HTTP: ${resolved.model}`
        : resolved.kind === "replay"
          ? "Replay (demo mode)"
          : resolved.kind === "codex"
            ? `Codex: ${resolved.model}`
            : "(none)";
  const available =
    resolved.kind === "replay" ||
    (resolved.kind !== "disabled" && resolved.kind !== "unresolved" && resolved.available);
  const status =
    available && resolved.kind === "codex"
      ? `${c.green}configured${c.reset}`
      : available
        ? `${c.green}ready${c.reset}`
        : `${c.yellow}unavailable${c.reset}`;
  const reason =
    "reason" in resolved && resolved.reason ? `  ${c.dim}— ${resolved.reason}${c.reset}` : "";
  // Show file size for local GGUF models
  const sizeHint =
    resolved.kind === "local" && activeId
      ? (() => {
          const m = installed.find((i) => i.id === activeId);
          return m ? `  ${c.dim}(${formatSize(m.sizeBytes)})${c.reset}` : "";
        })()
      : "";
  console.log(`  ${role.padEnd(20)} ${displayName}  [${status}]${sizeHint}${reason}`);
}

const modelDoctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Verify on-disk integrity (size + sha256) for one or all installed models",
  },
  args: {
    id: { type: "positional", description: "catalog id (optional)", required: false },
  },
  async run(ctx) {
    const id = typeof ctx.args.id === "string" && ctx.args.id ? ctx.args.id : undefined;
    const overview = await getOverview();
    const ids = id ? [id] : overview.installed.map((m) => m.id);
    if (ids.length === 0) {
      console.log("No installed models to check.");
      return;
    }
    for (const x of ids) {
      const res = await gatewayJson<{ issues: string[] }>(
        `/admin/models/doctor/${encodeURIComponent(x)}`,
      );
      if (res.issues.length === 0) {
        console.log(`${c.green}✔${c.reset} ${x}`);
      } else {
        console.log(`${c.red}✖${c.reset} ${x}`);
        for (const i of res.issues) console.log(`    ${i}`);
      }
    }
  },
});

export const modelCommand = defineCommand({
  meta: {
    name: "model",
    description: "Install / assign / uninstall embedding, agent, and transcription models",
  },
  subCommands: {
    list: modelListCommand,
    catalog: modelCatalogCommand,
    show: modelShowCommand,
    install: modelInstallCommand,
    assign: modelAssignCommand,
    uninstall: modelUninstallCommand,
    status: modelStatusCommand,
    doctor: modelDoctorCommand,
  },
  // Default to `list` when no subcommand is given.
  async run(ctx) {
    if (ctx.rawArgs.filter((a) => !a.startsWith("-")).length === 0) {
      const { runCommand } = await import("citty");
      await runCommand(modelListCommand, { rawArgs: [] });
    }
  },
});
