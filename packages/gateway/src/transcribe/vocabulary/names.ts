// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isCommonVocabularyWord } from "./common-words.js";

/** Names stay lexical hints, never addresses, markup, or display annotations. */
export function cleanVocabularyName(input: string): string | null {
  if (input.length > 80 || /[\r\n\t]/u.test(input)) return null;
  const name = input
    .normalize("NFC")
    .split(/\s+\|\s+/u)[0]
    .replace(/\([^()]*\)|\[[^[\]]*\]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (
    name.length < 3 ||
    !/^[\p{L}\p{M}]+(?:[ '’.-][\p{L}\p{M}]+)*$/u.test(name) ||
    /(?:https?|www)\b/iu.test(name) ||
    /\p{L}\.\p{L}/u.test(name) ||
    /^(?:you|self|me|unknown)$/iu.test(name) ||
    isCommonVocabularyWord(name)
  )
    return null;
  return name;
}
