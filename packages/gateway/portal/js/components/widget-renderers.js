// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Generic hosted-widget renderer loader for the `link-widget` AuthType.
//
// Providers declare widget renderer modules on their source/provider
// descriptors. The collector registers those modules with the gateway, the
// gateway exposes a same-origin manifest + module route, and the portal imports
// by opaque widget `kind`. Vendor SDK URLs, payload fields, callback semantics,
// and teardown details stay inside the declaring provider package.

const RENDERER_MANIFEST_URL = "/portal/widget-renderers.json";

let manifestPromise = null;
const rendererCache = new Map();

/**
 * Lazily inject a third-party `<script src>` once and resolve when it has
 * loaded. Provider-owned widget renderer modules use this for their vendor
 * SDKs; shared portal code does not know which vendor is being loaded.
 */
export function loadExternalScript(src) {
  return new Promise((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("no document"));
      return;
    }
    const existing = document.querySelector(`script[data-widget-src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === "true") {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), {
        once: true,
      });
      return;
    }
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.dataset.widgetSrc = src;
    el.addEventListener(
      "load",
      () => {
        el.dataset.loaded = "true";
        resolve();
      },
      { once: true },
    );
    el.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
    document.head.appendChild(el);
  });
}

async function rendererManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch(RENDERER_MANIFEST_URL, { credentials: "same-origin" })
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load widget renderer manifest (${res.status})`);
        return res.json();
      })
      .then((body) => {
        const renderers = body?.renderers && typeof body.renderers === "object" ? body.renderers : {};
        if (Object.keys(renderers).length === 0) manifestPromise = null;
        return renderers;
      })
      .catch(() => {
        manifestPromise = null;
        return {};
      });
  }
  return manifestPromise;
}

async function loadWidgetRenderer(kind) {
  if (typeof kind !== "string" || !kind) return null;
  if (rendererCache.has(kind)) return rendererCache.get(kind);
  let manifest = await rendererManifest();
  let url = manifest[kind];
  if (typeof url !== "string" || !url) {
    manifestPromise = null;
    manifest = await rendererManifest();
    url = manifest[kind];
  }
  if (typeof url !== "string" || !url) return null;
  let mod;
  try {
    mod = await import(url);
  } catch {
    return null;
  }
  const open = typeof mod.open === "function" ? mod.open : null;
  if (open) rendererCache.set(kind, open);
  return open;
}

/**
 * Return a generic async renderer wrapper for `kind`, or null for clearly
 * invalid input. Missing server-side registrations surface through `onError`
 * when the wrapper runs, which keeps the auth UI fallback asynchronous.
 */
export function getWidgetRenderer(kind) {
  if (typeof kind !== "string" || !kind) return null;
  return async (args) => {
    const renderer = await loadWidgetRenderer(kind);
    if (!renderer) {
      args?.onError?.(`This client can't render the ${kind} sign-in widget.`);
      return () => {};
    }
    return renderer(args);
  };
}

/** Test-only reset for the module-level manifest and renderer caches. */
export function resetWidgetRendererLoaderForTests() {
  manifestPromise = null;
  rendererCache.clear();
}
