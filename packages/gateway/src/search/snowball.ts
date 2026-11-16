// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Snowball stemmers, typed. The package is CommonJS and ships no type
 * declarations, so it is loaded through `require` and given its types here,
 * where every project that compiles this file sees them. knip does not follow
 * a `require` made this way, so `knip.json` lists the package as used.
 */

import { createRequire } from "node:module";

export interface Stemmer {
  stem(word: string): string;
}

const snowball = createRequire(import.meta.url)("snowball-stemmers") as {
  newStemmer(algorithm: string): Stemmer;
};

/** A stemmer for one Snowball algorithm, named in lower case (`russian`, `arabic`). */
export const newStemmer = snowball.newStemmer;
