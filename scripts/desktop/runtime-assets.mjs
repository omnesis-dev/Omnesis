// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Only declared workspace aliases outside the compiled production closure may be omitted. */
export function createRuntimeDependencyPlan(inputRoot, entries, lock) {
  const links = new Map();
  const local = new Map();
  const selected = new Map(entries.map((entry) => [entry.pkg.name, entry]));
  for (const [path, record] of Object.entries(lock.packages)) {
    if (record.link !== true) continue;
    const manifest = lock.packages[record.resolved];
    if (
      !manifest?.name ||
      path !== `node_modules/${manifest.name}` ||
      isAbsolute(record.resolved) ||
      record.resolved.split(/[\\/]/u).includes("..")
    )
      throw new Error("The runtime workspace lock entry is invalid");
    local.set(manifest.name, record.resolved);
    links.set(resolve(inputRoot, path), {
      path,
      directory: record.resolved,
      selected: selected.has(manifest.name),
    });
  }
  for (const entry of entries) {
    if (local.get(entry.pkg.name) !== entry.dir)
      throw new Error("The runtime workspace closure does not match its lock");
    for (const dependencies of [
      entry.pkg.dependencies,
      entry.pkg.optionalDependencies,
      entry.pkg.peerDependencies,
    ]) {
      for (const name of Object.keys(dependencies ?? {})) {
        if (local.has(name) && !selected.has(name))
          throw new Error("A required local workspace is missing from the runtime closure");
      }
    }
  }
  return { inputRoot: resolve(inputRoot), entries, links };
}

/** Fail before native compilation if dependency aliases do not survive relocation. */
export function assertRuntimeDependencyLinks(target, plan) {
  const root = realpathSync(target);
  const within = (path) => {
    const rel = relative(root, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error("A runtime dependency link escapes its stage");
  };
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (isAbsolute(readlinkSync(path)))
          throw new Error("A runtime dependency link is absolute");
        within(realpathSync(path));
      } else if (entry.isDirectory()) visit(path);
    }
  };
  visit(root);
  for (const entry of plan.entries) {
    const alias = join(root, "node_modules", entry.pkg.name);
    if (!lstatSync(alias).isSymbolicLink() || realpathSync(alias) !== join(root, entry.dir))
      throw new Error("A runtime workspace alias is missing or changed");
    const manifest = JSON.parse(readFileSync(join(alias, "package.json"), "utf8"));
    if (manifest.name !== entry.pkg.name)
      throw new Error("A runtime workspace alias has the wrong package identity");
  }
}

/** npm's source-workspace bin links are unnecessary and can point at excluded src files. */
export function copyProductionDependencies(source, target, plan, nativeFilter) {
  cpSync(source, target, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (path) => {
      if (basename(path) === ".bin") return false;
      const workspace = plan?.links.get(resolve(path));
      if (!workspace) return nativeFilter ? nativeFilter(path) : true;
      if (
        !lstatSync(path).isSymbolicLink() ||
        isAbsolute(readlinkSync(path)) ||
        resolve(dirname(path), readlinkSync(path)) !== resolve(plan.inputRoot, workspace.directory)
      )
        throw new Error("An installed workspace alias does not match its lock");
      return workspace.selected;
    },
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
