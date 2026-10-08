// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { html } from "htm/preact";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { internalKnowledgeHref, renderKnowledgeMarkdown } from "./knowledge-claim-markdown.js";
import { claimUsageGroups, useClaimUsage } from "./knowledge-claim-usage.js";
import { KnowledgeIcon, knowledgeReferenceMetadata } from "../lib/knowledge-link-icons.js";

import { bindClaimIndicatorTails } from "./knowledge-claim-layout.js";

const EMPTY_REFERENCES = {};

const label = (value) => String(value ?? "").replaceAll("_", " ");
const verificationLabel = (value) => ({
  verified: "Verified", unverified: "Not verified", rejected: "Not supported",
})[value] ?? label(value);

export function KnowledgeClaimReader({ node, references = EMPTY_REFERENCES, onClaim = () => {}, selectedClaim = null }) {
  const rendered = useMemo(
    () => renderKnowledgeMarkdown(node.markdown, node.claims, references),
    [node.markdown, node.claims, references],
  );
  const [preview, setPreview] = useState(null);
  const usage = useClaimUsage(node, Boolean(preview));
  const popup = useRef(null);
  const prose = useRef(null);
  useLayoutEffect(() => { if (prose.current) bindClaimIndicatorTails(prose.current); }, [rendered]);
  const timer = useRef(null);
  const currentPreview = useRef(null);
  const restoringFocus = useRef(false);
  currentPreview.current = preview;
  const tooltipId = useId();
  function keepOpen() { clearTimeout(timer.current); }
  function close() { keepOpen(); setPreview(null); }
  function leave() {
    keepOpen();
    timer.current = setTimeout(() => setPreview((current) =>
      current?.target.contains(document.activeElement) || popup.current?.contains(document.activeElement) ? current : null,
    ), 180);
  }
  useEffect(() => {
    close();
    const escape = (event) => {
      if (event.key !== "Escape" || !currentPreview.current) return;
      event.stopPropagation();
      if (popup.current?.contains(document.activeElement)) {
        restoringFocus.current = true;
        currentPreview.current.target.focus({ preventScroll: true });
        restoringFocus.current = false;
      }
      close();
    };
    const reposition = () => setPreview((current) => current ? { ...current } : null);
    const scroll = (event) => { if (!popup.current?.contains(event.target)) reposition(); };
    window.addEventListener("keydown", escape);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", scroll, true);
    return () => {
      keepOpen();
      window.removeEventListener("keydown", escape);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [rendered]);
  useLayoutEffect(() => {
    if (!preview || !popup.current) return;
    const element = popup.current;
    const anchor = preview.target.getBoundingClientRect();
    const width = element.offsetWidth, height = element.offsetHeight;
    const left = Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12));
    const below = anchor.bottom + 8;
    const top = below + height <= window.innerHeight - 12
      ? below : Math.max(12, anchor.top - height - 8);
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    const span = document.getElementById(`${preview.target.id}-span`);
    span?.classList.add("kn-claim-span--active");
    preview.target.setAttribute("aria-controls", tooltipId);
    preview.target.setAttribute("aria-haspopup", "dialog");
    preview.target.setAttribute("aria-expanded", "true");
    return () => {
      span?.classList.remove("kn-claim-span--active");
      preview.target.removeAttribute("aria-controls");
      preview.target.removeAttribute("aria-expanded");
    };
  }, [preview, tooltipId, usage]);
  function show(event) {
    if (restoringFocus.current) return;
    const target = event.target.closest(".kn-claim-indicator");
    const id = target && rendered.targets.get(target.id);
    const claim = node.claims?.find((entry) => entry.id === id);
    if (!claim) return;
    keepOpen();
    setPreview((current) => current?.target === target ? current : { target, claim });
  }
  function inspect(event) {
    if (event.type === "keydown" && !event.shiftKey && ["Tab", "ArrowDown"].includes(event.key) &&
      currentPreview.current?.target === event.target) {
      const link = popup.current?.querySelector("a");
      if (link) {
        event.preventDefault();
        link.focus();
        return;
      }
    }
    if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
    // Actual hyperlinks remain navigable; claim inspection never intercepts them.
    if (event.target.closest("a")) return;
    const target = event.target.closest(".kn-claim-indicator");
    const id = target && rendered.targets.get(target.id);
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    show(event);
    onClaim(id);
  }
  useEffect(() => {
    if (!selectedClaim) return;
    const entry = [...rendered.targets].find(([, id]) => id === selectedClaim);
    const target = entry && document.getElementById(entry[0]);
    const claim = node.claims?.find((item) => item.id === selectedClaim);
    if (target && claim) {
      target.scrollIntoView({ block: "nearest" });
      target.focus({ preventScroll: true });
      setPreview({ target, claim });
    }
  }, [selectedClaim, rendered]);
  const claim = preview?.claim;
  const usedBy = claimUsageGroups(usage.items, claim?.id);
  return html`<div class="kn-claim-reader">
    <div
      class="kn-prose"
      ref=${prose}
      onClick=${inspect}
      onKeyDown=${inspect}
      onMouseOver=${show}
      onMouseOut=${leave}
      onFocusIn=${show}
      onFocusOut=${leave}
      dangerouslySetInnerHTML=${{ __html: rendered.html }}
    />
    ${claim && html`<aside ref=${popup} id=${tooltipId} role="dialog" aria-label="Claim details" class="kn-claim-popover"
      onMouseEnter=${keepOpen} onMouseLeave=${leave} onFocusIn=${keepOpen} onFocusOut=${leave}>
      <div class="kn-claim-popover-heading"><strong>Claim ${claim.id}</strong>
        <span class="kn-badge">${verificationLabel(claim.verification)}</span>
      </div>
      ${node.validity === "stale" && html`<p class="kn-caption">Linked evidence changed; this page needs review.</p>`}
      <p class="kn-claim-popover-text">${claim.text}</p>
      <dl class="kn-facts">
        <dt>Type</dt><dd>${label(claim.modality ?? "observation")}</dd>
        <dt>Assessment</dt><dd>${label(claim.epistemicStatus ?? "asserted")}</dd>
        ${claim.attribution && html`<dt>Attributed to</dt><dd>${claim.attribution}</dd>`}
        ${claim.parentId && html`<dt>Within claim</dt><dd>${claim.parentId}</dd>`}
      </dl>
      <strong>References from this claim (${claim.refs?.length ?? 0})</strong>
      ${claim.refs?.length ? html`<ul class="kn-claim-popover-refs">${claim.refs.map((ref) => {
        const metadata = knowledgeReferenceMetadata(ref, references);
        const href = internalKnowledgeHref(ref);
        const title = html`<${KnowledgeIcon} reference=${ref} ...${metadata} />${metadata.title ?? ref}`;
        return html`<li key=${ref}>${href ? html`<a href=${href}>${title}</a>` : title}</li>`;
      })}</ul>`
        : html`<p class="kn-caption">No references from this claim.</p>`}
      <div class="kn-claim-usage">
        ${usage.loading && html`<p class="kn-caption">Loading where this claim is used…</p>`}
        ${usage.error && html`<p class="kn-caption">Usage could not be loaded. Open Connections to try again.</p>`}
        ${[["References to this claim", usedBy.claim], ["References to this page", usedBy.page]].map(([title, edges]) => edges.length > 0 && html`
          <strong>${title}</strong>
          <ul class="kn-claim-popover-refs">${edges.map((edge) => html`<li key=${edge.node.id}><a href=${`/portal/debug/cognition/knowledge/${encodeURIComponent(edge.node.id)}${edge.claimId ? `?claim=${encodeURIComponent(edge.claimId)}` : ""}`}><${KnowledgeIcon} ...${edge.node} />${edge.node.title || "Untitled record"}</a></li>`)}</ul>
        `)}
        ${usage.nextCursor && html`<p class="kn-caption">More connections are available in Connections.</p>`}
      </div>
    </aside>`}
  </div>`;
}
