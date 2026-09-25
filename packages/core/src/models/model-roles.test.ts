// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { classifyModelRoles, classifyModels } from "./model-roles.js";

const GENERATIVE_ROLES = [
  "agent",
  "privacy-reviewer",
  "background-agent",
  "watch-judge",
  "entailment-verifier",
  "brief-judge",
];

describe("classifyModelRoles", () => {
  it("classifies embedding models as embedder only", () => {
    for (const id of [
      "text-embedding-3-small",
      "text-embedding-3-large",
      "text-embedding-004",
      "mistral-embed",
      "Qwen/Qwen3-Embedding-0.6B",
      "nomic-embed-text-v1.5",
      "mxbai-embed-large",
      "BAAI/bge-large-en-v1.5",
      "thenlper/gte-base",
      "intfloat/e5-large-v2",
      "intfloat/multilingual-e5-large-instruct",
      "togethercomputer/m2-bert-80M-8k-retrieval",
      "WhereIsAI/UAE-Large-V1",
    ]) {
      expect(classifyModelRoles(id), id).toEqual(["embedder"]);
    }
  });

  it("classifies non-suggestable families (TTS / image / moderation) as no role", () => {
    for (const id of [
      "tts-1",
      "gpt-4o-mini-tts",
      "playai-tts",
      "dall-e-3",
      "gpt-image-1",
      "chatgpt-image-latest",
      "stable-diffusion-xl",
      "omni-moderation-latest",
      "meta-llama/Llama-Guard-3-8B",
    ]) {
      expect(classifyModelRoles(id), id).toEqual([]);
    }
  });

  it("classifies image/video/music-generation families as no role (#706)", () => {
    for (const id of [
      "models/veo-3.1-fast-generate-preview",
      "models/lyria-realtime-exp",
      "imagen-4.0-generate-001",
      "sora-2",
      "sora-2-pro",
    ]) {
      expect(classifyModelRoles(id), id).toEqual([]);
    }
  });

  it("keeps conversational audio-I/O models generative (not excluded as media-gen) (#706)", () => {
    for (const id of [
      "gpt-4o-audio-preview",
      "gpt-audio",
      "gemini-2.5-flash-native-audio-latest",
    ]) {
      expect(classifyModelRoles(id), id).toEqual(GENERATIVE_ROLES);
    }
  });

  it("suggests cross-encoder scoring models for no role at all", () => {
    // A pair-scoring model emits a relevance score, not a vector or a
    // completion, so it fulfils no Omnesis capability.
    for (const id of [
      "bge-reranker-v2-m3",
      "mxbai-rerank-large-v1",
      "jina-reranker-v2-base",
      "cross-encoder/ms-marco-MiniLM-L-6-v2",
    ]) {
      expect(classifyModelRoles(id), id).toEqual([]);
    }
  });

  it("excludes a cross-encoder whose name also carries an embed-family token", () => {
    // "bge-reranker" contains the embed-family token "bge". Without the
    // exclusion running first it would be offered as an embedder and would
    // silently produce meaningless vectors.
    expect(classifyModelRoles("bge-reranker-base")).toEqual([]);
  });

  it("classifies speech-to-text model ids as transcriber only", () => {
    // These are HTTP-backend model ids; local catalog models get their roles
    // from the catalog, not this name heuristic.
    for (const id of [
      "whisper-1",
      "Systran/faster-whisper-large-v3",
      "openai/whisper-large-v3-turbo",
      "stt-model",
      "speech-to-text",
    ]) {
      expect(classifyModelRoles(id), id).toEqual(["transcriber"]);
    }
  });

  it("classifies dedicated OCR model ids as ocr only", () => {
    for (const id of [
      "dots.ocr",
      "deepseek-ocr",
      "PaddlePaddle/PaddleOCR-VL",
      "got-ocr2.0",
      "ibm-granite/granite-docling-258M",
      "my-ocr-model",
    ]) {
      expect(classifyModelRoles(id), id).toEqual(["ocr"]);
    }
  });

  it("does not steal general vision-language models from the generative tabs", () => {
    // A VLM that isn't named as an OCR specialist stays generative — it can
    // still be assigned to OCR by hand.
    for (const id of ["Qwen/Qwen3-VL-8B-Instruct", "minicpm-v-2.6"]) {
      expect(classifyModelRoles(id), id).toEqual(GENERATIVE_ROLES);
    }
  });

  it("classifies generative models for every text-completion capability", () => {
    for (const id of [
      "gpt-4o",
      "gpt-4.1-mini",
      "o3-mini",
      "Qwen/Qwen3-8B",
      "llama-3.3-70b-versatile",
      "gemini-2.5-flash",
      "mistral-large-latest",
      "deepseek-chat",
    ]) {
      expect(classifyModelRoles(id), id).toEqual(GENERATIVE_ROLES);
    }
  });

  it("defaults unknown ids to generative (safe default)", () => {
    expect(classifyModelRoles("some-unknown-model-x")).toEqual(GENERATIVE_ROLES);
    expect(classifyModelRoles("")).toEqual(GENERATIVE_ROLES);
  });

  it("classifyModels builds an id → roles map", () => {
    expect(classifyModels(["gpt-4o", "text-embedding-3-small"])).toEqual({
      "gpt-4o": GENERATIVE_ROLES,
      "text-embedding-3-small": ["embedder"],
    });
  });

  it("background-agent picker parity: a model serves it iff it serves agent", () => {
    // The background agent (the Briefs feature) deliberately offers exactly
    // the models the Agent capability offers — never more, never fewer.
    const ids = [
      "gpt-4o",
      "deepseek-chat",
      "text-embedding-3-small",
      "whisper-1",
      "bge-reranker-v2-m3",
      "dots.ocr",
      "tts-1",
      "some-unknown-model-x",
    ];
    for (const id of ids) {
      const roles = classifyModelRoles(id);
      expect(roles.includes("background-agent"), id).toBe(roles.includes("agent"));
    }
  });

  it("privacy-reviewer picker parity: a model serves it iff it serves agent", () => {
    const ids = [
      "gpt-4o",
      "deepseek-chat",
      "text-embedding-3-small",
      "whisper-1",
      "bge-reranker-v2-m3",
      "dots.ocr",
      "tts-1",
      "some-unknown-model-x",
    ];
    for (const id of ids) {
      const roles = classifyModelRoles(id);
      expect(roles.includes("privacy-reviewer"), id).toBe(roles.includes("agent"));
    }
  });

  it("watch-judge picker parity: a completion model serves it iff it serves agent", () => {
    for (const id of [
      "gpt-4o",
      "deepseek-chat",
      "text-embedding-3-small",
      "whisper-1",
      "bge-reranker-v2-m3",
      "dots.ocr",
      "tts-1",
      "some-unknown-model-x",
    ]) {
      const roles = classifyModelRoles(id);
      expect(roles.includes("watch-judge"), id).toBe(roles.includes("agent"));
    }
  });
});
