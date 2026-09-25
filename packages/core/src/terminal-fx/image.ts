// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Inline-image emitter for iTerm2.
 *
 * iTerm2's OSC 1337 inline-image sequence:
 *   ESC ] 1337 ; File = [args] : <base64-data> BEL
 *
 * Sizing: we target N cells wide × 1 cell tall so an icon fits next
 * to text in a status column without breaking row layout. iTerm2
 * scales the image preserving aspect ratio.
 *
 * Not implemented here but kept on the shelf:
 *   - Kitty graphics protocol (APC G).
 *   - tmux DCS passthrough wrapping.
 */

import { imagesSupported } from "./capability.js";

export interface InlineImageOptions {
  /** Width in terminal cells. Default 2. */
  widthCells?: number;
  /** Height in terminal cells. Default 1. */
  heightCells?: number;
  /**
   * Whether this terminal supports images (pre-detected). Pass to
   * avoid re-sniffing env on hot paths (e.g. inside a watch loop).
   * Defaults to per-call `imagesSupported()`.
   */
  enabled?: boolean;
}

const ESC = "\x1b";
const BEL = "\x07";

/**
 * Build the bytes that render a single inline image in iTerm2, or an
 * empty string when images aren't supported (piped output, non-iTerm2
 * terminal, inside tmux). Callers concatenate the result into normal
 * output — no terminal-state mutation, no conditional needed at the
 * call site.
 *
 * `base64` is the raw base64-encoded PNG (no `data:image/png;base64,`
 * prefix — strip that before calling).
 */
export function inlineImage(base64: string, opts: InlineImageOptions = {}): string {
  const enabled = opts.enabled ?? imagesSupported();
  if (!enabled) return "";

  const widthCells = opts.widthCells ?? 2;
  const heightCells = opts.heightCells ?? 1;

  // `inline=1` is required for iTerm2 to render the image immediately
  // rather than save it. `width=N` / `height=N` are in cells.
  // `preserveAspectRatio=1` keeps the icon un-squished if it's not
  // exactly N:1.
  const args = [
    "inline=1",
    `width=${widthCells}`,
    `height=${heightCells}`,
    "preserveAspectRatio=1",
  ].join(";");
  return `${ESC}]1337;File=${args}:${base64}${BEL}`;
}
