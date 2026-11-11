// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Owns the decision capability for the gateway. The assignment is resolved
 * fresh on every `get()` and the loaded backend is cached under a signature of
 * that resolution (backend, model, endpoint, availability, a fingerprint of
 * the key), so assigning a model, pasting a new key or pointing at another
 * endpoint from the portal takes effect on the next decision without a
 * restart. The backend it replaces is disposed, which frees a local model.
 *
 * Backends: TypeSafe (`typesafe/<model>`), a backend's decision API
 * (`<backend>/<model>`: a System One server, Workers AI or OpenAI Decisions),
 * a local GGUF chat model, an OpenAI-compatible HTTP backend that returns
 * token log-probabilities, and recorded replay. `get()` returns null when the role is unset or cannot run —
 * no key, remote inference off, a missing model file, an unreadable replay
 * fixture — which callers treat as "decision model absent". The HTTP and
 * replay backends are stateless; the local backend serializes its own calls.
 */

import { createHash } from "node:crypto";
import {
  assertNever,
  createLogger,
  type DecisionCapability,
  type ResolvedAssignment,
} from "@omnesis/core";
import { DecisionClients } from "./decision-clients.js";
import { HttpChatDecision } from "./http-chat-decision.js";
import { LlamaCppDecision } from "./llama-cpp-decision.js";
import { ReplayDecision } from "./replay-decision.js";
import type { DecisionEndpointConfig } from "../registry.js";

import type { InferenceHealth } from "../model-health.js";

const log = createLogger("gateway:decision");

export interface DecisionServiceDeps {
  health?: InferenceHealth;
  resolveAssignment: () => ResolvedAssignment;
  readTypeSafeApiKey: () => string | null;
  /** The API key of a named HTTP backend, if it has one. */
  getBackendApiKey?: (backendKey: string) => string | undefined;
  /** A backend's decision API, with the backend's API key read from the secret store. */
  getDecisionEndpoint?: (backendKey: string) => DecisionEndpointConfig | undefined;
  /** Fixture used by a bare `replay` assignment (e.g. `OMNESIS_DECISION_FIXTURE`). */
  defaultReplayFixture?: () => string | undefined;
  /** Test seam passed to the HTTP clients. */
  fetchFn?: typeof fetch;
  /** Test seam: builds the local backend. */
  createLocal?: (modelPath: string) => DecisionCapability;
  /**
   * Builds the decision API and TypeSafe clients; shared with verify so
   * they share each backend's concurrency limit. Built from
   * the deps above when omitted.
   */
  clients?: DecisionClients;
}

export class DecisionService {
  private current: { signature: string; capability: DecisionCapability | null } | null = null;

  private readonly clients: DecisionClients;

  constructor(private readonly deps: DecisionServiceDeps) {
    this.clients =
      deps.clients ??
      new DecisionClients({
        getDecisionEndpoint: (key) => deps.getDecisionEndpoint?.(key),
        readTypeSafeApiKey: deps.readTypeSafeApiKey,
        ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      });
  }

  /** The live decision backend for the current assignment, or null when absent. */
  get(): DecisionCapability | null {
    const resolved = this.deps.resolveAssignment();
    const decisionBackend =
      resolved.kind === "decision"
        ? this.deps.getDecisionEndpoint?.(resolved.backendKey)
        : undefined;
    const apiKey =
      resolved.kind === "typesafe"
        ? this.deps.readTypeSafeApiKey()
        : resolved.kind === "http"
          ? (this.deps.getBackendApiKey?.(resolved.backendKey) ?? null)
          : (decisionBackend?.apiKey ?? null);
    const fixture =
      resolved.kind === "replay"
        ? (resolved.fixture ?? this.deps.defaultReplayFixture?.())
        : undefined;
    const signature = signatureOf(resolved, apiKey, fixture, decisionBackend);
    if (this.current?.signature === signature) return this.current.capability;
    const previous = this.current?.capability;
    if (previous) {
      void Promise.resolve(previous.dispose()).catch((err: unknown) =>
        log.warn(
          `disposing the previous decision model failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
    let loaded: DecisionCapability | null;
    try {
      loaded = this.load(resolved, apiKey, fixture, decisionBackend);
    } catch (err) {
      log.warn(
        `decision model could not be built: ${err instanceof Error ? err.message : String(err)}`,
      );
      loaded = null;
    }
    const capability =
      loaded && this.deps.health ? this.deps.health.observe(resolved, loaded, ["decide"]) : loaded;
    this.current = { signature, capability };
    return capability;
  }

  private load(
    resolved: ResolvedAssignment,
    apiKey: string | null,
    fixture: string | undefined,
    decisionBackend: DecisionEndpointConfig | undefined,
  ): DecisionCapability | null {
    if (resolved.kind === "decision") {
      if (!resolved.available || !decisionBackend) {
        if (resolved.reason) log.info(`decision model unavailable: ${resolved.reason}`);
        return null;
      }
      log.info(`decision model: ${resolved.backendKey}/${resolved.model} at ${resolved.url}`);
      return this.clients.backend(resolved);
    }
    if (resolved.kind === "typesafe") {
      if (!resolved.available || (!apiKey && !resolved.selfHosted)) {
        if (resolved.reason) log.info(`decision model unavailable: ${resolved.reason}`);
        return null;
      }
      log.info(`decision model: typesafe/${resolved.model} at ${resolved.url}`);
      return this.clients.typesafe(resolved);
    }
    if (resolved.kind === "http") {
      if (!resolved.available) {
        if (resolved.reason) log.info(`decision model unavailable: ${resolved.reason}`);
        return null;
      }
      log.info(`decision model: ${resolved.backendKey}/${resolved.model}`);
      return new HttpChatDecision({
        backendKey: resolved.backendKey,
        baseUrl: resolved.url,
        model: resolved.model,
        ...(resolved.apiPathPrefix !== undefined ? { apiPathPrefix: resolved.apiPathPrefix } : {}),
        ...(apiKey ? { apiKey } : {}),
        allowRemoteInference: resolved.allowRemoteInference,
        limiter: this.clients.limiter(
          `http:${resolved.backendKey}`,
          HTTP_CHAT_DECISION_CONCURRENCY,
        ),
        ...(resolved.modelControls ? { modelControls: resolved.modelControls } : {}),
        ...(resolved.modelBehavior ? { modelBehavior: resolved.modelBehavior } : {}),
        ...(this.deps.fetchFn ? { fetchFn: this.deps.fetchFn } : {}),
      });
    }
    if (resolved.kind === "local") {
      if (!resolved.available) {
        if (resolved.reason) log.info(`decision model unavailable: ${resolved.reason}`);
        return null;
      }
      log.info(`decision model: local/${resolved.catalogId}`);
      return (
        this.deps.createLocal?.(resolved.modelPath) ?? new LlamaCppDecision(resolved.modelPath)
      );
    }
    if (resolved.kind === "replay") {
      if (!fixture) {
        log.warn("decision model is replay but no fixture is configured");
        return null;
      }
      try {
        const replay = ReplayDecision.fromPath(fixture);
        log.info(`decision model: replay (${replay.size} recorded decisions from ${fixture})`);
        return replay;
      } catch (err) {
        log.warn(
          `decision replay fixture unreadable: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    }
    if (resolved.kind === "unresolved") log.warn(`decision model unresolved: ${resolved.reason}`);
    return null;
  }
}

/** Questions in flight on an OpenAI-compatible chat server answering decisions. */
const HTTP_CHAT_DECISION_CONCURRENCY = 4;
function signatureOf(
  resolved: ResolvedAssignment,
  apiKey: string | null,
  fixture: string | undefined,
  decisionBackend?: DecisionEndpointConfig,
): string {
  switch (resolved.kind) {
    case "decision":
      return JSON.stringify([
        "decision",
        resolved.backendKey,
        resolved.model,
        resolved.available,
        resolved.allowRemoteInference,
        decisionBackend?.url,
        decisionBackend?.protocol,
        decisionBackend?.auth,
        decisionBackend?.scoreField,
        decisionBackend?.maxConcurrency,
        decisionBackend?.timeoutMs,
        keyPrintOf(apiKey),
      ]);
    case "typesafe": {
      const keyPrint = keyPrintOf(apiKey);
      return `typesafe:${resolved.model}:${resolved.url}:${resolved.available}:${resolved.allowRemoteInference}:${keyPrint}`;
    }
    case "http":
      return [
        "http",
        resolved.backendKey,
        resolved.url,
        resolved.apiPathPrefix ?? "",
        resolved.model,
        resolved.available,
        resolved.allowRemoteInference,
        JSON.stringify(resolved.modelBehavior ?? null),
        keyPrintOf(apiKey),
      ].join(":");
    case "local":
      return `local:${resolved.modelPath}:${resolved.available}`;
    case "replay":
      return `replay:${fixture ?? ""}`;
    case "unresolved":
      return `unresolved:${resolved.reason}`;
    case "anthropic":
    case "codex":
    case "claude-code":
    case "disabled":
      return resolved.kind;
    default:
      return assertNever(resolved);
  }
}

function keyPrintOf(apiKey: string | null): string {
  return createHash("sha256")
    .update(apiKey ?? "")
    .digest("hex")
    .slice(0, 8);
}
