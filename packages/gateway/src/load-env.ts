// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Side-effect module: load `$OMNESIS_CONFIG_DIR/.env` into `process.env`
 * before anything else evaluates. Imported FIRST by `index.ts` so the
 * gateway's later `process.env` reads (config dir, DB paths, TLS, …) and any
 * imported module that freezes an env value at import time see the merged
 * environment. See #52.
 */
import { loadDotEnv } from "@omnesis/config";

/**
 * The keys `.env` supplied at boot. A later re-read of the file can then tell
 * a key it dropped from one the real environment set, which `process.env`
 * alone cannot.
 */
export const dotEnvKeysAtBoot: ReadonlySet<string> = new Set(loadDotEnv()?.keys ?? []);
if (typeof process.umask === "function") process.umask(0o077);
