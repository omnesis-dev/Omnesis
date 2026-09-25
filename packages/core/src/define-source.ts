// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Moved to `@omnesis/source-sdk`. This shim preserves the
// `from "./define-source.js"` and `from "@omnesis/core"` import edges for
// consumers that haven't migrated to the new package yet.
//
// We list the bindings explicitly rather than `export * from
// "@omnesis/source-sdk"` because vite/vitest's static analyser doesn't
// follow `export *` chains across workspace-package boundaries — named
// re-exports downstream (`export { defineSource } from
// "./define-source.js"`) then resolve to `undefined` at runtime even
// though tsc + tsx-direct handle them fine.
export {
  defineSource,
  defineProvider,
  defineStructuredSource,
  resolveProvider,
} from "@omnesis/source-sdk";
export type {
  SourceDefinition,
  ProviderDefinition,
  SourceOrProviderDefinition,
  SourceInstance,
  CreateOptions,
  ProviderSourceEntry,
} from "@omnesis/source-sdk";
