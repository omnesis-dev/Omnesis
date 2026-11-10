// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The real launcher, run by a real shell against a real git checkout whose
// update record says a rollback did not finish. npm and the CLI body are
// scripts that record what the launcher asked of them, in order.

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { acquireUpdateLock } from "@omnesis/core";
import { prepareSourceRecoveryLauncher } from "./source-launcher.js";

const { sourceLoaderFixture } = createRequire(import.meta.url)(
  "../../../../scripts/release/source-loader-fixture.mjs",
) as { sourceLoaderFixture: string };

const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

interface Scenario {
  rootDir: string;
  configDir: string;
  statePath: string;
  marker: string;
  /** The build that completed before the update, and the one it was moving to. */
  completed: string;
  target: string;
  head(): string;
  /** What npm and the CLI were asked to do, in order. */
  calls(): string[];
  run(
    args: string[],
    env?: Record<string, string>,
  ): { status: number | null; stderr: string; stdout: string };
}

/**
 * A managed checkout left on the update's target with its record at `phase`,
 * as an update whose rollback failed leaves it.
 */
function unfinishedUpdate(phase: "applying" | "rolling-back" | "complete"): Scenario {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-daemon-recovery-"));
  scratch.push(dir);
  const rootDir = join(dir, "source");
  const homeDir = join(dir, "home");
  const configDir = join(dir, "config");
  const fakeBin = join(dir, "bin");
  const log = join(dir, "calls.log");
  const cli = join(dir, "cli.sh");
  mkdirSync(rootDir);
  mkdirSync(fakeBin);
  mkdirSync(configDir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
  const commit = (message: string) =>
    git(
      "-c",
      "user.name=Example",
      "-c",
      "user.email=dev@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      message,
    );
  git("init", "-q");
  writeFileSync(join(rootDir, ".gitignore"), "node_modules\n");
  git("add", ".gitignore");
  commit("the release that completed");
  const completed = git("rev-parse", "HEAD");
  commit("the release the update was moving to");
  const target = git("rev-parse", "HEAD");

  const statePath = join(configDir, "update-state.json");
  const completeState = JSON.stringify({
    version: 1,
    method: "source",
    rootDir,
    phase: "complete",
    commit: completed,
  });
  writeFileSync(
    statePath,
    phase === "complete"
      ? completeState
      : JSON.stringify({
          version: 1,
          method: "source",
          rootDir,
          phase,
          targetCommit: target,
          lastCompletedCommit: completed,
        }),
  );

  // The CLI body: what `update finish-rollback` and the daemon each observe.
  writeFileSync(
    cli,
    `#!/bin/sh
shift
printf 'cli %s\\n' "$*" >> "$FAKE_LOG"
case "$*" in
  "update finish-rollback")
    [ -f "$OMNESIS_CONFIG_DIR/update.lock/owner.json" ] || exit 9
    [ "\${FAKE_FINISH_FAILS:-0}" = 1 ] && exit 1
    printf '%s' "$FAKE_COMPLETE_STATE" > "$OMNESIS_CONFIG_DIR/update-state.json"
    ;;
  "gateway serve"|"collector run")
    if [ -e "$OMNESIS_CONFIG_DIR/update.lock" ]; then exit 8; fi
    ;;
esac
`,
    { mode: 0o755 },
  );
  // npm: records the commit it installed for, and leaves a loadable CLI.
  writeFileSync(
    join(fakeBin, "npm"),
    `#!/bin/sh
case "\${1:-}" in
  ci)
    printf 'npm ci at %s\\n' "$(git rev-parse HEAD)" >> "$FAKE_LOG"
    [ "\${FAKE_NPM_FAILS:-0}" = 1 ] && exit 1
    ${sourceLoaderFixture}mkdir -p node_modules/.bin
    cp "$FAKE_CLI" node_modules/.bin/tsx
    chmod 755 node_modules/.bin/tsx
    ;;
esac
`,
    { mode: 0o755 },
  );
  const launcher = prepareSourceRecoveryLauncher(rootDir, configDir, homeDir);
  return {
    rootDir,
    configDir,
    statePath,
    marker: join(configDir, "update-recovery-attempt"),
    completed,
    target,
    head: () => git("rev-parse", "HEAD"),
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
    run: (args, env = {}) => {
      const result = spawnSync(launcher, args, {
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          OMNESIS_CONFIG_DIR: configDir,
          OMNESIS_UPDATE_LOCK_ID: "",
          FAKE_LOG: log,
          FAKE_CLI: cli,
          FAKE_COMPLETE_STATE: completeState,
          ...env,
        },
      });
      return { status: result.status, stderr: result.stderr, stdout: result.stdout };
    },
  };
}

describe.skipIf(process.platform === "win32")(
  "a daemon started over an update that did not finish",
  () => {
    test.each([
      ["gateway", "serve", "rolling-back"],
      ["collector", "run", "rolling-back"],
      ["collector", "run", "applying"],
    ] as const)(
      "`%s %s` over a %s record restores the last completed release, then starts",
      (component, verb, phase) => {
        const host = unfinishedUpdate(phase);
        expect(host.head()).toBe(host.target);

        const result = host.run([component, verb]);

        expect(result.stderr).toContain("Restoring the last completed release before starting");
        expect(result.status).toBe(0);
        // In order: dependencies for the completed commit, its build and
        // record under the update lock, then the daemon with the lock released.
        expect(host.calls()).toEqual([
          `npm ci at ${host.completed}`,
          "cli update finish-rollback",
          `cli ${component} ${verb}`,
        ]);
        expect(host.head()).toBe(host.completed);
        expect(JSON.parse(readFileSync(host.statePath, "utf8"))).toMatchObject({
          phase: "complete",
          commit: host.completed,
        });
        expect(existsSync(host.marker)).toBe(false);
        expect(existsSync(join(host.configDir, "update.lock"))).toBe(false);

        // The next start is an ordinary one: nothing is restored again.
        expect(host.run([component, verb]).status).toBe(0);
        expect(host.calls().slice(3)).toEqual([`cli ${component} ${verb}`]);
      },
      60_000,
    );

    test.each([
      ["the dependency install", { FAKE_NPM_FAILS: "1" }],
      ["the rebuild", { FAKE_FINISH_FAILS: "1" }],
    ] as const)(
      "a recovery that fails at %s does not start the daemon and is retried only 15 minutes later",
      (_step, failure) => {
        const host = unfinishedUpdate("rolling-back");

        const first = host.run(["collector", "run"], failure);
        expect(first.status).toBe(1);
        expect(host.calls()).not.toContain("cli collector run");
        expect(existsSync(join(host.configDir, "update.lock"))).toBe(false);
        expect(JSON.parse(readFileSync(host.statePath, "utf8")).phase).toBe("rolling-back");
        const attempted = host.calls().length;

        // The service manager restarts the daemon seconds later: it must not
        // reinstall on every start.
        const again = host.run(["collector", "run"], failure);
        expect(again.status).toBe(1);
        expect(again.stderr).toContain("attempted less than 15 minutes ago");
        expect(again.stderr).toContain("Run 'omnesis update'");
        expect(host.calls()).toHaveLength(attempted);

        // Sixteen minutes on, with the cause gone, the next start recovers.
        const earlier = new Date(Date.now() - 16 * 60_000);
        utimesSync(host.marker, earlier, earlier);
        const later = host.run(["collector", "run"]);
        expect(later.status).toBe(0);
        expect(host.calls().at(-1)).toBe("cli collector run");
        expect(host.head()).toBe(host.completed);
        expect(existsSync(host.marker)).toBe(false);
      },
      60_000,
    );

    test("a daemon does not touch the checkout while an update holds the lock", () => {
      const host = unfinishedUpdate("applying");
      const update = acquireUpdateLock(host.configDir, { owner: "operator update" });
      try {
        const result = host.run(["gateway", "serve"]);
        expect(result.status).toBe(73);
        expect(result.stderr).toContain("update is running on this host");
        expect(host.calls()).toEqual([]);
        expect(host.head()).toBe(host.target);
      } finally {
        update.release();
      }
    }, 60_000);

    test("any other command is still refused and sent to `omnesis update`", () => {
      const host = unfinishedUpdate("rolling-back");
      for (const args of [["status"], ["gateway", "status"], ["collector"], []]) {
        const result = host.run(args);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Run 'omnesis update' before starting another command");
      }
      expect(host.calls()).toEqual([]);
      expect(host.head()).toBe(host.target);
      expect(existsSync(host.marker)).toBe(false);
    }, 60_000);

    test("a checkout moved away from a completed record is not restored by a daemon", () => {
      // Nothing says an update did this, so nothing says which tree is wanted.
      const host = unfinishedUpdate("complete");
      const result = host.run(["gateway", "serve"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Run 'omnesis update' before starting another command");
      expect(host.calls()).toEqual([]);
      expect(host.head()).toBe(host.target);
    }, 60_000);

    test("`omnesis update` still recovers by hand, and clears nothing a daemon needs", () => {
      const host = unfinishedUpdate("rolling-back");
      const result = host.run(["update", "--yes"]);
      expect(result.status).toBe(0);
      expect(host.calls()).toEqual([`npm ci at ${host.completed}`, "cli update --yes"]);
    }, 60_000);
  },
);
