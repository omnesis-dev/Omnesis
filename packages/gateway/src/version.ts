// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readPackageVersion } from "@omnesis/core";

/**
 * Product version of this gateway build, read from the package manifest.
 * Surfaced on `GET /health` so clients (CLI `--version`, portal, iOS) can
 * reconcile their own version against the running gateway's.
 */
export const GATEWAY_VERSION = readPackageVersion(import.meta.url);
