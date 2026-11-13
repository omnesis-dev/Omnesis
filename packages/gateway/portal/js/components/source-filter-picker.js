// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  scopeKindNoun,
  scopeLevelNoun,
  scopeNestingHint,
  useScopeLabelGeneration,
} from "./source-filter-labels.js";
import { readFilterOptions } from "./source-filter-requests.js";
import { COUNT_POLL_MS, filterApiError } from "./source-filter-preview.js";
import { CountSpinner, CountingRecords } from "./source-filter-table.js";
import { sourceId as accountIdOf } from "./grant-builder-state.js";
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
  readiness,
  onReadiness,
  overlay = false,
  open = false,
  onOpen,
  onClose,
  showExact = true,
}) {
  const root = useRef(null);
  const results = useRef(null);
  const restoringFocus = useRef(false);
  const resultsId = useId();
  const visibleActive = active && (!overlay || open);
  const sourceId = accountIdOf(source);
  const sourceKey = `${sourceId}:${kind}`;
  const saved = memory?.get(sourceKey);
  const [query, setQuery] = useState(saved?.query ?? "");
  const [trail, setTrail] = useState(saved?.trail ?? []);
  const positions = useRef(saved?.positions ?? new Map());
  // Option pages belong to this child draft. They never validate Apply: that
  // always requires a fresh exact-policy preview.
  const catalogues = useRef(saved?.catalogues ?? new Map());
  const parentId = query ? undefined : trail.at(-1)?.id;
  const generation = useScopeLabelGeneration();
  const identity = JSON.stringify([
    generation,
    requestIdentity(sourceId, kind, query, parentId),
    trail.map((item) => item.id),
  ]);
  const scrollKey = identity;
  const current = useRef(identity);
  current.current = identity;
  const requests = useRef(new Set());
  const inFlight = useRef(false);
  const [state, setState] = useState(() => {
    const retained = catalogues.current.get(identity);
    return retained
      ? { ...retained, retained: true }
      : { identity, items: [], pending: true, nextCursor: null, error: "" };
  });
  const declaration = source.scopes?.items?.find((item) => item.kind === kind);
  const identifierTypes = declaration?.identifiers ?? [];

  // A quiet load replaces the list it shows without a loading state in between.
  async function load(cursor, append, quiet = false) {
    if ((append || quiet) && inFlight.current) return;
    inFlight.current = true;
    const controller = new AbortController();
    requests.current.add(controller);
    const requestKey = identity;
    if (!quiet)
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
      setState((old) => {
        const next = {
          identity,
          items:
            append && old.identity === identity ? [...old.items, ...result.items] : result.items,
          nextCursor: result.nextCursor,
          readiness: result.readiness,
          pending: false,
          error: "",
          retained: false,
        };
        catalogues.current.delete(identity);
        catalogues.current.set(identity, next);
        while (catalogues.current.size > 16) {
          const oldest = catalogues.current.keys().next().value;
          catalogues.current.delete(oldest);
          positions.current.delete(oldest);
        }
        return next;
      });
      if (Array.isArray(result.readiness)) onReadiness?.(result.readiness);
    } catch (error) {
      if (!quiet && !controller.signal.aborted && current.current === requestKey)
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
    if (!visibleActive) return;
    const retained = catalogues.current.get(identity);
    if (retained) {
      catalogues.current.delete(identity);
      catalogues.current.set(identity, retained);
      setState({ ...retained, retained: true });
    }
    const timer = retained ? null : setTimeout(() => load(null, false), 150);
    return () => {
      clearTimeout(timer);
      for (const controller of requests.current) controller.abort();
      inFlight.current = false;
    };
  }, [identity, visibleActive]);
  // Keep each search and folder location at its own scroll position.
  // Option pages remain hints; only the exact-policy preview authorizes Apply.
  useLayoutEffect(() => {
    const element = scrollContainer?.current ?? results.current;
    if (!element || !visibleActive) return;
    const restore = () => {
      element.scrollTop = positions.current.get(scrollKey) ?? 0;
    };
    restore();
    const remember = () => positions.current.set(scrollKey, element.scrollTop);
    element.addEventListener("scroll", remember);
    return () => {
      element.removeEventListener("scroll", remember);
      memory?.set(sourceKey, {
        query,
        trail,
        positions: positions.current,
        catalogues: catalogues.current,
      });
    };
  }, [scrollKey, visibleActive]);
  useLayoutEffect(() => {
    const element = scrollContainer?.current ?? results.current;
    if (visibleActive && state.identity === identity && !state.pending && element)
      element.scrollTop = positions.current.get(scrollKey) ?? 0;
  }, [scrollKey, visibleActive, state.pending]);
  useEffect(() => {
    if (!overlay || !open) return;
    const dismiss = (event) => {
      if (!root.current?.contains(event.target)) onClose?.();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [overlay, open, onClose]);
  const retained = catalogues.current.get(identity);
  const visible =
    state.identity === identity
      ? state
      : retained
        ? { ...retained, retained: true }
        : { items: [], pending: true };
  const currentReadiness = readiness ?? visible.readiness ?? source.scopeReadiness;
  const focusSearch = () =>
    root.current?.querySelector("input[type=search]")?.focus({ preventScroll: true });
  const navigate = (next) => {
    focusSearch();
    setQuery("");
    setTrail(next);
  };
  const counting = Boolean(currentReadiness?.some((item) => item.kind === kind && !item.ready));
  // While the account's counts are still being worked out, the first page is
  // read again until they arrive; pages loaded after it wait for the next search.
  useEffect(() => {
    if (!visibleActive || !counting || visible.pending || visible.error) return;
    const timer = setTimeout(() => load(null, false, true), COUNT_POLL_MS);
    return () => clearTimeout(timer);
  }, [identity, visibleActive, counting, visible.pending, visible.error, visible.items]);
  const location = trail.at(-1);
  const locationRef = location ? { kind: "folder", id: location.id } : null;
  // A source that names the levels of its tree has a word for each; the
  // picker says which level a location, a list and a search result are at.
  const leveled = Array.isArray(declaration?.levels) && declaration.levels.length > 0;
  const allRoots = `All ${scopeLevelNoun(source, kind, 0, true)}`;
  const nestingHint = scopeNestingHint(source, kind, query ? undefined : trail.length);
  const levelPrefix = (item) => {
    if (!leveled || !Number.isInteger(item.depth)) return "";
    const noun = scopeLevelNoun(source, kind, item.depth);
    return `${noun.charAt(0).toLocaleUpperCase()}${noun.slice(1)} · `;
  };
  const keys = new Set(selected.map(scopeRefKey));
  return html`<section
    class=${`source-filter-picker${overlay ? " source-filter-picker-overlay" : ""}`}
    aria-label=${`Choose ${scopeKindNoun(source, kind, true)}`}
    ref=${root}
    onFocusOut=${(event) => {
      if (overlay && open && event.relatedTarget && !root.current?.contains(event.relatedTarget))
        onClose?.();
    }}
    onKeyDown=${(event) => {
      if (!overlay || !open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        restoringFocus.current = true;
        onClose?.();
        root.current?.querySelector("input[type=search]")?.focus();
        restoringFocus.current = false;
      }
      if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        const controls = [
          ...(results.current?.querySelectorAll("input[type=checkbox]:not(:disabled)") ?? []),
        ];
        if (!controls.length) return;
        event.preventDefault();
        const index = controls.indexOf(document.activeElement);
        controls[
          index < 0
            ? event.key === "ArrowDown"
              ? 0
              : controls.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + controls.length) % controls.length
        ]?.focus();
      }
    }}
  >
    <label class="source-filter-search"
      >Search ${scopeKindNoun(source, kind, kind === "participant")}<input
        type="search"
        value=${query}
        maxlength="256"
        aria-expanded=${overlay ? open : undefined}
        aria-controls=${overlay ? resultsId : undefined}
        onFocus=${() => {
          if (!restoringFocus.current) onOpen?.();
        }}
        onInput=${(event) => {
          setQuery(event.currentTarget.value);
          onOpen?.();
        }}
    /></label>
    <div class="source-filter-results" id=${resultsId} hidden=${overlay && !open} ref=${results}>
      ${
        kind === "folder"
          ? html`<nav class="source-filter-breadcrumbs" aria-label="Location">
                <span class="source-filter-location">Location</span>
                ${location ? html`<button type="button" onClick=${() => navigate([])}>${allRoots}</button>` : html`<span aria-current="location">${allRoots}</span>`}${trail.map((item, index) => (index === trail.length - 1 ? html`<span aria-current="location">${item.label}</span>` : html`<button type="button" onClick=${() => navigate(trail.slice(0, index + 1))}>${item.label}</button>`))}
              </nav>
              ${locationRef ? html`<label class="source-filter-select-location"><input type="checkbox" checked=${keys.has(scopeRefKey(locationRef))} disabled=${disabled} onChange=${() => onToggle(locationRef, { ref: locationRef, label: location.label, ...(leveled ? { depth: trail.length - 1 } : {}) })} />Select this ${scopeLevelNoun(source, kind, trail.length - 1)}</label>` : null}
              ${nestingHint ? html`<p class="filter-option-hint">${nestingHint}</p>` : null}`
          : null
      }
      ${visible.pending ? html`<p role="status">Loading source options…</p>` : null}
      ${
        visible.error
          ? html`<div role="status">
              <p>${visible.error}</p>
              <button
                type="button"
                class="btn-secondary"
                onClick=${() => {
                  focusSearch();
                  load(null, false);
                }}
              >
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
                /><span>${item.label}</span>${Number.isFinite(item.count) ? html`<small>${levelPrefix(item)}${item.count.toLocaleString()} matching</small>` : html`<${CountSpinner} />`}</label
              >
              ${kind === "folder" && item.hasChildren ? html`<button type="button" class="btn-tiny" aria-label=${`Open ${item.label}`} onClick=${() => navigate([...trail, { id: item.ref.id, label: item.label }])}><span aria-hidden="true">›</span></button>` : null}
            </li>`,
        )}
      </ul>
      ${!visible.pending && !visible.error && !visible.items.length ? (counting ? html`<p role="status"><${CountingRecords} /></p>` : html`<p>No matching options.</p>`) : null}
      ${
        visible.nextCursor
          ? html`<button
              type="button"
              class="btn-secondary"
              disabled=${visible.pending}
              onClick=${() => {
                focusSearch();
                load(visible.nextCursor, true);
              }}
            >
              Load more
            </button>`
          : null
      }
    </div>
    ${showExact && kind === "participant" && identifierTypes.length ? html`<${ExactIdentifierInput} types=${identifierTypes} selected=${selected} onToggle=${onToggle} disabled=${disabled} />` : null}
  </section>`;
}

/** What a typed address that names no address of the chosen type is told. */
const INVALID_ADDRESS_MESSAGES = {
  phone: "Enter a valid phone number. Include the international country code.",
  email: "Enter a valid email address.",
  domain: "Enter a valid domain.",
};

export function ExactIdentifierInput({
  types: declaredTypes,
  selected = [],
  onToggle,
  disabled = false,
}) {
  const types = ["email", "phone", "domain"].filter((item) => declaredTypes.includes(item));
  const nouns = ["email", "domain", "phone"]
    .filter((item) => types.includes(item))
    .map((item) => (item === "phone" ? "phone number" : item));
  const prompt = `Add ${nouns[0] === "email" ? "an" : "a"} ${nouns.length > 1 ? `${nouns.slice(0, -1).join(", ")} or ${nouns.at(-1)}` : nouns[0]}`;
  const [type, setType] = useState(types[0]);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const typedType = types.includes(type) ? type : types[0];
  const add = () => {
    const ref = typedParticipant(typedType, typed);
    if (!ref) {
      setError(INVALID_ADDRESS_MESSAGES[typedType]);
      return;
    }
    if (!selected.some((item) => scopeRefKey(item) === scopeRefKey(ref))) onToggle(ref);
    setTyped("");
  };
  if (!types.length) return null;
  return html`<div class="source-filter-exact">
    <fieldset class="source-filter-typed" disabled=${disabled}>
      <legend class="sr-only">${prompt}</legend>
      <span>${prompt}</span>
      <select
        aria-label="Type"
        value=${typedType}
        onChange=${(event) => {
          setType(event.currentTarget.value);
          setError("");
        }}
      >
        ${types.map((item) => html`<option value=${item}>${item === "phone" ? "Phone number" : item === "email" ? "Email address" : "Domain"}</option>`)}
      </select>
      <input
        aria-label="Value"
        value=${typed}
        maxlength="512"
        placeholder=${typedType === "phone" ? "+15550100123" : typedType === "domain" ? "example.com" : "person@example.com"}
        onInput=${(event) => {
          setTyped(event.currentTarget.value);
          setError("");
        }}
        onKeyDown=${(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            add();
          }
        }}
      />
      <button type="button" class="btn-secondary" onClick=${add}>Add</button>
    </fieldset>
    ${error ? html`<p class="access-field-error" role="alert">${error}</p>` : null}
  </div>`;
}
