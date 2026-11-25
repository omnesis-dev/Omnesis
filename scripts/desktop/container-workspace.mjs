// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { globSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";

// This is the container's writable workspace; dependency payloads stay read-only.
if (
  !process.env.OMNESIS_DESKTOP_ACCOUNT_CONTAINER_NONCE ||
  !process.env.OMNESIS_ACCOUNT_DEPENDENCIES
)
  throw new Error("The isolated account container is required");
const root = resolve(".");
const dependencies = process.env.OMNESIS_ACCOUNT_DEPENDENCIES;
const modules = join(root, "node_modules");
mkdirSync(modules);
for (const entry of readdirSync(dependencies)) {
  if (entry === "@omnesis" || entry === "omnesis") continue;
  symlinkSync(join(dependencies, entry), join(modules, entry));
}
mkdirSync(join(modules, "@omnesis"));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const workspace of manifest.workspaces.flatMap((pattern) => [...globSync(pattern)])) {
  const path = join(root, workspace);
  const { name } = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  if (name?.startsWith("@omnesis/") || name === "omnesis") symlinkSync(path, join(modules, name));
}
