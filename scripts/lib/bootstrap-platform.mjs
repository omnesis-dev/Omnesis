// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

/** Load builtins-only platform source before npm has created workspace aliases. */
export async function bootstrapWindowsPlatform(entry = "windows-job.ts") {
  if (!["windows-job.ts", "windows-process.ts"].includes(entry))
    throw new Error("Unsupported Windows platform bootstrap entry");
  const root = new URL("../../packages/platform/src/", import.meta.url);
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith(".") && context.parentURL?.startsWith(root.href)) {
        const target = new URL(specifier, context.parentURL);
        if (target.href.startsWith(root.href) && target.pathname.endsWith(".js")) {
          target.pathname = target.pathname.slice(0, -3) + ".ts";
          if (existsSync(fileURLToPath(target))) return { url: target.href, shortCircuit: true };
        }
      }
      return nextResolve(specifier, context);
    },
  });
  try {
    return await import(new URL(entry, root).href);
  } finally {
    hook.deregister();
  }
}
