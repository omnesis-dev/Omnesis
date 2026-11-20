// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

interface PrivateWindowsFiles {
  readWindowsPrivateFileContentsSync(path: string): Buffer;
  secureWindowsPrivatePathSync(path: string, kind: "file" | "directory"): void;
  inspectWindowsPrivatePathSync(path: string, kind: "file" | "directory"): { private: boolean };
  writeWindowsPrivateFileAtomicSync(path: string, bytes: Uint8Array): void;
}

let files: PrivateWindowsFiles | undefined;

/** The standalone archive carries canonical generated helpers, with no Omnesis runtime dependency. */
export function privateWindowsFiles(): PrivateWindowsFiles {
  if (files) return files;
  const candidate = loadWindowsPlatformRuntime(
    "windows-private-file",
  ) as Partial<PrivateWindowsFiles> | null;
  if (
    typeof candidate?.readWindowsPrivateFileContentsSync !== "function" ||
    typeof candidate.writeWindowsPrivateFileAtomicSync !== "function" ||
    typeof candidate.secureWindowsPrivatePathSync !== "function" ||
    typeof candidate.inspectWindowsPrivatePathSync !== "function"
  )
    throw new Error("This Windows integration archive has an invalid private filesystem runtime");
  files = candidate as PrivateWindowsFiles;
  return files;
}

const localRequire = createRequire(import.meta.url);
/** Only canonical generated modules shipped beside the integration runtime. */
export function loadWindowsPlatformRuntime(name: "windows-private-file" | "windows-job"): unknown {
  if (name !== "windows-private-file" && name !== "windows-job")
    throw new Error("Invalid integration Windows runtime module");
  const bundled = fileURLToPath(new URL(`./private-platform/${name}.js`, import.meta.url));
  let entry: string;
  let sourceRoot: URL | undefined;
  if (existsSync(bundled)) entry = bundled;
  else if (import.meta.url.endsWith(".ts")) {
    entry = localRequire.resolve(`@omnesis/platform/${name}`);
    sourceRoot = new URL("./", pathToFileURL(entry));
  } else {
    throw new Error("This Windows integration archive is missing its private filesystem runtime");
  }
  // Node's synchronous require uses native type stripping for this builtin-only
  // source graph. Resolve only its existing relative .js siblings to .ts; the
  // generated standalone graph already has real .js files and needs no hook.
  const sourceBase = sourceRoot?.href;
  const hook = sourceBase
    ? registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier.startsWith(".") && context.parentURL?.startsWith(sourceBase)) {
            const target = new URL(specifier, context.parentURL);
            if (target.href.startsWith(sourceBase) && target.pathname.endsWith(".js")) {
              target.pathname = target.pathname.slice(0, -3) + ".ts";
              if (existsSync(fileURLToPath(target)))
                return { url: target.href, shortCircuit: true };
            }
          }
          return nextResolve(specifier, context);
        },
      })
    : undefined;
  let candidate: unknown;
  try {
    candidate = localRequire(entry);
  } finally {
    hook?.deregister();
  }
  return candidate;
}
