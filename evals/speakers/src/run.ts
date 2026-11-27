// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `npm run speaker-eval:run` — score grouping candidates on the separated
 * recordings and write the tables.
 *
 * Parameters are chosen on VoxConverse (the tuning set) and the chosen ones
 * are confirmed on AMI (the confirmation set), which no choice looks at. The
 * best parameters on AMI are reported beside them only to show the gap.
 *
 * Output: `results/<name>.json` (every candidate on every recording) and
 * `results/<name>.md` (the tables RESULTS.md quotes).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  c0,
  c1,
  c2,
  c3,
  c4,
  c5,
  centroids,
  matchSelf,
  meanVoice,
  pinOwner,
  relabel,
  Session,
  type Candidate,
} from "./candidates.js";
import {
  defaultDataDir,
  hasSeparated,
  loadSeparated,
  paths,
  talkPerSpeaker,
  truncate,
  type LoadedRecording,
} from "./dataset.js";
import { attribution, referenceForWindows, type WindowReference } from "./metrics.js";
import { dot } from "./vectors.js";

const PARTICIPANT_MS = 10_000;
const ENROL_MS = 60_000;
const TARGET_ERROR = 0.15;

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

interface Item {
  id: string;
  recording: string;
  dataset: string;
  durationMs: number;
  truncated: boolean;
  rec: LoadedRecording;
  refs: WindowReference[];
  durations: number[];
  session: Session;
  trueAll: number;
  true10: number;
  overlapShare: number;
  nonSpeechShare: number;
}

function makeItem(rec: LoadedRecording, recording: string, truncated: boolean): Item {
  const refs = referenceForWindows(rec.windows, rec.reference);
  const durations = rec.windows.map((w) => w.endMs - w.startMs);
  const talk = talkPerSpeaker(rec.reference);
  const total = durations.reduce((a, b) => a + b, 0) || 1;
  return {
    id: rec.id,
    recording,
    dataset: rec.dataset,
    durationMs: rec.durationMs,
    truncated,
    rec,
    refs,
    durations,
    session: new Session(rec.vectors, durations),
    trueAll: talk.size,
    true10: [...talk.values()].filter((t) => t >= PARTICIPANT_MS).length,
    overlapShare: refs.reduce((s, r) => s + r.overlapMs, 0) / total,
    nonSpeechShare: refs.reduce((s, r, i) => s + (r.speaker ? 0 : durations[i]!), 0) / total,
  };
}

interface Row {
  item: string;
  est: number;
  error: number;
  ms: number;
}

function scoreItem(c: Candidate, it: Item): Row {
  const t = performance.now();
  const labels = c.group(it.session);
  const ms = performance.now() - t;
  return {
    item: it.id,
    est: new Set(labels).size,
    error: attribution(labels, it.durations, it.refs).error,
    ms,
  };
}

interface Summary {
  n: number;
  exact10: number;
  exactAll: number;
  absErr: number;
  over: number;
  under: number;
  error: number;
  joint: number;
}

function summarize(rows: readonly Row[], items: Map<string, Item>): Summary {
  const n = rows.length;
  if (n === 0)
    return { n, exact10: 0, exactAll: 0, absErr: 0, over: 0, under: 0, error: 0, joint: 0 };
  let exact10 = 0;
  let exactAll = 0;
  let absErr = 0;
  let over = 0;
  let under = 0;
  let error = 0;
  let joint = 0;
  for (const r of rows) {
    const it = items.get(r.item)!;
    if (r.est === it.true10) exact10 += 1;
    if (r.est === it.trueAll) exactAll += 1;
    if (r.est > it.true10) over += 1;
    if (r.est < it.true10) under += 1;
    absErr += Math.abs(r.est - it.true10);
    error += r.error;
    if (r.est === it.true10 && r.error <= TARGET_ERROR) joint += 1;
  }
  return {
    n,
    exact10: exact10 / n,
    exactAll: exactAll / n,
    absErr: absErr / n,
    over: over / n,
    under: under / n,
    error: error / n,
    joint: joint / n,
  };
}

/** Lexicographic: exact count, then lower attribution error. */
function better(a: Summary, b: Summary): boolean {
  if (Math.abs(a.exact10 - b.exact10) > 1e-9) return a.exact10 > b.exact10;
  return a.error < b.error;
}

function grid(): Candidate[] {
  const thresholds = [0.3, 0.325, 0.35, 0.375, 0.4, 0.425, 0.45, 0.475, 0.5];
  const shares = [0.03, 0.05, 0.07, 0.1, 0.12, 0.15];
  const lengths = [2000, 3000, 4000];
  const out: Candidate[] = [];
  for (const t of thresholds) {
    out.push(c0(t));
    for (const s of shares) out.push(c1(t, s));
    for (const l of lengths) {
      out.push(c2(t, l));
      for (const s of shares) out.push(c3(t, l, s));
    }
  }
  for (const t of [0.2, 0.25, 0.3, 0.35, 0.4, 0.45])
    for (const anchorMs of [15_000, 30_000, 60_000])
      for (const absorbSimilarity of [0.3, 0.4, 0.5])
        for (const participantMs of [5_000, 10_000, 15_000, 20_000, 30_000, 45_000])
          out.push(c5({ threshold: t, anchorMs, absorbSimilarity, participantMs }));
  for (const minWindowMs of [0, 2000, 3000])
    for (const share of [0.02, 0.05, 0.1]) out.push(c4({ minWindowMs, maxSpeakers: 8, share }));
  return out;
}

const pct = (x: number): string => `${(100 * x).toFixed(0)}%`;
const pct1 = (x: number): string => `${(100 * x).toFixed(1)}%`;

function table(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

type Bucket = { name: string; test: (it: Item) => boolean };

const HEADLINE: Bucket = { name: "2–4 spk", test: (it) => it.true10 >= 2 && it.true10 <= 4 };
const BUCKETS: Bucket[] = [
  { name: "2 spk", test: (it) => it.true10 === 2 },
  { name: "3 spk", test: (it) => it.true10 === 3 },
  { name: "4+ spk", test: (it) => it.true10 >= 4 },
  { name: "3–4 spk", test: (it) => it.true10 >= 3 && it.true10 <= 4 },
  { name: "<10 min", test: (it) => HEADLINE.test(it) && it.durationMs < 10 * 60_000 },
  { name: "≥10 min", test: (it) => HEADLINE.test(it) && it.durationMs >= 10 * 60_000 },
  HEADLINE,
];

function summaryCells(s: Summary): string[] {
  return [
    String(s.n),
    pct(s.exact10),
    pct(s.exactAll),
    s.absErr.toFixed(2),
    `${pct(s.over)} / ${pct(s.under)}`,
    pct1(s.error),
    pct(s.joint),
  ];
}
const SUMMARY_HEADER = [
  "n",
  "exact count (≥10 s)",
  "exact count (all)",
  "mean |Δcount|",
  "over / under",
  "attribution error",
  "exact & error ≤15 %",
];

// ── Owner profile ─────────────────────────────────────────────────────────

interface OwnerTrial {
  item: string;
  kind: "in-session" | "cross-session" | "impostor";
  owner: string | null;
  /** Session windows the trial groups (enrolment windows removed in-session). */
  keep: boolean[];
  profile: Float32Array;
}

/** Clean windows of `speaker`, spread over the recording, up to `ms` of talk. */
function enrolmentWindows(it: Item, speaker: string, ms: number): number[] {
  const clean = it.refs.flatMap((r, i) =>
    r.speaker === speaker && r.overlapMs === 0 && r.speechMs >= 0.8 * it.durations[i]! ? [i] : [],
  );
  const total = clean.reduce((s, i) => s + it.durations[i]!, 0);
  if (total < ms * 0.75) return [];
  const step = total / ms;
  const out: number[] = [];
  let acc = 0;
  for (let k = 0; k < clean.length && acc < ms; k += Math.max(1, Math.floor(step))) {
    out.push(clean[k]!);
    acc += it.durations[clean[k]!]!;
  }
  return out;
}

function dominant(it: Item): string | null {
  const t = new Map<string, number>();
  it.refs.forEach(
    (r, i) => r.speaker && t.set(r.speaker, (t.get(r.speaker) ?? 0) + it.durations[i]!),
  );
  let best: string | null = null;
  for (const [s, x] of t) if (!best || x > t.get(best)!) best = s;
  return best;
}

function ownerTrials(items: Item[]): OwnerTrial[] {
  const trials: OwnerTrial[] = [];
  const profiles: {
    item: string;
    dataset: string;
    series: string;
    speaker: string;
    profile: Float32Array;
  }[] = [];
  for (const it of items) {
    const owner = dominant(it);
    if (!owner) continue;
    const enrol = enrolmentWindows(it, owner, ENROL_MS);
    if (enrol.length === 0) continue;
    const set = new Set(enrol);
    const profile = meanVoice(enrol.map((i) => it.rec.vectors[i]!));
    trials.push({
      item: it.id,
      kind: "in-session",
      owner,
      keep: it.durations.map((_, i) => !set.has(i)),
      profile,
    });
    profiles.push({
      item: it.id,
      dataset: it.dataset,
      series: it.id.slice(0, 6),
      speaker: owner,
      profile,
    });
  }
  // AMI speakers keep their ids across a series' meetings: enrol on one, test on another.
  for (const it of items) {
    if (it.dataset !== "ami") continue;
    const owner = dominant(it);
    const series = it.id.slice(0, 6);
    for (const other of items) {
      if (other === it || other.dataset !== "ami" || other.id.slice(0, 6) !== series) continue;
      const enrol = enrolmentWindows(other, owner!, ENROL_MS);
      if (enrol.length === 0) continue;
      trials.push({
        item: it.id,
        kind: "cross-session",
        owner,
        keep: it.durations.map(() => true),
        profile: meanVoice(enrol.map((i) => other.rec.vectors[i]!)),
      });
      break;
    }
  }
  // Impostors: a profile of somebody who is not in the session.
  items.forEach((it, k) => {
    const speakers = new Set(it.rec.reference.map((t) => t.speaker));
    const series = it.id.slice(0, 6);
    for (let j = 1; j < profiles.length; j += 1) {
      const p = profiles[(k + j) % profiles.length]!;
      if (p.dataset !== it.dataset || p.item === it.id) continue;
      if (it.dataset === "ami" && (p.series === series || speakers.has(p.speaker))) continue;
      trials.push({
        item: it.id,
        kind: "impostor",
        owner: null,
        keep: it.durations.map(() => true),
        profile: p.profile,
      });
      break;
    }
  });
  return trials;
}

function subItem(it: Item, keep: boolean[]): Item {
  if (keep.every(Boolean)) return it;
  const rec: LoadedRecording = {
    ...it.rec,
    windows: it.rec.windows.filter((_, i) => keep[i]),
    vectors: it.rec.vectors.filter((_, i) => keep[i]),
  };
  return makeItem(rec, it.recording, it.truncated);
}

function majority(
  labels: number[],
  refs: WindowReference[],
  durations: number[],
  label: number,
): string | null {
  const t = new Map<string, number>();
  labels.forEach((l, i) => {
    const s = refs[i]!.speaker;
    if (l === label && s) t.set(s, (t.get(s) ?? 0) + durations[i]!);
  });
  let best: string | null = null;
  for (const [s, x] of t) if (!best || x > t.get(best)!) best = s;
  return best;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string" },
      cache: { type: "string", default: "separated" },
      name: { type: "string", default: "latest" },
      "skip-spectral": { type: "boolean" },
    },
  });
  const dataDir = values["data-dir"] ?? defaultDataDir();
  const p = paths(dataDir, values.cache);
  const manifest = JSON.parse(readFileSync(p.manifest, "utf8")) as { recordings: { id: string }[] };
  const missing = manifest.recordings.filter((r) => !hasSeparated(p.separated, r.id));
  if (missing.length > 0)
    say(`Not separated yet, left out: ${missing.map((r) => r.id).join(", ")}`);
  const recordings = manifest.recordings
    .filter((r) => hasSeparated(p.separated, r.id))
    .map((r) => loadSeparated(p.separated, r.id));
  const full = recordings.map((r) => makeItem(r, r.id, false));
  const truncated: Item[] = [];
  for (const r of recordings) {
    for (const limit of [10, 30]) {
      if (r.durationMs >= limit * 60_000 * 1.2)
        truncated.push(makeItem(truncate(r, limit * 60_000), r.id, true));
    }
  }
  const all = [...full, ...truncated];
  const byId = new Map(all.map((it) => [it.id, it]));
  const vox = full.filter((it) => it.dataset === "voxconverse");
  const ami = full.filter((it) => it.dataset === "ami");
  say(`${vox.length} VoxConverse + ${ami.length} AMI recordings, ${truncated.length} truncations`);

  let candidates = grid();
  if (values["skip-spectral"]) candidates = candidates.filter((c) => c.family !== "C4");
  const rows = new Map<string, Row[]>();
  const started = Date.now();
  for (const c of candidates)
    rows.set(
      c.name,
      all.map((it) => scoreItem(c, it)),
    );
  say(`Scored ${candidates.length} candidates in ${((Date.now() - started) / 1000).toFixed(0)} s`);

  const rowsFor = (c: Candidate, items: Item[]): Row[] => {
    const ids = new Set(items.map((it) => it.id));
    return rows.get(c.name)!.filter((r) => ids.has(r.item));
  };
  const head = (items: Item[]) => items.filter(HEADLINE.test);
  const families = [...new Set(candidates.map((c) => c.family))];
  const baseline = candidates.find((c) => c.name === "C0 t=0.4")!;
  // Omi's own constants, as shipped for its WeSpeaker model.
  const omi = candidates.find((c) => c.name === "C5 t=0.3 anchor=30s absorb=0.4 part=10s")!;
  // A parameter set is judged with its threshold neighbours (±0.025), so a
  // choice lands on a plateau rather than on a lucky peak of a small set.
  const neighbours = (c: Candidate): Candidate[] =>
    candidates.filter(
      (o) =>
        o.family === c.family &&
        Object.entries(c.params).every(([k, v]) =>
          k === "threshold" ? Math.abs(o.params[k]! - v) < 0.026 : o.params[k] === v,
        ),
    );
  const smooth = (c: Candidate, score: (c: Candidate) => Summary): Summary => {
    const all = neighbours(c).map(score);
    const mean = (k: keyof Summary) => all.reduce((s, x) => s + x[k], 0) / all.length;
    return { ...score(c), exact10: mean("exact10"), error: mean("error") };
  };
  const chosen = new Map<string, Candidate>();
  const amiBest = new Map<string, Candidate>();
  for (const f of families) {
    const fam = candidates.filter((c) => c.family === f);
    const on = (items: Item[]) => (c: Candidate) => summarize(rowsFor(c, head(items)), byId);
    const pick = (items: Item[], smoothed: boolean) =>
      fam.reduce((a, b) => {
        const score = smoothed ? (c: Candidate) => smooth(c, on(items)) : on(items);
        return better(score(b), score(a)) ? b : a;
      });
    chosen.set(f, pick(vox, true));
    // The oracle is the plain best, smoothing would only hide how high it reaches.
    amiBest.set(f, pick(ami, false));
  }
  const voxBest = [...chosen.values()].reduce((a, b) =>
    better(summarize(rowsFor(b, head(vox)), byId), summarize(rowsFor(a, head(vox)), byId)) ? b : a,
  );

  // Cross-fitting: choose on VoxConverse plus two AMI series, score on the
  // other two, and the other way round. Every AMI meeting is scored once by
  // parameters that never saw its series. VoxConverse and the AMI part weigh
  // the same in the choice.
  const seriesOf = (it: Item) => it.id.slice(0, 6);
  const folds = [
    { train: ["ES2004", "IS1009"], test: ["TS3003", "EN2002"] },
    { train: ["TS3003", "EN2002"], test: ["ES2004", "IS1009"] },
  ];
  const joint = (c: Candidate, amiPart: Item[]): Summary => {
    const a = summarize(rowsFor(c, head(vox)), byId);
    const b = summarize(rowsFor(c, head(amiPart)), byId);
    return { ...a, exact10: (a.exact10 + b.exact10) / 2, error: (a.error + b.error) / 2 };
  };
  const pickJoint = (pool: Candidate[], amiPart: Item[]): Candidate => {
    const score = (c: Candidate) => smooth(c, (x) => joint(x, amiPart));
    return pool.reduce((a, b) => (better(score(b), score(a)) ? b : a));
  };
  const crossFit = new Map<string, { picks: Candidate[]; rows: Row[] }>();
  for (const f of families) {
    const fam = candidates.filter((c) => c.family === f);
    const picks: Candidate[] = [];
    const out: Row[] = [];
    for (const fold of folds) {
      const train = ami.filter((it) => fold.train.includes(seriesOf(it)));
      const test = ami.filter((it) => fold.test.includes(seriesOf(it)));
      const c = pickJoint(fam, train);
      picks.push(c);
      out.push(...rowsFor(c, test));
    }
    crossFit.set(f, { picks, rows: out });
  }
  // The recommendation: the family whose cross-fitted AMI score is best, at
  // the parameters chosen on VoxConverse and every AMI meeting.
  const bestFamily = families.reduce((a, b) =>
    better(summarize(crossFit.get(b)!.rows, byId), summarize(crossFit.get(a)!.rows, byId)) ? b : a,
  );
  const finalPick = new Map(
    families.map((f) => [
      f,
      pickJoint(
        candidates.filter((c) => c.family === f),
        ami,
      ),
    ]),
  );
  const overall = finalPick.get(bestFamily)!;

  const md: string[] = [];
  md.push(`# Speaker grouping eval — ${values.name}`, "");
  md.push(
    `${vox.length} VoxConverse dev recordings (tuning) and ${ami.length} AMI test meetings (confirmation). ` +
      `True count = reference speakers with ≥10 s of talk; "all" counts every reference speaker. ` +
      `Attribution error is per recording, averaged.`,
    "",
  );
  md.push("## Recordings", "");
  md.push(
    table(
      [
        "recording",
        "set",
        "min",
        "chunks (mean s)",
        "windows",
        "spk ≥10 s / all",
        "overlap",
        "non-speech",
      ],
      full.map((it) => [
        it.id,
        it.dataset,
        (it.durationMs / 60_000).toFixed(1),
        `${it.rec.chunks.length} (${(it.durationMs / 1000 / Math.max(1, it.rec.chunks.length)).toFixed(1)})`,
        String(it.rec.windows.length),
        `${it.true10} / ${it.trueAll}`,
        pct1(it.overlapShare),
        pct1(it.nonSpeechShare),
      ]),
    ),
    "",
  );

  const familyTable = (items: Item[], set: Map<string, Candidate>, label: string): void => {
    md.push(`### ${label}`, "");
    const out: string[][] = [];
    for (const c of new Set([baseline, omi, ...set.values()])) {
      for (const b of BUCKETS) {
        const sub = items.filter(b.test);
        if (sub.length === 0) continue;
        out.push([
          c === baseline
            ? `**${c.name}** (production)`
            : c === omi
              ? `${c.name} (Omi's constants)`
              : c.name,
          b.name,
          ...summaryCells(summarize(rowsFor(c, sub), byId)),
        ]);
      }
    }
    md.push(table(["candidate", "bucket", ...SUMMARY_HEADER], out), "");
  };
  md.push("## Each family at its best VoxConverse parameters", "");
  familyTable(vox, chosen, "VoxConverse (tuning)");
  familyTable(ami, chosen, "AMI (confirmation, same parameters)");
  md.push("## Cross-fitted: chosen on VoxConverse + two AMI series, scored on the other two", "");
  md.push(
    table(
      ["family", "fold picks", ...SUMMARY_HEADER],
      families.map((f) => {
        const cf = crossFit.get(f)!;
        return [
          f,
          cf.picks.map((c) => c.name.slice(3)).join(" · "),
          ...summaryCells(summarize(cf.rows, byId)),
        ];
      }),
    ),
    "",
  );
  md.push("## Each family at its parameters chosen on VoxConverse + all AMI (equal weight)", "");
  familyTable(vox, finalPick, "VoxConverse");
  familyTable(ami, finalPick, "AMI (in-sample for these parameters; see the cross-fitted table)");
  md.push("## For comparison: each family at its best AMI parameters (oracle, not a choice)", "");
  familyTable(ami, amiBest, "AMI oracle");

  md.push("## Threshold sweeps (2–4 speakers, VoxConverse / AMI)", "");
  const sweepRows: string[][] = [];
  for (const f of families) {
    const best = chosen.get(f)!;
    const same = candidates.filter(
      (c) =>
        c.family === f &&
        Object.entries(best.params).every(([k, v]) => k === "threshold" || c.params[k] === v),
    );
    for (const c of same) {
      const sv = summarize(rowsFor(c, head(vox)), byId);
      const sa = summarize(rowsFor(c, head(ami)), byId);
      sweepRows.push([
        c.name,
        pct(sv.exact10),
        sv.absErr.toFixed(2),
        pct1(sv.error),
        pct(sa.exact10),
        sa.absErr.toFixed(2),
        pct1(sa.error),
      ]);
    }
  }
  md.push(
    table(
      ["candidate", "Vox exact", "Vox |Δ|", "Vox error", "AMI exact", "AMI |Δ|", "AMI error"],
      sweepRows,
    ),
    "",
  );

  md.push("## Top 15 parameter sets on VoxConverse, with AMI", "");
  const ranked = [...candidates].sort((a, b) =>
    better(summarize(rowsFor(a, head(vox)), byId), summarize(rowsFor(b, head(vox)), byId)) ? -1 : 1,
  );
  md.push(
    table(
      ["candidate", "Vox exact", "Vox |Δ|", "Vox error", "AMI exact", "AMI |Δ|", "AMI error"],
      ranked.slice(0, 15).map((c) => {
        const sv = summarize(rowsFor(c, head(vox)), byId);
        const sa = summarize(rowsFor(c, head(ami)), byId);
        return [
          c.name,
          pct(sv.exact10),
          sv.absErr.toFixed(2),
          pct1(sv.error),
          pct(sa.exact10),
          sa.absErr.toFixed(2),
          pct1(sa.error),
        ];
      }),
    ),
    "",
  );

  md.push("## Production-length truncations (first 10 and 30 minutes)", "");
  const truncRows: string[][] = [];
  for (const c of new Set([baseline, omi, ...chosen.values(), ...finalPick.values()])) {
    for (const lim of ["@10m", "@30m"]) {
      for (const [setName, ds] of [
        ["Vox", "voxconverse"],
        ["AMI", "ami"],
      ] as const) {
        const sub = truncated.filter(
          (it) => it.id.endsWith(lim) && it.dataset === ds && HEADLINE.test(it),
        );
        if (sub.length === 0) continue;
        truncRows.push([
          c.name,
          `${setName} ${lim.slice(1)}`,
          ...summaryCells(summarize(rowsFor(c, sub), byId)),
        ]);
      }
    }
  }
  md.push(table(["candidate", "truncation", ...SUMMARY_HEADER], truncRows), "");

  md.push(`## Per recording: ${baseline.name} vs ${overall.name}`, "");
  md.push(
    table(
      ["recording", "true ≥10 s", "C0 count", "C0 error", "best count", "best error"],
      full.map((it) => {
        const a = rows.get(baseline.name)!.find((r) => r.item === it.id)!;
        const b = rows.get(overall.name)!.find((r) => r.item === it.id)!;
        return [
          it.id,
          String(it.true10),
          String(a.est),
          pct1(a.error),
          String(b.est),
          pct1(b.error),
        ];
      }),
    ),
    "",
  );

  // ── Owner profile ───────────────────────────────────────────────────────
  md.push("## Owner profile", "");
  const trials = ownerTrials(full);
  md.push(
    `${trials.filter((t) => t.kind === "in-session").length} in-session trials (60 s of the dominant speaker's clean windows enrolled and removed from the session), ` +
      `${trials.filter((t) => t.kind === "cross-session").length} AMI cross-session trials (enrolled from another meeting of the same series), ` +
      `${trials.filter((t) => t.kind === "impostor").length} impostor trials (a profile of someone absent). Grouping: ${overall.name}.`,
    "",
  );
  md.push("### `matchSelf` rule (speaker mean vs profile ≥ threshold)", "");
  const matchRows: string[][] = [];
  const trialLabels = trials.map((t) => {
    const it = subItem(byId.get(t.item)!, t.keep);
    return { t, it, labels: overall.group(it.session) };
  });
  const simStats: Record<string, number[]> = {};
  const addStat = (key: string, x: number) => (simStats[key] ??= []).push(x);
  for (const { t, it, labels } of trialLabels) {
    const c = centroids(labels, it.session.unit);
    const sims = [...c].map(([g, m]) => ({
      g,
      s: dot(m, t.profile),
      who: majority(labels, it.refs, it.durations, g),
    }));
    const tag = `${t.kind}, ${it.dataset}`;
    if (t.kind === "impostor")
      addStat(`most similar speaker — impostor, ${it.dataset}`, Math.max(...sims.map((x) => x.s)));
    else {
      const own = sims.filter((x) => x.who === t.owner).map((x) => x.s);
      const non = sims.filter((x) => x.who !== t.owner).map((x) => x.s);
      if (own.length) addStat(`owner's speaker — ${tag}`, Math.max(...own));
      if (non.length) addStat(`most similar other speaker — ${tag}`, Math.max(...non));
    }
  }
  for (const threshold of [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7]) {
    for (const kind of ["in-session", "cross-session", "impostor"] as const) {
      const sub = trialLabels.filter((x) => x.t.kind === kind);
      if (sub.length === 0) continue;
      for (const ds of ["voxconverse", "ami"]) {
        const set = sub.filter((x) => x.it.dataset === ds);
        if (set.length === 0) continue;
        let correct = 0;
        let wrong = 0;
        let miss = 0;
        for (const { t, it, labels } of set) {
          const m = matchSelf(it.rec.vectors, labels, t.profile, threshold);
          if (!m) miss += 1;
          else if (t.owner && majority(labels, it.refs, it.durations, m.label) === t.owner)
            correct += 1;
          else wrong += 1;
        }
        matchRows.push([
          threshold.toFixed(2),
          kind,
          ds,
          String(set.length),
          kind === "impostor" ? "—" : pct(correct / set.length),
          pct(wrong / set.length),
          kind === "impostor" ? "—" : pct(miss / set.length),
        ]);
      }
    }
  }
  md.push(
    table(
      [
        "threshold",
        "trial",
        "set",
        "n",
        "owner named",
        "false match (someone else named owner)",
        "miss",
      ],
      matchRows,
    ),
    "",
  );
  const quant = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const q = (f: number) =>
      s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))]!.toFixed(2) : "—";
    return [q(0), q(0.1), q(0.5), q(0.9), q(1)];
  };
  md.push(
    table(
      ["similarity to profile", "min", "p10", "median", "p90", "max"],
      Object.entries(simStats)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, xs]) => [`${k} (n=${xs.length})`, ...quant(xs)]),
    ),
    "",
  );

  md.push("### Using the profile to group: window pinning", "");
  const pinRows: string[][] = [];
  const targetTrials = trialLabels.filter((x) => x.t.kind !== "impostor");
  const baseOf = (sel: typeof targetTrials, group: (s: Session) => number[]) =>
    sel.map(({ it }) => {
      const labels = group(it.session);
      return {
        item: it.id,
        est: new Set(labels).size,
        error: attribution(labels, it.durations, it.refs).error,
        ms: 0,
      };
    });
  const trialItems = new Map(targetTrials.map((x) => [x.it.id, x.it]));
  for (const kind of ["in-session", "cross-session"] as const) {
    for (const ds of ["voxconverse", "ami"]) {
      const sel = targetTrials.filter(
        (x) => x.t.kind === kind && x.it.dataset === ds && HEADLINE.test(x.it),
      );
      if (sel.length === 0) continue;
      const items = new Map([...byId, ...trialItems]);
      const base = summarize(
        baseOf(sel, (s) => overall.group(s)),
        items,
      );
      pinRows.push([kind, ds, "no profile", ...summaryCells(base)]);
      for (const threshold of [0.5, 0.6, 0.7, 0.8])
        for (const margin of [0, 0.1]) {
          const r = sel.map(({ t, it }) => {
            const labels = pinOwner(it.session, t.profile, threshold, margin, (s) =>
              overall.group(s),
            );
            return {
              item: it.id,
              est: new Set(labels).size,
              error: attribution(labels, it.durations, it.refs).error,
              ms: 0,
            };
          });
          pinRows.push([
            kind,
            ds,
            `pin T=${threshold} margin=${margin}`,
            ...summaryCells(summarize(r, items)),
          ]);
        }
      // Merge every speaker matchSelf-similar to the profile into one owner.
      for (const threshold of [0.5, 0.6, 0.7]) {
        const r = sel.map(({ t, it }) => {
          const labels = overall.group(it.session);
          const c = centroids(labels, it.session.unit);
          const own = new Set(
            [...c].filter(([, m]) => dot(m, t.profile) >= threshold).map(([g]) => g),
          );
          const first = [...own][0];
          const merged = relabel(labels.map((l) => (own.has(l) ? first! : l)));
          return {
            item: it.id,
            est: new Set(merged).size,
            error: attribution(merged, it.durations, it.refs).error,
            ms: 0,
          };
        });
        pinRows.push([
          kind,
          ds,
          `merge speakers ≥${threshold}`,
          ...summaryCells(summarize(r, items)),
        ]);
      }
    }
  }
  md.push(table(["trial", "set", "variant", ...SUMMARY_HEADER], pinRows), "");

  // ── Runtime ─────────────────────────────────────────────────────────────
  md.push("## Grouping runtime", "");
  const pool = full.flatMap((it) => it.rec.vectors.map((v, i) => ({ v, d: it.durations[i]! })));
  const runtimeRows: string[][] = [];
  for (const n of [500, 1000, 2000]) {
    const sample = Array.from({ length: n }, (_, i) => pool[(i * 7919) % pool.length]!);
    const s = () =>
      new Session(
        sample.map((x) => x.v),
        sample.map((x) => x.d),
      );
    for (const c of [baseline, overall]) {
      const t = performance.now();
      c.group(s());
      runtimeRows.push([String(n), c.name, `${((performance.now() - t) / 1000).toFixed(2)} s`]);
    }
  }
  md.push(table(["windows", "candidate", "wall time (one core)"], runtimeRows), "");

  md.push(
    "## Chosen",
    "",
    `Best on VoxConverse alone: **${voxBest.name}**. Recommended (best cross-fitted family, parameters chosen on VoxConverse + all AMI): **${overall.name}**.`,
    "",
  );
  for (const [label, items] of [
    ["VoxConverse", vox],
    ["AMI", ami],
  ] as const) {
    const long = items.filter((it) => HEADLINE.test(it) && it.durationMs >= 10 * 60_000);
    const s = summarize(rowsFor(overall, long), byId);
    md.push(
      `- ${label}, 2–4 speakers, ≥10 min (n=${s.n}): exact count ${pct(s.exact10)}, mean attribution error ${pct1(s.error)}, both on ${pct(s.joint)}.`,
    );
  }
  md.push("");

  const outDir = join(import.meta.dirname, "..", "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${values.name}.md`), `${md.join("\n")}\n`);
  writeFileSync(
    join(outDir, `${values.name}.json`),
    `${JSON.stringify(
      {
        recordings: full.map((it) => ({
          id: it.id,
          dataset: it.dataset,
          minutes: +(it.durationMs / 60_000).toFixed(2),
          windows: it.rec.windows.length,
          true10: it.true10,
          trueAll: it.trueAll,
          separateSeconds: Math.round(it.rec.separateMs / 1000),
        })),
        chosenOnVox: Object.fromEntries([...chosen].map(([f, c]) => [f, c.name])),
        chosenOnBoth: Object.fromEntries([...finalPick].map(([f, c]) => [f, c.name])),
        crossFit: Object.fromEntries(
          [...crossFit].map(([f, x]) => [f, x.picks.map((c) => c.name)]),
        ),
        overall: overall.name,
        // Rows of the candidates the tables name; the full grid is rebuilt by a run.
        rows: Object.fromEntries(
          [
            ...new Set([
              baseline,
              omi,
              ...chosen.values(),
              ...finalPick.values(),
              ...amiBest.values(),
              ...[...crossFit.values()].flatMap((x) => x.picks),
            ]),
          ].map((c) => [
            c.name,
            rows
              .get(c.name)!
              .map((r) => ({ ...r, ms: +r.ms.toFixed(1), error: +r.error.toFixed(4) })),
          ]),
        ),
      },
      null,
      0,
    )}\n`,
  );
  say(`Wrote results/${values.name}.md; recommended: ${overall.name}`);
}

try {
  main();
} catch (err: unknown) {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
}
