// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Owns the decision capability for the gateway. The assignment is resolved
 * fresh on every `get()` and the loaded backend is cached under a signature of
 * that resolution (model, endpoint, availability, a fingerprint of the key),
 * so assigning Jev, pasting a new key or pointing at another endpoint from the
 * portal takes effect on the next decision without a restart.
 *
 * `get()` returns null when the role is unset or cannot run — no key, remote
 * inference off, an unreadable replay fixture — which callers treat as
 * "decision model absent". Unlike the entailment service there is no
 * serialization fence: both backends are stateless HTTP or in-memory lookups,
 * so concurrent decisions against the same instance are safe.
 */

import { createHash } from "node:crypto";
import {
  assertNever,
  createLogger,
  type DecisionCapability,
  type ResolvedAssignment,
} from "@omnesis/core";
import { ReplayDecision } from "./replay-decision.js";
import { TypeSafeDecision } from "./typesafe-client.js";

const log = createLogger("gateway:decision");

export interface DecisionServiceDeps {
  resolveAssignment: () => ResolvedAssignment;
  readTypeSafeApiKey: () => string | null;
  /** Fixture used by a bare `replay` assignment (e.g. `OMNESIS_DECISION_FIXTURE`). */
  defaultReplayFixture?: () => string | undefined;
  /** Test seam passed to the TypeSafe client. */
  fetchFn?: typeof fetch;
}

export class DecisionService {
  private current: { signature: string; capability: DecisionCapability | null } | null = null;

  constructor(private readonly deps: DecisionServiceDeps) {}

  /** The live decision backend for the current assignment, or null when absent. */
  get(): DecisionCapability | null {
    const resolved = this.deps.resolveAssignment();
    const apiKey = resolved.kind === "typesafe" ? this.deps.readTypeSafeApiKey() : null;
    const fixture =
      resolved.kind === "replay"
        ? (resolved.fixture ?? this.deps.defaultReplayFixture?.())
        : undefined;
    const signature = signatureOf(resolved, apiKey, fixture);
    if (this.current?.signature === signature) return this.current.capability;
    const capability = this.load(resolved, apiKey, fixture);
    this.current = { signature, capability };
    return capability;
  }

  private load(
    resolved: ResolvedAssignment,
    apiKey: string | null,
    fixture: string | undefined,
  ): DecisionCapability | null {
    if (resolved.kind === "typesafe") {
      if (!resolved.available || !apiKey) {
        if (resolved.reason) log.info(`decision model unavailable: ${resolved.reason}`);
        return null;
      }
      log.info(`decision model: typesafe/${resolved.model}`);
      return new TypeSafeDecision({
        url: resolved.url,
        model: resolved.model,
        apiKey,
        allowRemoteInference: resolved.allowRemoteInference,
        ...(this.deps.fetchFn ? { fetchFn: this.deps.fetchFn } : {}),
      });
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

function signatureOf(
  resolved: ResolvedAssignment,
  apiKey: string | null,
  fixture: string | undefined,
): string {
  switch (resolved.kind) {
    case "typesafe": {
      const keyPrint = createHash("sha256")
        .update(apiKey ?? "")
        .digest("hex")
        .slice(0, 8);
      return `typesafe:${resolved.model}:${resolved.url}:${resolved.available}:${resolved.allowRemoteInference}:${keyPrint}`;
    }
    case "replay":
      return `replay:${fixture ?? ""}`;
    case "unresolved":
      return `unresolved:${resolved.reason}`;
    case "local":
    case "http":
    case "anthropic":
    case "codex":
    case "disabled":
      return resolved.kind;
    default:
      return assertNever(resolved);
  }
}
