// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceIcon } from "@omnesis/source-sdk";

/**
 * Claude's first-party app icon, served by claude.ai. The source package owns
 * the integration-specific choice; clients render the descriptor generically.
 * See TRADEMARKS.md for nominative-use attribution.
 */
export const claudeCodeIcon: SourceIcon = {
  sfSymbol: "terminal.fill",
  color: "#D97757",
  bgColor: "#2A1B17",
  url: "https://claude.ai/images/claude_app_icon.png",
};
