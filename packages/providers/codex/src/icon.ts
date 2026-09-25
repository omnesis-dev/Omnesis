// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceIcon } from "@omnesis/source-sdk";

/**
 * The first-party icon served for OpenAI's verified Codex extension. The
 * source package owns the integration-specific choice; clients render the
 * descriptor generically. See TRADEMARKS.md for nominative-use attribution.
 */
export const codexIcon: SourceIcon = {
  sfSymbol: "terminal.fill",
  color: "#10A37F",
  bgColor: "#10251F",
  url: "https://openai.gallerycdn.vsassets.io/extensions/openai/chatgpt/26.5818.41705/1787379434402/Microsoft.VisualStudio.Services.Icons.Default",
};
