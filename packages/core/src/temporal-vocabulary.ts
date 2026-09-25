// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Declared in `@omnesis/types/temporal-vocabulary` — the leaf package both
// `@omnesis/core` and `@omnesis/source-sdk` depend on, so the projection and
// annotation producers can share one vocabulary without a dependency cycle.
// This shim preserves the `from "@omnesis/core"` import edge.
export * from "@omnesis/types/temporal-vocabulary";
export * from "@omnesis/types/temporal-interval";
