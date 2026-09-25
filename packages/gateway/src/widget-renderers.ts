// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, sep } from "node:path";
import { createLogger } from "@omnesis/core";

const log = createLogger("gateway").child("widget-renderers");

export interface WidgetRendererRegistration {
  kind: string;
  modulePath: string;
}

const KIND_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

let renderers = new Map<string, string>();

function cleanKind(raw: string): string | null {
  const kind = raw.trim();
  return KIND_RE.test(kind) ? kind : null;
}

function pathIsInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith(sep));
}

function providerPackageRoot(filePath: string): string | null {
  let dir = dirname(filePath);
  while (dir !== dirname(dir)) {
    const pkgPath = `${dir}/package.json`;
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown };
        return typeof pkg.name === "string" && pkg.name.startsWith("@omnesis/provider-")
          ? dir
          : null;
      } catch {
        return null;
      }
    }
    dir = dirname(dir);
  }
  return null;
}

function canonicalRendererModulePath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!isAbsolute(trimmed) || extname(trimmed) !== ".js") return null;
  try {
    const real = realpathSync(trimmed);
    if (!statSync(real).isFile()) return null;
    const root = providerPackageRoot(real);
    if (!root) return null;
    const srcPortal = `${root}/src/portal`;
    const distPortal = `${root}/dist/portal`;
    if (!pathIsInside(srcPortal, real) && !pathIsInside(distPortal, real)) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * Replace the provider-owned hosted-widget renderer registry. Invalid entries
 * are dropped; the admin route validates before calling this, but this extra
 * guard keeps test and direct-call paths defensive.
 */
export function setWidgetRenderers(next: readonly WidgetRendererRegistration[]): void {
  const out = new Map<string, string>();
  for (const entry of next) {
    const kind = cleanKind(entry.kind);
    const modulePath = canonicalRendererModulePath(entry.modulePath);
    if (!kind || !modulePath) continue;
    out.set(kind, modulePath);
  }
  renderers = new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
  log.info(`registered ${renderers.size} widget renderer(s)`);
}

/** Return the same-origin portal URL for a registered widget kind. */
export function widgetRendererUrl(kind: string): string | null {
  const clean = cleanKind(kind);
  if (!clean || !renderers.has(clean)) return null;
  return `/portal/widget-renderers/${encodeURIComponent(clean)}/module.js`;
}

/** Resolve a registered renderer kind to its canonical filesystem path. */
export function resolveWidgetRendererModule(kind: string): string | null {
  const clean = cleanKind(kind);
  if (!clean) return null;
  const modulePath = renderers.get(clean);
  return modulePath ? canonicalRendererModulePath(modulePath) : null;
}

export function getWidgetRenderers(): WidgetRendererRegistration[] {
  return [...renderers.entries()].map(([kind, modulePath]) => ({ kind, modulePath }));
}

export function resetWidgetRenderers(): void {
  renderers = new Map();
}
