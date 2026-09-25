// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** The extension id Chrome derives from the test manifest's pinned key. */
export declare const TEST_EXTENSION_ID: string;
export declare function applyTestManifest<T extends Record<string, unknown>>(
  manifest: T,
): Omit<T, "optional_host_permissions"> & { key: string; host_permissions: string[] };
