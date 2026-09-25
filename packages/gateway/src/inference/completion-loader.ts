// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Turn a resolved assignment into a {@link CompleteCapability} — the
 * single-shot "prompt in, text out" provider the gateway's internal
 * classification passes drive. The InferenceRegistry decides *which* model a
 * role points at; this decides *how* to instantiate it, and logs why it could
 * not when it fails.
 *
 * The transcription analog is `transcribe/loader.ts`; the entailment analog is
 * `entailment-loader.ts`.
 */

import {
  assertNever,
  createLogger,
  CLOUD_EGRESS_DISABLED_REASON,
  type CompleteCapability,
  type ResolvedAssignment,
} from "@omnesis/core";
import { resolveAnthropicApiKey } from "../model-credentials.js";
import { HttpCompleter } from "./http-completer.js";
import { LlamaCppCompleter } from "./llama-cpp-completer.js";
import { CodexCompleter } from "./codex-completer.js";
import { AnthropicCompleter } from "./anthropic-completer.js";
import type { CodexRuntimeService } from "../models/codex-runtime-service.js";

const log = createLogger("inference:completion");

export interface LoadCompletionDeps {
  /** Gateway-owned independent inference lane, safe inside another Codex turn. */
  codexRuntimeService?: Pick<CodexRuntimeService, "createBackend">;
  /**
   * Gateway-host config dir — used to read model-provider credential
   * files (e.g. `<configDir>/anthropic-credentials.json`).
   */
  configDir: string;
  /** Resolve the API key for a named HTTP backend, if configured. */
  getBackendApiKey?: (key: string) => string | undefined;
  /**
   * How long one call may take, when the caller's work is not a short one.
   *
   * The default suits what most callers ask for — a query expansion, a short
   * classification — and is far too tight for a caller that sends tens of
   * thousands of tokens and waits for a document back. How long a call should
   * be allowed to run is a property of the work, not of the backend, so the
   * caller states it. Honoured by the HTTP and Codex backends; the local and Anthropic
   * ones manage their own deadlines.
   */
  timeoutMs?: number;
}

/**
 * Build a completion provider from a pre-resolved assignment, or return null
 * when the assignment is disabled, unresolved, or points at a backend that
 * cannot serve single-shot completions. Callers treat null as "this pass is
 * unavailable" and skip their work rather than failing.
 *
 * The returned provider belongs to the caller, which is responsible for
 * disposing it.
 */
export function loadCompletionFromResolved(
  resolved: ResolvedAssignment,
  deps: LoadCompletionDeps,
): CompleteCapability | null {
  switch (resolved.kind) {
    case "disabled":
      log.info("Completion provider disabled (assignment = null)");
      return null;

    case "unresolved":
      log.warn(`Completion provider unresolved: ${resolved.reason}`);
      return null;

    case "local": {
      if (!resolved.available) {
        log.info(`Completion provider unavailable — model not found: ${resolved.modelPath}`);
        return null;
      }
      log.info(`Completion provider configured (local): ${resolved.catalogId}`);
      return new LlamaCppCompleter(resolved.modelPath);
    }

    case "anthropic": {
      if (!resolved.allowRemoteInference) {
        log.info(`Completion provider unavailable — ${CLOUD_EGRESS_DISABLED_REASON}`);
        return null;
      }
      const apiKey = resolveAnthropicApiKey(deps.configDir);
      if (!apiKey) {
        log.info("Completion provider unavailable — Anthropic API key not configured");
        return null;
      }
      log.info(`Completion provider configured (anthropic): ${resolved.catalogId}`);
      return new AnthropicCompleter(resolved.apiModelId, apiKey);
    }

    case "http": {
      if (!resolved.available) {
        log.warn(`Completion provider unavailable — HTTP backend unreachable: ${resolved.url}`);
        return null;
      }
      log.info(
        `Completion provider configured (http): backend=${resolved.backendKey} model=${resolved.model}`,
      );
      return new HttpCompleter({
        baseUrl: resolved.url,
        apiPathPrefix: resolved.apiPathPrefix,
        model: resolved.model,
        apiKey: deps.getBackendApiKey?.(resolved.backendKey),
        allowRemoteInference: resolved.allowRemoteInference,
        protocol: resolved.protocol,
        modelControls: resolved.modelControls,
        modelBehavior: resolved.modelBehavior,
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      });
    }

    case "replay":
      log.warn("Replay backend cannot serve single-shot completions — treating as unavailable");
      return null;

    case "codex": {
      if (!resolved.allowRemoteInference || !resolved.available || !deps.codexRuntimeService) {
        log.info(
          "Completion provider unavailable — Codex requires remote inference, an available model and a runtime",
        );
        return null;
      }
      return new CodexCompleter({
        backend: deps.codexRuntimeService.createBackend({
          model: resolved.model,
          ...(resolved.modelBehavior?.reasoningEffort
            ? { reasoningEffort: resolved.modelBehavior.reasoningEffort }
            : {}),
          lane: "inference",
        }),
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      });
    }

    default:
      assertNever(resolved);
  }
}
