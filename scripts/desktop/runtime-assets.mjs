// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmodSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/** npm's source-workspace bin links are unnecessary and can point at excluded src files. */
export function copyProductionDependencies(source, target) {
  cpSync(source, target, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (path) => basename(path) !== ".bin",
  });
}

/** A private npm supports managed model runtimes without finding Node/npm on the host. */
export function copyNodeTools(distribution, target) {
  mkdirSync(join(target, "lib/node_modules"), { recursive: true });
  cpSync(join(distribution, "bin/node"), join(target, "node"));
  cpSync(join(distribution, "lib/node_modules/npm"), join(target, "lib/node_modules/npm"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  cpSync(join(distribution, "LICENSE"), join(target, "NODE_LICENSE"));
  for (const name of ["npm", "npx"]) {
    writeFileSync(
      join(target, name),
      `#!/bin/sh\nruntime_dir="$(CDPATH= cd "$(/usr/bin/dirname "$0")" && pwd)"\nexec "$runtime_dir/runtime-exec" --node "$runtime_dir/lib/node_modules/npm/bin/${name}-cli.js" "$@"\n`,
    );
    chmodSync(join(target, name), 0o755);
  }
  mkdirSync(join(target, "bin"), { recursive: true });
  writeFileSync(
    join(target, "bin/node"),
    '#!/bin/sh\nruntime_dir="$(CDPATH= cd "$(/usr/bin/dirname "$0")/.." && pwd)"\nexec "$runtime_dir/runtime-exec" --node "$@"\n',
  );
  chmodSync(join(target, "bin/node"), 0o755);
  for (const name of ["npm", "npx"]) {
    writeFileSync(
      join(target, "bin", name),
      `#!/bin/sh\nruntime_dir="$(CDPATH= cd "$(/usr/bin/dirname "$0")/.." && pwd)"\nexec "$runtime_dir/${name}" "$@"\n`,
    );
    chmodSync(join(target, "bin", name), 0o755);
  }
  chmodSync(join(target, "node"), 0o755);
}
