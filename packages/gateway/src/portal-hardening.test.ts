// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Structural assertions for the portal security-hardening bundle:
// every check here is something that, if it silently regresses,
// re-opens a P0 finding (stored XSS, CDN hot-link, missing CSP, 401
// not surfaced).
//
// Behaviour-level tests (CSP headers on responses, vendored route
// content) live in `server.test.ts`; this file is the static
// safety-net that watches the source files themselves.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORTAL = join(HERE, "..", "portal");

function readPortal(rel: string): string {
  return readFileSync(join(PORTAL, rel), "utf8");
}

describe("portal markdown sanitization", () => {
  test("renderMarkdown imports DOMPurify and runs marked output through sanitize()", () => {
    const src = readPortal("js/lib/markdown.js");
    expect(src).toMatch(/import\s+DOMPurify\s+from\s+["']dompurify["']/);
    expect(src).toMatch(/marked\.parse\s*\(/);
    expect(src).toMatch(/DOMPurify\.sanitize\s*\(/);
    // sanitize must wrap the marked output, not run on the raw input
    // (otherwise tag-shaped markdown survives as markup but the
    // dangerous payload is gone — the inverse of what we want).
    const sanitizeIdx = src.indexOf("DOMPurify.sanitize");
    const parseIdx = src.indexOf("marked.parse");
    expect(parseIdx).toBeGreaterThan(-1);
    expect(sanitizeIdx).toBeGreaterThan(parseIdx);
  });

  test("DOMPurify config disables data attributes + unknown protocols", () => {
    const src = readPortal("js/lib/markdown.js");
    expect(src).toMatch(/ALLOW_DATA_ATTR\s*:\s*false/);
    expect(src).toMatch(/ALLOW_UNKNOWN_PROTOCOLS\s*:\s*false/);
  });
});

describe("portal vendored deps", () => {
  test("every importmap entry resolves to a real file under /portal/vendor/", () => {
    const html = readPortal("index.html");
    const importmapMatch = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    expect(importmapMatch).not.toBeNull();
    const importmap = JSON.parse(importmapMatch![1]);
    const entries = Object.entries(importmap.imports as Record<string, string>);
    expect(entries.length).toBeGreaterThan(0);

    for (const [key, url] of entries) {
      expect(url, `import "${key}" should be a /portal/vendor/ path`).toMatch(
        /^\/portal\/vendor\//,
      );
      // url is e.g. "/portal/vendor/preact.js" — strip the leading
      // "/portal/" to land at the on-disk path.
      const onDisk = join(PORTAL, url.replace(/^\/portal\//, ""));
      expect(existsSync(onDisk), `vendored bundle missing on disk for "${key}": ${onDisk}`).toBe(
        true,
      );
    }
  });

  test("the importmap precedes everything that triggers a module load", () => {
    const html = readPortal("index.html");

    // An import map is only consulted for module loads that begin AFTER it is
    // parsed. Anything that starts a module load earlier — a modulepreload
    // link, a module script, a script preload — races the parser: the map can
    // lose, and every bare specifier ("htm/preact", "preact") then fails to
    // resolve and the SPA renders an empty page. Cache warmth decides the
    // race, so it surfaces on a warm navigation (a back that re-parses this
    // document) and not on a cold load.
    //
    // Walk the tags in document order and classify rather than matching the
    // two spellings that happen to exist today, so a future `rel="prefetch"`
    // or inline module script is covered too.
    const importMapAt = html.search(/<script[^>]*\btype\s*=\s*["']importmap["']/i);
    expect(importMapAt, "index.html must declare an import map").toBeGreaterThan(-1);

    const triggers: Array<{ at: number; tag: string }> = [];
    for (const m of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
      const tag = m[0];
      const at = m.index;
      const isModuleScript = /\btype\s*=\s*["']module["']/i.test(tag);
      const isModulePreload = /\brel\s*=\s*["']modulepreload["']/i.test(tag);
      const isScriptPreload =
        /\brel\s*=\s*["'](?:preload|prefetch)["']/i.test(tag) &&
        /\bas\s*=\s*["']script["']/i.test(tag);
      if (isModuleScript || isModulePreload || isScriptPreload) triggers.push({ at, tag });
    }
    expect(triggers.length, "expected at least one module load in index.html").toBeGreaterThan(0);

    const first = triggers[0];
    expect(
      importMapAt,
      `the import map must be declared before the first module load: ${first.tag}`,
    ).toBeLessThan(first.at);
  });

  test("dompurify is in the importmap so markdown.js can import it (P0 wiring)", () => {
    const html = readPortal("index.html");
    expect(html).toMatch(/"dompurify"\s*:\s*"\/portal\/vendor\/dompurify\.js"/);
  });

  test("no live esm.sh URLs in the portal tree", () => {
    function* walk(dir: string): Generator<string> {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "vendor") continue; // bundles minify with no URL embeds
        const full = join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(full);
        else yield full;
      }
    }
    const offenders: string[] = [];
    for (const file of walk(PORTAL)) {
      if (!/\.(js|html|css)$/.test(file)) continue;
      const content = readFileSync(file, "utf8");
      // Live URLs would look like https://esm.sh/<something> in
      // source; comment lines describing the migration are allowed.
      // We accept the explanatory comment in index.html that names
      // the migration source by URL.
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        if (!/https?:\/\/esm\.sh/.test(line)) return;
        // skip explanatory comments that contain "from https://esm.sh/" — these document the migration
        if (/from https?:\/\/esm\.sh\/?\./.test(line)) return;
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, "live esm.sh references found:\n" + offenders.join("\n")).toEqual([]);
  });
});

describe("portal hosted-widget encapsulation", () => {
  test("shared portal widget loader contains no Plaid-specific SDK knowledge", () => {
    const src = readPortal("js/components/widget-renderers.js");
    expect(src).not.toMatch(/plaid/i);
    expect(src).not.toMatch(/link-initialize/);
  });
});

describe("portal 401 session-expired event", () => {
  test("api.js exports apiFetch and dispatches omnesis:session-expired on 401", () => {
    const src = readPortal("js/api.js");
    expect(src).toMatch(/export\s+async\s+function\s+apiFetch/);
    expect(src).toMatch(/omnesis:session-expired/);
    expect(src).toMatch(/res\.status\s*===\s*401/);
    expect(src).toMatch(/dispatchEvent\s*\(/);
  });

  test("app.js subscribes to omnesis:session-expired and re-renders LoginView", () => {
    const src = readPortal("js/app.js");
    expect(src).toMatch(/addEventListener\(\s*["']omnesis:session-expired["']/);
    // The handler must short-circuit App's usual render path with
    // LoginView so the user gets a re-login prompt instead of a
    // sea of polling-error banners.
    expect(src).toMatch(/sessionExpired/);
    expect(src).toMatch(/LoginView/);
  });

  test("config.js subscribes to authenticated config SSE events", () => {
    const src = readPortal("js/views/config.js");
    expect(src).toMatch(/new EventSource\(\s*["']\/admin\/config\/events["']/);
    expect(src).not.toMatch(/\/device\/ws/);
  });
});
