// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A watch's live state, read for the canvas.
 *
 * `GET /admin/watch/watches/:id/state` returns one consistent snapshot: every
 * node's cell population, the armed timers, the parked nominations, and the
 * journal event all of it is true at. This turns that into the two framings the
 * canvas offers, and nothing else — no DOM, no fetching, so both are testable
 * without a browser.
 *
 * **No lens**: every node wears its cell count. The canvas answers "where does
 * state exist right now".
 *
 * **A key selected**: the canvas dims to that key's slice. A node holding a cell
 * for the key stays lit; a keyed node without one dims; an unkeyed node — a
 * source, a transform, the sink — is always lit, because it has no population to
 * be absent from. The canvas answers "where is *this* instantiation".
 *
 * Keys are grouped by **shape** rather than listed flat: a watch that joins on
 * `(person, day)` and one that keys on `order_id` produce keys that are not
 * comparable, and one alphabetical list of both invites reading them as
 * alternatives. Everything here takes raw JSON off the wire, so every reader is
 * defensive: a field of the wrong type reads as absent rather than throwing.
 */

/** The label a key with no components carries, matching the runtime's own. */
const SINGLETON_KEY_LABEL = "singleton";

/**
 * Read a state response into the shape the views use.
 *
 * Returns null when the payload carries no snapshot at all — a caller renders
 * that as "state could not be read", which is different from a watch that holds
 * nothing.
 */
export function readWatchStateSnapshot(payload) {
  if (!isPlainObject(payload) || !Array.isArray(payload.nodes)) return null;
  const nodes = payload.nodes.filter(isPlainObject).map((node) => ({
    id: typeof node.id === "string" ? node.id : "",
    type: typeof node.type === "string" ? node.type : "unknown",
    count: Number.isInteger(node.cells) ? node.cells : asArray(node.instances).length,
    onCollision: typeof node.onCollision === "string" ? node.onCollision : null,
    maxLiveInstances: Number.isInteger(node.maxLiveInstances) ? node.maxLiveInstances : null,
    cancelledBy: asArray(node.cancelledBy).filter((id) => typeof id === "string"),
    instances: asArray(node.instances).filter(isPlainObject).map(readInstance),
  }));
  return {
    asOf: {
      at: typeof payload.asOf?.at === "string" ? payload.asOf.at : null,
      seq: Number.isFinite(payload.asOf?.seq) ? payload.asOf.seq : null,
      journalHead: Number.isFinite(payload.asOf?.journalHead) ? payload.asOf.journalHead : null,
    },
    nodes,
    byNodeId: new Map(nodes.map((node) => [node.id, node])),
    timers: asArray(payload.timers).filter(isPlainObject).map(readTimer),
    parked: asArray(payload.parked).filter(isPlainObject).map(readParked),
    judge: isPlainObject(payload.judge) ? payload.judge : null,
    /** Whether the runtime is holding anything at all for this watch. */
    empty:
      nodes.every((node) => node.count === 0)
      && asArray(payload.timers).length === 0
      && asArray(payload.parked).length === 0,
  };
}

function readInstance(instance) {
  return {
    keyHash: typeof instance.keyHash === "string" ? instance.keyHash : "",
    instance: Number.isInteger(instance.instance) ? instance.instance : 0,
    label: keyLabel(instance),
    components: readComponents(instance.components),
    state: typeof instance.state === "string" ? instance.state : "live",
    armedAt: typeof instance.armedAt === "string" ? instance.armedAt : null,
    deadlineAt: typeof instance.deadlineAt === "string" ? instance.deadlineAt : null,
    lastFiredAt: typeof instance.lastFiredAt === "string" ? instance.lastFiredAt : null,
    detail: isPlainObject(instance.detail) ? instance.detail : { kind: "opaque" },
  };
}

function readTimer(timer) {
  return {
    nodeId: typeof timer.nodeId === "string" ? timer.nodeId : "",
    keyHash: typeof timer.keyHash === "string" ? timer.keyHash : "",
    instance: Number.isInteger(timer.instance) ? timer.instance : 0,
    label: keyLabel(timer),
    components: readComponents(timer.components),
    kind: typeof timer.kind === "string" ? timer.kind : "timer",
    dueAt: typeof timer.dueAt === "string" ? timer.dueAt : null,
    overdue: timer.overdue === true,
  };
}

function readParked(nomination) {
  return {
    nodeId: typeof nomination.nodeId === "string" ? nomination.nodeId : "",
    docId: typeof nomination.docId === "string" ? nomination.docId : "",
    seq: Number.isFinite(nomination.seq) ? nomination.seq : null,
    at: typeof nomination.at === "string" ? nomination.at : null,
    failure: typeof nomination.failure === "string" ? nomination.failure : null,
  };
}

function readComponents(components) {
  return asArray(components)
    .filter(isPlainObject)
    .map((component) => ({
      name: typeof component.name === "string" ? component.name : "",
      raw: typeof component.raw === "string" ? component.raw : "",
      display: typeof component.display === "string" ? component.display : null,
    }));
}

function keyLabel(carrier) {
  return typeof carrier.keyLabel === "string" && carrier.keyLabel.length > 0
    ? carrier.keyLabel
    : SINGLETON_KEY_LABEL;
}

// ── The key selector ────────────────────────────────────────────────────────

/**
 * Every live key across the watch, grouped by shape.
 *
 * One key can be held by several nodes and by several instances of one node, so
 * they are collapsed onto the key hash — which is the runtime's own identity for
 * a key, and what selecting one dims by. A timer's key counts too: a cell can be
 * dropped while its timer row is still being read in the same snapshot, and a
 * key that had gone from the selector would leave that timer unattributable.
 *
 * Groups are ordered by shape, keys within a group by their display text, so the
 * list is stable between refreshes.
 */
export function watchStateKeyGroups(snapshot) {
  if (!snapshot) return [];
  const keys = new Map();
  const record = (carrier, nodeId, cells) => {
    if (carrier.keyHash === "") return;
    const held =
      keys.get(carrier.keyHash)
      ?? {
        keyHash: carrier.keyHash,
        label: carrier.label,
        components: carrier.components,
        shape: keyShape(carrier.components),
        nodeIds: [],
        cells: 0,
      };
    if (!held.nodeIds.includes(nodeId)) held.nodeIds.push(nodeId);
    held.cells += cells;
    keys.set(carrier.keyHash, held);
  };
  for (const node of snapshot.nodes) {
    for (const instance of node.instances) record(instance, node.id, 1);
  }
  for (const timer of snapshot.timers) record(timer, timer.nodeId, 0);

  const groups = new Map();
  for (const key of keys.values()) {
    const group = groups.get(key.shape) ?? { shape: key.shape, keys: [] };
    group.keys.push(key);
    groups.set(key.shape, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      // Ordered by what the chip says, not by the id behind it: a list of
      // people sorted by opaque id is a list in no order the reader can see.
      keys: group.keys.sort((a, b) => keyDisplayLabel(a).localeCompare(keyDisplayLabel(b))),
    }))
    .sort((a, b) => a.shape.localeCompare(b.shape));
}

/** A key's shape as `(person, day)` — its component names, in order. */
function keyShape(components) {
  const names = components.map((component) => component.name).filter(Boolean);
  return names.length === 0 ? SINGLETON_KEY_LABEL : `(${names.join(", ")})`;
}

/**
 * The groups narrowed to keys matching `query`.
 *
 * Matched against both the display name and the raw id, because the operator
 * arrives with whichever they have: a name they read on the People page, or an
 * id they copied out of a trace. An empty group is dropped rather than shown
 * with nothing under it.
 */
export function filterWatchStateKeys(groups, query) {
  const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (needle === "") return groups;
  return groups
    .map((group) => ({
      ...group,
      keys: group.keys.filter((key) => searchText(key).toLowerCase().includes(needle)),
    }))
    .filter((group) => group.keys.length > 0);
}

/** Everything about a key a search should look at. */
function searchText(key) {
  return [
    key.label,
    ...key.components.flatMap((component) =>
      component.display ? [component.display, component.raw] : [component.raw],
    ),
  ].join(" ");
}

/**
 * Every id the state read resolved to a name, as `raw → display`.
 *
 * The state route resolves key components against the people directory; the
 * history route answers with the key the runtime wrote to its trace, which is
 * ids all the way down. Both land on one page, so without this the same person
 * appears as a name in the key selector and as a UUID two inches below it, and
 * a reader cannot tell that the row and the chip are about the same key.
 *
 * Only what the runtime is holding *now* can be resolved this way, which is
 * why the substitution falls back to the id rather than inventing one.
 */
export function watchStateNames(snapshot) {
  const names = new Map();
  const collect = (carrier) => {
    for (const component of carrier.components) {
      if (component.display && component.raw) names.set(component.raw, component.display);
    }
  };
  for (const node of snapshot?.nodes ?? []) for (const instance of node.instances) collect(instance);
  for (const timer of snapshot?.timers ?? []) collect(timer);
  return names;
}

/** A key's components as one line, preferring the resolved names. */
export function keyDisplayLabel(key) {
  if (!key || key.components.length === 0) return SINGLETON_KEY_LABEL;
  return key.components
    .map((component) => `${component.name}=${component.display ?? component.raw}`)
    .join(", ");
}

// ── The key lens ────────────────────────────────────────────────────────────

/**
 * Which nodes stay lit under a selected key.
 *
 * A node is lit when it holds a cell for the key, and also when it holds no
 * keyed population at all — a source, a transform, a broadcast tick and the sink
 * are not absent from a key's slice, they are simply outside the keying. Dimming
 * those would dim most of the canvas and say nothing.
 *
 * `dag` is the definition reading the canvas already has; `keyed` on each node
 * is what says whether a key is expected of it.
 */
export function litNodeIds(snapshot, dag, keyHash) {
  const lit = new Set();
  if (!dag) return lit;
  for (const node of dag.nodes) {
    if (!node.keyed) {
      lit.add(node.id);
      continue;
    }
    const held = snapshot?.byNodeId.get(node.id);
    if (held?.instances.some((instance) => instance.keyHash === keyHash)) lit.add(node.id);
  }
  return lit;
}

/** The cells one node holds for a selected key, oldest instance first. */
export function cellsForKey(snapshot, nodeId, keyHash) {
  const node = snapshot?.byNodeId.get(nodeId);
  if (!node) return [];
  return node.instances.filter((instance) => instance.keyHash === keyHash);
}

// ── Rendering arithmetic ────────────────────────────────────────────────────

/**
 * Where `now` sits between two instants, as a fraction of the span.
 *
 * Clamped to `[0, 1]`: a deadline the evaluation tick has not swept yet is
 * genuinely in the past, and a bar drawn past its own end would read as a
 * rendering fault rather than as the overdue timer it is. Null when either end
 * is unreadable or the span has no length, so a caller draws nothing rather
 * than a full bar it cannot justify.
 */
export function spanProgress(fromIso, toIso, now = Date.now()) {
  const from = instantMs(fromIso);
  const to = instantMs(toIso);
  if (from === null || to === null || to <= from) return null;
  return Math.min(1, Math.max(0, (now - from) / (to - from)));
}

/** An ISO instant as epoch milliseconds, or null when it is unreadable. */
function instantMs(value) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
