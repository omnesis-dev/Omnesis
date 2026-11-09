// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { CliError } from "../utils.js";
import { finishSourceRollback, type FinishRollbackDeps } from "./finish-rollback.js";
import type { CommandSpec, UpdateApplyState } from "./detect.js";

const rootDir = "/home/dev/omnesis";
const completed = "9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3";
const target = "1122334455667788990011223344556677889900";

const unfinished = (phase: "applying" | "rolling-back", root = rootDir): string =>
  JSON.stringify({
    version: 1,
    method: "source",
    rootDir: root,
    phase,
    targetCommit: target,
    lastCompletedCommit: completed,
  });

function host(options: { state: string | null; head?: string; buildExit?: number }) {
  const ran: CommandSpec[] = [];
  const writes: UpdateApplyState[] = [];
  const steps: string[] = [];
  const logged: string[] = [];
  const deps: FinishRollbackDeps = {
    run: (spec, mode) => {
      ran.push(spec);
      if (mode === "capture") {
        return Promise.resolve({ code: 0, stdout: `${options.head ?? completed}\n` });
      }
      return Promise.resolve({ code: options.buildExit ?? 0, stdout: "" });
    },
    applyState: { read: () => options.state, write: (state) => writes.push(state) },
    buildEnv: () => ({ NODE_OPTIONS: "--max-old-space-size=2048" }),
    setStep: (step) => steps.push(step),
    log: (message) => logged.push(message),
  };
  const commands = () => ran.map((spec) => [spec.command, ...spec.args].join(" "));
  return { deps, ran, writes, steps, logged, commands };
}

describe("finishSourceRollback", () => {
  it.each(["applying", "rolling-back"] as const)(
    "rebuilds the last completed commit of a %s record and records it complete",
    async (phase) => {
      const h = host({ state: unfinished(phase) });
      await expect(finishSourceRollback(rootDir, h.deps)).resolves.toBe("finished");
      expect(h.commands()).toEqual(["git rev-parse HEAD", "npm run build"]);
      const build = h.ran[1]!;
      expect(build.cwd).toBe(rootDir);
      // The same heap policy as the update's own build.
      expect(build.env).toEqual({ NODE_OPTIONS: "--max-old-space-size=2048" });
      expect(h.writes).toEqual([
        { version: 1, method: "source", rootDir, phase: "complete", commit: completed },
      ]);
      expect(h.steps).toEqual(["rebuilding the last completed release"]);
      expect(h.logged.join("\n")).toContain("run `omnesis update` to apply it");
    },
  );

  it("leaves the record unfinished when the build fails", async () => {
    const h = host({ state: unfinished("rolling-back"), buildExit: 137 });
    const failure = await finishSourceRollback(rootDir, h.deps).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).message).toContain("`npm run build` failed (exit 137)");
    expect(h.writes).toEqual([]);
  });

  it("refuses to record a checkout that is not on the last completed commit", async () => {
    // The launcher restores it first; a tree anywhere else was not restored.
    const h = host({ state: unfinished("rolling-back"), head: target });
    await expect(finishSourceRollback(rootDir, h.deps)).rejects.toThrow(
      /not on its last completed build/u,
    );
    expect(h.commands()).toEqual(["git rev-parse HEAD"]);
    expect(h.writes).toEqual([]);
  });

  it.each([
    ["no record", null],
    [
      "a completed record",
      JSON.stringify({ version: 1, method: "source", rootDir, phase: "complete", commit: target }),
    ],
    ["another checkout's record", unfinished("rolling-back", "/srv/other")],
    ["an unreadable record", "{"],
  ])("does nothing over %s, which another recovery or an update finished", async (_name, state) => {
    const h = host({ state });
    await expect(finishSourceRollback(rootDir, h.deps)).resolves.toBe("nothing-unfinished");
    expect(h.ran).toEqual([]);
    expect(h.writes).toEqual([]);
  });
});
