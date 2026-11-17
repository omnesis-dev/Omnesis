// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { AssistantMarkdown } from "./agent/assistant-markdown.js";

/** Source-owned setup prose; code spans are exact values to copy elsewhere. */
export function SetupMarkdown({ text, className = "" }) {
  return html`<${AssistantMarkdown}
    text=${text}
    copyable=${true}
    blockImages=${true}
    plainValueFences=${false}
    linkCodeUrls=${true}
    className=${`setup-markdown ${className}`}
  />`;
}
