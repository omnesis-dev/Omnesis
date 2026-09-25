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
import { BACKGROUND_AGENT_ROLE } from "./feature-gate.js";
import type { ChatBackend } from "@omnesis/agent";
import type { Logger } from "@omnesis/core";
import type Database from "better-sqlite3";
import type { InferenceRegistry } from "../inference/registry.js";
import type { CodexRuntimeService } from "../models/codex-runtime-service.js";

export function backgroundAgentBackendResolver(ctx: {
  inferenceRegistry: InferenceRegistry;
  configDir: string;
  db: Database.Database;
  /** Read live so a config edit applies on the next run. */
  getMaxToolIterations: () => number | undefined;
  log: Logger;
  codexRuntimeService?: CodexRuntimeService | null;
}): () => ChatBackend | null {
  return () =>
    resolveRoleBackend(BACKGROUND_AGENT_ROLE, {
      inferenceRegistry: ctx.inferenceRegistry,
      configDir: ctx.configDir,
      db: ctx.db,
      maxToolIterations: ctx.getMaxToolIterations(),
      log: ctx.log,
      codexRuntimeService: ctx.codexRuntimeService,
    });
}
