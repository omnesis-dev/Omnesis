// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { shellQuote } from "./service/hardened-bootstrap.js";

/** Quote a displayed command argument for PowerShell on Windows or a POSIX shell. */
export function quoteCommandArgument(
  word: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return shellQuote(word);
  return /^[A-Za-z0-9_./:=%+-]+$/.test(word)
    ? word
    : `'${word.replace(/['‘’]/gu, (quote) => quote + quote)}'`;
}
