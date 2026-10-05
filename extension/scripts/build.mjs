// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Build the unpacked Manifest V3 extension into `extension/dist/` (or the
 * directory named by `OMNESIS_EXTENSION_DIST_DIR`).
 *
 * Bundler: esbuild. Each MV3 entry point (the service worker, options page,
 * popup, content script) is a separate ESM bundle; the static `public/` assets
 * (manifest, HTML, CSS, and the toolbar icons under `public/icons/`) are copied
 * verbatim. `OMNESIS_EXTENSION_STORE_BUILD=1` produces the minified,
 * source-map-free variant the store packager zips.
 *
 * The icons are the shared Omnesis app icon — the same mark the iOS and
 * Android apps use — pre-rendered from the master AppIcon to 16/32/48/128 px
 * and committed under `public/icons/`, so the extension carries the product's
 * real brand rather than a placeholder.
 *
 * Output `extension/dist/` is the directory you load via
 * chrome://extensions → "Load unpacked".
 */
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { applyTestManifest } from "./test-manifest.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = process.env.OMNESIS_EXTENSION_DIST_DIR ?? join(root, "dist");
const storeBuild = process.env.OMNESIS_EXTENSION_STORE_BUILD === "1";
// The headless E2E variant (see test-manifest.mjs). Mutually exclusive with a
// store build: the packager must never see a manifest with a pre-granted host
// permission or a pinned key.
const testBuild = process.env.OMNESIS_EXTENSION_TEST_BUILD === "1";
if (storeBuild && testBuild) {
  throw new Error("A store build and a test build cannot be requested together.");
}

async function main() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  await build({
    entryPoints: {
      background: join(root, "src/chrome/background.ts"),
      options: join(root, "src/chrome/options.ts"),
      popup: join(root, "src/chrome/popup.ts"),
      notes: join(root, "src/chrome/notes.ts"),
      content: join(root, "src/chrome/content.ts"),
    },
    outdir,
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    sourcemap: storeBuild ? false : true,
    minify: storeBuild,
    logLevel: "info",
  });

  // Static assets: manifest, HTML, CSS, and the committed brand icons under
  // public/icons/ — copied verbatim into the loadable bundle.
  await cp(join(root, "public"), outdir, { recursive: true });
  // Render independent pages from one template, using the same bundled components.
  const panelHtml = await readFile(join(root, "public/notes.html"), "utf8");
  const withoutSection = (html, section) => {
    const block = new RegExp(
      `    <!-- ${section}:start -->[\\s\\S]*?    <!-- ${section}:end -->\\n`,
    );
    if (!block.test(html)) throw new Error(`Missing ${section} section in panel template.`);
    return html.replace(block, "");
  };
  await writeFile(join(outdir, "notes.html"), withoutSection(panelHtml, "find"));
  await writeFile(
    join(outdir, "find.html"),
    withoutSection(panelHtml, "notes")
      .replace('<body class="notes-panel">', '<body class="notes-panel find-page">')
      .replace('<section id="find-section" hidden>', '<section id="find-section">'),
  );

  await cp(
    join(root, "../packages/gateway/portal/img/omnesis-mark.svg"),
    join(outdir, "icons/omnesis-mark.svg"),
  );

  const sharedStyles = await readFile(
    fileURLToPath(import.meta.resolve("@omnesis/gateway/agent-ui/styles.css")),
    "utf8",
  );
  await mkdir(join(outdir, "fonts"), { recursive: true });
  await cp(
    join(root, "../packages/gateway/portal/fonts/InterVariable.woff2"),
    join(outdir, "fonts/InterVariable.woff2"),
  );
  const fontStyles = `@font-face { font-family: "Inter"; src: url("fonts/InterVariable.woff2") format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; }`;
  const cssPath = join(outdir, "ui.css");
  await writeFile(cssPath, `${await readFile(cssPath, "utf8")}\n${fontStyles}\n${sharedStyles}`);

  if (testBuild) {
    const manifestPath = join(outdir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, `${JSON.stringify(applyTestManifest(manifest), null, 2)}\n`);
  }

  console.log(`Built unpacked extension → ${outdir}${testBuild ? " (test manifest)" : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
