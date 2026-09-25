// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether a capability role assigned a chat model can actually run right now
 * — and, when it cannot, why.
 *
 * An assignment's *shape* says almost nothing about whether inference will
 * happen. A backend kind can be perfectly well-formed while the API key is
 * absent, the egress policy forbids the call, the endpoint is unreachable, or
 * the replay fixture is missing. A gate that reads only the kind reports a
 * feature as ready and then watches its queue park on every run, with nothing
 * on any surface explaining why.
 *
 * The verdict here mirrors, condition for condition, what
 * `resolveRoleBackend` requires to return a backend. Those two must agree:
 * a role reported runnable that then resolves to null is exactly the silent
 * failure this module exists to remove. Any new condition in the resolver
 * needs its counterpart here; `chat-role-readiness.lockstep.test.ts` pairs
 * the two against the real resolver so a change to either side that breaks
 * the agreement fails the build.
 *
 * The one residual gap is a replay fixture that exists but does not parse —
 * readiness probes the path, the resolver loads the file. A corrupt fixture
 * therefore still reports runnable. Loading it here would put file parsing on
 * the status and drain paths, which is the worse trade.
 */

import { CLOUD_EGRESS_DISABLED_REASON } from "@omnesis/core";
import type { ResolvedAssignment } from "@omnesis/core";

/** Why a role cannot run, or that it can. */
export interface ChatRoleReadiness {
  runnable: boolean;
  /**
   * Operator-facing explanation when `runnable` is false — surfaced verbatim
   * on `/status` so a client can say what to fix instead of showing a feature
   * that silently does nothing.
   */
  reason?: string;
}

const READY: ChatRoleReadiness = { runnable: true };

/**
 * The one condition the resolved assignment cannot answer on its own.
 *
 * Everything else the resolver needs is already on the assignment: the
 * registry folds the Anthropic key check into `available`, and the Codex
 * runtime is unconditionally constructed. A replay fixture is different — the
 * resolver builds its backend eagerly and fails on a path that does not
 * resolve, so readiness has to reach the filesystem to match it.
 */
export interface ChatRoleReadinessDeps {
  /**
   * Whether the assignment's fixture resolves to something loadable. Must
   * apply the resolver's own precedence (`OMNESIS_AGENT_FIXTURE` overrides the
   * assignment's) and probe existence, not just non-emptiness.
   */
  hasReplayFixture: (fixture: string | undefined) => boolean;
}

export function chatRoleReadiness(
  resolved: ResolvedAssignment,
  deps: ChatRoleReadinessDeps,
): ChatRoleReadiness {
  switch (resolved.kind) {
    case "anthropic":
      if (!resolved.allowRemoteInference)
        return { runnable: false, reason: CLOUD_EGRESS_DISABLED_REASON };
      // The registry resolves `available` from the same key check the resolver
      // performs, and carries the more actionable message. Reading it here
      // keeps one source of truth and keeps a sync credential decrypt off the
      // status/drain/ingest paths that call this.
      if (!resolved.available) {
        return {
          runnable: false,
          reason: resolved.reason ?? "Anthropic API key not configured.",
        };
      }
      return READY;

    case "codex":
      if (!resolved.allowRemoteInference)
        return { runnable: false, reason: CLOUD_EGRESS_DISABLED_REASON };
      // The runtime is unconditionally constructed, so the remaining
      // preconditions are the registry's: a role codex can serve, and a model
      // id to serve it with.
      if (!resolved.available) {
        return {
          runnable: false,
          reason: resolved.reason ?? "This Codex assignment is incomplete.",
        };
      }
      return READY;

    case "http":
      // `available` already folds in endpoint reachability and whether a model
      // id resolved; the resolver carries the specific reason.
      if (!resolved.available) {
        return {
          runnable: false,
          reason: resolved.reason ?? `The backend at ${resolved.url} is unavailable.`,
        };
      }
      return READY;

    case "replay":
      if (!deps.hasReplayFixture(resolved.fixture)) {
        return {
          runnable: false,
          reason:
            "The replay backend has no fixture — set one on the assignment or OMNESIS_AGENT_FIXTURE.",
        };
      }
      return READY;

    case "local":
      // Chat roles have no local GGUF path: `resolveRoleBackend` builds no
      // backend for a local assignment, so it can never run one.
      return {
        runnable: false,
        reason: "Local GGUF models cannot serve a chat role — assign a cloud or HTTP backend.",
      };

    case "unresolved":
      return { runnable: false, reason: resolved.reason };

    case "disabled":
      return { runnable: false, reason: "No model is assigned to this capability." };

    default:
      // `kind` comes from config the operator edits, so an unknown value is
      // possible and must read as "not runnable" rather than throwing.
      return {
        runnable: false,
        reason: "This assignment names a backend kind this build cannot run.",
      };
  }
}
