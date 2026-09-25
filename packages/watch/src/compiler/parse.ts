// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Reading a model's reply.
 *
 * The reply is asked for as one fenced JSON block holding either a compilation
 * or a refusal. Three things can come back, and the difference between them
 * matters to the evaluation more than it matters to the compiler: a watch, an
 * honest refusal, and a reply that is neither. The third is a *result*, not an
 * exception — "the model did not emit parseable JSON" is one of the failure
 * classes worth counting, and swallowing it into a retry would hide how often
 * it happens.
 *
 * Parsing is deliberately forgiving about the wrapper and strict about the
 * content. A model that writes a sentence before its code block has still
 * answered; a model that returns a JSON object with no `decision` has not.
 */

export type ParsedReply =
  | { readonly kind: "watch"; readonly watch: unknown }
  | {
      readonly kind: "refusal";
      /**
       * The model's own words, bounded and stripped of control characters.
       *
       * The grammar asks for reasons about the request, but this is free text
       * from a reader that has the corpus open, so nothing here may be handed
       * to a caller outside this machine. {@link RefusalCode} is that channel.
       */
      readonly reasons: readonly string[];
      /**
       * The refusal's closed-vocabulary codes, exactly as the model wrote them.
       *
       * Unvalidated on purpose: `disclosableCodes` is the one place that
       * decides what a caller sees, so a second filter here would be a second
       * policy. A model that ignored the grammar leaves this empty.
       */
      readonly codes: readonly string[];
    }
  | { readonly kind: "unparseable"; readonly detail: string };

/**
 * The fenced blocks in a reply, in order, without their fences.
 *
 * The opening fence's tag is matched narrowly, and the run of whitespace before
 * the newline is spaces and tabs rather than `\s`: `\s` can match the newline
 * itself, which makes the two halves ambiguous and gives the engine a split
 * point to try for every whitespace character it sees.
 */
function fencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const fence = /```(?:json|jsonc)?[ \t]*\n([\s\S]*?)```/g;
  for (let match = fence.exec(text); match !== null; match = fence.exec(text)) {
    blocks.push(match[1]!);
  }
  return blocks;
}

/**
 * How many reasons a refusal may carry, and how long each may be.
 *
 * Bounded because the destination is a log file. A refusal's reasons are the
 * one part of a reply that is kept as prose rather than parsed into a
 * structure, and the model writing them has the corpus open — so an unbounded
 * array is a way to fill a size-rotated log with whatever a document asked for,
 * pushing the evidence of that out the other end.
 */
const MAX_REASONS = 8;
const MAX_REASON_LENGTH = 500;

/**
 * One reason, made safe to put in a line-oriented log.
 *
 * Control characters become spaces — a newline in the middle of a reason
 * otherwise forges a complete, well-formed log line, and the text is written by
 * a reader that a planted document can steer. Sanitised here, at the parse
 * boundary, rather than at each sink: this is the one place a model's prose
 * enters the compiler, and every consumer downstream — the log, the admin
 * route, the agent's tool result — inherits the guarantee.
 */
// eslint-disable-next-line no-control-regex -- matching them is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

function oneLine(value: unknown): string {
  return String(value).replace(CONTROL_CHARACTERS, " ").slice(0, MAX_REASON_LENGTH);
}

/** A parsed object carrying a `decision`, or null if this text is not one. */
function asAnswer(text: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return "decision" in value ? (value as Record<string, unknown>) : null;
}

/**
 * The reply's answer.
 *
 * The **last block that reads as an answer** wins, not simply the last block. A
 * model that reasons in the open shows a draft before the thing it settled on,
 * so later beats earlier; but it may equally follow its answer with a snippet
 * of shell or a note in a fence of its own, and taking the trailer would throw
 * the answer away. A reply with no fenced answer at all is tried whole, because
 * "reply with JSON" is sometimes taken literally.
 */
export function parseReply(text: string): ParsedReply {
  const blocks = fencedBlocks(text);
  const answer =
    [...blocks]
      .reverse()
      .map(asAnswer)
      .find((value) => value !== null) ?? asAnswer(text);

  if (!answer) {
    // Nothing that reads as an answer. Say which of the two ways it failed, so
    // the model is told to add a fence or to fix its JSON, and not both.
    const candidate = blocks.at(-1) ?? text;
    try {
      const value: unknown = JSON.parse(candidate);
      return typeof value !== "object" || value === null || Array.isArray(value)
        ? { kind: "unparseable", detail: "the JSON is not an object" }
        : { kind: "unparseable", detail: "the object has no 'decision'" };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        kind: "unparseable",
        detail:
          blocks.length === 0
            ? "no fenced JSON block, and the reply itself is not JSON"
            : `the last fenced block is not JSON: ${reason}`,
      };
    }
  }

  const decision = answer.decision;
  if (decision === "compile") {
    if (answer.watch === undefined) {
      return { kind: "unparseable", detail: "decision is 'compile' but there is no 'watch'" };
    }
    return { kind: "watch", watch: answer.watch };
  }
  if (decision === "refuse") {
    const reasons = answer.reasons;
    if (!Array.isArray(reasons) || reasons.length === 0) {
      return { kind: "unparseable", detail: "decision is 'refuse' but no reasons were given" };
    }
    // A missing or malformed `codes` is not an unparseable reply. The model has
    // refused, and the refusal is the answer; `disclosableCodes` falls back to
    // the general code so the caller is told, rather than being handed a repair
    // loop over a reply that already said no.
    const codes = answer.codes;
    return {
      kind: "refusal",
      reasons: reasons.slice(0, MAX_REASONS).map(oneLine),
      codes: Array.isArray(codes) ? codes.map(String) : [],
    };
  }

  return {
    kind: "unparseable",
    detail: `'decision' must be 'compile' or 'refuse', got ${JSON.stringify(decision)}`,
  };
}
