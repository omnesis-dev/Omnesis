// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { html } from "htm/preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { renderKnowledgeMarkdown } from "./knowledge-claim-markdown.js";

export function KnowledgeClaimReader({ node, names, referenceHref, Badge }) {
  const requestedClaim = () =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("claim");
  const [selected, setSelected] = useState(requestedClaim);
  useEffect(() => setSelected(requestedClaim()), [node.id]);
  const rendered = useMemo(
    () => renderKnowledgeMarkdown(node.markdown, node.claims),
    [node.markdown, node.claims],
  );
  const claim = node.claims.find((item) => item.id === selected);
  function inspect(event) {
    if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
    // Actual hyperlinks remain navigable; claim inspection never intercepts them.
    if (event.target.closest("a")) return;
    const target = event.target.closest(".kn-claim-span");
    const id = target && rendered.targets.get(target.id);
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    setSelected(id);
  }
  return html`<div class="kn-claim-reader">
    <p class="kn-caption kn-claim-hint">
      Underlined passages are claims. Select one to inspect its evidence.
    </p>
    <div
      class="kn-prose"
      onClick=${inspect}
      onKeyDown=${inspect}
      dangerouslySetInnerHTML=${{ __html: rendered.html }}
    />
    ${claim &&
    html`<aside class="kn-claim-inspector" aria-label="Selected claim" aria-live="polite">
      <div class="kn-evidence-meta">
        <strong>Claim evidence</strong
        ><button type="button" class="kn-button" onClick=${() => setSelected(null)}>Close</button>
      </div>
      <p class="kn-claim-text">${claim.text}</p>
      <p>
        <${Badge} value=${claim.verification} /> ${claim.epistemicStatus !== "asserted" &&
        html`<${Badge} value=${claim.epistemicStatus} />`}
      </p>
      <p class="kn-caption">
        ${claim.modality ?? "observation"}${claim.attribution
          ? ` · Attributed to ${claim.attribution}`
          : ""}
      </p>
      ${(claim.refs ?? []).length
        ? html`<ul class="kn-claim-sources">
            ${claim.refs.map((ref) => {
              const href = referenceHref(ref);
              const dependency = (node.dependencies ?? []).find(
                (item) => item.claimId === claim.id && item.ref === ref,
              );
              return html`<li>
                ${href
                  ? html`<a href=${href}
                      >${names[ref] ??
                      (ref.startsWith("source:") ? "Source document" : "Related page")}</a
                    >`
                  : "Reference unavailable"}<span>${dependency?.relation ?? "supports"}</span>
              </li>`;
            })}
          </ul>`
        : html`<p>No supporting references recorded.</p>`}
      ${(claim.parentId || node.claims.some((item) => item.parentId === claim.id)) &&
      html`<div class="kn-claim-family">
        <span>Nested claims</span>${node.claims
          .filter((item) => item.id === claim.parentId || item.parentId === claim.id)
          .map(
            (item) =>
              html`<button class="kn-button" type="button" onClick=${() => setSelected(item.id)}>
                ${item.id === claim.parentId
                  ? "Inspect enclosing claim"
                  : `Inspect nested claim ${node.claims.indexOf(item) + 1}`}
              </button>`,
          )}
      </div>`}
    </aside>`}
  </div>`;
}
