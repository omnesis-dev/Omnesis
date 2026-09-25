// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Publish-time package.json transform.
 *
 * Dev manifests point `main`/`types`/`exports`/`bin` at `src/*.ts` so the
 * whole dev workflow (tsx, vitest, tsc project references, worktree symlink
 * farms) resolves TypeScript source directly — no stale-dist traps. The
 * published artifact must instead point at the `tsc`-emitted `dist/*.js`
 * (+ `.d.ts`) and carry real semver on its `@omnesis/*` dependencies.
 *
 * This module is pure: it takes a parsed dev manifest and returns the
 * manifest to publish. `stage-packages.mjs` applies it while copying each
 * package into `release/staging/`.
 */

const SRC_ENTRY = /^\.?\/?src\/(.+)\.ts$/;

function distPaths(value, what) {
  const m = SRC_ENTRY.exec(value);
  if (!m) throw new Error(`Cannot transform ${what} "${value}" — expected a src/*.ts path`);
  return { js: `./dist/${m[1]}.js`, dts: `./dist/${m[1]}.d.ts` };
}

function transformExportsValue(value, what) {
  if (typeof value === "string") {
    const { js, dts } = distPaths(value, what);
    return { types: dts, default: js };
  }
  if (value && typeof value === "object") {
    // Conditional exports object: rewrite each condition's target.
    const out = {};
    for (const [cond, target] of Object.entries(value)) {
      out[cond] = transformExportsValue(target, `${what}.${cond}`);
    }
    return out;
  }
  throw new Error(`Cannot transform ${what}: unsupported exports shape`);
}

/**
 * @param {Record<string, any>} pkg parsed dev package.json
 * @param {string} version the lockstep version every @omnesis/* dep is pinned to
 * @param {{access?: "public" | "restricted"}} [opts] npm visibility. Defaults to
 *   "restricted" so a public publish must be opted into explicitly (see publish-policy).
 * @returns {Record<string, any>} the manifest to publish
 */
export function transformManifest(pkg, version, opts = {}) {
  if (pkg.private) throw new Error(`${pkg.name} is private — not publishable`);
  const out = structuredClone(pkg);

  if (out.main) {
    const { js, dts } = distPaths(out.main, `${pkg.name}#main`);
    out.main = js;
    out.types = dts;
  } else if (out.types) {
    out.types = distPaths(out.types, `${pkg.name}#types`).dts;
  }

  if (out.exports) {
    const exports = {};
    for (const [key, value] of Object.entries(out.exports)) {
      exports[key] = transformExportsValue(value, `${pkg.name}#exports[${key}]`);
    }
    out.exports = exports;
  }

  if (out.bin) {
    const bin = {};
    for (const [name, target] of Object.entries(out.bin)) {
      bin[name] = distPaths(target, `${pkg.name}#bin.${name}`).js;
    }
    out.bin = bin;
  }

  if (out.dependencies) {
    for (const [dep, range] of Object.entries(out.dependencies)) {
      if (dep.startsWith("@omnesis/")) {
        // Changesets prerelease mode replaces workspace wildcards with the
        // exact lockstep prerelease. Accept only that generated form; normal
        // development manifests must keep using "*" so stale internal pins
        // cannot enter a stable package unnoticed.
        const generatedPrereleasePin =
          pkg.version === version && version.includes("-") && range === version;
        if (range !== "*" && !generatedPrereleasePin) {
          throw new Error(
            `${pkg.name} depends on ${dep}@"${range}" — workspace deps must be "*" or the current prerelease version`,
          );
        }
        out.dependencies[dep] = version;
      }
    }
  }

  // Published packages carry no dev tooling and no workspace scripts.
  delete out.devDependencies;
  delete out.scripts;
  if (pkg.name === "@omnesis/gateway") {
    out.scripts = { preinstall: "node native-runtime-preflight.mjs" };
    out.files = [...(out.files ?? []), "native-runtime-preflight.mjs"];
  }

  // Single source of truth for the publish-only metadata. Matches the repo
  // LICENSE (AGPL-3.0-or-later), which every dev package.json also declares.
  out.license = "AGPL-3.0-or-later";
  out.repository = { type: "git", url: "git+https://github.com/omnesis-dev/Omnesis.git" };
  out.engines = { node: ">=24.0.0" };
  out.publishConfig = { access: opts.access ?? "restricted" };

  return out;
}
