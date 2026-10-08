// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { html } from "htm/preact";
import { internalKnowledgeHref } from "./knowledge-claim-markdown.js";
import { KnowledgeIcon } from "../lib/knowledge-link-icons.js";

/** Subject identity comes from the canonical owner and person registry, never the claim text. */
export function KnowledgeSubjectContext({ node }) {
  if (!["person_annotation", "doc_annotation"].includes(node.kind)) return null;
  const subject = node.subjectRef;
  if (node.kind === "doc_annotation") {
    const available = subject?.kind === "source" && typeof subject.id === "string" && subject.id;
    return html`<div class="kn-subject-context">${available
      ? html`About <a href=${internalKnowledgeHref(`source:${subject.id}`)}><${KnowledgeIcon} kind="source" sourceId=${subject.sourceId} />${typeof subject.title === "string" && subject.title.trim() ? subject.title : "Untitled document"}</a>`
      : "Document unavailable"}</div>`;
  }
  const available = subject?.kind === "person" && typeof subject.id === "string" && subject.id;
  return html`<div class="kn-subject-context">${available
    ? html`About <a href=${`/portal/people/${encodeURIComponent(subject.id)}`}>${typeof subject.name === "string" && subject.name.trim() ? subject.name : "Unnamed person"}</a>`
    : "Person unavailable"}</div>`;
}
