// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Inference providers Omnesis knows how to reach. A preset fills the "Add
 * backend" forms of the portal, the apps and the CLI, so the operator only
 * gives what is their own: an API key, and for Cloudflare and Microsoft
 * Foundry an account or resource name.
 *
 * A provider serves an OpenAI-compatible API (`defaultUrl`), a decision API
 * (`decision`), or both; a backend made from a preset is one provider account
 * with one key, used by both endpoints.
 *
 * The OpenAI-compatible side carries no model ids: suggestions come only from
 * a backend's live `/models` probe, so the UI shows nothing rather than a
 * potentially stale hardcoded list. The decision side does list model ids:
 * decision servers mostly have no model listing, and the few ids per provider
 * change rarely. The models.dev decision catalog, when it covers the
 * provider, adds to them.
 */

import {
  decisionUrlPlaceholders,
  type DecisionAuth,
  type DecisionPresetUrlParam,
  type DecisionProtocol,
  type DecisionScoreField,
} from "./decision-api.js";
import type { DecisionModelOption, ProviderPresetView } from "./types.js";

/** A provider's decision API, as a preset describes it. */
export interface ProviderDecisionPreset {
  /**
   * The full endpoint, complete except for `{param}` placeholders listed in
   * `urlParams`. Local presets name the server's default port on this host.
   */
  url: string;
  protocol: DecisionProtocol;
  /** The header that carries the backend's API key. */
  auth: DecisionAuth;
  scoreField?: DecisionScoreField;
  /** Whether the provider refuses decision requests without a key. */
  keyRequired: boolean;
  /** Model ids to offer, most useful first. */
  suggestedModels: readonly string[];
  /** The provider's id in the models.dev decision catalog, when it is there. */
  modelsDevId?: string;
  urlParams?: readonly DecisionPresetUrlParam[];
  /** One sentence the setup form shows under the provider's name. */
  note?: string;
  /** Where the operator reads how the decision API works. */
  docsUrl: string;
  /** Where the operator creates an API key. */
  keyUrl?: string;
}

export interface ProviderPreset {
  /** Short identifier used as the default backend name. */
  id: string;
  /** Models.dev provider ID when it differs from the Omnesis preset ID. */
  modelsDevId?: string;
  /** Human-readable provider name. */
  name: string;
  /** `local`: a server the operator runs on their own machine; `cloud`: a hosted API. */
  kind: "local" | "cloud";
  /**
   * Default base URL for the OpenAI-compatible API (host, without a version
   * path). Absent for a provider that serves only decision models.
   */
  defaultUrl?: string;
  /**
   * Path segment between the base URL and the OpenAI-compatible endpoints,
   * carried onto the backend config when added from this preset. Defaults to
   * `"/v1"` when unset; set it when the provider's compat surface lives under a
   * non-`/v1` path (e.g. Gemini's `"/v1beta/openai"`).
   */
  apiPathPrefix?: string;
  /** Capability roles this provider is typically used for. */
  capabilities: readonly string[];
  /** The provider's decision API, when it has one. */
  decision?: ProviderDecisionPreset;
  /**
   * Set on the one preset that is not added as a backend: TypeSafe, served by
   * the built-in `typesafe/<model>` Decision assignment and its credential.
   */
  builtIn?: "typesafe";
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    kind: "cloud",
    defaultUrl: "https://api.openai.com",
    capabilities: ["agent", "embed", "transcribe", "decision"],
    decision: {
      url: "https://api.openai.com/v1/decisions",
      protocol: "openai-decisions",
      auth: "bearer",
      keyRequired: true,
      suggestedModels: ["gpt-6-luna"],
      docsUrl: "https://developers.openai.com/api/docs/guides/decisions",
      keyUrl: "https://platform.openai.com/api-keys",
    },
  },
  {
    id: "groq",
    name: "Groq",
    kind: "cloud",
    defaultUrl: "https://api.groq.com/openai",
    capabilities: ["agent", "transcribe"],
  },
  {
    id: "cerebras",
    name: "Cerebras",
    kind: "cloud",
    defaultUrl: "https://api.cerebras.ai",
    capabilities: ["agent"],
  },
  {
    id: "together",
    modelsDevId: "togetherai",
    name: "Together AI",
    kind: "cloud",
    defaultUrl: "https://api.together.xyz",
    capabilities: ["agent", "embed"],
  },
  {
    id: "fireworks",
    modelsDevId: "fireworks-ai",
    name: "Fireworks AI",
    kind: "cloud",
    defaultUrl: "https://api.fireworks.ai/inference",
    capabilities: ["agent", "embed", "decision"],
    decision: {
      url: "https://api.fireworks.ai/inference/v1/systemone",
      protocol: "systemone",
      auth: "bearer",
      keyRequired: true,
      suggestedModels: ["accounts/fireworks/models/rune"],
      docsUrl: "https://docs.fireworks.ai/api-reference/post-systemone",
      keyUrl: "https://app.fireworks.ai/settings/users/api-keys",
    },
  },
  {
    id: "mistral",
    name: "Mistral",
    kind: "cloud",
    defaultUrl: "https://api.mistral.ai",
    capabilities: ["agent", "embed", "transcribe"],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    kind: "cloud",
    defaultUrl: "https://api.deepseek.com",
    capabilities: ["agent"],
  },
  {
    id: "nvidia",
    name: "NVIDIA",
    kind: "cloud",
    defaultUrl: "https://integrate.api.nvidia.com",
    capabilities: ["agent"],
  },
  {
    id: "google",
    name: "Google AI (Gemini)",
    kind: "cloud",
    // Gemini's OpenAI-compatible surface lives at `…/v1beta/openai`, NOT under
    // `/v1`. The base URL is the bare host; `apiPathPrefix` carries the version
    // path so consumers build `…/v1beta/openai/chat|embeddings|models`.
    defaultUrl: "https://generativelanguage.googleapis.com",
    apiPathPrefix: "/v1beta/openai",
    capabilities: ["agent", "embed"],
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    kind: "cloud",
    // Standard OpenAI-compatible surface under `/v1`; "change the base_url and
    // api_key" and the OpenAI SDK works unmodified. No embedding models are
    // offered, so no `embed` capability.
    defaultUrl: "https://api.x.ai",
    capabilities: ["agent"],
  },
  {
    id: "meta",
    name: "Meta (Muse Spark)",
    kind: "cloud",
    // Meta Model API — the OpenAI-compatible Chat Completions surface for the
    // Muse Spark models, under `/v1`. (Distinct from the older Llama API at
    // `api.llama.com/compat/v1`.) No first-party embedding models, so no
    // `embed` capability.
    defaultUrl: "https://api.meta.ai",
    capabilities: ["agent"],
  },
  {
    id: "moonshot",
    modelsDevId: "moonshotai",
    name: "Moonshot AI (Kimi)",
    kind: "cloud",
    // Kimi Open Platform — OpenAI-compatible Chat Completions under `/v1`; set
    // the base URL + key and the OpenAI SDK works unmodified. No embedding
    // models are offered, so no `embed` capability.
    defaultUrl: "https://api.moonshot.ai",
    capabilities: ["agent"],
  },
  {
    id: "regolo",
    modelsDevId: "regolo-ai",
    name: "Regolo AI",
    kind: "cloud",
    // OpenAI-compatible Chat Completions and embeddings under `/v1`. Its
    // `/models` list also serves rerankers, speech-to-text, OCR and image
    // models; only the embedding models (e.g. `qwen3-embedding-8b`) suit the
    // embedder role.
    defaultUrl: "https://api.regolo.ai",
    capabilities: ["agent", "embed"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "cloud",
    // Aggregator — one key routes to many upstream providers. The OpenAI
    // compatible surface lives under `/api/v1`, so the base URL carries the
    // `/api` path segment and the default `/v1` prefix completes it. No
    // embeddings endpoint is offered, so no `embed` capability.
    defaultUrl: "https://openrouter.ai/api",
    capabilities: ["agent", "decision"],
    decision: {
      url: "https://openrouter.ai/api/v1/systemone",
      protocol: "systemone",
      auth: "bearer",
      keyRequired: true,
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
      modelsDevId: "openrouter",
      note: "One key for most hosted decision models.",
      docsUrl: "https://openrouter.ai/docs/guides/community/jev",
      keyUrl: "https://openrouter.ai/keys",
    },
  },
  // Providers that serve only decision models.
  {
    id: "ollaya",
    name: "Ollaya",
    kind: "local",
    capabilities: ["decision"],
    decision: {
      url: "http://127.0.0.1:11435/v1/systemone",
      protocol: "systemone",
      auth: "bearer",
      keyRequired: false,
      suggestedModels: [
        "kev",
        "d1",
        "strands-decider",
        "pplx-decider",
        "clef",
        "winnow:e4b",
        "laya",
      ],
      note: "Runs open decision models on this machine. Pull a model with `ollaya pull <model>` first.",
      docsUrl: "https://ollaya.dev/docs/api",
    },
  },
  {
    id: "ollama",
    name: "Ollama",
    kind: "local",
    capabilities: ["decision"],
    decision: {
      url: "http://127.0.0.1:11434/v1/systemone",
      protocol: "systemone",
      auth: "bearer",
      keyRequired: false,
      suggestedModels: ["d3:4b", "tev1:4b", "kev:4b-q8_0", "d1:3b", "laya", "nimble:9b"],
      note: "Ollama serves decision models too. Pull a model with `ollama pull <model>` first.",
      docsUrl: "https://docs.ollama.com/api/systemone",
    },
  },
  {
    id: "typesafe",
    name: "TypeSafe",
    kind: "cloud",
    capabilities: ["decision"],
    builtIn: "typesafe",
    decision: {
      url: "https://api.typesafe.ai/v1/systemone",
      protocol: "systemone",
      auth: "bearer",
      keyRequired: true,
      suggestedModels: ["jev-1.14.0", "jev-1.13.0"],
      note: "Jev, the model every decision threshold was tuned on.",
      docsUrl: "https://docs.typesafe.ai/api",
      keyUrl: "https://console.typesafe.ai/keys",
    },
  },
  {
    id: "ollama-cloud",
    name: "Ollama Cloud",
    kind: "cloud",
    capabilities: ["decision"],
    decision: {
      url: "https://ollama.com/v1/systemone",
      protocol: "systemone",
      auth: "bearer",
      keyRequired: true,
      suggestedModels: ["clef:27b"],
      docsUrl: "https://docs.ollama.com/api/systemone",
      keyUrl: "https://ollama.com/settings/keys",
    },
  },
  {
    id: "perplexity",
    name: "Perplexity",
    kind: "cloud",
    capabilities: ["decision"],
    decision: {
      url: "https://api.perplexity.ai/v1/decisions",
      protocol: "systemone",
      auth: "bearer",
      keyRequired: true,
      suggestedModels: ["pplx-decider-flash-v1.2", "pplx-decider-v1.2"],
      docsUrl: "https://docs.perplexity.ai/docs/decisions/quickstart",
      keyUrl: "https://www.perplexity.ai/account/api/keys",
    },
  },
  {
    id: "baseten",
    name: "Baseten",
    kind: "cloud",
    capabilities: ["decision"],
    decision: {
      url: "https://inference.baseten.co/v1/systemone",
      protocol: "systemone",
      auth: "bearer",
      keyRequired: true,
      suggestedModels: [
        "decision-models/baseten-elephant-9b-latest",
        "decision-models/baseten-joey-2b-latest",
        "decision-models/baseten-mammoth-27b-latest",
      ],
      docsUrl: "https://docs.baseten.co/reference/inference-api/system-one",
      keyUrl: "https://app.baseten.co/settings/api_keys",
    },
  },
  {
    id: "deepinfra",
    name: "DeepInfra",
    kind: "cloud",
    capabilities: ["decision"],
    decision: {
      url: "https://api.deepinfra.com/v1/decisions",
      protocol: "systemone",
      auth: "bearer",
      keyRequired: true,
      suggestedModels: ["nace-ai/drex-max"],
      docsUrl: "https://deepinfra.com/nace-ai/drex-max/api",
      keyUrl: "https://deepinfra.com/dash/api_keys",
    },
  },
  {
    id: "vercel",
    name: "Vercel AI Gateway",
    kind: "cloud",
    capabilities: ["decision"],
    decision: {
      url: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
      protocol: "systemone",
      auth: "bearer",
      keyRequired: true,
      suggestedModels: [
        "typesafe-ai/jev-1.14.0",
        "perplexity/pplx-decider-flash-v1.2",
        "liquid/d1",
        "microsoft/microsoft-decision-1",
        "convaiinnovations/laya",
      ],
      modelsDevId: "vercel",
      docsUrl: "https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe",
      keyUrl: "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%2Fapi-keys",
    },
  },
  {
    id: "cloudflare",
    name: "Cloudflare Workers AI",
    kind: "cloud",
    capabilities: ["decision"],
    decision: {
      url: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run",
      protocol: "workers-ai",
      auth: "bearer",
      keyRequired: true,
      suggestedModels: ["@cf/cloudflare/clef-flash", "@cf/cloudflare/clef"],
      modelsDevId: "cloudflare-workers-ai",
      urlParams: [
        { key: "account", label: "Account ID", placeholder: "0123456789abcdef0123456789abcdef" },
      ],
      note: "Workers AI shortens long text to fit Clef's context without saying so.",
      docsUrl: "https://developers.cloudflare.com/workers-ai/models/clef/",
      keyUrl: "https://dash.cloudflare.com/profile/api-tokens",
    },
  },
  {
    id: "azure-foundry",
    name: "Microsoft Foundry",
    kind: "cloud",
    capabilities: ["decision"],
    decision: {
      url: "https://{resource}.services.ai.azure.com/providers/microsoft/v1/systemone",
      protocol: "systemone",
      auth: "api-key",
      keyRequired: true,
      suggestedModels: ["microsoft-decision-1"],
      urlParams: [{ key: "resource", label: "Resource name", placeholder: "my-foundry" }],
      note: "The model is your deployment's name.",
      docsUrl:
        "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision",
      keyUrl: "https://ai.azure.com",
    },
  },
  {
    id: "fastino",
    name: "Fastino",
    kind: "cloud",
    capabilities: ["decision"],
    decision: {
      url: "https://api.fastino.ai/v1/systemone",
      protocol: "systemone",
      auth: "x-api-key",
      scoreField: "expected_level",
      keyRequired: true,
      suggestedModels: ["fastino/GLiDE"],
      docsUrl: "https://docs.fastino.ai/inference/systemone",
    },
  },
  {
    id: "aimlapi",
    name: "AI/ML API",
    kind: "cloud",
    capabilities: ["decision"],
    decision: {
      url: "https://api.aimlapi.com/v1/decisions",
      protocol: "systemone",
      auth: "bearer",
      keyRequired: true,
      suggestedModels: ["typesafe/jev-1.14", "liquid/d1"],
      docsUrl: "https://docs.aimlapi.com/api-references/decision-models",
      keyUrl: "https://aimlapi.com/app/keys",
    },
  },
];

/** Look up a provider preset by its short id. */
export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

const trimSlashes = (url: string) => url.replace(/\/+$/, "");

/** Look up the provider preset whose default URL a backend uses, ignoring trailing slashes. */
export function getPresetByUrl(url: string): ProviderPreset | undefined {
  const normalized = trimSlashes(url);
  return PROVIDER_PRESETS.find((p) => p.defaultUrl && trimSlashes(p.defaultUrl) === normalized);
}

/**
 * The preset a configured backend was made from: by its recorded id, or else
 * by an exact match of its OpenAI-compatible URL or its decision URL (so a
 * hand-written config still gets its brand). A decision URL with `{param}`
 * placeholders never matches by URL alone.
 */
export function findPreset(
  presetId: string | undefined,
  urls: { url?: string; decisionUrl?: string },
): ProviderPreset | undefined {
  if (presetId) {
    const byId = getPreset(presetId);
    if (byId) return byId;
  }
  if (urls.url) {
    const byUrl = getPresetByUrl(urls.url);
    if (byUrl) return byUrl;
  }
  if (!urls.decisionUrl) return undefined;
  const decisionUrl = trimSlashes(urls.decisionUrl);
  return PROVIDER_PRESETS.find(
    (p) =>
      p.decision &&
      !p.decision.urlParams?.length &&
      !p.builtIn &&
      trimSlashes(p.decision.url) === decisionUrl,
  );
}

/**
 * A preset's decision URL with its placeholders filled. Each value is
 * URL-path-encoded and must be non-empty; a placeholder left without a value
 * is an error naming its label.
 */
export function fillDecisionPresetUrl(
  preset: ProviderPreset,
  params: Readonly<Record<string, string>>,
): string {
  if (!preset.decision) throw new Error(`${preset.name} serves no decision models`);
  let url = preset.decision.url;
  for (const param of preset.decision.urlParams ?? []) {
    const value = params[param.key]?.trim();
    if (!value) throw new Error(`${preset.name} needs your ${param.label.toLowerCase()}`);
    url = url.replaceAll(`{${param.key}}`, encodeURIComponent(value));
  }
  const left = decisionUrlPlaceholders(url);
  if (left.length) throw new Error(`${preset.name} URL still has {${left[0]}}`);
  return url;
}

/**
 * A preset as `/admin/models` serves it: its decision API, when it has one,
 * lists the preset's own models first (in its order, with the catalog's facts
 * when it knows the model), then any further models the catalog lists for the
 * provider.
 */
export function providerPresetView(
  preset: ProviderPreset,
  catalog: ReadonlyMap<string, DecisionModelOption> = new Map(),
): ProviderPresetView {
  const { decision, ...rest } = preset;
  if (!decision) return rest;
  const extra = new Map(catalog);
  const models: DecisionModelOption[] = decision.suggestedModels.map((id) => {
    const known = extra.get(id);
    extra.delete(id);
    return known ? { ...known, source: "preset" } : { id, source: "preset" };
  });
  models.push(...[...extra.values()].sort((a, b) => a.id.localeCompare(b.id)));
  return { ...rest, decision: { ...decision, models } };
}
