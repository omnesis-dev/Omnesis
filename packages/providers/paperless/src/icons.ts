// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceIcon } from "@omnesis/source-sdk";

/**
 * Hot-linked at runtime — the Paperless-ngx app icon (the leaf mark) from the
 * project's own repository. See `TRADEMARKS.md` for usage notes.
 *
 * The SF Symbol is iOS's instant-render fallback: a stack of paper reads an
 * archive of scanned documents at a glance. Colours match the project's
 * green; bg is a dimmed wash of the same hue for dark-mode surfaces.
 */
export const paperlessIcon: SourceIcon = {
  sfSymbol: "doc.on.doc",
  color: "#17541F",
  bgColor: "#0E2A12",
  url: "https://raw.githubusercontent.com/paperless-ngx/paperless-ngx/main/src-ui/src/apple-touch-icon.png",
};
