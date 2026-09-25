// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Preload stub for the history-import Worker thread (#588): registers the tsx
// ESM loader hooks so the worker can resolve `.js` specifiers back to `.ts`
// source files. `--import tsx` alone doesn't register the hooks in a worker —
// used via `{ execArgv: ["--import", <file-url>] }` in importer.ts. Mirrors
// packages/gateway/src/workers/register-tsx.mjs.
import { register } from "tsx/esm/api";
register();
