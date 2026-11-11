// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The models.dev catalog of decision models.
 *
 * models.dev's default catalog leaves specialised model types out; decision
 * models are served by `api.json?type=decision`, one small document listing
 * each provider's decision models with their context window and price. The
 * setup forms use it to offer a provider's current decision models next to the
 * preset's own list. Like the main catalog, it ships as a snapshot so the forms
 * work offline, and a gateway-local copy is revalidated at most once a day
 * when the Models overview is read.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  PROVIDER_PRESETS,
  createLogger,
  providerPresetView,
  type DecisionModelOption,
  type ProviderPresetView,
} from "@omnesis/core";
import { readBounded } from "./models-dev-catalog.js";

const log = createLogger("gateway:models-dev:decisions");
const CATALOG_URL = "https://models.dev/api.json?type=decision";
const REFRESH_MS = 24 * 60 * 60 * 1000;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12_000;
/** A refreshed catalog smaller than this is treated as truncated and ignored. */
const MIN_PROVIDERS = 3;
const MIN_MODELS = 10;

const modelSchema = z
  .object({
    type: z.string().optional(),
    name: z.string().optional(),
    limit: z.object({ context: z.number().optional() }).passthrough().optional(),
    cost: z.object({ input: z.number().optional() }).passthrough().optional(),
  })
  .passthrough();
const providerSchema = z
  .object({ name: z.string(), models: z.record(z.string(), modelSchema) })
  .passthrough();
const catalogSchema = z.record(z.string(), providerSchema);
type DecisionCatalog = z.infer<typeof catalogSchema>;

export interface ModelsDevDecisionCatalogOptions {
  configDir: string;
  /** Injected test catalog; production reads the committed snapshot. */
  bundled?: unknown;
  bundledFetchedAt?: number;
  fetcher?: typeof fetch;
  now?: () => number;
}

function readBundled(): { catalog: DecisionCatalog; fetchedAt: number } {
  const base = new URL("../../models-dev/", import.meta.url);
  const catalog = catalogSchema.parse(
    JSON.parse(readFileSync(new URL("decision.json", base), "utf8")),
  );
  const snapshot = JSON.parse(readFileSync(new URL("decision-snapshot.json", base), "utf8")) as {
    fetchedAt: string;
  };
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  return { catalog, fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : 0 };
}

function coverage(catalog: DecisionCatalog): { providers: number; models: number } {
  const providers = Object.values(catalog).filter((p) =>
    Object.values(p.models).some((m) => m.type === "decision"),
  ).length;
  const models = Object.values(catalog).reduce(
    (n, p) => n + Object.values(p.models).filter((m) => m.type === "decision").length,
    0,
  );
  return { providers, models };
}

export class ModelsDevDecisionCatalog {
  private catalog: DecisionCatalog;
  private checkedAt: number;
  private etag?: string;
  private refreshPending?: Promise<void>;
  private readonly cacheDir: string;
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;

  constructor(opts: ModelsDevDecisionCatalogOptions) {
    const bundled =
      opts.bundled === undefined
        ? readBundled()
        : { catalog: catalogSchema.parse(opts.bundled), fetchedAt: opts.bundledFetchedAt ?? 0 };
    this.catalog = bundled.catalog;
    this.checkedAt = bundled.fetchedAt;
    this.cacheDir = join(opts.configDir, "models-dev");
    this.now = opts.now ?? Date.now;
    this.fetcher = opts.fetcher ?? fetch;
    try {
      const catalogPath = join(this.cacheDir, "decision.json");
      if (existsSync(catalogPath)) {
        const cached = catalogSchema.parse(JSON.parse(readFileSync(catalogPath, "utf8")));
        const state = JSON.parse(
          readFileSync(join(this.cacheDir, "decision-state.json"), "utf8"),
        ) as { checkedAt: number; etag?: string };
        const { providers, models } = coverage(cached);
        if (
          providers >= MIN_PROVIDERS &&
          models >= MIN_MODELS &&
          Number.isFinite(state.checkedAt) &&
          state.checkedAt >= this.checkedAt
        ) {
          this.catalog = cached;
          this.checkedAt = state.checkedAt;
          this.etag = typeof state.etag === "string" ? state.etag : undefined;
        }
      }
    } catch (err) {
      log.warn(
        `Ignoring invalid local decision catalog cache: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** A single fetch is shared by simultaneous reads. */
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
        this.trySave("decision-state.json", this.stateJson());
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const raw = await readBounded(response.body, MAX_CATALOG_BYTES);
      const candidate = catalogSchema.parse(JSON.parse(raw.toString("utf8")));
      const { providers, models } = coverage(candidate);
      if (providers < MIN_PROVIDERS || models < MIN_MODELS) {
        throw new Error("decision catalog is unexpectedly small");
      }
      this.catalog = candidate;
      this.checkedAt = checkedAt;
      this.etag = response.headers.get("etag") ?? undefined;
      if (this.trySave("decision.json", raw)) this.trySave("decision-state.json", this.stateJson());
      log.info(`Refreshed models.dev decision catalog (${models} models)`);
    } catch (err) {
      this.checkedAt = checkedAt;
      this.trySave("decision-state.json", this.stateJson());
      log.warn(
        `models.dev decision catalog refresh failed; using the cached copy: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private stateJson(): string {
    return JSON.stringify({ checkedAt: this.checkedAt, etag: this.etag });
  }

  private trySave(filename: string, data: string | Buffer): boolean {
    const path = join(this.cacheDir, filename);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, data, { mode: 0o600 });
      renameSync(temporary, path);
      return true;
    } catch (err) {
      rmSync(temporary, { force: true });
      log.warn(
        `models.dev decision cache write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /** The decision models models.dev lists for a provider, by id. */
  models(modelsDevId: string): Map<string, DecisionModelOption> {
    const out = new Map<string, DecisionModelOption>();
    const provider = Object.hasOwn(this.catalog, modelsDevId) ? this.catalog[modelsDevId] : null;
    for (const [id, model] of Object.entries(provider?.models ?? {})) {
      if (model.type !== "decision") continue;
      const context = model.limit?.context;
      const price = model.cost?.input;
      out.set(id, {
        id,
        ...(context && context > 0 ? { contextTokens: context } : {}),
        ...(typeof price === "number" ? { inputCostPerMillion: price } : {}),
        source: "models.dev",
      });
    }
    return out;
  }

  /**
   * Every provider preset, a decision API's models merged from the preset's
   * own list and the models models.dev lists for the provider.
   */
  presets(): ProviderPresetView[] {
    return PROVIDER_PRESETS.map((preset) =>
      providerPresetView(
        preset,
        preset.decision?.modelsDevId ? this.models(preset.decision.modelsDevId) : undefined,
      ),
    );
  }
}
