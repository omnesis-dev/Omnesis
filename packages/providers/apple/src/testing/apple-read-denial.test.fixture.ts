// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, vi } from "vitest";

// Logical read failures must not depend on whether the runner can bypass file permissions.
const denied = vi.hoisted(() => ({
  paths: new Set<string>(),
  errorFor(path: unknown): NodeJS.ErrnoException | undefined {
    if (typeof path !== "string") return undefined;
    for (const root of this.paths) {
      if (path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)) {
        return Object.assign(new Error("Fixture read access denied"), { code: "EACCES" });
      }
    }
    return undefined;
  },
}));

vi.mock("better-sqlite3", async (importOriginal) => {
  const sqlite = await importOriginal<{ default: typeof import("better-sqlite3") }>();
  return {
    ...sqlite,
    default: new Proxy(sqlite.default, {
      construct(target, args, newTarget) {
        if (args[1]?.readonly && denied.errorFor(args[0])) {
          throw new sqlite.default.SqliteError("unable to open database file", "SQLITE_CANTOPEN");
        }
        return Reflect.construct(target, args, newTarget);
      },
    }),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readdirSync: ((...args: Parameters<typeof fs.readdirSync>) => {
      const error = denied.errorFor(args[0]);
      if (error) throw error;
      return fs.readdirSync(...args);
    }) as typeof fs.readdirSync,
    open: ((...args: Parameters<typeof fs.open>) => {
      const error = denied.errorFor(args[0]);
      if (error) {
        const callback = args[args.length - 1] as (error: NodeJS.ErrnoException) => void;
        queueMicrotask(() => callback(error));
        return;
      }
      return fs.open(...args);
    }) as typeof fs.open,
  };
});

export function setAppleFixtureReadable(path: string, readable: boolean): void {
  if (readable) denied.paths.delete(path);
  else denied.paths.add(path);
}

afterEach(() => denied.paths.clear());
