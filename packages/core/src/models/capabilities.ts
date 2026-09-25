// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Capability interfaces — the contracts consumers depend on.
 *
 * Each interface defines what a capability provides, not how it's
 * implemented. The search pipeline imports `EmbedCapability`; the
 * indexer imports `EmbedCapability`; neither knows whether the
 * implementation is a local GGUF, an HTTP server, or a cloud API.
 *
 * Backend implementations (in-process, HTTP, Anthropic) fulfil one
 * or more of these interfaces. The InferenceRegistry resolves config
 * into concrete instances.
 */

export interface EmbedCapability {
  embed(texts: string[]): Promise<Float32Array[]>;
  embedQuery(query: string): Promise<Float32Array>;
  dispose(): Promise<void>;
}

/**
 * Single-shot text completion — prompt in, text out. The generic contract for
 * the non-conversational model calls Omnesis makes internally: the entailment
 * firewall's verdict pass and the token-identity classifier both drive a model
 * this way. Distinct from the agent contract, which is streaming and tool-aware.
 *
 * Implementations wrap a local GGUF, an OpenAI-compatible HTTP server, or the
 * Anthropic Messages API, so a caller never learns where inference runs.
 */
export interface CompleteCapability {
  readonly name: string;
  readonly modelId: string;
  complete(
    prompt: string,
    opts?: {
      maxTokens?: number;
      temperature?: number;
      stop?: readonly string[];
    },
  ): Promise<string>;
  /**
   * Like `complete`, but also returns the token usage the backend reported
   * (null when it reports none). Optional — HTTP-backed implementations
   * expose it for cost accounting; local GGUF providers, which have no
   * billable usage to report, omit it and callers fall back to `complete`.
   */
  completeWithUsage?(
    prompt: string,
    opts?: {
      maxTokens?: number;
      temperature?: number;
      stop?: readonly string[];
    },
  ): Promise<{ text: string; usage: { promptTokens: number; completionTokens: number } | null }>;
  dispose(): Promise<void>;
}

/**
 * Output of a speech-to-text transcription. `text` is the spoken content
 * as plain text (empty string when no speech was detected). `language`
 * and `durationSec` are best-effort metadata the backend surfaces when it
 * knows them — they ride along into the document so a downstream consumer
 * can flag a non-default language or a clipped clip without re-decoding.
 */
export interface TranscriptionResult {
  text: string;
  /** Detected language as an ISO-639-1 code (e.g. "en", "fr"), when known. */
  language?: string;
  /** Duration of the source audio in seconds, when known. */
  durationSec?: number;
}

/**
 * Speech-to-text. Takes raw audio bytes (any container/codec — the backend
 * owns decoding) plus the MIME type, and returns the transcript. Backends:
 * a local Whisper model (whisper.cpp), or a deterministic synthetic
 * transcriber for tests. Unlike the other capabilities this one consumes
 * binary input, so it is the single seam where audio enters the model layer.
 */
export interface TranscribeCapability {
  readonly name: string;
  readonly modelId: string;
  transcribe(
    audio: Uint8Array,
    mimeType: string,
    opts?: {
      /** ISO-639-1 hint to skip language auto-detection. */
      language?: string;
    },
  ): Promise<TranscriptionResult>;
  dispose(): Promise<void>;
}

/**
 * Output of an OCR pass over an image (or a rasterized PDF page). `text` is
 * the recognized text as plain text, reading-order joined with line breaks
 * (empty string when no text was found). `language` and `pages` are
 * best-effort metadata a backend surfaces when it knows them — `pages` counts
 * the rasterized PDF pages OCR'd, and rides into the document so a downstream
 * consumer can flag a non-default language or a multi-page scan.
 *
 * Note: per-region bounding boxes and per-region confidence are deliberately
 * NOT part of this contract. They are backend-specific (classical engines and
 * Apple Vision emit them; prompt-driven VLM backends generally do not), so the
 * shared seam carries only the text that every backend can produce.
 */
export interface OcrResult {
  text: string;
  /** Detected language as an ISO-639-1 code (e.g. "en", "fr"), when known. */
  language?: string;
  /** Number of pages in the rasterized PDF, when known. */
  pages?: number;
  /**
   * Per-page recognized text for a PDF, page-aligned (page N → index N-1).
   * Pages not OCR'd carry an empty string. Present only for PDF OCR; it lets a
   * caller interleave OCR'd image-only pages with the PDF's native text layer
   * page by page, rather than treating the whole document as one or the other.
   */
  pageTexts?: string[];
}

/**
 * Optical character recognition. Takes raw image bytes (or a PDF the backend
 * rasterizes itself) plus the MIME type, and returns the recognized text.
 * Backends: Apple Vision (macOS), a llama.cpp vision GGUF, an OpenAI-compatible
 * vision server (vLLM / llama-server), Tesseract, or a deterministic synthetic
 * recognizer for tests. Like transcription this consumes binary input, so it is
 * a seam where images enter the model layer; the bytes are never persisted.
 */
export interface OcrCapability {
  readonly name: string;
  readonly modelId: string;
  recognize(
    image: Uint8Array,
    mimeType: string,
    opts?: {
      /** ISO-639-1 hint to bias language-specific recognition. */
      language?: string;
    },
  ): Promise<OcrResult>;
  dispose(): Promise<void>;
}

/**
 * Verdict of an entailment check: does a quoted piece of evidence actually
 * establish a claim? `entailment` = the evidence supports the claim at its
 * stated modality; `neutral` = the evidence merely relates to the claim's
 * topic without establishing it; `contradiction` = the evidence undercuts it.
 * `probability` and `raw` are best-effort extras a backend surfaces when it
 * has them (a calibrated checker's score; the raw model output for audit).
 */
export interface EntailVerdict {
  label: "entailment" | "neutral" | "contradiction";
  probability?: number;
  raw?: string;
}

/**
 * Entailment verification — judges whether `evidence` (a verbatim source
 * quote) establishes `claim`. Backs the annotation write gate's entailment
 * firewall: a claim only persists as a memory prior when its cited quote
 * actually supports it. Implementations MUST throw (rather than guess a
 * verdict) when they cannot produce a judgement — callers treat a throw as
 * "verifier unavailable" and fail open, which is safer than a fabricated
 * verdict silently blocking or approving writes.
 */
export interface EntailCapability {
  verify(input: { claim: string; evidence: string }): Promise<EntailVerdict>;
  dispose(): Promise<void> | void;
}

export type CapabilityRole =
  | "embedder"
  | "agent"
  | "privacy-reviewer"
  | "transcriber"
  | "ocr"
  | "background-agent"
  | "watch-judge"
  | "entailment-verifier"
  | "brief-judge";

export const CAPABILITY_ROLES = [
  "embedder",
  "agent",
  "privacy-reviewer",
  "transcriber",
  "ocr",
  "background-agent",
  "watch-judge",
  "entailment-verifier",
  "brief-judge",
] as const;

/** Roles served by Codex turns. Embedding vectors and audio need other protocols. */
export const CODEX_SUPPORTED_ROLES: readonly CapabilityRole[] = [
  "agent",
  "privacy-reviewer",
  "background-agent",
  "watch-judge",
  "entailment-verifier",
  "brief-judge",
  "ocr",
];

/**
 * Presentation metadata for a capability — the title, plain-language
 * description, and a Lucide-style icon slug. Lives here (not in the portal)
 * so the gateway, the CLI, and the portal all read one source of truth for
 * "what is this capability for". The `icon` slug names a Lucide glyph the
 * portal maps to inline SVG; it is purely cosmetic and carries no behaviour.
 *
 * This is generic capability metadata, not source-specific knowledge — every
 * capability is provider-agnostic, so describing what an Embedder does belongs
 * with the capability definition, the same way `CAPABILITY_ROLES` does.
 */
export interface CapabilityMetadata {
  /** Stable role id. */
  readonly role: CapabilityRole;
  /** Human-readable title shown on the card and detail page. */
  readonly title: string;
  /** One- or two-sentence plain-language description of what it's for. */
  readonly description: string;
  /** Lucide icon slug (e.g. "binary", "sparkles"); the portal maps it to SVG. */
  readonly icon: string;
  /**
   * When true, the capability is plumbed through the system but not yet
   * surfaced as a card in the portal (e.g. a role whose implementation is
   * still planned). Consumers that render the capability grid skip it.
   */
  readonly hidden?: boolean;
  /**
   * When true, the capability only exists to serve an experimental feature
   * (e.g. the background agent behind Omnesis Briefs, or the annotation write
   * gate's entailment firewall). The gateway omits it from the capability grid
   * unless experimental mode is on, so an operator who never opted in is not
   * shown a model role they cannot use. See `experimentalVisible()`.
   */
  readonly experimental?: boolean;
  /**
   * Display grouping for the capability grid. `core` capabilities power the
   * always-on substrate — embedding for search, OCR and transcription during
   * ingest, the egress reviewer. `cognition` capabilities reason about what
   * the corpus means, whether a person asked for it (the interactive agent),
   * Brain decided on its own, or a Watch needs a bounded semantic verdict.
   * Clients render the two groups as separate sections.
   *
   * The line is not "uses a model" — embedding and OCR do. It is whether the
   * component reasons about what the user's records mean.
   */
  readonly section: "core" | "cognition";
}

/**
 * Ordered capability metadata. The portal renders one card per entry in this
 * order; new capabilities added to `CAPABILITY_ROLES` should get an entry here
 * (the TS `Record` type makes a missing entry a compile error).
 */
export const CAPABILITY_METADATA: Readonly<Record<CapabilityRole, CapabilityMetadata>> = {
  embedder: {
    role: "embedder",
    title: "Embedder",
    description:
      "Turns your documents into vectors so search can find things by meaning, not just exact words.",
    icon: "binary",
    section: "core",
  },
  // Interactive cognition: reasoning over the corpus in response to a person,
  // rather than a pipeline step. Grouped with the background cognition roles
  // for that reason, not with the always-on ingest/search capabilities.
  agent: {
    role: "agent",
    title: "Agent",
    description:
      "The conversational model that answers questions over your corpus via the portal and companion iOS or Android app. Also powers every step of Deep Research — the planner, the parallel readers, and the final cited report.",
    icon: "bot",
    section: "cognition",
  },
  "privacy-reviewer": {
    role: "privacy-reviewer",
    title: "Privacy reviewer",
    description:
      "Reviews answers before they leave the Omnesis sandbox and applies the operator's privacy policy without access to tools.",
    icon: "shield-check",
    section: "core",
  },
  transcriber: {
    role: "transcriber",
    title: "Transcriber",
    description: "Converts voice notes and audio into searchable text as sources sync.",
    icon: "mic",
    section: "core",
  },
  ocr: {
    role: "ocr",
    title: "OCR",
    description: "Reads text out of images and scanned PDFs so they become searchable.",
    icon: "scan-text",
    section: "core",
  },
  // Powers the Omnesis Briefs feature (experimental). Offers the same
  // chat-capable models as the Agent capability; deliberately never
  // auto-assigned — no model assigned means no proactive intelligence.
  "background-agent": {
    role: "background-agent",
    title: "Background agent",
    description:
      "The model for everything Omnesis does headlessly in the background: reacting to new data to maintain open loops and surface briefs, and the small judgement calls the people graph needs while matching contacts. Same model choices as the Agent capability.",
    icon: "bot",
    experimental: true,
    section: "cognition",
  },
  // The precision pass over a Watch nomination (experimental). It is separate
  // from the background agent so Watch does not silently inherit Brain's
  // provider or cost attribution. An operator may still assign both roles to
  // the same backend, whose external capacity and outages they would share.
  "watch-judge": {
    role: "watch-judge",
    title: "Watch judge",
    description:
      "Makes bounded semantic decisions for Watches whose conditions cannot be decided deterministically. Supports local GGUF, Anthropic, Codex, or OpenAI-compatible Chat Completions; Replay and Responses-only HTTP backends cannot serve this role.",
    icon: "scan-search",
    experimental: true,
    section: "cognition",
  },
  // The annotation write gate's entailment firewall (experimental). Never
  // auto-assigned — unset means the gate is silently absent and annotation
  // writes behave exactly as without it.
  "entailment-verifier": {
    role: "entailment-verifier",
    title: "Entailment verifier",
    description:
      "Checks that a memory claim is actually supported by its quoted evidence before it persists. A small, fast chat model works well; MiniCheck-family fact checkers (e.g. bespoke-minicheck served via an OpenAI-compatible server) are purpose-built for this — note bespoke-minicheck's weights are CC BY-NC (non-commercial), which suits personal installs.",
    icon: "shield-check",
    experimental: true,
    section: "cognition",
  },
  // The push bar over Omnesis Briefs (experimental). A dedicated role — not
  // the background agent — so its ship/no-ship pass runs on an independent
  // backend and never re-enters the background agent's own model mid-run.
  // Never auto-assigned — unset means briefs ship unjudged.
  "brief-judge": {
    role: "brief-judge",
    title: "Brief judge",
    description:
      "The push bar for Omnesis Briefs: a separate model pass that decides whether a candidate brief is worth interrupting you for — is it new, timely, consequential, and a real synthesis? Uses an independent model turn; Codex judges run separately from the background agent, even when both use the same model.",
    icon: "shield-check",
    experimental: true,
    section: "cognition",
  },
};
