// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Which of a watch's output fields carry a document id.
 *
 * A debug surface showing what a node produced has a string on its hands and no
 * way to know whether it is a document, a person, a thread key or a title — so
 * it renders every one of them as an opaque value, and an operator looking at
 * `by_whatsapp` sees `a3f2…` where they wanted to see the conversation the
 * watch fired on.
 *
 * The DSL answers this statically. `$e.docId` at a source node is a document
 * id; a field whose expression is that reference carries one; a downstream
 * `$n.<node>.<field>` carries one when the field it names does. So the lineage
 * is a fixed point over the graph, computed once from the definition, and the
 * surfaces read it rather than guessing.
 *
 * **Never guess from the name.** A field called `doc_id` holding a person id
 * would be rendered as a document that does not exist, and the operator would
 * be looking at a chip for the wrong thing with no way to tell. The analysis is
 * the contract; a field it cannot prove is not marked.
 */

import { lookup } from "../internal/lookup.js";
import { EXTRACTOR_FUNCTIONS, parseExpression, type Expression } from "./expression.js";

import type { WatchDefinition, WatchNode } from "./schema.js";

/**
 * The document-carrying fields of each node's output, and of the sink's.
 *
 * Keyed by node id, with the sink under {@link SINK_LINEAGE_KEY}. A node absent
 * from the map produced no document-typed field, which is the ordinary case.
 */
export type DocumentLineage = ReadonlyMap<string, ReadonlySet<string>>;

/** Where the sink's own output fields live in a lineage map. */
export const SINK_LINEAGE_KEY = "$sink";

/**
 * The one expression that introduces a document id: the arriving event's own.
 *
 * `$e.docId` and nothing else — a document id reached any other way (out of
 * metadata, out of an analytics column) is a string the DSL cannot prove is a
 * document, and marking it would be the name-guessing this exists to avoid.
 */
function isEventDocId(expression: Expression): boolean {
  if (expression.kind !== "event") return false;
  const [first, ...rest] = expression.path;
  return rest.length === 0 && first?.kind === "field" && first.name === "docId";
}

/**
 * Whether an expression carries a document id, given what upstream nodes do.
 *
 * A call is followed through its arguments only when the function *passes an
 * argument through* — `coalesce($n.a.doc, $n.b.doc)` is a document when its
 * branches are, which is exactly the join case an operator asks about, "which
 * document did each arm bring". A function that computes a new value from its
 * arguments carries nothing forward however document-typed those arguments
 * were: `date_trunc($e.docId, $e.docId)` validates, and evaluates to a
 * truncated instant or a null, and is never a document.
 *
 * Which functions are which is read from {@link EXTRACTOR_FUNCTIONS} rather
 * than listed here, so a function added to the DSL cannot be silently treated
 * as pass-through by this file alone. An unknown function is not marked: the
 * validator rejects the watch, and until it does, nothing is proven.
 *
 * A call mixing a document with something else is not marked either — the value
 * it produces is a document only sometimes, and a chip that is right half the
 * time is worse than a string.
 */
function carriesDocument(expression: Expression, known: Map<string, Set<string>>): boolean {
  if (isEventDocId(expression)) return true;
  if (expression.kind === "node") {
    const component = expression.component;
    if (component.kind !== "field") return false;
    return known.get(expression.node)?.has(component.name) === true;
  }
  if (expression.kind === "call") {
    const signature = lookup(EXTRACTOR_FUNCTIONS, expression.fn);
    if (!signature?.passesThrough) return false;
    // Every argument, and at least one: a zero-argument call produces something
    // of its own rather than passing a document through.
    return (
      expression.args.length > 0 && expression.args.every((arg) => carriesDocument(arg, known))
    );
  }
  return false;
}

/** The `output_map` a node declares, or nothing when it declares none. */
function outputMapOf(node: WatchNode): Readonly<Record<string, string>> | undefined {
  const declared = (node as { output_map?: Readonly<Record<string, string>> }).output_map;
  return declared;
}

/**
 * The document-carrying fields a node projects when it renames nothing.
 *
 * A node with no `output_map` forwards its arriving event's own fields, so a
 * document-event source projects `docId` under that name — the same fact
 * `$e.docId` states, reached without an expression to read it out of. A watch
 * whose sink cites `$n.<source>.docId` is an ordinary way to author one, and
 * without this it renders the raw id as a string: the exact symptom this
 * analysis exists to remove.
 *
 * Only the document-event source. An analytics row carries its columns under
 * `$e.row.*` and a loop event carries loop ids; neither has a document in it.
 */
function nativeDocumentFields(node: WatchNode): Set<string> {
  return node.type === "source.document_event" ? new Set(["docId"]) : new Set();
}

function documentFieldsOf(
  map: Readonly<Record<string, string>> | undefined,
  known: Map<string, Set<string>>,
): Set<string> {
  const fields = new Set<string>();
  for (const [name, source] of Object.entries(map ?? {})) {
    const parsed = parseExpression(source);
    // An expression this build cannot parse is not proven to be anything. The
    // validator reports it; nothing here needs to double as a second opinion.
    if (!parsed.ok) continue;
    if (carriesDocument(parsed.value, known)) fields.add(name);
  }
  return fields;
}

/**
 * Every document-carrying output field of a watch, by node.
 *
 * Iterated to a fixed point rather than in declaration order: a watch's nodes
 * are a graph and the DSL does not require an author to list them
 * topologically, so a single pass would miss a node that reads one declared
 * after it. The graph is acyclic and small — the loop settles in as many passes
 * as the graph is deep, and is bounded by the node count regardless.
 */
export function documentLineage(watch: WatchDefinition): DocumentLineage {
  const known = new Map<string, Set<string>>();
  for (let pass = 0; pass <= watch.nodes.length; pass += 1) {
    let changed = false;
    for (const node of watch.nodes) {
      const map = outputMapOf(node);
      const fields = map === undefined ? nativeDocumentFields(node) : documentFieldsOf(map, known);
      const before = known.get(node.id);
      if (before && before.size === fields.size && [...fields].every((f) => before.has(f)))
        continue;
      known.set(node.id, fields);
      changed = true;
    }
    if (!changed) break;
  }
  const sink = documentFieldsOf(watch.sink.output_map, known);
  if (sink.size > 0) known.set(SINK_LINEAGE_KEY, sink);
  for (const [node, fields] of [...known]) if (fields.size === 0) known.delete(node);
  return known;
}
