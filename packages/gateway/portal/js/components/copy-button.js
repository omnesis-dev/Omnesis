// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useState } from "preact/hooks";

// The two glyphs a copy button toggles between: the clipboard (idle) and the
// checkmark (just-copied). Shared so every copy affordance in the portal shows
// the same icon.
const COPY_SVG = html`<svg
  width="14"
  height="14"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
>
  <rect x="9" y="9" width="13" height="13" rx="2" />
  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
</svg>`;

const CHECK_SVG = html`<svg
  width="14"
  height="14"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
>
  <path d="M20 6L9 17l-5-5" />
</svg>`;

/**
 * A copy-to-clipboard icon button with a transient "copied" state (checkmark
 * for 1.5s). The layout around it is the caller's — pass the `class` the view
 * styles (e.g. `copy-block-btn`, `creds-wizard-copy-btn`) so this stays a bare,
 * position-agnostic primitive shared across views.
 *
 * @param {object} props
 * @param {string} props.text - The text written to the clipboard.
 * @param {string} [props.class] - Class applied to the <button>.
 * @param {string} [props.title] - Tooltip / accessible label (default "Copy to clipboard").
 */
export function CopyIconButton({ text, class: className, title = "Copy to clipboard" }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access may be denied by browser policy. Leave the idle icon
      // in place so it never falsely reports success.
    }
  };

  return html`
    <button
      class=${className}
      onClick=${copy}
      title=${title}
      aria-label=${copied ? "Copied" : title}
    >
      ${copied ? CHECK_SVG : COPY_SVG}
    </button>
  `;
}
