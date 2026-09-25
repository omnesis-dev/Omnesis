// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * OSC 8 hyperlink emitter.
 *
 * Spec:
 *   ESC ] 8 ; ; URL  ST
 *   <visible text>
 *   ESC ] 8 ; ;      ST
 *
 * ST is `ESC \`. BEL works in most terminals too; ST is the spec form.
 *
 * Shipped gating is iTerm2-only today — see `capability.ts`; broadening to
 * Kitty / Ghostty / WezTerm / etc. is future work.
 */

import { hyperlinksSupported } from "./capability.js";

const ESC = "\x1b";
const ST = `${ESC}\\`;

export interface HyperlinkOptions {
  /**
   * Whether OSC 8 hyperlinks render in this terminal (pre-resolved).
   * Pass inside tight loops to skip re-sniffing env per call.
   */
  enabled?: boolean;
  /**
   * Fallback renderer when hyperlinks aren't supported. Default is
   * `${text} (${url})`. Pass a custom formatter if the surrounding
   * layout would be cluttered by the parenthesised URL (e.g. set
   * `fallback: (t) => t` to show just the text with no URL).
   */
  fallback?: (text: string, url: string) => string;
}

const defaultFallback = (text: string, url: string): string =>
  text === url ? text : `${text} (${url})`;

/**
 * Strip C0 control bytes (including ESC) and DEL. `text` and `url` reach here
 * from indexed third-party content (document titles, source URLs from emails /
 * web pages / files), so a raw `ESC]8;;…` embedded in either could forge or
 * prematurely terminate the OSC 8 sequence — a terminal-escape injection when
 * the user runs an interactive search. A legitimate single-line title or URL
 * never contains these bytes, so stripping them is lossless in practice.
 */
function stripControlChars(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, "");
}

/**
 * Wrap `text` in an OSC 8 escape that links to `url`. When the terminal doesn't
 * support hyperlinks, returns the plain fallback form. Control bytes are stripped
 * from both `text` and `url` first so untrusted content can't inject terminal
 * escape sequences; the caller is still responsible for URL-encoding if needed.
 */
export function hyperlink(text: string, url: string, opts: HyperlinkOptions = {}): string {
  const safeText = stripControlChars(text);
  const safeUrl = stripControlChars(url);
  const enabled = opts.enabled ?? hyperlinksSupported();
  if (!enabled) {
    return (opts.fallback ?? defaultFallback)(safeText, safeUrl);
  }
  return `${ESC}]8;;${safeUrl}${ST}${safeText}${ESC}]8;;${ST}`;
}
