// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { getSourceFilterOptions, previewSourceFilter } from "../api.js";
import { rememberScopeLabels, scopeLabelGeneration } from "./source-filter-labels.js";

// Leave capacity for another owner view. Options and previews share the same
// server budget. Only simultaneous exact requests share a result; completed
// responses are never reused to authorize a new edit.
const LIMIT = 2;
const pending = [];
const requests = new Map();
let active = 0;
const aborted = () => new DOMException("The request was canceled.", "AbortError");
function settle(entry, error, result) {
  // Remove before resolving consumers: an immediate fresh request after await
  // must not join an entry whose listeners have already been notified.
  if (requests.get(entry.key) === entry) requests.delete(entry.key);
  for (const listener of [...entry.listeners]) listener.finish(error, result);
}
function drain() {
  while (active < LIMIT && pending.length) {
    const entry = pending.shift();
    if (!entry.listeners.size) continue;
    if (entry.generation !== scopeLabelGeneration()) {
      for (const listener of [...entry.listeners]) listener.finish(aborted());
      if (requests.get(entry.key) === entry) requests.delete(entry.key);
      continue;
    }
    active++;
    entry.started = true;
    Promise.resolve()
      .then(() => {
        if (entry.generation !== scopeLabelGeneration()) throw aborted();
        return entry.read(entry.controller.signal);
      })
      .then(
        (result) =>
          settle(entry, entry.generation === scopeLabelGeneration() ? null : aborted(), result),
        (error) => settle(entry, entry.generation === scopeLabelGeneration() ? error : aborted()),
      )
      .finally(() => {
        if (requests.get(entry.key) === entry) requests.delete(entry.key);
        active--;
        drain();
      });
  }
}
function admitted(key, read, signal, generation) {
  key = JSON.stringify([generation, key]);
  if (signal?.aborted) return Promise.reject(aborted());
  let entry = requests.get(key);
  if (!entry) {
    entry = {
      key,
      generation,
      read,
      controller: new AbortController(),
      listeners: new Set(),
      started: false,
    };
    requests.set(key, entry);
    pending.push(entry);
  }
  return new Promise((resolve, reject) => {
    const listener = {
      finish(error, value) {
        if (!entry.listeners.delete(listener)) return;
        signal?.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolve(value);
      },
    };
    const cancel = () => {
      listener.finish(aborted());
      if (!entry.listeners.size && !entry.started) {
        entry.controller.abort();
        if (requests.get(key) === entry) requests.delete(key);
      }
      drain();
    };
    entry.listeners.add(listener);
    signal?.addEventListener("abort", cancel, { once: true });
    drain();
  });
}
export function readFilterOptions(sourceId, query, signal) {
  const generation = scopeLabelGeneration();
  return admitted(
    JSON.stringify(["options", sourceId, query]),
    async (requestSignal) => {
      const result = await getSourceFilterOptions(sourceId, query, requestSignal);
      if (result.sourceId === sourceId) rememberScopeLabels(sourceId, result.items, generation);
      return result;
    },
    signal,
    generation,
  );
}
export function readFilterPreview(sourceId, policy, signal) {
  const generation = scopeLabelGeneration();
  return admitted(
    JSON.stringify(["preview", sourceId, policy]),
    async (requestSignal) => {
      const result = await previewSourceFilter(sourceId, policy, requestSignal);
      if (result.sourceId === sourceId) rememberScopeLabels(sourceId, result.items, generation);
      return result;
    },
    signal,
    generation,
  );
}
