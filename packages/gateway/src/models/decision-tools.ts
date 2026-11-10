// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The decision model's setup tools: list a server's models, and calibrate a
 * model onto Jev's scale. Verifying a model lives with its clients
 * (`inference/decision/verify.ts`).
 *
 * - Probe asks a local server (Ollaya, Ollama, any other System One server
 *   added by hand) which models it has. Hosted providers are not listed:
 *   their model lists mix chat and decision models, so the presets and the
 *   models.dev decision catalog name theirs instead.
 * - Calibration replays the Jev reference set — invented emails with the
 *   answers Jev gave them — through the assigned model, fits the map from its
 *   scores to Jev's, and stores it with the decision backend.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MIN_CALIBRATION_SAMPLES,
  createLogger,
  decisionGateRates,
  fetchWithInferenceUrlPolicy,
  findDecisionPreset,
  fitDecisionCalibration,
  calibrateNormalized,
  parseDecisionCassette,
  type DecisionCalibration,
  type DecisionCapability,
  type DecisionCassetteEntry,
  type DecisionAuth,
  type DecisionProtocol,
  type DecisionScoreField,
  type ResolvedAssignment,
  type ResolvedDecisionBackend,
} from "@omnesis/core";
import { decisionAuthHeaders } from "../inference/decision/transport.js";
import { describeDecisionFailure } from "../inference/decision/verify.js";
import {
  EMAIL_WORTH_QUESTION_ID,
  EMAIL_WORTH_THRESHOLD,
  WORTH_GATE_RUBRIC_VERSION,
} from "../worth/rubric.js";
import type { ResolvedDecisionBackendConfig } from "../inference/registry.js";

const log = createLogger("gateway:decision:tools");

// ── Probe ───────────────────────────────────────────────────────────────

export interface DecisionProbeResult {
  ok: boolean;
  /** Model ids the server reported, when it lists them. */
  models: string[];
  /** False when the server was not asked: a hosted provider, or a format with no listing. */
  listed: boolean;
  reason?: string;
}

const PROBE_TIMEOUT_MS = 8_000;

/** The URLs a System One server may list its models at, most specific first. */
export function modelListUrls(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const out: string[] = [];
  // Ollama and Ollaya list installed models at /api/tags.
  out.push(new URL("/api/tags", parsed.origin).toString());
  // An OpenAI-style listing beside the endpoint: …/v1/systemone → …/v1/models.
  const segments = parsed.pathname.replace(/\/+$/, "").split("/");
  if (segments.length > 1) {
    segments[segments.length - 1] = "models";
    out.push(new URL(segments.join("/"), parsed.origin).toString());
  }
  return out;
}

function modelIdsFrom(body: unknown): string[] | null {
  if (!body || typeof body !== "object") return null;
  const record = body as { models?: unknown; data?: unknown };
  const list = Array.isArray(record.models)
    ? record.models
    : Array.isArray(record.data)
      ? record.data
      : null;
  if (!list) return null;
  const ids = list
    .map((m) => {
      if (typeof m === "string") return m;
      const entry = m as { name?: unknown; model?: unknown; id?: unknown };
      const id = entry.name ?? entry.model ?? entry.id;
      return typeof id === "string" ? id : null;
    })
    .filter((id): id is string => !!id);
  return [...new Set(ids)].sort();
}

/** What probing needs of a decision backend, saved or not. */
export interface DecisionProbeTarget {
  url: string;
  preset?: string;
  protocol?: DecisionProtocol;
  auth?: DecisionAuth;
  apiKey?: string;
}

export async function probeDecisionBackend(
  cfg: DecisionProbeTarget,
  allowRemoteInference: boolean,
  fetchFn?: typeof fetch,
): Promise<DecisionProbeResult> {
  const preset = findDecisionPreset(cfg.preset, cfg.url);
  if ((cfg.protocol ?? "systemone") !== "systemone" || preset?.kind === "cloud") {
    return { ok: true, models: [], listed: false };
  }
  const headers = decisionAuthHeaders(cfg.auth ?? "bearer", cfg.apiKey);
  let lastReason = "the server lists no models";
  for (const url of modelListUrls(cfg.url)) {
    try {
      const response = await fetchWithInferenceUrlPolicy(
        url,
        { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
        { allowRemoteInference, ...(fetchFn ? { fetchFn } : {}) },
      );
      if (!response.ok) {
        lastReason = `HTTP ${response.status} from ${url}`;
        continue;
      }
      const ids = modelIdsFrom(await response.json().catch(() => null));
      if (ids) return { ok: true, models: ids, listed: true };
    } catch (err) {
      // An unreachable host fails every listing URL the same way.
      lastReason = describeNetworkError(cfg.url, err);
      break;
    }
  }
  return { ok: false, models: [], listed: false, reason: lastReason };
}

function describeNetworkError(url: string, err: unknown): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return `${url} did not answer in time`;
  }
  return `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`;
}

// ── Calibration ─────────────────────────────────────────────────────────

export type DecisionCalibrationState = "idle" | "running" | "done" | "failed" | "cancelled";

export interface DecisionCalibrationStatus {
  state: DecisionCalibrationState;
  /** The assignment being (or last) calibrated, `<backend>/<model>`. */
  assignment?: string;
  done: number;
  total: number;
  failed: number;
  startedAt?: string;
  finishedAt?: string;
  result?: DecisionCalibration;
  error?: string;
}

/** Fewer than this share of answered reference items fails the run. */
const MIN_ANSWERED_SHARE = 0.9;

export function readReferenceSet(path: string): DecisionCassetteEntry[] {
  return [...parseDecisionCassette(readFileSync(path, "utf8"), path).values()];
}

/** The bundled Jev reference set. */
export function defaultReferencePath(): string {
  return fileURLToPath(new URL("../../decision-reference/jev-worth.jsonl", import.meta.url));
}

export interface DecisionCalibrationDeps {
  /** The current decision assignment. */
  resolve: () => ResolvedAssignment;
  getDecisionBackend: (key: string) => ResolvedDecisionBackendConfig | undefined;
  /** The model's own (uncalibrated) client for an assignment. */
  createRawClient: (
    resolved: ResolvedDecisionBackend,
    cfg: ResolvedDecisionBackendConfig,
  ) => DecisionCapability;
  /**
   * Store a calibration with the backend; resolves when the config is written.
   * Refuses when the backend no longer matches `fittedOn`: a calibration
   * fitted on one server or wire format says nothing about another.
   */
  store: (
    backendKey: string,
    model: string,
    calibration: DecisionCalibration,
    fittedOn: DecisionBackendIdentity,
  ) => Promise<void>;
  reference: () => DecisionCassetteEntry[];
  now?: () => Date;
  /** Reference items sent at once; the backend's own limiter caps it further. */
  concurrency?: number;
}

/** What a calibration was fitted on: the parts of a backend that change its scores. */
export interface DecisionBackendIdentity {
  url: string;
  protocol: DecisionProtocol;
  scoreField: DecisionScoreField;
}

export function decisionBackendIdentity(cfg: {
  url: string;
  protocol?: DecisionProtocol;
  scoreField?: DecisionScoreField;
}): DecisionBackendIdentity {
  return {
    url: cfg.url,
    protocol: cfg.protocol ?? "systemone",
    scoreField: cfg.scoreField ?? "score",
  };
}

/**
 * One calibration at a time for the gateway's decision model. `start()`
 * returns at once; progress is read with `status()`.
 */
export class DecisionCalibrationJob {
  private current: DecisionCalibrationStatus = { state: "idle", done: 0, total: 0, failed: 0 };
  private abort: AbortController | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: DecisionCalibrationDeps) {}

  status(): DecisionCalibrationStatus {
    return { ...this.current };
  }

  /** Resolves when the running calibration, if any, has finished. For tests. */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  start(): DecisionCalibrationStatus {
    if (this.current.state === "running")
      throw new CalibrationConflict("A calibration is already running");
    const resolved = this.deps.resolve();
    if (resolved.kind !== "decision") {
      throw new CalibrationUnsupported(
        resolved.kind === "typesafe"
          ? "TypeSafe's Jev is the reference itself; a decision backend's model is what gets calibrated."
          : "Calibration needs the Decision model to be assigned to a decision backend.",
      );
    }
    if (!resolved.available)
      throw new CalibrationUnsupported(resolved.reason ?? "The Decision model is unavailable");
    const cfg = this.deps.getDecisionBackend(resolved.backendKey);
    if (!cfg) throw new CalibrationUnsupported(`Unknown decision backend "${resolved.backendKey}"`);
    const reference = this.deps.reference().filter((entry) => {
      const answer = entry.response.answers[EMAIL_WORTH_QUESTION_ID];
      return (
        answer?.type === "score" &&
        entry.request.questions[EMAIL_WORTH_QUESTION_ID]?.type === "score"
      );
    });
    // Built before the job counts as running: a client that cannot be built
    // (an invalid model id) leaves the job idle, with the reason.
    let client: DecisionCapability;
    try {
      client = this.deps.createRawClient(resolved, cfg);
    } catch (err) {
      throw new CalibrationUnsupported(err instanceof Error ? err.message : String(err));
    }
    const now = this.deps.now ?? (() => new Date());
    this.abort = new AbortController();
    this.current = {
      state: "running",
      assignment: `${resolved.backendKey}/${resolved.model}`,
      done: 0,
      total: reference.length,
      failed: 0,
      startedAt: now().toISOString(),
    };
    const identity = decisionBackendIdentity(cfg);
    this.running = this.run(resolved, identity, client, reference, this.abort.signal, now).finally(
      () => {
        this.running = null;
        void Promise.resolve(client.dispose()).catch(() => {});
      },
    );
    return this.status();
  }

  cancel(): DecisionCalibrationStatus {
    if (this.current.state === "running") this.abort?.abort(new Error("Calibration cancelled"));
    return this.status();
  }

  private async run(
    resolved: ResolvedDecisionBackend,
    identity: DecisionBackendIdentity,
    client: DecisionCapability,
    reference: DecisionCassetteEntry[],
    signal: AbortSignal,
    now: () => Date,
  ): Promise<void> {
    // Scores normalised to 0–1 by each question's own top level.
    const candidate: number[] = [];
    const jev: number[] = [];
    /** The worth threshold on the same 0–1 scale, from the reference questions' levels. */
    let cut = 0;
    let firstError: string | undefined;
    let next = 0;
    const worker = async () => {
      while (next < reference.length && !signal.aborted) {
        const entry = reference[next++]!;
        const question = entry.request.questions[EMAIL_WORTH_QUESTION_ID]!;
        const top = question.type === "score" ? question.criteria.length - 1 : 1;
        try {
          const result = await client.decide(entry.request, { signal });
          const answer = result.answers[EMAIL_WORTH_QUESTION_ID];
          const expected = entry.response.answers[EMAIL_WORTH_QUESTION_ID];
          if (answer?.type !== "score" || expected?.type !== "score")
            throw new Error("no score answer");
          candidate.push(answer.score / top);
          jev.push(expected.score / top);
          cut = EMAIL_WORTH_THRESHOLD / top;
        } catch (err) {
          if (signal.aborted) return;
          this.current.failed += 1;
          firstError ??= describeDecisionFailure(err, {
            url: resolved.url,
            model: resolved.model,
          }).reason;
        }
        this.current.done += 1;
      }
    };
    await Promise.all(Array.from({ length: this.deps.concurrency ?? 4 }, worker));
    const finishedAt = now().toISOString();
    if (signal.aborted) {
      this.current = { ...this.current, state: "cancelled", finishedAt };
      return;
    }
    const answered = candidate.length;
    if (answered < Math.max(MIN_CALIBRATION_SAMPLES, MIN_ANSWERED_SHARE * reference.length)) {
      this.current = {
        ...this.current,
        state: "failed",
        finishedAt,
        error: `Only ${answered} of ${reference.length} reference emails were answered${firstError ? `: ${firstError}` : ""}`,
      };
      return;
    }
    try {
      const points = fitDecisionCalibration(candidate, jev, cut);
      const calibrated = candidate.map((x) => calibrateNormalized(points, x));
      const before = decisionGateRates(candidate, jev, cut);
      const after = decisionGateRates(calibrated, jev, cut);
      const calibration: DecisionCalibration = {
        points,
        reference: `jev-worth/${WORTH_GATE_RUBRIC_VERSION}/${reference[0]?.response.model ?? "jev"}`,
        fittedAt: finishedAt,
        samples: answered,
        agreement: round3(after.agreement),
        agreementBefore: round3(before.agreement),
        keeps: round3(after.keeps),
        keepsBefore: round3(before.keeps),
        skips: round3(after.skips),
        skipsBefore: round3(before.skips),
      };
      await this.deps.store(resolved.backendKey, resolved.model, calibration, identity);
      log.info(
        `Calibrated ${resolved.backendKey}/${resolved.model} on ${answered} reference emails: keeps ${calibration.keepsBefore} → ${calibration.keeps} of what Jev keeps, skips ${calibration.skipsBefore} → ${calibration.skips} of what it skips`,
      );
      this.current = { ...this.current, state: "done", finishedAt, result: calibration };
    } catch (err) {
      this.current = {
        ...this.current,
        state: "failed",
        finishedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

export class CalibrationConflict extends Error {}
export class CalibrationUnsupported extends Error {}
