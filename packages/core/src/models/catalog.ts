// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Bundled model catalog. The list lives in TypeScript (rather than a
 * separate JSON file) so the type system enforces every required field
 * at build time — a misnamed quant or a missing `embedDim` can't slip
 * through to a runtime "undefined.toLowerCase()" crash on the CLI.
 *
 * What goes in here:
 *  - License must be permissive (Apache-2.0, MIT, OpenRAIL with no
 *    field-of-use restrictions). Gated weights (Llama family) are
 *    deliberately omitted.
 *  - For GGUF entries: a known-good build that loads cleanly with the
 *    project's pinned `node-llama-cpp` version.
 *  - For Anthropic API entries: a small fallback used until live Models API
 *    discovery succeeds. The gateway's live catalog is authoritative once
 *    Anthropic returns the models available to the configured key.
 *
 * What does NOT go in here:
 *  - Sideloaded models the user dropped in manually (those still work
 *    via the manifest's `unverified` flag — see #21 for the planned
 *    HuggingFace browse flow that adds them to the picker).
 *  - Remote *embedding* providers (OpenAI, Cohere, Voyage). Embedding
 *    every chunk would mean uploading the entire personal corpus to a
 *    third party, which contradicts the local-first promise. A remote
 *    agent, which sees only what a turn retrieves, is a different deal.
 */

import type { CatalogEntry, ModelRole } from "./types.js";

const HF = (repo: string, file: string): string =>
  `https://huggingface.co/${repo}/resolve/main/${file}`;

export const CATALOG: readonly CatalogEntry[] = [
  // ── Embedding ────────────────────────────────────────────────────────
  {
    kind: "gguf",
    id: "nomic-embed-text-v1.5.Q8_0",
    name: "Nomic Embed Text v1.5 (Q8_0)",
    roles: ["embed"],
    author: "Nomic AI",
    license: "Apache-2.0",
    description:
      "768-dimensional general-purpose English text embedder. Strong default — fast on Apple Silicon Metal and well-tested with the indexer.",
    filename: "nomic-embed-text-v1.5.Q8_0.gguf",
    downloadUrl: HF("nomic-ai/nomic-embed-text-v1.5-GGUF", "nomic-embed-text-v1.5.Q8_0.gguf"),
    sizeBytes: 145_000_000,
    quant: "Q8_0",
    embedDim: 768,
    contextLength: 8192,
    params: "137M",
    recommendedRamGb: 1,
    minRamGb: 0.5,
    recommended: true,
  },
  {
    kind: "gguf",
    id: "bge-small-en-v1.5.Q8_0",
    name: "BGE Small EN v1.5 (Q8_0)",
    roles: ["embed"],
    author: "BAAI",
    license: "MIT",
    description:
      "384-dimensional, lighter and faster than Nomic — good fit for low-RAM machines at the cost of some retrieval quality.",
    filename: "bge-small-en-v1.5.Q8_0.gguf",
    downloadUrl: HF("CompendiumLabs/bge-small-en-v1.5-gguf", "bge-small-en-v1.5-q8_0.gguf"),
    sizeBytes: 36_000_000,
    quant: "Q8_0",
    embedDim: 384,
    contextLength: 512,
    params: "33M",
    recommendedRamGb: 0.5,
    minRamGb: 0.25,
  },
  {
    kind: "gguf",
    id: "bge-large-en-v1.5.Q8_0",
    name: "BGE Large EN v1.5 (Q8_0)",
    roles: ["embed"],
    author: "BAAI",
    license: "MIT",
    description:
      "1024-dimensional, higher retrieval quality at ~3× the file size and runtime cost of Nomic. Pick this on a fast M-series Mac when you want the best ranking.",
    filename: "bge-large-en-v1.5.Q8_0.gguf",
    downloadUrl: HF("CompendiumLabs/bge-large-en-v1.5-gguf", "bge-large-en-v1.5-q8_0.gguf"),
    sizeBytes: 348_000_000,
    quant: "Q8_0",
    embedDim: 1024,
    contextLength: 512,
    params: "335M",
    recommendedRamGb: 2,
    minRamGb: 1,
  },

  {
    kind: "gguf",
    id: "mxbai-embed-large-v1.Q8_0",
    name: "mxbai Embed Large v1 (Q8_0)",
    roles: ["embed"],
    author: "Mixedbread AI",
    license: "Apache-2.0",
    description:
      "1024-dimensional English embedder. Higher retrieval quality than Nomic and BGE-large on MTEB benchmarks at a similar parameter count.",
    filename: "mxbai-embed-large-v1.Q8_0.gguf",
    downloadUrl: HF("ChristianAzinn/mxbai-embed-large-v1-gguf", "mxbai-embed-large-v1.Q8_0.gguf"),
    sizeBytes: 358_000_000,
    quant: "Q8_0",
    embedDim: 1024,
    contextLength: 512,
    params: "335M",
    recommendedRamGb: 2,
    minRamGb: 1,
  },
  {
    kind: "gguf",
    id: "multilingual-e5-large-instruct.Q8_0",
    name: "Multilingual E5 Large Instruct (Q8_0)",
    roles: ["embed"],
    author: "Microsoft (intfloat)",
    license: "MIT",
    description:
      "1024-dimensional multilingual embedder covering 100+ languages. Best choice for corpora mixing English with other languages (French, German, Spanish, etc.).",
    filename: "multilingual-e5-large-instruct-q8_0.gguf",
    downloadUrl: HF(
      "Ralriki/multilingual-e5-large-instruct-GGUF",
      "multilingual-e5-large-instruct-q8_0.gguf",
    ),
    sizeBytes: 603_000_000,
    quant: "Q8_0",
    embedDim: 1024,
    contextLength: 512,
    params: "560M",
    recommendedRamGb: 2,
    minRamGb: 1,
  },
  {
    kind: "gguf",
    id: "qwen3-embedding-0.6b.Q8_0",
    name: "Qwen3 Embedding 0.6B (Q8_0)",
    roles: ["embed"],
    author: "Alibaba (Qwen team)",
    license: "Apache-2.0",
    description:
      "1024-dimensional multilingual embedder from the Qwen3 family. MTEB #1 multilingual. Supports 100+ languages and 32k context. Compact size with strong retrieval quality.",
    filename: "Qwen3-Embedding-0.6B-Q8_0.gguf",
    downloadUrl: HF("Qwen/Qwen3-Embedding-0.6B-GGUF", "Qwen3-Embedding-0.6B-Q8_0.gguf"),
    sizeBytes: 639_000_000,
    quant: "Q8_0",
    embedDim: 1024,
    contextLength: 32_768,
    params: "0.6B",
    recommendedRamGb: 2,
    minRamGb: 1,
  },
  {
    kind: "gguf",
    id: "qwen3-embedding-4b.Q8_0",
    name: "Qwen3 Embedding 4B (Q8_0)",
    roles: ["embed"],
    author: "Alibaba (Qwen team)",
    license: "Apache-2.0",
    description:
      "1024-dimensional multilingual embedder. Larger sibling of the 0.6B — higher retrieval quality at ~7× the file size. 100+ languages, 32k context.",
    filename: "Qwen3-Embedding-4B-Q8_0.gguf",
    downloadUrl: HF("Qwen/Qwen3-Embedding-4B-GGUF", "Qwen3-Embedding-4B-Q8_0.gguf"),
    sizeBytes: 4_280_000_000,
    quant: "Q8_0",
    embedDim: 1024,
    contextLength: 32_768,
    params: "4B",
    recommendedRamGb: 8,
    minRamGb: 6,
  },
  {
    kind: "gguf",
    id: "qwen3-embedding-8b.Q8_0",
    name: "Qwen3 Embedding 8B (Q8_0)",
    roles: ["embed"],
    author: "Alibaba (Qwen team)",
    license: "Apache-2.0",
    description:
      "1024-dimensional multilingual embedder. Top of the Qwen3 line — MTEB #1 multilingual (score 70.58). 100+ languages, 32k context. Needs significant RAM.",
    filename: "Qwen3-Embedding-8B-Q8_0.gguf",
    downloadUrl: HF("Qwen/Qwen3-Embedding-8B-GGUF", "Qwen3-Embedding-8B-Q8_0.gguf"),
    sizeBytes: 8_050_000_000,
    quant: "Q8_0",
    embedDim: 1024,
    contextLength: 32_768,
    params: "8B",
    recommendedRamGb: 12,
    minRamGb: 10,
  },

  {
    kind: "anthropic-api",
    id: "anthropic/claude-haiku-4-5-20251001",
    apiModelId: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5 (Anthropic API)",
    roles: ["agent"],
    author: "Anthropic",
    license: "Anthropic Commercial Terms",
    description:
      "Fast, low-cost Anthropic cloud model. Requires an Anthropic API key and permission for remote inference.",
  },
  {
    kind: "anthropic-api",
    id: "anthropic/claude-sonnet-4-6",
    apiModelId: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Anthropic API)",
    roles: ["agent"],
    author: "Anthropic",
    license: "Anthropic Commercial Terms",
    description:
      "Higher-quality Anthropic cloud model. Requires an Anthropic API key and permission for remote inference.",
  },

  // ── Speech-to-text (Whisper) ─────────────────────────────────────────
  // whisper.cpp GGML weights from the canonical ggerganov/whisper.cpp repo.
  // Multilingual (not the English-only `.en` variants) so voice notes in any
  // language transcribe correctly. Run locally via whisper.cpp — audio never
  // leaves the machine. The `gguf` kind reuses the shared download/manifest
  // path; the transcriber runtime is whisper.cpp, not node-llama-cpp.
  {
    kind: "gguf",
    id: "whisper-tiny",
    name: "Whisper Tiny (multilingual)",
    roles: ["transcribe"],
    author: "OpenAI (Whisper)",
    license: "MIT",
    description:
      "Smallest, fastest Whisper model. Lowest accuracy — fine for short, clear voice notes on low-RAM machines. 99 languages with auto-detect.",
    filename: "ggml-tiny.bin",
    downloadUrl: HF("ggerganov/whisper.cpp", "ggml-tiny.bin"),
    sizeBytes: 77_691_713,
    sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
    quant: "F16",
    params: "39M",
    recommendedRamGb: 1,
    minRamGb: 0.5,
  },
  {
    kind: "gguf",
    id: "whisper-base",
    name: "Whisper Base (multilingual)",
    roles: ["transcribe"],
    author: "OpenAI (Whisper)",
    license: "MIT",
    description:
      "A step up from Tiny — noticeably better on accents and background noise at a small size and runtime cost. 99 languages with auto-detect.",
    filename: "ggml-base.bin",
    downloadUrl: HF("ggerganov/whisper.cpp", "ggml-base.bin"),
    sizeBytes: 147_951_465,
    sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    quant: "F16",
    params: "74M",
    recommendedRamGb: 1,
    minRamGb: 0.5,
  },
  {
    kind: "gguf",
    id: "whisper-small",
    name: "Whisper Small (multilingual)",
    roles: ["transcribe"],
    author: "OpenAI (Whisper)",
    license: "MIT",
    description:
      "The accuracy/speed balance most people want — solid on names and jargon across 99 languages. Strong default for voice-note transcription.",
    filename: "ggml-small.bin",
    downloadUrl: HF("ggerganov/whisper.cpp", "ggml-small.bin"),
    sizeBytes: 487_601_967,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    quant: "F16",
    params: "244M",
    recommendedRamGb: 2,
    minRamGb: 1,
    recommended: true,
  },
  {
    kind: "gguf",
    id: "whisper-medium",
    name: "Whisper Medium (multilingual)",
    roles: ["transcribe"],
    author: "OpenAI (Whisper)",
    license: "MIT",
    description:
      "Higher accuracy than Small, especially on noisy or heavily-accented speech, at ~3× the size and runtime. Pick this when transcript quality matters more than speed.",
    filename: "ggml-medium.bin",
    downloadUrl: HF("ggerganov/whisper.cpp", "ggml-medium.bin"),
    sizeBytes: 1_533_763_059,
    sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
    quant: "F16",
    params: "769M",
    recommendedRamGb: 4,
    minRamGb: 2,
  },
  {
    kind: "gguf",
    id: "whisper-large-v3-turbo",
    name: "Whisper Large v3 Turbo (multilingual)",
    roles: ["transcribe"],
    author: "OpenAI (Whisper)",
    license: "MIT",
    description:
      "Near large-v3 accuracy at a fraction of the decoding cost — the best choice on a capable machine. 99 languages with auto-detect.",
    filename: "ggml-large-v3-turbo.bin",
    downloadUrl: HF("ggerganov/whisper.cpp", "ggml-large-v3-turbo.bin"),
    sizeBytes: 1_624_555_275,
    sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
    quant: "F16",
    params: "809M",
    recommendedRamGb: 4,
    minRamGb: 2,
  },
];

const BY_ID = new Map(CATALOG.map((e) => [e.id, e]));

/** Look up a catalog entry by id. Returns undefined for unknown ids. */
export function getCatalogEntry(id: string): CatalogEntry | undefined {
  return BY_ID.get(id);
}

/**
 * Look up the catalog entry whose GGUF filename matches `filename`.
 * Used by the InferenceRegistry to resolve a bare filename to a
 * catalog id when the user specifies a `.gguf` filename in config.
 */
export function getCatalogEntryByFilename(filename: string): CatalogEntry | undefined {
  for (const entry of CATALOG) {
    if (entry.kind === "gguf" && entry.filename === filename) return entry;
  }
  return undefined;
}

/** Catalog entries that can serve a given role, recommended first. */
export function catalogForRole(role: ModelRole): CatalogEntry[] {
  return CATALOG.filter((e) => e.roles.includes(role)).sort((a, b) => {
    if (!!a.recommended === !!b.recommended) return a.name.localeCompare(b.name);
    return a.recommended ? -1 : 1;
  });
}

/** The recommended default for a role, when one is marked. */
export function defaultForRole(role: ModelRole): CatalogEntry | undefined {
  return CATALOG.find((e) => e.roles.includes(role) && e.recommended);
}
