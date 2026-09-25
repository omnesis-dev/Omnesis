// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The mirror-gateway bridge — the real-data backtest's replay driver.
 *
 * The bridge turns a corpus SNAPSHOT (a copied gateway `omnesis.db` —
 * never the live database) into a time-faithful replay against an
 * ISOLATED mirror gateway running the briefs virtual clock:
 *
 *   1. every document dated ≤ T0 is bulk-backfilled — establishing the
 *      mirror's corpus/index/graph state as of T0;
 *   2. the > T0 window is drip-fed in source-timestamp order, moving the
 *      mirror's virtual decision clock to each datum's instant first.
 *
 * Because the mirror's index is built incrementally, search at virtual
 * time T can only return documents ≤ T — point-in-time retrieval
 * fidelity comes for free, with zero query-layer changes (the design's
 * key insight). The virtual clock keeps the recency gate, decay, and
 * ranking in replay time; the drip gates on the run queue SETTLING, not
 * a fixed rate, so the index absorbs each datum before the next.
 *
 * Safety rails, enforced here (not just in the runbook):
 *   - the target gateway must answer `/admin/brain/clock` with
 *     `virtual: true` — a gateway booted without
 *     `OMNESIS_BRIEFS_VIRTUAL_CLOCK=1` (any live instance) is refused;
 *   - the default live port (7600) is refused outright;
 *   - the snapshot is opened READ-ONLY.
 */

import Database from "better-sqlite3";

// ── snapshot reading ────────────────────────────────────────────────────────

export interface SnapshotDocument {
  externalId: string;
  /** Original provider + source identity, replayed verbatim into the
   * mirror so per-source semantics (daily batches, attribution) hold. */
  providerId: string;
  sourceId: string;
  title: string;
  content: string;
  contentHash: string;
  metadata: Record<string, unknown>;
  sourceCreatedAt: string;
  sourceUpdatedAt: string;
  /** `sourceCreatedAt` in unix ms — the replay ordering key. */
  tsMs: number;
}

export interface ReadSnapshotOptions {
  /** Keep only these source ids (exact `<type>:<account>` keys). */
  sources?: readonly string[];
  /** Drop documents dated after this instant (the window end). */
  untilMs: number;
  /** Hard cap on documents read (refuses larger replays). */
  maxDocs?: number;
}

/** Read the replayable documents from a snapshot DB, oldest first. */
export function readSnapshotDocuments(
  snapshotPath: string,
  opts: ReadSnapshotOptions,
): SnapshotDocument[] {
  const db = new Database(snapshotPath, { readonly: true, fileMustExist: true });
  try {
    const filters: string[] = [];
    const params: (string | number)[] = [];
    if (opts.sources && opts.sources.length > 0) {
      filters.push(`source_id IN (${opts.sources.map(() => "?").join(", ")})`);
      params.push(...opts.sources);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = db
      .prepare<
        (string | number)[],
        {
          external_id: string;
          provider_id: string;
          source_id: string;
          title: string;
          content: string;
          content_hash: string;
          metadata: string;
          source_created_at: string;
          source_updated_at: string;
        }
      >(
        `SELECT external_id, provider_id, source_id, title, content, content_hash,
                metadata, source_created_at, source_updated_at
           FROM documents ${where}
          ORDER BY source_created_at ASC, external_id ASC`,
      )
      .all(...params);

    const docs: SnapshotDocument[] = [];
    for (const r of rows) {
      const tsMs = Date.parse(r.source_created_at);
      if (!Number.isFinite(tsMs) || tsMs > opts.untilMs) continue;
      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(r.metadata) as Record<string, unknown>;
      } catch {
        /* unparseable metadata rides as {} */
      }
      docs.push({
        externalId: r.external_id,
        providerId: r.provider_id,
        sourceId: r.source_id,
        title: r.title,
        content: r.content,
        contentHash: r.content_hash,
        metadata,
        sourceCreatedAt: r.source_created_at,
        sourceUpdatedAt: r.source_updated_at,
        tsMs,
      });
    }
    if (opts.maxDocs !== undefined && docs.length > opts.maxDocs) {
      throw new Error(
        `snapshot yields ${docs.length} documents, over the --max-docs cap of ${opts.maxDocs} — ` +
          `narrow the window or sources (each post-T0 datum is a priced agent run)`,
      );
    }
    return docs;
  } finally {
    db.close();
  }
}

// ── the replay plan ─────────────────────────────────────────────────────────

export interface ReplayPlan {
  /** Documents ≤ T0, bulk-backfilled as the as-of-T0 corpus. */
  backfill: SnapshotDocument[];
  /** Documents in (T0, until], drip-fed in timestamp order. */
  window: SnapshotDocument[];
}

export function planReplay(docs: readonly SnapshotDocument[], t0Ms: number): ReplayPlan {
  const backfill: SnapshotDocument[] = [];
  const window: SnapshotDocument[] = [];
  for (const d of docs) (d.tsMs <= t0Ms ? backfill : window).push(d);
  return { backfill, window };
}

// ── the mirror gateway client ───────────────────────────────────────────────

interface RunItem {
  status: string;
  nextAttemptAt: string | null;
}

export class MirrorGatewayClient {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    if (init?.body) headers.set("Content-Type", "application/json");
    const res = await fetch(`${this.url}${path}`, { ...init, headers });
    if (!res.ok) {
      throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  /** The bridge's hard precondition: the mirror runs the virtual clock. */
  async assertVirtualClock(): Promise<void> {
    const clock = await this.json<{ virtual: boolean }>("/admin/brain/clock");
    if (!clock.virtual) {
      throw new Error(
        "target gateway is NOT running the briefs virtual clock — refusing to replay. " +
          "The mirror must be started with OMNESIS_BRIEFS_VIRTUAL_CLOCK=1; a live gateway never is.",
      );
    }
  }

  async setClock(nowMs: number): Promise<void> {
    await this.json("/admin/brain/clock", {
      method: "POST",
      body: JSON.stringify({ now: nowMs }),
    });
  }

  async pushDocuments(docs: readonly SnapshotDocument[]): Promise<void> {
    await this.json("/documents", {
      method: "POST",
      body: JSON.stringify({
        documents: docs.map((d) => ({
          externalId: d.externalId,
          providerId: d.providerId,
          sourceId: d.sourceId,
          title: d.title,
          content: d.content,
          contentHash: d.contentHash,
          metadata: d.metadata,
          sourceCreatedAt: d.sourceCreatedAt,
          sourceUpdatedAt: d.sourceUpdatedAt,
        })),
      }),
    });
  }

  async refreshSearchSnapshot(): Promise<void> {
    const res = await fetch(`${this.url}/admin/search-snapshot/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`search-snapshot refresh -> ${res.status}`);
  }

  /**
   * True when the run queue has settled at the given virtual instant:
   * nothing in flight, and no pending run already due. Pending runs
   * dated in the virtual FUTURE (scheduled re-verifies, decay checks)
   * do not block — they fire when the replay cursor reaches them.
   */
  async runQueueQuiet(virtualNowMs: number): Promise<boolean> {
    const runs = await this.json<{ items: RunItem[] }>("/admin/brain/runs?limit=500");
    return !runs.items.some((r) => {
      if (r.status === "completed" || r.status === "failed") return false;
      if (r.status === "pending") {
        return r.nextAttemptAt === null || Date.parse(r.nextAttemptAt) <= virtualNowMs;
      }
      return true; // claimed / anything in flight blocks
    });
  }
}

// ── the replay loop ─────────────────────────────────────────────────────────

export interface BridgeOptions {
  snapshotPath: string;
  gatewayUrl: string;
  token: string;
  t0Ms: number;
  untilMs: number;
  sources?: readonly string[];
  maxDocs?: number;
  /** Backfill push batch size. */
  batchSize?: number;
  /** Max wall-clock ms to wait for the queue to settle per step. */
  settleTimeoutMs?: number;
  /** Poll interval while waiting for settling. */
  settlePollMs?: number;
  /** Print the plan and exit without touching the gateway. */
  dryRun?: boolean;
  log?: (line: string) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForQuiet(
  client: MirrorGatewayClient,
  virtualNowMs: number,
  timeoutMs: number,
  pollMs: number,
  what: string,
): Promise<void> {
  // A wake sits in the waker's in-memory debounce buffer before it becomes
  // a queue row, so an instant "queue empty" can race the flush — quiet
  // only counts after TWO consecutive observations, the first one delayed
  // past a waker tick.
  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;
  for (;;) {
    await sleep(pollMs);
    if (await client.runQueueQuiet(virtualNowMs)) {
      consecutive += 1;
      if (consecutive >= 2) return;
    } else {
      consecutive = 0;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for the run queue: ${what}`);
  }
}

export interface BridgeReport {
  backfilled: number;
  dripped: number;
  finalVirtualNowMs: number;
}

/** Run the full replay: preflight → backfill at T0 → clock-gated drip. */
export async function runBridge(opts: BridgeOptions): Promise<BridgeReport> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const port = new URL(opts.gatewayUrl).port;
  if (port === "7600" || port === "") {
    throw new Error(
      `refusing gateway url "${opts.gatewayUrl}" — the default live port is never a mirror; ` +
        `spawn an isolated gateway on a high port (17xxx) per the runbook`,
    );
  }

  const docs = readSnapshotDocuments(opts.snapshotPath, {
    ...(opts.sources ? { sources: opts.sources } : {}),
    untilMs: opts.untilMs,
    ...(opts.maxDocs !== undefined ? { maxDocs: opts.maxDocs } : {}),
  });
  const plan = planReplay(docs, opts.t0Ms);
  log(
    `replay plan: ${plan.backfill.length} backfill (≤ ${new Date(opts.t0Ms).toISOString()}), ` +
      `${plan.window.length} window datums (→ ${new Date(opts.untilMs).toISOString()})`,
  );
  if (opts.dryRun) return { backfilled: 0, dripped: 0, finalVirtualNowMs: opts.t0Ms };

  const client = new MirrorGatewayClient(opts.gatewayUrl, opts.token);
  await client.assertVirtualClock();

  const settleTimeoutMs = opts.settleTimeoutMs ?? 600_000;
  const settlePollMs = opts.settlePollMs ?? 1_000;
  const batchSize = opts.batchSize ?? 200;

  // Backfill at T0: the corpus state the replay starts from. Documents
  // inside the recency window of T0 legitimately wake (they are recent
  // as of T0); older ones are skipped by the gate — both are faithful.
  await client.setClock(opts.t0Ms);
  for (let i = 0; i < plan.backfill.length; i += batchSize) {
    const batch = plan.backfill.slice(i, i + batchSize);
    await client.pushDocuments(batch);
    log(`backfill: ${Math.min(i + batchSize, plan.backfill.length)}/${plan.backfill.length}`);
  }
  await client.refreshSearchSnapshot();
  await waitForQuiet(client, opts.t0Ms, settleTimeoutMs, settlePollMs, "post-backfill settle");

  // The drip: one datum at a time, in source-timestamp order, the clock
  // always at the datum's instant before it lands.
  let dripped = 0;
  let virtualNow = opts.t0Ms;
  for (const doc of plan.window) {
    virtualNow = Math.max(virtualNow, doc.tsMs);
    await client.setClock(virtualNow);
    await client.pushDocuments([doc]);
    dripped += 1;
    await client.refreshSearchSnapshot();
    await waitForQuiet(
      client,
      virtualNow,
      settleTimeoutMs,
      settlePollMs,
      `datum ${dripped}/${plan.window.length} (${doc.externalId})`,
    );
    if (dripped % 10 === 0 || dripped === plan.window.length) {
      log(
        `drip: ${dripped}/${plan.window.length} — virtual now ${new Date(virtualNow).toISOString()}`,
      );
    }
  }

  // Land the cursor on the window end so due-soon checks can fire.
  virtualNow = Math.max(virtualNow, opts.untilMs);
  await client.setClock(virtualNow);
  await waitForQuiet(client, virtualNow, settleTimeoutMs, settlePollMs, "final settle");
  log(`replay complete: ${plan.backfill.length} backfilled, ${dripped} dripped`);
  return { backfilled: plan.backfill.length, dripped, finalVirtualNowMs: virtualNow };
}
