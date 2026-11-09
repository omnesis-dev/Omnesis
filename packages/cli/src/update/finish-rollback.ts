// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The second half of a daemon's own recovery from a source update that did
 * not finish.
 *
 * An update whose rollback failed, or that was killed, leaves its record at
 * "applying" or "rolling-back", and the source launcher starts no daemon from
 * such a tree. An operator recovers with `omnesis update`; a daemon its
 * service manager starts cannot, and used to exit on every start until someone
 * did. The launcher now finishes the rollback when a daemon meets that record:
 * it takes the host update lock, restores the last completed commit and its
 * dependencies — which is what makes this CLI loadable at all — and runs this
 * step, which rebuilds that commit and records it complete. The daemon then
 * starts on the release it ran before the update.
 *
 * Nothing here moves the checkout or picks a target: reapplying the update
 * stays an operator's or a fleet update's decision.
 */

import { CliError, EXIT_FAILURE } from "../utils.js";
import {
  formatCommandSpec,
  parseUpdateApplyState,
  sourceHeadSpec,
  sourceUpdateSpecs,
  type CommandSpec,
  type UpdateApplyState,
} from "./detect.js";

export const FINISH_ROLLBACK_SUBCOMMAND = "finish-rollback";

export interface FinishRollbackDeps {
  /** Run one command; `capture` returns its stdout, `inherit` streams it. */
  run(spec: CommandSpec, mode: "capture" | "inherit"): Promise<{ code: number; stdout: string }>;
  applyState: { read(): string | null; write(state: UpdateApplyState): void };
  /** The environment the heap policy chose for this machine's build. */
  buildEnv?(): Record<string, string> | undefined;
  setStep?(step: string): void;
  log(message: string): void;
}

export type FinishRollbackOutcome = "finished" | "nothing-unfinished";

/**
 * Rebuild the last completed commit of the checkout at `rootDir` and record
 * it complete. The launcher has already restored that commit and its
 * dependencies; a checkout anywhere else is refused rather than recorded.
 */
export async function finishSourceRollback(
  rootDir: string,
  deps: FinishRollbackDeps,
): Promise<FinishRollbackOutcome> {
  const state = parseUpdateApplyState(deps.applyState.read());
  // Another start of this recovery, or an update, finished it first.
  if (!state || state.method !== "source" || state.rootDir !== rootDir) return "nothing-unfinished";
  if (state.phase === "complete") return "nothing-unfinished";

  const commit = state.lastCompletedCommit;
  const head = await deps
    .run(sourceHeadSpec(rootDir), "capture")
    .catch(() => ({ code: 1, stdout: "" }));
  if (head.code !== 0 || head.stdout.trim() !== commit) {
    throw new CliError(
      `The checkout at ${rootDir} is not on its last completed build (${commit}), so that ` +
        `build cannot be recorded as restored. Run \`omnesis update\` on this machine.`,
      EXIT_FAILURE,
    );
  }

  const build = sourceUpdateSpecs(rootDir, commit, deps.buildEnv?.()).at(-1)!;
  deps.setStep?.("rebuilding the last completed release");
  deps.log(`$ ${formatCommandSpec(build)}`);
  const built = await deps.run(build, "inherit");
  if (built.code !== 0) {
    throw new CliError(
      `\`${formatCommandSpec(build)}\` failed (exit ${built.code}) while restoring the last ` +
        `completed build. The update stays unfinished; run \`omnesis update\` on this machine.`,
      EXIT_FAILURE,
    );
  }

  deps.applyState.write({ version: 1, method: "source", rootDir, phase: "complete", commit });
  deps.log(
    `Restored the last completed build (${commit.slice(0, 12)}). The update that did not ` +
      `finish was not applied; run \`omnesis update\` to apply it.`,
  );
  return "finished";
}
