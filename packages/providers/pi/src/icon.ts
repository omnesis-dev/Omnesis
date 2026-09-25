// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceIcon } from "@omnesis/source-sdk";

/**
 * Pi's first-party square mark, served by pi.dev. The source package owns the
 * integration-specific choice; clients render the descriptor generically.
 * See TRADEMARKS.md for nominative-use attribution.
 */
export const piIcon: SourceIcon = {
  sfSymbol: "terminal.fill",
  color: "#FFFFFF",
  bgColor: "#09090B",
  url: "https://pi.dev/favicon.svg",
};
