// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { jsonHighlightParts } from "../shared/agent-ui/json-highlight.js";

/** Token children only: the caller owns the block or inline layout. */
export function JsonCode({ text }) {
  return jsonHighlightParts(text).map(({ text, className }) => className
    ? html`<span class=${className}>${text}</span>`
    : text);
}
