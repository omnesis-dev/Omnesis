// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { waitForChild } from "../lib/check-process.mjs";
import { bundles, bundleTestArgs } from "./bundles.mjs";
import { assertTreeFingerprint } from "./tree-state.mjs";

const name = process.argv[2];
const bundle = bundles[name];
if (!bundle) throw new Error(`Unknown check bundle: ${name}`);
if (process.env.OMNESIS_TREE_FINGERPRINT) {
  assertTreeFingerprint(process.env.OMNESIS_TREE_BASE, process.env.OMNESIS_TREE_FINGERPRINT);
}

let command;
let args;
if (bundle.kind === "e2e") {
  const alreadySelected = new Set(
    (process.env.OMNESIS_E2E_ALREADY_SELECTED || "").split("\n").filter(Boolean),
  );
  const tests = bundleTestArgs(name).filter((test) => !alreadySelected.has(test));
  if (tests.length === 0) {
    process.stdout.write(`[nx] ${name} is already covered by earlier selected bundles.\n`);
    process.exitCode = 0;
    process.exit();
  }
  command = process.execPath;
  args = ["scripts/run-check.mjs", "e2e", ...tests];
} else {
  command = process.env.OMNESIS_NATIVE_DISPATCHER || "omnesis-native-job";
  if (
    !command.includes("/") &&
    !process.env.PATH?.split(":").some((dir) => existsSync(resolve(dir, command)))
  ) {
    throw new Error(
      `${command} is unavailable. Install/configure the native dispatcher before running ${name}.`,
    );
  }
  if (
    process.env.OMNESIS_TREE_FINGERPRINT &&
    (!process.env.OMNESIS_TREE_HEAD || !process.env.OMNESIS_NATIVE_TREE_FINGERPRINT)
  ) {
    throw new Error(`Managed native bundle ${name} is missing its frozen source identity.`);
  }
  args = ["run", "--host", "auto", "--kind", bundle.nativeKind, "--checkout", process.cwd()];
  if (process.env.OMNESIS_TREE_HEAD) args.push("--expected-head", process.env.OMNESIS_TREE_HEAD);
  if (process.env.OMNESIS_NATIVE_TREE_FINGERPRINT)
    args.push("--expected-fingerprint", process.env.OMNESIS_NATIVE_TREE_FINGERPRINT);
  if (name === "android-render") args.push("--", "--verify");
}

const child = spawn(command, args, { stdio: "inherit", env: process.env });
process.exitCode = await waitForChild(child);
