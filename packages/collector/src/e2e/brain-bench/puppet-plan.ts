// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The puppet steward's mind — pure, so it can be unit-tested without a
 * gateway.
 *
 * A bench test declares WHAT the steward should do for a given run as an
 * ordered list of tool calls (a {@link PuppetPlan}); this module works out
 * WHICH of those calls to emit next, by reconstructing the calls already
 * executed from the conversation the gateway sends back. The gateway then
 * executes each emitted call for real, so a plan is a script for the tool
 * layer, not a canned transcript.
 *
 * Two things make the plans readable. Calls may reference the results of
 * earlier calls through {@link ref} placeholders —
 * `ref("open_loop_create", "loop.id")` reads the id the real call just minted — because ids are minted
 * by the gateway and cannot be known when the plan is written. And a plan
 * is chosen per run by matching the run's kind and its subject, so one
 * behavior table drives a whole day of mixed runs.
 */

import { parseCognitionRunEnvelope } from "@omnesis/core";

// ── the conversation, as the gateway reports it back ────────────────────────

export interface WireToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

/** One executed tool round-trip reconstructed from the history. */
export interface ToolStep {
  name: string;
  args: Record<string, unknown> | null;
  /** Parsed tool-result JSON; null when the result message is missing. */
  result: unknown | null;
}

function safeParse(text: string | null | undefined): unknown | null {
  if (typeof text !== "string" || text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function collectToolSteps(messages: readonly WireMessage[]): ToolStep[] {
  const resultsByCallId = new Map<string, unknown | null>();
  for (const m of messages) {
    if (m.role === "tool" && typeof m.tool_call_id === "string") {
      resultsByCallId.set(m.tool_call_id, safeParse(m.content));
    }
  }
  const steps: ToolStep[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      steps.push({
        name: tc.function.name,
        args: (safeParse(tc.function.arguments) as Record<string, unknown> | null) ?? null,
        result: resultsByCallId.get(tc.id) ?? null,
      });
    }
  }
  return steps;
}

// ── run identification ──────────────────────────────────────────────────────

/** What the puppet knows about the run it is being asked to perform. */
export interface RunContext {
  runId: string;
  kind: string;
  attempt: number;
  /** The body markers that name this run's flavour and subject. */
  flavour: RunFlavour;
  /** The run's subject, when its prompt names one (doc id, source id, sweep id, …). */
  subject: string | null;
  /** Secondary subject: the brief title on feedback runs, the doc event on data runs. */
  detail: string | null;
  prompt: string;
}

export type RunFlavour =
  | "data.created"
  | "data.updated"
  | "data.deleted"
  | "daily.digest"
  | "daily.source"
  | "daily.mayday"
  | "time_based.scheduled"
  | "time_based.decay"
  | "time_based.decay.gone"
  | "feedback.dismissal"
  | "feedback.provenance"
  | "synthesis.noticing"
  | "synthesis.collision.loops"
  | "synthesis.collision.temporal"
  | "synthesis.contradiction"
  | "sweep"
  | "bootstrap"
  | "bootstrap.deleted"
  | "verification"
  | "verification.empty"
  | "merge_adjudication"
  | "merge_adjudication.settled"
  | "notes_compaction"
  | "malformed"
  | "unknown";

/**
 * Identify a run from its prompt. The envelope's `kind` is authoritative;
 * the body markers name the flavour within a kind and the subject the
 * behavior table keys on.
 */
export function readRunContext(prompt: string): RunContext | null {
  const env = parseCognitionRunEnvelope(prompt);
  if (!env) return null;
  const base = { runId: env.runId, kind: env.kind, attempt: env.attempt, prompt };

  const m = (re: RegExp): RegExpExecArray | null => re.exec(prompt);

  // data
  const created = m(/^A new document arrived: (\S+)\. Fetch/m);
  if (created) return { ...base, flavour: "data.created", subject: created[1]!, detail: "created" };
  const updated = m(/^Document (\S+) was updated\. Fetch/m);
  if (updated) return { ...base, flavour: "data.updated", subject: updated[1]!, detail: "updated" };
  const deleted = m(/document (\S+) that triggered this run has been DELETED/);
  if (deleted) return { ...base, flavour: "data.deleted", subject: deleted[1]!, detail: null };

  // daily
  const digest = m(/^Morning digest for (\S+?)\./m);
  if (digest) return { ...base, flavour: "daily.digest", subject: digest[1]!, detail: null };
  const dailySource = m(/^Daily batch review for source "([^"]+)"/m);
  if (dailySource)
    return { ...base, flavour: "daily.source", subject: dailySource[1]!, detail: null };
  if (prompt.includes("day-ahead lookahead enqueued by an older build"))
    return { ...base, flavour: "daily.mayday", subject: null, detail: null };

  // time_based
  if (prompt.includes("<scheduled-instruction>")) {
    const instr = m(/<scheduled-instruction>\n([\s\S]*?)\n<\/scheduled-instruction>/);
    return {
      ...base,
      flavour: "time_based.scheduled",
      subject: null,
      detail: instr?.[1] ?? null,
    };
  }
  const decay = m(/no new data has touched open loop (\S+) for a while/);
  if (decay) return { ...base, flavour: "time_based.decay", subject: decay[1]!, detail: null };
  const decayGone = m(/This is a decay status-check on (?:open )?loop (\S+)/);
  if (decayGone)
    return { ...base, flavour: "time_based.decay.gone", subject: decayGone[1]!, detail: null };

  // feedback
  const reacted = m(/^The user reacted to brief (\S+) \("([^"]*)"\)\. Its state is now: (\S+)\./m);
  if (reacted)
    return {
      ...base,
      flavour: "feedback.dismissal",
      subject: reacted[1]!,
      detail: reacted[2]!,
    };
  const provenance = m(/^Provenance re-check(?: for)? (brief|loop) (\S+)/m);
  if (provenance)
    return {
      ...base,
      flavour: "feedback.provenance",
      subject: provenance[2]!,
      detail: provenance[1]!,
    };
  if (prompt.includes("Provenance re-check:"))
    return { ...base, flavour: "feedback.provenance", subject: null, detail: null };

  // synthesis
  const noticing = m(/^Synthesis pass \("Noticing"\) for (\S+)\./m);
  if (noticing)
    return { ...base, flavour: "synthesis.noticing", subject: noticing[1]!, detail: null };
  if (prompt.includes("Cross-loop collision check."))
    return { ...base, flavour: "synthesis.collision.loops", subject: null, detail: null };
  if (prompt.includes("Time-overlap check"))
    return { ...base, flavour: "synthesis.collision.temporal", subject: null, detail: null };
  if (prompt.includes("Annotation-contradiction check"))
    return { ...base, flavour: "synthesis.contradiction", subject: null, detail: null };

  // sweep
  const sweep = m(/^Scheduled sweep "([^"]+)" for (\S+)\./m);
  if (sweep) return { ...base, flavour: "sweep", subject: sweep[1]!, detail: sweep[2]! };

  // bootstrap
  const boot = m(/^RETROSPECTIVE BOOTSTRAP\. This is a PAST document \((\S+)\)/m);
  if (boot) return { ...base, flavour: "bootstrap", subject: boot[1]!, detail: null };
  const bootGone = m(/^The document (\S+) this bootstrap run targets has been DELETED/m);
  if (bootGone)
    return { ...base, flavour: "bootstrap.deleted", subject: bootGone[1]!, detail: null };

  // verification
  const verify = m(/^Re-verification pass over the (doc|person) annotation store\./m);
  if (verify) return { ...base, flavour: "verification", subject: verify[1]!, detail: null };
  if (prompt.includes("Re-verification check: none of the flagged annotations"))
    return { ...base, flavour: "verification.empty", subject: null, detail: null };

  // merge adjudication
  if (prompt.includes("You are adjudicating ONE pending person-merge candidate"))
    return { ...base, flavour: "merge_adjudication", subject: null, detail: null };
  const mergeSettled = m(/^Merge candidate (\S+) is /m);
  if (mergeSettled)
    return {
      ...base,
      flavour: "merge_adjudication.settled",
      subject: mergeSettled[1]!,
      detail: null,
    };

  // notes compaction
  const notes = m(/^Notes compaction: your agent notes are (\d+) bytes/m);
  if (notes) return { ...base, flavour: "notes_compaction", subject: notes[1]!, detail: null };

  if (/payload is malformed/.test(prompt))
    return { ...base, flavour: "malformed", subject: null, detail: null };

  return { ...base, flavour: "unknown", subject: null, detail: null };
}

// ── the plan DSL ────────────────────────────────────────────────────────────

/**
 * A reference to a value produced by an earlier call in this run. `path`
 * is dot-notation into the executed step's parsed result, rooted at the
 * result's `data` for a structured result (so `open_loop_create` →
 * `"loop.id"`), with the step chosen by tool name and occurrence.
 */
export interface PlanRef {
  __ref: true;
  tool: string;
  path: string;
  /** Which occurrence of that tool to read; defaults to the first. */
  nth?: number;
}

export function ref(tool: string, path: string, nth = 0): PlanRef {
  return { __ref: true, tool, path, nth };
}

function isRef(v: unknown): v is PlanRef {
  return typeof v === "object" && v !== null && (v as PlanRef).__ref === true;
}

/** One scripted tool call. */
export interface PlanCall {
  tool: string;
  args: Record<string, unknown>;
}

export function call(tool: string, args: Record<string, unknown> = {}): PlanCall {
  return { tool, args };
}

/**
 * What the puppet does for one run: an ordered list of calls, then a final
 * text turn. An empty list is a legitimate plan — most runs should do
 * nothing.
 */
export interface PuppetPlan {
  calls: PlanCall[];
  /** The closing text turn. */
  finalText?: string;
}

/** Match a run to a plan. Every field present must match. */
export interface PuppetBehavior {
  /** Run kind (`data`, `sweep`, …). */
  kind?: string;
  /** Run flavour, more specific than kind. */
  flavour?: RunFlavour;
  /** The run's subject, exactly (a source id, sweep id, brief id, doc id). */
  subject?: string;
  /** A substring the run prompt must contain — the escape hatch for anything unmodelled. */
  promptContains?: string;
  /**
   * For data/bootstrap runs, the TITLE of the fetched document. Requires
   * the plan to have fetched it, which the puppet does automatically for
   * document-subject runs before consulting the behavior table.
   */
  docTitle?: string;
  /** Only match on this attempt number. */
  attempt?: number;
  /** The plan to carry out. */
  plan: PuppetPlan | ((ctx: RunContext) => PuppetPlan);
}

/** The behavior table a bench hands the puppet. */
export interface PuppetBehaviors {
  behaviors?: readonly PuppetBehavior[];
  /** Text for a run that matches nothing. Defaults to a no-op note. */
  fallbackText?: string;
}

// ── result reading ──────────────────────────────────────────────────────────

/** The payload a structured tool result carries under `data`. */
export function structuredData(result: unknown): Record<string, unknown> | null {
  if (result === null || typeof result !== "object") return null;
  const r = result as { kind?: unknown; data?: unknown };
  if (r.kind !== "structured" || r.data === null || typeof r.data !== "object") return null;
  return r.data as Record<string, unknown>;
}

function readPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    const idx = Number.parseInt(seg, 10);
    cur =
      Array.isArray(cur) && !Number.isNaN(idx) ? cur[idx] : (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Read a ref against the executed steps; undefined when not yet available. */
export function resolveRef(r: PlanRef, steps: readonly ToolStep[]): unknown {
  const matches = steps.filter((s) => s.name === r.tool);
  const step = matches[r.nth ?? 0];
  if (!step) return undefined;
  const data = structuredData(step.result);
  return readPath(data ?? step.result, r.path);
}

/** Substitute every ref in an args object; unresolved refs become undefined. */
export function resolveArgs(
  args: Record<string, unknown>,
  steps: readonly ToolStep[],
): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (isRef(v)) return resolveRef(v, steps);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(args) as Record<string, unknown>;
}

/** The title of the document a `fetch_many` step returned. */
export function fetchedTitle(step: ToolStep | undefined): string | null {
  if (!step || step.result === null || typeof step.result !== "object") return null;
  const r = step.result as {
    kind?: unknown;
    document?: { title?: unknown };
    items?: Array<{ kind?: unknown; document?: { title?: unknown } } | null>;
  };
  const doc =
    r.kind === "document.batch" && Array.isArray(r.items)
      ? (r.items.find((it) => it?.kind === "document") ?? null)?.document
      : r.kind === "document"
        ? r.document
        : null;
  return typeof doc?.title === "string" ? doc.title : null;
}

// ── the decision ────────────────────────────────────────────────────────────

export type NextTurn =
  | { kind: "tool"; name: string; args: Record<string, unknown> }
  | { kind: "final"; text: string };

/** Flavours whose subject is a document the puppet fetches before deciding. */
const DOCUMENT_SUBJECT_FLAVOURS = new Set<RunFlavour>([
  "data.created",
  "data.updated",
  "bootstrap",
]);

/**
 * The four loop/brief write tools require `annotationDependencies`; a plan
 * that declares no priors gets an explicit empty list rather than failing
 * argument validation.
 */
const DEPENDENCY_TOOLS = new Set([
  "open_loop_create",
  "open_loop_update",
  "brief_create",
  "brief_update",
]);

function pickBehavior(
  behaviors: readonly PuppetBehavior[],
  ctx: RunContext,
  docTitle: string | null,
): PuppetBehavior | null {
  for (const b of behaviors) {
    if (b.kind !== undefined && b.kind !== ctx.kind) continue;
    if (b.flavour !== undefined && b.flavour !== ctx.flavour) continue;
    if (b.subject !== undefined && b.subject !== ctx.subject) continue;
    if (b.attempt !== undefined && b.attempt !== ctx.attempt) continue;
    if (b.promptContains !== undefined && !ctx.prompt.includes(b.promptContains)) continue;
    if (b.docTitle !== undefined && b.docTitle !== docTitle) continue;
    return b;
  }
  return null;
}

/**
 * Decide the next turn from the conversation so far. Pure; the puppet
 * server is a thin HTTP wrapper over this.
 */
export function decideNextTurn(messages: readonly WireMessage[], table: PuppetBehaviors): NextTurn {
  const prompt = messages.find((m) => m.role === "user")?.content ?? "";
  const ctx = readRunContext(prompt);
  if (!ctx) {
    return { kind: "final", text: "This is not a cognition run prompt; refusing to act." };
  }
  const steps = collectToolSteps(messages);

  // A run whose subject is a document is given the document first: the
  // behavior table keys on the title, which only a real fetch can supply.
  let docTitle: string | null = null;
  if (DOCUMENT_SUBJECT_FLAVOURS.has(ctx.flavour) && ctx.subject) {
    const fetchStep = steps.find((s) => s.name === "fetch_many");
    if (!fetchStep) {
      return {
        kind: "tool",
        name: "fetch_many",
        args: { documents: [{ documentId: ctx.subject }] },
      };
    }
    docTitle = fetchedTitle(fetchStep);
    if (docTitle === null) {
      return { kind: "final", text: "fetch_many failed; stopping without mutating anything." };
    }
  }

  const behavior = pickBehavior(table.behaviors ?? [], ctx, docTitle);
  if (!behavior) {
    return {
      kind: "final",
      text:
        table.fallbackText ??
        `No scripted behavior for ${ctx.kind}/${ctx.flavour}${ctx.subject ? ` (${ctx.subject})` : ""}; nothing to do.`,
    };
  }
  const plan = typeof behavior.plan === "function" ? behavior.plan(ctx) : behavior.plan;
  return emitNextPlanned(plan, steps, docTitle !== null);
}

/**
 * Emit the first planned call not yet executed.
 *
 * The puppet only ever emits in plan order, so the Nth executed call of a
 * tool is the Nth planned call of that tool: matching counts occurrences
 * per tool name rather than comparing arguments. That keeps a plan free to
 * repeat a tool — three ledger appends, two annotation writes — without a
 * later repeat being mistaken for the first one having already run, and it
 * makes progress independent of whether a call SUCCEEDED: a rejected write
 * still counts as executed, so a gated tool cannot spin forever.
 */
export function emitNextPlanned(
  plan: PuppetPlan,
  steps: readonly ToolStep[],
  skipLeadingFetch: boolean,
): NextTurn {
  const remaining = new Map<string, number>();
  for (const s of steps) remaining.set(s.name, (remaining.get(s.name) ?? 0) + 1);
  // The automatic document fetch is not part of the plan; don't let it
  // consume a planned `fetch_many`.
  if (skipLeadingFetch && (remaining.get("fetch_many") ?? 0) > 0) {
    remaining.set("fetch_many", remaining.get("fetch_many")! - 1);
  }

  for (const planned of plan.calls) {
    const already = remaining.get(planned.tool) ?? 0;
    if (already > 0) {
      remaining.set(planned.tool, already - 1);
      continue;
    }
    const args = resolveArgs(planned.args, steps);
    return {
      kind: "tool",
      name: planned.tool,
      args: DEPENDENCY_TOOLS.has(planned.tool) ? { annotationDependencies: [], ...args } : args,
    };
  }
  return { kind: "final", text: plan.finalText ?? "Scripted plan complete." };
}
