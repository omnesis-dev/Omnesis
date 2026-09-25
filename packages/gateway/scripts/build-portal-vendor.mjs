// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Vendors every CDN-loaded portal dependency locally so the running portal
// has zero runtime fetches against https://esm.sh/. This is the build half of
// finding — eliminate the single-point-of-compromise / privacy
// leak that came with hot-linking ESM modules from a third-party CDN.
//
// One esbuild invocation per importmap entry produces a self-contained ESM
// bundle under `packages/gateway/portal/vendor/<name>.js`. Cross-package deps
// (e.g. `@codemirror/view` -> `@codemirror/state`) are externalised so each
// vendored bundle defers to whatever the importmap resolves at load time —
// otherwise we'd duplicate `@codemirror/state` inside every editor bundle.
//
// `legalComments: "external"` peels every `/*! … */` license header out of the
// minified bundle into a sibling `<bundle>.LEGAL.txt`, which keeps the served
// JS lean while preserving attributions for redistribution.

import { build } from "esbuild";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gatewayRoot = dirname(__dirname);
const vendorDir = join(gatewayRoot, "portal", "vendor");

/**
 * One row per importmap entry. `entry` is what esbuild resolves
 * (passed as the bare module specifier to `stdin` so npm resolution kicks in
 * from the gateway package's perspective). `externals` are bare module
 * specifiers that should NOT be bundled — at runtime the importmap will
 * resolve them to their own vendor file.
 */
const TARGETS = [
  { key: "preact", out: "preact.js", entry: "preact", externals: [], hasDefault: false },
  {
    key: "preact/hooks",
    out: "preact-hooks.js",
    entry: "preact/hooks",
    externals: ["preact"],
    hasDefault: false,
  },
  {
    key: "htm/preact",
    out: "htm-preact.js",
    entry: "htm/preact",
    externals: ["preact"],
    hasDefault: false,
  },
  { key: "marked", out: "marked.js", entry: "marked", externals: [], hasDefault: false },
  { key: "dompurify", out: "dompurify.js", entry: "dompurify", externals: [], hasDefault: true },
  { key: "qrcode", out: "qrcode.js", entry: "qrcode", externals: [], hasDefault: true },
  {
    key: "@codemirror/state",
    out: "codemirror-state.js",
    entry: "@codemirror/state",
    externals: [],
    hasDefault: false,
  },
  {
    key: "@codemirror/view",
    out: "codemirror-view.js",
    entry: "@codemirror/view",
    externals: ["@codemirror/state", "style-mod", "w3c-keyname"],
    hasDefault: false,
  },
  {
    key: "@codemirror/language",
    out: "codemirror-language.js",
    entry: "@codemirror/language",
    externals: [
      "@codemirror/state",
      "@codemirror/view",
      "@lezer/common",
      "@lezer/highlight",
      "@lezer/lr",
      "style-mod",
    ],
    hasDefault: false,
  },
  {
    key: "@codemirror/commands",
    out: "codemirror-commands.js",
    entry: "@codemirror/commands",
    externals: ["@codemirror/state", "@codemirror/view", "@codemirror/language", "@lezer/common"],
    hasDefault: false,
  },
  {
    key: "@codemirror/search",
    out: "codemirror-search.js",
    entry: "@codemirror/search",
    externals: ["@codemirror/state", "@codemirror/view", "crelt"],
    hasDefault: false,
  },
  {
    key: "@codemirror/autocomplete",
    out: "codemirror-autocomplete.js",
    entry: "@codemirror/autocomplete",
    externals: ["@codemirror/state", "@codemirror/view", "@codemirror/language"],
    hasDefault: false,
  },
  {
    key: "@codemirror/lint",
    out: "codemirror-lint.js",
    entry: "@codemirror/lint",
    externals: ["@codemirror/state", "@codemirror/view", "crelt"],
    hasDefault: false,
  },
  {
    key: "@codemirror/lang-json",
    out: "codemirror-lang-json.js",
    entry: "@codemirror/lang-json",
    externals: ["@codemirror/language", "@codemirror/state", "@lezer/json", "@lezer/highlight"],
    hasDefault: false,
  },
  {
    key: "@codemirror/lang-sql",
    out: "codemirror-lang-sql.js",
    entry: "@codemirror/lang-sql",
    externals: [
      "@codemirror/language",
      "@codemirror/state",
      "@codemirror/autocomplete",
      "@lezer/highlight",
      "@lezer/lr",
    ],
    hasDefault: false,
  },
  {
    key: "@lezer/common",
    out: "lezer-common.js",
    entry: "@lezer/common",
    externals: [],
    hasDefault: false,
  },
  {
    key: "@lezer/highlight",
    out: "lezer-highlight.js",
    entry: "@lezer/highlight",
    externals: ["@lezer/common"],
    hasDefault: false,
  },
  {
    key: "@lezer/lr",
    out: "lezer-lr.js",
    entry: "@lezer/lr",
    externals: ["@lezer/common"],
    hasDefault: false,
  },
  {
    key: "@lezer/json",
    out: "lezer-json.js",
    entry: "@lezer/json",
    externals: ["@lezer/lr", "@lezer/highlight"],
    hasDefault: false,
  },
  { key: "style-mod", out: "style-mod.js", entry: "style-mod", externals: [], hasDefault: false },
  {
    key: "w3c-keyname",
    out: "w3c-keyname.js",
    entry: "w3c-keyname",
    externals: [],
    hasDefault: false,
  },
  { key: "crelt", out: "crelt.js", entry: "crelt", externals: [], hasDefault: true },
  {
    key: "sql-formatter",
    out: "sql-formatter.js",
    entry: "sql-formatter",
    externals: [],
    hasDefault: false,
  },
  // Our own browser-safe subpath — pure `{gatewayOrigin}` token expansion shared
  // with the CLI wizard so the two credentials-spec renderers can't drift. The
  // subpath imports only a `import type` from the node-flavored credentials
  // module, which esbuild erases, so the bundle stays browser-clean (#1243).
  {
    key: "@omnesis/core/credentials-tokens",
    out: "omnesis-credentials-tokens.js",
    entry: "@omnesis/core/credentials-tokens",
    externals: [],
    hasDefault: false,
  },
];

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * esbuild plugin that externalises a fixed set of bare specifiers by EXACT
 * match. We can't use esbuild's built-in `external: [...]` for this because
 * esbuild treats `external: ["preact"]` as a prefix match, which would also
 * externalise `preact/hooks` — defeating the build of the hooks bundle.
 */
function exactExternalsPlugin(externals) {
  const set = new Set(externals);
  return {
    name: "exact-externals",
    setup(api) {
      api.onResolve({ filter: /.*/ }, (args) => {
        if (set.has(args.path)) {
          return { path: args.path, external: true };
        }
        return null;
      });
    },
  };
}

async function bundleOne(target) {
  const outfile = join(vendorDir, target.out);
  // Per-target shim. `import * as` triggers esbuild to actually bundle the
  // module body (a bare `export * from` can pass straight through unchanged).
  // Most packages only have named exports — for those we just `export *`. A
  // small set ship default exports that consumers depend on (crelt: function,
  // qrcode: factory, dompurify: instance) — for those we explicitly forward
  // the default. A blanket `export default __ns.default ?? __ns` would emit
  // a fake default for every package and surface `import-is-undefined`
  // warnings, so it's per-target.
  const lines = [
    `import * as __ns from ${JSON.stringify(target.entry)};`,
    `export * from ${JSON.stringify(target.entry)};`,
    `void __ns;`,
  ];
  if (target.hasDefault) {
    lines.push(`export { default } from ${JSON.stringify(target.entry)};`);
  }
  await build({
    stdin: {
      contents: lines.join("\n"),
      resolveDir: gatewayRoot,
      loader: "js",
    },
    outfile,
    format: "esm",
    bundle: true,
    minify: true,
    target: "es2022",
    sourcemap: false,
    legalComments: "external",
    plugins: [exactExternalsPlugin(target.externals)],
    logLevel: "warning",
  });
  const size = statSync(outfile).size;
  console.log(
    `  ${target.key.padEnd(28)} -> portal/vendor/${target.out.padEnd(32)} ${formatKb(size)}`,
  );
}

async function main() {
  console.log(`portal-vendor: cleaning ${vendorDir}`);
  rmSync(vendorDir, { recursive: true, force: true });
  mkdirSync(vendorDir, { recursive: true });

  console.log(`portal-vendor: building ${TARGETS.length} bundles`);
  for (const target of TARGETS) {
    await bundleOne(target);
  }
  console.log("portal-vendor: done");
}

main().catch((err) => {
  console.error("portal-vendor: build failed");
  console.error(err);
  process.exit(1);
});
