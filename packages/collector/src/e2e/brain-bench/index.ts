// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Brain Bench — the end-to-end correctness net for the Cognition
 * Steward.
 *
 * A bench test boots a real gateway with the whole cognition engine live,
 * drives deterministic stimuli (document events, clock advances, user
 * actions on briefs), substitutes only the model at its production seam,
 * and asserts on what the brain left behind through the same admin surface
 * the portal and CLI read.
 *
 * What it deliberately does NOT do is judge the quality of the steward's
 * reasoning. The bench answers "given this decision, did the machine do
 * the right thing?" — never "was this a good decision". Quality lives in
 * the scorecard/eval lane, so improving a prompt never reddens correctness
 * CI.
 *
 *   import { BrainBench, call, ref, compressCognitionCadences } from "./brain-bench/index.js";
 *
 *   compressCognitionCadences();                       // module scope, before boot
 *   const bench = await BrainBench.start({
 *     experimental: true,
 *     behaviors: { behaviors: [ … ] },
 *   });
 *   await bench.pushAndSettle([doc]);
 *   expect((await bench.obs.loops()).items).toHaveLength(1);
 */

export { BrainBench, compressCognitionCadences, sleep, waitFor } from "./bench.js";
export type { BrainBenchOptions, BenchDoc, SeededRun } from "./bench.js";

export { PuppetHttpRefusal } from "./puppet.js";

export { BrainObs } from "./obs.js";
export type {
  Pulse,
  PulseCounts,
  RunDto,
  LoopDto,
  ProductLoopDto,
  LedgerEntry,
  BriefDto,
  BriefClaim,
  AdminDocRef,
  FeedDocRef,
  AnnotationDto,
  TemporalAnnotationDto,
  ExecutedTool,
  ToolResultView,
  DecisionDto,
  DecisionAction,
  PageOf,
} from "./obs.js";

export {
  call,
  ref,
  decideNextTurn,
  readRunContext,
  collectToolSteps,
  emitNextPlanned,
  resolveArgs,
  structuredData,
  fetchedTitle,
} from "./puppet-plan.js";
export type {
  PuppetBehavior,
  PuppetBehaviors,
  PuppetPlan,
  PlanCall,
  PlanRef,
  RunContext,
  RunFlavour,
  NextTurn,
  ToolStep,
  WireMessage,
} from "./puppet-plan.js";

export { startPuppetModelServer } from "./puppet.js";
export type { PuppetModelServer, PuppetCall } from "./puppet.js";

export { startVerdictServer } from "./verdict-servers.js";
export type {
  VerdictServer,
  VerdictCall,
  EntailmentPolicy,
  EntailmentLabel,
  JudgePolicy,
} from "./verdict-servers.js";

export { snapshotBrainState } from "./snapshot.js";
export type { BrainSnapshot } from "./snapshot.js";

export * from "./docs.js";
