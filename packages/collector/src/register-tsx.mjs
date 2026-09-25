// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Preload stub for the collector's Worker threads: registers the tsx ESM
// loader hooks so a worker can resolve `.js` specifiers back to `.ts` source
// files. `--import tsx` alone doesn't register the hooks in a worker — used
// via `{ execArgv: ["--import", <file-url>] }` from `resolveWorkerEntry`.
import { register } from "tsx/esm/api";
register();
