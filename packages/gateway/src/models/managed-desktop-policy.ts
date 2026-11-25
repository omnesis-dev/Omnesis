// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export const DESKTOP_CLAUDE_CODE_UNAVAILABLE =
  "Claude Code is unavailable in the desktop app until its login has independent filesystem and Keychain protection. Use an Anthropic API key instead.";

/** Fixed by the application's scoped child environment; ordinary headless installs do not opt in. */
export function isManagedDesktopRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMNESIS_DESKTOP_MANAGED === "1";
}
