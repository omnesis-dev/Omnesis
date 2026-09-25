// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Preload stub for Worker threads: registers the tsx ESM loader hooks so
// the worker can resolve `.js` specifiers back to `.ts` source files.
// `--import tsx` alone doesn't register the hooks (tsx's main export is
// just the loader module — the CLI path does the registration). This
// file is used via `{ execArgv: ["--import", <file-url>] }` in the
// indexer + backfill worker proxies.
import { register } from "tsx/esm/api";
register();
