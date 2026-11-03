// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Resolution of the `background-agent` capability role to a runnable
 * {@link ChatBackend} — the same generic role resolution the sub-agent
 * roles use (`resolveRoleBackend`), specialised to the Cognition Steward's
 * role. Resolved fresh on every call so a live model swap takes effect
 * on the next queued run without a restart. Null means "no runnable
 * backend right now" (unassigned, unresolved, key missing, or a local
 * GGUF assignment, which chat backends don't support) — the run driver
 * fails the attempt softly and the queue retries.
 */

import { resolveRoleBackend } from "../agent/agent-lifecycle.js";
import {
  BACKGROUND_AGENT_ROLE,
  briefsFeatureStatus,
  type BackgroundAgentResolver,
} from "./feature-gate.js";
import {
  loadCompletionFromResolved,
  type LoadCompletionDeps,
} from "../inference/completion-loader.js";
import type { ChatRoleReadinessDeps } from "../models/chat-role-readiness.js";
import type { ChatBackend } from "@omnesis/agent";
import type { Logger } from "@omnesis/core";
import type Database from "better-sqlite3";
import type { InferenceRegistry } from "../inference/registry.js";
import type { ClaudeCodeService } from "../models/claude-code-service.js";
import type { CodexRuntimeService } from "../models/codex-runtime-service.js";

export function backgroundAgentBackendResolver(ctx: {
  inferenceRegistry: InferenceRegistry;
  configDir: string;
  db: Database.Database;
  /** Read live so a config edit applies on the next run. */
  getMaxToolIterations: () => number | undefined;
  log: Logger;
  codexRuntimeService?: CodexRuntimeService | null;
  claudeCodeService?: ClaudeCodeService | null;
}): () => ChatBackend | null {
  return () =>
    resolveRoleBackend(BACKGROUND_AGENT_ROLE, {
      inferenceRegistry: ctx.inferenceRegistry,
      configDir: ctx.configDir,
      db: ctx.db,
      maxToolIterations: ctx.getMaxToolIterations(),
      log: ctx.log,
      codexRuntimeService: ctx.codexRuntimeService,
      claudeCodeService: ctx.claudeCodeService,
    });
}

/** Optional autonomous completions share the Brain's actual live gate.
 * No provider is constructed while the Brain is inactive, even if its model
 * assignment is retained for a later opt-in. The caller owns disposal.
 */
export function loadBrainCompletionProvider(
  registry: BackgroundAgentResolver,
  readiness: ChatRoleReadinessDeps,
  deps: LoadCompletionDeps,
) {
  if (!briefsFeatureStatus(registry, readiness).active) return null;
  return loadCompletionFromResolved(registry.resolve(BACKGROUND_AGENT_ROLE), deps);
}
