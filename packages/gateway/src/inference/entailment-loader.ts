// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Loader + judge adapter for the `entailment-verifier` capability — the
 * model role behind the annotation write gate's entailment firewall.
 *
 * `loadEntailmentFromResolved` turns a pre-resolved assignment into an
 * {@link EntailCapability}: a local GGUF (LlamaCppCompleter), an
 * OpenAI-compatible HTTP backend (HttpCompleter), the Anthropic API, or Codex,
 * all behind one usage-reporting `complete(prompt)` seam. The replay backend
 * and a disabled/unresolved assignment yield null —
 * the gate is then absent.
 *
 * `LlmJudgeEntailmentVerifier` is the adapter: it renders one of two prompt
 * conventions (`judge` for generic chat models, `minicheck` for
 * MiniCheck-family fact checkers), parses the model's answer into an
 * {@link EntailVerdict}, and reports each call's token usage through a
 * callback so verifier spend is cost-accounted. An unparseable answer
 * THROWS — the caller treats that as "verifier unavailable" and fails open,
 * never as a verdict.
 */

import {
  assertNever,
  createLogger,
  CLOUD_EGRESS_DISABLED_REASON,
  type EntailCapability,
  type EntailVerdict,
  type ResolvedAssignment,
  type CompleteCapability,
} from "@omnesis/core";
import Anthropic from "@anthropic-ai/sdk";
import { resolveAnthropicApiKey } from "../model-credentials.js";
import { loadCompletionFromResolved, type LoadCompletionDeps } from "./completion-loader.js";
import { LlamaCppCompleter } from "./llama-cpp-completer.js";
import { HttpCompleter, type HttpCompletion } from "./http-completer.js";

const log = createLogger("inference:entailment");

export type EntailmentPromptStyle = "judge" | "minicheck";

/** Per-call token usage reported to the cost-accounting sink. */
export interface EntailmentUsage {
  promptTokens: number;
  completionTokens: number;
  modelId: string;
}

/**
 * Completion budget for a verdict. The judge answers with a single label
 * token, but reasoning-tuned chat models spend hidden thinking tokens first,
 * so the budget leaves room for that without letting a runaway generation
 * bill unbounded output.
 */
const VERDICT_MAX_TOKENS = 512;

/**
 * The generic judge prompt: present the quote and the claim, ask for exactly
 * one of the three NLI labels. Modality- and scope-aware by instruction — a
 * claim is ENTAILMENT only when the quote establishes it AT ITS STATED
 * MODALITY AND SCOPE, so a quote that merely mentions the topic, shows a
 * request/estimate/application where the claim asserts possession/completion,
 * or lists what IS included where the claim asserts exhaustiveness, is
 * NEUTRAL.
 */
function judgePrompt(input: { claim: string; evidence: string }): string {
  return [
    "You are a strict entailment judge. Decide whether the evidence quote establishes the claim.",
    "",
    `Evidence quote: ${input.evidence}`,
    `Claim: ${input.claim}`,
    "",
    "Answer with exactly one word — ENTAILMENT, NEUTRAL, or CONTRADICTION.",
    "ENTAILMENT only if the quote establishes the claim at its stated modality.",
    "A quote that merely mentions the claim's topic is NEUTRAL.",
    "A quote showing a request, estimate, application, or intention where the claim asserts possession or completion is NEUTRAL.",
    "First- or second-person language supports a claim about a named person only when the quote itself identifies that person as the speaker or addressee; a bare ‘I’ or ‘you’ is otherwise NEUTRAL.",
    'A claim whose exhaustive or negative scope ("only", "no", "none", "never", "nothing else", "all") is not itself established by the quote is NEUTRAL — a quote listing what IS included does not license an "only" or "nothing else" claim about what it does not show.',
    "CONTRADICTION only if the quote establishes the claim is false.",
  ].join("\n");
}

/**
 * The MiniCheck convention: `Document: …\nClaim: …`, answered Yes/No.
 * Yes maps to entailment; No maps to neutral (MiniCheck checks support,
 * not contradiction).
 */
function minicheckPrompt(input: { claim: string; evidence: string }): string {
  return `Document: ${input.evidence}\nClaim: ${input.claim}`;
}

/**
 * Drop `<think>…</think>` reasoning blocks (closed or trailing-open) before
 * verdict parsing — a reasoning model's deliberation freely *mentions* every
 * label while weighing them, and only the text after the block carries the
 * actual verdict. Applied on every transport (the local GGUF path returns raw
 * text; only the HTTP path strips upstream).
 */
function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "");
}

/** A label immediately preceded by a negator asserts the opposite of its bare word. */
const NEGATOR_TAIL =
  /\b(?:no|not|never|isn't|wasn't|doesn't|cannot|can't|without|lacks?)\b[\s:,–—-]*$/i;

/**
 * Verdict parse, negation- and recency-aware. A chatty judge's final verdict
 * lives at the END of its output ("…therefore: NEUTRAL"), so matches are
 * scanned last-to-first; a negated ENTAILMENT ("no entailment") is itself a
 * reject-side verdict and maps to neutral, while other negated labels are
 * skipped as non-verdicts. Null = no usable verdict — the caller treats that
 * as verifier-unavailable, never as a pass.
 */
function parseJudgeLabel(text: string): EntailVerdict["label"] | null {
  const clean = stripThinkBlocks(text);
  const matches = [...clean.matchAll(/entailment|neutral|contradiction/gi)];
  let negatedEntailment = false;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]!;
    const label = m[0].toLowerCase() as EntailVerdict["label"];
    const before = clean.slice(Math.max(0, (m.index ?? 0) - 24), m.index ?? 0);
    if (NEGATOR_TAIL.test(before)) {
      // A negated label is not a verdict — but "no entailment" with nothing
      // stronger elsewhere is itself a reject-side answer.
      if (label === "entailment") negatedEntailment = true;
      continue;
    }
    return label;
  }
  return negatedEntailment ? "neutral" : null;
}

/** Last yes/no word wins (think-blocks stripped first); null = unparseable. */
function parseMinicheckLabel(text: string): EntailVerdict["label"] | null {
  const matches = [...stripThinkBlocks(text).matchAll(/\b(yes|no)\b/gi)];
  const last = matches[matches.length - 1];
  if (!last) return null;
  return last[1]!.toLowerCase() === "yes" ? "entailment" : "neutral";
}

/**
 * The completion seam the verifier drives: prompt in, text + optional token
 * usage out. The HTTP and Anthropic paths report real decoded usage; the
 * local path wraps a plain `complete` and reports none (nothing is billed).
 */
export interface EntailmentCompleter {
  readonly modelId: string;
  complete(
    prompt: string,
    opts?: { maxTokens?: number; temperature?: number },
  ): Promise<HttpCompletion>;
  dispose(): Promise<void> | void;
}

export interface LlmJudgeEntailmentVerifierDeps {
  completer: EntailmentCompleter;
  /** Read live per call so a config change takes effect without a reload. */
  getPromptStyle: () => EntailmentPromptStyle;
  /** Cost-accounting sink; fired once per verify call with the decoded usage (zeros when the transport reports none). */
  recordUsage?: (usage: EntailmentUsage) => void;
}

/**
 * EntailCapability over a text completer: render the configured prompt style,
 * parse the answer defensively, report usage. Throws on an unparseable
 * answer — a judge that cannot commit to a label is unavailable, and callers
 * must fail open rather than act on a fabricated verdict.
 */
export class LlmJudgeEntailmentVerifier implements EntailCapability {
  constructor(private readonly deps: LlmJudgeEntailmentVerifierDeps) {}

  async verify(input: { claim: string; evidence: string }): Promise<EntailVerdict> {
    const style = this.deps.getPromptStyle();
    const prompt = style === "minicheck" ? minicheckPrompt(input) : judgePrompt(input);
    const { text, usage } = await this.deps.completer.complete(prompt, {
      maxTokens: VERDICT_MAX_TOKENS,
      temperature: 0,
    });
    this.deps.recordUsage?.({
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
      modelId: this.deps.completer.modelId,
    });
    const label = style === "minicheck" ? parseMinicheckLabel(text) : parseJudgeLabel(text);
    if (label === null) {
      throw new Error(
        `entailment verifier returned no parseable ${style === "minicheck" ? "Yes/No" : "label"} (model=${this.deps.completer.modelId}, ${text.length} chars)`,
      );
    }
    return { label, raw: text.trim() };
  }

  dispose(): Promise<void> | void {
    return this.deps.completer.dispose();
  }
}

/** Adapt a plain CompleteCapability (local GGUF / Anthropic) to the usage-carrying seam. */
function withoutUsage(provider: CompleteCapability): EntailmentCompleter {
  return {
    modelId: provider.modelId,
    complete: async (prompt, opts) => ({
      text: await provider.complete(prompt, opts),
      usage: null,
    }),
    dispose: () => provider.dispose(),
  };
}

/**
 * Anthropic completer with real usage — the one per-token-billed transport,
 * so its spend must not be recorded as zeros. Calls the Messages API directly
 * (a judge verdict is one short turn) with a hard request timeout so a hung
 * call fails open at the gate instead of stalling a run for the SDK's
 * multi-minute default.
 */
function anthropicEntailmentCompleter(modelId: string, apiKey: string): EntailmentCompleter {
  const client = new Anthropic({ apiKey, timeout: 45_000, maxRetries: 1 });
  return {
    modelId,
    complete: async (prompt, opts) => {
      const response = await client.messages.create({
        model: modelId,
        max_tokens: opts?.maxTokens ?? 128,
        temperature: opts?.temperature ?? 0,
        messages: [{ role: "user", content: prompt }],
      });
      const block = response.content[0];
      return {
        text: block?.type === "text" ? block.text : "",
        usage: {
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
        },
      };
    },
    dispose: () => {},
  };
}

export interface LoadEntailmentDeps {
  codexRuntimeService?: LoadCompletionDeps["codexRuntimeService"];
  /** Gateway-host config dir — where Anthropic credentials live. */
  configDir: string;
  /** Live prompt-style knob (`inference.entailment.promptStyle`). */
  getPromptStyle: () => EntailmentPromptStyle;
  /** Resolve the API key for a named HTTP backend, if configured. */
  getBackendApiKey?: (key: string) => string | undefined;
  /** Cost-accounting sink for every verifier call. */
  recordUsage?: (usage: EntailmentUsage) => void;
}

/**
 * Load an entailment verifier from a pre-resolved assignment. Returns null
 * (logging why) whenever the assignment cannot back a verifier — the caller
 * then leaves the entailment gate absent.
 */
export async function loadEntailmentFromResolved(
  resolved: ResolvedAssignment,
  deps: LoadEntailmentDeps,
): Promise<EntailCapability | null> {
  const build = (completer: EntailmentCompleter): EntailCapability =>
    new LlmJudgeEntailmentVerifier({
      completer,
      getPromptStyle: deps.getPromptStyle,
      ...(deps.recordUsage ? { recordUsage: deps.recordUsage } : {}),
    });

  switch (resolved.kind) {
    case "disabled":
      log.info("Entailment verifier disabled (assignment unset)");
      return null;

    case "unresolved":
      log.warn(`Entailment verifier unresolved: ${resolved.reason}`);
      return null;

    case "local": {
      if (!resolved.available) {
        log.warn(`Entailment verifier disabled — model not found: ${resolved.modelPath}`);
        return null;
      }
      log.info(`Entailment verifier configured (local): ${resolved.catalogId}`);
      return build(withoutUsage(new LlamaCppCompleter(resolved.modelPath)));
    }

    case "anthropic": {
      if (!resolved.allowRemoteInference) {
        log.warn(`Entailment verifier disabled — ${CLOUD_EGRESS_DISABLED_REASON}`);
        return null;
      }
      const apiKey = resolveAnthropicApiKey(deps.configDir);
      if (!apiKey) {
        log.warn("Entailment verifier disabled — Anthropic API key not configured");
        return null;
      }
      log.info(`Entailment verifier configured (anthropic): ${resolved.catalogId}`);
      return build(anthropicEntailmentCompleter(resolved.apiModelId, apiKey));
    }

    case "http": {
      if (!resolved.available) {
        log.warn(
          `Entailment verifier disabled — HTTP backend unavailable: ${resolved.reason ?? resolved.url}`,
        );
        return null;
      }
      const completer = new HttpCompleter({
        baseUrl: resolved.url,
        apiPathPrefix: resolved.apiPathPrefix,
        model: resolved.model,
        apiKey: deps.getBackendApiKey?.(resolved.backendKey),
        allowRemoteInference: resolved.allowRemoteInference,
        modelControls: resolved.modelControls,
        modelBehavior: resolved.modelBehavior,
      });
      log.info(
        `Entailment verifier configured (http): backend=${resolved.backendKey} model=${resolved.model}`,
      );
      return build({
        modelId: completer.modelId,
        complete: (prompt, opts) => completer.completeWithUsage(prompt, opts),
        dispose: () => completer.dispose(),
      });
    }

    case "replay":
      log.warn(
        "Replay backend is not applicable for entailment verification — treating as disabled",
      );
      return null;

    case "codex": {
      const completer = loadCompletionFromResolved(resolved, deps);
      if (!completer) return null;
      return build({
        modelId: completer.modelId,
        complete: (prompt, opts) => completer.completeWithUsage!(prompt, opts),
        dispose: () => completer.dispose(),
      });
    }

    default:
      return assertNever(resolved);
  }
}
