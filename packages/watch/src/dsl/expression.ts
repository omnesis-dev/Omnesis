// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The restricted expression language used inside `output_map` values, key
 * extractor maps, and `fire_when` predicates.
 *
 * It is deliberately tiny. Everything it can say is statically checkable
 * against the ontology and the upstream nodes' declared outputs — that is the
 * whole point of having a DSL rather than letting the compiler emit code.
 *
 * The five reference namespaces:
 *
 * | Form                       | Means                                             |
 * | -------------------------- | ------------------------------------------------- |
 * | `$e.<path>`                | this source node's own journal event payload      |
 * | `$n.<node>.<component>`    | an upstream node's declared output                |
 * | `$key.<component>`         | this node's own key                               |
 * | `$const.<name>`            | a compile-time resolved constant                  |
 * | `$judge.<field>`           | the embedded semantic-match judge's output        |
 *
 * Two shapes that are not `$`-prefixed:
 *
 * - `.field` — a field of *the edge's own* arriving payload. Only legal inside
 *   a key extractor map, where the edge is what the map is attached to.
 * - `field` — a field of the node's own native output. For a SQL node that is a
 *   result column; that is why `{"avg_hr": "avg_hr"}` reads the way it does.
 *
 * String literals are single-quoted (`'b3f2a9d4-…'`). A bare token is never a
 * literal — an unquoted identifier always references something, so a typo is a
 * diagnostic rather than a silently-constant value.
 */

import { BOOLEAN, NUMBER, STRING, type ValueType } from "./value-type.js";

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

/** A step through a structured event payload. */
export type PathSegment =
  | { readonly kind: "field"; readonly name: string }
  /** `people[role=sender]` — pick the element whose `field` equals `value`. */
  | { readonly kind: "filter"; readonly field: string; readonly value: string };

/** What of an upstream node is being read. */
type NodeComponent =
  | { readonly kind: "field"; readonly name: string }
  | { readonly kind: "key"; readonly component: string }
  /** `$fired_by` — which branch(es) of an OR / N-of-M actually fired. */
  | { readonly kind: "fired_by" };

export type Expression =
  | { readonly kind: "call"; readonly fn: string; readonly args: readonly Expression[] }
  | { readonly kind: "event"; readonly path: readonly PathSegment[] }
  | { readonly kind: "node"; readonly node: string; readonly component: NodeComponent }
  | { readonly kind: "key"; readonly component: string }
  | { readonly kind: "const"; readonly name: string }
  | { readonly kind: "judge"; readonly field: string }
  | { readonly kind: "edge"; readonly path: readonly string[] }
  | { readonly kind: "native"; readonly path: readonly string[] }
  | {
      readonly kind: "literal";
      readonly value: string | number | boolean | null;
      readonly type: ValueType;
    };

type ComparisonOperator = "==" | "!=" | ">" | ">=" | "<" | "<=";

/** A `fire_when` predicate over the node's own typed output. */
export type Predicate =
  | { readonly kind: "and"; readonly operands: readonly Predicate[] }
  | { readonly kind: "or"; readonly operands: readonly Predicate[] }
  | { readonly kind: "not"; readonly operand: Predicate }
  | {
      readonly kind: "comparison";
      readonly left: Expression;
      readonly op: ComparisonOperator;
      readonly right: Expression;
    }
  /** A bare truthiness test — `fire_when: "decision AND …"`. */
  | { readonly kind: "truthy"; readonly operand: Expression };

interface ParseFailure {
  readonly message: string;
  /** Character offset into the source text, for a caret in the diagnostic. */
  readonly offset: number;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ParseFailure };

/** What the DSL knows about one extractor function, beyond its name. */
export interface ExtractorSignature {
  readonly minArity: number;
  readonly maxArity: number;
  /**
   * Whether the call yields one of its arguments unchanged.
   *
   * This is what tells a caller reasoning about a value's *provenance* whether
   * the result is still the thing that went in. `coalesce` picks a branch and
   * hands it back, so a coalesce over document ids is a document id — which is
   * how a join's "which arm brought this document" chip is derived. A function
   * that computes something new is not that, however document-typed its
   * arguments were: `date_trunc` over a document id produces an instant, or a
   * null, and never a document.
   *
   * Declared here rather than by each consumer, because a consumer's own list
   * silently misclassifies every function added after it was written — and the
   * failure is invisible, since the wrong answer is a plausible-looking value
   * rather than an error.
   */
  readonly passesThrough: boolean;
}

/**
 * The units `date_trunc` truncates to, in the spelling the runtime matches.
 *
 * Named here rather than only in the evaluator so the validator can reject a
 * unit the runtime would not recognise. Without that, `date_trunc('week', …)`
 * is a clean watch that silently evaluates to null forever — the worst shape a
 * mistake can take, because the watch goes on running and reports nothing.
 */
export const DATE_TRUNC_UNITS = ["year", "month", "day", "hour", "minute"] as const;

/** The extractor functions the runtime implements. Grown from observed need. */
export const EXTRACTOR_FUNCTIONS: Record<string, ExtractorSignature> = {
  date_trunc: { minArity: 2, maxArity: 2, passesThrough: false },
  // A watch merging more than sixteen branches has a shape problem the arity
  // cap should surface rather than silently accept.
  coalesce: { minArity: 2, maxArity: 16, passesThrough: true },
};

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenKind = "ident" | "dollar" | "number" | "string" | "punct" | "end";

interface Token {
  kind: TokenKind;
  text: string;
  offset: number;
}

const PUNCT = new Set(["(", ")", ",", ".", "[", "]", "=", "!", "<", ">", "-"]);

function tokenize(input: string): ParseResult<Token[]> {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      if (end === -1) {
        return fail("unterminated string literal", i);
      }
      tokens.push({ kind: "string", text: input.slice(i + 1, end), offset: i });
      i = end + 1;
      continue;
    }

    if (ch === "$") {
      const match = /^\$[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(i));
      if (!match) return fail("'$' must be followed by a namespace name", i);
      tokens.push({ kind: "dollar", text: match[0], offset: i });
      i += match[0].length;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      const match = /^\d+(\.\d+)?/.exec(input.slice(i))!;
      tokens.push({ kind: "number", text: match[0], offset: i });
      i += match[0].length;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(i))!;
      tokens.push({ kind: "ident", text: match[0], offset: i });
      i += match[0].length;
      continue;
    }

    if (PUNCT.has(ch)) {
      // Two-character comparison operators.
      const two = input.slice(i, i + 2);
      if (two === "==" || two === "!=" || two === ">=" || two === "<=") {
        tokens.push({ kind: "punct", text: two, offset: i });
        i += 2;
        continue;
      }
      tokens.push({ kind: "punct", text: ch, offset: i });
      i++;
      continue;
    }

    return fail(`unexpected character '${ch}'`, i);
  }

  tokens.push({ kind: "end", text: "", offset: input.length });
  return { ok: true, value: tokens };
}

function fail<T>(message: string, offset: number): ParseResult<T> {
  return { ok: false, error: { message, offset } };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * How deep `NOT`/parenthesis nesting may go before the parser gives up. These
 * documents are written by a model, so a pathological nesting depth is a real
 * input, and a recursive-descent parser that meets one blows the stack instead
 * of returning a diagnostic. No hand-written predicate comes close to this.
 */
const MAX_PREDICATE_DEPTH = 64;

class Parser {
  private pos = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  peek(): Token {
    return this.tokens[this.pos]!;
  }

  next(): Token {
    return this.tokens[this.pos++]!;
  }

  at(text: string): boolean {
    const token = this.peek();
    return token.kind !== "end" && token.text === text;
  }

  atKeyword(word: string): boolean {
    const token = this.peek();
    return token.kind === "ident" && token.text.toUpperCase() === word;
  }

  expect(text: string): ParseFailure | null {
    if (!this.at(text)) {
      return { message: `expected '${text}'`, offset: this.peek().offset };
    }
    this.pos++;
    return null;
  }

  atEnd(): boolean {
    return this.peek().kind === "end";
  }
}

/**
 * Parse an `output_map` value or a key-extractor value. The grammar is the same
 * in both places; whether a given form makes sense there — `.field` only means
 * something on a key map, whose edge supplies the payload — is a question for
 * the validator, which knows the surrounding context and can say so with a JSON
 * path attached.
 */
export function parseExpression(input: string): ParseResult<Expression> {
  const tokens = tokenize(input);
  if (!tokens.ok) return tokens;

  const parser = new Parser(tokens.value);
  const expr = parseExpr(parser);
  if (!expr.ok) return expr;

  if (!parser.atEnd()) {
    return fail(`unexpected trailing input`, parser.peek().offset);
  }
  return expr;
}

function parseExpr(p: Parser): ParseResult<Expression> {
  const token = p.peek();

  if (token.kind === "string") {
    p.next();
    return { ok: true, value: { kind: "literal", value: token.text, type: STRING } };
  }

  if (token.kind === "number") {
    p.next();
    return { ok: true, value: { kind: "literal", value: Number(token.text), type: NUMBER } };
  }

  // A leading minus signs the number that follows it. There is no arithmetic in
  // this grammar, so this is the only place `-` can appear.
  if (token.kind === "punct" && token.text === "-") {
    p.next();
    const magnitude = p.peek();
    if (magnitude.kind !== "number") {
      return fail("expected a number after '-'", magnitude.offset);
    }
    p.next();
    return { ok: true, value: { kind: "literal", value: -Number(magnitude.text), type: NUMBER } };
  }

  if (token.kind === "dollar") {
    return parseReference(p);
  }

  if (token.kind === "punct" && token.text === ".") {
    return parseEdgeField(p);
  }

  if (token.kind === "ident") {
    const lowered = token.text.toLowerCase();
    if (lowered === "true" || lowered === "false") {
      p.next();
      return { ok: true, value: { kind: "literal", value: lowered === "true", type: BOOLEAN } };
    }
    if (lowered === "null") {
      p.next();
      return { ok: true, value: { kind: "literal", value: null, type: { kind: "unknown" } } };
    }

    p.next();
    if (p.at("(")) return parseCallArguments(p, token.text);

    // A dotted bare path is a field of this node's own native output.
    const path = [token.text];
    while (p.at(".")) {
      p.next();
      const part = p.next();
      if (part.kind !== "ident") {
        return fail("expected a field name after '.'", part.offset);
      }
      path.push(part.text);
    }
    return { ok: true, value: { kind: "native", path } };
  }

  return fail("expected an expression", token.offset);
}

function parseCallArguments(p: Parser, fn: string): ParseResult<Expression> {
  const open = p.expect("(");
  if (open) return { ok: false, error: open };

  const args: Expression[] = [];
  if (!p.at(")")) {
    for (;;) {
      const arg = parseExpr(p);
      if (!arg.ok) return arg;
      args.push(arg.value);
      if (!p.at(",")) break;
      p.next();
    }
  }

  const close = p.expect(")");
  if (close) return { ok: false, error: close };

  return { ok: true, value: { kind: "call", fn, args } };
}

function parseEdgeField(p: Parser): ParseResult<Expression> {
  const path: string[] = [];
  while (p.at(".")) {
    p.next();
    const part = p.next();
    if (part.kind !== "ident") {
      return fail("expected a field name after '.'", part.offset);
    }
    path.push(part.text);
  }
  return { ok: true, value: { kind: "edge", path } };
}

function parseReference(p: Parser): ParseResult<Expression> {
  const token = p.next();

  switch (token.text) {
    case "$e":
      return parseEventPath(p);
    case "$n":
      return parseNodeRef(p);
    case "$key": {
      const component = parseDotName(p, "a key component name");
      if (!component.ok) return component;
      return { ok: true, value: { kind: "key", component: component.value } };
    }
    case "$const": {
      const name = parseDotName(p, "a constant name");
      if (!name.ok) return name;
      return { ok: true, value: { kind: "const", name: name.value } };
    }
    case "$judge": {
      const field = parseDotName(p, "a judge output field");
      if (!field.ok) return field;
      return { ok: true, value: { kind: "judge", field: field.value } };
    }
    default:
      return fail(
        `unknown reference namespace '${token.text}' (expected $e, $n, $key, $const or $judge)`,
        token.offset,
      );
  }
}

function parseDotName(p: Parser, what: string): ParseResult<string> {
  const dot = p.expect(".");
  if (dot) return { ok: false, error: dot };
  const name = p.next();
  if (name.kind !== "ident") {
    return fail(`expected ${what}`, name.offset);
  }
  return { ok: true, value: name.text };
}

function parseEventPath(p: Parser): ParseResult<Expression> {
  const path: PathSegment[] = [];

  for (;;) {
    if (p.at(".")) {
      p.next();
      const name = p.next();
      if (name.kind !== "ident") {
        return fail("expected a field name after '.'", name.offset);
      }
      path.push({ kind: "field", name: name.text });
      continue;
    }

    if (p.at("[")) {
      const open = p.next();
      const field = p.next();
      if (field.kind !== "ident") {
        return fail("expected a field name inside '[...]'", field.offset);
      }
      const eq = p.expect("=");
      if (eq) return { ok: false, error: eq };
      const value = p.next();
      if (value.kind !== "ident" && value.kind !== "string") {
        return fail("expected a value inside '[...]'", value.offset);
      }
      const close = p.expect("]");
      if (close) return { ok: false, error: close };
      if (path.length === 0) {
        return fail("'[...]' must follow a field name", open.offset);
      }
      path.push({ kind: "filter", field: field.text, value: value.text });
      continue;
    }

    break;
  }

  if (path.length === 0) {
    return fail("'$e' must be followed by a field path", p.peek().offset);
  }
  return { ok: true, value: { kind: "event", path } };
}

function parseNodeRef(p: Parser): ParseResult<Expression> {
  const node = parseDotName(p, "an upstream node id");
  if (!node.ok) return node;

  const dot = p.expect(".");
  if (dot) return { ok: false, error: dot };

  const token = p.next();
  if (token.kind === "dollar") {
    if (token.text === "$fired_by") {
      return {
        ok: true,
        value: { kind: "node", node: node.value, component: { kind: "fired_by" } },
      };
    }
    if (token.text === "$key") {
      const component = parseDotName(p, "a key component name");
      if (!component.ok) return component;
      return {
        ok: true,
        value: {
          kind: "node",
          node: node.value,
          component: { kind: "key", component: component.value },
        },
      };
    }
    return fail(
      `unknown node component '${token.text}' (expected $key or $fired_by)`,
      token.offset,
    );
  }

  if (token.kind !== "ident") {
    return fail("expected an output field name", token.offset);
  }
  return {
    ok: true,
    value: { kind: "node", node: node.value, component: { kind: "field", name: token.text } },
  };
}

// ---------------------------------------------------------------------------
// `fire_when` predicates
// ---------------------------------------------------------------------------

const COMPARISON_OPERATORS = new Set<string>(["==", "!=", ">", ">=", "<", "<="]);

/** Parse a `fire_when` boolean predicate. */
export function parsePredicate(input: string): ParseResult<Predicate> {
  const tokens = tokenize(input);
  if (!tokens.ok) return tokens;

  const parser = new Parser(tokens.value);
  const predicate = parseOr(parser, 0);
  if (!predicate.ok) return predicate;

  if (!parser.atEnd()) {
    return fail("unexpected trailing input", parser.peek().offset);
  }
  return predicate;
}

function parseOr(p: Parser, depth: number): ParseResult<Predicate> {
  if (depth > MAX_PREDICATE_DEPTH) {
    return fail(`predicate nests deeper than ${MAX_PREDICATE_DEPTH} levels`, p.peek().offset);
  }

  const first = parseAnd(p, depth);
  if (!first.ok) return first;

  const operands: Predicate[] = [first.value];
  while (p.atKeyword("OR")) {
    p.next();
    const next = parseAnd(p, depth);
    if (!next.ok) return next;
    operands.push(next.value);
  }
  return operands.length === 1 ? first : { ok: true, value: { kind: "or", operands } };
}

function parseAnd(p: Parser, depth: number): ParseResult<Predicate> {
  const first = parseNot(p, depth);
  if (!first.ok) return first;

  const operands: Predicate[] = [first.value];
  while (p.atKeyword("AND")) {
    p.next();
    const next = parseNot(p, depth);
    if (!next.ok) return next;
    operands.push(next.value);
  }
  return operands.length === 1 ? first : { ok: true, value: { kind: "and", operands } };
}

function parseNot(p: Parser, depth: number): ParseResult<Predicate> {
  if (p.atKeyword("NOT")) {
    if (depth > MAX_PREDICATE_DEPTH) {
      return fail(`predicate nests deeper than ${MAX_PREDICATE_DEPTH} levels`, p.peek().offset);
    }
    p.next();
    const operand = parseNot(p, depth + 1);
    if (!operand.ok) return operand;
    return { ok: true, value: { kind: "not", operand: operand.value } };
  }
  return parsePrimary(p, depth);
}

function parsePrimary(p: Parser, depth: number): ParseResult<Predicate> {
  if (p.at("(")) {
    p.next();
    const inner = parseOr(p, depth + 1);
    if (!inner.ok) return inner;
    const close = p.expect(")");
    if (close) return { ok: false, error: close };
    return inner;
  }

  const left = parseExpr(p);
  if (!left.ok) return left;

  const token = p.peek();
  if (token.kind === "punct" && COMPARISON_OPERATORS.has(token.text)) {
    p.next();
    const right = parseExpr(p);
    if (!right.ok) return right;
    return {
      ok: true,
      value: {
        kind: "comparison",
        left: left.value,
        op: token.text as ComparisonOperator,
        right: right.value,
      },
    };
  }

  return { ok: true, value: { kind: "truthy", operand: left.value } };
}
