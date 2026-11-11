// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The decision API a provider may serve beside, or instead of, its
 * OpenAI-compatible one: the endpoint that answers typed decisions (see
 * `decision.ts`) for the Decision model.
 *
 * Most providers speak TypeSafe's System One format (`{model, state,
 * questions}` in, `{model, answers, usage}` out) at a path of their own; a
 * few differ in the auth header, the score field, the URL, or the whole
 * schema. A backend's `decision` block (`inference.backends.<key>.decision`)
 * records which, and a provider preset's `decision` block (see
 * `provider-presets.ts`) carries the values for a known provider.
 */

/** The request and response format a decision endpoint speaks. */
export type DecisionProtocol =
  /** TypeSafe's System One body, at whatever path the provider serves it. */
  | "systemone"
  /** Cloudflare Workers AI: System One body posted to `<url>/<model>`, reply wrapped in `{result}`. */
  | "workers-ai"
  /** OpenAI's Decisions API: its own question and answer arrays. */
  | "openai-decisions";

/** The header a decision endpoint reads the backend's API key from. */
export type DecisionAuth =
  /** `Authorization: Bearer <key>` — almost every provider. */
  | "bearer"
  /** `api-key: <key>` — Microsoft Foundry. */
  | "api-key"
  /** `X-API-Key: <key>` — Fastino. */
  | "x-api-key";

/**
 * Which answer field holds the probability-weighted level of a score
 * question. System One's `score` does; Fastino's `score` is the most likely
 * level and its weighted value is `expected_level`.
 */
export type DecisionScoreField = "score" | "expected_level";

/** A value the operator supplies to complete a preset's decision URL. */
export interface DecisionPresetUrlParam {
  /** Placeholder name in the URL, written `{key}`. */
  key: string;
  label: string;
  placeholder: string;
}

/**
 * Whether a model id can name a Workers AI model in a URL path
 * (`@cf/cloudflare/clef`): segments of letters, digits, dots, dashes and
 * underscores, the first optionally starting with `@`. Anything else is
 * refused rather than escaped, so an id can never reach another path.
 */
export function isWorkersAiModelId(model: string): boolean {
  return /^@?[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(model);
}

/** The `{param}` placeholders a URL still contains. */
export function decisionUrlPlaceholders(url: string): string[] {
  return [...url.matchAll(/\{([a-z][a-z0-9-]*)\}/gi)].map((m) => m[1]!);
}
