// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Side-effect module: load `$OMNESIS_CONFIG_DIR/.env` into `process.env`
 * before anything else evaluates. Imported FIRST by `main.ts` so the
 * module-scope `GATEWAY_URL` read (and any other import-time env reads) pick
 * up `OMNESIS_GATEWAY_URL` / `OMNESIS_TOKEN` from the file.
 */
import { loadDotEnv } from "@omnesis/config";

loadDotEnv();
if (typeof process.umask === "function") process.umask(0o077);
