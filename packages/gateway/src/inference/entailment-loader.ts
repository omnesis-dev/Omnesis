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
import { AnthropicTemperature, NO_THINKING, responseText } from "./anthropic-messages.js";
import { prepareAnswerWitnessRequest, parseAnswerWitnessVerdict } from "./answer-entailment.js";
import {
  annotationEntailmentPrompt,
  assessAnnotationEntailment,
  AnnotationAssessmentError,
  ANNOTATION_VERDICT_MAX_TOKENS,
  uncoveredClaimWords,
} from "./annotation-entailment.js";
import { loadCompletionFromResolved, type LoadCompletionDeps } from "./completion-loader.js";
import { LlamaCppCompleter } from "./llama-cpp-completer.js";
import { AgentTurnCompleter } from "./agent-turn-completer.js";
import { HttpCompleter, type HttpCompletion } from "./http-completer.js";

import {
  CONTEXTUAL_VERDICT_MAX_TOKENS,
  CONTEXTUAL_EVIDENCE_MAX_BYTES,
  ContextualAssessmentError,
} from "./contextual-entailment.js";

import {
  prepareContextualWitnessRequest,
  parseContextualWitnessVerdict,
  contextualSchemaIssues,
  contextualWitnessFailure,
} from "./contextual-segments.js";

import type { InferenceHealth } from "./model-health.js";

const log = createLogger("inference:entailment");

export type EntailmentPromptStyle = "judge" | "minicheck";

/** Per-call token usage reported to the cost-accounting sink. */
export interface EntailmentUsage {
  promptTokens: number;
  completionTokens: number;
  /** Reported subsets of total prompt tokens; absent is unknown, not zero. */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
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
    "Answer with exactly one word — ENTAILMENT, NEUTRAL, or CONTRADICTION.",
    "ENTAILMENT only if the quote establishes the claim at its stated modality.",
    "For a compound claim, every factual clause and implied factual premise must be supported; one supported clause does not establish the whole claim. Otherwise answer NEUTRAL.",
    "A historical event, unsuccessful attempt, or past status does not establish that the condition persists now, remains unresolved, or creates a current obligation. Missing later evidence establishes neither resolution nor non-resolution; such a claim is NEUTRAL without support for its stated time and status.",
    "Advice or a recommendation does not excuse an unsupported factual premise. Separate what someone could do from claims that they still must act or that a condition will persist until they act; unsupported premises make the compound claim NEUTRAL.",
    "A quote that merely mentions the claim's topic is NEUTRAL.",
    "A quote showing a request, estimate, application, or intention where the claim asserts possession or completion is NEUTRAL.",
    "First- or second-person language supports a claim about a named person only when the quote itself identifies that person as the speaker or addressee; a bare ‘I’ or ‘you’ is otherwise NEUTRAL.",
    'A claim whose exhaustive or negative scope ("only", "no", "none", "never", "nothing else", "all") is not itself established by the quote is NEUTRAL — a quote listing what IS included does not license an "only" or "nothing else" claim about what it does not show.',
    "CONTRADICTION only if the quote establishes the claim is false.",
    "",
    `Evidence quote: ${input.evidence}`,
    `Claim: ${input.claim}`,
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
    opts?: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
  ): Promise<HttpCompletion>;
  dispose(): Promise<void> | void;
}

export interface LlmJudgeEntailmentVerifierDeps {
  completer: EntailmentCompleter;
  /** Read live per call so a config change takes effect without a reload. */
  getPromptStyle: () => EntailmentPromptStyle;
  /** Cost-accounting sink; fired for each completed inference attempt with the decoded usage (zeros when the transport reports none). */
  recordUsage?: (usage: EntailmentUsage) => void;
}

/** Repair for spans that left claim words uncovered; none when every word is covered. */
function uncoveredWordsRepair(missing: readonly string[]): string | undefined {
  return missing.length
    ? `A prior response left these words of the claim outside every assertion's spans: ${missing.map((word) => JSON.stringify(word)).join(", ")}. Decompose the unchanged claim again so the spans together cover each of them, and reassess every assertion from the unchanged input below; do not preserve any prior verdict.`
    : undefined;
}

/** Repair for a supported verdict whose evidence quotes are missing or not authorized witnesses. */
const WITNESS_REPAIR =
  "A prior response gave a supported verdict whose evidenceQuotes were missing or were not exact authorized witnesses. For selected_quote frames only selectedQuotes are witnesses; whole_source authorizes its actual source fields; verifiedReferences authorize their text. Surrounding text, titles, metadata, framing and the proposed claim are never witnesses. Reassess every assertion and the placement from the unchanged input below: quote only exact substrings of authorized witnesses, character for character, and return unsupported wherever no authorized witness states it. Do not preserve any prior verdict.";

/**
 * EntailCapability over a text completer: render the configured prompt style,
 * parse the answer defensively, report usage. Throws on an unparseable
 * answer — a judge that cannot commit to a label is unavailable, and callers
 * must fail open rather than act on a fabricated verdict.
 */
export class LlmJudgeEntailmentVerifier implements EntailCapability {
  constructor(private readonly deps: LlmJudgeEntailmentVerifierDeps) {}

  async verify(input: {
    claim: string;
    evidence: string;
    context?: string;
    assessment?: "annotation_atomic" | "answer_segments";
    signal?: AbortSignal;
  }): Promise<EntailVerdict> {
    input.signal?.throwIfAborted();
    const { claim, evidence, context } = input;
    const style = this.deps.getPromptStyle();
    const atomic = input.assessment === "annotation_atomic";
    const answer = input.assessment === "answer_segments";
    const contextual = input.context !== undefined || atomic || answer;
    if (contextual && Buffer.byteLength(input.evidence) > CONTEXTUAL_EVIDENCE_MAX_BYTES)
      throw new Error(
        "Contextual verifier evidence exceeds its bounded input budget; verification unavailable",
      );
    if (contextual && style === "minicheck") {
      throw new Error(
        "MiniCheck cannot verify interpretation context; contextual verifier unavailable",
      );
    }
    const answerRequest = answer
      ? prepareAnswerWitnessRequest({ claim, evidence, context })
      : undefined;
    const contextualRequest =
      contextual && !answer && !atomic
        ? prepareContextualWitnessRequest({ claim, evidence, context: context! })
        : undefined;
    const prompt = answerRequest
      ? answerRequest.prompt
      : atomic
        ? annotationEntailmentPrompt({ claim, evidence, context })
        : contextual
          ? contextualRequest!.prompt
          : style === "minicheck"
            ? minicheckPrompt(input)
            : judgePrompt(input);
    let attemptPrompt = prompt;
    for (let attempt = 0; ; attempt++) {
      input.signal?.throwIfAborted();
      const { text, usage } = await this.deps.completer.complete(attemptPrompt, {
        maxTokens: atomic
          ? ANNOTATION_VERDICT_MAX_TOKENS
          : contextual
            ? CONTEXTUAL_VERDICT_MAX_TOKENS
            : VERDICT_MAX_TOKENS,
        temperature: 0,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      // Completed inference is billed even when cancellation arrived in flight.
      this.deps.recordUsage?.({
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        modelId: this.deps.completer.modelId,
        ...(usage?.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(usage?.cacheCreationTokens !== undefined
          ? { cacheCreationTokens: usage.cacheCreationTokens }
          : {}),
      });
      input.signal?.throwIfAborted();
      const annotation = atomic ? assessAnnotationEntailment(text, claim, evidence) : undefined;
      const label = answerRequest
        ? parseAnswerWitnessVerdict(text, answerRequest)
        : atomic
          ? annotation && "label" in annotation
            ? annotation.label
            : null
          : contextual
            ? parseContextualWitnessVerdict(text, contextualRequest!)
            : style === "minicheck"
              ? parseMinicheckLabel(text)
              : parseJudgeLabel(text);
      if (label !== null) return { label, raw: text.trim() };
      if (annotation && "failure" in annotation) {
        // Atomic annotations get one repair call for a gap the engine can name
        // exactly: claim words the spans left uncovered, or a supported verdict
        // whose quotes are not authorized witnesses. The repaired response is
        // held to the same checks; any other malformed output stays unverified.
        const repair =
          attempt !== 0
            ? undefined
            : annotation.failure === "coverage"
              ? uncoveredWordsRepair(uncoveredClaimWords(text, claim))
              : annotation.failure === "witness_outside_authority" ||
                  annotation.failure === "positive_witness_missing"
                ? WITNESS_REPAIR
                : undefined;
        if (repair) {
          attemptPrompt = [repair, prompt].join("\n\n");
          continue;
        }
        throw new AnnotationAssessmentError(
          annotation.failure,
          this.deps.completer.modelId,
          annotation.witnessMiss,
        );
      }
      if (contextual) {
        const category = answerRequest
          ? "assessment_schema"
          : contextualWitnessFailure(text, contextualRequest!);
        if (attempt === 0) {
          // A protocol failure is not a semantic verdict. Rejudge the identical
          // input once; never salvage invalid witnesses or ask to retain a label.
          attemptPrompt = [
            `A prior response failed protocol validation (${category}). Re-evaluate both assessments from the unchanged input below; do not preserve any prior verdict.`,
            answerRequest || contextualRequest
              ? "Return the exact request witnessSet and required JSON schema. Positive evidenceSegments must name only supplied authorized IDs, interpreted with all surrounding qualifications. Never invent IDs or preserve the previous verdict. If support is absent return unsupported."
              : "Return the required JSON schema. Positive evidenceQuotes must be exact authorized source witnesses: selected_quote permits only selectedQuotes; whole_source permits its authorized source fields. Framing, limitations, interpretation constraints, instructions and candidate prose are not factual witnesses. If support is absent, return unsupported rather than inventing or rewriting a quote.",
            prompt,
          ].join("\n\n");
          input.signal?.throwIfAborted();
          continue;
        }
        throw new ContextualAssessmentError(
          category,
          this.deps.completer.modelId,
          category === "assessment_schema" && contextualRequest
            ? contextualSchemaIssues(text, contextualRequest)
            : [],
        );
      }
      throw new Error(
        `entailment verifier returned no parseable ${style === "minicheck" ? "Yes/No" : "label"} (model=${this.deps.completer.modelId}, ${text.length} chars)`,
      );
    }
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
  const sampling = new AnthropicTemperature();
  return {
    modelId,
    complete: async (prompt, opts) => {
      const request = {
        model: modelId,
        max_tokens: opts?.maxTokens ?? 128,
        thinking: NO_THINKING,
        messages: [{ role: "user" as const, content: prompt }],
      };
      const response = await sampling.send(opts?.temperature ?? 0, (temperature) =>
        client.messages.create(
          temperature === undefined ? request : { ...request, temperature },
          opts?.signal ? { signal: opts.signal } : undefined,
        ),
      );
      return {
        text: responseText(response),
        usage: {
          promptTokens:
            response.usage.input_tokens +
            (response.usage.cache_read_input_tokens ?? 0) +
            (response.usage.cache_creation_input_tokens ?? 0),
          ...(response.usage.cache_read_input_tokens != null
            ? { cacheReadTokens: response.usage.cache_read_input_tokens }
            : {}),
          ...(response.usage.cache_creation_input_tokens != null
            ? { cacheCreationTokens: response.usage.cache_creation_input_tokens }
            : {}),
          completionTokens: response.usage.output_tokens,
        },
      };
    },
    dispose: () => {},
  };
}

export interface LoadEntailmentDeps {
  health?: InferenceHealth;
  codexRuntimeService?: LoadCompletionDeps["codexRuntimeService"];
  claudeCodeService?: LoadCompletionDeps["claudeCodeService"];
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
  const beginModelCall = deps.health?.callFactory(resolved.role);
  const provider = await loadVerifier(resolved, deps);
  return provider && deps.health
    ? deps.health.observe(resolved, provider, ["verify"], beginModelCall)
    : provider;
}

async function loadVerifier(
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

    case "codex":
    case "claude-code": {
      const completer = loadCompletionFromResolved(resolved, { ...deps, health: undefined });
      if (!(completer instanceof AgentTurnCompleter)) return null;
      return build({
        modelId: completer.modelId,
        complete: (prompt, opts) => completer.completeWithUsageSettled(prompt, opts),
        dispose: () => completer.dispose(),
      });
    }

    case "typesafe":
      return null;

    default:
      return assertNever(resolved);
  }
}
