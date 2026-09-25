// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Terminal effects — inline images + clickable hyperlinks in the CLI.
 *
 * Shipped surface: **iTerm2 only**. Detection returns false for every
 * other terminal (including piped output and tmux).
 *
 * Every function returns a string that can be concatenated into normal
 * output. On unsupported terminals the functions return the graceful
 * fallback (empty string for images, `text (url)` for hyperlinks) so
 * callers don't need conditional branches at every call site.
 */

export { imagesSupported, hyperlinksSupported } from "./capability.js";

export { inlineImage, type InlineImageOptions } from "./image.js";

export { hyperlink, type HyperlinkOptions } from "./link.js";
