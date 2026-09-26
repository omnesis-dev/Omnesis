// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The live schema version. Bumped only when a migration changes the
 * shape or content of an existing install in a way `runSchemaSetup`'s
 * idempotent CREATE statements cannot express.
 *
 * This dependency-free module is also read by the compiled container
 * entrypoint before installing a seeded-state artifact. Keep the constant
 * here rather than loading the complete migration graph at container boot.
 */
export const LATEST_SCHEMA_VERSION = 182;
