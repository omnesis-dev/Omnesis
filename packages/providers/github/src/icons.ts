// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceIcon } from "@omnesis/source-sdk";

/**
 * Hot-linked at runtime — GitHub's own favicon (the Octocat mark) on the
 * official github.com origin, served with permissive caching. See
 * `TRADEMARKS.md` for third-party mark usage notes.
 *
 * The SF Symbol is iOS's instant-render fallback: a branching glyph reads
 * "version control" at a glance. Colours follow GitHub's near-black mark
 * with a neutral dark wash for dark-mode surfaces.
 */
export const githubThreadsIcon: SourceIcon = {
  sfSymbol: "arrow.triangle.branch",
  color: "#8B949E",
  bgColor: "#21262D",
  url: "https://github.com/fluidicon.png",
};

export const githubCommitsIcon: SourceIcon = {
  sfSymbol: "point.3.connected.trianglepath.dotted",
  color: "#8B949E",
  bgColor: "#21262D",
  url: "https://github.com/fluidicon.png",
};
