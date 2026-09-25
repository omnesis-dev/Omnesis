// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP routes for the model manager. Mounted from server.ts via
 * `registerModelRoutes(app, ...)` so the bulk of the route logic lives
 * in one place rather than buried inside the 3000-line server file.
 *
 * All routes declare `scope.admin()` at their mount site; the gateway's
 * `strictRoute()` wrapper rejects any mount that doesn't.
 *
 * Routes:
 *   GET    /admin/system-info              snapshot of host RAM/CPU/Metal/disk
 *   GET    /admin/models                   catalog + installed + per-role active
 *   GET    /admin/models/recent/:capability  recently-used picker entries
 *   POST   /admin/models/install           body { id }      → start download
 *   POST   /admin/models/cancel-download   body { id }      → cancel in-flight
 *   DELETE /admin/models/:id                                → remove from disk
 *   POST   /admin/models/activate          body { id, role, capability? }→ switch active model
 *   GET    /admin/models/doctor/:id                          → integrity check
 *   POST   /admin/inference/backends/:key/probe              → re-probe an HTTP backend
 *   POST   /admin/inference/backends/:key/verify            → behavioral capability check
 *   POST   /admin/inference/anthropic/refresh               → refresh Anthropic's model catalog
 *   POST   /admin/inference/codex/refresh                   → refresh Codex login/model status
 *   POST   /admin/inference/codex/agent                     → assign Codex if Agent is unassigned
 *   GET    /admin/inference/codex/runtime/update            → inspect/poll runtime update
 *   POST   /admin/inference/codex/runtime/update            → plan or start runtime update
 *   DELETE /admin/inference/codex/runtime/update            → cancel before activation
 *   POST   /admin/inference/codex/login                     → start Codex device login
 *   GET    /admin/inference/codex/login                     → read active Codex login flow
 *   DELETE /admin/inference/codex/login                     → cancel active Codex login flow
 *   DELETE /admin/inference/codex                           → log out Codex and clear Codex assignments
 *
 * Switch semantics:
 *
 *   - For role=embed, activating a different model wipes the vector
 *     index and queues a full re-embed. The route returns a flag so the
 *     CLI/portal can show the impact before the user clicks through.
 *
 * The actual restart/reload is driven by the gateway's
 * `configStore.onChange` listener, not from this file. Activating just
 * means writing the new id to the config; the listener does the work.
 */

import {
  CATALOG_ROLE_CAPABILITY,
  CAPABILITY_ROLES,
  type ModelRole,
  type CapabilityRole,
  type InferenceOverview,
  type BackendStatus,
  type CodexBackendStatus,
  type CodexLoginFlow,
  type CodexRuntimeUpdateSnapshot,
} from "@omnesis/core";
import { z } from "zod";
import { scope } from "../http/scope.js";
import { BadRequestError, ConflictError, ValidationError } from "../http/errors.js";
import { CodexRuntimeUpdateConflictError } from "./codex-runtime-updater.js";
import { CodexRuntimeLifecycleConflictError } from "./codex-runtime-lifecycle.js";
import {
  CodexAgentSetupConflictError,
  CodexAgentSetupUnavailableError,
} from "./codex-agent-setup.js";
import type { CodexAgentSetupResult } from "./codex-agent-setup.js";
import type { RecentModelsResult } from "./recent-models.js";
import type { ConfigStore } from "../config-store.js";
import type { ModelManager } from "./manager.js";
import type { SystemInfo } from "../system-info.js";
import type { RouteApp } from "../http/routes/types.js";
import type { ModelsDevCatalog } from "./models-dev-catalog.js";
/**
 * Catalog roles describe what a model can do; capability roles identify the
 * independent assignment being changed. `capability` is optional on the route
 * for backwards compatibility, but an explicit target lets the Privacy
 * reviewer use an agent-class model without overwriting the Agent assignment.
 */
export const CAPABILITY_TO_CATALOG: Partial<Record<CapabilityRole, ModelRole>> = {
  embedder: "embed",
  agent: "agent",
  "privacy-reviewer": "agent",
  transcriber: "transcribe",
  "background-agent": "agent",
  "watch-judge": "agent",
  // The brief judge and the entailment verifier take the same agent-class
  // models as every other chat role (the portal already offers them there) —
  // without a mapping the activate endpoint rejects their capability.
  "brief-judge": "agent",
  "entailment-verifier": "agent",
};

interface RegisterOptions {
  modelManager: ModelManager;
  modelsDevCatalog?: ModelsDevCatalog;
  configStore: ConfigStore;
  getSystemInfo: () => SystemInfo;
  getInferenceOverview: () => InferenceOverview;
  probeBackend: (
    key: string,
  ) => Promise<{ status: "ok" | "reachable" | "unreachable"; models: string[]; reason?: string }>;
  verifyModel: (
    key: string,
    model: string,
    role: CapabilityRole,
    opts?: { force?: boolean },
  ) => Promise<import("@omnesis/core").CapabilityVerdict>;
  getCodexStatus?: () => CodexBackendStatus;
  refreshCodexStatus?: () => Promise<CodexBackendStatus>;
  setupCodexAgent?: (model: string) => Promise<CodexAgentSetupResult>;
  getCodexRuntimeUpdate?: () => Promise<CodexRuntimeUpdateSnapshot>;
  startCodexRuntimeUpdate?: (opts: { dryRun: boolean }) => Promise<CodexRuntimeUpdateSnapshot>;
  cancelCodexRuntimeUpdate?: () => Promise<CodexRuntimeUpdateSnapshot>;
  startCodexLogin?: () => Promise<CodexLoginFlow>;
  getCodexLogin?: () => CodexLoginFlow | null;
  cancelCodexLogin?: () => Promise<{ ok: true; canceled: boolean; flow: CodexLoginFlow | null }>;
  logoutCodex?: () => Promise<{ ok: true; status: CodexBackendStatus }>;
  refreshAnthropicStatus?: () => Promise<BackendStatus | undefined>;
  /**
   * "Recently used" entries for a reference capability (see
   * `recent-models.ts`). Optional so partial test servers without a history
   * store keep serving the rest of the model routes — the route then
   * answers with no entries and clients hide the section.
   */
  getRecentModels?: (capability: CapabilityRole) => RecentModelsResult;
}

const VERIFIABLE_ROLES = new Set<CapabilityRole>([
  "embedder",
  "agent",
  "privacy-reviewer",
  "background-agent",
  "watch-judge",
  "entailment-verifier",
]);

const REASONING_ROLES = new Set<CapabilityRole>([
  "agent",
  "privacy-reviewer",
  "background-agent",
  "watch-judge",
  "entailment-verifier",
  "brief-judge",
]);

const codexRuntimeUpdateBodySchema = z.strictObject({
  dryRun: z.boolean().optional(),
});

const codexAgentSetupBodySchema = z.strictObject({
  model: z.string().trim().min(1).max(200),
});

const behaviorValuesSchema = z.strictObject({
  reasoningEnabled: z.boolean().optional(),
  reasoningEffort: z.string().min(1).max(32).optional(),
  reasoningBudgetTokens: z.number().int().min(-1).optional(),
});

const behaviorBodySchema = z.strictObject({
  assignment: z.string().min(1),
  values: behaviorValuesSchema,
  expectedValues: behaviorValuesSchema.optional(),
});

function sameBehaviorValues(
  left: z.infer<typeof behaviorValuesSchema>,
  right: z.infer<typeof behaviorValuesSchema>,
): boolean {
  return (
    left.reasoningEnabled === right.reasoningEnabled &&
    left.reasoningEffort === right.reasoningEffort &&
    left.reasoningBudgetTokens === right.reasoningBudgetTokens
  );
}

export function registerModelRoutes(app: RouteApp, opts: RegisterOptions): void {
  const { modelManager, configStore, getSystemInfo: sysInfo, getInferenceOverview } = opts;
  const modelInferenceOverview = (): InferenceOverview => {
    const inference = getInferenceOverview();
    const codex = opts.getCodexStatus?.();
    return codex ? { ...inference, codex } : inference;
  };

  app.get("/admin/system-info", scope.admin(), (c) => c.json(sysInfo()));

  app.get("/admin/models", scope.admin(), async (c) => {
    await opts.modelsDevCatalog?.refreshIfStale();
    const inference = modelInferenceOverview();
    const overview = modelManager.getOverview(inference);
    const behavior = opts.modelsDevCatalog?.overview(inference, configStore.get());
    const getRecentModels = opts.getRecentModels;
    const recentModels = getRecentModels
      ? Object.fromEntries(CAPABILITY_ROLES.map((role) => [role, getRecentModels(role).entries]))
      : {};
    return c.json({ ...overview, ...behavior, recentModels });
  });

  app.get("/model-logos/:providerId", scope.public(), async (c) => {
    if (!opts.modelsDevCatalog) throw new BadRequestError("Model logos unavailable");
    const param = c.req.param("providerId") ?? "";
    const requested = param.endsWith(".svg") ? param.slice(0, -4) : "";
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/i.test(requested)) {
      throw new BadRequestError("Invalid provider ID");
    }
    try {
      const svg = await opts.modelsDevCatalog.logo(requested);
      return c.body(svg.toString("utf8"), 200, {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "private, max-age=31536000, immutable",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "X-Content-Type-Options": "nosniff",
      });
    } catch (err) {
      throw new BadRequestError(err instanceof Error ? err.message : String(err));
    }
  });

  app.patch("/admin/models/behavior/:role", scope.admin(), async (c) => {
    const role = c.req.param("role") as CapabilityRole;
    if (!(CAPABILITY_ROLES as readonly string[]).includes(role)) {
      throw new BadRequestError(`unsupported capability: ${c.req.param("role")}`);
    }
    if (!REASONING_ROLES.has(role)) {
      throw new BadRequestError(`reasoning controls are unavailable for ${role}`);
    }
    if (!opts.modelsDevCatalog) throw new BadRequestError("Model controls unavailable");
    const parsed = behaviorBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError("assignment and valid values required");
    const { assignment, values, expectedValues } = parsed.data;
    const result = await configStore.update((current) => {
      const inference = modelInferenceOverview();
      if (!["http", "codex"].includes(inference.assignments[role]?.kind)) {
        throw new BadRequestError("Reasoning controls require a configurable model assignment");
      }
      const active = opts.modelsDevCatalog!.overview(inference, current).modelSettings[role]
        ?.assignment;
      if (active !== assignment) {
        throw new ConflictError("The capability model changed; reload its settings.");
      }
      const stored = current.inference?.modelSettings?.[role];
      const effectiveValues = stored?.assignment === assignment ? stored.values : {};
      if (expectedValues && !sameBehaviorValues(expectedValues, effectiveValues)) {
        throw new ConflictError("The model settings changed on another client; reload them.");
      }
      try {
        opts.modelsDevCatalog!.validateValues(assignment, values, inference);
      } catch (err) {
        throw new BadRequestError(err instanceof Error ? err.message : String(err));
      }
      return {
        ...current,
        inference: {
          ...current.inference,
          modelSettings: {
            ...current.inference?.modelSettings,
            [role]: { assignment, values },
          },
        },
      };
    });
    if (!result.ok) throw new ValidationError("config patch failed", result.errors);
    return c.json({ ok: true, role, assignment, values });
  });

  app.post("/admin/models/install", scope.admin(), async (c) => {
    let body: { id?: unknown };
    try {
      body = await c.req.json();
    } catch {
      throw new BadRequestError("Invalid JSON body");
    }
    if (typeof body.id !== "string") throw new BadRequestError("id (string) required");
    try {
      const { downloadId } = modelManager.install(body.id);
      return c.json({ ok: true, downloadId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Bad-input failures (unknown id / already installed / etc.) come
      // back as 400; the manager throws synchronously in those cases.
      // Real failures during download surface via the WS progress event.
      throw new BadRequestError(message);
    }
  });

  app.post("/admin/models/cancel-download", scope.admin(), async (c) => {
    let body: { id?: unknown };
    try {
      body = await c.req.json();
    } catch {
      throw new BadRequestError("Invalid JSON body");
    }
    if (typeof body.id !== "string") throw new BadRequestError("id (string) required");
    const cancelled = modelManager.cancel(body.id);
    return c.json({ ok: true, cancelled });
  });

  app.delete("/admin/models/:id", scope.admin(), (c) => {
    const id = c.req.param("id");
    const isActive = (candidateId: string): boolean => {
      const inference = modelInferenceOverview();
      for (const assignment of Object.values(inference.assignments)) {
        if (assignment.kind === "local" && assignment.catalogId === candidateId) return true;
      }
      return false;
    };
    try {
      modelManager.uninstall(id, { isActive });
      return c.json({ ok: true });
    } catch (err) {
      throw new BadRequestError(err instanceof Error ? err.message : String(err));
    }
  });

  app.post("/admin/models/activate", scope.admin(), async (c) => {
    let body: { id?: unknown; role?: unknown; capability?: unknown };
    try {
      body = await c.req.json();
    } catch {
      throw new BadRequestError("Invalid JSON body");
    }
    if (typeof body.id !== "string" || typeof body.role !== "string") {
      throw new BadRequestError("id (string) and role (string) required");
    }
    const role = body.role as ModelRole;
    if (role !== "embed" && role !== "agent" && role !== "transcribe") {
      throw new BadRequestError(`unsupported role: ${body.role}`);
    }
    if (body.capability !== undefined && typeof body.capability !== "string") {
      throw new BadRequestError("capability must be a string when provided");
    }
    const requestedCapability = body.capability as CapabilityRole | undefined;
    if (requestedCapability !== undefined) {
      const capabilityCatalogRole = CAPABILITY_TO_CATALOG[requestedCapability];
      if (!capabilityCatalogRole) {
        throw new BadRequestError(`unsupported capability: ${requestedCapability}`);
      }
      if (capabilityCatalogRole !== role) {
        throw new BadRequestError(
          `capability=${requestedCapability} cannot be assigned a role=${role} model`,
        );
      }
    }
    const entry = modelManager.getCatalogEntry(body.id);
    if (!entry) throw new BadRequestError(`unknown catalog id: ${body.id}`);
    if (!entry.roles.includes(role)) {
      throw new BadRequestError(`${entry.id} does not serve role=${role}`);
    }

    // Block activation of GGUF models that aren't on disk. API entries
    // can be activated even without a key — we surface the missing-key
    // state via `available: false` in the resolved status.
    if (entry.kind === "gguf" && !modelManager.isInstalled(entry.id)) {
      throw new BadRequestError(`${entry.id} is not installed — install it first`);
    }

    const capRole = requestedCapability ?? CATALOG_ROLE_CAPABILITY[role];
    const inference = modelInferenceOverview();
    const currentAssignment = inference.assignments[capRole];
    const currentActiveId =
      currentAssignment.kind === "local"
        ? currentAssignment.catalogId
        : currentAssignment.kind === "anthropic"
          ? currentAssignment.catalogId
          : undefined;

    const willReindex = role === "embed" && currentActiveId !== entry.id;

    const assignmentValue = entry.kind === "gguf" ? `local/${entry.id}` : entry.id;
    const patch = {
      inference: { assignments: { [capRole]: assignmentValue } },
    };

    const res = await configStore.patch(patch);
    if (!res.ok) {
      throw new ValidationError("config patch failed", res.errors);
    }

    return c.json({
      ok: true,
      role,
      capability: capRole,
      activeId: entry.id,
      willReindex,
      previous: currentActiveId,
    });
  });

  app.get("/admin/models/doctor/:id", scope.admin(), async (c) => {
    const id = c.req.param("id");
    const result = await modelManager.doctor(id);
    return c.json(result);
  });

  // "Recently used" models for the capability picker. The client passes the
  // capability it is configuring (`reference`); the response lists the
  // deduplicated models recently used for it or a similar capability, the
  // reference's own first, each with its provider display and how to apply
  // it. An empty list means "hide the section" — including for capabilities
  // with no similar group (the entailment verifier).
  app.get("/admin/models/recent/:capability", scope.admin(), (c) => {
    const capability = c.req.param("capability") as CapabilityRole;
    if (!(CAPABILITY_ROLES as readonly string[]).includes(capability)) {
      throw new BadRequestError(`unsupported capability: ${c.req.param("capability")}`);
    }
    if (!opts.getRecentModels) return c.json({ capability, entries: [] });
    return c.json(opts.getRecentModels(capability));
  });

  app.post("/admin/inference/backends/:key/probe", scope.admin(), async (c) => {
    const key = c.req.param("key");
    const backend = modelInferenceOverview().backends[key];
    if (!backend) throw new BadRequestError(`unknown backend: ${key}`);
    if (backend.type !== "http")
      throw new BadRequestError(`cannot probe a ${backend.type} backend`);
    // Probe through the registry so the request carries the backend's
    // configured API key and the cached status the row reads is updated in
    // the same pass — the result the "Test" button sees can't disagree with
    // the row.
    const result = await opts.probeBackend(key);
    // `reachable` (host up, model list unavailable) counts as a pass — the
    // backend can still serve a manually-assigned model. Only `unreachable`
    // (host down or rejected credentials) is a failed test.
    return c.json({
      ok: result.status !== "unreachable",
      status: result.status,
      models: result.models,
      ...(result.reason ? { reason: result.reason } : {}),
    });
  });

  // Behavioral capability confirm for one (backend, model, role). On-demand
  // only — never auto-probed per model on page load.
  app.post("/admin/inference/backends/:key/verify", scope.admin(), async (c) => {
    const key = c.req.param("key");
    const backend = modelInferenceOverview().backends[key];
    if (!backend) throw new BadRequestError(`unknown backend: ${key}`);
    if (backend.type !== "http")
      throw new BadRequestError(`cannot verify a ${backend.type} backend`);

    const body = (await c.req.json().catch(() => null)) as {
      model?: unknown;
      role?: unknown;
      force?: unknown;
    } | null;
    const model = typeof body?.model === "string" ? body.model.trim() : "";
    const role = body?.role as CapabilityRole;
    if (!model) throw new BadRequestError("`model` is required");
    if (!VERIFIABLE_ROLES.has(role)) {
      throw new BadRequestError(
        `\`role\` must be one of ${[...VERIFIABLE_ROLES].join(", ")} (got "${String(body?.role)}")`,
      );
    }
    const verdict = await opts.verifyModel(key, model, role, { force: body?.force === true });
    return c.json(verdict);
  });

  app.post("/admin/inference/codex/refresh", scope.admin(), async (c) => {
    if (!opts.refreshCodexStatus) throw new BadRequestError("Codex backend is not available");
    const status = await opts.refreshCodexStatus();
    return c.json(status);
  });

  app.post("/admin/inference/codex/agent", scope.admin(), async (c) => {
    if (!opts.setupCodexAgent) {
      throw new BadRequestError("Codex agent setup is not available");
    }
    const parsed = codexAgentSetupBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new BadRequestError("body must contain only model (a non-empty string)");
    }
    try {
      const result = await opts.setupCodexAgent(parsed.data.model);
      return c.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof CodexAgentSetupUnavailableError) {
        throw new BadRequestError(error.message);
      }
      if (error instanceof CodexAgentSetupConflictError) {
        throw new ConflictError(error.message);
      }
      throw error;
    }
  });

  app.get("/admin/inference/codex/runtime/update", scope.admin(), async (c) => {
    if (!opts.getCodexRuntimeUpdate)
      throw new BadRequestError("Codex runtime updates are unavailable");
    return c.json(await opts.getCodexRuntimeUpdate());
  });

  app.post("/admin/inference/codex/runtime/update", scope.admin(), async (c) => {
    if (!opts.startCodexRuntimeUpdate) {
      throw new BadRequestError("Codex runtime updates are unavailable");
    }
    const raw = await c.req.json().catch(() => null);
    const parsed = codexRuntimeUpdateBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestError(
        "body must be a JSON object containing only optional dryRun (boolean)",
      );
    }
    try {
      return c.json(await opts.startCodexRuntimeUpdate({ dryRun: parsed.data.dryRun ?? false }));
    } catch (err) {
      if (err instanceof CodexRuntimeUpdateConflictError) throw new ConflictError(err.message);
      throw err;
    }
  });

  app.delete("/admin/inference/codex/runtime/update", scope.admin(), async (c) => {
    if (!opts.cancelCodexRuntimeUpdate) {
      throw new BadRequestError("Codex runtime updates are unavailable");
    }
    try {
      return c.json(await opts.cancelCodexRuntimeUpdate());
    } catch (err) {
      if (err instanceof CodexRuntimeUpdateConflictError) throw new ConflictError(err.message);
      throw err;
    }
  });

  app.post("/admin/inference/anthropic/refresh", scope.admin(), async (c) => {
    if (!opts.refreshAnthropicStatus) {
      throw new BadRequestError("Anthropic model discovery is not available");
    }
    const status = await opts.refreshAnthropicStatus();
    if (!status) throw new BadRequestError("Anthropic API key not configured");
    return c.json(status);
  });

  app.post("/admin/inference/codex/login", scope.admin(), async (c) => {
    if (!opts.startCodexLogin) throw new BadRequestError("Codex backend is not available");
    try {
      return c.json(await opts.startCodexLogin());
    } catch (err) {
      if (err instanceof CodexRuntimeLifecycleConflictError) {
        throw new ConflictError(err.message);
      }
      throw new BadRequestError(err instanceof Error ? err.message : String(err));
    }
  });

  app.get("/admin/inference/codex/login", scope.admin(), (c) => {
    if (!opts.getCodexLogin) throw new BadRequestError("Codex backend is not available");
    return c.json({ flow: opts.getCodexLogin() });
  });

  app.delete("/admin/inference/codex/login", scope.admin(), async (c) => {
    if (!opts.cancelCodexLogin) throw new BadRequestError("Codex backend is not available");
    return c.json(await opts.cancelCodexLogin());
  });

  app.delete("/admin/inference/codex", scope.admin(), async (c) => {
    if (!opts.logoutCodex) throw new BadRequestError("Codex backend is not available");
    let result: Awaited<ReturnType<NonNullable<RegisterOptions["logoutCodex"]>>>;
    try {
      result = await opts.logoutCodex();
    } catch (err) {
      if (err instanceof CodexRuntimeLifecycleConflictError) {
        throw new ConflictError(err.message);
      }
      throw err;
    }
    const assignments = configStore.get().inference?.assignments ?? {};
    const clearedAssignments: string[] = [];
    const patch: Partial<Record<CapabilityRole, null>> = {};
    for (const [role, value] of Object.entries(assignments)) {
      if (typeof value !== "string" || !value.startsWith("codex/")) continue;
      patch[role as CapabilityRole] = null;
      clearedAssignments.push(role);
    }
    if (clearedAssignments.length > 0) {
      const res = await configStore.patch({ inference: { assignments: patch } });
      if (!res.ok) throw new ValidationError("config patch failed", res.errors);
    }
    return c.json({ ...result, clearedAssignments });
  });
}
