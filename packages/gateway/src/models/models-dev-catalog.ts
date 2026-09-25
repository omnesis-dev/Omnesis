// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Models.dev is an advisory catalog for exact serving-provider/model pairs.
 * A committed snapshot keeps Omnesis usable offline. A gateway-local copy is
 * revalidated at most once per day when a model picker reads /admin/models.
 * Provider SVGs are fetched through this same gateway and retained forever
 * after the first successful fetch.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createLogger,
  assertNever,
  getPreset,
  type InferenceOverview,
  type ModelControls,
  type ModelControlDescriptor,
  type ModelBehaviorValues,
  type ModelSettingsByRole,
  type CapabilityRole,
  type CodexBackendStatus,
  type ResolvedAssignment,
} from "@omnesis/core";
import { supportsModelReasoningControl } from "@omnesis/agent";
import type { OmnesisConfig } from "@omnesis/config";

const log = createLogger("gateway:models-dev");
const CATALOG_URL = "https://models.dev/api.json";
const LOGO_BASE_URL = "https://models.dev/logos/";
const REFRESH_MS = 24 * 60 * 60 * 1000;
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const MAX_SVG_BYTES = 100 * 1024;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_CONCURRENT_LOGO_FETCHES = 4;

const providerSchema = z
  .object({
    name: z.string(),
    models: z.record(z.string(), z.unknown()),
  })
  .passthrough();
const catalogSchema = z.record(z.string(), providerSchema);
const effortSchema = z
  .object({ type: z.literal("effort"), values: z.array(z.string().nullable()) })
  .passthrough();
const toggleSchema = z.object({ type: z.literal("toggle") }).passthrough();
const budgetSchema = z
  .object({
    type: z.literal("budget_tokens"),
    // NVIDIA uses -1 for no reasoning-budget enforcement.
    min: z.number().int().min(-1).optional(),
    max: z.number().int().positive().optional(),
  })
  .passthrough();
const reasoningOptionSchema = z.union([effortSchema, toggleSchema, budgetSchema]);
const interleavedFieldSchema = z
  .object({ field: z.enum(["reasoning_content", "reasoning_details"]) })
  .passthrough();
const modelSchema = z
  .object({
    reasoning: z.boolean().optional(),
    // New option kinds must not hide still-valid model modalities and tool facts.
    reasoning_options: z.array(z.unknown()).optional(),
    modalities: z.object({ input: z.array(z.string()), output: z.array(z.string()) }).optional(),
    tool_call: z.boolean().optional(),
    // Unknown future fields must not hide still-valid modalities and tool facts.
    interleaved: z.unknown().optional(),
  })
  .passthrough();

type ProviderMap = z.infer<typeof catalogSchema>;
interface CacheState {
  checkedAt: number;
  etag?: string;
}

export interface ModelsDevCatalogOptions {
  configDir: string;
  /** Injected test catalog; production reads the committed snapshot. */
  bundled?: unknown;
  /** Injected test snapshot time; production reads snapshot.json. */
  bundledFetchedAt?: number;
  fetcher?: typeof fetch;
  now?: () => number;
  /** Test fixture threshold; production rejects unexpectedly truncated catalogs. */
  minProviderCount?: number;
  minModelCount?: number;
}

function readBundled(): { catalog: ProviderMap; fetchedAt: number } {
  const base = new URL("../../models-dev/", import.meta.url);
  const catalog = catalogSchema.parse(JSON.parse(readFileSync(new URL("api.json", base), "utf8")));
  const snapshot = JSON.parse(readFileSync(new URL("snapshot.json", base), "utf8")) as {
    fetchedAt: string;
  };
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  return { catalog, fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : 0 };
}

function readBounded(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Buffer> {
  if (!body) throw new Error("empty response body");
  return (async () => {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error("response exceeds size limit");
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  })();
}

/** Restrict cached SVGs to passive path-based logos, not active browser content. */
export function validateProviderSvg(input: Buffer): Buffer {
  if (input.length === 0 || input.length > MAX_SVG_BYTES) throw new Error("invalid SVG size");
  const svg = input.toString("utf8");
  if (!/^\s*(?:<\?xml[^>]*>\s*)?<svg\b[\s\S]*<\/svg>\s*$/i.test(svg)) {
    throw new Error("response is not an SVG document");
  }
  if (
    /<(?:script|style|foreignObject|image|a|use|iframe|object|embed)\b|<!doctype|<\?xml-stylesheet|\bon[a-z]+\s*=|\bhref\s*=|\burl\s*\(/i.test(
      svg,
    )
  ) {
    throw new Error("SVG contains active or external content");
  }
  const passiveTags = new Set([
    "svg",
    "g",
    "defs",
    "path",
    "circle",
    "rect",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "clippath",
    "mask",
    "lineargradient",
    "radialgradient",
    "stop",
    "title",
    "desc",
    "text",
    "tspan",
  ]);
  for (const tag of svg.matchAll(/<\s*\/?\s*([a-z][\w:-]*)\b/gi)) {
    if (!passiveTags.has(tag[1]!.toLowerCase())) {
      throw new Error("SVG contains active or external content");
    }
  }
  if (/\bstyle\s*=|\b(?:src|formaction)\s*=/i.test(svg)) {
    throw new Error("SVG contains active or external content");
  }
  return input;
}

function assignmentId(resolved: ResolvedAssignment): string | null {
  switch (resolved.kind) {
    case "http":
      return `${resolved.backendKey}/${resolved.model}`;
    case "anthropic":
      return `anthropic/${resolved.apiModelId}`;
    case "local":
      return `local/${resolved.catalogId}`;
    case "codex":
      return `codex/${resolved.model}`;
    case "disabled":
    case "unresolved":
    case "replay":
      return null;
    default:
      return assertNever(resolved);
  }
}

export class ModelsDevCatalog {
  private catalog: ProviderMap;
  private checkedAt: number;
  private etag?: string;
  private readonly cacheDir: string;
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  private readonly minProviderCount: number;
  private readonly minModelCount: number;
  private refreshPending?: Promise<void>;
  private readonly logoPending = new Map<string, Promise<Buffer>>();
  private readonly logoMemory = new Map<string, Buffer>();
  private readonly logoWaiters: Array<() => void> = [];
  private activeLogoFetches = 0;

  constructor(opts: ModelsDevCatalogOptions) {
    const bundled =
      opts.bundled === undefined
        ? readBundled()
        : { catalog: catalogSchema.parse(opts.bundled), fetchedAt: opts.bundledFetchedAt ?? 0 };
    this.catalog = bundled.catalog;
    this.checkedAt = bundled.fetchedAt;
    this.cacheDir = join(opts.configDir, "models-dev");
    this.now = opts.now ?? Date.now;
    this.fetcher = opts.fetcher ?? fetch;
    this.minProviderCount = opts.minProviderCount ?? 100;
    this.minModelCount = opts.minModelCount ?? 1000;
    const catalogPath = join(this.cacheDir, "api.json");
    const statePath = join(this.cacheDir, "state.json");
    try {
      if (existsSync(catalogPath)) {
        const cached = catalogSchema.parse(JSON.parse(readFileSync(catalogPath, "utf8")));
        if (!this.hasMinimumCoverage(cached))
          throw new Error("local catalog is unexpectedly small");
        const state = JSON.parse(readFileSync(statePath, "utf8")) as CacheState;
        if (Number.isFinite(state.checkedAt) && state.checkedAt >= this.checkedAt) {
          this.catalog = cached;
          this.checkedAt = state.checkedAt;
          this.etag = typeof state.etag === "string" ? state.etag : undefined;
        }
      }
    } catch (err) {
      log.warn(
        `Ignoring invalid local Models.dev cache: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** A single fetch is shared by simultaneous portal/mobile picker reads. */
  async refreshIfStale(): Promise<void> {
    if (this.now() - this.checkedAt < REFRESH_MS) return;
    if (this.refreshPending) return this.refreshPending;
    this.refreshPending = this.refreshOnce().finally(() => {
      this.refreshPending = undefined;
    });
    return this.refreshPending;
  }

  private async refreshOnce(): Promise<void> {
    const checkedAt = this.now();
    try {
      const headers: Record<string, string> = {};
      if (this.etag) headers["If-None-Match"] = this.etag;
      const response = await this.fetcher(CATALOG_URL, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.status === 304) {
        this.checkedAt = checkedAt;
        this.trySaveState();
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const raw = await readBounded(response.body, MAX_CATALOG_BYTES);
      const candidate = catalogSchema.parse(JSON.parse(raw.toString("utf8")));
      // A truncated but syntactically valid response must not displace a good snapshot.
      if (!this.hasMinimumCoverage(candidate)) {
        throw new Error("catalog is unexpectedly small");
      }
      this.catalog = candidate;
      this.checkedAt = checkedAt;
      this.etag = response.headers.get("etag") ?? undefined;
      // Cache persistence is advisory; a read-only/full config directory must
      // not prevent an in-memory catalog from serving the model picker.
      if (this.trySaveCatalog(raw)) this.trySaveState();
      log.info(`Refreshed Models.dev catalog (${Object.keys(candidate).length} providers)`);
    } catch (err) {
      // Keep the last known good snapshot, and debounce repeated offline reads.
      this.checkedAt = checkedAt;
      this.trySaveState();
      log.warn(
        `Models.dev refresh failed; using cached snapshot: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private atomicWrite(filename: string, data: string | Buffer): void {
    mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
    const path = join(this.cacheDir, filename);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, data, { mode: 0o600 });
      renameSync(temporary, path);
    } catch (err) {
      rmSync(temporary, { force: true });
      throw err;
    }
  }

  private hasMinimumCoverage(candidate: ProviderMap): boolean {
    return (
      Object.keys(candidate).length >= this.minProviderCount &&
      Object.values(candidate).reduce(
        (n, provider) => n + Object.keys(provider.models).length,
        0,
      ) >= this.minModelCount
    );
  }

  private trySaveCatalog(raw: Buffer): boolean {
    try {
      this.atomicWrite("api.json", raw);
      return true;
    } catch (err) {
      log.warn(
        `Models.dev catalog cache write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  private trySaveState(): void {
    try {
      this.atomicWrite(
        "state.json",
        JSON.stringify({ checkedAt: this.checkedAt, etag: this.etag } satisfies CacheState),
      );
    } catch (err) {
      log.warn(
        `Models.dev cache state write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Resolve an Omnesis preset alias, or an exact Models.dev provider ID. */
  providerId(requested: string, backendUrl?: string): string | null {
    if (Object.hasOwn(this.catalog, requested)) return requested;
    const preset = getPreset(requested);
    const byPreset = preset?.modelsDevId ?? preset?.id;
    if (byPreset && Object.hasOwn(this.catalog, byPreset)) return byPreset;
    if (backendUrl) {
      const url = backendUrl.replace(/\/+$/, "");
      for (const id of [
        "openai",
        "google",
        "groq",
        "cerebras",
        "together",
        "fireworks",
        "mistral",
        "deepseek",
        "nvidia",
        "xai",
        "meta",
        "moonshot",
        "openrouter",
      ]) {
        const item = getPreset(id);
        if (item && url === item.defaultUrl.replace(/\/+$/, "")) {
          const provider = item.modelsDevId ?? item.id;
          if (Object.hasOwn(this.catalog, provider)) return provider;
        }
      }
    }
    return null;
  }

  /** Provider-specific model lookup. Google prefixes IDs with `models/` on its shim. */
  model(providerId: string, servedModelId: string): z.infer<typeof modelSchema> | null {
    if (!Object.hasOwn(this.catalog, providerId)) return null;
    const provider = this.catalog[providerId]!;
    const id =
      providerId === "google" && servedModelId.startsWith("models/")
        ? servedModelId.slice("models/".length)
        : servedModelId;
    if (!Object.hasOwn(provider.models, id)) return null;
    const raw = provider.models[id];
    if (!raw) return null;
    const parsed = modelSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn(`Ignoring invalid Models.dev entry for provider=${providerId} model=${id}`);
      return null;
    }
    return parsed.data;
  }

  controlsFor(assignment: string, inference: InferenceOverview): ModelControls {
    const slash = assignment.indexOf("/");
    const backend = slash > 0 ? assignment.slice(0, slash) : assignment;
    const modelId = slash > 0 ? assignment.slice(slash + 1) : "";
    if (backend === "codex" && inference.codex)
      return this.controlsForCodex(modelId, inference.codex);
    const status = inference.backends[backend];
    const facts = this.controlsForBackend(backend, modelId, status?.url, status?.protocol);
    return status?.type === "http" ? facts : { ...facts, controls: [] };
  }

  private controlsForCodex(modelId: string, status: CodexBackendStatus): ModelControls {
    const detail = status.modelDetails?.find((candidate) => candidate.id === modelId);
    const values = detail?.supportedReasoningEfforts ?? [];
    return {
      providerId: "openai",
      providerName: "OpenAI",
      source: detail ? "provider" : "unknown",
      reasoning: values.length > 0 ? true : null,
      controls:
        values.length > 0
          ? [{ key: "reasoningEffort", type: "enum", label: "Reasoning effort", values }]
          : [],
      ...(detail
        ? { modalities: { input: detail.inputModalities ?? ["text", "image"], output: ["text"] } }
        : {}),
      ...(detail ? { toolCall: true } : {}),
      logoUrl: "/model-logos/openai.svg",
    };
  }

  controlsForBackend(
    backend: string,
    modelId: string,
    backendUrl?: string,
    protocol: "chat-completions" | "responses" = "chat-completions",
  ): ModelControls {
    const providerId = this.providerId(backend, backendUrl);
    const model = providerId && modelId ? this.model(providerId, modelId) : null;
    const interleaved = interleavedFieldSchema.safeParse(model?.interleaved);
    const controls: ModelControlDescriptor[] = [];
    for (const rawOption of model?.reasoning_options ?? []) {
      const parsed = reasoningOptionSchema.safeParse(rawOption);
      if (!parsed.success) continue;
      const option = parsed.data;
      switch (option.type) {
        case "toggle":
          controls.push({ key: "reasoningEnabled", type: "boolean", label: "Reasoning" });
          break;
        case "effort": {
          const values = option.values.filter((value): value is string => value !== null);
          if (values.length > 0)
            controls.push({
              key: "reasoningEffort",
              type: "enum",
              label: "Reasoning effort",
              values,
            });
          break;
        }
        case "budget_tokens":
          controls.push({
            key: "reasoningBudgetTokens",
            type: "integer",
            label: "Reasoning token budget",
            ...(option.min === undefined ? {} : { min: option.min }),
            ...(option.max === undefined ? {} : { max: option.max }),
          });
          break;
      }
    }
    // Models.dev lists native choices, but not their HTTP field names. Show only
    // controls the serving protocol can actually carry through our wire adapter.
    const catalogFacts: ModelControls = {
      providerId: providerId ?? backend,
      source: model ? "models.dev" : "unknown",
      reasoning: model?.reasoning ?? null,
      controls,
      logoUrl: `/model-logos/${encodeURIComponent(providerId ?? backend)}.svg`,
    };
    const supported = controls.filter(
      (control) =>
        providerId &&
        supportsModelReasoningControl(providerId, control.key, protocol, catalogFacts),
    );
    if (
      providerId === "openrouter" &&
      supported.some((c) => c.key === "reasoningEffort") &&
      supported.some((c) => c.key === "reasoningBudgetTokens")
    ) {
      supported.find((c) => c.key === "reasoningEffort")!.exclusiveWith = ["reasoningBudgetTokens"];
      supported.find((c) => c.key === "reasoningBudgetTokens")!.exclusiveWith = ["reasoningEffort"];
    }
    if (providerId === "google" || (providerId === "deepseek" && protocol === "responses")) {
      for (const control of supported) {
        control.exclusiveWith = supported
          .filter((other) => other.key !== control.key)
          .map((other) => other.key);
      }
    }
    return {
      providerId: providerId ?? backend,
      ...(providerId ? { providerName: this.catalog[providerId]?.name } : {}),
      source: model ? "models.dev" : "unknown",
      reasoning: model?.reasoning ?? null,
      controls: supported,
      ...(model?.modalities ? { modalities: model.modalities } : {}),
      ...(model?.tool_call !== undefined ? { toolCall: model.tool_call } : {}),
      ...(interleaved.success ? { interleavedReasoningField: interleaved.data.field } : {}),
      logoUrl: `/model-logos/${encodeURIComponent(providerId ?? backend)}.svg`,
    };
  }

  overview(
    inference: InferenceOverview,
    config: OmnesisConfig,
  ): {
    modelControls: Record<string, ModelControls>;
    modelSettings: ModelSettingsByRole;
  } {
    const modelControls: Record<string, ModelControls> = {};
    for (const [backend, status] of Object.entries(inference.backends)) {
      for (const model of new Set([
        ...(status.models ?? []),
        ...Object.keys(status.modelRoles ?? {}),
      ])) {
        const id = `${backend}/${model}`;
        modelControls[id] = this.controlsFor(id, inference);
      }
    }
    const modelSettings: ModelSettingsByRole = {};
    for (const [role, resolved] of Object.entries(inference.assignments)) {
      const cap = role as CapabilityRole;
      // An explicit null disables the role even while the registry still
      // reports its previous HTTP assignment during an asynchronous update.
      const configured = config.inference?.assignments?.[cap];
      const active = configured === undefined ? assignmentId(resolved) : configured;
      const assignment = typeof active === "string" ? active : null;
      if (assignment && !modelControls[assignment])
        modelControls[assignment] = this.controlsFor(assignment, inference);
      const saved = config.inference?.modelSettings?.[cap];
      modelSettings[cap] = {
        assignment,
        values: saved?.assignment === assignment ? saved.values : {},
      };
    }
    return { modelControls, modelSettings };
  }

  validateValues(
    assignment: string,
    values: ModelBehaviorValues,
    inference: InferenceOverview,
  ): void {
    const facts = this.controlsFor(assignment, inference);
    const controls = facts.controls;
    if (
      values.reasoningEnabled === false &&
      (values.reasoningEffort !== undefined || values.reasoningBudgetTokens !== undefined)
    ) {
      throw new Error("Disable reasoning without an effort or token budget");
    }
    if (
      facts.providerId === "openrouter" &&
      values.reasoningEffort !== undefined &&
      values.reasoningBudgetTokens !== undefined
    ) {
      throw new Error("OpenRouter accepts either reasoning effort or a token budget, not both");
    }
    const descriptors = new Map(controls.map((control) => [control.key, control]));
    for (const [key, value] of Object.entries(values)) {
      const control = descriptors.get(key as keyof ModelBehaviorValues);
      if (!control) throw new Error(`${key} is not configurable for this provider/model`);
      if (control.exclusiveWith?.some((excluded) => values[excluded] !== undefined)) {
        throw new Error(`${key} cannot be combined with this provider's other reasoning controls`);
      }
      if (control.type === "boolean" && typeof value !== "boolean")
        throw new Error(`${key} must be boolean`);
      if (
        control.type === "enum" &&
        (typeof value !== "string" || !control.values?.includes(value))
      ) {
        throw new Error(`${key} must be one of the advertised effort values`);
      }
      if (
        control.type === "integer" &&
        (typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < (control.min ?? 0) ||
          (control.max !== undefined && value > control.max))
      ) {
        throw new Error(`${key} must be inside the advertised token-budget bounds`);
      }
    }
  }

  private async withLogoSlot<T>(work: () => Promise<T>): Promise<T> {
    // The public image route may be requested without an admin token. Hand a
    // completed slot directly to the next waiter so new calls cannot overtake it.
    if (this.activeLogoFetches < MAX_CONCURRENT_LOGO_FETCHES) this.activeLogoFetches++;
    else
      await new Promise<void>((resolve) => {
        this.logoWaiters.push(resolve);
      });
    try {
      return await work();
    } finally {
      const next = this.logoWaiters.shift();
      if (next) next();
      else this.activeLogoFetches--;
    }
  }

  async logo(requested: string): Promise<Buffer> {
    // Local Ollama has no model catalog entry; the cloud provider shares its brand glyph.
    const logoProvider =
      requested === "codex" ? "openai" : requested === "ollama" ? "ollama-cloud" : requested;
    const providerId = this.providerId(logoProvider);
    if (!providerId) throw new Error("unknown Models.dev provider");
    const inMemory = this.logoMemory.get(providerId);
    if (inMemory) return inMemory;
    const path = join(this.cacheDir, "logos", `${providerId}.svg`);
    if (existsSync(path)) {
      try {
        const cached = validateProviderSvg(readFileSync(path));
        this.logoMemory.set(providerId, cached);
        return cached;
      } catch {
        /* Corrupt cache is replaced below. */
      }
    }
    const pending = this.logoPending.get(providerId);
    if (pending) return pending;
    const run = this.withLogoSlot(async () => {
      const response = await this.fetcher(`${LOGO_BASE_URL}${providerId}.svg`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`logo fetch HTTP ${response.status}`);
      const svg = validateProviderSvg(await readBounded(response.body, MAX_SVG_BYTES));
      this.logoMemory.set(providerId, svg);
      let temporary: string | undefined;
      try {
        mkdirSync(join(this.cacheDir, "logos"), { recursive: true, mode: 0o700 });
        temporary = `${path}.${randomUUID()}.tmp`;
        writeFileSync(temporary, svg, { mode: 0o600 });
        renameSync(temporary, path);
      } catch (err) {
        if (temporary)
          try {
            rmSync(temporary, { force: true });
          } catch {
            /* Cache is advisory. */
          }
        log.warn(
          `Models.dev logo cache write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return svg;
    }).finally(() => {
      this.logoPending.delete(providerId);
    });
    this.logoPending.set(providerId, run);
    return run;
  }
}
