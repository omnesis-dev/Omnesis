// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The scripted loop-model server — a deterministic fake OpenAI-compatible
 * chat-completions server that stands in for the `background-agent` model
 * in the Brain reconcile instrument (the scripted half of its
 * instrument validation).
 *
 * Unlike the config-level ReplayBackend (which replays transcripts and
 * never invokes tools), this server emits real `tool_calls`, so the
 * gateway's run driver executes the REAL tool layer end-to-end: fetch the
 * triggering document, reconcile via `open_loop_search`, then mutate
 * loops/observations through the write gate — a scripted run leaves genuine
 * rows behind.
 *
 * The script is not a canned transcript: each request derives the next
 * action from the conversation so far (the messages array carries all
 * state; the server itself is stateless per request) and from the arc
 * behavior table (`briefs-arcs.ts`) keyed by the FETCHED document's
 * title. `decideNextTurn` is exported pure for unit tests.
 *
 * Wire shape: only non-streamed completions are served; a `stream: true`
 * request gets a 400, which `HttpChatBackend`'s resilience ladder
 * (stream → stream-without-options → non-streamed) treats as a request-
 * shape problem and retries non-streamed. Deterministic by construction.
 */

import { createServer, type Server } from "node:http";
import { parseCognitionRunEnvelope } from "@omnesis/core";
import { parseClaimMarkup } from "@omnesis/gateway/src/brain/knowledge/claims.js";
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";
import { preserveCurrentOwner, refreshCurrentOwner } from "./brain-bench/source-interpretations.js";
import {
  readRunContext,
  collectToolSteps as collectMaintenanceSteps,
  type PuppetPlan,
} from "./brain-bench/puppet-plan.js";
import type { ArcAction, ArcDocBehavior } from "./briefs-arcs.js";

const SCRIPTED_LOOP_MODEL_ID = "scripted-loop-agent-v1";

// ── message parsing ─────────────────────────────────────────────────────────

interface WireToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

/** One executed tool round-trip reconstructed from the history. */
interface ToolStep {
  name: string;
  args: unknown;
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

/** Reconstruct the executed tool steps from the OpenAI message history. */
function collectToolSteps(messages: readonly WireMessage[]): ToolStep[] {
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
        args: safeParse(tc.function.arguments),
        result: resultsByCallId.get(tc.id) ?? null,
      });
    }
  }
  return steps;
}

// ── run-prompt parsing ──────────────────────────────────────────────────────

interface RunPromptMeta {
  runId: string | null;
  kind: string | null;
  event: "created" | "updated" | null;
  docId: string | null;
  docDeleted: boolean;
  hasDiff: boolean;
}

/** Parse the run driver's prompt envelope + the data-run body. */
export function parseRunPrompt(prompt: string): RunPromptMeta {
  // The envelope follows the static run rules, so it is found on any line.
  const envelope = parseCognitionRunEnvelope(prompt);
  const created = /A new document arrived: (\S+)\. Fetch/.exec(prompt);
  const updated = /^Document (\S+) was updated\./m.exec(prompt);
  const deleted = /document (\S+) that triggered this run has been DELETED/.exec(prompt);
  return {
    runId: envelope?.runId ?? null,
    kind: envelope?.kind ?? null,
    event: created ? "created" : updated ? "updated" : null,
    docId: created?.[1] ?? updated?.[1] ?? deleted?.[1] ?? null,
    docDeleted: deleted !== null,
    hasDiff: prompt.includes("<diff>"),
  };
}

// ── the scripted decision ───────────────────────────────────────────────────

export type NextTurn =
  | { kind: "tool"; name: string; args: Record<string, unknown> }
  | { kind: "final"; text: string };

interface SearchLoopHit {
  id: string;
  title: string;
  state: string;
  docs?: string[];
  /** Open (live/held) observations attached to the loop. */
  attachedObservations: Array<{ id: string; state: string }>;
}

function structuredData(result: unknown): Record<string, unknown> | null {
  if (result === null || typeof result !== "object") return null;
  const r = result as { kind?: unknown; data?: unknown };
  if (r.kind !== "structured" || r.data === null || typeof r.data !== "object") return null;
  return r.data as Record<string, unknown>;
}

function searchHits(step: ToolStep | undefined): SearchLoopHit[] | null {
  if (!step) return null;
  const data = structuredData(step.result);
  if (!data || !Array.isArray(data.loops)) return null;
  return data.loops as SearchLoopHit[];
}

function fetchedTitle(step: ToolStep | undefined): string | null {
  if (!step || step.result === null || typeof step.result !== "object") return null;
  const r = step.result as {
    kind?: unknown;
    document?: { title?: unknown };
    items?: Array<{ kind?: unknown; document?: { title?: unknown } } | null>;
  };
  // `fetch_many` returns a `document.batch`; unwrap the first document child.
  const doc =
    r.kind === "document.batch" && Array.isArray(r.items)
      ? (r.items.find((it) => it?.kind === "document") ?? null)?.document
      : r.kind === "document"
        ? r.document
        : null;
  return typeof doc?.title === "string" ? doc.title : null;
}

function createdLoopId(step: ToolStep | undefined): string | null {
  const data = step ? structuredData(step.result) : null;
  const loop = data?.loop as { id?: unknown } | undefined;
  return typeof loop?.id === "string" ? loop.id : null;
}

/** The plan for one action, as an ordered list of tool invocations. */
function planFor(
  action: ArcAction,
  docId: string,
  steps: readonly ToolStep[],
): Array<{ name: string; args: Record<string, unknown> }> | { finalText: string } {
  if (action.kind === "ignore") {
    return { finalText: "Nothing loop-worthy in this datum. Done." };
  }

  if (action.kind === "inform") {
    // Awareness only: a standalone observation, no loop and no loop search.
    return [
      { name: "observation_list", args: {} },
      {
        name: "observation_note",
        args: {
          summary: action.observation,
          why: "Worth knowing; nothing to act on.",
          citations: [docId],
        },
      },
    ];
  }

  const search = steps.find((s) => s.name === "open_loop_search");
  if (!search) {
    return [{ name: "open_loop_search", args: { query: action.searchQuery } }];
  }
  const hits = searchHits(search);
  if (hits === null) {
    return { finalText: "open_loop_search failed; stopping without mutating anything." };
  }
  const fetchedOwner = steps
    .filter((step) => step.name === "open_loop_fetch")
    .map((step) => structuredData(step.result))
    .find((row) => typeof row?.title === "string" && row.title.includes(action.marker));
  const matched =
    hits.find((l) => l.title.includes(action.marker)) ??
    (fetchedOwner as unknown as SearchLoopHit | undefined);
  // A historical commitment is not a fresh obligation just because the active
  // search omits its terminal owner. These fixture arcs have unique markers.
  const retired = structuredData(search.result)?.retired;
  if (
    !matched &&
    Array.isArray(retired) &&
    retired.some((entry: { title?: string }) => entry.title?.includes(action.marker))
  )
    return [{ name: "open_loop_search", args: { query: action.searchQuery } }];
  const alreadyOwned = hits.find(
    (hit) => hit.title.includes(action.marker) && hit.docs?.includes(docId),
  );
  if (action.kind === "commit" && alreadyOwned) {
    const reconciled = [{ name: "open_loop_search", args: { query: action.searchQuery } }];
    if (
      alreadyOwned.attachedObservations.length ||
      ["done", "dismissed"].includes(alreadyOwned.state)
    )
      return reconciled;
    // A previous attempt may have committed the loop but stopped before its
    // observation. Finish that plan without repeating even a planted duplicate mint.
    return [
      ...reconciled,
      { name: "observation_list", args: {} },
      {
        name: "observation_note",
        args: {
          summary: action.observation,
          why: "Needs your attention.",
          citations: [docId],
          relatedLoopIds: [alreadyOwned.id],
        },
      },
    ];
  }

  if (action.kind === "commit") {
    if (matched && !action.forceCreate) {
      return [
        { name: "open_loop_search", args: { query: action.searchQuery } },
        {
          name: "open_loop_ledger_append",
          args: {
            id: matched.id,
            note: `Duplicate datum for ${action.marker}; adopted the existing loop.`,
          },
        },
      ];
    }
    const create = steps.find((s) => s.name === "open_loop_create");
    const loopId = createdLoopId(create);
    return [
      { name: "open_loop_search", args: { query: action.searchQuery } },
      {
        name: "open_loop_create",
        args: {
          title: action.loopTitle,
          description: "Tracked from the triggering document.",
          confidence: 0.9,
          importance: 0.8,
          docs: [docId],
        },
      },
      { name: "observation_list", args: {} },
      {
        name: "observation_note",
        args: {
          summary: action.observation,
          why: "Needs your attention.",
          citations: [docId],
          relatedLoopIds: loopId ? [loopId] : [],
        },
      },
    ];
  }

  if (action.kind === "schedule") {
    // Reconsideration must adopt a dated commitment already represented by a
    // loop and its observation; its scheduled follow-up belongs to that same owner.
    if (
      matched &&
      (matched.attachedObservations.length || ["done", "dismissed"].includes(matched.state))
    )
      return [{ name: "open_loop_search", args: { query: action.searchQuery } }];
    // A fresh dated commitment: reconcile (no match exists in the arc), then
    // track it as a loop and note an observation windowed on the scheduled
    // day, plus a re-verify run tied to the loop. loopId is read from the create
    // step's result once it lands (same seam as the commit plan).
    const create = steps.find((s) => s.name === "open_loop_create");
    const loopId = matched?.id ?? createdLoopId(create);
    return [
      { name: "open_loop_search", args: { query: action.searchQuery } },
      ...(matched
        ? []
        : [
            {
              name: "open_loop_create",
              args: {
                title: action.loopTitle,
                description: "Dated self-reminder tracked from the triggering document.",
                confidence: 0.9,
                importance: 0.7,
                docs: [docId],
              },
            },
          ]),
      { name: "observation_list", args: {} },
      {
        name: "observation_note",
        args: {
          summary: action.observation,
          why: "Matters on the scheduled day.",
          citations: [docId],
          relatedLoopIds: loopId ? [loopId] : [],
          windowStart: action.windowStart,
          relevantUntil: action.relevantUntil,
        },
      },
      {
        name: "schedule_agent_run",
        args: {
          when: action.scheduleWhen,
          prompt: `Re-verify the dated to-do "${action.loopTitle}" is not already done before ${action.relevantUntil}.`,
          ...(loopId ? { loopId } : {}),
        },
      },
    ];
  }

  if (action.kind === "note") {
    if (!matched) {
      return { finalText: `No loop matching ${action.marker} to annotate. Done.` };
    }
    return [
      { name: "open_loop_search", args: { query: action.searchQuery } },
      { name: "open_loop_ledger_append", args: { id: matched.id, note: action.ledgerNote } },
    ];
  }

  if (action.kind === "retract") {
    // The obligation never belonged to the user: delete the loop outright
    // (attached observations cascade). done would fabricate a fulfilment.
    if (!matched) {
      return { finalText: `No loop matching ${action.marker} to retract. Done.` };
    }
    return [
      { name: "open_loop_search", args: { query: action.searchQuery } },
      { name: "open_loop_delete", args: { id: matched.id } },
    ];
  }

  if (action.kind === "resolvedCommit") {
    // An obligation whose fulfilment already synced: close a matching open
    // loop if one exists, else track it as created-and-immediately-done.
    // No observation either way — nothing needs the user. The create's loop id is
    // read from the executed step's result once it lands (plan order
    // guarantees the id-bearing calls are only emitted after the create).
    if (matched) {
      return [
        { name: "open_loop_search", args: { query: action.searchQuery } },
        { name: "open_loop_update", args: { id: matched.id, state: "done" } },
        { name: "open_loop_ledger_append", args: { id: matched.id, note: action.ledgerNote } },
      ];
    }
    const create = steps.find((s) => s.name === "open_loop_create");
    const loopId = createdLoopId(create);
    return [
      { name: "open_loop_search", args: { query: action.searchQuery } },
      {
        name: "open_loop_create",
        args: {
          title: action.loopTitle,
          description: "Obligation already fulfilled before it synced; tracked for the record.",
          confidence: 0.9,
          importance: 0.4,
          docs: [docId],
        },
      },
      { name: "open_loop_update", args: { ...(loopId ? { id: loopId } : {}), state: "done" } },
      {
        name: "open_loop_ledger_append",
        args: { ...(loopId ? { id: loopId } : {}), note: action.ledgerNote },
      },
    ];
  }

  // action.kind === "resolve"
  if (!matched) {
    // The duplicate-mint failure path: a correct system never reaches it
    // (the fresh-reads overlay makes the prior loop visible), but the
    // instrument must MODEL what a real agent does on a search miss so
    // regressions surface as detectable duplicates, not silent no-ops.
    return [
      { name: "open_loop_search", args: { query: action.searchQuery } },
      {
        name: "open_loop_create",
        args: {
          title: `Follow up on ${action.marker}`,
          description: "Resolution datum arrived but no tracked loop was found.",
          confidence: 0.5,
          importance: 0.5,
          docs: [docId],
        },
      },
    ];
  }

  if (action.ambiguous) {
    // The confirmation replaces whatever the loop already raised, so the
    // morning brief carries one current item for it.
    const supersedes = matched.attachedObservations.map((o) => o.id);
    return [
      { name: "open_loop_search", args: { query: action.searchQuery } },
      { name: "observation_list", args: {} },
      {
        name: "observation_note",
        args: {
          summary: action.confirmObservation ?? `Confirm completion of ${action.marker}`,
          why: "Please confirm this is fully handled.",
          citations: [docId],
          relatedLoopIds: [matched.id],
          ...(supersedes.length ? { supersedes } : {}),
        },
      },
      { name: "open_loop_ledger_append", args: { id: matched.id, note: action.ledgerNote } },
    ];
  }

  // Closing the loop drops its open observations in the same cascade, so a
  // clear resolution needs nothing beyond the state change and the note.
  return [
    { name: "open_loop_search", args: { query: action.searchQuery } },
    { name: "open_loop_update", args: { id: matched.id, state: "done" } },
    { name: "open_loop_ledger_append", args: { id: matched.id, note: action.ledgerNote } },
  ];
}

/** Current maintenance uses durable frontiers; legacy recovery below remains explicit. */
function maintenanceTurn(
  messages: readonly WireMessage[],
  behaviors: ReadonlyMap<string, ArcDocBehavior>,
): NextTurn | null {
  const prompt = messages.find((message) => message.role === "user")?.content ?? "";
  const context = readRunContext(prompt);
  if (context?.flavour !== "synthesis.knowledge") return null;
  return knowledgePuppet({
    maxRevisionConflictRetries: 8,
    targets(item, steps) {
      if (!item.source) return [];
      const behavior = behaviors.get(item.source.title);
      const action =
        behavior?.onUpdated && behavior.updatedContents?.includes(item.source.content)
          ? behavior.onUpdated
          : behavior?.onCreated;
      if (action?.kind !== "commit" || action.forceCreate) return [];
      const owner = steps
        .filter((step) => step.name === "open_loop_fetch")
        .map((step) => structuredData(step.result))
        .find((row) => typeof row?.title === "string" && row.title.includes(action.marker));
      return typeof owner?.id === "string" ? [owner.id] : [];
    },
    plan(item, ctx, steps) {
      const frontierAt = steps.map((step) => step.name).lastIndexOf("knowledge_next_frontier");
      const local = steps.slice(frontierAt + 1);
      if (!item.source) {
        if (item.node?.kind !== "loop" || item.node.validity !== "stale")
          return refreshCurrentOwner(item, ctx, steps);
        // The loop fixture's prose is deliberately unchanged by its ledger/state
        // actions. Read the canonical owner before explicitly retaining that
        // context; do not wait for an asynchronous mirror conversion to repair it.
        const ownerStep = local.find(
          (step) => step.name === "open_loop_fetch" && step.args?.id === item.node!.ownerId,
        );
        const calls: PuppetPlan["calls"] = [
          { tool: "open_loop_fetch", args: { id: item.node.ownerId } },
        ];
        if (!ownerStep) return { calls };
        const owner = structuredData(ownerStep.result);
        if (
          owner?.title !== item.node.title ||
          owner.description !== parseClaimMarkup(item.node.markdown).text
        )
          return {
            calls,
            finalText: "Canonical loop prose changed; refuse stale fixture preservation.",
          };
        const preserved = preserveCurrentOwner(
          { ...item, node: { ...item.node, validity: "current" } },
          ctx,
          steps,
        );
        return { ...preserved, calls: [...calls, ...preserved.calls] };
      }
      const behavior = behaviors.get(item.source.title);
      const action =
        behavior?.onUpdated && behavior.updatedContents?.includes(item.source.content)
          ? behavior.onUpdated
          : behavior?.onCreated;
      const plan = action
        ? planFor(action, item.source.id, local)
        : { finalText: "No scripted mutation for this source." };
      const calls: PuppetPlan["calls"] = [
        { tool: "fetch_many", args: { documents: [{ documentId: item.source.id }] } },
      ];
      // A conflict retry must not forget an owner this run already discovered
      // and closed: active search may now omit it. Read its current canonical
      // state again rather than using the earlier snapshot as truth.
      if (action && action.kind !== "ignore" && action.kind !== "inform") {
        const previousOwner = steps
          .slice(0, frontierAt)
          .filter((step) => step.name === "open_loop_search")
          .flatMap((step) => searchHits(step) ?? [])
          .find((hit) => hit.title.includes(action.marker));
        if (previousOwner) calls.push({ tool: "open_loop_fetch", args: { id: previousOwner.id } });
      }
      if (!Array.isArray(plan)) return { calls, finalText: plan.finalText };
      for (const call of plan) {
        // Duplicate evidence needs an exact owner read and a durable routing
        // hint, not a meaningless canonical ledger mutation that races its creator.
        if (
          action?.kind === "commit" &&
          !action.forceCreate &&
          call.name === "open_loop_ledger_append"
        ) {
          calls.push({ tool: "open_loop_fetch", args: { id: call.args.id } });
          continue;
        }
        if (
          ["open_loop_update", "open_loop_delete", "open_loop_ledger_append"].includes(call.name) &&
          typeof call.args.id === "string"
        )
          calls.push({ tool: "open_loop_fetch", args: { id: call.args.id } });
        calls.push({
          tool: call.name,
          args: ["open_loop_create", "open_loop_update", "observation_note"].includes(call.name)
            ? { annotationDependencies: [], ...call.args }
            : call.args,
        });
      }
      return { calls };
    },
  })(context, collectMaintenanceSteps(messages));
}

/**
 * Derive the next turn from the full message history — the scripted
 * agent's whole brain. Pure; exported for unit tests.
 */
export function decideNextTurn(
  messages: readonly WireMessage[],
  behaviors: ReadonlyMap<string, ArcDocBehavior>,
): NextTurn {
  const prompt = messages.find((m) => m.role === "user")?.content ?? "";
  const meta = parseRunPrompt(prompt);
  const maintenance = maintenanceTurn(messages, behaviors);
  if (maintenance) return maintenance;

  if (meta.kind !== "data") {
    return { kind: "final", text: `No scripted behavior for run kind "${meta.kind}". Done.` };
  }
  if (meta.docDeleted) {
    return { kind: "final", text: "Triggering document was deleted; nothing to do." };
  }
  if (!meta.docId || !meta.event) {
    return { kind: "final", text: "Malformed data-run prompt; refusing to act." };
  }

  const steps = collectToolSteps(messages);
  const fetchStep = steps.find((s) => s.name === "fetch_many");
  if (!fetchStep) {
    return { kind: "tool", name: "fetch_many", args: { documents: [{ documentId: meta.docId }] } };
  }
  const title = fetchedTitle(fetchStep);
  if (title === null) {
    return { kind: "final", text: "fetch_many failed; stopping without mutating anything." };
  }
  const behavior = behaviors.get(title);
  if (!behavior) {
    return { kind: "final", text: "No scripted behavior for this document; nothing to do." };
  }
  const action =
    meta.event === "updated" && behavior.onUpdated ? behavior.onUpdated : behavior.onCreated;

  const plan = planFor(action, meta.docId, steps);
  if (!Array.isArray(plan)) return { kind: "final", text: plan.finalText };
  return emitNextPlanned(plan, steps);
}

/**
 * Emit the first planned call not yet present in the executed steps.
 * Calls are matched by name, and by `id`/`documentId` argument when one
 * is present (so repeated calls on different loops each run once).
 */
function emitNextPlanned(
  plan: ReadonlyArray<{ name: string; args: Record<string, unknown> }>,
  steps: readonly ToolStep[],
): NextTurn {
  const remaining = [...steps];
  for (const call of plan) {
    const idx = remaining.findIndex((s) => {
      if (s.name !== call.name) return false;
      const wantId = (call.args as { id?: unknown }).id;
      if (wantId === undefined) return true;
      return (s.args as { id?: unknown } | null)?.id === wantId;
    });
    if (idx === -1) {
      const args = ["open_loop_create", "open_loop_update", "observation_note"].includes(call.name)
        ? { annotationDependencies: [], ...call.args }
        : call.args;
      return { kind: "tool", name: call.name, args };
    }
    remaining.splice(idx, 1);
  }
  return { kind: "final", text: "Scripted plan complete." };
}

// ── the HTTP server ─────────────────────────────────────────────────────────

/** One recorded completion request, for e2e transcript assertions. */
interface RecordedModelCall {
  at: number;
  runId: string | null;
  kind: string | null;
  event: "created" | "updated" | null;
  docId: string | null;
  /** The run prompt (first user message). */
  prompt: string;
  emitted: NextTurn;
}

export interface ScriptedLoopModelServer {
  url: string;
  modelId: string;
  /** Every completion request served, in order. */
  calls: RecordedModelCall[];
  close(): Promise<void>;
}

export interface ScriptedLoopModelOptions {
  behaviors: ReadonlyMap<string, ArcDocBehavior>;
  modelId?: string;
}

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startScriptedLoopModelServer(
  opts: ScriptedLoopModelOptions,
): Promise<ScriptedLoopModelServer> {
  const modelId = opts.modelId ?? SCRIPTED_LOOP_MODEL_ID;
  const calls: RecordedModelCall[] = [];
  let counter = 0;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
      if (req.method === "GET" && url.startsWith("/v1/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ id: modelId, object: "model", owned_by: "omnesis-test" }],
          }),
        );
        return;
      }
      if (req.method === "POST" && url.startsWith("/v1/chat/completions")) {
        const body = safeParse(await readBody(req)) as {
          stream?: unknown;
          messages?: WireMessage[];
        } | null;
        if (!body || !Array.isArray(body.messages)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "malformed request body" } }));
          return;
        }
        if (body.stream === true) {
          // Request-shape 400: HttpChatBackend's resilience ladder retries
          // non-streamed, which is the only shape this server speaks.
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: "stream is not supported by the scripted loop-model server" },
            }),
          );
          return;
        }

        const turn = decideNextTurn(body.messages, opts.behaviors);
        const prompt = body.messages.find((m) => m.role === "user")?.content ?? "";
        const meta = parseRunPrompt(prompt);
        const steps = collectToolSteps(body.messages);
        const frontierAt = steps.map((step) => step.name).lastIndexOf("knowledge_next_frontier");
        const frontier = structuredData(steps[frontierAt]?.result);
        const completed = new Set(
          steps
            .slice(frontierAt + 1)
            .filter((step) => step.name === "knowledge_discovery_complete")
            .map((step) => (step.args as { id?: unknown })?.id),
        );
        const source = (
          frontier?.items as
            | Array<{ id: string; source?: { id: string; content: string } }>
            | undefined
        )?.find((item) => item.source && !completed.has(item.id))?.source;
        calls.push({
          at: Date.now(),
          runId: meta.runId,
          kind: meta.kind,
          event: meta.event,
          docId: meta.docId ?? source?.id ?? null,
          prompt,
          emitted: turn,
        });

        const usage = {
          prompt_tokens: Math.ceil(JSON.stringify(body.messages).length / 4),
          completion_tokens: 24,
        };
        const message =
          turn.kind === "tool"
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `call_${++counter}`,
                    type: "function",
                    function: { name: turn.name, arguments: JSON.stringify(turn.args) },
                  },
                ],
              }
            : { role: "assistant", content: turn.text };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: `scripted-${counter}`,
            object: "chat.completion",
            model: modelId,
            choices: [
              {
                index: 0,
                message,
                finish_reason: turn.kind === "tool" ? "tool_calls" : "stop",
              },
            ],
            usage,
          }),
        );
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${url}` } }));
    })().catch(() => {
      try {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "internal scripted-server error" } }));
      } catch {
        /* response already gone */
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("scripted loop-model server failed to bind a port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    modelId,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
