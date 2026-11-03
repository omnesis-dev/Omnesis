// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Reduce a V8 CPU profile of the main thread to the code that held it in
 * long busy runs.
 *
 * A busy run is a stretch of consecutive samples none of which is `(idle)`:
 * the event loop doing work rather than waiting for it. Ordinary request
 * handling makes thousands of short runs; a stall is one long one. Only runs
 * of at least `minRunMs` are summarised, so what the summary ranks is what
 * the loop was stuck in, not what it was merely busy with.
 *
 * The summary names code and nothing else: a function name, a file path
 * made relative to the code root (or to `node_modules`, or reduced to a
 * base name when it lies elsewhere), and the 1-based line the function
 * starts on. "Our code" is the code root outside `node_modules`, plus the
 * `@omnesis/` packages inside it, which is where an npm install keeps them. A CPU profile holds
 * no argument values or heap contents to begin with; this keeps even the
 * absolute paths of the machine it ran on out of what is stored.
 */

import { fileURLToPath } from "node:url";

/** The parts of the DevTools protocol's `Profiler.Profile` this reads. */
export interface CpuProfile {
  nodes: Array<{
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
    children?: number[];
  }>;
  /** Microseconds. */
  startTime: number;
  endTime: number;
  samples?: number[];
  /** Microseconds between consecutive samples; the first is from `startTime`. */
  timeDeltas?: number[];
}

export interface ProfileFrame {
  functionName: string;
  file: string;
  line: number | null;
}

/** A frame as one line: `name (file:line)`. */
export function formatFrame(f: ProfileFrame): string {
  return f.file ? `${f.functionName} (${f.file}${f.line ? `:${f.line}` : ""})` : f.functionName;
}

export interface ProfileFrameStat extends ProfileFrame {
  /** Time this frame was the one executing. */
  selfMs: number;
  /** Time this frame was anywhere on the stack. */
  totalMs: number;
}

export interface ProfileLongRun {
  /** Start, from the beginning of the capture. */
  offsetMs: number;
  durationMs: number;
  topSelf: ProfileFrameStat[];
  /** The stack the run spent most time in, innermost frame first. */
  hotStack: ProfileFrame[];
  /** The innermost frame from the code root on that stack: where in our code it was. */
  hottestCode: ProfileFrame | null;
}

export interface ProfileSummaryBody {
  profiledMs: number;
  /** The innermost frame from the code root on the hottest stack across the long runs. */
  hottestCode: ProfileFrame | null;
  /** Time in every non-idle sample. */
  busyMs: number;
  /** Time in the long busy runs the rest of the summary covers. */
  longRunMs: number;
  /** The longest runs, in the order they happened. */
  longRuns: ProfileLongRun[];
  /** Frames by self time across the long runs. */
  bySelf: ProfileFrameStat[];
  /** Frames from the code root by total time across the long runs. */
  byTotal: ProfileFrameStat[];
  /** Whole stacks by time across the long runs, innermost frame first. */
  topStacks: Array<{ selfMs: number; frames: ProfileFrame[] }>;
}

export interface SummarizeOptions {
  minRunMs: number;
  /** Absolute directory file paths are made relative to. */
  codeRoot: string;
  /** Entries per ranked list. Default 10. */
  top?: number;
}

const MAX_LONG_RUNS = 10;
const MAX_STACKS = 5;
const MAX_STACK_FRAMES = 20;
const RUN_TOP_SELF = 3;
const RUN_STACK_FRAMES = 12;

interface FrameInfo extends ProfileFrame {
  key: string;
  inRoot: boolean;
}

interface Accumulator {
  self: Map<string, number>;
  total: Map<string, number>;
  byLeaf: Map<number, number>;
}

function newAccumulator(): Accumulator {
  return { self: new Map(), total: new Map(), byLeaf: new Map() };
}

function add(map: Map<string | number, number>, key: string | number, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

/** A location as the summary stores it; see the module comment. */
export function displayPath(url: string, codeRoot: string): { file: string; inRoot: boolean } {
  if (!url) return { file: "", inRoot: false };
  if (url.startsWith("node:")) return { file: url, inRoot: false };
  let path: string;
  if (url.startsWith("file:")) {
    try {
      path = fileURLToPath(url);
    } catch {
      return { file: "", inRoot: false };
    }
  } else if (url.startsWith("/") || /^[A-Za-z]:[\\/]/.test(url)) {
    path = url;
  } else {
    // Some other scheme (`data:`, `wasm:`, an eval): its kind, not its body.
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1];
    return { file: scheme ? `${scheme}:` : "", inRoot: false };
  }
  path = path.replace(/\\/g, "/");
  // Under `node_modules/`, our own packages are ours wherever they are
  // installed: in an npm install the whole gateway lives there.
  const nm = path.lastIndexOf("/node_modules/");
  if (nm >= 0) {
    const file = path.slice(nm + 1);
    return { file, inRoot: file.startsWith("node_modules/@omnesis/") };
  }
  const root = codeRoot.replace(/\\/g, "/").replace(/\/?$/, "/");
  if (path.startsWith(root)) return { file: path.slice(root.length), inRoot: true };
  return { file: path.slice(path.lastIndexOf("/") + 1), inRoot: false };
}

export function summarizeProfile(profile: CpuProfile, opts: SummarizeOptions): ProfileSummaryBody {
  const top = opts.top ?? 10;
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

  const frameCache = new Map<number, FrameInfo>();
  const frameOf = (id: number): FrameInfo => {
    let f = frameCache.get(id);
    if (f) return f;
    const cf = nodes.get(id)!.callFrame;
    const { file, inRoot } = displayPath(cf.url, opts.codeRoot);
    const line = cf.lineNumber >= 0 ? cf.lineNumber + 1 : null;
    const functionName = cf.functionName || "(anonymous)";
    f = { functionName, file, line, inRoot, key: `${functionName}\u0000${file}\u0000${line}` };
    frameCache.set(id, f);
    return f;
  };
  // Root-to-leaf paths, leaf first, without `(root)`; shared by every sample
  // that lands on the same node.
  const pathCache = new Map<number, number[]>();
  const pathOf = (leaf: number): number[] => {
    let p = pathCache.get(leaf);
    if (p) return p;
    p = [];
    for (let id: number | undefined = leaf; id !== undefined; id = parent.get(id)) {
      if (parent.get(id) === undefined) break; // the root node
      p.push(id);
    }
    pathCache.set(leaf, p);
    return p;
  };
  const isIdle = (id: number): boolean => nodes.get(id)?.callFrame.functionName === "(idle)";

  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const times: number[] = new Array(samples.length);
  let t = profile.startTime;
  for (let i = 0; i < samples.length; i++) {
    t += deltas[i] ?? 0;
    times[i] = t;
  }
  // A sample stands for the time until the next one.
  const weightMs = (i: number): number =>
    Math.max(0, (i + 1 < samples.length ? times[i + 1]! : profile.endTime) - times[i]!) / 1000;

  const whole = newAccumulator();
  const runs: Array<{ start: number; end: number; durationMs: number }> = [];
  let busyMs = 0;
  let runStart = -1;
  const closeRun = (end: number): void => {
    if (runStart < 0) return;
    let durationMs = 0;
    for (let i = runStart; i < end; i++) durationMs += weightMs(i);
    if (durationMs >= opts.minRunMs) runs.push({ start: runStart, end, durationMs });
    runStart = -1;
  };
  for (let i = 0; i < samples.length; i++) {
    if (isIdle(samples[i]!)) {
      closeRun(i);
      continue;
    }
    busyMs += weightMs(i);
    if (runStart < 0) runStart = i;
  }
  closeRun(samples.length);

  const accumulate = (acc: Accumulator, from: number, to: number): void => {
    for (let i = from; i < to; i++) {
      const leaf = samples[i]!;
      const w = weightMs(i);
      const path = pathOf(leaf);
      if (path.length === 0) continue;
      add(acc.self, frameOf(leaf).key, w);
      add(acc.byLeaf, leaf, w);
      const seen = new Set<string>();
      for (const id of path) {
        const key = frameOf(id).key;
        if (seen.has(key)) continue;
        seen.add(key);
        add(acc.total, key, w);
      }
    }
  };

  const framesByKey = new Map<string, FrameInfo>();
  for (const id of nodes.keys()) framesByKey.set(frameOf(id).key, frameOf(id));
  const stat = (key: string, acc: Accumulator): ProfileFrameStat => {
    const f = framesByKey.get(key)!;
    return {
      functionName: f.functionName,
      file: f.file,
      line: f.line,
      selfMs: round(acc.self.get(key) ?? 0),
      totalMs: round(acc.total.get(key) ?? 0),
    };
  };
  const frame = (id: number): ProfileFrame => {
    const f = frameOf(id);
    return { functionName: f.functionName, file: f.file, line: f.line };
  };
  const ranked = (
    map: Map<string, number>,
    n: number,
    keep: (key: string) => boolean = () => true,
  ) =>
    [...map.entries()]
      .filter(([key]) => keep(key))
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([key]) => key);

  const longRuns: ProfileLongRun[] = [];
  const kept = [...runs]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, MAX_LONG_RUNS)
    .sort((a, b) => a.start - b.start);
  const hottestLeafOf = (acc: Accumulator): number | undefined =>
    [...acc.byLeaf.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const codeFrameOn = (leaf: number | undefined): ProfileFrame | null => {
    const id = leaf === undefined ? undefined : pathOf(leaf).find((n) => frameOf(n).inRoot);
    return id === undefined ? null : frame(id);
  };
  for (const run of runs) accumulate(whole, run.start, run.end);
  for (const run of kept) {
    const acc = newAccumulator();
    accumulate(acc, run.start, run.end);
    const hottestLeaf = hottestLeafOf(acc);
    longRuns.push({
      offsetMs: round((times[run.start]! - profile.startTime) / 1000),
      durationMs: round(run.durationMs),
      topSelf: ranked(acc.self, RUN_TOP_SELF).map((key) => stat(key, acc)),
      hotStack:
        hottestLeaf === undefined ? [] : pathOf(hottestLeaf).slice(0, RUN_STACK_FRAMES).map(frame),
      hottestCode: codeFrameOn(hottestLeaf),
    });
  }

  return {
    profiledMs: round((profile.endTime - profile.startTime) / 1000),
    hottestCode: codeFrameOn(hottestLeafOf(whole)),
    busyMs: round(busyMs),
    longRunMs: round(runs.reduce((sum, r) => sum + r.durationMs, 0)),
    longRuns,
    bySelf: ranked(whole.self, top).map((key) => stat(key, whole)),
    byTotal: ranked(whole.total, top, (key) => framesByKey.get(key)!.inRoot).map((key) =>
      stat(key, whole),
    ),
    topStacks: [...whole.byLeaf.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_STACKS)
      .map(([leaf, ms]) => ({
        selfMs: round(ms),
        frames: pathOf(leaf).slice(0, MAX_STACK_FRAMES).map(frame),
      })),
  };
}
