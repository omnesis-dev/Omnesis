// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Side-effect module: load `$OMNESIS_CONFIG_DIR/.env` into `process.env`
 * before anything else evaluates. Imported FIRST by `index.ts` — ahead of
 * `./utils.js`, which freezes `GATEWAY_URL` from `process.env` at import — so
 * a `.env`-provided `OMNESIS_GATEWAY_URL` / `OMNESIS_TOKEN` is honoured.
 */
import { loadDotEnv } from "@omnesis/config";

loadDotEnv();
if (typeof process.umask === "function") process.umask(0o077);
