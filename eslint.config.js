// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Flat ESLint config for Omnesis.
//
// Pairs with Prettier (Prettier owns formatting; ESLint owns code correctness).
// Type-aware rules are enabled — running `eslint .` invokes the TypeScript
// program, so first run is a few seconds slower than non-type-checked lint.
//
// Rules are deliberately scoped to encode the conventions in AGENTS.md /
// CLAUDE.md that previously lived as review-only norms:
//   - no `console.*` outside the logger module + CLIs + scripts
//   - no `any` outside test files
//   - no cross-package relative imports (use the workspace package name)
//   - ESM `.js` extensions on relative imports (we ship as native ESM)
//   - async safety: no floating / misused promises, await-thenable
//   - `import type` for type-only imports (separate from value imports)
//
// Adding a rule? Verify it auto-fixes cleanly across all of packages/* before
// promoting it to `error` — flip it on as `warn` first, sweep the codebase,
// then promote.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importX from "eslint-plugin-import-x";
import unicorn from "eslint-plugin-unicorn";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  // ----------------------------------------------------------------------
  // Global ignores. Anything matched here is invisible to every later block.
  // ----------------------------------------------------------------------
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      // tsc build output for the browser extension (the lint surface is the
      // `src/` TypeScript, not the emitted JS).
      "**/dist-tsc/**",
      "**/coverage/**",
      "**/test-results/**",
      "**/*.tsbuildinfo",
      "**/*.d.ts",

      // Swift / iOS — handled by SwiftLint + SwiftFormat
      "ios/**",

      // Kotlin / Android — handled by the Gradle toolchain; build dirs contain
      // generated JS (test/Roborazzi HTML reports) that must never be linted.
      "android/**",

      // Portal is hand-rolled vanilla JS/CSS served as static assets;
      // not part of the TypeScript build graph. See #2125 — planned: a narrow
      // rule set for it, since nothing mechanical checks this tree today.
      "packages/gateway/portal/**",

      // Landing site (omnesis.dev) — same deal: static HTML/CSS/JS with
      // browser globals, no build graph.
      "website/**",

      // Cloudflare Worker for the pre-launch access gate — Workers-runtime
      // globals, not part of the TypeScript build graph.
      "worker.js",

      // Publish staging output (scripts/release/stage-packages.mjs)
      "release/**",

      // Internal docs tree — prose + assets, no lintable JS/TS sources
      "docs/**",

      // Claude Code runtime: agent worktrees, transcripts, etc.
      ".claude/**",
    ],
  },

  // ----------------------------------------------------------------------
  // JS recommended + typescript-eslint recommended (non-type-checked).
  // The type-aware rules we want are added explicitly below so we keep
  // strict control over the surface area.
  // ----------------------------------------------------------------------
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ----------------------------------------------------------------------
  // import-x — flat-config-native fork of eslint-plugin-import.
  // The TypeScript preset wires up the TS resolver so `.js` ESM imports
  // resolve to the corresponding `.ts` source.
  // ----------------------------------------------------------------------
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,

  // ----------------------------------------------------------------------
  // Project-wide TypeScript rules.
  // ----------------------------------------------------------------------
  {
    files: ["**/*.{ts,mts,cts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // Per-package tsconfigs exclude *.test.ts (Vitest builds those
        // separately), so projectService can't find test files via the
        // build graph. tsconfig.lint.json is a lint-only project that
        // re-includes everything we want ESLint to touch.
        project: ["./tsconfig.lint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
        ...globals.es2024,
      },
    },
    rules: {
      // --- AGENTS.md / CLAUDE.md "Code style" enforcement ---------------

      // The logger module is the only file allowed to call console.*.
      // Overrides below re-allow it for CLI / scripts.
      // Demoted to `warn` initially: ~100 pre-existing call sites need a
      // human cleanup pass. Ratchet back to `error` once those are gone.
      "no-console": "warn",

      // No `any` — overridden to allow in tests below.
      // Demoted to `warn` initially while pre-existing `any` usages are
      // audited and replaced with concrete types.
      "@typescript-eslint/no-explicit-any": "warn",

      // `import type { Foo }` for type-only imports (separate statement
      // from value imports so the value import elides cleanly at runtime).
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "separate-type-imports",
          disallowTypeAnnotations: false,
        },
      ],
      "@typescript-eslint/consistent-type-exports": "error",

      // ESM ships as `.js`-extension imports even though source files are
      // `.ts` — that's the TS-as-ESM contract.
      "import-x/extensions": [
        "error",
        "always",
        {
          ignorePackages: true,
          checkTypeImports: true,
          pattern: { ts: "never", tsx: "never", mts: "never", cts: "never" },
        },
      ],

      // No cross-package relative imports. If you need something from
      // another workspace package, import it by name. Demoted to `warn`
      // until the pre-existing ~3 cross-package relatives are migrated.
      "no-restricted-imports": [
        "warn",
        {
          patterns: [
            {
              group: ["**/packages/*/src/**", "**/packages/*/**"],
              message:
                "Use the workspace package name (e.g. @omnesis/core) instead of a relative path into another package.",
            },
          ],
        },
      ],

      // --- Async safety (type-aware) ------------------------------------

      // Floating / misused promises are real bugs. They're `warn` now so
      // CI doesn't block on the ~16 pre-existing call sites, but every
      // new one should be treated as a fix-on-sight finding. Ratchet
      // back to `error` once the existing call sites are addressed.
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-misused-promises": [
        "warn",
        {
          checksVoidReturn: { arguments: false, attributes: false },
        },
      ],
      "@typescript-eslint/await-thenable": "warn",
      "@typescript-eslint/require-await": "warn",

      // --- TypeScript hygiene -------------------------------------------

      // Unused vars: demoted to `warn` until a sweep removes the ~86
      // pre-existing dead bindings. New unused vars still show as warnings
      // in PR annotations.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // Inferred types are clearer than verbose annotations on internal
      // functions. We rely on the API-boundary types instead.
      "@typescript-eslint/explicit-module-boundary-types": "off",

      // --- import hygiene ------------------------------------------------

      // import-x/no-duplicates is declared in the "Pre-existing-violations
      // bucket" below as `warn`; remove that override once the call sites
      // have been cleaned up, then we can restore it to `error` here.
      "import-x/no-useless-path-segments": "error",
      "import-x/order": [
        "warn",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index", "type"],
          "newlines-between": "ignore",
        },
      ],
      // import-x/namespace can be slow on large monorepos and adds little
      // signal — `no-explicit-any` and TS itself cover the cases that matter.
      "import-x/namespace": "off",
      "import-x/no-named-as-default-member": "off",

      // --- Misc ---------------------------------------------------------

      // Always use `node:fs` not `fs`.
      "unicorn/prefer-node-protocol": "error",

      eqeqeq: ["error", "smart"],
      "no-debugger": "error",
      "prefer-const": "error",

      // --- Pre-existing-violations bucket -------------------------------
      //
      // These rules surface real issues but each has 1-10 pre-existing
      // call sites that need bespoke fixes rather than an autofix. Listed
      // here as `warn` so the initial rollout doesn't block CI; ratchet
      // each one back to `error` in a follow-up cleanup pass.
      "import-x/no-duplicates": "warn",
      "import-x/default": "warn",
      "no-useless-escape": "warn",
      "no-control-regex": "warn",
      "no-empty": "warn",
      "no-misleading-character-class": "warn",
      "@typescript-eslint/no-this-alias": "warn",
    },
  },

  // ----------------------------------------------------------------------
  // Source-encapsulation guard (CLAUDE.md "Source encapsulation").
  //
  // The repo's #1 architectural rule: no shared package (core / gateway /
  // collector / cli / cli-shared) may branch on a specific source name. A
  // consumer that needs source-specific behaviour reads it through the
  // `defineSource` descriptor / source registry instead. The daily commit
  // audit catches violations after the fact; this is the write-time guard —
  // it reddens the moment someone types `sourceType === "gmail"`.
  //
  // `warn`, not `error`: a flagged line is sometimes a legitimate, reviewed
  // exception (and the lint lane stays green on warns), but every new one
  // surfaces in PR annotations as a finding to justify or refactor.
  //
  // Scoped to the shared packages below — NOT the provider packages (where
  // source-specific code is correct) and NOT tests (which legitimately
  // enumerate sources). The AST selectors match a `===` / `!==` comparison
  // between a `sourceType` / `.sourceType` reference and a string literal, in
  // either operand order. Deliberately keyed on the `sourceType` name (the
  // unambiguous source-name-branching signal), NOT a bare `.type` — `.type`
  // is a generic discriminant across the codebase (`def.type === "source"`,
  // ws-message `type`, …) and would drown the rule in false positives.
  {
    files: [
      "packages/core/src/**/*.ts",
      "packages/gateway/src/**/*.ts",
      "packages/collector/src/**/*.ts",
      "packages/cli/src/**/*.ts",
      "packages/cli-shared/src/**/*.ts",
    ],
    ignores: ["**/*.test.ts", "**/*.spec.ts", "**/test/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector:
            'BinaryExpression[operator=/^(===|!==)$/][left.type="Identifier"][left.name="sourceType"][right.type="Literal"]',
          message:
            "Source-encapsulation: don't branch on a source name. Read source-specific behaviour through the defineSource descriptor / source registry instead. (CLAUDE.md → Source encapsulation)",
        },
        {
          selector:
            'BinaryExpression[operator=/^(===|!==)$/][right.type="Identifier"][right.name="sourceType"][left.type="Literal"]',
          message:
            "Source-encapsulation: don't branch on a source name. Read source-specific behaviour through the defineSource descriptor / source registry instead. (CLAUDE.md → Source encapsulation)",
        },
        {
          selector:
            'BinaryExpression[operator=/^(===|!==)$/][left.type="MemberExpression"][left.property.name="sourceType"][right.type="Literal"]',
          message:
            "Source-encapsulation: don't branch on a source name. Read source-specific behaviour through the defineSource descriptor / source registry instead. (CLAUDE.md → Source encapsulation)",
        },
        {
          selector:
            'BinaryExpression[operator=/^(===|!==)$/][right.type="MemberExpression"][right.property.name="sourceType"][left.type="Literal"]',
          message:
            "Source-encapsulation: don't branch on a source name. Read source-specific behaviour through the defineSource descriptor / source registry instead. (CLAUDE.md → Source encapsulation)",
        },
      ],
    },
  },

  // ----------------------------------------------------------------------
  // Tests — relax explicit-any, allow non-null assertions, allow
  // cross-package relative imports (tests sometimes reach into internals).
  // ----------------------------------------------------------------------
  {
    files: ["**/*.test.ts", "**/*.spec.ts", "**/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "no-restricted-imports": "off",
      "no-console": "off",
    },
  },

  // ----------------------------------------------------------------------
  // Logger module — the one place allowed to call console.*.
  // ----------------------------------------------------------------------
  {
    files: ["packages/core/src/logger.ts"],
    rules: {
      "no-console": "off",
    },
  },

  // ----------------------------------------------------------------------
  // CLIs and bench/admin scripts — console.* is the output channel.
  // ----------------------------------------------------------------------
  {
    files: [
      "packages/cli/**/*.ts",
      "packages/cli-shared/**/*.ts",
      "scripts/**/*.{ts,mts,mjs,js}",
      // The extension's esbuild build script reports progress to the console.
      "extension/scripts/**/*.{mjs,js}",
    ],
    rules: {
      "no-console": "off",
    },
  },

  // ----------------------------------------------------------------------
  // Repo scripts are not a published package, so the rule that keeps
  // packages off each other's internals does not apply to them. A
  // validation or bench harness has to call the exact function or query it
  // is measuring, which is often not on a package's public surface.
  // ----------------------------------------------------------------------
  {
    files: ["scripts/**/*.{ts,mts,mjs,js}"],
    rules: {
      "no-restricted-imports": "off",
    },
  },

  // ----------------------------------------------------------------------
  // Browser-extension ambient global typings. `declare global { namespace
  // chrome { … } }` is the idiomatic way to type the MV3 `chrome.*` API
  // surface without depending on the heavy `@types/chrome` package; the
  // `no-namespace` ban targets value namespaces, not ambient global decls.
  // ----------------------------------------------------------------------
  {
    files: ["extension/src/chrome/chrome-api.ts"],
    rules: {
      "@typescript-eslint/no-namespace": "off",
    },
  },

  // ----------------------------------------------------------------------
  // Plain JS / MJS / CJS — turn off type-aware rules (no TS program).
  // ----------------------------------------------------------------------
  {
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      "@typescript-eslint/consistent-type-imports": "off",
      // The TS block uses varsIgnorePattern: "^_" so leading-underscore
      // parameters are intentionally-unused. Mirror that here for parity.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  // ----------------------------------------------------------------------
  // Prettier — MUST come last so it can disable any conflicting style rules.
  // ----------------------------------------------------------------------
  prettier,

  // ----------------------------------------------------------------------
  // Unicorn — only one rule, declared after the prettier disable so it
  // is unambiguously on.
  // ----------------------------------------------------------------------
  {
    plugins: { unicorn },
    rules: {
      "unicorn/prefer-node-protocol": "error",
    },
  },
);
