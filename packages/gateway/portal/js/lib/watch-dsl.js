// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Watch DSL, as the portal reads it.
 *
 * The DSL itself is declared once, in zod, inside `@omnesis/watch` — which the
 * portal cannot import: it is served as static ES modules with no bundler, and
 * only the specifiers in the page's importmap resolve. So the parts needed to
 * *look at* a stored definition are mirrored here by hand: which node types are
 * trip-wires, which hold state between arm and fire, which report a branch
 * through `$fired_by`, and what one line of each node's configuration says.
 *
 * Mirrored rather than derived means it can drift from the runtime's table.
 * What keeps the drift honest is that an unrecognised node type is rendered as
 * itself — its raw type as the title, its fields in the pane, and no summary
 * invented on its behalf — so a definition carrying a node this file has never
 * heard of still appears on the canvas instead of vanishing from it.
 *
 * Everything here takes raw JSON straight off the wire, so every reader is
 * defensive: a field of the wrong type reads as absent rather than throwing.
 */

/** The synthetic id the sink box carries. Real node ids are `[a-z][a-z0-9_]*`. */
export const WATCH_SINK_ID = "$sink";

/**
 * What each node type is, mirroring the runtime's `NODE_TRAITS`.
 *
 * `stateful: "by-shape"` means the DSL fields decide rather than the type — a
 * SQL node with no timer, no persistence and no level tracking evaluates
 * instantly and holds nothing.
 */
const NODE_TRAITS = {
  "source.document_event": { source: true, cancellable: false, firedBy: false, stateful: false },
  "source.analytics_row": { source: true, cancellable: false, firedBy: false, stateful: false },
  "source.open_loop": { source: true, cancellable: false, firedBy: false, stateful: false },
  "source.time": { source: true, cancellable: false, firedBy: false, stateful: false },
  "stateless.or": { source: false, cancellable: false, firedBy: true, stateful: false },
  "stateless.transform": { source: false, cancellable: false, firedBy: false, stateful: false },
  "stateful.wait": { source: false, cancellable: true, firedBy: false, stateful: true },
  "stateful.and": { source: false, cancellable: true, firedBy: false, stateful: true },
  "stateful.threshold": { source: false, cancellable: true, firedBy: true, stateful: true },
  "stateful.sequence": { source: false, cancellable: true, firedBy: false, stateful: true },
  "stateful.cooldown": { source: false, cancellable: true, firedBy: false, stateful: true },
  "stateful.persistence": { source: false, cancellable: true, firedBy: false, stateful: true },
  sql: { source: false, cancellable: true, firedBy: false, stateful: "by-shape" },
  llm: { source: false, cancellable: true, firedBy: false, stateful: true },
};

/**
 * The traits of a node type, or null when this build has never heard of it.
 *
 * A null is a real answer: the canvas draws the node anyway and simply makes no
 * claim about what it does.
 */
export function watchNodeTraits(type) {
  return Object.hasOwn(NODE_TRAITS, type) ? NODE_TRAITS[type] : null;
}

/**
 * Whether a node is a trip-wire — no inputs, instantiated by the journal or a
 * timer. An unrecognised type is judged by its shape instead: a node carrying
 * no `inputs` has nothing upstream of it and sits on the top rank either way.
 */
export function isWatchSourceNode(node) {
  const traits = watchNodeTraits(node?.type);
  if (traits) return traits.source;
  return !isPlainObject(node?.inputs);
}

/** Whether a node holds an instance between arm and fire. */
export function isWatchNodeStateful(node) {
  const traits = watchNodeTraits(node?.type);
  if (!traits) return false;
  if (traits.stateful !== "by-shape") return traits.stateful;
  return (
    typeof node?.timer === "string"
    || typeof node?.persistence === "string"
    || node?.fire_on === "rising_edge"
  );
}

/** Whether `$n.<id>.$fired_by` means anything on this node — only branching ones. */
export function watchNodeReportsFiredBy(node) {
  return watchNodeTraits(node?.type)?.firedBy === true;
}

// ── Summaries ───────────────────────────────────────────────────────────────

/**
 * The one line of configuration that says what this node is watching for: the
 * source filter, the deadline, the threshold, the proposition's first words.
 *
 * Null when the node type is unrecognised, so nothing is asserted about a node
 * this build cannot read.
 */
export function watchNodeSummary(node) {
  const summarize = NODE_SUMMARIES[node?.type];
  return summarize ? (summarize(node) ?? null) : null;
}

const NODE_SUMMARIES = {
  "source.document_event": (node) => {
    const filter = node.filter ?? {};
    const parts = [textList(filter.source) ?? "any source"];
    const documentType = textList(filter.documentType);
    if (documentType) parts.push(documentType);
    const events = textList(filter.event);
    if (events) parts.push(`on ${events}`);
    return parts.join(" · ");
  },
  "source.analytics_row": (node) => {
    const table = typeof node.table === "string" ? node.table : "a table";
    const ops = textList(node.op);
    const parts = [ops ? `${table} · on ${ops}` : table];
    if (typeof node.predicate === "string") parts.push("filtered");
    return parts.join(" · ");
  },
  "source.open_loop": (node) => {
    const ops = textList(node.op);
    const parts = [ops ? `open loops · on ${ops}` : "open loops"];
    const loopIds = Array.isArray(node.loop_ids) ? node.loop_ids.length : 0;
    if (loopIds > 0) parts.push(`${loopIds} named loop${loopIds === 1 ? "" : "s"}`);
    return parts.join(" · ");
  },
  "source.time": (node) => {
    if (typeof node.recurring === "string") return `every ${node.recurring}`;
    if (typeof node.one_off === "string") return `once, at ${node.one_off}`;
    return null;
  },
  "stateless.or": (node) => {
    const count = inputCount(node);
    return `fires on any of ${count} input${count === 1 ? "" : "s"}`;
  },
  "stateless.transform": (node) => firstWords(node.query),
  "stateful.wait": (node) =>
    typeof node.duration === "string" ? `${node.duration} after arming` : null,
  "stateful.and": (node) => `every arm ${withinLabel(node.deadline)}`,
  "stateful.threshold": (node) => {
    const n = Number.isInteger(node.n) ? node.n : "?";
    return `${n} of ${inputCount(node)} arms ${withinLabel(node.deadline)}`;
  },
  "stateful.sequence": (node) => {
    const order = Array.isArray(node.order)
      ? node.order.filter((step) => typeof step === "string")
      : [];
    const steps = order.length > 0 ? order.join(" → ") : "in order";
    return `${steps} ${withinLabel(node.deadline)}`;
  },
  "stateful.cooldown": (node) =>
    typeof node.min_interval === "string" ? `at most once every ${node.min_interval}` : null,
  "stateful.persistence": (node) => {
    const events = Number.isInteger(node.min_events) ? node.min_events : "?";
    const duration = typeof node.duration === "string" ? node.duration : "the window";
    return `${events} arms within ${duration}`;
  },
  sql: (node) => firstWords(node.query),
  llm: (node) => {
    const proposition = firstWords(node.proposition);
    const mode = typeof node.mode === "string" ? node.mode : null;
    if (!proposition) return mode;
    return mode ? `${mode}: ${proposition}` : proposition;
  },
};

// ── Badges ──────────────────────────────────────────────────────────────────

/**
 * The properties that change how a node behaves, as short chips.
 *
 * Only the switches belong here — an enum, a count, an interval. Anything with
 * a body of its own (a query, a proposition, a filter) is the pane's job, and
 * a badge carrying it would be unreadable at box width.
 */
export function watchNodeBadges(node) {
  const badges = [];
  const add = (label, title) => badges.push({ label, title });

  if (typeof node?.on_collision === "string") {
    add(`collision: ${node.on_collision}`, COLLISION_MEANING[node.on_collision] ?? null);
  }
  if (Number.isInteger(node?.max_live_instances)) {
    add(
      `≤ ${node.max_live_instances} live`,
      "How many instances may be live under one key at once; an arm past the cap is dropped.",
    );
  }
  if (typeof node?.fire_on === "string") {
    add(
      node.fire_on === "rising_edge" ? "rising edge" : "every true",
      node.fire_on === "rising_edge"
        ? "Fires when the predicate becomes true, not for every evaluation it stays true."
        : "Fires on every evaluation where the predicate holds.",
    );
  }
  if (typeof node?.initial_level === "string") {
    add(
      node.initial_level === "assume_false" ? "assumes false" : "first observation",
      "What the level is taken to have been before the first evaluation.",
    );
  }
  if (Number.isInteger(node?.min_events)) {
    add(`≥ ${node.min_events} events`, "How many arms inside the window constitute 'kept firing'.");
  }
  if (typeof node?.min_interval === "string") {
    add(`≥ ${node.min_interval} apart`, "The quiet period this node holds after it fires.");
  }
  if (typeof node?.deadline === "string") {
    add(
      node.deadline === "infinite" ? "no deadline" : `deadline ${node.deadline}`,
      "How long the cell waits before it expires unfired.",
    );
  }
  if (typeof node?.timer === "string") {
    add(`re-runs every ${node.timer}`, "The interval the query is re-evaluated on until it settles.");
  }
  if (typeof node?.persistence === "string") {
    add(`holds ${node.persistence}`, "How long the predicate must keep holding before it fires.");
  }
  if (node?.backfill === "include") {
    add("includes backfill", "Rows a source replayed count too, not only ones it reported live.");
  }
  if (isPlainObject(node?.judge)) {
    add("judged", "Nomination is never firing: a judge decides every document this source recalls.");
  }
  return badges;
}

const COLLISION_MEANING = {
  reset: "A second arm restarts the live cell.",
  ignore: "A second arm is dropped while a cell is live.",
  spawn: "A second arm opens another live instance under the same key.",
  accumulate: "The cell outlives its firings and keeps taking arms.",
};

// ── Watch-level vocabulary ──────────────────────────────────────────────────

/** What a firing policy means, in the operator's terms. */
export function watchFiringPolicyLabel(policy) {
  if (policy === "once_ever") return "Once ever — the watch retires when it fires";
  if (policy === "stays_active") return "Stays active — it keeps watching after it fires";
  return "Unknown";
}

/**
 * Every sentence this watch puts to a model, attributed to the node that puts
 * it — a recall-driven source's inline judge, or an `llm` node's own.
 *
 * An installed watch stores no approved interpretation: what it was understood
 * to mean is not a field on the definition. These propositions are the nearest
 * thing to one, and they are the exact text a model is asked to decide, so the
 * pane shows them under their own node rather than as a summary of the watch.
 *
 * This is a developer surface. The watch's own page states what the operator
 * asked for and stops there: which sentences the compiler put to a model is
 * how the watch is built rather than what it does, and a reader who wants that
 * has the definition and this canvas.
 */
export function watchPropositions(definition) {
  const nodes = Array.isArray(definition?.nodes) ? definition.nodes : [];
  const found = [];
  for (const node of nodes) {
    if (!isPlainObject(node)) continue;
    if (typeof node.judge?.proposition === "string") {
      found.push({
        nodeId: node.id,
        kind: "judge",
        proposition: node.judge.proposition,
        outputSchema: isPlainObject(node.judge.output_schema) ? node.judge.output_schema : null,
      });
    }
    if (node.type === "llm" && typeof node.proposition === "string") {
      found.push({
        nodeId: node.id,
        kind: typeof node.mode === "string" ? node.mode : "llm",
        proposition: node.proposition,
        outputSchema: isPlainObject(node.output_schema) ? node.output_schema : null,
      });
    }
  }
  return found;
}

/**
 * The delivery block's fields, structured for display, or null when the watch
 * delivers nowhere.
 *
 * Both spellings of the notify kind are accepted: the stored DSL is served
 * verbatim, so a watch written before the rename still says `ios-push`.
 */
export function watchDeliveryFields(delivery) {
  if (delivery?.kind === "omnesis-notify" || delivery?.kind === "ios-push") {
    return {
      kind: delivery.kind,
      fields: [
        ["Title", typeof delivery.title === "string" ? delivery.title : null],
        ["Body", typeof delivery.body === "string" ? delivery.body : null],
      ],
      note:
        typeof delivery.title === "string" || typeof delivery.body === "string"
          ? null
          : "No words were authored, so the runtime composes the banner from the request.",
    };
  }
  if (delivery?.kind === "agent-wake") {
    const bindings = watchWakeBindings(delivery);
    return {
      kind: "agent-wake",
      fields: [
        ["Integration", typeof delivery.integration === "string" ? delivery.integration : null],
        ["Instruction", typeof delivery.instruction === "string" ? delivery.instruction : null],
        // After the instruction, because that is what names them: a referent
        // read before the words that point at it is a value with no question.
        ...bindings.map(([name, referent]) => [`Referent · ${name}`, referent]),
      ],
      note:
        bindings.length > 0
          ? "The woken agent is handed these alongside the instruction; nothing here reads them."
          : null,
    };
  }
  return null;
}

/**
 * The referents an `agent-wake` block names, as `[name, referent]` pairs sorted
 * by name.
 *
 * Sorted because a map is unordered and a surface that printed them in
 * enumeration order would reshuffle the list on a rewrite that changed nothing.
 * Values that are not strings are dropped: the stored DSL is served verbatim,
 * so a block written by something that did not go through the schema can carry
 * anything, and a row reading `[object Object]` is worse than one absent.
 */
export function watchWakeBindings(delivery) {
  if (!isPlainObject(delivery?.bindings)) return [];
  return Object.entries(delivery.bindings)
    .filter(([, referent]) => typeof referent === "string" && referent.length > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// ── Shared readers ──────────────────────────────────────────────────────────

/** A `{component: expression}` key extractor as `(person, day)`. */
export function watchKeyLabel(key) {
  const components = watchKeyComponents(key);
  return components.length > 0 ? `(${components.join(", ")})` : null;
}

/** The component names of a key extractor, in declaration order. */
export function watchKeyComponents(key) {
  return isPlainObject(key) ? Object.keys(key) : [];
}

/** A string, or an array of them, as one comma-joined line. Null when neither. */
export function textList(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const items = value.filter((item) => typeof item === "string");
    return items.length > 0 ? items.join(", ") : null;
  }
  return null;
}

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A deadline phrased for a summary line. */
function withinLabel(deadline) {
  if (deadline === "infinite") return "with no deadline";
  return typeof deadline === "string" ? `within ${deadline}` : "within its deadline";
}

/** The opening of a long piece of prose — a proposition, a query. */
function firstWords(text, limit = 9) {
  if (typeof text !== "string") return null;
  const collapsed = text.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) return null;
  const words = collapsed.split(" ");
  return words.length <= limit ? collapsed : `${words.slice(0, limit).join(" ")}…`;
}

/**
 * How many arms a node draws from.
 *
 * The arms are the inputs that can complete it: an edge declared `cancel` ends
 * a live cell rather than filling it, and a `broadcast` edge reaches every live
 * key rather than being one of the things counted. Counting either would print
 * a firing rule the runtime does not use — "2 of 3 arms" on a node the runtime
 * completes with two of two.
 */
function inputCount(node) {
  if (!isPlainObject(node?.inputs)) return 0;
  return Object.values(node.inputs).filter(
    (input) => isPlainObject(input) && input.role !== "cancel" && input.broadcast !== true,
  ).length;
}
