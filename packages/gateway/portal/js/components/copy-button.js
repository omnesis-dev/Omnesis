// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { CopyIconButton } from "../shared/agent-ui/copy-button.js";

export * from "../shared/agent-ui/copy-button.js";

/**
 * A copyable command or payload: the text in a <pre>, with the copy button in
 * its top-right corner. Use it for anything the user pastes into a terminal or
 * another app — a pairing command, an install line, a raw QR payload.
 *
 * @param {object} props
 * @param {string} props.text - The text shown and copied.
 * @param {string} [props.title] - Tooltip for the button.
 */
export function CopyBlock({ text, title }) {
  return html`
    <div class="copy-block">
      <pre class="copy-block-code">${text}</pre>
      <${CopyIconButton} text=${text} class="copy-block-btn" title=${title} />
    </div>
  `;
}

/**
 * A copyable inline value — a pairing code, a login code, a URL to type
 * elsewhere — with the copy button right after it. `children` renders the
 * value in the caller's styling; without them the value is plain inline code.
 *
 * @param {object} props
 * @param {string} props.text - The text copied.
 * @param {string} [props.title] - Tooltip for the button.
 * @param {any} [props.children] - How the value is displayed.
 */
export function CopyValue({ text, title, children }) {
  return html`
    <span class="copy-value">
      ${children ?? html`<code>${text}</code>`}
      <${CopyIconButton} text=${text} class="copy-value-btn" title=${title} />
    </span>
  `;
}
