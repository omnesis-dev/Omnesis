// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import { checkFilterIdentifier } from "../api.js";
import { useScopeLabelGeneration } from "./source-filter-labels.js";
import { readFilterOptions } from "./source-filter-requests.js";
import {
  fieldLevelNoun,
  fieldNoun,
  filterApiError,
} from "./source-filter-fields.js";
import { CountSpinner } from "./source-filter-table.js";
import { sourceId as accountIdOf } from "./grant-builder-state.js";
import { identifierRef, isDeviceRef, scopeRefKey } from "./source-filter-state.js";

/** Pages of one field's items kept per picker, so going back up a tree is instant. */
const RETAINED_PAGES = 16;

/**
 * One field's items, to tick into a filter: searched, or browsed level by
 * level when the field is a tree. A field whose items belong to a device
 * starts at the devices when the account has several. Inside a tree a row
 * shows its own short name; a search result shows its full name.
 */
export function SourceFilterPicker({
  source,
  editor,
  field,
  selected,
  onToggle,
  disabled = false,
  active = true,
  scrollContainer,
  memory,
  overlay = false,
  open = false,
  onOpen,
  onClose,
}) {
  const root = useRef(null);
  const results = useRef(null);
  const restoringFocus = useRef(false);
  const resultsId = useId();
  const visibleActive = active && (!overlay || open);
  const sourceId = accountIdOf(source);
  const sourceKey = `${sourceId}:${field.field}`;
  const saved = memory?.get(sourceKey);
  const [query, setQuery] = useState(saved?.query ?? "");
  const [trail, setTrail] = useState(saved?.trail ?? []);
  const positions = useRef(saved?.positions ?? new Map());
  const catalogues = useRef(saved?.catalogues ?? new Map());
  const deviceLevel = Boolean(editor?.showDeviceLevel) && field.scope === "device";
  const browsable = field.picker === "tree" || deviceLevel;
  const location = trail.at(-1);
  const device = deviceLevel ? trail[0]?.ref.device : undefined;
  const parentId = query || !location || isDeviceRef(location.ref) ? undefined : location.ref.id;
  const request = {
    field: field.field,
    ...(query ? { q: query } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
    ...(device ? { device } : {}),
  };
  const generation = useScopeLabelGeneration();
  const identity = JSON.stringify([generation, sourceId, request]);
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
        { ...request, ...(cursor ? { cursor } : {}) },
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
          retryAfterMs: result.retryAfterMs,
          pending: false,
          error: "",
          retained: false,
        };
        catalogues.current.delete(identity);
        catalogues.current.set(identity, next);
        while (catalogues.current.size > RETAINED_PAGES) {
          const oldest = catalogues.current.keys().next().value;
          catalogues.current.delete(oldest);
          positions.current.delete(oldest);
        }
        return next;
      });
    } catch (error) {
      if (!quiet && !controller.signal.aborted && current.current === requestKey)
        setState((old) => ({
          ...old,
          identity,
          pending: false,
          error: filterApiError(error, "This list could not be loaded. Your selection is kept."),
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
  // Keep each search and tree location at its own scroll position.
  useLayoutEffect(() => {
    const element = scrollContainer?.current ?? results.current;
    if (!element || !visibleActive) return;
    element.scrollTop = positions.current.get(identity) ?? 0;
    const remember = () => positions.current.set(identity, element.scrollTop);
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
  }, [identity, visibleActive]);
  useLayoutEffect(() => {
    const element = scrollContainer?.current ?? results.current;
    if (visibleActive && state.identity === identity && !state.pending && element)
      element.scrollTop = positions.current.get(identity) ?? 0;
  }, [identity, visibleActive, state.pending]);
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
  // Counts the gateway is still working out are asked for again when it says.
  useEffect(() => {
    if (!visibleActive || visible.pending || visible.error || !visible.retryAfterMs) return;
    const timer = setTimeout(() => load(null, false, true), visible.retryAfterMs);
    return () => clearTimeout(timer);
  }, [identity, visibleActive, visible.pending, visible.error, visible.items]);
  const focusSearch = () =>
    root.current?.querySelector("input[type=search]")?.focus({ preventScroll: true });
  const navigate = (next) => {
    focusSearch();
    setQuery("");
    setTrail(next);
  };
  const levelNoun = (ref, depth) => (isDeviceRef(ref) ? "device" : fieldLevelNoun(field, depth));
  const rootLabel = deviceLevel ? "All devices" : `All ${fieldLevelNoun(field, 0, true)}`;
  const many = fieldNoun(field, true);
  const keys = new Set(selected.map(scopeRefKey));
  const openable = (item) => browsable && !query && (item.hasChildren || isDeviceRef(item.ref));
  return html`<section
    class=${`source-filter-picker${overlay ? " source-filter-picker-overlay" : ""}`}
    aria-label=${`Choose ${many}`}
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
        focusSearch();
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
      >Search ${many}<input
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
        browsable && !query
          ? html`<nav class="source-filter-breadcrumbs" aria-label="Location">
                <span class="source-filter-location">Location</span>
                ${location ? html`<button type="button" onClick=${() => navigate([])}>${rootLabel}</button>` : html`<span aria-current="location">${rootLabel}</span>`}${trail.map((item, index) => (index === trail.length - 1 ? html`<span aria-current="location">${item.label}</span>` : html`<button type="button" onClick=${() => navigate(trail.slice(0, index + 1))}>${item.label}</button>`))}
              </nav>
              ${field.insideText ? html`<p class="filter-option-hint">${field.insideText}</p>` : null}
              ${location ? html`<label class="source-filter-select-location"><input type="checkbox" checked=${keys.has(scopeRefKey(location.ref))} disabled=${disabled} onChange=${() => onToggle(location.ref, location.item)} /><span>Select this ${levelNoun(location.ref, location.item.depth)}</span>${Number.isFinite(location.item.count) ? html`<small>${location.item.count.toLocaleString()} matching</small>` : null}</label>` : null}`
          : null
      }
      ${visible.pending ? html`<p role="status">Loading…</p>` : null}
      ${
        visible.error
          ? html`<div role="status" class="source-filter-count-error">
              <p>${visible.error}</p>
              <button
                type="button"
                class="btn-secondary"
                onClick=${() => {
                  focusSearch();
                  load(null, false);
                }}
              >
                Try again
              </button>
            </div>`
          : null
      }
      <ul class="source-filter-options">
        ${visible.items.map((item) => {
          const label = browsable && !query ? item.shortLabel || item.label : item.label;
          return html`<li key=${scopeRefKey(item.ref)}>
            <label
              ><input
                type="checkbox"
                checked=${keys.has(scopeRefKey(item.ref))}
                disabled=${disabled}
                onChange=${() => onToggle(item.ref, item)}
              /><span>${label}</span>${Number.isFinite(item.count) ? html`<small>${item.count.toLocaleString()} matching</small>` : html`<${CountSpinner} />`}</label
            >
            ${openable(item) ? html`<button type="button" class="btn-tiny" aria-label=${`Open ${label}`} onClick=${() => navigate([...trail, { ref: item.ref, label, item }])}><span aria-hidden="true">›</span></button>` : null}
          </li>`;
        })}
      </ul>
      ${!visible.pending && !visible.error && !visible.items.length ? html`<p>${query ? `No ${many} match this search.` : `No ${many} here.`}</p>` : null}
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
  </section>`;
}

/** Each address type: its option label, placeholder, noun and the article the noun takes. */
const IDENTIFIER_CHOICES = {
  email: ["Email address", "person@example.com", "email", "an"],
  domain: ["Domain", "example.com", "domain", "a"],
  phone: ["Phone number", "+15550100123", "phone number", "a"],
};

/**
 * An email, domain or phone number typed by hand. The gateway reads it into
 * its own spelling, or answers the sentence to show under the field.
 */
export function ExactIdentifierInput({
  types: declaredTypes,
  selected = [],
  onToggle,
  disabled = false,
}) {
  const types = ["email", "domain", "phone"].filter((item) => declaredTypes.includes(item));
  const nouns = types.map((item) => IDENTIFIER_CHOICES[item][2]);
  const article = types.length ? IDENTIFIER_CHOICES[types[0]][3] : "";
  const prompt = `Add ${article} ${nouns.length > 1 ? `${nouns.slice(0, -1).join(", ")} or ${nouns.at(-1)}` : nouns[0]}`;
  const [type, setType] = useState(types[0]);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  // One check at a time: a second press while the gateway reads the first is ignored.
  const inFlight = useRef(false);
  const typedType = types.includes(type) ? type : types[0];
  const add = async () => {
    if (inFlight.current || !typed.trim()) return;
    inFlight.current = true;
    setChecking(true);
    setError("");
    try {
      const result = await checkFilterIdentifier(typedType, typed);
      if (result?.identifier) {
        const ref = identifierRef(result.identifier);
        if (!selected.some((item) => scopeRefKey(item) === scopeRefKey(ref))) onToggle(ref);
        setTyped("");
      } else setError(result?.error || "This could not be checked. Try again.");
    } catch (failure) {
      setError(filterApiError(failure, "This could not be checked. Try again."));
    } finally {
      inFlight.current = false;
      setChecking(false);
    }
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
        ${types.map((item) => html`<option value=${item}>${IDENTIFIER_CHOICES[item][0]}</option>`)}
      </select>
      <input
        aria-label="Value"
        value=${typed}
        maxlength="512"
        placeholder=${IDENTIFIER_CHOICES[typedType][1]}
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
      <button type="button" class="btn-secondary" disabled=${checking} onClick=${add}>Add</button>
    </fieldset>
    ${error ? html`<p class="access-field-error" role="alert">${error}</p>` : null}
  </div>`;
}
