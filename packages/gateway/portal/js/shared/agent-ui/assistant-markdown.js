// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { render } from "preact";
import { useLayoutEffect, useMemo, useRef } from "preact/hooks";
import { renderMarkdown, renderCopyableMarkdown } from "./markdown.js";
import { CopyIconButton } from "./copy-button.js";

/** Sanitized Markdown with copy controls attached to trusted token targets. */
export function AssistantMarkdown({
  text,
  copyable = false,
  blockImages = false,
  plainValueFences = true,
  className = "agent-part-text",
}) {
  const root = useRef(null);
  const result = useMemo(
    () =>
      copyable || plainValueFences
        ? renderCopyableMarkdown(text, { plainValueFences, blockImages })
        : { html: renderMarkdown(text, { blockImages }), targets: [] },
    [text, copyable, plainValueFences, blockImages],
  );

  useLayoutEffect(() => {
    const hosts = [];
    for (const target of result.targets) {
      const code = root.current.querySelector(`#${target.id}`);
      if (!code) continue;
      const showCopy = copyable && target.closed;
      if (!showCopy && !target.plain) continue;
      const host = document.createElement("span");
      host.className =
        target.block && !target.plain ? "agent-value-copy-block" : "agent-value-copy-inline";
      // Keep buttons outside links so copying never also follows the link.
      const anchor = code.closest("a");
      if (anchor) anchor.after(host);
      else if (target.plain) {
        const block = document.createElement("div");
        block.className = "agent-value-text-block";
        // Keep the control after the last text line; copying retains all trailing LFs.
        block.textContent = target.text.replace(/\n+$/, "");
        code.parentElement.replaceWith(block);
        if (showCopy) block.append(host);
      } else if (target.block) {
        // Feedback lives outside the scrolling pre so its message is never clipped.
        const pre = code.parentElement;
        const block = document.createElement("div");
        block.className = "agent-value-code-block";
        pre.before(block);
        block.append(pre, host);
      } else code.after(host);
      if (!showCopy) continue;
      render(
        html`<${CopyIconButton}
          text=${target.text}
          class="agent-value-copy-btn"
          label=${`Copy ${target.block ? "text block" : "value"}: ${target.text.replace(/\s+/g, " ").slice(0, 80)}`}
        />`,
        host,
      );
      hosts.push(host);
    }
    return () => {
      for (const host of hosts) {
        render(null, host);
        host.remove();
      }
    };
  }, [result]);

  return html`<div
    ref=${root}
    class=${className}
    dangerouslySetInnerHTML=${{ __html: result.html }}
  />`;
}
