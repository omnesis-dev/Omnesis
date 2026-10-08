// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { html } from "htm/preact";
import { KnowledgeIcon } from "../lib/knowledge-link-icons.js";
import { internalKnowledgeHref } from "./knowledge-claim-markdown.js";

export function DecisionSubject({ subject }) {
  if (!subject) return html`<span class="cognition-dim">Subject unavailable</span>`;
  const ref = `${["source", "loop", "brief"].includes(subject.kind) ? subject.kind : "wiki"}:${subject.id}`;
  return html`<a href=${internalKnowledgeHref(ref)}><${KnowledgeIcon} kind=${subject.kind} sourceId=${subject.sourceId} />${subject.title || "Untitled"}</a>`;
}

