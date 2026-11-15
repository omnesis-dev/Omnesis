// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * One card of a Models provider grid — a provider logo (or a neutral glyph),
 * a title and one muted line — and the glyphs used where a provider has no
 * logo. Shared by the capability model picker, the Add-backend grid and the
 * Decision model's provider picker.
 */

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { ProviderIcon, mayHaveServedLogo } from "./provider-icon.js";
import { CapabilityIcon } from "./capability-icon.js";

// Whether the gateway serves a logo for a provider id, once known. The logos
// come from the models.dev catalog, which does not cover every provider.
const logoAvailability = new Map();

function probeLogo(providerId) {
  if (logoAvailability.has(providerId)) return logoAvailability.get(providerId);
  const probe = new Promise((resolve) => {
    if (typeof Image === "undefined") { resolve(true); return; }
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = `/model-logos/${encodeURIComponent(providerId)}.svg`;
  }).then((ok) => {
    logoAvailability.set(providerId, ok);
    return ok;
  });
  logoAvailability.set(providerId, probe);
  return probe;
}

/**
 * A provider logo that falls back to `fallback` when the gateway has none.
 * Without a fallback it is the plain ProviderIcon.
 */
export function ProviderLogo({ providerId, fallback, size }) {
  const known = providerId ? logoAvailability.get(providerId) : false;
  const [available, setAvailable] = useState(typeof known === "boolean" ? known : null);
  useEffect(() => {
    if (!mayHaveServedLogo(providerId) || !fallback || typeof known === "boolean") return undefined;
    let live = true;
    void probeLogo(providerId).then((ok) => { if (live) setAvailable(ok); });
    return () => { live = false; };
  }, [providerId]);
  if (!providerId) return fallback ?? null;
  // Built-in runtimes have no logo by design; they keep the plain icon (none).
  if (!mayHaveServedLogo(providerId)) return html`<${ProviderIcon} providerId=${providerId} size=${size} />`;
  if (fallback && (typeof known === "boolean" ? known : available) === false) return fallback;
  return html`<${ProviderIcon} providerId=${providerId} size=${size} />`;
}

/** A letter badge for a provider whose logo the gateway does not have. */
export function Monogram({ name }) {
  const letter = String(name ?? "?").trim().charAt(0).toUpperCase() || "?";
  return html`<span class="provider-monogram" aria-hidden="true">${letter}</span>`;
}

/**
 * `compact` lays the card out as one row (logo beside title and subtitle),
 * for grids with many providers.
 */
export function BackendOptionCard({ providerId, fallbackGlyph, title, subtitle, muted, compact, onClick }) {
  const icon = html`<span class="backend-opt-icon">
    ${compact
      ? html`<${ProviderLogo} providerId=${providerId} fallback=${fallbackGlyph} size=${22} />`
      : html`${providerId ? html`<${ProviderIcon} providerId=${providerId} size=${22} />` : null}${fallbackGlyph ?? null}`}
  </span>`;
  if (compact) {
    return html`
      <button class="backend-opt backend-opt--row ${muted ? "backend-opt--muted" : ""}" onClick=${onClick}>
        ${icon}
        <span class="backend-opt-text">
          <span class="backend-opt-title">${title}</span>
          <span class="backend-opt-sub">${subtitle}</span>
        </span>
      </button>
    `;
  }
  return html`
    <button class="backend-opt ${muted ? "backend-opt--muted" : ""}" onClick=${onClick}>
      ${icon}
      <span class="backend-opt-title">${title}</span>
      <span class="backend-opt-sub">${subtitle}</span>
    </button>
  `;
}

/** A neutral "stack" glyph for servers with no provider brand. */
export const LOCAL_GLYPH = html`<svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="6" rx="1" /><rect x="3" y="14" width="18" height="6" rx="1" /></svg>`;
/** TypeSafe has no served provider logo; it wears the Decision model's own glyph. */
export const TYPESAFE_GLYPH = html`<${CapabilityIcon} icon="scale" size=${22} />`;
/** A "plus" glyph for the add-custom card. */
export const ADD_GLYPH = html`<svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14" /></svg>`;
