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
    const value = { label: item.label, missing: item.missing === true };
    if (JSON.stringify(labels.get(key)) !== JSON.stringify(value)) changed = true;
    labels.delete(key);
    labels.set(key, value);
  }
  while (labels.size > LIMIT) labels.delete(labels.keys().next().value);
  if (changed) notify();
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
  const noun = source?.scopes?.items?.find((item) => item.kind === ref.kind)?.noun?.one || "item";
  return { label: `Saved ${noun} selection`, unavailable: true };
}
export function clearScopeLabels() {
  generation++;
  labels.clear();
  notify();
}
