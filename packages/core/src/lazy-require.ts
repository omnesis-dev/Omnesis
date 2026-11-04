// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A dependency loaded on first use instead of when the importing module loads.
 *
 * Every worker thread is a separate V8 isolate that loads its own copy of each
 * module it reaches, so a large library imported at the top of a widely shared
 * module (a phone-number database, the date recognizer's models, a language
 * detector, an HTML parser) costs every worker its memory whether or not that
 * worker ever calls it. `lazyRequire` defers the load to the first call that
 * needs the library, and keeps it from then on. The returned getter is
 * synchronous, so a synchronous API stays synchronous.
 *
 * Only CommonJS-loadable packages qualify (Node also loads an ES module through
 * `require`, but not one with top-level await). A static import of the library
 * in any module a worker reaches would load it in that worker anyway, and a
 * package that ships separate CommonJS and ES module builds is then loaded
 * twice in a thread that uses both; `workers/worker-module-graph.test.ts` in the
 * gateway fails if a worker entry reaches one of these libraries statically.
 * The first call pays the load synchronously on whichever thread makes it (tens
 * of milliseconds for the largest), so a library first used on the main thread
 * while it serves is a candidate for a dynamic `import()` instead, which code
 * whose caller is already asynchronous uses anyway.
 */

import { createRequire } from "node:module";

/**
 * A memoized loader for `specifier`, resolved from `importMetaUrl` (pass the
 * caller's `import.meta.url` so resolution starts from the caller's package).
 * Type it with the library's module type, e.g.
 * `lazyRequire<typeof import("libphonenumber-js")>(import.meta.url, "libphonenumber-js")`.
 */
export function lazyRequire<T>(importMetaUrl: string, specifier: string): () => T {
  let loaded: { value: T } | undefined;
  return () => {
    loaded ??= { value: createRequire(importMetaUrl)(specifier) as T };
    return loaded.value;
  };
}
