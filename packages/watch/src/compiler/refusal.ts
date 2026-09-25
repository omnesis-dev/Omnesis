// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a refusal may say to whoever asked.
 *
 * A refusal has two audiences and they are not owed the same thing. The
 * **operator** owns the corpus, so the model's own words are theirs to read —
 * "there is no source here that carries parcel tracking" is the sentence that
 * turns a dead end into a better request. An **off-host integration** is on the
 * other side of the privacy boundary: since the compiler reads the corpus while
 * it works, its free text can quote what it read, and a 422 is not a place
 * corpus content may travel. No reviewer sees it and no ledger records it.
 *
 * So the reply grammar asks for both: `reasons` in the model's own words, and
 * `codes` from the closed set below. The codes are the disclosable channel —
 * they describe the shape of the *request*, and there is no sentence in them a
 * corpus could get into. Anything outside the set is dropped rather than
 * repaired, because a filter that tried to sanitise free text would be a guess,
 * and a guess is what the unenforced "they describe the request, not the
 * corpus" comment already was.
 *
 * Each code is also chosen not to answer a question about the corpus. A caller
 * that could submit conditions and read back "there is nobody by that name
 * here" would have an oracle; every code below is true or false about the
 * request alone.
 *
 * That rule is what keeps a source the install runs and a source it has never
 * heard of behind one code, even though the operator's next move differs
 * completely between them. A code saying "that one is connected" would be a
 * genuine improvement for the asker and a fingerprint of the install for
 * anyone who asked it once per known source type — and the caller receives
 * these codes through an operational `subscriptions:manage` credential that
 * cannot read the corpus. Every surface carrying a `sourceId` is read-gated.
 * So the distinction lives where it costs nothing: in the validator's
 * diagnostic and in the refusal's `reasons`, both of which stay on this
 * machine.
 *
 * That closes the codes, not the endpoint. **Whether** a request compiles is
 * still a corpus-dependent bit — a compiler holding retrieval tools can decline
 * a condition about somebody this corpus has never heard of and accept the same
 * condition about somebody it has, and 201-versus-422 says so without any code
 * being read. The same shape as the grounding rejection this vocabulary is
 * modelled on, which hides *which* refusal but not *that* it refused. Narrowing
 * it needs a decision about the create endpoint itself rather than about what a
 * refusal may say: see #1812.
 *
 * The code set itself lives in `@omnesis/types`, which has no dependencies and
 * is therefore the one place every runtime that has to agree on it can reach.
 * What stays here is this file's own half: the operator-facing sentences, and
 * the filter that decides which of a model's claimed codes may travel.
 *
 * Four consumers restate the set rather than importing it: the integration
 * HTTP client, published as a plugin whose dependency footprint is
 * deliberately free of Omnesis packages; the two Hermes adapters, which are
 * Python; and `integrations/README.md`, which is prose. `agent-integration`'s
 * `refusal-vocabulary.test.ts` reads all four and reddens if any of their key
 * sets drift from the declaration.
 */

import { MODEL_REFUSAL_CODES, REFUSAL_CODES, type RefusalCode } from "@omnesis/types";

export { MODEL_REFUSAL_CODES, REFUSAL_CODES, type RefusalCode };

/**
 * The operator's sentence for each code.
 *
 * Fixed text, never derived from a model's words: the model's own account of a
 * refusal is what {@link disclosableCodes} exists to keep off the wire, and a
 * sentence assembled from it would put it back.
 */
const SENTENCES: Record<RefusalCode, string> = {
  unsupported_condition: "That condition cannot be expressed as a watch on this install.",
  not_a_condition:
    "That request does not describe something that happens, so nothing can watch for it.",
  ambiguous_request: "That request has more than one reasonable reading; say which one is meant.",
  compiler_failed: "The compiler did not produce a valid watch. Asking again may work.",
};

const CHOOSABLE: ReadonlySet<string> = new Set<string>(MODEL_REFUSAL_CODES);

/**
 * The codes safe to hand back, from whatever the model said.
 *
 * Filtered against what a model may *choose*, not against every code that
 * exists: `compiler_failed` tells the caller to try again, and a model that
 * emitted it for a considered refusal would send an agent round that loop
 * forever. Unknown entries are dropped, order and first occurrence are kept,
 * and an empty result becomes `unsupported_condition` — a model that answered
 * in prose has still refused, and the caller is owed the fact of it even when
 * the grammar was not followed.
 */
export function disclosableCodes(raw: readonly unknown[] | undefined): RefusalCode[] {
  const seen = new Set<RefusalCode>();
  for (const value of raw ?? []) {
    if (typeof value === "string" && CHOOSABLE.has(value)) seen.add(value as RefusalCode);
  }
  return seen.size === 0 ? ["unsupported_condition"] : [...seen];
}

/** The fixed sentence a code stands for. Never derived from a model's words. */
export function refusalSentence(code: RefusalCode): string {
  return SENTENCES[code];
}
