// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Lists the models a decision server has: probe asks a local server (Ollaya,
 * Ollama, any other System One server added by hand) which models it has.
 * Hosted providers are not listed: their model lists mix chat and decision
 * models, so the presets and the models.dev decision catalog name theirs
 * instead. Verifying a model lives with its clients
 * (`inference/decision/verify.ts`).
 */

import {
  fetchWithInferenceUrlPolicy,
  findPreset,
  type DecisionAuth,
  type DecisionProtocol,
} from "@omnesis/core";
import { decisionAuthHeaders } from "../inference/decision/transport.js";

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

/** What probing needs of a decision API, saved or not. */
export interface DecisionProbeTarget {
  /** The decision endpoint's URL. */
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
  const preset = findPreset(cfg.preset, { decisionUrl: cfg.url });
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
