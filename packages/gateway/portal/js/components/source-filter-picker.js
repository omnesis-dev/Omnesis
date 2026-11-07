// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useScopeLabelGeneration } from "./source-filter-labels.js";
import { readFilterOptions } from "./source-filter-requests.js";
import { filterApiError, FilterReadiness } from "./source-filter-preview.js";
import { requestIdentity, scopeRefKey, typedParticipant } from "./source-filter-state.js";

export function SourceFilterPicker({
  source,
  kind,
  selected,
  onToggle,
  disabled = false,
  active = true,
  scrollContainer,
  memory,
}) {
  const sourceKey = `${source.id ?? source.sourceId}:${kind}`;
  const saved = memory?.get(sourceKey);
  const [query, setQuery] = useState(saved?.query ?? "");
  const [trail, setTrail] = useState(saved?.trail ?? []);
  const positions = useRef(saved?.positions ?? new Map());
  const parentId = query ? undefined : trail.at(-1)?.id;
  const sourceId = source.id ?? source.sourceId;
  const generation = useScopeLabelGeneration();
  const identity = JSON.stringify([generation, requestIdentity(sourceId, kind, query, parentId)]);
  const scrollKey = JSON.stringify([identity, trail.map((item) => item.id)]);
  const current = useRef(identity);
  current.current = identity;
  const requests = useRef(new Set());
  const inFlight = useRef(false);
  const [state, setState] = useState({
    identity,
    items: [],
    pending: true,
    nextCursor: null,
    error: "",
  });
  const [type, setType] = useState("email");
  const [typed, setTyped] = useState("");
  const [typedError, setTypedError] = useState("");
  const [typedOpen, setTypedOpen] = useState(false);
  const declaration = source.scopes?.items?.find((item) => item.kind === kind);
  const identifierTypes = declaration?.identifiers ?? [];
  const types = ["email", "phone", "domain"].filter((item) => identifierTypes.includes(item));
  const typedType = types.includes(type) ? type : types[0];

  async function load(cursor, append) {
    if (append && inFlight.current) return;
    inFlight.current = true;
    const controller = new AbortController();
    requests.current.add(controller);
    const requestKey = identity;
    setState((old) => ({
      ...(old.identity === identity ? old : { identity, items: [] }),
      pending: true,
      error: "",
    }));
    try {
      const result = await readFilterOptions(
        sourceId,
        { kind, q: query || undefined, parentId, cursor: cursor || undefined },
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        current.current !== requestKey ||
        result.sourceId !== sourceId
      )
        return;
      setState((old) => ({
        identity,
        items: append && old.identity === identity ? [...old.items, ...result.items] : result.items,
        nextCursor: result.nextCursor,
        readiness: result.readiness,
        pending: false,
        error: "",
      }));
    } catch (error) {
      if (!controller.signal.aborted && current.current === requestKey)
        setState((old) => ({
          ...old,
          identity,
          pending: false,
          error: filterApiError(error, "Options are unavailable. Saved selections are retained."),
        }));
    } finally {
      requests.current.delete(controller);
      if (current.current === requestKey) inFlight.current = false;
    }
  }
  useEffect(() => {
    const timer = setTimeout(() => load(null, false), 150);
    return () => {
      clearTimeout(timer);
      for (const controller of requests.current) controller.abort();
      inFlight.current = false;
    };
  }, [identity]);
  // The owner keeps one scroll container across the picker and review. Save
  // offsets by exact catalogue context; a new query starts at its own position.
  useLayoutEffect(() => {
    const element = scrollContainer?.current;
    if (!element || !active) return;
    const restore = () => {
      element.scrollTop = positions.current.get(scrollKey) ?? 0;
    };
    restore();
    const remember = () => positions.current.set(scrollKey, element.scrollTop);
    element.addEventListener("scroll", remember);
    return () => {
      element.removeEventListener("scroll", remember);
      memory?.set(sourceKey, { query, trail, positions: positions.current });
    };
  }, [scrollKey, active]);
  useLayoutEffect(() => {
    if (active && state.identity === identity && !state.pending && scrollContainer?.current)
      scrollContainer.current.scrollTop = positions.current.get(scrollKey) ?? 0;
  }, [scrollKey, active, state.pending]);
  const visible = state.identity === identity ? state : { items: [], pending: true };
  const keys = new Set(selected.map(scopeRefKey));
  return html`<section
    class="source-filter-picker"
    aria-label=${`Choose ${declaration?.noun?.many || kind}`}
  >
    <${FilterReadiness} readiness=${visible.readiness ?? source.scopeReadiness} />
    ${
      kind === "folder"
        ? html`<p>
              Choosing a folder includes all of its descendants. Moving records or folders can
              change access.
            </p>
            <nav class="source-filter-breadcrumbs" aria-label="Folder path">
              <button type="button" onClick=${() => setTrail([])}>All folders</button
              >${trail.map((item, index) => html`<button type="button" onClick=${() => setTrail(trail.slice(0, index + 1))}>${item.label}</button>`)}
            </nav>`
        : null
    }
    <label class="source-filter-search"
      >Search ${declaration?.noun?.many || kind}<input
        type="search"
        value=${query}
        maxlength="256"
        onInput=${(event) => setQuery(event.currentTarget.value)}
    /></label>
    ${visible.pending ? html`<p role="status">Loading source options…</p>` : null}
    ${
      visible.error
        ? html`<div role="status">
            <p>${visible.error}</p>
            <button type="button" class="btn-secondary" onClick=${() => load(null, false)}>
              Retry options
            </button>
          </div>`
        : null
    }
    <ul class="source-filter-options">
      ${visible.items.map(
        (item) =>
          html`<li key=${scopeRefKey(item.ref)}>
            <label
              ><input
                type="checkbox"
                checked=${keys.has(scopeRefKey(item.ref))}
                disabled=${disabled}
                onChange=${() => onToggle(item.ref, item)}
              /><span>${item.label}<small>${item.count} matching records</small></span></label
            >
            ${
              kind === "folder" && item.hasChildren
                ? html`<button
                    type="button"
                    class="btn-tiny"
                    aria-label=${`Open ${item.label}`}
                    onClick=${() => {
                      setQuery("");
                      setTrail([...trail, { id: item.ref.id, label: item.label }]);
                    }}
                  >
                    <span aria-hidden="true">›</span>
                  </button>`
                : null
            }
          </li>`,
      )}
    </ul>
    ${!visible.pending && !visible.error && !visible.items.length ? html`<p>No matching options. Existing selections remain listed above.</p>` : null}
    ${visible.nextCursor ? html`<button type="button" class="btn-secondary" disabled=${visible.pending} onClick=${() => load(visible.nextCursor, true)}>Load more</button>` : null}
    ${
      kind === "participant" && types.length
        ? html`<details
            class="source-filter-typed-disclosure"
            open=${typedOpen}
            onToggle=${(event) => setTypedOpen(event.currentTarget.open)}
          >
            <summary>Add an exact identifier</summary>
            <fieldset class="source-filter-typed" disabled=${disabled}>
              <legend class="sr-only">Exact identifier</legend>
              <p>
                Saved identifiers are snapshots. Later name changes and person merges do not change
                this filter.
              </p>
              <select
                aria-label="Identifier type"
                value=${typedType}
                onChange=${(event) => setType(event.currentTarget.value)}
              >
                ${types.map((item) => html`<option value=${item}>${item === "phone" ? "Phone number" : item === "email" ? "Email address" : "Email domain"}</option>`)}
              </select>
              <input
                aria-label="Exact identifier"
                value=${typed}
                onInput=${(event) => {
                  setTyped(event.currentTarget.value);
                  setTypedError("");
                }}
                placeholder=${typedType === "phone" ? "+15550100123" : typedType === "domain" ? "example.com" : "person@example.com"}
              />
              <button
                type="button"
                class="btn-secondary"
                onClick=${() => {
                  const ref = typedParticipant(typedType, typed);
                  if (!ref) {
                    setTypedError(
                      "Enter a valid exact identifier. Phone numbers need an international + prefix.",
                    );
                    return;
                  }
                  if (!keys.has(scopeRefKey(ref))) onToggle(ref);
                  setTyped("");
                }}
              >
                Add identifier
              </button>
              ${typedError ? html`<p class="access-field-error" role="alert">${typedError}</p>` : null}
            </fieldset>
          </details>`
        : null
    }
  </section>`;
}
