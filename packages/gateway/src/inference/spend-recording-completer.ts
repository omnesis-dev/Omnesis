// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Cognition-spend decorator for {@link CompleteCapability} consumers. Wraps a
 * completer so every `complete` / `completeWithUsage` call reports the token
 * usage the backend returned to a recording callback — without the call
 * sites (the token-identity classifier, the entailment gate) knowing anything
 * about spend accounting.
 *
 * A provider without `completeWithUsage` (a local GGUF completer) is
 * returned unwrapped: it reports no usage, so there is nothing to record.
 * The wrapper never owns the provider's lifecycle — `dispose` delegates.
 */

import { createLogger, type CompleteCapability } from "@omnesis/core";

const log = createLogger("gateway").child("completer-spend");

/** One completion call's reported usage, forwarded to the recorder. */
export interface CompleterUsageSample {
  /** The provider's resolved model id. */
  modelId: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Wrap `provider` so each completion's reported usage is forwarded to
 * `record`. Recording is best-effort: a throwing recorder is logged and the
 * completion still returns.
 */
export function withSpendRecording(
  provider: CompleteCapability,
  record: (sample: CompleterUsageSample) => void,
): CompleteCapability {
  const withUsage = provider.completeWithUsage?.bind(provider);
  if (!withUsage) return provider;

  const report = (usage: { promptTokens: number; completionTokens: number } | null): void => {
    if (!usage) return;
    try {
      record({ modelId: provider.modelId, ...usage });
    } catch (err) {
      log.warn(
        `spend recording failed for completer ${provider.modelId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  return {
    get name() {
      return provider.name;
    },
    get modelId() {
      return provider.modelId;
    },
    complete: async (prompt, opts) => {
      const { text, usage } = await withUsage(prompt, opts);
      report(usage);
      return text;
    },
    completeWithUsage: async (prompt, opts) => {
      const result = await withUsage(prompt, opts);
      report(result.usage);
      return result;
    },
    dispose: () => provider.dispose(),
  };
}
