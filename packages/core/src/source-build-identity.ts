// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Exact source-build identity for a running process.
 *
 * A source update records its completed checkout commit before restarting a
 * daemon. The daemon may claim that commit only when it started after that
 * record was written and its own module lives inside the recorded checkout.
 * This keeps a still-running old process from attesting code merely because
 * the checkout underneath it moved.
 */

import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

interface CompletedSourceState {
  version: 1;
  method: "source";
  rootDir: string;
  phase: "complete";
  commit: string;
}

function completedSourceState(value: unknown): value is CompletedSourceState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    state.version === 1 &&
    state.method === "source" &&
    state.phase === "complete" &&
    typeof state.rootDir === "string" &&
    isAbsolute(state.rootDir) &&
    typeof state.commit === "string" &&
    SOURCE_COMMIT_PATTERN.test(state.commit)
  );
}

export function runningSourceCommit(
  configDir: string,
  moduleUrl: string,
  processStartedAt: number,
): string | null {
  const path = resolve(configDir, "update-state.json");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    if (fstatSync(descriptor).mtimeMs >= processStartedAt) return null;
    const parsed: unknown = JSON.parse(readFileSync(descriptor, "utf8"));
    if (!completedSourceState(parsed)) return null;
    const modulePath = fileURLToPath(moduleUrl);
    const fromRoot = relative(resolve(parsed.rootDir), modulePath);
    if (
      fromRoot === "" ||
      fromRoot === ".." ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      return null;
    }
    const head = execFileSync("git", ["-C", parsed.rootDir, "rev-parse", "HEAD^{commit}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (head !== parsed.commit) return null;
    return parsed.commit;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
