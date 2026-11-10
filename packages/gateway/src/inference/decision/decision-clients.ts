// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Builds the clients for the decision model's API backends — decision
 * backends and the built-in TypeSafe slot — for every user of them: the live
 * decision service, verify, the assignment check and calibration.
 *
 * Each backend has one concurrency limiter, shared by all its clients, so a
 * calibration run, a verify and the live gates together never have more
 * requests in flight than the backend allows: a single-slot local server
 * would otherwise time out the ones queued behind the first.
 */

import {
  findDecisionPreset,
  type AssignmentValue,
  type DecisionCapability,
  type ResolvedAssignment,
  type ResolvedDecisionBackend,
  type ResolvedTypeSafe,
} from "@omnesis/core";
import { CalibratedDecision } from "./calibrated-decision.js";
import { ConcurrencyLimiter } from "./limiter.js";
import { OpenAIDecisionsDecision } from "./openai-decisions-client.js";
import { SystemOneDecision } from "./system-one-client.js";
import { TypeSafeDecision } from "./typesafe-client.js";
import { vetDecisionModel, verifyDecisionModel, type DecisionVerifyResult } from "./verify.js";
import type { ResolvedDecisionBackendConfig } from "../registry.js";

/** Requests in flight on a decision backend, unless its config says otherwise. */
export const DECISION_BACKEND_CONCURRENCY = 4;
/** How long a verify or an assignment check waits for the test answer. */
const CHECK_TIMEOUT_MS = 20_000;

export interface DecisionClientsDeps {
  getDecisionBackend: (key: string) => ResolvedDecisionBackendConfig | undefined;
  readTypeSafeApiKey: () => string | null;
  /** Test seam passed to the HTTP clients. */
  fetchFn?: typeof fetch;
}

export interface DecisionClientOptions {
  /** Apply the backend's stored calibration for the model. */
  calibrated: boolean;
  maxRetries?: number;
  timeoutMs?: number;
}

export class DecisionClients {
  private readonly limiters = new Map<string, ConcurrencyLimiter>();

  constructor(private readonly deps: DecisionClientsDeps) {}

  /** The limiter every client of one backend shares; a changed limit starts a new one. */
  limiter(key: string, max: number): ConcurrencyLimiter {
    const current = this.limiters.get(key);
    if (current?.max === max) return current;
    const next = new ConcurrencyLimiter(max);
    this.limiters.set(key, next);
    return next;
  }

  /** The API key a decision assignment's client sends, or null. */
  apiKeyFor(resolved: ResolvedAssignment): string | null {
    if (resolved.kind === "typesafe") return this.deps.readTypeSafeApiKey();
    if (resolved.kind === "decision") {
      return this.deps.getDecisionBackend(resolved.backendKey)?.apiKey ?? null;
    }
    return null;
  }

  /** A decision backend's client; throws for a backend the registry no longer has. */
  backend(resolved: ResolvedDecisionBackend, opts: DecisionClientOptions): DecisionCapability {
    const cfg = this.deps.getDecisionBackend(resolved.backendKey);
    if (!cfg) throw new Error(`Unknown decision backend "${resolved.backendKey}"`);
    const preset = findDecisionPreset(cfg.preset, cfg.url);
    const common = {
      url: cfg.url,
      model: resolved.model,
      ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
      auth: cfg.auth ?? "bearer",
      allowRemoteInference: resolved.allowRemoteInference,
      label: preset?.name ?? resolved.backendKey,
      limiter: this.limiter(
        `decision:${resolved.backendKey}`,
        cfg.maxConcurrency ?? DECISION_BACKEND_CONCURRENCY,
      ),
      ...(opts.timeoutMs !== undefined || cfg.timeoutMs !== undefined
        ? { timeoutMs: opts.timeoutMs ?? cfg.timeoutMs }
        : {}),
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      ...(this.deps.fetchFn ? { fetchFn: this.deps.fetchFn } : {}),
    };
    const raw: DecisionCapability =
      resolved.protocol === "openai-decisions"
        ? new OpenAIDecisionsDecision(common)
        : new SystemOneDecision({
            ...common,
            protocol: resolved.protocol,
            ...(cfg.scoreField ? { scoreField: cfg.scoreField } : {}),
          });
    const calibration = opts.calibrated ? cfg.calibration?.[resolved.model] : undefined;
    return calibration ? new CalibratedDecision(raw, calibration) : raw;
  }

  /** TypeSafe's client, or null when TypeSafe's own endpoint has no key. */
  typesafe(
    resolved: ResolvedTypeSafe,
    opts: Omit<DecisionClientOptions, "calibrated"> = {},
  ): DecisionCapability | null {
    const apiKey = this.deps.readTypeSafeApiKey();
    if (!apiKey && !resolved.selfHosted) return null;
    return new TypeSafeDecision({
      url: resolved.url,
      model: resolved.model,
      ...(apiKey ? { apiKey } : {}),
      allowRemoteInference: resolved.allowRemoteInference,
      limiter: this.limiter("typesafe", DECISION_BACKEND_CONCURRENCY),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      ...(this.deps.fetchFn ? { fetchFn: this.deps.fetchFn } : {}),
    });
  }

  /**
   * One test decision for a decision backend or TypeSafe assignment, with no
   * retries and a short timeout, uncalibrated.
   */
  async verify(resolved: ResolvedAssignment): Promise<DecisionVerifyResult> {
    if (resolved.kind !== "decision" && resolved.kind !== "typesafe") {
      return {
        ok: false,
        failure: "refused",
        reason: "reason" in resolved && resolved.reason ? resolved.reason : "Not a decision model.",
      };
    }
    if (!resolved.available) return { ok: false, failure: "refused", reason: resolved.reason };
    const client = this.checkClient(resolved);
    if (!client) {
      return { ok: false, failure: "refused", reason: "TypeSafe API key not configured." };
    }
    return verifyDecisionModel(client, { url: resolved.url, model: resolved.model });
  }

  /**
   * Whether a config write may set the Decision model to `value`: the model
   * is asked the verify questions and refused only when it definitely cannot
   * serve them. Not asked when the value is the current assignment, or when
   * the same write changes the backend it names (the check would test the
   * old URL or key; the clients verify after saving).
   */
  async vetAssignment(
    value: AssignmentValue,
    ctx: {
      current: AssignmentValue | undefined;
      resolve: (value: string) => ResolvedAssignment;
      body: unknown;
    },
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (value === null || value === ctx.current) return { ok: true };
    const resolved = ctx.resolve(value);
    if (resolved.kind !== "decision" && resolved.kind !== "typesafe") return { ok: true };
    if (!resolved.available) return { ok: true };
    const inference = (ctx.body as { inference?: Record<string, unknown> } | null)?.inference;
    if (resolved.kind === "decision") {
      const changed = (inference?.decisionBackends as Record<string, unknown> | undefined)?.[
        resolved.backendKey
      ];
      if (changed !== undefined) return { ok: true };
    } else if (inference?.typesafe !== undefined) {
      return { ok: true };
    }
    const client = this.checkClient(resolved);
    if (!client) return { ok: true };
    return vetDecisionModel(client, { url: resolved.url, model: resolved.model });
  }

  private checkClient(
    resolved: ResolvedDecisionBackend | ResolvedTypeSafe,
  ): DecisionCapability | null {
    const opts = { maxRetries: 0, timeoutMs: CHECK_TIMEOUT_MS };
    return resolved.kind === "decision"
      ? this.backend(resolved, { ...opts, calibrated: false })
      : this.typesafe(resolved, opts);
  }
}
