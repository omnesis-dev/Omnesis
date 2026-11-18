// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { resolve, sep } from "node:path";

/** Windows chmod does not deny reads; inject the same OS error at the filesystem boundary. */
export const deniedFixturePaths = new Set<string>();

export function withFixturePermissions<T extends (...args: never[]) => unknown>(operation: T): T {
  return ((...args: Parameters<T>): ReturnType<T> => {
    const path = args[0];
    if (typeof path === "string") {
      const absolute = resolve(path);
      for (const denied of deniedFixturePaths) {
        const blocked = resolve(denied);
        if (absolute === blocked || absolute.startsWith(blocked + sep))
          throw Object.assign(new Error("Invented fixture read denied"), { code: "EACCES" });
      }
    }
    return Reflect.apply(operation, undefined, args) as ReturnType<T>;
  }) as T;
}
