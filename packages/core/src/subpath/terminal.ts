// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `@omnesis/core/terminal` — terminal-FX primitives (inline images,
 * OSC 8 hyperlinks). iTerm2-only; degrades to empty string / `text
 * (url)` fallback on unsupported terminals.
 *
 * The cli-shared package was created to break a cycle around terminal
 * FX — this subpath gives consumers a clean, narrow surface for
 * terminal-only concerns without re-exporting the whole core barrel.
 */

export {
  imagesSupported,
  hyperlinksSupported,
  inlineImage,
  hyperlink,
  type InlineImageOptions,
  type HyperlinkOptions,
} from "../terminal-fx/index.js";
