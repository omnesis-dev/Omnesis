// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync } from "node:fs";
import { join } from "node:path";
import { CODEX_SUPPORTED_ROLES } from "@omnesis/core";
import {
  createLogger,
  getCatalogEntry as getBundledCatalogEntry,
  getCatalogEntryByFilename,
  defaultForRole,
  findManifestEntry,
  classifyModels,
  normalizeApiPathPrefix,
  extractModelIds,
  CLOUD_EGRESS_DISABLED_REASON,
  parseConfigSecretRef,
  readConfigSecretRefSync,
  fetchWithInferenceUrlPolicy,
  CAPABILITY_ROLES,
  type Manifest,
  type CapabilityRole,
  type DegradedRole,
  type ConfigHealth,
  type GgufCatalogEntry,
  type AssignmentValue,
  type ResolvedAssignment,
  type ResolvedLocal,
  type OcrNativeRuntime,
  type ResolvedAnthropic,
  type ResolvedReplay,
  type ResolvedCodex,
  type InferenceOverview,
  type BackendStatus,
  type CapabilityVerdict,
  type HttpBackendConfig,
  type CatalogEntry,
} from "@omnesis/core";
import type { OmnesisConfig } from "@omnesis/config";

const log = createLogger("inference:registry");

/** Timeout for HTTP backend probe requests. */
const PROBE_TIMEOUT_MS = 10_000;

/** How often the starvation sampler checks in while a probe is in flight. */
const LOOP_LAG_SAMPLE_MS = 250;

/**
 * How far behind schedule the event loop must fall during a probe before a
 * failed probe stops being evidence about the backend.
 *
 * Everything a probe depends on — the DNS lookup, the socket, the
 * `AbortSignal.timeout` that bounds it — is delivered on the event loop. A
 * starved loop delays all of them, so the probe reports a failure it never
 * gave the backend a chance to avoid. Elapsed wall time cannot stand in for
 * this: a hung DNS lookup and a starved loop both take thirty seconds, and
 * only one of them is the backend's fault.
 */
const LOOP_LAG_STARVATION_MS = 2_000;

/** Prefixes the held reason so an operator can see the probe judged nothing. */
const STARVED_PROBE_REASON = "Probe inconclusive — gateway too busy to measure";

/**
 * Consecutive inconclusive probes a backend's last real verdict survives.
 *
 * Holding is a courtesy extended to a backend we could not measure, not a
 * licence to stop measuring. A gateway that stays busy indefinitely would
 * otherwise pin a stale verdict forever — reporting a dead backend healthy is
 * the same failure as reporting a healthy one dead, just aimed the other way.
 */
const MAX_CONSECUTIVE_HOLDS = 5;

/** Base delay before the first re-probe of an unreachable backend. */
const DEFAULT_REPROBE_BASE_MS = 60_000;
/** Cap on the exponential re-probe backoff for a persistently-down backend. */
const DEFAULT_REPROBE_MAX_MS = 15 * 60_000;
/**
 * Earliest a backend may be re-probed after an inconclusive result — a floor,
 * not a period: the driving task's own cadence decides the rest. Deliberately
 * short and flat, because the backend is not suspected of anything and the
 * exponential ladder exists to stop hammering something known to be down.
 */
const INCONCLUSIVE_REPROBE_MS = 15_000;

/**
 * Watches how far behind schedule the event loop runs, for as long as it is
 * kept. Reports the worst delay it saw, which is what says whether anything
 * measured during that window can be believed.
 */
function sampleLoopLag(): { worstMs: () => number; stop: () => void } {
  let worst = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - LOOP_LAG_SAMPLE_MS);
    last = now;
  }, LOOP_LAG_SAMPLE_MS);
  timer.unref?.();
  return {
    // Counts the delay still outstanding as well as the ones already recorded:
    // a block that has only just ended has not let the sampler tick yet, and
    // that stretch is precisely the one a failing probe ran through.
    worstMs: () => Math.max(worst, performance.now() - last - LOOP_LAG_SAMPLE_MS),
    stop: () => clearInterval(timer),
  };
}

/** The verdict of one probe, plus whether it was able to reach one at all. */
export interface ProbeOutcome {
  status: "ok" | "reachable" | "unreachable";
  models: string[];
  reason?: string;
  /**
   * The probe could not be run fairly and returned the backend's previous
   * status untouched. Not evidence for or against the backend.
   */
  inconclusive?: boolean;
}

type ResolvedHttpBackendConfig = HttpBackendConfig & {
  apiKeySecretError?: string;
};

/**
 * Map capability roles to catalog roles for default resolution. Only the
 * embedder auto-defaults to its recommended catalog model (search can't run
 * without it); every other role — agent, transcriber, … — stays disabled
 * until explicitly assigned, so transcription never starts on its own just
 * because a Whisper model happens to be on disk.
 */
const ROLE_TO_CATALOG_ROLE = {
  embedder: "embed",
  agent: undefined,
  "privacy-reviewer": undefined,
  transcriber: undefined,
  ocr: undefined,
  "background-agent": undefined,
  "watch-judge": undefined,
  "entailment-verifier": undefined,
  "brief-judge": undefined,
} as const;

/**
 * Heal backend URLs that carry the OpenAI-compatible version path inline. Many
 * providers and SDK snippets document a "base URL" ending in `/v1`, while
 * Omnesis stores that path in `apiPathPrefix`. Split those pasted URLs on load
 * so the request builders don't append a second `/v1`. Idempotent and
 * self-healing — runs on every config load, no persisted migration needed.
 */
function normalizeBackendConfig(cfg: HttpBackendConfig): HttpBackendConfig {
  if (cfg.apiPathPrefix) return cfg;
  let parsed: URL;
  try {
    parsed = new URL(cfg.url);
  } catch {
    return cfg;
  }

  const path = parsed.pathname.replace(/\/+$/, "");
  const match = path.match(/^(.*?)(\/v\d+(?:beta)?\/openai|\/v\d+(?:beta)?)$/i);
  if (!match) return cfg;

  const basePath = match[1] ?? "";
  const apiPathPrefix = match[2] ?? "";
  parsed.pathname = basePath || "";
  parsed.search = "";
  parsed.hash = "";
  return { ...cfg, url: parsed.toString().replace(/\/+$/, ""), apiPathPrefix };
}

/**
 * Built-in OCR runtimes selectable by a bare `inference.assignments.ocr`
 * value. They have no catalog/manifest entry (apple-vision and tesseract need
 * no model file; gguf reads its paths from `inference.ocr.gguf`), so the
 * registry resolves them to a `ResolvedLocal` carrying `nativeRuntime` rather
 * than routing through the GGUF catalog path. See `OcrNativeRuntime`.
 */
const NATIVE_OCR_RUNTIMES = new Set<OcrNativeRuntime>(["apple-vision", "tesseract", "gguf"]);

/**
 * Roles that can actually run a cloud (Anthropic/Codex) backend. The
 * transcriber, ocr, and embedder loaders are local/HTTP-only and reject a cloud
 * assignment regardless of `allowRemoteInference`, so an egress-off block is not
 * an actionable degradation for them.
 */
const CLOUD_CAPABLE_ROLES = new Set<CapabilityRole>([
  "agent",
  "privacy-reviewer",
  "background-agent",
  "watch-judge",
  "entailment-verifier",
  "brief-judge",
]);

function asNativeOcrRuntime(value: string): OcrNativeRuntime | undefined {
  return NATIVE_OCR_RUNTIMES.has(value as OcrNativeRuntime)
    ? (value as OcrNativeRuntime)
    : undefined;
}

export class InferenceRegistry {
  private modelsDir: string;
  private configDir: string;
  private getManifest: () => Manifest;
  private checkAnthropicKey: () => boolean;
  private lookupCatalogEntry: (id: string) => CatalogEntry | undefined;
  private getAnthropicStatus: () => BackendStatus | undefined;

  private httpBackends = new Map<
    string,
    { config: ResolvedHttpBackendConfig; status: BackendStatus }
  >();
  private assignmentValues: Partial<Record<CapabilityRole, AssignmentValue>> = {};
  private modelSettings: import("@omnesis/core").ModelSettingsByRole = {};
  private getModelControls?: (
    backendKey: string,
    model: string,
    backendUrl: string,
    protocol: "chat-completions" | "responses",
  ) => import("@omnesis/core").ModelControls;
  private allowRemoteInference = false;
  /** Monotone identity for config/probe state; lets hot paths avoid re-resolving unchanged roles. */
  private stateRevision = 0;
  /** Behavioral capability verdicts, keyed `${backendKey}::${model}::${role}`. */
  private verifyCache = new Map<string, CapabilityVerdict>();
  /** Per-backend exponential-backoff schedule for {@link reprobeUnavailable}. */
  private reprobeBackoff = new Map<string, { attempts: number; nextAt: number }>();
  /**
   * Per-backend count of probes in a row that measured only this process. Bounds
   * how long a stale verdict may be held; cleared by any probe that reached a
   * real answer. See {@link MAX_CONSECUTIVE_HOLDS}.
   */
  private consecutiveHolds = new Map<string, number>();

  constructor(opts: {
    modelsDir: string;
    configDir: string;
    manifest: () => Manifest;
    hasAnthropicApiKey: () => boolean;
    getCatalogEntry?: (id: string) => CatalogEntry | undefined;
    getAnthropicStatus?: () => BackendStatus | undefined;
    getModelControls?: (
      backendKey: string,
      model: string,
      backendUrl: string,
      protocol: "chat-completions" | "responses",
    ) => import("@omnesis/core").ModelControls;
  }) {
    this.modelsDir = opts.modelsDir;
    this.configDir = opts.configDir;
    this.getManifest = opts.manifest;
    this.checkAnthropicKey = opts.hasAnthropicApiKey;
    this.lookupCatalogEntry = opts.getCatalogEntry ?? getBundledCatalogEntry;
    this.getAnthropicStatus = opts.getAnthropicStatus ?? (() => undefined);
    this.getModelControls = opts.getModelControls;
  }

  /**
   * Re-read the inference block from the live config. Preserves probe
   * status for backends whose connection parameters haven't changed.
   * When backends are added, or their URL or credentials change, fires
   * an async re-probe — reachability depends on the API key the probe
   * sends, so a corrected key must re-probe rather than carry over the
   * stale status.
   */
  loadConfig(config: OmnesisConfig): void {
    this.stateRevision += 1;
    let needsProbe = false;
    const previousAllowRemoteInference = this.allowRemoteInference;
    this.allowRemoteInference = config.inference?.allowRemoteInference === true;
    const previous = new Map(this.httpBackends);
    this.httpBackends.clear();

    if (config.inference?.backends) {
      for (const [key, cfg] of Object.entries(config.inference.backends)) {
        const typedCfg = this.resolveBackendSecrets(
          key,
          normalizeBackendConfig(cfg as HttpBackendConfig),
        );
        const prev = previous.get(key);
        const hasApiKey = !!typedCfg.apiKey;
        const secretError = typedCfg.apiKeySecretError;
        const unchanged =
          prev &&
          prev.config.url === typedCfg.url &&
          prev.config.apiKey === typedCfg.apiKey &&
          prev.config.apiKeySecret === typedCfg.apiKeySecret &&
          prev.config.apiKeySecretError === typedCfg.apiKeySecretError &&
          prev.config.apiPathPrefix === typedCfg.apiPathPrefix &&
          previousAllowRemoteInference === this.allowRemoteInference;
        if (secretError) {
          this.httpBackends.set(key, {
            config: typedCfg,
            status: {
              type: "http",
              url: typedCfg.url,
              status: "unreachable",
              hasApiKey,
              reason: secretError,
            },
          });
          if (!unchanged) this.clearVerifyCache(key);
        } else if (unchanged) {
          this.httpBackends.set(key, {
            config: typedCfg,
            status: { ...prev.status, hasApiKey },
          });
        } else {
          this.httpBackends.set(key, {
            config: typedCfg,
            status: { type: "http", url: typedCfg.url, status: "probing", hasApiKey },
          });
          // A changed URL/key/prefix can change what the backend serves, so a
          // cached capability verdict is no longer trustworthy.
          this.clearVerifyCache(key);
          needsProbe = true;
        }
      }
    }

    // Drop verdicts for backends that no longer exist.
    for (const key of previous.keys()) {
      if (!this.httpBackends.has(key)) this.clearVerifyCache(key);
    }

    this.assignmentValues = { ...(config.inference?.assignments ?? {}) };
    this.modelSettings = { ...(config.inference?.modelSettings ?? {}) };

    if (needsProbe) {
      this.probeBackends().catch((err) => {
        log.warn(`Backend re-probe failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  /** Cheap change token for caches whose resolved provider depends on registry state. */
  revision(): number {
    return this.stateRevision;
  }

  /**
   * Resolve a capability role to a concrete assignment. Returns a
   * discriminated union so callers can switch on `kind`.
   *
   * Assignment strings use `"backend/model"` format:
   *   - `"local/<catalogId>"`        → local GGUF
   *   - `"anthropic/<apiModelId>"`   → Anthropic API
   *   - `"<httpKey>/<model>"`        → HTTP backend
   *   - `"replay"` / `"replay/..."` → replay (agent only)
   *   - bare string without `/`     → local GGUF (backward compat)
   */
  resolve(role: CapabilityRole): ResolvedAssignment {
    return this.resolveValue(role, this.assignmentValues[role]);
  }

  /**
   * Resolve an explicit assignment value for a role, rather than the
   * value currently configured for it. The recent-models route uses this
   * to project previously-used (now replaced) assignments into displays
   * without touching the live configuration.
   */
  resolveValue(role: CapabilityRole, value: AssignmentValue | undefined): ResolvedAssignment {
    if (value === null) return { role, kind: "disabled" };

    if (value === undefined) {
      const catalogRole = ROLE_TO_CATALOG_ROLE[role];
      if (!catalogRole) return { role, kind: "disabled" };
      const def = defaultForRole(catalogRole);
      if (!def) return { role, kind: "disabled" };
      return this.resolveLocalModel(role, def.id);
    }

    const slashIndex = value.indexOf("/");

    if (slashIndex === -1) {
      if (value === "replay") {
        if (role === "watch-judge") {
          return {
            role,
            kind: "unresolved",
            reason:
              "Watch judge requires a single-shot completion provider; Replay cannot serve it",
          };
        }
        return this.resolveReplay(role, undefined);
      }
      if (role === "ocr") {
        const runtime = asNativeOcrRuntime(value);
        if (runtime) return this.resolveNativeOcr(role, runtime);
      }
      return this.resolveLocalModel(role, value);
    }

    const prefix = value.slice(0, slashIndex);
    const suffix = value.slice(slashIndex + 1);

    if (prefix === "local") return this.resolveLocalModel(role, suffix);
    if (prefix === "anthropic") return this.resolveAnthropicModel(role, value, suffix);
    if (prefix === "codex") return this.resolveCodex(role, suffix);
    if (prefix === "replay") {
      if (role === "watch-judge") {
        return {
          role,
          kind: "unresolved",
          reason: "Watch judge requires a single-shot completion provider; Replay cannot serve it",
        };
      }
      return this.resolveReplay(role, suffix || undefined);
    }

    if (this.httpBackends.has(prefix)) {
      return this.resolveHttpAssignment(role, prefix, suffix);
    }

    return {
      role,
      kind: "unresolved",
      reason: `Unknown backend "${prefix}" in assignment "${value}"`,
    };
  }

  /** Probe every HTTP backend for availability. */
  async probeBackends(): Promise<void> {
    await Promise.all([...this.httpBackends.keys()].map((key) => this.probeBackend(key)));
  }

  /**
   * Re-probe HTTP backends stuck at `unreachable`, on a per-backend exponential
   * backoff, so a backend that was merely unreachable when the gateway booted
   * (or during a transient network blip) recovers WITHOUT a restart or a manual
   * `POST /admin/inference/backends/:key/probe`. Config-change re-probing stays
   * in {@link loadConfig}; this is the time-based recovery path a periodic task
   * drives.
   *
   * `unreachable` is the only latch worth healing here: a `reachable` backend is
   * already usable, and `ok` is healthy. A still-failing backend has its next
   * eligible probe pushed out `base·2^(n-1)` (capped), so a persistently-down
   * backend (e.g. a rejected API key) is not hammered.
   *
   * @param nowMs current epoch ms (injected for testability)
   * @returns down = unreachable backends; probed = of those, how many were due
   *   and re-probed this call; recovered = how many became usable.
   */
  async reprobeUnavailable(
    nowMs: number,
    backoff: { baseMs: number; maxMs: number } = {
      baseMs: DEFAULT_REPROBE_BASE_MS,
      maxMs: DEFAULT_REPROBE_MAX_MS,
    },
  ): Promise<{ down: number; probed: number; recovered: number }> {
    // Drop backoff state for backends no longer unreachable (recovered via a
    // config-change probe, or removed) so a future outage starts fresh.
    for (const key of [...this.reprobeBackoff.keys()]) {
      if (this.httpBackends.get(key)?.status.status !== "unreachable") {
        this.reprobeBackoff.delete(key);
      }
    }
    const down = [...this.httpBackends.entries()].filter(
      ([, e]) => e.status.status === "unreachable",
    );
    let probed = 0;
    let recovered = 0;
    await Promise.all(
      down.map(async ([key]) => {
        const state = this.reprobeBackoff.get(key);
        if (state && state.nextAt > nowMs) return; // still backing off
        probed++;
        const result = await this.probeBackend(key);
        if (result.inconclusive) {
          // The probe measured this process, not the backend. Retry soon and
          // leave the attempt count alone — otherwise a stretch of local
          // congestion walks the backoff up to its cap and keeps a healthy
          // provider switched off long after the congestion clears.
          this.reprobeBackoff.set(key, {
            attempts: state?.attempts ?? 0,
            nextAt: nowMs + INCONCLUSIVE_REPROBE_MS,
          });
        } else if (result.status === "unreachable") {
          const attempts = (state?.attempts ?? 0) + 1;
          const delay = Math.min(backoff.maxMs, backoff.baseMs * 2 ** (attempts - 1));
          this.reprobeBackoff.set(key, { attempts, nextAt: nowMs + delay });
        } else {
          this.reprobeBackoff.delete(key);
          recovered++;
        }
      }),
    );
    return { down: down.length, probed, recovered };
  }

  /**
   * Probe a single HTTP backend through its configured credentials, update
   * its stored status, and return the outcome (including a failure reason).
   * The request carries the backend's API key — the registry owns the key;
   * the overview never exposes it — so this is the one authoritative
   * reachability check. The `/admin/.../probe` route and the periodic
   * re-probe both go through here, which keeps the "Test" result and the
   * row status in lockstep.
   *
   * A probe that could not be run fairly returns `inconclusive` rather than a
   * verdict — see {@link sampleLoopLag}. Callers must not treat that as
   * evidence against the backend.
   */
  async probeBackend(key: string): Promise<ProbeOutcome> {
    const entry = this.httpBackends.get(key);
    if (!entry) {
      return { status: "unreachable", models: [], reason: `unknown backend "${key}"` };
    }
    if (entry.config.apiKeySecretError) {
      const reason = entry.config.apiKeySecretError;
      entry.status = {
        type: "http",
        url: entry.config.url,
        status: "unreachable",
        hasApiKey: false,
        reason,
      };
      return { status: "unreachable", models: [], reason };
    }
    const url = entry.config.url.replace(/\/+$/, "");
    const prefix = normalizeApiPathPrefix(entry.config.apiPathPrefix);
    const hasApiKey = !!entry.config.apiKey;
    const lag = sampleLoopLag();
    try {
      const headers: Record<string, string> = {};
      if (entry.config.apiKey) {
        headers["Authorization"] = `Bearer ${entry.config.apiKey}`;
      }
      const res = await fetchWithInferenceUrlPolicy(
        `${url}${prefix}/models`,
        {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          headers,
        },
        { allowRemoteInference: this.allowRemoteInference },
      );
      if (res.ok) {
        const models = extractModelIds(await res.json());
        entry.status = { type: "http", url: entry.config.url, status: "ok", models, hasApiKey };
        this.consecutiveHolds.delete(key);
        log.info(`HTTP backend "${key}" probed OK: ${models.length} model(s)`);
        return { status: "ok", models };
      }
      const reason = `HTTP ${res.status}`;
      // The host answered, so it's reachable — only `/v1/models` failed. Some
      // backends (e.g. Fireworks, whose `/v1/models` lists dedicated
      // deployments and 500s when there are none) serve inference fine despite
      // a broken model-list endpoint. Report `reachable` so the backend stays
      // usable with a manually-assigned model. An auth failure is the
      // exception: a rejected key means inference would fail too, so keep it
      // `unreachable` to surface the misconfiguration loudly.
      const authFailure = res.status === 401 || res.status === 403;
      const status = authFailure ? "unreachable" : "reachable";
      entry.status = { type: "http", url: entry.config.url, status, hasApiKey, reason };
      this.consecutiveHolds.delete(key);
      log.warn(`HTTP backend "${key}" probe ${status}: ${reason}`);
      return { status, models: [], reason };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const lagMs = lag.worstMs();
      const holds = this.consecutiveHolds.get(key) ?? 0;
      if (lagMs > LOOP_LAG_STARVATION_MS && holds < MAX_CONSECUTIVE_HOLDS) {
        // The loop fell far enough behind during this probe that the failure
        // describes this process. Keep whatever the backend last actually
        // demonstrated — condemning it here is how a busy gateway takes a
        // healthy provider down with it. A backend still mid-first-probe has
        // demonstrated nothing, so it reports unreachable; `inconclusive`
        // still keeps the backoff flat, so it is re-asked shortly rather than
        // written off.
        this.consecutiveHolds.set(key, holds + 1);
        const prior = entry.status.status;
        const held = prior === "probing" ? "unreachable" : prior;
        entry.status = {
          ...entry.status,
          status: held,
          reason: `${STARVED_PROBE_REASON} (${reason})`,
        };
        log.warn(
          `HTTP backend "${key}" probe inconclusive: event loop fell ${Math.round(lagMs)}ms ` +
            `behind during it — holding "${held}" (${holds + 1}/${MAX_CONSECUTIVE_HOLDS})`,
        );
        return { status: held, models: entry.status.models ?? [], reason, inconclusive: true };
      }
      this.consecutiveHolds.delete(key);
      entry.status = {
        type: "http",
        url: entry.config.url,
        status: "unreachable",
        hasApiKey,
        reason,
      };
      log.warn(`HTTP backend "${key}" unreachable: ${reason}`);
      return { status: "unreachable", models: [], reason };
    } finally {
      lag.stop();
      this.stateRevision += 1;
    }
  }

  /** Forget every cached capability verdict for a backend. */
  private clearVerifyCache(key: string): void {
    const prefix = `${key}::`;
    for (const k of this.verifyCache.keys()) {
      if (k.startsWith(prefix)) this.verifyCache.delete(k);
    }
  }

  private resolveBackendSecrets(key: string, cfg: HttpBackendConfig): ResolvedHttpBackendConfig {
    if (!cfg.apiKeySecret) return cfg;
    if (!parseConfigSecretRef(cfg.apiKeySecret)) {
      const reason = `HTTP backend "${key}" API key secret reference is invalid`;
      log.warn(reason);
      const next: ResolvedHttpBackendConfig = { ...cfg, apiKeySecretError: reason };
      delete next.apiKey;
      return next;
    }
    const value = readConfigSecretRefSync(cfg.apiKeySecret, { configDir: this.configDir });
    if (!value) {
      const reason = `HTTP backend "${key}" API key secret is missing or unreadable`;
      log.warn(reason);
      const next: ResolvedHttpBackendConfig = { ...cfg, apiKeySecretError: reason };
      delete next.apiKey;
      return next;
    }
    return { ...cfg, apiKey: value };
  }

  /**
   * Behavioral confirm: issue one minimal capability call for `(backend,
   * model, role)` and report whether the backend can actually serve it. The
   * `/v1/models` protocol advertises no purpose, so a name heuristic otherwise
   * decides model→role fit; this is the authoritative check. On-demand only
   * (never auto-probed per model on page load) and cached per
   * `(backend, model, role)`
   *
   * Probe per role: embeddings (`/embeddings`) and chat (`/chat/completions`,
   * with a Responses-API retry for agent-class models).
   * `transcriber`/`ocr` aren't behaviorally probed (binary audio/image
   * payloads) and report unsupported with a clear reason.
   */
  async verifyModel(
    key: string,
    model: string,
    role: CapabilityRole,
    opts: { force?: boolean } = {},
  ): Promise<CapabilityVerdict> {
    const cacheKey = `${key}::${model}::${role}`;
    if (!opts.force) {
      const cached = this.verifyCache.get(cacheKey);
      if (cached) return cached;
    }

    const entry = this.httpBackends.get(key);
    if (!entry) {
      return { role, model, supported: false, detail: `unknown backend "${key}"` };
    }
    if (entry.config.apiKeySecretError) {
      return { role, model, supported: false, detail: entry.config.apiKeySecretError };
    }
    if (!model) {
      return { role, model, supported: false, detail: "no model specified" };
    }

    const url = entry.config.url.replace(/\/+$/, "");
    const prefix = normalizeApiPathPrefix(entry.config.apiPathPrefix);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (entry.config.apiKey) headers["Authorization"] = `Bearer ${entry.config.apiKey}`;

    const post = (path: string, body: unknown): Promise<Response> =>
      fetchWithInferenceUrlPolicy(
        `${url}${prefix}${path}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        },
        { allowRemoteInference: this.allowRemoteInference },
      );

    const verdict = await this.runCapabilityProbe(role, model, post);
    this.verifyCache.set(cacheKey, verdict);
    log.info(
      `verify ${key}/${model} as ${role}: ${verdict.supported ? "supported" : "unsupported"} — ${verdict.detail}`,
    );
    return verdict;
  }

  private async runCapabilityProbe(
    role: CapabilityRole,
    model: string,
    post: (path: string, body: unknown) => Promise<Response>,
  ): Promise<CapabilityVerdict> {
    const fail = (detail: string): CapabilityVerdict => ({ role, model, supported: false, detail });
    const ok = (detail: string): CapabilityVerdict => ({ role, model, supported: true, detail });
    const errorDetail = async (res: Response): Promise<string> => {
      const body = await res.text().catch(() => "");
      let msg = body.trim().slice(0, 160);
      try {
        const j = JSON.parse(body) as { error?: { message?: string }; detail?: string };
        msg = (j.error?.message ?? j.detail ?? msg).slice(0, 160);
      } catch {
        /* keep raw */
      }
      return `HTTP ${res.status}${msg ? `: ${msg}` : ""}`;
    };

    try {
      if (role === "embedder") {
        const res = await post("/embeddings", { model, input: "capability check" });
        if (!res.ok) return fail(await errorDetail(res));
        const json = (await res.json()) as { data?: Array<{ embedding?: unknown }> };
        const dim = Array.isArray(json.data?.[0]?.embedding) ? json.data![0]!.embedding!.length : 0;
        return dim > 0
          ? ok(`embeddings endpoint returned a ${dim}-dim vector`)
          : fail("embeddings endpoint returned no vector");
      }

      if (
        role === "agent" ||
        role === "privacy-reviewer" ||
        role === "background-agent" ||
        role === "watch-judge" ||
        role === "entailment-verifier" ||
        role === "brief-judge"
      ) {
        const res = await post("/chat/completions", {
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        });
        if (res.ok) return ok("chat-completions endpoint served the request");
        // Agent roles only: a Responses-only model 404s on chat-completions.
        //The entailment-verifier loader speaks only chat-completions,
        // so a Responses-only model is genuinely unsupported for it and the
        // retry would report a false positive.
        if (role !== "entailment-verifier" && role !== "watch-judge" && res.status === 404) {
          const detail = await errorDetail(res);
          if (/v1\/responses/i.test(detail) || /not a chat model/i.test(detail)) {
            const r2 = await post("/responses", { model, input: "ping", stream: false });
            return r2.ok
              ? ok("served via the Responses API (/responses)")
              : fail(`chat-completions 404 and /responses failed: ${await errorDetail(r2)}`);
          }
          return fail(detail);
        }
        return fail(await errorDetail(res));
      }

      return fail(`behavioral probe not supported for the "${role}" role`);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Roles whose assignment is *degraded* — it points at a model or backend
   * that doesn't resolve (a typo, a removed backend, a stale id). These are
   * the `unresolved` resolutions; an intentionally-unset/null role resolves
   * to `disabled` and is a normal state, so it is NOT reported here.
   *
   * Fail-loud signal: surfaced onto `/status` (and `omnesis status`) as
   * `configHealth.degradedRoles` so a capability silently disabling itself
   * because of a typo'd assignment becomes a named, queryable error instead
   * of only a log line.
   */
  degradedAssignments(): DegradedRole[] {
    const degraded: DegradedRole[] = [];
    for (const role of CAPABILITY_ROLES) {
      const resolved = this.resolve(role);
      if (resolved.kind === "unresolved") {
        degraded.push({ role, reason: resolved.reason });
      } else if (
        (resolved.kind === "anthropic" || resolved.kind === "codex") &&
        !resolved.allowRemoteInference &&
        CLOUD_CAPABLE_ROLES.has(role)
      ) {
        // A cloud backend selected while remote inference is off can't run —
        // flag it so /status shows the contradiction rather than a healthy role.
        // Scoped to roles that can actually use a cloud backend so a nonsensical
        // cloud assignment on a local-only role isn't given "enable remote
        // inference" advice it can't act on.
        degraded.push({ role, reason: resolved.reason ?? CLOUD_EGRESS_DISABLED_REASON });
      }
    }
    return degraded;
  }

  /**
   * Project the degraded assignments into the `/status` config-health shape:
   * the degraded roles plus a single one-line summary (`lastConfigError`,
   * null when nothing is degraded) naming the affected roles.
   */
  configHealth(): ConfigHealth {
    const degradedRoles = this.degradedAssignments();
    const lastConfigError =
      degradedRoles.length === 0
        ? null
        : `Inference config degraded: ${degradedRoles
            .map((d) => `${d.role} (${d.reason})`)
            .join("; ")}`;
    return { degradedRoles, lastConfigError };
  }

  /** Snapshot for the API response (GET /admin/models). */
  getOverview(): InferenceOverview {
    const backends: Record<string, BackendStatus> = {};
    backends["local"] = { type: "local", status: "ok" };
    for (const [key, entry] of this.httpBackends) {
      backends[key] = {
        ...entry.status,
        modelRoles: this.classifyBackendModels(key, entry),
        apiPathPrefix: entry.config.apiPathPrefix,
        protocol: entry.config.protocol,
      };
    }
    if (this.checkAnthropicKey()) {
      backends["anthropic"] = this.getAnthropicStatus() ?? {
        type: "anthropic",
        status: "ok",
        hasApiKey: true,
      };
    }
    // Resolve every known role so the overview never drifts when a new
    // CapabilityRole is added (e.g. the subagent roles).
    const assignments = Object.fromEntries(
      CAPABILITY_ROLES.map((role) => [role, this.resolve(role)]),
    ) as Record<CapabilityRole, ResolvedAssignment>;
    return { allowRemoteInference: this.allowRemoteInference, backends, assignments };
  }

  /**
   * Classify every candidate model for an HTTP backend into the capability
   * roles it can serve. Candidates are the probed served-models only — an
   * unprobed backend surfaces no suggestions rather than a potentially stale
   * hardcoded list. `/v1/models` never advertises purpose, so this is derived
   * from the model id (see `classifyModelRoles`).
   */
  private classifyBackendModels(
    backendKey: string,
    entry: { config: ResolvedHttpBackendConfig; status: BackendStatus },
  ): Record<string, CapabilityRole[]> {
    const roles = classifyModels([...(entry.status.models ?? [])]);
    if (!this.getModelControls) return roles;
    for (const [model, suggestions] of Object.entries(roles)) {
      const facts = this.getModelControls(
        backendKey,
        model,
        entry.config.url,
        entry.config.protocol ?? "chat-completions",
      );
      if (facts.source !== "models.dev" || !facts.modalities) continue;
      const input = new Set(facts.modalities.input);
      const output = new Set(facts.modalities.output);
      roles[model] = suggestions.filter((role) => {
        if (role === "transcriber") return input.has("audio") && output.has("text");
        if (role === "ocr") return (input.has("image") || input.has("pdf")) && output.has("text");
        if (role === "embedder") return input.has("text") && output.has("text");
        if (!input.has("text") || !output.has("text")) return false;
        if ((role === "agent" || role === "background-agent") && facts.toolCall === false)
          return false;
        return true;
      });
    }
    return roles;
  }

  /** Return the API key for a named HTTP backend, if configured. */
  getBackendApiKey(key: string): string | undefined {
    return this.httpBackends.get(key)?.config.apiKey;
  }

  async dispose(): Promise<void> {}

  // ── Private resolution helpers ──────────────────────────────────────

  private resolveLocalModel(role: CapabilityRole, idOrFilename: string): ResolvedLocal {
    // Normalise: if it ends with .gguf, try filename lookup first
    let catalogId = idOrFilename;
    let catalogEntry = this.lookupCatalogEntry(idOrFilename);

    if (!catalogEntry && idOrFilename.endsWith(".gguf")) {
      const byFilename = getCatalogEntryByFilename(idOrFilename);
      if (byFilename) {
        catalogEntry = byFilename;
        catalogId = byFilename.id;
      } else {
        // Strip .gguf suffix and try as id
        catalogId = idOrFilename.replace(/\.gguf$/i, "");
        catalogEntry = this.lookupCatalogEntry(catalogId);
      }
    }

    const ggufEntry =
      catalogEntry?.kind === "gguf" ? (catalogEntry as GgufCatalogEntry) : undefined;
    const filename = ggufEntry?.filename ?? idOrFilename;
    const modelPath = join(this.modelsDir, filename);

    // Check availability: manifest first, then stat
    const manifest = this.getManifest();
    const manifestEntry = findManifestEntry(manifest, catalogId);
    const fileExists = manifestEntry
      ? existsSync(join(this.modelsDir, manifestEntry.filename))
      : existsSync(modelPath);

    const embedDim =
      ggufEntry && typeof ggufEntry.embedDim === "number" ? ggufEntry.embedDim : undefined;

    return {
      role,
      kind: "local",
      catalogId,
      catalogEntry: ggufEntry,
      modelPath: manifestEntry ? join(this.modelsDir, manifestEntry.filename) : modelPath,
      embedDim,
      available: fileExists,
      reason: fileExists ? undefined : `Model file not found at ${modelPath}`,
    };
  }

  private resolveAnthropicModel(
    role: CapabilityRole,
    fullId: string,
    apiModelId: string,
  ): ResolvedAnthropic {
    const catalogEntry = this.lookupCatalogEntry(fullId);
    const anthropicEntry = catalogEntry?.kind === "anthropic-api" ? catalogEntry : undefined;
    const allowRemoteInference = this.allowRemoteInference;
    const available = this.checkAnthropicKey();

    return {
      role,
      kind: "anthropic",
      catalogId: fullId,
      catalogEntry: anthropicEntry,
      apiModelId,
      allowRemoteInference,
      available,
      // Remote-inference-off is a more fundamental block than a missing key —
      // the backend cannot run off-host regardless — so surface it first.
      reason: !allowRemoteInference
        ? CLOUD_EGRESS_DISABLED_REASON
        : available
          ? undefined
          : "Anthropic API key not configured. Set it from the portal's Settings → Models tab.",
    };
  }

  private resolveHttpAssignment(
    role: CapabilityRole,
    backendKey: string,
    model: string,
  ): ResolvedAssignment {
    const entry = this.httpBackends.get(backendKey);
    if (!entry) {
      return {
        role,
        kind: "unresolved",
        reason: `HTTP backend "${backendKey}" not declared in inference.backends`,
      };
    }

    if (role === "watch-judge" && entry.config.protocol === "responses") {
      return {
        role,
        kind: "unresolved",
        reason:
          "Watch judge requires an HTTP backend using Chat Completions; Responses-only backends cannot serve it",
      };
    }

    const resolvedModel =
      model || (entry.status.models?.length === 1 ? entry.status.models[0] : "");

    // A `reachable` backend answered its host but couldn't list models, so we
    // can't auto-pick a single model — but an explicitly-assigned model still
    // works for inference. Treat it as usable when a model is named.
    const usable = entry.status.status === "ok" || entry.status.status === "reachable";
    const available = usable && resolvedModel !== "";
    let reason: string | undefined;
    if (!usable) {
      reason = entry.status.reason
        ? `Backend "${backendKey}" is ${entry.status.status}: ${entry.status.reason}`
        : `Backend "${backendKey}" is ${entry.status.status}`;
    } else if (!resolvedModel) {
      reason =
        entry.status.status === "reachable"
          ? `Backend "${backendKey}" didn't return a model list — set the model id explicitly`
          : `No model specified and backend "${backendKey}" serves multiple models — set model explicitly`;
    }

    return {
      role,
      kind: "http",
      backendKey,
      url: entry.config.url,
      apiPathPrefix: entry.config.apiPathPrefix,
      protocol: entry.config.protocol,
      model: resolvedModel,
      ...(this.getModelControls
        ? {
            modelControls: this.getModelControls(
              backendKey,
              resolvedModel,
              entry.config.url,
              entry.config.protocol ?? "chat-completions",
            ),
          }
        : {}),
      ...(this.modelSettings[role]?.assignment === `${backendKey}/${resolvedModel}`
        ? { modelBehavior: this.modelSettings[role]!.values }
        : {}),
      modelLimits: entry.config.modelLimits?.[resolvedModel],
      agentTimeoutMs: entry.config.agentTimeoutMs,
      allowRemoteInference: this.allowRemoteInference,
      available,
      reason,
    };
  }

  private resolveReplay(role: CapabilityRole, fixture?: string): ResolvedReplay {
    return { role, kind: "replay", fixture };
  }

  private resolveCodex(role: CapabilityRole, model: string): ResolvedCodex {
    const allowRemoteInference = this.allowRemoteInference;
    if (!CODEX_SUPPORTED_ROLES.includes(role)) {
      return {
        role,
        kind: "codex",
        model,
        allowRemoteInference,
        available: false,
        reason: `Codex does not provide ${role === "embedder" ? "embedding vectors" : "audio transcription"}; assign a backend that supports "${role}"`,
      };
    }
    if (!model.trim()) {
      return {
        role,
        kind: "codex",
        model,
        allowRemoteInference,
        available: false,
        reason: 'Codex assignment must include a model id, e.g. "codex/gpt-5.4"',
      };
    }
    return {
      role,
      kind: "codex",
      model,
      allowRemoteInference,
      ...(this.modelSettings[role]?.assignment === `codex/${model}`
        ? { modelBehavior: this.modelSettings[role]!.values }
        : {}),
      available: true,
      reason: allowRemoteInference ? undefined : CLOUD_EGRESS_DISABLED_REASON,
    };
  }

  /**
   * Resolve a built-in OCR runtime (no catalog model). `apple-vision`
   * availability is known here (the gateway's own platform); `tesseract` and
   * `gguf` are reported available and the OCR loader is authoritative — it
   * returns no capability (and logs why) when the Tesseract binary is absent
   * or the `inference.ocr.gguf` paths aren't set. `modelPath` is empty; the
   * loader keys on `nativeRuntime`.
   */
  private resolveNativeOcr(role: CapabilityRole, runtime: OcrNativeRuntime): ResolvedLocal {
    const appleOnMac = runtime !== "apple-vision" || process.platform === "darwin";
    return {
      role,
      kind: "local",
      catalogId: runtime,
      modelPath: "",
      available: appleOnMac,
      reason: appleOnMac
        ? undefined
        : "Apple Vision OCR is only available when the gateway runs on macOS",
      nativeRuntime: runtime,
    };
  }
}
