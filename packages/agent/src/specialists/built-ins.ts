// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The v1 built-in specialists (#748): `research-planner`, `history-sweep`,
 * `source-digest`, `citation-verifier`.
 *
 * Each is a `defineSpecialist({...})` descriptor — a system prompt, a model
 * role, and a read-only default tool allowlist selected by Deep Research.
 *
 * Tool names referenced in the allowlists are the read tools from the tool
 * registry (`search_many`, `fetch_many`, `trace_connections`, `run_sql`,
 * `annotate`, `lookup_people`, `lookup_document_by_url`). Write tools are never
 * listed — they're stripped downstream regardless (`selectSubagentTools`).
 *
 * None of these prompts or examples are seeded from any real corpus (frozen
 * privacy constraint): the illustrative topics are invented.
 */

import { defineSpecialist, type SpecialistDescriptor } from "./define-specialist.js";

/**
 * `research-planner` — decompose a broad research question into a small set of
 * focused, parallelisable sub-tasks for the Deep Research loop (#748).
 *
 * The Deep Research orchestrator runs this specialist FIRST: it emits a fenced
 * ```json block of `{ specialist, title, task }` entries naming which built-in reader
 * (history-sweep / source-digest) should chase which slice of the question. The
 * orchestrator parses that block deterministically and fans the readers out in
 * parallel. The planner does NOT read the corpus itself — it only plans — so it
 * carries no read tools.
 */
export const researchPlannerSpecialist: SpecialistDescriptor = defineSpecialist({
  name: "research-planner",
  modelRole: "agent",
  systemPrompt:
    "You are the research-planner specialist. You do not read the corpus — you " +
    "only plan. Given the research question in your brief, decompose it into 2 to " +
    "4 focused sub-tasks that can run in parallel, each handled by ONE reader " +
    "specialist: use 'history-sweep' for a broad time-window sweep of a topic, or " +
    "'source-digest' for catching up on a single named source. Reply with ONLY a " +
    "fenced JSON code block — no prose before or after — of the form:\n" +
    "```json\n" +
    '[{"specialist":"history-sweep","title":"<short outcome>","task":"<self-contained brief>"}, ' +
    '{"specialist":"source-digest","title":"<short outcome>","task":"<self-contained brief>"}]\n' +
    "```\n" +
    "Each task brief must be fully self-contained (the reader cannot see the " +
    "research question or this plan). Give each a short human-facing title that " +
    "states the outcome, not the full brief. Keep the list short — over-decomposition " +
    "wastes tokens. Do not ask follow-up questions.",
  defaultTools: [],
});

/**
 * `history-sweep` — sweep the corpus over a time window for everything touching
 * a topic, and return a compact chronological digest with citations. A
 * read-only fan-out reader; runs on the Agent model, like every research step.
 */
export const historySweepSpecialist: SpecialistDescriptor = defineSpecialist({
  name: "history-sweep",
  modelRole: "agent",
  systemPrompt:
    "You are the history-sweep specialist. You have one self-contained task: " +
    "sweep the corpus over the given time window for everything relevant to the " +
    "topic in your brief. Search broadly, then fetch the documents that matter; " +
    "iterate until coverage is good. Reply with a SHORT chronological digest — " +
    "dated bullet points, oldest first, each one sentence — followed by a brief " +
    "synthesis of how things evolved. Cite every document you relied on with the " +
    "annotate_many tool, including a short note on every annotation stating the point " +
    "that document supports. Stop retrieving once the branch is settled, then immediately " +
    "return the compact digest; do not narrate your process or keep exploring after the " +
    "evidence is sufficient. Do not speculate beyond what the documents show, and do not " +
    "ask follow-up questions — you cannot see the parent conversation.",
  defaultTools: ["search_many", "fetch_many", "trace_connections", "annotate_many"],
});

/**
 * `source-digest` — summarise one source's recent documents into a tight
 * briefing with citations. A read-only fan-out reader; the Deep Research loop
 * will fan several of these out (one per source) in a later iteration.
 */
export const sourceDigestSpecialist: SpecialistDescriptor = defineSpecialist({
  name: "source-digest",
  modelRole: "agent",
  systemPrompt:
    "You are the source-digest specialist. You have one self-contained task: " +
    "produce a concise briefing of the recent documents from the source named in " +
    "your brief, scoped to any time window the brief gives. Use the source " +
    "filter on search to stay within that source; fetch the documents that " +
    "matter. Stop retrieving once the branch is settled. Cite every document you relied on " +
    "with annotate_many, including a short note on every annotation stating the point it " +
    "supports, then immediately reply with a short briefing: the few themes that recur, each as a " +
    "one-line bullet, then any standout item. Do not narrate your process or keep exploring " +
    "after the evidence is sufficient. Read the source's display name and unit noun from " +
    "the metadata the tools return — never assume a source's identity. Do not " +
    "ask follow-up questions — you cannot see the parent conversation.",
  defaultTools: ["search_many", "fetch_many", "annotate_many"],
});

/**
 * `citation-verifier` — re-check that quotes attributed to documents actually
 * appear in them (string match), and report any mismatches. The trust feature,
 * first cut. Read-only; the work is mechanical (fetch + compare).
 */
export const citationVerifierSpecialist: SpecialistDescriptor = defineSpecialist({
  name: "citation-verifier",
  modelRole: "agent",
  systemPrompt:
    "You are the citation-verifier specialist. You have one self-contained task: " +
    "for each (document id, quoted text) pair in your brief, fetch the document " +
    "with the fetch_many tool and check — by exact text match, ignoring only " +
    "whitespace and letter case — whether the quoted text actually appears in the " +
    "document body. Reply with a verdict per quote: VERIFIED when the quote " +
    "appears, MISMATCH when it does not (quote it back and note that it was not " +
    "found). Be strict: a reworded or paraphrased line is a MISMATCH, not a " +
    "verification. End with an overall verdict (all verified / N mismatches). Do " +
    "not ask follow-up questions — you cannot see the parent conversation.",
  defaultTools: ["fetch_many", "search_many"],
});

/** The v1 built-in specialists, in registration order. */
export const BUILTIN_SPECIALISTS: ReadonlyArray<SpecialistDescriptor> = [
  researchPlannerSpecialist,
  historySweepSpecialist,
  sourceDigestSpecialist,
  citationVerifierSpecialist,
];
