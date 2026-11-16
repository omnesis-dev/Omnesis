// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Minimal ambient types for `snowball-stemmers` (a CommonJS package that ships
 * none). Only the surface the keyword analysis uses is declared.
 */
declare module "snowball-stemmers" {
  interface Stemmer {
    stem(word: string): string;
  }

  const snowball: {
    /** A stemmer for one Snowball algorithm, named in lower case (`russian`, `arabic`). */
    newStemmer(algorithm: string): Stemmer;
  };
  export = snowball;
}
