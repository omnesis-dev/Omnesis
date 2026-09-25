// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The two places a watch asks something it cannot compute.
 *
 * **Recall** scores a document against a query — per-chunk max cosine against
 * stored embeddings. **Judgement** decides a proposition from evidence. Both
 * are ports rather than implementations, for one reason: a golden trace has to
 * be reproducible, and a model is not. The scripted providers here answer from
 * a fixture, so a run in CI produces the same trace as a run on a laptop.
 *
 * That is not a compromise on realism in the place it would matter. The
 * procedural half of a watch — its filters, keys, deadlines, collisions, SQL —
 * is what these traces exist to pin, and it is fully exercised. What a model
 * would decide is exactly the part a golden should *not* assert, because
 * asserting it would freeze a model's opinion into a regression test.
 *
 * A backtest goes further and stubs judgement entirely, counting reaches
 * instead. That count is the number the compiler needs: "this watch would have
 * asked a model four hundred times in ninety days" is the feedback that pushes
 * it toward cheap procedural pre-filtering.
 */

import type { FailureClass } from "./trace.js";

/** What a judge is being asked, and what it has to go on. */
export interface JudgeRequest {
  readonly watch: string;
  readonly nodeId: string;
  /** The instance key, rendered readably. */
  readonly key: string;
  readonly proposition: string;
  /** Documents the judge is expected to have read. */
  readonly documentIds: readonly string[];
  /** Content revision the host must still observe before adding body context. */
  readonly documentRevision?: string;
  /** Typed evidence from upstream nodes. */
  readonly evidence: Readonly<Record<string, unknown>>;
  /**
   * The fields the node declared its judge would return, as `name → type`.
   *
   * A watch addresses a verdict through `$judge.<field>`, and the validator
   * holds it to the fields declared here. A judge that answered some other
   * shape would leave every one of those references resolving to null — which
   * is silent, because an unresolved reference is a null rather than an error,
   * so the watch fires forever with empty output. Passing the declaration to
   * the judge is what lets a live one answer the shape it was promised.
   */
  readonly outputSchema?: Readonly<Record<string, string>>;
}

/**
 * Why a judge returned without deciding anything.
 *
 * A judge that declines and a judge that could not run both come back with
 * `fired: false`, and confusing the two is how an outage gets read as
 * precision. The class says who to ask about it: `budget` is the ceiling doing
 * its job and will clear on its own, `provider` is a model that is missing,
 * unreachable, or answering in a shape nothing can read.
 *
 * `reason` is a fixed phrase chosen by the judge rather than whatever a backend
 * wrote, because it is shown to a person and a provider's error text can quote
 * the prompt back — which contains the corpus.
 */
export interface JudgeUnanswered {
  readonly failure: Extract<FailureClass, "budget" | "provider">;
  readonly reason: string;
  /**
   * Earliest wall-clock instant at which retrying may produce a different
   * answer. Hosts should persist this with the nomination: retrying an
   * unavailable provider on every engine pass wastes work and floods logs.
   */
  readonly retryAtMs?: number;
}

export interface JudgeVerdict {
  readonly fired: boolean;
  /** The judge's typed output, matching the node's declared schema. */
  readonly output: Readonly<Record<string, unknown>>;
  /**
   * Set when there was no judgement — the question was never put to a model,
   * or the answer could not be read.
   *
   * A first-class field rather than a marker inside `output`, because `output`
   * is whatever the model wrote: a node's declared fields pass through it
   * verbatim, so a model that emitted the marker itself could park its own
   * document and have the runtime withhold the record that says it was
   * considered. Control over whether a document counts as judged belongs to
   * the judge, not to the thing being judged.
   */
  readonly unanswered?: JudgeUnanswered;
}

export interface JudgeProvider {
  /**
   * May answer synchronously or not.
   *
   * A fixture judge has its verdict written down and returns it; a live one is
   * a model call over a network. The union keeps every scripted implementation
   * exactly as it was while letting a host supply one that has to wait.
   */
  judge(request: JudgeRequest): JudgeVerdict | Promise<JudgeVerdict>;
}

export interface RecallRequest {
  readonly nodeId: string;
  readonly documentId: string;
  readonly query: string;
}

export interface RecallScorer {
  /**
   * Per-chunk max cosine, in [0, 1].
   *
   * Asynchronous for the same reason a judge is: a live scorer embeds the query
   * and reads the document's stored chunk vectors, and neither is in memory.
   */
  score(request: RecallRequest): number | Promise<number>;
}

// ---------------------------------------------------------------------------
// Scripted implementations
// ---------------------------------------------------------------------------

/**
 * A verdict written down in advance, keyed by what it answers.
 *
 * Keys are matched most-specific-first: an entry naming a document beats one
 * naming only the node, which beats the node's default. That ordering is what
 * lets a fixture say "this node normally declines, except for these two
 * documents" without enumerating every document in the universe.
 */
export interface ScriptedJudgement {
  readonly nodeId: string;
  /** Match only when this document is among the evidence. */
  readonly documentId?: string;
  /** Match only for this rendered key. */
  readonly key?: string;
  readonly fired: boolean;
  readonly output?: Readonly<Record<string, unknown>>;
}

export interface ScriptedJudgeOptions {
  readonly judgements: readonly ScriptedJudgement[];
  /**
   * What an unmatched request gets. Declining by default is deliberate: a
   * fixture that forgot to script a node should produce a watch that does not
   * fire, which is visible, rather than one that fires for no stated reason.
   */
  readonly fallback?: JudgeVerdict;
}

export class ScriptedJudge implements JudgeProvider {
  private readonly judgements: readonly ScriptedJudgement[];
  private readonly fallback: JudgeVerdict;
  private readonly used = new Set<number>();

  constructor(options: ScriptedJudgeOptions) {
    this.judgements = options.judgements;
    this.fallback = options.fallback ?? { fired: false, output: {} };
  }

  judge(request: JudgeRequest): JudgeVerdict {
    let best: { index: number; entry: ScriptedJudgement; specificity: number } | null = null;

    this.judgements.forEach((entry, index) => {
      if (entry.nodeId !== request.nodeId) return;
      if (entry.key !== undefined && entry.key !== request.key) return;
      if (entry.documentId !== undefined && !request.documentIds.includes(entry.documentId)) return;

      const specificity = (entry.documentId ? 2 : 0) + (entry.key ? 1 : 0);
      if (!best || specificity > best.specificity) best = { index, entry, specificity };
    });

    if (!best) return this.fallback;
    const match = best as { index: number; entry: ScriptedJudgement };
    this.used.add(match.index);
    return { fired: match.entry.fired, output: match.entry.output ?? {} };
  }

  /**
   * Judgements the run never matched. A fixture entry nobody reached is either
   * a scenario that stopped happening or a typo, and both are worth failing on
   * rather than leaving as decoration.
   */
  unusedJudgements(): ScriptedJudgement[] {
    return this.judgements.filter((_, index) => !this.used.has(index));
  }
}

/** A recall score written down per (node, document). */
export interface ScriptedScore {
  readonly nodeId: string;
  readonly documentId: string;
  readonly score: number;
}

export class ScriptedRecall implements RecallScorer {
  private readonly scores: ReadonlyMap<string, number>;
  private readonly fallback: number;

  /**
   * `fallback` is the score for a document nobody scripted. Zero by default,
   * so a document is only ever recalled because a fixture said so.
   */
  constructor(scores: readonly ScriptedScore[], fallback = 0) {
    this.scores = new Map(scores.map((s) => [`${s.nodeId}\u0000${s.documentId}`, s.score]));
    this.fallback = fallback;
  }

  score(request: RecallRequest): number {
    return this.scores.get(`${request.nodeId}\u0000${request.documentId}`) ?? this.fallback;
  }
}

/**
 * A judge that never fires and counts what it was asked.
 *
 * This is what a backtest runs. The recall pass still happens — embeddings are
 * cheap and local — and everything downstream of a judge simply never fires, so
 * the report is "the procedural part reached the model N times", which is the
 * cost the compiler is trying to minimise.
 */
export class CountingJudge implements JudgeProvider {
  private readonly counts = new Map<string, number>();

  judge(request: JudgeRequest): JudgeVerdict {
    this.counts.set(request.nodeId, (this.counts.get(request.nodeId) ?? 0) + 1);
    return { fired: false, output: {} };
  }

  /** How many times each LLM node would have been invoked. */
  reachCounts(): Record<string, number> {
    return Object.fromEntries([...this.counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  }

  get total(): number {
    let sum = 0;
    for (const count of this.counts.values()) sum += count;
    return sum;
  }
}
