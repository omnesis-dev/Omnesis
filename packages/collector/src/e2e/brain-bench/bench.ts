// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `BrainBench` — the boot + stimulus half of the brain end-to-end kit.
 *
 * A bench boots a REAL gateway (via {@link SyntheticE2EHarness}) with the
 * whole cognition engine live: waker, queue, rhythm enqueuers, drainer,
 * run driver, tool layer, write gates and cascades all execute. The only
 * substitution is the model itself, wired at the production seam — the
 * `background-agent` inference assignment — so a bench run exercises the
 * same code path an operator's gateway does.
 *
 * Three things are scriptable:
 *  - the steward's mind: the puppet model (`puppet.ts`) decides each turn
 *    from the run prompt and a behavior table, emitting real tool calls;
 *  - the two gate roles: `entailment-verifier` and `brief-judge` get
 *    verdict servers, so annotation and brief gates can be driven into
 *    their REJECT and configured-outage arms;
 *  - time: with `clock: "virtual"` the gateway's cognition clock is driven
 *    by `POST /admin/brain/clock`, so day boundaries, decay windows and
 *    budget resets are crossed deliberately rather than waited out.
 *
 * Assertions live in `obs.ts` (typed reads over the production admin
 * surface) and `snapshot.ts` (normalized whole-state snapshots).
 */

import Database from "better-sqlite3";
import {
  SyntheticE2EHarness,
  type PushDocumentInput,
  type SyntheticHarnessOptions,
} from "../synth-harness.js";
import { openHarnessDb, sleep, waitFor } from "../briefs-scorecard.js";
import { startPuppetModelServer, type PuppetModelServer, type PuppetBehaviors } from "./puppet.js";
import {
  startVerdictServer,
  type VerdictServer,
  type EntailmentPolicy,
  type JudgePolicy,
} from "./verdict-servers.js";
import { BrainObs } from "./obs.js";

/**
 * Cognition cadences compressed to test speed. Read by the spawned gateway
 * from its inherited env, so this must run before the gateway boots — call
 * it at module scope in a bench test file.
 */
export function compressCognitionCadences(): void {
  process.env.OMNESIS_COGNITION_WAKER_INTERVAL_MS = "100";
  process.env.OMNESIS_COGNITION_WAKER_IDLE_MS = "200";
  process.env.OMNESIS_COGNITION_WAKER_START_DELAY_MS = "300";
  process.env.OMNESIS_COGNITION_DRAIN_INTERVAL_MS = "150";
  process.env.OMNESIS_COGNITION_DRAIN_IDLE_MS = "300";
  process.env.OMNESIS_COGNITION_DRAIN_START_DELAY_MS = "500";
  process.env.OMNESIS_COGNITION_RHYTHM_INTERVAL_MS = "300";
  process.env.OMNESIS_COGNITION_RHYTHM_IDLE_MS = "500";
  process.env.OMNESIS_COGNITION_RHYTHM_START_DELAY_MS = "700";
}

/**
 * The proactive producers, off.
 *
 * A bench asserts on one lane at a time — claim order, a rhythm cadence, a
 * verification pass — and each of these enqueues onto the same run queue the
 * assertion reads. They ship ON, so without this baseline a suite's subject
 * would share its queue with eight other producers and the numbers it counts
 * would depend on which of them happened to fire that tick.
 *
 * A suite that wants one live names it in {@link BrainBenchOptions.brain},
 * which spreads over this. Keep it exhaustive against the shipped defaults: a
 * producer added there without a line here silently rejoins every bench.
 *
 * `mergeAdjudication` and `bootstrap` are deliberately absent — they are not
 * part of this set, ship on for reasons of their own, and the suites that care
 * already opt out by name.
 */
const QUIET_PROACTIVE_LANE: Record<string, unknown> = {
  awarenessAxis: false,
  synthesis: { enabled: false },
  collision: { enabled: false, annotationContradictions: { enabled: false } },
  digest: { enabled: false, push: false },
  reverification: { enabled: false },
  provenanceRecheck: { enabled: false },
  judge: { enabled: false },
  sweepsEnabled: false,
};

export interface BrainBenchOptions {
  /** Override inference at the production seam for alternative model transports. */
  extraInference?: SyntheticHarnessOptions["extraInference"];
  /**
   * Synthetic universe supplying the ambient corpus. Defaults to
   * `loops-test-life` — the Cognition Steward's own test life, whose
   * fixtures are all dated outside the waker's recency window, so boot
   * enqueues zero data runs and every run a bench observes is one it
   * deliberately caused.
   */
  universe?: string;
  /**
   * The steward's scripted mind. Behaviors are matched per run kind; see
   * `puppet-plan.ts` for the DSL. Omit for a bench that only asserts on
   * enqueue-side behavior (the puppet then finishes every run with a
   * no-op final turn).
   */
  behaviors?: PuppetBehaviors;
  /**
   * Directory of `background-agent` replay cassettes to serve INSTEAD of
   * the puppet — a `.jsonl` + `.meta.json` pair per scenario, as built by
   * `scripts/record-brain-scenario.mjs`. Mutually exclusive with `behaviors`.
   */
  cassetteDir?: string;
  /** Entailment-gate verdicts. Omitted → the role is intentionally unassigned. */
  entailment?: EntailmentPolicy;
  /** Brief-judge verdicts. Omitted → the role is intentionally unassigned. */
  judge?: JudgePolicy;
  /**
   * `"virtual"` enables the cognition virtual clock so `clock.set()` /
   * `clock.advance()` drive day boundaries. Defaults to `"real"`.
   */
  clock?: "real" | "virtual";
  /** Experimental gate. Must be explicit because without it the whole engine is inert. */
  experimental: boolean;
  /**
   * Merged into the spawned gateway's `brain` config block, over the bench's
   * quiet baseline — so a suite naming a producer here is the only way that
   * producer runs (see {@link QUIET_PROACTIVE_LANE}).
   */
  brain?: Record<string, unknown>;
  /**
   * Extra top-level `omnesis.json` blocks, spread alongside the assembled
   * `brain` block — a `brain` key here is overwritten, so use `brain` above
   * for that.
   */
  extraGatewayConfig?: Record<string, unknown>;
  /** Wire the deterministic fake embedder (needed for semantic reconcile paths). */
  embedder?: boolean;
  /** Wire the fake APNs server (needed to assert digest / brief pushes). */
  apns?: boolean;
  /** Sync every universe source at boot so the ambient corpus lands. Defaults to true. */
  syncSources?: boolean;
}

/** A queue row seeded directly, for a state no enqueuer produces. */
export interface SeededRun {
  id: string;
  kind: string;
  payload: unknown;
  dedupeKey?: string | null;
  status?: "pending" | "completed" | "failed";
  attempts?: number;
  nextAttemptAt?: number;
  enqueuedAt?: number;
  /** Defaults to `enqueuedAt`; the fold clamp reads it. */
  cycleAnchorAt?: number;
}

/** A document event the bench drives into the gateway. */
export interface BenchDoc {
  externalId: string;
  title: string;
  content: string;
  documentType?: string;
  metadata?: Record<string, unknown>;
  /** Backdates `sourceCreatedAt`/`sourceUpdatedAt` — the waker's recency gate reads these. */
  ageDays?: number;
  /**
   * Absolute source timestamp, in unix ms. Takes precedence over `ageDays`.
   * A virtual-clock suite needs this: `ageDays` is relative to WALL time,
   * while the daily enqueuer selects `source_created_at` against a boundary
   * window the test chose on the cognition clock.
   */
  at?: number;
  sourceId?: string;
  providerId?: string;
}

export class BrainBench {
  readonly harness: SyntheticE2EHarness;
  readonly obs: BrainObs;
  private readonly puppetServer: PuppetModelServer | null;
  private readonly entailmentServer: VerdictServer | null;
  private readonly judgeServer: VerdictServer | null;
  private readonly virtualClock: boolean;
  private db: Database.Database | null = null;

  private constructor(init: {
    harness: SyntheticE2EHarness;
    puppet: PuppetModelServer | null;
    entailment: VerdictServer | null;
    judge: VerdictServer | null;
    virtualClock: boolean;
  }) {
    this.harness = init.harness;
    this.puppetServer = init.puppet;
    this.entailmentServer = init.entailment;
    this.judgeServer = init.judge;
    this.virtualClock = init.virtualClock;
    this.obs = new BrainObs(init.harness);
  }

  static async start(opts: BrainBenchOptions): Promise<BrainBench> {
    if (opts.behaviors && opts.cassetteDir) {
      throw new Error("BrainBench: `behaviors` and `cassetteDir` are mutually exclusive");
    }
    const virtualClock = opts.clock === "virtual";
    if (virtualClock) process.env.OMNESIS_BRIEFS_VIRTUAL_CLOCK = "1";
    else delete process.env.OMNESIS_BRIEFS_VIRTUAL_CLOCK;

    const backends: Record<string, { type: "http"; url: string }> = {};
    const assignments: Record<string, string> = {};

    let puppet: PuppetModelServer | null = null;
    if (opts.cassetteDir) {
      process.env.OMNESIS_AGENT_FIXTURE = opts.cassetteDir;
      assignments["background-agent"] = "replay";
    } else {
      puppet = await startPuppetModelServer({ behaviors: opts.behaviors ?? {} });
      backends.puppet = { type: "http", url: puppet.url };
      assignments["background-agent"] = `puppet/${puppet.modelId}`;
    }

    let entailment: VerdictServer | null = null;
    if (opts.entailment) {
      entailment = await startVerdictServer({ role: "entailment", policy: opts.entailment });
      backends.entailment = { type: "http", url: entailment.url };
      assignments["entailment-verifier"] = `entailment/${entailment.modelId}`;
    }

    let judge: VerdictServer | null = null;
    if (opts.judge) {
      judge = await startVerdictServer({ role: "judge", policy: opts.judge });
      backends.judge = { type: "http", url: judge.url };
      assignments["brief-judge"] = `judge/${judge.modelId}`;
    }

    const harness = new SyntheticE2EHarness({
      gatewayMode: opts.experimental ? "experimental" : "stable",
      universe: opts.universe ?? "loops-test-life",
      ...(opts.embedder ? { embedderBackend: "fake" as const } : {}),
      ...(opts.apns ? { apnsBackend: "fake" as const } : {}),
      extraInference: {
        ...opts.extraInference,
        backends: { ...backends, ...opts.extraInference?.backends },
        assignments: { ...assignments, ...opts.extraInference?.assignments },
      },
      extraGatewayConfig: {
        ...(opts.extraGatewayConfig ?? {}),
        brain: {
          conversationDebounce: "2s",
          documentUpdateDebounce: "2s",
          // The readiness barrier (how long a data run may wait for a
          // document's derivation stages) is capped like the debounces: the
          // link backfill re-arms on its idle cadence, and a run parked behind
          // it for the production ceiling is invisible to `drainUntilQuiet`'s
          // horizon — a bench would then assert on work the gateway has not
          // done yet. Suites that pin the barrier's own behaviour override it.
          derivationBarrier: "2s",
          ...QUIET_PROACTIVE_LANE,
          ...(opts.judge ? { judge: { enabled: true } } : {}),
          ...(opts.brain ?? {}),
        },
      },
    });
    await harness.start();

    if (opts.syncSources !== false) {
      for (const id of harness.getSourceIds()) {
        await harness.triggerSyncAndWait(id, 60_000);
      }
      await harness.refreshSearchSnapshot();
    }

    return new BrainBench({ harness, puppet, entailment, judge, virtualClock });
  }

  // ── stimulus ──────────────────────────────────────────────────────────────

  /** Ingest a document, driving a create (or, on a repeated externalId, an update). */
  async push(doc: BenchDoc): Promise<void> {
    const at = new Date(doc.at ?? Date.now() - (doc.ageDays ?? 0) * 86_400_000).toISOString();
    const input: PushDocumentInput = {
      externalId: doc.externalId,
      title: doc.title,
      content: doc.content,
      sourceCreatedAt: at,
      sourceUpdatedAt: at,
      ...(doc.documentType ? { documentType: doc.documentType } : {}),
      ...(doc.metadata ? { metadata: doc.metadata } : {}),
      ...(doc.sourceId ? { sourceId: doc.sourceId } : {}),
      ...(doc.providerId ? { providerId: doc.providerId } : {}),
    };
    await this.harness.pushDocument(input);
  }

  async pushAll(docs: readonly BenchDoc[]): Promise<void> {
    for (const doc of docs) await this.push(doc);
  }

  /**
   * Re-push an existing document with changed content — the update
   * transition the waker turns into a diff-carrying data run.
   */
  async update(doc: BenchDoc, content: string): Promise<void> {
    await this.push({ ...doc, content });
  }

  /** Delete a document through the production route (cascades run for real). */
  async deleteDoc(docId: string): Promise<void> {
    const res = await this.harness.gatewayFetch(`/documents/${docId}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`delete /documents/${docId} failed: ${res.status}`);
  }

  // ── time ──────────────────────────────────────────────────────────────────

  /** The last instant `clock.set` was asked for, so a restart can restore it. */
  private lastClockSet: number | null = null;

  readonly clock = {
    /**
     * The gateway's current cognition instant, in unix ms.
     *
     * The route reports `now` as an ISO string, so it is parsed here rather
     * than in every caller — arithmetic on the raw field silently produces a
     * string concatenation the POST then rejects.
     */
    now: async (): Promise<{ virtual: boolean; now: number }> => {
      const raw = await this.harness.gatewayJson<{ virtual: boolean; now: number | string }>(
        "/admin/brain/clock",
      );
      const ms = typeof raw.now === "number" ? raw.now : Date.parse(raw.now);
      if (!Number.isFinite(ms)) {
        throw new Error(`/admin/brain/clock returned an unreadable instant: ${String(raw.now)}`);
      }
      return { virtual: raw.virtual, now: ms };
    },
    /** Set the virtual clock to an absolute instant. */
    set: async (at: number | Date): Promise<void> => {
      this.requireVirtualClock();
      const ms = at instanceof Date ? at.getTime() : at;
      await this.harness.gatewayJson("/admin/brain/clock", {
        method: "POST",
        body: JSON.stringify({ now: ms }),
      });
      this.lastClockSet = ms;
    },
    /** Advance the virtual clock by a delta, returning the new instant. */
    advance: async (ms: number): Promise<number> => {
      this.requireVirtualClock();
      const current = await this.clock.now();
      const next = current.now + ms;
      await this.clock.set(next);
      return next;
    },
    /** Advance whole days, landing past the configured daily boundary hour. */
    advanceDays: async (days: number): Promise<number> => this.clock.advance(days * 86_400_000),
    /** Local midnight of the day containing `ms`, matching the daily boundary's own arithmetic. */
    localMidnight: (ms: number): number => {
      const d = new Date(ms);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    },
    /** `YYYY-MM-DD` in gateway-local time — the day key the rhythm markers use. */
    localDay: (ms: number): string => {
      const d = new Date(ms);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    },
  };

  /**
   * Restart the gateway, restoring the virtual clock afterwards — a restart
   * otherwise silently drops back to wall time, which reads as the engine
   * skipping days.
   */
  async restartGateway(): Promise<void> {
    await this.harness.restartGateway();
    this.db?.close();
    this.db = null;
    if (this.virtualClock && this.lastClockSet !== null) {
      await this.clock.set(this.lastClockSet);
    }
  }

  private requireVirtualClock(): void {
    if (!this.virtualClock) {
      throw new Error('BrainBench: clock control requires `clock: "virtual"`');
    }
  }

  // ── draining ──────────────────────────────────────────────────────────────

  /**
   * Wait until the cognition queue is empty and nothing is executing.
   *
   * Progress-based, not a fixed sleep: the deadline extends whenever a run
   * settles, and the failure names the queue's actual contents — so a
   * genuinely stalled engine fails loudly instead of passing as "quiet".
   */
  async drainUntilQuiet(
    opts: { timeoutMs?: number; stallMs?: number; includeUpcoming?: boolean } = {},
  ): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 90_000;
    const stallMs = opts.stallMs ?? 20_000;
    // `queuedRuns` counts only runs already DUE, so a run inside its debounce
    // window is invisible to it. Wait for those too by default — otherwise a
    // bench with a non-trivial debounce races straight past its own run and
    // asserts on a gateway that has not acted yet. A test that deliberately
    // parks work in the future (a scheduled follow-up, a decay check) opts out.
    const includeUpcoming = opts.includeUpcoming ?? true;
    const hardDeadline = Date.now() + timeoutMs;
    let lastSettled = -1;
    let lastProgressAt = Date.now();

    for (;;) {
      const pulse = await this.obs.pulse();
      const settled = pulse.counts.totalRuns - pulse.counts.queuedRuns;
      if (settled !== lastSettled) {
        lastSettled = settled;
        lastProgressAt = Date.now();
      }
      const debounced = includeUpcoming ? await this.debouncedRunCount() : 0;
      const idle =
        pulse.counts.queuedRuns === 0 && pulse.runningRuns.length === 0 && debounced === 0;
      if (idle) {
        // One more settle interval, so a run enqueued by the run that just
        // finished (feedback, notes compaction, scheduled follow-ups) is
        // observed rather than raced past.
        await sleep(600);
        const confirm = await this.obs.pulse();
        const stillDebounced = includeUpcoming ? await this.debouncedRunCount() : 0;
        if (
          confirm.counts.queuedRuns === 0 &&
          confirm.runningRuns.length === 0 &&
          stillDebounced === 0
        ) {
          return;
        }
        continue;
      }
      const now = Date.now();
      if (now > hardDeadline || now - lastProgressAt > stallMs) {
        const runs = await this.obs.runs({ limit: 20 });
        const detail = runs.items
          .map((r) => `${r.kind}/${r.status} attempts=${r.attempts} ${r.lastError ?? ""}`)
          .join("; ");
        throw new Error(
          `brain queue did not drain (queued=${pulse.counts.queuedRuns}, running=${pulse.runningRuns.length}, debounced=${debounced}, failed24h=${pulse.counts.failedRuns24h}): ${detail}`,
        );
      }
      await sleep(250);
    }
  }

  /**
   * Pending runs whose turn is imminent — inside a debounce or a retry
   * backoff, rather than deliberately parked days out.
   *
   * The horizon is what separates the two: a debounce is seconds, a scheduled
   * follow-up or decay check is hours. Comparing against the COGNITION clock
   * matters under a virtual clock, where wall time and the queue's own notion
   * of "now" diverge by design.
   */
  private async debouncedRunCount(horizonMs = 15_000): Promise<number> {
    const { now } = await this.clock.now();
    const row = this.sql
      .prepare<
        [number],
        { n: number }
      >("SELECT COUNT(*) AS n FROM cognition_runs WHERE status = 'pending' AND next_attempt_at <= ?")
      .get(now + horizonMs);
    return row?.n ?? 0;
  }

  /**
   * Push documents and drain — the common stimulus/settle pairing. Returns
   * the gateway document ids in push order.
   */
  async pushAndSettle(docs: readonly BenchDoc[]): Promise<string[]> {
    await this.pushAll(docs);
    await this.drainUntilQuiet();
    const ids: string[] = [];
    for (const doc of docs) {
      ids.push(await this.docId(doc.externalId));
    }
    return ids;
  }

  // ── probes ────────────────────────────────────────────────────────────────

  /** Read-only SQLite handle over the spawned gateway's database. */
  get sql(): Database.Database {
    this.db ??= openHarnessDb(this.harness);
    return this.db;
  }

  /**
   * Run `fn` against a WRITABLE handle on the gateway's database.
   *
   * The gateway owns the WAL, so this is for bounded, deliberate injections
   * only — seeding a crashed run, arranging a merge candidate, clearing a
   * rhythm marker. Several states the bench must cover (a run whose candidate
   * settled, an attempts-exhausted row) are unreachable through the enqueuers
   * by construction, and this is the only way to arrange them.
   */
  withWriteHandle<T>(fn: (db: Database.Database) => T): T {
    const db = new Database(this.harness.getDbPath(), { fileMustExist: true });
    db.pragma("busy_timeout = 10000");
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  /**
   * Seed a queue row directly. Returns the run id.
   *
   * Prefer driving a real enqueuer; reach for this when the state under test
   * is one no enqueuer produces — a crashed run, an attempts-exhausted row, a
   * candidate that settled before its run executed.
   */
  seedRun(run: SeededRun): string {
    return this.seedRuns([run])[0]!;
  }

  /**
   * Seed several queue rows in ONE transaction, so they all become claimable
   * at the same instant.
   *
   * Row-at-a-time seeding is not equivalent: the drainer ticks every few
   * hundred milliseconds, so it can claim a partial backlog between inserts —
   * which quietly invalidates any assertion about claim ORDER or concurrency,
   * the very things a seeded backlog exists to test.
   */
  seedRuns(runs: readonly SeededRun[]): string[] {
    const fallback = Date.now();
    this.withWriteHandle((db) => {
      const insert = db.prepare(
        `INSERT INTO cognition_runs (
           id, kind, payload_json, dedupe_key, status, attempts,
           next_attempt_at, enqueued_at, cycle_anchor_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      db.transaction(() => {
        for (const run of runs) {
          const at = run.enqueuedAt ?? fallback;
          insert.run(
            run.id,
            run.kind,
            JSON.stringify(run.payload ?? {}),
            run.dedupeKey ?? null,
            run.status ?? "pending",
            run.attempts ?? 0,
            run.nextAttemptAt ?? at,
            at,
            // The enqueuers stamp this, and a fold clamps the new due time to
            // `cycle_anchor_at + maxDefer`. Left at its DEFAULT 0, a seeded row
            // that later gets folded becomes instantly due instead of
            // respecting its debounce.
            run.cycleAnchorAt ?? at,
          );
        }
      })();
    });
    return runs.map((r) => r.id);
  }

  /** The raw queue row, with unix-ms fields the rendered DTO turns into ISO. */
  runRow(id: string): Record<string, unknown> | undefined {
    return this.sql.prepare("SELECT * FROM cognition_runs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
  }

  /**
   * The payload a run was enqueued with. `obs.runs()` exposes only a rendered
   * `trigger`, so anything that asserts on the enqueuer's own arithmetic — a
   * daily window, a bootstrap doc id, a sweep's steering snapshot — reads it
   * from here.
   */
  runPayload(id: string): unknown {
    const row = this.sql
      .prepare<
        [string],
        { payload_json: string | null }
      >("SELECT payload_json FROM cognition_runs WHERE id = ?")
      .get(id);
    return row?.payload_json ? JSON.parse(row.payload_json) : null;
  }

  /** Fold keys of every still-pending run — the enqueue-side probe. */
  pendingDedupeKeys(): string[] {
    return this.sql
      .prepare<[], { dedupe_key: string }>(
        "SELECT dedupe_key FROM cognition_runs WHERE status = 'pending' AND dedupe_key IS NOT NULL",
      )
      .all()
      .map((r) => r.dedupe_key);
  }

  /**
   * The rhythm engine's due-gate markers. Every periodic lane records its
   * progress here, and the marker is written LAST — so a marker moving is
   * proof the pass's enqueues already landed, which is the only non-racy way
   * to observe an enqueuer from outside.
   */
  readonly markers = {
    get: (key: string): string | undefined =>
      (
        this.sql.prepare("SELECT value FROM cognition_engine_state WHERE key = ?").get(key) as
          | { value: string }
          | undefined
      )?.value,
    /** Clear a marker so a due-gated pass re-arms without waiting out its cadence. */
    clear: (key: string): void => {
      this.withWriteHandle((db) => {
        db.prepare("DELETE FROM cognition_engine_state WHERE key = ?").run(key);
      });
    },
    /** Wait until a marker satisfies `predicate` — i.e. until its pass has run. */
    waitFor: async (
      key: string,
      predicate: (value: string | undefined) => boolean,
      timeoutMs = 60_000,
    ): Promise<string | undefined> =>
      waitFor(
        () => `engine-state marker ${key} (currently ${String(this.markers.get(key))})`,
        () => (predicate(this.markers.get(key)) ? { value: this.markers.get(key) } : null),
        timeoutMs,
      ).then((r) => r.value),
  };

  /** Patch the gateway's live config — several knobs are read per tick. */
  async patchConfig(patch: Record<string, unknown>): Promise<void> {
    await this.harness.gatewayJson("/admin/config", {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  /** Resolve a pushed document's gateway id, waiting for ingestion to land. */
  async docId(externalId: string): Promise<string> {
    return waitFor(
      `document ${externalId} to be ingested`,
      () =>
        this.sql
          .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
          .get(externalId)?.id ?? null,
      30_000,
    );
  }

  /** Every completion request the puppet served, in order. */
  /**
   * Open or close a provider outage on the puppet backend — see
   * `PuppetModelServer.refuseWith`. The lever a test pulls to assert what the
   * brain does when the model is unreachable rather than merely unhelpful.
   */
  refuseModelWith(status: number | null, message?: string): void {
    if (!this.puppetServer) throw new Error("BrainBench: no puppet model is running");
    this.puppetServer.refuseWith(status, message);
  }

  get puppetCalls() {
    if (!this.puppetServer) throw new Error("BrainBench: no puppet model is running");
    return this.puppetServer.calls;
  }

  /** Every entailment verdict served, in order. */
  get entailmentCalls() {
    if (!this.entailmentServer) throw new Error("BrainBench: no entailment verifier is running");
    return this.entailmentServer.calls;
  }

  /** Every brief-judge verdict served, in order. */
  get judgeCalls() {
    if (!this.judgeServer) throw new Error("BrainBench: no brief judge is running");
    return this.judgeServer.calls;
  }

  /** Open or close a provider outage on the configured Brief judge. */
  refuseJudgeWith(status: number | null, message?: string): void {
    if (!this.judgeServer) throw new Error("BrainBench: no brief judge is running");
    this.judgeServer.refuseWith(status, message);
  }

  async destroy(): Promise<void> {
    this.db?.close();
    this.db = null;
    await this.harness?.destroy();
    await this.puppetServer?.close();
    await this.entailmentServer?.close();
    await this.judgeServer?.close();
  }
}

export { sleep, waitFor };
