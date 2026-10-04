// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Vocabulary selection is recognizer-independent; this adapter owns runtime limits. */
export interface RankedTranscriptionVocabulary {
  entries: readonly { text: string; score: number }[];
}

export interface WhisperVocabularyHint {
  initial_prompt: string;
  no_context: true;
  n_max_text_ctx: number;
}

// Standard Whisper has a 448-token text context; whisper.cpp retains at most
// half of it as an initial prompt. Larger caller budgets cannot raise this cap.
export const WHISPER_MAX_PROMPT_TOKENS = 224;

/**
 * Pack complete, high-ranked phrases into a smart-whisper initial prompt.
 *
 * smart-whisper does not expose whisper_tokenize. Its bundled whisper.cpp
 * tokenizer emits one token per nonempty UTF-8 substring, so UTF-8 byte length
 * is a guaranteed upper bound on token count. This deliberately underfills the
 * token budget, particularly for non-Latin scripts, rather than truncating the
 * most relevant terms unpredictably inside the native runtime. Separators count
 * toward the same bound. No instructions or corpus prose are added.
 *
 * Only the known local binding is supported. Other runtimes must declare their
 * own capabilities before receiving private vocabulary.
 */
export function adaptTranscriptionVocabulary(
  vocabulary: RankedTranscriptionVocabulary,
  options: { runtime: string; maxPromptTokens?: number },
): WhisperVocabularyHint | undefined {
  if (options.runtime !== "smart-whisper") return undefined;
  const requested = options.maxPromptTokens ?? WHISPER_MAX_PROMPT_TOKENS;
  if (!Number.isFinite(requested) || requested < 1) return undefined;
  const budget = Math.min(Math.floor(requested), WHISPER_MAX_PROMPT_TOKENS);
  const candidates = vocabulary.entries
    .filter((entry) => Number.isFinite(entry.score) && entry.score > 0)
    .map((entry) => ({
      text: entry.text.normalize("NFC").replace(/\s+/gu, " ").trim(),
      score: entry.score,
    }))
    // C strings terminate at NUL; other control characters cannot be vocabulary.
    .filter((entry) => entry.text.length > 0 && !/[\p{Cc}\p{Cf}]/u.test(entry.text))
    .sort((a, b) => b.score - a.score || a.text.localeCompare(b.text));

  const seen = new Set<string>();
  let packed: { text: string; words: string[] }[] = [];
  let prompt = "";
  for (const { text } of candidates) {
    // Even replacing every packed component cannot make this phrase fit. This
    // also bounds the word matching below by the native prompt byte budget.
    if (Buffer.byteLength(text, "utf8") > budget) continue;
    const key = text.toLocaleLowerCase("und");
    if (seen.has(key)) continue;
    seen.add(key);
    const words = key.split(" ");
    // Whitespace words preserve hyphens, apostrophes and unsegmented scripts.
    // Only a phrase that actually fits can supply its components to Whisper.
    if (packed.some((phrase) => containsWords(phrase.words, words))) continue;

    // A later full spelling may replace its already-packed components, even
    // when they rank higher. It must fit alongside every unrelated hint; only
    // spare budget pays for the added words. Keep the first component's slot
    // so unrelated hints retain their order. Oversized upgrades change nothing.
    const covered = packed.map((phrase) => containsWords(words, phrase.words));
    const firstCovered = covered.indexOf(true);
    const nextPacked = packed.filter((_phrase, index) => !covered[index]);
    nextPacked.splice(firstCovered < 0 ? nextPacked.length : firstCovered, 0, { text, words });
    const next = nextPacked.map((phrase) => phrase.text).join(", ");
    if (Buffer.byteLength(next, "utf8") <= budget) {
      prompt = next;
      packed = nextPacked;
    }
  }
  if (!prompt) return undefined;
  return { initial_prompt: prompt, no_context: true, n_max_text_ctx: budget };
}

/** Exact contiguous whitespace words; never substrings or words joined across hints. */
function containsWords(phrase: readonly string[], words: readonly string[]): boolean {
  if (words.length > phrase.length) return false;
  return phrase.some(
    (_word, start) =>
      start + words.length <= phrase.length &&
      words.every((word, offset) => phrase[start + offset] === word),
  );
}
