// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { useEffect, useState } from "preact/hooks";
import { scopeRefKey } from "./source-filter-state.js";

// Display hints only. Counts, readiness and permission validation always come
// from a fresh exact-policy preview, never from these retained names.
const labels = new Map();
const LIMIT = 2048;
let generation = 0;
let version = 0;
const subscribers = new Set();
const notify = () => {
  version++;
  for (const subscriber of subscribers) subscriber();
};
export const scopeLabelGeneration = () => generation;
export function useScopeLabelGeneration() {
  const [current, setCurrent] = useState(generation);
  useEffect(() => {
    const update = () => setCurrent(generation);
    subscribers.add(update);
    update();
    return () => subscribers.delete(update);
  }, []);
  return current;
}
export function useScopeLabelVersion() {
  const [current, setCurrent] = useState(version);
  useEffect(() => {
    const update = () => setCurrent(version);
    subscribers.add(update);
    update();
    return () => subscribers.delete(update);
  }, []);
  return current;
}
export function rememberScopeLabels(sourceId, items = [], expectedGeneration = generation) {
  if (expectedGeneration !== generation) return;
  let changed = false;
  for (const item of items) {
    if (!item?.ref || typeof item.label !== "string" || !item.label.trim()) continue;
    const key = JSON.stringify([sourceId, scopeRefKey(item.ref)]);
    const prior = labels.get(key);
    const opaqueMissing =
      item.missing === true && item.ref.kind !== "participant" && item.label === item.ref.id;
    const depth = Number.isInteger(item.depth) ? item.depth : prior?.depth;
    const value = {
      label: opaqueMissing ? (prior?.label ?? "Saved selection") : item.label,
      missing: item.missing === true,
      ...(depth !== undefined ? { depth } : {}),
      ...(opaqueMissing && (!prior || prior.unavailable) ? { unavailable: true } : {}),
    };
    if (JSON.stringify(labels.get(key)) !== JSON.stringify(value)) changed = true;
    labels.delete(key);
    labels.set(key, value);
  }
  while (labels.size > LIMIT) labels.delete(labels.keys().next().value);
  if (changed) notify();
}
/** What a source calls one kind of filter item: "conversation", "person", "label", "folder". */
export function scopeKindNoun(source, kind, many = false) {
  const noun = source?.scopes?.items?.find((item) => item.kind === kind)?.noun;
  if (kind === "participant") return (many ? noun?.many : noun?.one) || (many ? "people" : "person");
  return (many ? noun?.many : noun?.one) || kind;
}
/** The nouns a source gives the levels of a kind's tree, roots first; null when one noun names every item. */
function scopeLevels(source, kind) {
  const levels = source?.scopes?.items?.find((item) => item.kind === kind)?.levels;
  return Array.isArray(levels) && levels.length ? levels : null;
}
/**
 * What a source calls an item `depth` levels down a kind's tree. A source that
 * names its levels has a word for each ("shelf", then "binder"), the last
 * one standing for every deeper level; any other source, and an item whose
 * depth is not known, gets the kind's own noun.
 */
export function scopeLevelNoun(source, kind, depth, many = false) {
  const levels = scopeLevels(source, kind);
  const noun =
    levels && Number.isInteger(depth) && depth >= 0
      ? levels[Math.min(depth, levels.length - 1)]
      : null;
  return (many ? noun?.many : noun?.one) || scopeKindNoun(source, kind, many);
}
/** What choosing an item `depth` levels down a tree also takes in, in the source's words; null when nothing lies beneath it. */
export function scopeNestingHint(source, kind, depth) {
  const levels = scopeLevels(source, kind);
  if (!levels) return `Includes the ${scopeKindNoun(source, kind, true)} inside.`;
  if (!Number.isInteger(depth) || depth < 0 || depth + 1 >= levels.length) return null;
  return `Selecting ${levels[depth].many} includes their ${levels[depth + 1].many}.`;
}
export function scopeDisplayLabel(sourceId, ref, source) {
  const saved = labels.get(JSON.stringify([sourceId, scopeRefKey(ref)]));
  if (saved) return saved;
  if (ref.kind === "participant")
    return {
      label:
        ref.label ||
        ref.identifiers?.map((id) => id.value).join(" or ") ||
        "Saved person selection",
    };
  return { label: `Saved ${scopeKindNoun(source, ref.kind) || "item"} selection`, unavailable: true };
}
export function clearScopeLabels() {
  generation++;
  labels.clear();
  notify();
}
