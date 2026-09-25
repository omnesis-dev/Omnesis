// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Moved to `@omnesis/source-sdk`. This shim preserves the
// `from "./cursor-validator.js"` and `from "@omnesis/core"` import edges for
// consumers that haven't migrated to the new package yet.
//
// Explicit named re-exports because vite/vitest can't statically follow
// `export * from "@omnesis/source-sdk"` chains.
export { makeCursorValidator } from "@omnesis/source-sdk";
export type { CursorValidator } from "@omnesis/source-sdk";
