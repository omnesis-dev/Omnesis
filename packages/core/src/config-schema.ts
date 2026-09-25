// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Moved to `@omnesis/config`. This shim preserves the
// `from "./config-schema.js"` and `from "@omnesis/core"` import
// edges for consumers that haven't migrated to the new package yet.
export * from "@omnesis/config";
