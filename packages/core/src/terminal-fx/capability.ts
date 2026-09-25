// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Terminal-capability detection — iTerm2 only.
 *
 * The shipped surface intentionally targets iTerm2 and nothing else:
 * that's what the author uses and can test. Earlier drafts supported
 * Kitty / Ghostty / WezTerm and tmux passthrough; both were removed
 * because they couldn't be verified on the author's setup.
 *
 * Detection is env-based — no runtime CSI queries, no stdin poke.
 * Every mainstream CLI does the same (gh, lazygit, glow's termenv).
 */

function isITerm2(env: NodeJS.ProcessEnv): boolean {
  // LC_TERMINAL survives SSH when the client is configured with
  // `SendEnv LC_*`, so it's a useful second signal.
  return env.TERM_PROGRAM === "iTerm.app" || env.LC_TERMINAL === "iTerm2";
}

/**
 * Whether this terminal can render inline images. Returns false when:
 *   - stdout isn't a TTY (piped / redirected output must stay clean);
 *   - we're inside tmux (TMUX env var set);
 *   - the outer terminal isn't iTerm2.
 */
export function imagesSupported(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = process.stdout.isTTY === true,
): boolean {
  if (!isTTY) return false;
  if (env.TMUX) return false;
  return isITerm2(env);
}

/**
 * Whether OSC 8 hyperlinks will render as clickable links. Same gating
 * as images today (iTerm2-only) — the code could theoretically light
 * up on every terminal that supports OSC 8, but we haven't broadened
 * the test matrix yet.
 */
export function hyperlinksSupported(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = process.stdout.isTTY === true,
): boolean {
  if (!isTTY) return false;
  if (env.TMUX) return false;
  return isITerm2(env);
}
