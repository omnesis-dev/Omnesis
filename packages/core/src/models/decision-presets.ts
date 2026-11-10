// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Decision model providers — the servers and clouds that answer typed
 * decisions (see `decision.ts`) over a System One-style API.
 *
 * Most speak TypeSafe's System One format (`{model, state, questions}` in,
 * `{model, answers, usage}` out) at a path of their own; a few differ in the
 * auth header, the score field, the URL, or the whole schema. A preset carries
 * exactly what a decision backend needs to reach one of them, so the portal,
 * the apps and the CLI fill the form and only ask for what is the operator's
 * own: an API key, and for Cloudflare and Microsoft Foundry an account or
 * resource name.
 *
 * Unlike chat presets, a decision preset lists model ids: decision servers
 * mostly have no model listing, and the few ids per provider change rarely.
 * The models.dev decision catalog, when it covers the provider, adds to them.
 */

/** The request and response format a decision backend speaks. */
export type DecisionProtocol =
  /** TypeSafe's System One body, at whatever path the provider serves it. */
  | "systemone"
  /** Cloudflare Workers AI: System One body posted to `<url>/<model>`, reply wrapped in `{result}`. */
  | "workers-ai"
  /** OpenAI's Decisions API: its own question and answer arrays. */
  | "openai-decisions";

export const DECISION_PROTOCOLS: readonly DecisionProtocol[] = [
  "systemone",
  "workers-ai",
  "openai-decisions",
];

/** How a decision backend sends its API key. */
export type DecisionAuth =
  /** `Authorization: Bearer <key>` — almost every provider. */
  | "bearer"
  /** `api-key: <key>` — Microsoft Foundry. */
  | "api-key"
  /** `X-API-Key: <key>` — Fastino. */
  | "x-api-key";

export const DECISION_AUTHS: readonly DecisionAuth[] = ["bearer", "api-key", "x-api-key"];

/**
 * Which answer field holds the probability-weighted level of a score
 * question. System One's `score` does; Fastino's `score` is the most likely
 * level and its weighted value is `expected_level`.
 */
export type DecisionScoreField = "score" | "expected_level";

/** A value the operator supplies to complete a preset's URL. */
export interface DecisionPresetUrlParam {
  /** Placeholder name in the URL, written `{key}`. */
  key: string;
  label: string;
  placeholder: string;
}

export interface DecisionProviderPreset {
  /** Stable id, also the default backend name. */
  id: string;
  name: string;
  /** `local`: a server the operator runs on their own machine; `cloud`: a hosted API. */
  kind: "local" | "cloud";
  /**
   * The endpoint, complete except for `{param}` placeholders listed in
   * `urlParams`. Local presets name the server's default port on this host.
   */
  url: string;
  protocol: DecisionProtocol;
  auth: DecisionAuth;
  scoreField?: DecisionScoreField;
  /** Whether the provider refuses requests without a key. */
  keyRequired: boolean;
  /**
   * Set on the one preset that is not a decision backend: TypeSafe, served
   * by the built-in `typesafe/<model>` assignment and its credential.
   */
  builtIn?: "typesafe";
  /** The provider's id in the models.dev decision catalog, when it is there. */
  modelsDevId?: string;
  /** Where the operator reads how the API works. */
  docsUrl: string;
  /** Where the operator creates an API key. */
  keyUrl?: string;
  /** Model ids to offer, most useful first. */
  suggestedModels: readonly string[];
  urlParams?: readonly DecisionPresetUrlParam[];
  /** One sentence the setup form shows under the provider's name. */
  note?: string;
}

export const DECISION_PROVIDER_PRESETS: readonly DecisionProviderPreset[] = [
  {
    id: "ollaya",
    name: "Ollaya",
    kind: "local",
    url: "http://127.0.0.1:11435/v1/systemone",
    protocol: "systemone",
    auth: "bearer",
    keyRequired: false,
    docsUrl: "https://ollaya.dev/docs/api",
    suggestedModels: ["kev", "d1", "strands-decider", "pplx-decider", "clef", "winnow:e4b", "laya"],
    note: "Runs open decision models on this machine. Pull a model with `ollaya pull <model>` first.",
  },
  {
    id: "ollama",
    name: "Ollama",
    kind: "local",
    url: "http://127.0.0.1:11434/v1/systemone",
    protocol: "systemone",
    auth: "bearer",
    keyRequired: false,
    docsUrl: "https://docs.ollama.com/api/systemone",
    suggestedModels: ["d3:4b", "tev1:4b", "kev:4b-q8_0", "d1:3b", "laya", "nimble:9b"],
    note: "Ollama serves decision models too. Pull a model with `ollama pull <model>` first.",
  },
  {
    id: "typesafe",
    name: "TypeSafe",
    kind: "cloud",
    url: "https://api.typesafe.ai/v1/systemone",
    protocol: "systemone",
    auth: "bearer",
    keyRequired: true,
    builtIn: "typesafe",
    docsUrl: "https://docs.typesafe.ai/api",
    keyUrl: "https://console.typesafe.ai/keys",
    suggestedModels: ["jev-1.14.0", "jev-1.13.0"],
    note: "Jev, the model every decision threshold was tuned on.",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "cloud",
    url: "https://openrouter.ai/api/v1/systemone",
    protocol: "systemone",
    auth: "bearer",
    keyRequired: true,
    modelsDevId: "openrouter",
    docsUrl: "https://openrouter.ai/docs/guides/community/jev",
    keyUrl: "https://openrouter.ai/keys",
    suggestedModels: [
      "typesafe/jev-1.14",
      "perplexity/pplx-decider-flash-v1.2",
      "liquid/d1.1",
      "cloudflare/clef-flash",
      "microsoft/microsoft-decision-1",
      "openai/gpt-6-luna-decisions",
      "nace-ai/drex-max",
      "togethercomputer/tev1-4b-experimental",
      "jaredpalmer/kev-4b",
    ],
    note: "One key for most hosted decision models.",
  },
  {
    id: "ollama-cloud",
    name: "Ollama Cloud",
    kind: "cloud",
    url: "https://ollama.com/v1/systemone",
    protocol: "systemone",
    auth: "bearer",
    keyRequired: true,
    docsUrl: "https://docs.ollama.com/api/systemone",
    keyUrl: "https://ollama.com/settings/keys",
    suggestedModels: ["clef:27b"],
  },
  {
    id: "perplexity",
    name: "Perplexity",
    kind: "cloud",
    url: "https://api.perplexity.ai/v1/decisions",
    protocol: "systemone",
    auth: "bearer",
    keyRequired: true,
    docsUrl: "https://docs.perplexity.ai/docs/decisions/quickstart",
    keyUrl: "https://www.perplexity.ai/account/api/keys",
    suggestedModels: ["pplx-decider-flash-v1.2", "pplx-decider-v1.2"],
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    kind: "cloud",
    url: "https://api.fireworks.ai/inference/v1/systemone",
    protocol: "systemone",
    auth: "bearer",
    keyRequired: true,
    docsUrl: "https://docs.fireworks.ai/api-reference/post-systemone",
    keyUrl: "https://app.fireworks.ai/settings/users/api-keys",
    suggestedModels: ["accounts/fireworks/models/rune"],
  },
  {
    id: "baseten",
    name: "Baseten",
    kind: "cloud",
    url: "https://inference.baseten.co/v1/systemone",
    protocol: "systemone",
    auth: "bearer",
    keyRequired: true,
    docsUrl: "https://docs.baseten.co/reference/inference-api/system-one",
    keyUrl: "https://app.baseten.co/settings/api_keys",
    suggestedModels: [
      "decision-models/baseten-elephant-9b-latest",
      "decision-models/baseten-joey-2b-latest",
      "decision-models/baseten-mammoth-27b-latest",
    ],
  },
  {
    id: "deepinfra",
    name: "DeepInfra",
    kind: "cloud",
    url: "https://api.deepinfra.com/v1/decisions",
    protocol: "systemone",
    auth: "bearer",
    keyRequired: true,
    docsUrl: "https://deepinfra.com/nace-ai/drex-max/api",
    keyUrl: "https://deepinfra.com/dash/api_keys",
    suggestedModels: ["nace-ai/drex-max"],
  },
  {
    id: "vercel",
    name: "Vercel AI Gateway",
    kind: "cloud",
    url: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
    protocol: "systemone",
    auth: "bearer",
    keyRequired: true,
    modelsDevId: "vercel",
    docsUrl: "https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe",
    keyUrl: "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%2Fapi-keys",
    suggestedModels: [
      "typesafe-ai/jev-1.14.0",
      "perplexity/pplx-decider-flash-v1.2",
      "liquid/d1",
      "microsoft/microsoft-decision-1",
      "convaiinnovations/laya",
    ],
  },
  {
    id: "cloudflare",
    name: "Cloudflare Workers AI",
    kind: "cloud",
    url: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run",
    protocol: "workers-ai",
    auth: "bearer",
    keyRequired: true,
    modelsDevId: "cloudflare-workers-ai",
    docsUrl: "https://developers.cloudflare.com/workers-ai/models/clef/",
    keyUrl: "https://dash.cloudflare.com/profile/api-tokens",
    suggestedModels: ["@cf/cloudflare/clef-flash", "@cf/cloudflare/clef"],
    urlParams: [
      { key: "account", label: "Account ID", placeholder: "0123456789abcdef0123456789abcdef" },
    ],
    note: "Workers AI shortens long text to fit Clef's context without saying so.",
  },
  {
    id: "openai",
    name: "OpenAI",
    kind: "cloud",
    url: "https://api.openai.com/v1/decisions",
    protocol: "openai-decisions",
    auth: "bearer",
    keyRequired: true,
    docsUrl: "https://developers.openai.com/api/docs/guides/decisions",
    keyUrl: "https://platform.openai.com/api-keys",
    suggestedModels: ["gpt-6-luna"],
  },
  {
    id: "azure-foundry",
    name: "Microsoft Foundry",
    kind: "cloud",
    url: "https://{resource}.services.ai.azure.com/providers/microsoft/v1/systemone",
    protocol: "systemone",
    auth: "api-key",
    keyRequired: true,
    docsUrl:
      "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision",
    keyUrl: "https://ai.azure.com",
    suggestedModels: ["microsoft-decision-1"],
    urlParams: [{ key: "resource", label: "Resource name", placeholder: "my-foundry" }],
    note: "The model is your deployment's name.",
  },
  {
    id: "fastino",
    name: "Fastino",
    kind: "cloud",
    url: "https://api.fastino.ai/v1/systemone",
    protocol: "systemone",
    auth: "x-api-key",
    scoreField: "expected_level",
    keyRequired: true,
    docsUrl: "https://docs.fastino.ai/inference/systemone",
    suggestedModels: ["fastino/GLiDE"],
  },
  {
    id: "aimlapi",
    name: "AI/ML API",
    kind: "cloud",
    url: "https://api.aimlapi.com/v1/decisions",
    protocol: "systemone",
    auth: "bearer",
    keyRequired: true,
    docsUrl: "https://docs.aimlapi.com/api-references/decision-models",
    keyUrl: "https://aimlapi.com/app/keys",
    suggestedModels: ["typesafe/jev-1.14", "liquid/d1"],
  },
];

export function getDecisionPreset(id: string): DecisionProviderPreset | undefined {
  return DECISION_PROVIDER_PRESETS.find((p) => p.id === id);
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

/**
 * Fill a preset's URL placeholders. Each value is URL-path-encoded and must be
 * non-empty; a placeholder left without a value is an error naming its label.
 */
export function fillDecisionPresetUrl(
  preset: DecisionProviderPreset,
  params: Readonly<Record<string, string>>,
): string {
  let url = preset.url;
  for (const param of preset.urlParams ?? []) {
    const value = params[param.key]?.trim();
    if (!value) throw new Error(`${preset.name} needs your ${param.label.toLowerCase()}`);
    url = url.replaceAll(`{${param.key}}`, encodeURIComponent(value));
  }
  const left = decisionUrlPlaceholders(url);
  if (left.length) throw new Error(`${preset.name} URL still has {${left[0]}}`);
  return url;
}

/**
 * The preset a configured backend was made from: by its recorded id, or else
 * by an exact URL match (so a hand-written config still gets its brand).
 */
export function findDecisionPreset(
  presetId: string | undefined,
  url: string,
): DecisionProviderPreset | undefined {
  if (presetId) {
    const byId = getDecisionPreset(presetId);
    if (byId) return byId;
  }
  const normalized = url.replace(/\/+$/, "");
  return DECISION_PROVIDER_PRESETS.find(
    (p) => !p.urlParams?.length && p.url.replace(/\/+$/, "") === normalized,
  );
}
