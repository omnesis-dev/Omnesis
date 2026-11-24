// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";

const root = join(import.meta.dirname, "..", "..");
const dir = join(root, ".github", "workflows");

/** A step that runs the SwiftPM command line: `swift build`, `swift test`, …. */
const runsSwiftPM = (step) =>
  /(?:^|[\s;&|(])swift (?:build|test|run|package)\b/mu.test(step.run ?? "");
const resolves = (step) => /\bscripts\/ci\/resolve-swift-packages\.sh\b/u.test(step.run ?? "");
/** A cache step for SwiftPM's resolved state (not Xcode's package directory). */
const isCacheStep = (step) =>
  /^actions\/cache(\/restore|\/save)?@/u.test(step.uses ?? "") &&
  /\.build\/repositories/u.test(step.with?.path ?? "");

/** The paths that let SwiftPM resolve a package in `dir` without the network. */
const resolvedState = (dir) =>
  [
    `${dir}/.build/repositories`,
    `${dir}/.build/checkouts`,
    `${dir}/.build/workspace-state.json`,
    `${dir}/Package.resolved`,
  ].join("\n");

/** Every job, in every workflow, that runs SwiftPM or its resolve script. */
const swiftJobs = readdirSync(dir)
  .filter((file) => /\.ya?ml$/u.test(file))
  .flatMap((file) =>
    Object.entries(parse(readFileSync(join(dir, file), "utf8")).jobs ?? {})
      .filter(([, job]) => (job.steps ?? []).some((step) => runsSwiftPM(step) || resolves(step)))
      .map(([name, job]) => ({ id: `${file} ${name}`, steps: job.steps })),
  );

// SwiftPM clones every dependency anonymously from its git host, which now and
// then refuses a hosted runner with HTTP 403 before any project code runs
// (#1274). A job restores the package's resolved state, resolves through the
// script that retries only a refusal from the git host, and builds with
// automatic resolution off so the lane itself never fetches.
describe("every job that runs SwiftPM resolves from a cache, with retries, before it builds", () => {
  test("there are SwiftPM jobs to check", () => {
    expect(swiftJobs.map(({ id }) => id)).toContain("ios.yml build-and-test");
  });

  for (const { id, steps } of swiftJobs) {
    describe(id, () => {
      const lanes = steps.filter((step) => runsSwiftPM(step) && !resolves(step));
      const resolve = steps.find(resolves);
      const packageDir = resolve?.run.match(/resolve-swift-packages\.sh\s+(\S+)/u)?.[1];
      const restore = steps.find(
        (step) => isCacheStep(step) && !step.uses.startsWith("actions/cache/save@"),
      );

      test("resolves its package through the retrying script", () => {
        expect(resolve, "no resolve-swift-packages.sh step").toBeTruthy();
        expect(packageDir).toBeTruthy();
        expect(lanes.length).toBeGreaterThan(0);
        for (const lane of lanes) {
          expect(lane["working-directory"]).toBe(packageDir);
          expect(steps.indexOf(lane)).toBeGreaterThan(steps.indexOf(resolve));
        }
      });

      test("never lets a lane resolve again", () => {
        for (const lane of lanes) {
          for (const line of lane.run.split("\n").filter((l) => /\bswift \w/u.test(l))) {
            expect(line).toContain("--disable-automatic-resolution");
          }
        }
      });

      test("restores the package's resolved state, keyed on its manifest", () => {
        expect(restore?.uses, "actions/cache saves on every ref").toMatch(
          /^actions\/cache\/restore@/u,
        );
        expect(restore.id).toBeTruthy();
        expect(restore.with.path.trim()).toBe(resolvedState(packageDir));
        expect(restore.with.key).toContain(`hashFiles('${packageDir}/Package.swift')`);
        expect(restore.with.key.startsWith(restore.with["restore-keys"])).toBe(true);
        expect(steps.indexOf(restore)).toBeLessThan(steps.indexOf(resolve));
      });

      // The repository's Actions caches share a 10 GB limit with the least
      // recently used entry evicted first, so only main saves (#1262), and a
      // saved entry is never replaced. It saves as soon as resolution
      // succeeds, so a later lane's failure costs the next run nothing.
      test("saves only from main, right after resolving", () => {
        const saves = steps.filter(
          (step) => isCacheStep(step) && !step.uses.startsWith("actions/cache/restore@"),
        );
        expect(saves).toHaveLength(1);
        const [save] = saves;
        expect(save.uses).toMatch(/^actions\/cache\/save@/u);
        expect(save.if).toBe(
          `\${{ github.ref == 'refs/heads/main' && steps.${restore.id}.outputs.cache-hit != 'true' }}`,
        );
        expect(save.with.path).toBe(restore.with.path);
        expect(save.with.key).toBe(`\${{ steps.${restore.id}.outputs.cache-primary-key }}`);
        expect(steps.indexOf(save)).toBe(steps.indexOf(resolve) + 1);
      });

      test("ends with the production-network check", () => {
        expect(steps.at(-1).run ?? "").toMatch(/production-network\.sh verify/u);
      });
    });
  }
});
