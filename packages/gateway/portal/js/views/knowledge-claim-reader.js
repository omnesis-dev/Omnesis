// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { html } from "htm/preact";
import { useMemo } from "preact/hooks";
import { renderKnowledgeMarkdown } from "./knowledge-claim-markdown.js";

export function KnowledgeClaimReader({ node, references = {}, onClaim = () => {} }) {
  const rendered = useMemo(
    () => renderKnowledgeMarkdown(node.markdown, node.claims, references),
    [node.markdown, node.claims, references],
  );
  function inspect(event) {
    if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
    // Actual hyperlinks remain navigable; claim inspection never intercepts them.
    if (event.target.closest("a")) return;
    const target = event.target.closest(".kn-claim-span");
    const id = target && rendered.targets.get(target.id);
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    onClaim(id);
  }
  return html`<div class="kn-claim-reader">
    <p class="kn-caption kn-claim-hint">
      Underlined passages are claims. Select one to inspect it in Connections.
    </p>
    <div
      class="kn-prose"
      onClick=${inspect}
      onKeyDown=${inspect}
      dangerouslySetInnerHTML=${{ __html: rendered.html }}
    />
  </div>`;
}
