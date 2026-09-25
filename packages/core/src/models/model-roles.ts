// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Derive which capability roles a model can serve from its id.
 *
 * The OpenAI-compatible `/v1/models` protocol every HTTP backend speaks
 * (vLLM, OpenAI, Groq, Together, Mistral, DeepSeek, Google's shim)
 * advertises only `{ id }` per model — never the model's type or purpose.
 * So an embedder, a chat model, and a transcriber are indistinguishable from
 * the protocol alone, and the `/portal/settings/models` capability pages would
 * otherwise suggest a chat model under Embedder, an embedder under Agent,
 * and so on.
 *
 * This module derives purpose from a model-name heuristic. It is a pure
 * string classifier — no network, no learned model. It deliberately lives
 * in core so the gateway (which applies it server-side before shipping the
 * `/admin/models` overview) and the CLI share one source of truth; the
 * portal is plain JS and reads the gateway-computed result.
 *
 * The heuristic is the default, not the last word: the portal pairs it
 * with a free-text box so any model can still be assigned by hand.
 * Behavioral capability probing — confirming purpose by actually calling
 * the endpoint — is the authoritative upgrade, tracked in #508.
 */

import type { CapabilityRole } from "./capabilities.js";

/**
 * Embedding families. The bare `embed` token already covers the bulk of
 * embedding ids — `text-embedding-3`, `*-embeddings`, `nomic-embed-text`,
 * `mxbai-embed-large`, `snowflake-arctic-embed`, `jina-embeddings`. The
 * remaining tokens are the well-known families whose ids don't carry the
 * word at all (bge, gte, e5, stella); word boundaries on the short ones
 * keep them from matching inside unrelated words.
 */
const EMBED_RE = /embed|\bbge\b|\bgte\b|\be5\b|\bstella\b|\bm2-bert\b|\buae\b/i;

/**
 * Speech-to-text families. Whisper is the dominant name; the rest are the
 * generic tokens an OpenAI-compatible audio server might use for its
 * transcription model id.
 */
const TRANSCRIBE_RE = /whisper|transcrib|\bstt\b|speech[-_]?to[-_]?text|\basr\b/i;

/**
 * Dedicated OCR / document-parsing model families. Kept deliberately narrow —
 * only models whose name signals they're OCR-specialized — so a general
 * vision-language model (Qwen-VL, MiniCPM-V) isn't stolen from the agent tab
 * just because it can also read text. The OCR tab still accepts any model
 * typed by hand, and a VLM can be assigned to OCR explicitly.
 */
const OCR_RE = /\bocr\b|docling|deepseek-ocr|paddleocr|got-?ocr|dots\.?ocr/i;

/**
 * Non-generative, non-suggestable families. These ids are served on the same
 * OpenAI-compatible surface but can't fulfil any Omnesis capability —
 * text-to-speech, image/video/music generation, moderation/guard models, and
 * cross-encoder scoring models. Without this a probed backend floods the Agent
 * tab with `tts-1`, `dall-e-3`, `veo-*`, `lyria-*`, `*-moderation`, etc.
 * (everything that isn't embed/transcribe/ocr defaults to generative). They
 * classify to no role; the free-text box still allows a manual override if a
 * server reuses one of these tokens for a chat model.
 *
 * Cross-encoder scoring families are listed here — and matched before the
 * embedding families below — because a pair-scoring model produces a relevance
 * score, not a vector. A name like `bge-reranker-v2` carries the embed-family
 * token `bge`, so without this it would be suggested as an embedder and silently
 * yield meaningless embeddings.
 *
 * Media-generation tokens are matched on word boundaries and kept specific
 * (`veo`, `lyria`, `imagen`, `sora`) so a conversational model that merely
 * does audio I/O — e.g. `gpt-4o-audio-preview`, `gemini-*-native-audio` — keeps
 * its generative classification rather than being excluded.
 */
const NON_SUGGESTABLE_RE =
  /tts|text[-_]?to[-_]?speech|dall-?e|gpt-image|stable-diffusion|\bflux\b|\bveo\b|\blyria\b|\bimagen\b|\bsora\b|moderation|\bguard\b|rerank|cross[-_]?encoder|ms[-_]?marco/i;

/**
 * Classify a model id into the capability roles it can serve.
 *
 * Generative models serve every text-completion role: `agent`,
 * `privacy-reviewer`, `background-agent`, `watch-judge`,
 * `entailment-verifier`, and `brief-judge`. Those roles deliberately offer exactly the models the Agent
 * capability does; `embedder`, `transcriber`, and `ocr` are exclusive.
 * Non-suggestable families (TTS / image / moderation / cross-encoder scorers)
 * return an empty array — they fulfil no role and shouldn't be suggested
 * anywhere. An id that matches no known family defaults to generative — the
 * safe default, since most models are generative and a model with an unusual
 * name can still be typed into the right tab by hand.
 *
 * Order matters: the non-suggestable check runs before the embedding check so
 * a scoring model whose name also carries an embed-family token is excluded
 * rather than offered as an embedder.
 */
export function classifyModelRoles(modelId: string): CapabilityRole[] {
  if (TRANSCRIBE_RE.test(modelId)) return ["transcriber"];
  if (OCR_RE.test(modelId)) return ["ocr"];
  if (NON_SUGGESTABLE_RE.test(modelId)) return [];
  if (EMBED_RE.test(modelId)) return ["embedder"];
  return [
    "agent",
    "privacy-reviewer",
    "background-agent",
    "watch-judge",
    "entailment-verifier",
    "brief-judge",
  ];
}

/** Classify a list of model ids into an id → roles map. */
export function classifyModels(modelIds: readonly string[]): Record<string, CapabilityRole[]> {
  const out: Record<string, CapabilityRole[]> = {};
  for (const id of modelIds) out[id] = classifyModelRoles(id);
  return out;
}
