// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure-JS reducer + transcript helpers for the agent view.
 *
 * Lives outside `agent.js` so the state machine can be unit-tested without
 * pulling Preact / DOM dependencies.
 *
 * Event → state reducer:
 *   session-ready, session-failed, user-send, conversations-list,
 *   rail-toggle, load-conversation, reset-conversation
 *   agent.message.start    → start a new assistant turn (parts: [])
 *   agent.text.delta       → append to the last text part (or start one)
 *   agent.thinking.delta   → append to the last thinking part (or start one)
 *   agent.tool.input_start → push a tool stub with no args yet
 *   agent.tool.start       → upgrade the stub with finalised args
 *   agent.tool.result      → fill in the matching tool part's result + duration
 *   agent.citation         → append an entry to the cited doc + bump assistant turn's citationCount
 *   agent.citations.update → mutate the Citations sidebar
 *   agent.message.end      → mark the turn done; clear busy
 *   agent.error            → attach error to the in-flight turn
 */

export const initialState = () => ({
  client: null,
  sessionId: null,
  model: null,
  backend: null,
  turns: [], // [{ id, role: "user"|"assistant", parts, error?, done, citationCount? }]
  // Citations[]: aggregated by documentId. Each carries `entries[]` of
  // { quote?, note?, toolCallId, messageId }. Populated only via the
  // `annotate` tool — search hits and fetched docs never auto-populate.
  citations: [],
  citationsByDocId: new Map(),
  // Annotation buckets fed by `annotate.recorded` — the ONLY document source
  // for the side-panel Timeline. Shape:
  //   byDoc: { [docId]: { ref?, note?, quotes: [{quote, note?}] } }
  // `byDoc` carries the DocRef on first set — `buildUnifiedTimeline`
  // synthesises one Timeline row per annotated document. A
  // `trace_connections` walk's raw output never lands here.
  trailAnnotations: {
    byDoc: {},
  },
  // Record citations fed by `cite_record.recorded` (#757) — every DuckDB row
  // the agent cited directly. Each is a record-only timeline event keyed by
  // `recordKey`; `buildUnifiedTimeline` interleaves them with the annotated
  // documents by semantic time.
  recordCitations: [],
  // Origin anchor when the loaded conversation did not start as a blank
  // chat — a brief's talk-back (`{ kind: "brief", briefId, runId, brief?,
  // seedMessageCount? }`) or a thread the agent opened when a watch fired (`{ kind:
  // "watch_firing", firingId, runId, watchId, watch?, seedMessageCount? }`).
  // The transcript pins the origin's snapshot card on top and the seeded
  // prefix is hidden (see `visibleMessages`). Null for plain chats.
  briefOrigin: null,
  busy: false,
  // Durable, conversation-level context exhaustion. It is intentionally
  // outside `turns` so it never becomes model-visible transcript history.
  terminalFailure: null,
  fatalError: null,
  // Agent-harness status from GET /admin/agent/config. null until probed.
  // When `{ enabled: false }`, the view renders configuration guidance
  // instead of a chat surface and never mints a session.
  agentConfig: null, // { backend, enabled, disabledReason } | null
  conversations: [], // [{ id, title, updatedAt, messageCount, model, backend }]
  railCollapsed: false,
  conversationError: null,
  // The resumed transcript is newest-first by page but chronological within
  // each turn-aligned page. Older pages are prepended on demand.
  messageNextCursor: null,
  // True when paging stopped defensively on a repeated/advancing no-progress
  // cursor. No numeric transcript count is shown today, but retaining this
  // distinction prevents future UI from treating a partial transcript as
  // proven complete.
  messagePagingTruncated: false,
  messageCount: 0,
  loadedHistoryPageKeys: [],
  loadedHistoryPageSignatures: [],
  // Sticky banner shown when the URL points at a conversation the
  // gateway can't find (deleted, never existed, wrong caller). The view
  // falls back to the empty state and offers "+ New" as recovery.
  notFoundConvoId: null,
  // Transient agent TODO panel. The `plan` tool returns the full
  // current list; we mirror it here verbatim. The view layer drives
  // the slide-in / 1s-after-done / slide-out animations on top of this
  // canonical state. Cleared after the turn ends (with a short grace
  // period) and on session reset; persisted history does not repopulate
  // it.
  planItems: [],
  // True while a user-invoked Deep Research run is in flight (the `/`-pill
  // set `deepResearch:true` on the send). Drives the bespoke multi-panel
  // research working-set surface: the surface appears only while this is
  // set AND at least one sub-agent panel exists, and collapses into the
  // written-back report when the run ends (`message.end` / error / reset).
  // It is a run-active marker, NOT persisted — resuming a conversation
  // never re-opens the surface.
  deepResearch: false,
});

/**
 * Tool names whose tool_use blocks are silently dropped when
 * reconstructing the transcript from persisted history. The live
 * renderer surfaces these as "ephemeral" rolling-slot cards that
 * stream their content in and then dismiss themselves; on resume the
 * rolling animation must NOT replay (the user is revisiting an old
 * conversation, not watching one in flight). Filtering at the data
 * boundary — rather than at the renderer — means the reconstructed
 * transcript literally doesn't carry these parts, so no card mount,
 * no animation, no surprise replay.
 *
 * This is purely client-side UI: the gateway's ConversationStore
 * record is the canonical history and is left untouched, so a
 * follow-up message after resume still hands the agent every tool
 * call/result for context.
 */
/**
 * The three tool names whose live `tool_use` blocks render as
 * self-dismissing rolling-slot cards (search results, document lines,
 * SQL rows). Two distinct uses for this set:
 *
 *   1. `chatMessagesToTurns` filters these out when reconstructing a
 *      transcript from persisted history — the rolling animation is a
 *      live-stream-only thing; replaying it on resume would look like
 *      the agent is re-doing the work.
 *
 *   2. The live reducer treats them as **causality gates**: once such a
 *      card has its result and starts its display lifecycle, any
 *      subsequent SSE action that would extend the current turn is
 *      held in the card's `pendingTail` queue until the card finishes
 *      its dismiss animation. Without this, text deltas that arrive
 *      microseconds after a `tool.result` would render UNDER a card
 *      that's still rotating items — the user sees the agent's answer
 *      while the card still looks like the agent is mid-tool-call.
 *
 * Both usages key off this single set.
 */
export const EPHEMERAL_TOOLS = new Set([
  "spawn_subagent",
  "search_loops",
  "fetch_loop",
  "list_loops",
  "entity_context",
  "search_documents",
  "fetch_document",
  // Batch retrieval tools: each renders live as N per-child ephemeral cards
  // (parts.js projects `part.children`), dropped from resumed history like the
  // singular ephemeral tools they wrap.
  "search_many",
  "fetch_many",
  "run_sql",
  "trace_connections",
  "lookup_people",
  "lookup_document_by_url",
  // The steward toolset, reachable from brief talk-back threads.
  // Ephemeral in the INTERACTIVE conversation only: dropped from resumed
  // history here, rendered live as a self-dismissing generic action card
  // (parts.js EPHEMERAL_ACTION_TOOLS). The cognition page's run transcripts
  // render through their own static path and keep every call visible.
  "open_loop_search",
  "open_loop_fetch",
  "open_loop_create",
  "open_loop_update",
  "open_loop_delete",
  "open_loop_ledger_append",
  "brief_list",
  "brief_fetch",
  "brief_create",
  "brief_update",
  "brief_delete",
  "temporal_annotation_add",
  "temporal_annotation_update",
  "temporal_annotation_delete",
  "temporal_query",
  "time_index_add",
  "time_index_update",
  "time_index_delete",
  "time_index_query",
  "notes_append",
  "notes_rewrite",
  "annotate_durable",
  // Durable memory tools used by the interactive agent. They remain in the
  // persisted model transcript, but their live UI cards are transient and
  // are omitted from normal resumed conversation history.
  "conversation_memory_evidence",
  "annotation_search",
  "annotation_revise",
  "annotation_retract",
  "annotation_supersede",
  "annotate_person",
  "person_annotation_revise",
  "person_annotation_retract",
  "person_annotation_supersede",
  "schedule_agent_run",
]);

/** Tool calls that are plumbing rather than user-facing transcript content. */
export const SILENT_TOOLS = new Set(["plan", "join_subagents"]);

/**
 * Batch retrieval tools render live as N concurrent per-child cards, but they
 * do NOT act as a causality gate the way a singular ephemeral card does. A
 * single rotating card gates the following text so it can't paint over the
 * animation; a batch fans out several cards whose lifecycles overlap, and the
 * answer streams as soon as the batch result lands — the children settle
 * alongside it. Gating a batch would also risk parking the turn forever on
 * backends that emit no per-child events (the children never mount, so no card
 * ever flushes). They stay in {@link EPHEMERAL_TOOLS} so they're still dropped
 * from resumed history; they're excluded from the gate via {@link actsAsGate}.
 */
export const BATCH_EPHEMERAL_TOOLS = new Set(["search_many", "fetch_many"]);

/**
 * Whether the turn-level "working" dots are ELIGIBLE to show: the conversation is busy AND the
 * trailing content is static, so no per-item affordance (a live thinking shimmer, a pending tool
 * spinner/card, a running sub-agent) is already signalling activity. The view debounces the actual
 * REVEAL against streamed-token cadence, so this only answers "is there a live self-animating
 * tail?", not "has the stream gone quiet?".
 *
 * Pure over `state` so it is unit-testable. Mirrors the iOS `workingIndicatorActive` and the
 * Android `AgentReducer.workingIndicatorActive`. Two portal-specific divergences: (1) a batch tool
 * (`search_many` / `fetch_many`) is NOT special-cased — the portal reconstructs its per-child cards
 * from the call's `args` on every backend (see `deriveBatchChildren` in parts.js), so a pending
 * batch always shows spinner cards rather than "nothing on screen", and it reads like any other
 * tool (`result != null` ⇒ static); (2) the portal has no separate pre-token indicator, so the dots
 * also cover the trailing-user / just-started-turn beat.
 */
export function workingIndicatorActive(state) {
  if (!state.busy) return false;
  const turns = state.turns ?? [];
  const last = turns[turns.length - 1];
  if (!last) return false;
  // Pre-token beat: the user's message is still the trailing turn (message.start not yet arrived).
  if (last.role !== "assistant") return true;
  if (last.done) return false;
  const parts = last.parts ?? [];
  const tail = parts[parts.length - 1];
  // message.start landed but no delta yet — the assistant turn renders nothing.
  if (!tail) return true;
  switch (tail.kind) {
    case "text":
    case "unknown":
      return true;
    // A live trailing thinking part paints its own shimmer + dots.
    case "thinking":
      return false;
    // Every tool renders an affordance while pending — a singular ephemeral spinner, the batch
    // pseudo-child cards derived from args, the persistent tool spinner, or a pulsing citing pill
    // for `annotate` — so a completed card (`result != null`) is the static "generating next" beat.
    case "tool":
      return tail.result != null;
    // A running sub-agent card spins; a finished one is static.
    case "subagent":
      return tail.status != null;
    default:
      return false;
  }
}

/** Whether an ephemeral tool's card gates the text that follows it. */
function actsAsGate(tool) {
  return EPHEMERAL_TOOLS.has(tool) && !BATCH_EPHEMERAL_TOOLS.has(tool);
}

/**
 * The messages a user should see for a conversation. An anchored thread
 * (brief talk-back or a watch-firing thread) opens with the creating run's
 * folded transcript — agent context, not user content — so when the
 * origin declares a seed prefix AND carries the snapshot that visually
 * replaces it (the pinned context card), the prefix is dropped. Without
 * the snapshot (threads created before snapshots existed, or an origin
 * kind this build doesn't know) everything stays visible. Mirrors
 * `AgentCoordinator.visibleMessages` on iOS.
 */
export function visibleMessages(messages, origin) {
  if (
    origin &&
    hasContextCard(origin) &&
    Number.isInteger(origin.seedMessageCount) &&
    origin.seedMessageCount > 0 &&
    origin.seedMessageCount <= messages.length
  ) {
    return messages.slice(origin.seedMessageCount);
  }
  return messages;
}

/**
 * Whether this build renders a pinned context card for the origin — the
 * precondition for hiding the seeded transcript prefix.
 */
export function hasContextCard(origin) {
  return (
    (origin?.kind === "brief" && Boolean(origin.brief)) ||
    (origin?.kind === "watch_firing" && Boolean(origin.watch))
  );
}

/** Prefix of the marker `formatTerminalErrorText` appends in `@omnesis/agent`. */
const TERMINAL_FAILURE_MARKER = "Model request failed: ";

/**
 * A turn that died on a model failure leaves a marker in its persisted text so
 * the model can see, on the next request, that the previous turn did not
 * finish. Reopening the conversation replays that history, so without this the
 * failure would come back as ordinary assistant prose with the code buried in
 * the middle of a sentence — the live stream renders the same failure as a
 * styled error, and the two views would disagree.
 *
 * The marker is authored by Omnesis (`formatTerminalErrorText` in
 * `@omnesis/agent`), not by a provider, which is what makes matching it safe.
 * Returns the text that preceded it, plus the failure lifted back out.
 */
export function splitTerminalFailureMarker(text) {
  // Anchored where `appendTerminalErrorText` puts it: alone, or after the blank
  // line separating it from whatever the turn produced first. An assistant that
  // merely quotes the phrase mid-sentence — explaining a log line, say — is
  // answering, not failing, and its answer must survive the reopen intact.
  const at = anchoredMarkerIndex(text);
  if (at < 0) return null;
  const tail = text.slice(at + TERMINAL_FAILURE_MARKER.length);
  const separator = tail.indexOf(": ");
  if (separator < 0) return null;
  const code = tail.slice(0, separator).trim();
  const message = tail.slice(separator + 2).trim();
  if (!code || !message) return null;
  return {
    body: text.slice(0, at).trim(),
    // The marker carries the code and the sentence; the provider's
    // disposition reaches only the live stream, which has the whole event.
    failure: { code, message, detail: null },
  };
}

function anchoredMarkerIndex(text) {
  if (text.startsWith(TERMINAL_FAILURE_MARKER)) return 0;
  const at = text.lastIndexOf(`\n\n${TERMINAL_FAILURE_MARKER}`);
  return at < 0 ? -1 : at + 2;
}

/**
 * Convert canonical ChatMessage[] from the gateway into the portal's
 * turn[] shape. The portal collapses one user-text message and the
 * following assistant/tool_result chain into one assistant turn so the
 * UI shows the model's tool calls inline under the answer that used
 * them. Tool_result blocks land back on the matching tool part as
 * `result`/`durationMs`.
 */
export function chatMessagesToTurns(
  messages,
  { includeEphemeralTools = false } = {},
) {
  const turns = [];
  let i = 0;
  let n = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (!m || !Array.isArray(m.parts)) {
      i++;
      continue;
    }
    if (m.role === "user") {
      const userText = m.parts.find(
        (p) => p && p.kind === "text" && typeof p.text === "string",
      );
      if (userText) {
        turns.push({
          id: `u-${n++}`,
          role: "user",
          parts: [{ kind: "text", text: userText.text }],
          done: true,
        });
      }
      i++;
      continue;
    }
    const t = {
      id: `a-${n++}`,
      role: "assistant",
      parts: [],
      done: true,
      citationCount: 0,
    };
    const toolIndexById = new Map();
    while (i < messages.length) {
      const cur = messages[i];
      if (!cur || !Array.isArray(cur.parts)) {
        i++;
        continue;
      }
      if (cur.role === "assistant") {
        for (const p of cur.parts) {
          if (!p || typeof p !== "object") continue;
          if (p.kind === "text" && typeof p.text === "string") {
            const marked = splitTerminalFailureMarker(p.text);
            if (marked) {
              if (marked.body) t.parts.push({ kind: "text", text: marked.body });
              if (marked.failure.code === "canceled") {
                // A stopped reply is an outcome, not a failure: the live view
                // ends such a turn with no error affordance, so a reopened one
                // says only that it stopped.
                t.stopReason = "canceled";
                t.stopped = marked.failure.message;
              } else {
                t.error = marked.failure.message;
                t.failure = marked.failure;
              }
            } else {
              t.parts.push({ kind: "text", text: p.text });
            }
          } else if (p.kind === "thinking") {
            // Thinking is a transient live-stream indicator (see ThinkingBlock
            // in components/agent/parts.js) — like the ephemeral tool cards
            // below, it is never rebuilt into resumed history. Drop it so
            // reopening a past conversation shows the answer alone, with no
            // reasoning blocks frozen in the transcript.
            continue;
          } else if (p.kind === "report_artifact") {
            // Legacy Deep Research transcripts carried citations only in this
            // retired presentation part. Preserve those Timeline references
            // when reopening history, but never restore the completion card.
            t.reportCitations = p.citations ?? [];
          } else if (
            p.kind === "tool_use"
            && typeof p.toolCallId === "string"
            && typeof p.tool === "string"
          ) {
            // Ephemeral tool calls (search_documents / fetch_document /
            // run_sql) are dropped from the rebuilt transcript: their
            // visual is a transient rolling-slot card meant for the
            // live stream, never for resumed history. The matching
            // tool_result is also skipped via `toolIndexById` lookup
            // missing below, so no orphan result rendering either.
            if (!includeEphemeralTools && (EPHEMERAL_TOOLS.has(p.tool) || SILENT_TOOLS.has(p.tool))) {
              continue;
            }
            // Persisted history carries the full Anthropic-format args
            // already (the turn ran to completion before persistence).
            // Mirror the post-`tool.start` shape so the renderer treats
            // it as "args resolved" and shows the finalized header
            // instead of the streaming "building query…" stub.
            t.parts.push({
              kind: "tool",
              toolCallId: p.toolCallId,
              tool: p.tool,
              args: p.args,
              argsSummary: summarizeArgs(p.tool, p.args),
              result: null,
              durationMs: null,
            });
            toolIndexById.set(p.toolCallId, t.parts.length - 1);
            // Citation tools count toward the turn's "N citations" chip:
            // `annotate`/`annotate_many` cite documents, `cite_record` cites a
            // DuckDB row (#757). `annotate_many` contributes one per child.
            if (p.tool === "annotate_many") {
              t.citationCount += Array.isArray(p.args?.annotations) ? p.args.annotations.length : 1;
            } else if (p.tool === "annotate" || p.tool === "cite_record") {
              t.citationCount++;
            }
          }
        }
        i++;
        continue;
      }
      const hasUserText = cur.parts.some(
        (p) => p && p.kind === "text" && typeof p.text === "string",
      );
      if (hasUserText) break;
      for (const p of cur.parts) {
        if (p && p.kind === "tool_result" && typeof p.toolCallId === "string") {
          const idx = toolIndexById.get(p.toolCallId);
          if (idx != null) t.parts[idx].result = p.result;
        }
      }
      i++;
    }
    turns.push(t);
  }
  return turns;
}

function historyPageHasVisibleContent(turns) {
  return turns.some(
    (turn) =>
      turn.parts.some((part) => part.kind !== "tool" || part.tool !== "plan") ||
      (turn.reportCitations?.length ?? 0) > 0,
  );
}

function historyPageSignature(messages) {
  return JSON.stringify(messages);
}

/**
 * Fold a stored Cognition Steward transcript's raw AgentEvent stream — the
 * `CognitionRunTranscript.events` array of `{ type, payload }`, verbatim — into
 * the portal's `turn[]` shape for a STATIC, read-only render (the Cognition
 * debug transcript's Formatted view).
 *
 * Deliberately NOT the live `reducer`: a settled transcript is replayed all at
 * once, so this fold has no session gating, no ephemeral causality gate (which
 * would park the tail behind a rolling card that never dismisses in a static
 * render), and no animation timers. It only reshapes the event log.
 *
 * Part kinds produced: `text`, `thinking`, `tool` (name + args summary +
 * result), and `unknown` — a compact one-liner carrying the raw event type,
 * emitted for ANY event this fold doesn't model (a citation/subagent/error
 * event from a richer agent, or a future type). That is the graceful-degrade
 * contract: an unrecognised event becomes a labelled line, never a blank.
 */
export function transcriptEventsToTurns(events) {
  const turns = [];
  let n = 0;
  const lastAssistant = () => {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === "assistant") return turns[i];
    }
    return null;
  };
  // The assistant turn content attaches to, opening a fresh one when the last
  // is absent or already ended (some backends emit content without a leading
  // `agent.message.start`, and a new round starts after `message.end`).
  const ensureAssistant = () => {
    const turn = lastAssistant();
    if (turn && !turn.done) return turn;
    const fresh = { id: `a-${n++}`, role: "assistant", parts: [], done: false };
    turns.push(fresh);
    return fresh;
  };
  const findToolPart = (toolCallId) => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const parts = turns[i].parts;
      for (let j = parts.length - 1; j >= 0; j--) {
        if (parts[j].kind === "tool" && parts[j].toolCallId === toolCallId) return parts[j];
      }
    }
    return null;
  };
  const pushUnknown = (type, payload) => {
    ensureAssistant().parts.push({ kind: "unknown", type: type ?? "(unknown)", payload });
  };
  for (const ev of events ?? []) {
    const type = ev?.type;
    const payload = ev?.payload ?? {};
    switch (type) {
      case "agent.message.start": {
        // Open the round's assistant turn. Idempotent on a duplicated start
        // (resume / retry) so we never double a bubble.
        const id = payload.messageId ?? `a-${n++}`;
        if (!turns.some((t) => t.id === id)) {
          turns.push({ id, role: "assistant", parts: [], done: false });
        }
        break;
      }
      case "agent.user.message": {
        // The interactive agent's user bubble. A steward transcript carries
        // none, but handle it so a reused stream still reads turn-by-turn.
        turns.push({
          id: payload.userMessageId ?? `u-${n++}`,
          role: "user",
          parts: [{ kind: "text", text: payload.text ?? "" }],
          done: true,
        });
        break;
      }
      case "agent.text.delta": {
        const turn = ensureAssistant();
        const last = turn.parts[turn.parts.length - 1];
        if (last && last.kind === "text") last.text += payload.delta ?? "";
        else turn.parts.push({ kind: "text", text: payload.delta ?? "" });
        break;
      }
      case "agent.thinking.delta": {
        const turn = ensureAssistant();
        const last = turn.parts[turn.parts.length - 1];
        if (last && last.kind === "thinking") last.text += payload.delta ?? "";
        else turn.parts.push({ kind: "thinking", text: payload.delta ?? "" });
        break;
      }
      case "agent.tool.input_start": {
        const turn = ensureAssistant();
        if (turn.parts.some((p) => p.kind === "tool" && p.toolCallId === payload.toolCallId)) break;
        turn.parts.push({
          kind: "tool",
          toolCallId: payload.toolCallId,
          tool: payload.tool,
          args: null,
          argsSummary: "",
          result: null,
          durationMs: null,
        });
        break;
      }
      case "agent.tool.start": {
        const turn = ensureAssistant();
        // The wire event carries `intent`, not `argsSummary`; derive a summary
        // from the args the same way the live reducer does.
        const summary = payload.argsSummary || summarizeArgs(payload.tool, payload.args);
        const existing = turn.parts.find(
          (p) => p.kind === "tool" && p.toolCallId === payload.toolCallId,
        );
        if (existing) {
          existing.tool = payload.tool;
          existing.args = payload.args;
          existing.argsSummary = summary;
        } else {
          turn.parts.push({
            kind: "tool",
            toolCallId: payload.toolCallId,
            tool: payload.tool,
            args: payload.args,
            argsSummary: summary,
            result: null,
            durationMs: null,
          });
        }
        break;
      }
      case "agent.tool.result": {
        const part = findToolPart(payload.toolCallId);
        if (part) {
          part.result = payload.result;
          part.durationMs = payload.durationMs ?? null;
        } else {
          // A result with no matching call (truncated / out-of-order log) still
          // gets a visible line rather than vanishing.
          pushUnknown(type, payload);
        }
        break;
      }
      // Live per-child progress for a batch tool (search_many / fetch_many).
      // Attach the child onto its parent part's `children` array, keyed by
      // index; parts.js projects one live ephemeral card per child. Order is by
      // index, not arrival, so out-of-order completion still renders correctly.
      case "agent.tool.child.start": {
        const part = findToolPart(payload.toolCallId);
        if (part) {
          if (!Array.isArray(part.children)) part.children = [];
          const existing = part.children.find((c) => c.index === payload.childIndex);
          if (existing) {
            existing.tool = payload.tool;
            existing.argsSummary = payload.argsSummary ?? existing.argsSummary ?? "";
          } else {
            part.children.push({
              index: payload.childIndex,
              tool: payload.tool,
              argsSummary: payload.argsSummary ?? "",
              result: null,
            });
          }
          part.children.sort((a, b) => a.index - b.index);
        }
        break;
      }
      case "agent.tool.child.result": {
        const part = findToolPart(payload.toolCallId);
        if (part) {
          if (!Array.isArray(part.children)) part.children = [];
          const child = part.children.find((c) => c.index === payload.childIndex);
          if (child) {
            child.result = payload.result;
          } else {
            part.children.push({
              index: payload.childIndex,
              tool: null,
              argsSummary: "",
              result: payload.result,
            });
            part.children.sort((a, b) => a.index - b.index);
          }
        }
        break;
      }
      case "agent.message.end": {
        const turn = lastAssistant();
        if (turn) {
          turn.done = true;
          // Without this a stored run that died on a model failure replays as a
          // transcript that simply stops, with no statement anywhere that it
          // failed or why.
          if (payload.failure) {
            turn.error = payload.failure.message || payload.failure.code || "The turn failed.";
            turn.failure = turnFailure(payload.failure);
          }
        }
        break;
      }
      case "agent.error": {
        const turn = lastAssistant();
        if (turn) {
          turn.error = payload.message || payload.code || "The turn failed.";
          turn.failure = turnFailure(payload);
        }
        break;
      }
      default:
        pushUnknown(type, payload);
        break;
    }
  }
  return turns;
}

/**
 * Walk a `ChatMessage[]` history and reconstruct the citations panel:
 * one entry per (assistant `annotate` tool_use + matching user
 * `annotate.recorded` tool_result) pair. Returns an array of Citation
 * objects shaped like `{ documentId, ref, entries: [{quote?, note?,
 *   toolCallId, messageId}] }`.
 *
 * Persisted history doesn't preserve the original message ids the
 * citation was made under, so each entry's `messageId` is the
 * synthetic `a-N` slot the same way `chatMessagesToTurns` produces
 * them. The panel doesn't care about exact ids — only about which
 * assistant turn a citation belongs to.
 */
/**
 * The `annotate.recorded` items in a tool result: one for a singular annotate,
 * N (in order) for an `annotate.batch` (annotate_many), none otherwise. Lets
 * the reload rebuilders fan a batch out to one citation per child — matching
 * the live path so live and reloaded Timeline state are identical.
 */
function annotateRecordedItems(result) {
  if (result?.kind === "annotate.recorded") return [result];
  if (result?.kind === "annotate.batch" && Array.isArray(result.items)) {
    return result.items.filter((it) => it?.kind === "annotate.recorded");
  }
  return [];
}

export function citationsFromMessages(messages) {
  const byDoc = new Map();
  // Track which assistant-turn slot we're inside so each annotation
  // entry can attribute itself to that turn — mirrors the synthetic
  // ids used by `chatMessagesToTurns` (i.e. `a-<n>`).
  let n = 0;
  let assistantSlot = null;
  // toolCallId → messageId of the assistant turn it was issued from.
  const pendingAnnotates = new Map();
  for (const m of messages) {
    if (m.role === "user") {
      const hasText = m.parts.some((p) => p.kind === "text");
      for (const p of m.parts) {
        if (p.kind !== "tool_result") continue;
        const messageId = pendingAnnotates.get(p.toolCallId);
        if (messageId === undefined) continue;
        const recs = annotateRecordedItems(p.result);
        recs.forEach((rec, idx) => {
          if (typeof rec.documentId !== "string" || !rec.ref) return;
          const docId = rec.documentId;
          let cit = byDoc.get(docId);
          if (!cit) {
            cit = { documentId: docId, ref: rec.ref, entries: [] };
            byDoc.set(docId, cit);
          }
          // Stable per-child id so a batch's children stay distinct entries and
          // match the live `agent.citation` events.
          const childCallId = recs.length > 1 ? `${p.toolCallId}#${idx}` : p.toolCallId;
          // Routing: note-only (no quote) is doc-level — promotes to the card
          // header, doesn't create a quote entry. Quote (with or without note)
          // appends as a real entry.
          if (rec.quote === undefined && rec.note !== undefined) {
            cit.docNote = rec.note;
          } else {
            cit.entries.push({
              toolCallId: childCallId,
              messageId,
              quote: rec.quote,
              quoteAuthor: rec.quoteAuthor,
              quoteIsSelf: rec.quoteIsSelf,
              note: rec.note,
            });
          }
        });
        pendingAnnotates.delete(p.toolCallId);
      }
      if (hasText) {
        n++;
        assistantSlot = null;
      }
    } else if (m.role === "assistant") {
      if (assistantSlot === null) {
        assistantSlot = `a-${n}`;
      }
      for (const p of m.parts) {
        if (p.kind === "tool_use" && (p.tool === "annotate" || p.tool === "annotate_many")) {
          pendingAnnotates.set(p.toolCallId, assistantSlot);
        }
      }
    }
  }
  return [...byDoc.values()];
}


/**
 * Walk a `ChatMessage[]` history and build the annotation buckets the
 * unified Timeline view projects onto event/doc rows.
 *
 *   byDoc: { [docId]: { ref?, note?, quotes: [...] } }
 *
 * The `ref` field on each `byDoc` slot is set on the first
 * `annotate.recorded` for that documentId — `buildUnifiedTimeline`
 * reads it to synthesise a Timeline row for every annotated document.
 *
 * Routing: quote (with or without note) appends to `quotes[]`;
 * note-only sets the slot's `note` (last-write wins).
 */
export function trailAnnotationsFromMessages(messages) {
  const byDoc = {};
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const p of m.parts) {
      if (p.kind !== "tool_result") continue;
      for (const rec of annotateRecordedItems(p.result)) {
        if (typeof rec.documentId !== "string") continue;
        byDoc[rec.documentId] = bumpDocSlot(
          byDoc[rec.documentId],
          rec.ref,
          rec.quote,
          rec.quoteAuthor,
          rec.note,
          rec.quoteIsSelf,
        );
      }
    }
  }
  return { byDoc };
}

/**
 * Map a `cite_record.recorded` tool result (#757) to a record-only timeline
 * event — the same shape `event_trail.built` emits for a bound row, so the
 * renderer treats a directly-cited record and a trail-surfaced record
 * identically. Returns null for a malformed result (no recordKey / no semantic
 * time — a timeless row is never citable as a record). Every displayed field is
 * already gateway-derived; this never branches on a source.
 */
function citeRecordToEvent(r) {
  if (!r || typeof r.recordKey !== "string" || typeof r.semanticTime !== "string") return null;
  if (!r.recordKey || !r.semanticTime) return null;
  return {
    eventId: `cite:${r.recordKey}`,
    at: r.semanticTime,
    kind: "record",
    record: {
      recordKey: r.recordKey,
      table: r.table,
      tableDisplayName: r.tableDisplayName,
      title: r.title,
      keyFields: r.keyFields ?? [],
      semanticTime: r.semanticTime,
      sourceId: r.sourceId,
      sourceType: r.sourceType,
      boundDocumentId: r.boundDocumentId ?? null,
      snapshot: r.snapshot ?? {},
    },
    attachments: [],
    people: [],
    related: [],
  };
}

/**
 * Walk a `ChatMessage[]` history and build the record-citation timeline events
 * from every `cite_record.recorded` tool result (#757), deduped by `recordKey`
 * (last cite of a row wins). Mirrors `trailAnnotationsFromMessages` for the
 * resume path so the Timeline renders directly-cited records the same way
 * live and on reload.
 */
export function recordCitationsFromMessages(messages) {
  const byKey = new Map();
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const p of m.parts) {
      if (p.kind !== "tool_result") continue;
      const r = p.result;
      if (r?.kind !== "cite_record.recorded") continue;
      const event = citeRecordToEvent(r);
      if (event) byKey.set(event.record.recordKey, event);
    }
  }
  return [...byKey.values()];
}

// Quote (with or without note) appends to `quotes[]`; note-only sets the
// slot's `note` (last-write wins). `ref` is captured on first set so
// `buildUnifiedTimeline` can synthesise a Timeline row for the annotated
// document. Shared between the live reducer's `annotate.recorded` arm and
// `trailAnnotationsFromMessages` (the resume path).
function bumpDocSlot(prev, ref, quote, quoteAuthor, note, quoteIsSelf) {
  const slot = prev ? { ...prev, quotes: [...prev.quotes] } : { quotes: [] };
  if (ref && !slot.ref) slot.ref = ref;
  if (quote !== undefined) {
    slot.quotes.push({ quote, quoteAuthor, note, quoteIsSelf });
  } else if (note !== undefined) {
    slot.note = note;
  }
  return slot;
}

/**
 * Compute the unified Timeline event list from the agent's deliberate
 * citations: the doc-level annotation bucket (`byDoc`, from `annotate`)
 * plus the directly-cited analytics rows (`records`, from `cite_record`,
 * #757). Nothing else feeds the Timeline — a `trace_connections` graph
 * walk's raw output never lands here.
 *
 * Algorithm:
 *
 *   1. For each cited record, emit one record-only event keyed by
 *      `record.recordKey` (first occurrence of a key wins; the feeders
 *      already dedupe before calling in).
 *   2. For each documentId in `byDoc` carrying a `ref`, synthesise a bare
 *      `TrailEvent`:
 *        eventId   = "synth:doc:" + documentId
 *        at        = ref.ts → ISO 8601 (or null)
 *        kind      = "document"
 *        doc       = mapped from the byDoc slot's `ref`
 *        people / attachments / related = []
 *      A slot with no `ref` is skipped.
 *   3. Merge-sort by `at` ascending — record citations interleave with
 *      document citations by their semantic time; events with null `at`
 *      go to the bottom in deterministic id order.
 *
 * The view treats synthesised document rows and record rows identically
 * for layout — the renderer (timeline.js) switches on the presence of
 * `event.doc` to pick the body.
 */
export function buildUnifiedTimeline(byDoc, records) {
  const eventByKey = new Map();
  // Directly-cited analytics rows (`cite_record`, #757): one record-only event
  // each, deduped by recordKey.
  for (const event of records ?? []) {
    const recordKey = event?.record?.recordKey;
    if (!recordKey || eventByKey.has(recordKey)) continue;
    eventByKey.set(recordKey, event);
  }
  // Annotated documents (`annotate`): one synthesised doc row per annotated
  // documentId. This is the ONLY way a document reaches the Timeline — a
  // `trace_connections` graph walk's raw output never does; the agent must
  // deliberately cite what its answer rests on.
  if (byDoc) {
    for (const documentId of Object.keys(byDoc)) {
      const slot = byDoc[documentId];
      if (!slot?.ref) continue;
      eventByKey.set(documentId, synthesisedTrailEvent(documentId, slot.ref));
    }
  }
  return [...eventByKey.values()].sort(compareTrailEventsByAt);
}

function synthesisedTrailEvent(documentId, ref) {
  // `at` on TrailEvent is an ISO 8601 string | null. DocRef.ts is epoch
  // milliseconds, so convert; the wire schemas differ deliberately
  // (search results carry the numeric, trails carry the human-readable).
  const at =
    typeof ref.ts === "number" && Number.isFinite(ref.ts)
      ? new Date(ref.ts).toISOString()
      : null;
  return {
    eventId: `synth:doc:${documentId}`,
    at,
    kind: "document",
    doc: {
      documentId,
      title: ref.title ?? "",
      sourceId: ref.sourceId,
      sourceUrl: ref.url,
      documentType: ref.documentType,
      mimeType: ref.mimeType,
    },
    attachments: [],
    people: [],
    related: [],
  };
}

function compareTrailEventsByAt(a, b) {
  const aMissing = !a.at;
  const bMissing = !b.at;
  if (aMissing && bMissing) {
    // Records (#757) have no `doc`; fall back to the stable record key so
    // undated record-only events still order deterministically.
    const aId = a.doc?.documentId ?? a.record?.recordKey ?? "";
    const bId = b.doc?.documentId ?? b.record?.recordKey ?? "";
    return aId.localeCompare(bId);
  }
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (a.at === b.at) return 0;
  return a.at < b.at ? -1 : 1;
}

export function summarizeArgs(tool, args) {
  if (!args || typeof args !== "object") return "";
  if (tool === "search_documents" && typeof args.query === "string") {
    const tail = [];
    if (args.limit) tail.push(`limit=${args.limit}`);
    return tail.length > 0 ? `${args.query} (${tail.join(", ")})` : args.query;
  }
  if (tool === "fetch_document" && typeof args.documentId === "string") {
    return args.documentId.slice(0, 24);
  }
  if (tool === "run_sql" && typeof args.sql === "string") {
    return args.sql.slice(0, 80);
  }
  if (tool === "lookup_people" && typeof args.query === "string") {
    return args.query.slice(0, 80);
  }
  if (tool === "search_loops" && typeof args.query === "string") {
    return args.query.slice(0, 80);
  }
  if (tool === "fetch_loop" && typeof args.loopId === "string") {
    return args.loopId.slice(0, 24);
  }
  if (tool === "lookup_document_by_url" && typeof args.url === "string") {
    // URL chips read better truncated mid-path than at the start —
    // the host carries the source identity ("docs.google.com" /
    // "notion.so") which is the cheapest legibility win.
    return args.url.length > 80 ? args.url.slice(0, 77) + "…" : args.url;
  }
  if (tool === "annotate" && typeof args.documentId === "string") {
    const head = args.documentId.slice(0, 24);
    const text = (typeof args.quote === "string" ? args.quote
      : typeof args.note === "string" ? args.note
      : "");
    return text ? `${head}: "${text.slice(0, 40)}"` : head;
  }
  try {
    return JSON.stringify(args).slice(0, 120);
  } catch {
    return "";
  }
}

function mutateLastAssistant(state, fn) {
  if (state.turns.length === 0) return state;
  const turns = [...state.turns];
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "assistant") {
      const next = { ...turns[i], parts: [...turns[i].parts] };
      fn(next);
      turns[i] = next;
      return { ...state, turns };
    }
  }
  return state;
}

/**
 * The three layers of a failed turn, kept apart so the bubble can show the
 * sentence prominently and the machine-readable half quietly beneath it — and
 * so the provider's disposition has somewhere to go that is not the sentence.
 */
function turnFailure(payload) {
  return {
    code: payload.code ?? null,
    message: payload.message ?? "",
    detail: providerDetailLine(payload.provider),
  };
}

/** `HTTP 404 · NOT_FOUND · param=model` from the provider's own envelope. */
export function providerDetailLine(provider) {
  if (!provider || typeof provider !== "object") return null;
  const parts = [];
  if (typeof provider.status === "number") parts.push(`HTTP ${provider.status}`);
  if (provider.code) parts.push(provider.code);
  else if (provider.type) parts.push(provider.type);
  if (provider.param) parts.push(`param=${provider.param}`);
  if (provider.requestId) parts.push(`request ${provider.requestId}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function attachAgentError(state, payload) {
  if (payload.sessionId && payload.sessionId !== state.sessionId) return state;
  const failure = turnFailure(payload);
  const error = failure.message || failure.code || "The turn failed.";
  const turns = [...state.turns];
  let idx = -1;
  if (payload.messageId) {
    idx = turns.findIndex((t) => t.role === "assistant" && t.id === payload.messageId);
  }
  if (idx < 0 && turns.at(-1)?.role === "assistant") {
    idx = turns.length - 1;
  }
  if (idx >= 0) {
    turns[idx] = { ...turns[idx], error, failure, done: true };
  } else {
    turns.push({
      id: payload.messageId || `error-${turns.length}`,
      role: "assistant",
      parts: [],
      error,
      failure,
      done: true,
      citationCount: 0,
    });
  }
  return { ...state, turns, busy: false, deepResearch: false };
}

// ─── Sub-agent card (#748) ───────────────────────────────────────────────
//
// A sub-agent is a nested AgentSession the parent spawns via `spawn_subagent`.
// Its lifecycle reaches the portal through three events, defined once in
// `agent-protocol.ts`:
//
//   agent.subagent.spawned → push a `subagent` part onto the current
//        assistant turn (a compact live progress row).
//   agent.subagent.event   → the child's own AgentEvent, wrapped. We feed
//        it through `reduceChildEvent` to update token usage and reached
//        documents as the child works. `childTurns` is bounded scratch state
//        for pending tool-call identity; child prose is not retained.
//   agent.subagent.result  → finalise the card (status, summary, token
//        total). Citations merge into the parent's single set elsewhere; the
//        card carries no per-citation attribution.
//
// Unknown wrapped child events are ignored without throwing.

/** Build the empty card state a `subagent` transcript part carries. */
function emptySubagentCard(payload) {
  return {
    kind: "subagent",
    subagentId: payload.subagentId,
    specialist: payload.specialist,
    title: payload.title,
    task: payload.task,
    parentToolCallId: payload.parentToolCallId,
    // Bounded scratch state used to associate results with pending tool calls.
    // The compact UI does not render child transcript content.
    childTurns: [],
    // Documents this researcher has reached so far, accumulated LIVE from
    // its child tool results (search hits, trail walks, opened docs) and
    // deduped by documentId. Each is a minimal source-tintable DocRef
    // (`{ documentId, title, sourceId }`) — the working-set surface paints
    // one source-tinted badge per source as the run proceeds.
    docs: [],
    // `tokens` is the rendered total; the private accounting fields prevent a
    // cumulative live usage update from being counted again at message.end.
    stepCount: 0,
    tokens: 0,
    completedUsageByMessage: {},
    liveUsageByMessage: {},
    // Finalised by `agent.subagent.result`. `status` null while in flight.
    status: null,
    summary: null,
    retainedCitationCount: 0,
    failureCode: null,
    failureProvider: null,
  };
}

/** Sum the token fields on an AgentUsage-shaped object (any may be absent). */
function sumUsageTokens(usage) {
  if (!usage || typeof usage !== "object") return 0;
  return (
    (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheCreationTokens ?? 0)
  );
}

/** True when an AgentUsage object reports at least one token field. */
function hasAnyUsageToken(usage) {
  if (!usage || typeof usage !== "object") return false;
  return (
    usage.inputTokens != null ||
    usage.outputTokens != null ||
    usage.cacheReadTokens != null ||
    usage.cacheCreationTokens != null
  );
}

function withChildUsage(card, messageId, usage, terminal = false) {
  const liveUsageByMessage = { ...(card.liveUsageByMessage ?? {}) };
  const completedUsageByMessage = { ...(card.completedUsageByMessage ?? {}) };
  if (terminal && completedUsageByMessage[messageId]) return card;
  const snapshot = mergeUsage(liveUsageByMessage[messageId], usage);
  if (terminal) {
    delete liveUsageByMessage[messageId];
    completedUsageByMessage[messageId] = snapshot;
  } else {
    liveUsageByMessage[messageId] = snapshot;
  }
  const total = (entries) => Object.values(entries).reduce((sum, value) => sum + sumUsageTokens(value), 0);
  return { ...card, completedUsageByMessage, liveUsageByMessage, tokens: total(completedUsageByMessage) + total(liveUsageByMessage) };
}

function mergeUsage(previous, next) {
  return {
    ...(previous ?? {}),
    ...Object.fromEntries(Object.entries(next ?? {}).filter(([, value]) => value != null)),
  };
}

/**
 * Pull the document references out of one child tool result so the
 * working-set surface can show this researcher's documents accumulating
 * live. Generic over tool kind — reads the same `{ documentId, title,
 * sourceId }` shape the ephemeral cards already extract, with NO branching
 * on a specific source (source identity is carried on the DocRef and
 * resolved through the registry by the view). Returns a (possibly empty)
 * array; unknown result kinds yield none (graceful degrade).
 */
function docsFromChildToolResult(result) {
  if (!result || typeof result !== "object") return [];
  const out = [];
  const push = (ref) => {
    if (ref && ref.documentId && ref.sourceId) {
      out.push({ documentId: ref.documentId, title: ref.title, sourceId: ref.sourceId });
    }
  };
  switch (result.kind) {
    case "search.results":
      for (const ref of result.results ?? []) push(ref);
      break;
    case "document":
      push(result.ref);
      break;
    case "search.batch":
    case "document.batch":
      for (const item of result.items ?? []) out.push(...docsFromChildToolResult(item));
      break;
    case "event_trail.built":
      // Top-level events plus their attachments — the same flatten the
      // trail card uses, so a researcher's trail walk contributes its docs.
      for (const ev of result.events ?? []) {
        push(ev?.doc);
        for (const att of ev?.attachments ?? []) push(att?.doc);
      }
      break;
    default:
      break;
  }
  return out;
}

/**
 * Append new docs to a card's `docs` list, deduped by documentId, returning
 * a NEW array (or the same reference when nothing new arrives, so the card
 * identity only changes on a real update).
 */
function mergeCardDocs(existing, incoming) {
  if (incoming.length === 0) return existing;
  const seen = new Set(existing.map((d) => d.documentId));
  const added = [];
  for (const d of incoming) {
    if (seen.has(d.documentId)) continue;
    seen.add(d.documentId);
    added.push(d);
  }
  return added.length === 0 ? existing : [...existing, ...added];
}

/**
 * Fold one wrapped child `AgentEvent` into a sub-agent card's live accounting,
 * returning a NEW card (never mutates `card`). Bounded scratch state associates
 * results with pending tool calls; child prose and completed result payloads
 * are not retained. Unknown event kinds are ignored.
 */
export function reduceChildEvent(card, childEvent) {
  if (!childEvent || typeof childEvent.type !== "string") return card;
  const type = childEvent.type;
  const payload = childEvent.payload ?? {};
  // These deltas are not rendered. Avoid cloning an invisible transcript for
  // every token of a long-running child response.
  if (type === "agent.text.delta" || type === "agent.thinking.delta") return card;
  const needsToolScratch =
    type === "agent.message.start" ||
    type === "agent.tool.input_start" ||
    type === "agent.tool.start" ||
    type === "agent.tool.result" ||
    type === "agent.message.end";
  const turns = needsToolScratch
    ? card.childTurns.map((t) => ({ ...t, parts: [...t.parts] }))
    : card.childTurns;
  const lastAssistant = () => {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === "assistant") return turns[i];
    }
    return null;
  };
  switch (type) {
    case "agent.message.start": {
      if (turns.at(-1)?.id === payload.messageId) return card;
      turns.splice(0, turns.length, {
        id: payload.messageId,
        role: "assistant",
        parts: [],
        done: false,
      });
      return { ...card, childTurns: turns };
    }
    case "agent.tool.input_start": {
      if (payload.tool === "plan") return card;
      const turn = lastAssistant();
      if (!turn) return card;
      if (turn.parts.some((p) => p.kind === "tool" && p.toolCallId === payload.toolCallId)) {
        return card;
      }
      turn.parts.push({
        kind: "tool",
        toolCallId: payload.toolCallId,
        tool: payload.tool,
        args: null,
        argsSummary: "",
        result: null,
        durationMs: null,
      });
      // A new child tool call is one "step" of the sub-agent's work.
      return { ...card, childTurns: turns, stepCount: card.stepCount + 1 };
    }
    case "agent.tool.start": {
      if (payload.tool === "plan") return card;
      const turn = lastAssistant();
      if (!turn) return card;
      const summary = payload.argsSummary || summarizeArgs(payload.tool, payload.args);
      for (let i = turn.parts.length - 1; i >= 0; i--) {
        const p = turn.parts[i];
        if (p.kind === "tool" && p.toolCallId === payload.toolCallId) {
          turn.parts[i] = { ...p, tool: payload.tool, args: payload.args, argsSummary: summary };
          return { ...card, childTurns: turns };
        }
      }
      // No prior input_start (replay / non-Anthropic backends skip it): this
      // is the step boundary, so count it here instead.
      turn.parts.push({
        kind: "tool",
        toolCallId: payload.toolCallId,
        tool: payload.tool,
        args: payload.args,
        argsSummary: summary,
        result: null,
        durationMs: null,
      });
      return { ...card, childTurns: turns, stepCount: card.stepCount + 1 };
    }
    case "agent.tool.result": {
      // Accrue any documents this result surfaced onto the card's live
      // working set FIRST — independent of whether a matching transcript
      // part exists (replay / out-of-order delivery still feeds the surface).
      const docs = mergeCardDocs(card.docs ?? [], docsFromChildToolResult(payload.result));
      const turn = lastAssistant();
      if (turn) {
        for (let i = turn.parts.length - 1; i >= 0; i--) {
          const p = turn.parts[i];
          if (p.kind === "tool" && p.toolCallId === payload.toolCallId) {
            // Its document refs are already folded into `docs`; discard the
            // completed call instead of retaining a potentially large result.
            turn.parts.splice(i, 1);
            return { ...card, childTurns: turns, docs };
          }
        }
      }
      return docs === (card.docs ?? []) ? card : { ...card, docs };
    }
    case "agent.tool.child.result": {
      // Batch tools stream each singular child result as it settles. These
      // results are the earliest source-bearing events for search_many and
      // fetch_many, so fold them into the card even though the compact card
      // does not render the batch's nested tool transcript.
      const docs = mergeCardDocs(card.docs ?? [], docsFromChildToolResult(payload.result));
      return docs === (card.docs ?? []) ? card : { ...card, docs };
    }
    case "agent.message.end": {
      return { ...withChildUsage(card, payload.messageId, payload.usage, true), childTurns: [] };
    }
    case "agent.usage.update":
      // Providers report a cumulative in-flight total. It is advisory — the
      // terminal sub-agent result remains authoritative — but makes a live
      // researcher row visibly progress before its request completes.
      return withChildUsage(card, payload.messageId, payload.usage);
    default:
      // Unknown / unhandled child event — degrade gracefully.
      return card;
  }
}

/**
 * Locate the `subagent` card with `subagentId` across all turns and replace
 * it with `fn(card)`. Returns a NEW state (turns + the holding turn cloned)
 * or the original state if no such card exists.
 */
function mutateSubagentCard(state, subagentId, fn) {
  const turns = [...state.turns];
  for (let ti = turns.length - 1; ti >= 0; ti--) {
    const turn = turns[ti];
    if (turn.role !== "assistant") continue;
    for (let pi = turn.parts.length - 1; pi >= 0; pi--) {
      const part = turn.parts[pi];
      if (part.kind === "subagent" && part.subagentId === subagentId) {
        const parts = [...turn.parts];
        parts[pi] = fn(part);
        turns[ti] = { ...turn, parts };
        return { ...state, turns };
      }
    }
  }
  return state;
}

// ─── Research working-set surface selectors (#748) ───────────────────────
//
// The bespoke multi-panel research working-set surface is driven entirely
// off reducer state — no side channel. `researchPanels` projects the
// sub-agent cards on the latest assistant turn into one panel descriptor per
// researcher; `isResearchWorkspaceActive` gates the surface to a live Deep
// Research run that has at least one researcher. The view renders the
// surface only while active and lets it collapse into the report (the
// finished assistant turn) when the run ends.

/**
 * Collect the sub-agent cards on the most-recent assistant turn as panel
 * descriptors for the working-set surface, in spawn order. Returns `[]`
 * when there is no assistant turn or it carries no sub-agent cards.
 */
export function researchPanels(state) {
  for (let i = state.turns.length - 1; i >= 0; i--) {
    const turn = state.turns[i];
    if (turn.role !== "assistant") continue;
    const panels = turn.parts.filter((p) => p.kind === "subagent");
    return panels.map((card) => ({
      subagentId: card.subagentId,
      specialist: card.specialist,
      title: card.title,
      task: card.task,
      docs: card.docs ?? [],
      stepCount: card.stepCount ?? 0,
      tokens: card.tokens ?? 0,
      status: card.status,
      summary: card.summary,
    }));
  }
  return [];
}

/**
 * True when the bespoke research working-set surface should be on screen:
 * a Deep Research run is in flight AND at least one researcher panel exists.
 * Once `deepResearch` clears (run ended) the surface collapses even though
 * the finished cards still live on the transcript.
 */
export function isResearchWorkspaceActive(state) {
  return state.deepResearch === true && researchPanels(state).length > 0;
}

// ─── Ephemeral causality gate ────────────────────────────────────────────
//
// The active gate is the last ephemeral tool part in the current
// assistant turn that has a result AND has not yet had its tail
// flushed (i.e. the card is mid-dismiss-lifecycle). Any SSE action
// arriving while a gate is active gets parked on the gate's
// `pendingTail` queue and applied verbatim once the card emits
// `ephemeral-tail-flush`. The queue is opaque to the reducer — we
// store the original action and replay it through the reducer on
// flush, which lets the replayed actions naturally activate any
// downstream gates of their own (e.g. a second ephemeral tool call
// that landed entirely within the first card's display window).

/**
 * Set of action kinds that, when they fire while a gate is active,
 * must be buffered. Everything else (turn-level state, sidebar,
 * end-of-turn) bypasses the gate.
 */
const TURN_APPEND_ACTIONS = new Set([
  "agent.text.delta",
  "agent.thinking.delta",
  "agent.tool.input_start",
  "agent.tool.start",
  "agent.tool.result",
]);

/**
 * Return the index of the active gate inside `turn.parts`, or `-1`.
 * Walks from the tail of the turn: the LATEST undismissed ephemeral
 * tool with a result wins. Earlier undismissed ephemeral tools never
 * coexist in `parts[]` by construction — the gate rule queues new
 * ephemeral tools behind the current one, so only one is ever live.
 */
function findActiveGateIndex(turn) {
  if (!turn || turn.role !== "assistant") return -1;
  for (let i = turn.parts.length - 1; i >= 0; i--) {
    const p = turn.parts[i];
    if (p.kind !== "tool") continue;
    if (!actsAsGate(p.tool)) continue;
    if (p.result && !p.tailDismissed) return i;
    // First ephemeral tool from the tail is either already dismissed
    // or has no result yet — neither is a gate, and any earlier
    // ephemeral tool is bounded by the same rule. Stop here.
    return -1;
  }
  return -1;
}

/** Enqueue `action` onto the gate's tail and return the new state. */
function enqueueOnGate(state, action) {
  return mutateLastAssistant(state, (turn) => {
    const gateIdx = findActiveGateIndex(turn);
    if (gateIdx < 0) return; // race-safety; caller already checked
    const gate = turn.parts[gateIdx];
    turn.parts[gateIdx] = {
      ...gate,
      pendingTail: [...(gate.pendingTail || []), action],
    };
  });
}

/**
 * Drain the gate identified by `toolCallId`: mark it dismissed and
 * replay its queue through the reducer in order. Each replay sees the
 * state with the gate already dismissed, so the gate check rejects
 * itself and lets the queued actions land. A queued action that is
 * itself an ephemeral `tool.result` will activate a NEW gate on its
 * way through, naturally absorbing any further queued actions ordered
 * after it.
 */
function drainGate(state, toolCallId) {
  // Locate the gate in the latest assistant turn. If it's not there
  // (already drained, or this is a stale flush from a torn-down card),
  // return state unchanged.
  let queue = null;
  let next = mutateLastAssistant(state, (turn) => {
    for (let i = turn.parts.length - 1; i >= 0; i--) {
      const p = turn.parts[i];
      if (p.kind !== "tool" || p.toolCallId !== toolCallId) continue;
      if (p.tailDismissed) return; // double-flush guard
      queue = p.pendingTail || [];
      turn.parts[i] = { ...p, pendingTail: [], tailDismissed: true };
      return;
    }
  });
  if (queue == null) return next;
  for (const queued of queue) {
    next = reducer(next, queued);
  }
  return next;
}

/** Drain every active ephemeral gate, including gates revealed by a queued tail. */
function forceDrainGates(state) {
  let next = state;
  while (true) {
    const turn = [...next.turns].reverse().find((candidate) => candidate.role === "assistant");
    const gateIdx = findActiveGateIndex(turn);
    if (gateIdx < 0) return next;
    const toolCallId = turn.parts[gateIdx].toolCallId;
    const drained = drainGate(next, toolCallId);
    if (drained === next) return next;
    next = drained;
  }
}

/** Remove one transient tool control without disturbing adjacent progress cards. */
function removeToolPart(state, toolCallId) {
  if (!toolCallId) return state;
  for (let turnIdx = state.turns.length - 1; turnIdx >= 0; turnIdx--) {
    const turn = state.turns[turnIdx];
    if (turn.role !== "assistant") continue;
    const parts = turn.parts.filter(
      (part) => part.kind !== "tool" || part.toolCallId !== toolCallId,
    );
    if (parts.length === turn.parts.length) continue;
    const turns = [...state.turns];
    turns[turnIdx] = { ...turn, parts };
    return { ...state, turns };
  }
  return state;
}

/** Final safety net: orchestration controls never survive a completed turn. */
function purgeOrchestrationTools(state) {
  return mutateLastAssistant(state, (turn) => {
    turn.parts = turn.parts.filter(
      (part) =>
        part.kind !== "tool" ||
        (part.tool !== "spawn_subagent" && part.tool !== "join_subagents"),
    );
  });
}

export function reducer(state, action) {
  // Causality gate. If the last live ephemeral tool card hasn't
  // finished dismissing, any "extend the current turn" action is
  // parked on its queue and replayed once the card emits
  // `ephemeral-tail-flush`. This guarantees text / further tool calls
  // never paint on top of (or under) a still-rotating card. The check
  // is at the top of the reducer so it covers every appendable action
  // in one place.
  if (TURN_APPEND_ACTIONS.has(action.kind) && state.turns.length > 0) {
    const lastAssistant = (() => {
      for (let i = state.turns.length - 1; i >= 0; i--) {
        if (state.turns[i].role === "assistant") return state.turns[i];
      }
      return null;
    })();
    if (lastAssistant && findActiveGateIndex(lastAssistant) >= 0) {
      return enqueueOnGate(state, action);
    }
  }
  switch (action.kind) {
    case "session-ready":
      return {
        ...state,
        client: action.client,
        sessionId: action.sessionId,
        model: action.model,
        backend: action.backend,
        terminalFailure:
          action.terminalFailure ??
          (action.sessionId === state.sessionId ? state.terminalFailure : null),
      };
    case "session-failed":
      return { ...state, fatalError: action.error };
    case "agent-unconfigured":
      return { ...state, agentConfig: action.config };
    case "user-send": {
      return {
        ...state,
        busy: true,
        // A locally submitted follow-up owns a new plan. Clear the completed
        // turn's grace-period state at this precise transition; resumed busy
        // sessions may already carry a replayed plan and must retain it.
        planItems: [],
        // A Deep Research send (`/`-pill) opens the working-set surface for
        // this run; an ordinary send closes any surface left from a prior run.
        deepResearch: action.deepResearch === true,
        turns: [
          ...state.turns,
          {
            id: action.optimisticId,
            role: "user",
            parts: [{ kind: "text", text: action.text }],
            done: true,
          },
        ],
      };
    }
    case "stamp-user-message": {
      // POST /agent/sessions/:id/messages returned with a server-assigned
      // userMessageId. If the matching `agent.user.message` event raced
      // ahead and already appended a stamped bubble, drop the placeholder
      // so we don't double-render the same message; otherwise rename the
      // placeholder so the event-side dedupe below recognises it.
      const { optimisticId, userMessageId } = action;
      const alreadyMaterialized = state.turns.some((t) => t.id === userMessageId);
      if (alreadyMaterialized) {
        return { ...state, turns: state.turns.filter((t) => t.id !== optimisticId) };
      }
      return {
        ...state,
        turns: state.turns.map((t) => (t.id === optimisticId ? { ...t, id: userMessageId } : t)),
      };
    }
    case "agent.user.message": {
      // Cross-device user-message sync. The originator already has an
      // optimistic bubble (stamped or pending) — `stamp-user-message`
      // gives it the same id this event carries, so we skip our own
      // send. Bubbles from another device watching the same session
      // land via this branch.
      const { userMessageId, text } = action.payload;
      if (state.turns.some((t) => t.id === userMessageId)) return state;
      return {
        ...state,
        turns: [
          ...state.turns,
          { id: userMessageId, role: "user", parts: [{ kind: "text", text }], done: true },
        ],
      };
    }
    case "agent.message.start": {
      // Anthropic + the gateway both occasionally re-deliver `message.start`
      // for the same id (resume after disconnect, retry on backend error).
      // Reuse the existing stub instead of pushing a duplicate empty turn.
      const existing = state.turns.some(
        (t) => t.role === "assistant" && t.id === action.payload.messageId,
      );
      const liveAssistant = [...state.turns]
        .reverse()
        .find((turn) => turn.role === "assistant" && turn.done === false);
      if (existing || (state.busy && liveAssistant)) return state;
      return {
        ...state,
        turns: [
          ...state.turns,
          {
            id: action.payload.messageId,
            role: "assistant",
            parts: [],
            done: false,
          },
        ],
      };
    }
    case "agent.text.delta":
      return mutateLastAssistant(state, (turn) => {
        const last = turn.parts[turn.parts.length - 1];
        if (last && last.kind === "text") {
          turn.parts[turn.parts.length - 1] = { kind: "text", text: last.text + action.payload.delta };
        } else {
          turn.parts.push({ kind: "text", text: action.payload.delta });
        }
      });
    case "agent.thinking.delta":
      return mutateLastAssistant(state, (turn) => {
        const last = turn.parts[turn.parts.length - 1];
        if (last && last.kind === "thinking") {
          turn.parts[turn.parts.length - 1] = { kind: "thinking", text: last.text + action.payload.delta };
        } else {
          turn.parts.push({ kind: "thinking", text: action.payload.delta });
        }
      });
    case "agent.tool.input_start":
      // Presentation-free orchestration tools never get transcript cards.
      // Plan results still land in the pinned TODO panel via tool.result.
      if (SILENT_TOOLS.has(action.payload.tool)) return state;
      // Render an immediate "running…" stub the moment the model opens
      // a tool-use block — the full args land seconds later via
      // `agent.tool.start`. Without this the card pops in fully-formed
      // and the user sees nothing for the gap.
      return mutateLastAssistant(state, (turn) => {
        // Duplicate `input_start` for the same tool call (resume / retry)
        // would push a redundant stub; skip if one exists already.
        for (const p of turn.parts) {
          if (p.kind === "tool" && p.toolCallId === action.payload.toolCallId) {
            return;
          }
        }
        turn.parts.push({
          kind: "tool",
          toolCallId: action.payload.toolCallId,
          tool: action.payload.tool,
          args: null,
          argsSummary: "",
          result: null,
          durationMs: null,
          // Ephemeral cards carry a per-part queue so subsequent SSE
          // events can wait for the card's dismiss animation. Other
          // tools never act as a gate; their pendingTail stays unused.
          pendingTail: actsAsGate(action.payload.tool) ? [] : undefined,
          tailDismissed: false,
        });
      });
    case "agent.tool.start":
      // Silent tool — same rationale as `agent.tool.input_start`.
      if (SILENT_TOOLS.has(action.payload.tool)) return state;
      return mutateLastAssistant(state, (turn) => {
        const summary =
          action.payload.argsSummary
          || summarizeArgs(action.payload.tool, action.payload.args);
        // Upgrade the stub from `tool.input_start` if present;
        // otherwise (replay backends + non-Anthropic backends may
        // skip input_start) append a fresh tool part.
        for (let i = turn.parts.length - 1; i >= 0; i--) {
          const p = turn.parts[i];
          if (p.kind === "tool" && p.toolCallId === action.payload.toolCallId) {
            turn.parts[i] = {
              ...p,
              tool: action.payload.tool,
              args: action.payload.args,
              argsSummary: summary,
            };
            return;
          }
        }
        turn.parts.push({
          kind: "tool",
          toolCallId: action.payload.toolCallId,
          tool: action.payload.tool,
          args: action.payload.args,
          argsSummary: summary,
          result: null,
          durationMs: null,
          pendingTail: actsAsGate(action.payload.tool) ? [] : undefined,
          tailDismissed: false,
        });
      });
    case "agent.tool.result": {
      // `plan.updated` carries the full current TODO list. Replace
      // `planItems` verbatim — server computes status, client just
      // mirrors. No matching tool part to fill in (the plan tool is
      // silent in the transcript), so return after the panel update.
      if (action.payload.result?.kind === "plan.updated") {
        return { ...state, planItems: action.payload.result.items ?? [] };
      }
      const result = action.payload.result;
      // `annotate.recorded` and `cite_record.recorded` feed the unified
      // Timeline panel. Update those derived state slots before fanning
      // out to mutateLastAssistant so the panel observes the change on
      // the same render the chip flips to "done". `annotate.recorded`
      // also lands via the synthesised `agent.citation` event below;
      // we mirror it into byDoc here so the Timeline projection sees
      // doc-level entries without waiting for the citations broadcast.
      let trailAnnotations = state.trailAnnotations;
      let recordCitations = state.recordCitations;
      if (result?.kind === "cite_record.recorded") {
        // A directly-cited DuckDB row (#757) → a record-only Timeline event,
        // deduped by recordKey (a re-cite of the same row replaces the prior).
        const event = citeRecordToEvent(result);
        if (event) {
          recordCitations = [
            ...state.recordCitations.filter((e) => e.record.recordKey !== event.record.recordKey),
            event,
          ];
        }
      } else {
        // A singular `annotate.recorded` or a batched `annotate.batch`
        // (annotate_many) both fan into the Timeline's byDoc map — one slot bump
        // per recorded child. Live must fan the batch out here or the Timeline
        // stays empty until reload (`trailAnnotationsFromMessages` fans the same
        // stored batch identically), breaking the live-equals-reloaded invariant.
        const recorded = annotateRecordedItems(result);
        let byDoc = trailAnnotations.byDoc;
        for (const rec of recorded) {
          if (typeof rec.documentId !== "string") continue;
          byDoc = {
            ...byDoc,
            [rec.documentId]: bumpDocSlot(
              byDoc[rec.documentId],
              rec.ref,
              rec.quote,
              rec.quoteAuthor,
              rec.note,
              rec.quoteIsSelf,
            ),
          };
        }
        if (byDoc !== trailAnnotations.byDoc) trailAnnotations = { byDoc };
      }
      // Out-of-order `tool.result` with no matching start is dropped —
      // the corresponding tool-use block is what carries the args we'd
      // need to render the chip header. A bare result with no header
      // would be a worse UX than silently skipping; the next agent turn
      // will surface whatever the result told the model anyway.
      // A directly-cited record bumps the turn's citation count the way an
      // `annotate` does — but records have no `agent.citation` broadcast, so
      // the count is bumped here off the tool result instead.
      const bumpsRecordCount = result?.kind === "cite_record.recorded" && !!citeRecordToEvent(result);
      const next = mutateLastAssistant(state, (turn) => {
        if (bumpsRecordCount) turn.citationCount = (turn.citationCount ?? 0) + 1;
        for (let i = turn.parts.length - 1; i >= 0; i--) {
          const p = turn.parts[i];
          if (p.kind === "tool" && p.toolCallId === action.payload.toolCallId) {
            turn.parts[i] = { ...p, result: action.payload.result, durationMs: action.payload.durationMs };
            return;
          }
        }
      });
      return { ...next, trailAnnotations, recordCitations };
    }
    // Live per-child progress for a batch tool (search_many / fetch_many).
    // Attach the child onto its parent part's `children` array, keyed by index
    // so out-of-order completion still renders in order; parts.js projects one
    // live ephemeral card per child. Every production backend emits these.
    case "agent.tool.child.start":
      return mutateLastAssistant(state, (turn) => {
        for (let i = turn.parts.length - 1; i >= 0; i--) {
          const p = turn.parts[i];
          if (p.kind !== "tool" || p.toolCallId !== action.payload.toolCallId) continue;
          const children = [...(p.children || [])];
          const existing = children.find((c) => c.index === action.payload.childIndex);
          if (existing) {
            existing.tool = action.payload.tool;
            existing.argsSummary = action.payload.argsSummary ?? existing.argsSummary ?? "";
          } else {
            children.push({
              index: action.payload.childIndex,
              tool: action.payload.tool,
              argsSummary: action.payload.argsSummary ?? "",
              result: null,
            });
          }
          children.sort((a, b) => a.index - b.index);
          turn.parts[i] = { ...p, children };
          return;
        }
      });
    case "agent.tool.child.result":
      return mutateLastAssistant(state, (turn) => {
        for (let i = turn.parts.length - 1; i >= 0; i--) {
          const p = turn.parts[i];
          if (p.kind !== "tool" || p.toolCallId !== action.payload.toolCallId) continue;
          const children = [...(p.children || [])];
          const child = children.find((c) => c.index === action.payload.childIndex);
          if (child) {
            child.result = action.payload.result;
          } else {
            children.push({
              index: action.payload.childIndex,
              tool: null,
              argsSummary: "",
              result: action.payload.result,
            });
            children.sort((a, b) => a.index - b.index);
          }
          turn.parts[i] = { ...p, children };
          return;
        }
      });
    case "agent.citation": {
      // Live signal: one annotate call just resolved. Routing:
      //   • note-only (no quote) → set the citation's docNote
      //     (last-write wins); does NOT create a quote entry.
      //   • quote (with or without note) → append a quote entry.
      // Either way, also bump the originating assistant turn's
      // `citationCount` so the chip in the bubble footer updates.
      const p = action.payload;
      const byDoc = new Map(state.citationsByDocId);
      const current = [...state.citations];
      const isDocNote = p.quote === undefined && p.note !== undefined;
      const existingIdx = byDoc.get(p.documentId);
      if (existingIdx != null) {
        const prev = current[existingIdx];
        if (isDocNote) {
          current[existingIdx] = { ...prev, docNote: p.note };
        } else {
          const entry = {
            toolCallId: p.toolCallId,
            messageId: p.messageId,
            quote: p.quote,
            quoteAuthor: p.quoteAuthor,
            quoteIsSelf: p.quoteIsSelf,
            note: p.note,
          };
          current[existingIdx] = { ...prev, entries: [...prev.entries, entry] };
        }
      } else {
        byDoc.set(p.documentId, current.length);
        const seed = { documentId: p.documentId, ref: p.ref, entries: [] };
        if (isDocNote) {
          seed.docNote = p.note;
        } else {
          seed.entries.push({
            toolCallId: p.toolCallId,
            messageId: p.messageId,
            quote: p.quote,
            quoteAuthor: p.quoteAuthor,
            quoteIsSelf: p.quoteIsSelf,
            note: p.note,
          });
        }
        current.push(seed);
      }
      // Bump the matching assistant turn's citationCount.
      const turns = [...state.turns];
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i].role === "assistant" && turns[i].id === p.messageId) {
          turns[i] = { ...turns[i], citationCount: (turns[i].citationCount ?? 0) + 1 };
          break;
        }
      }
      return { ...state, citations: current, citationsByDocId: byDoc, turns };
    }
    case "agent.citations.update": {
      const byDoc = new Map(state.citationsByDocId);
      const current = [...state.citations];
      for (const ref of action.payload.added || []) {
        if (!byDoc.has(ref.documentId)) {
          byDoc.set(ref.documentId, current.length);
          current.push({ documentId: ref.documentId, ref, entries: [] });
        }
      }
      for (const id of action.payload.removed || []) {
        const idx = byDoc.get(id);
        if (idx != null) {
          current.splice(idx, 1);
          byDoc.delete(id);
          // Re-index — splice shifted indices for entries after `idx`.
          for (const [docId, otherIdx] of byDoc) {
            if (otherIdx > idx) byDoc.set(docId, otherIdx - 1);
          }
        }
      }
      return { ...state, citations: current, citationsByDocId: byDoc };
    }
    case "agent.deep_research.summary":
      // Retired presentation metadata. The answer and normal annotations are
      // already carried by ordinary events, so no completion card is mounted.
      return state;
    case "agent.message.end": {
      // Stale `message.end` from a previously-switched session must not
      // clear the busy flag on the now-active conversation. The session
      // id check guards against the unsubscribe/attach race that can
      // leak a final event from the prior session.
      if (action.payload.sessionId !== state.sessionId) return state;
      // The run is over — collapse the research working-set surface into the
      // written-back report (which is the now-finished assistant turn).
      const terminalFailure =
        action.payload.failure?.code === "context_window_exceeded"
          ? {
              ...action.payload.failure,
              ...(action.payload.context ? { context: action.payload.context } : {}),
            }
          : state.terminalFailure;
      const settled = purgeOrchestrationTools(forceDrainGates(state));
      return mutateLastAssistant({
        ...settled,
        busy: false,
        deepResearch: false,
        terminalFailure,
      }, (turn) => {
        turn.done = true;
        if (action.payload.stopReason !== "end_turn") {
          turn.stopReason = action.payload.stopReason;
        }
        if (action.payload.failure?.code === "output_truncated") {
          turn.error =
            action.payload.failure.message ||
            "The model reached its output limit before completing this response.";
          turn.failure = turnFailure(action.payload.failure);
        }
      });
    }
    case "agent.error":
      if (
        action.payload.code === "context_window_exceeded" ||
        action.payload.code === "output_truncated"
      ) {
        // Live presentation signals only. The following `message.end.failure`
        // is authoritative: it alone freezes context-exhausted conversations
        // or marks a partial answer as truncated.
        return state;
      }
      return attachAgentError(state, action.payload);
    case "conversations-list":
      return { ...state, conversations: action.list, conversationError: null };
    case "conversation-error":
      return { ...state, conversationError: action.message };
    case "rail-toggle":
      return { ...state, railCollapsed: !state.railCollapsed };
    case "load-conversation": {
      const busy = action.busy === true;
      const terminalFailure =
        action.terminalFailure ??
        (action.sessionId === state.sessionId ? state.terminalFailure : null);
      // A turn may finish in buffered SSE immediately after the gateway took
      // a busy snapshot. Once message.end has settled the local turn, do not
      // let that older response resurrect it; genuinely busy local state is
      // rebuilt from the authoritative runtime snapshot below.
      if (
        busy &&
        action.sessionId === state.sessionId &&
        state.turns.length > 0 &&
        !state.busy
      ) {
        return {
          ...state,
          model: action.model,
          backend: action.backend,
          terminalFailure,
          notFoundConvoId: null,
        };
      }
      // A brief talk-back thread hides its folded run transcript — the
      // brief card (state.briefOrigin) carries that context instead.
      const origin = action.origin ?? null;
      const messages =
        action.messagesAreVisible === true
          ? action.messages
          : visibleMessages(action.messages, origin);
      const turns = chatMessagesToTurns(messages);
      // `chatMessagesToTurns` treats stored history as complete by default, but
      // a busy runtime snapshot is still receiving text, tools, and sub-agent
      // lifecycle events; keep its renderer open until `agent.message.end`.
      if (busy) {
        const lastAssistant = turns.findLast((turn) => turn.role === "assistant");
        if (lastAssistant) lastAssistant.done = false;
      }
      // The record's own account of how the last turn died, which carries the
      // provider's disposition. `chatMessagesToTurns` already lifted a failure
      // out of the history marker for a conversation stored before the record
      // kept one; this is the better source, so it wins where both exist.
      if (action.lastTurnFailure) {
        const truncated = action.lastTurnFailure.code === "output_truncated";
        const lastAssistant = turns.findLast((turn) => turn.role === "assistant");
        if (lastAssistant) {
          lastAssistant.error =
            action.lastTurnFailure.message ||
            (truncated
              ? "The model reached its output limit before completing this response."
              : "The turn failed.");
          lastAssistant.failure = turnFailure(action.lastTurnFailure);
          if (truncated) lastAssistant.stopReason = "max_tokens";
        }
      }
      const initialHistorySignatures = historyPageHasVisibleContent(turns)
        ? [historyPageSignature(messages)]
        : [];
      const citations = citationsFromMessages(messages);
      const byDoc = new Map();
      citations.forEach((c, i) => byDoc.set(c.documentId, i));
      // Older transcripts stored Deep Research document references inside a
      // retired `report_artifact` part. Keep those references available when
      // reopening history; new runs use normal annotate_many tool pairs.
      for (const turn of turns) {
        for (const ref of turn.reportCitations ?? []) {
          if (!ref || !ref.documentId || byDoc.has(ref.documentId)) continue;
          byDoc.set(ref.documentId, citations.length);
          citations.push({ documentId: ref.documentId, ref, entries: [] });
        }
      }
      // Rebuild the annotation buckets + cited records from persisted tool
      // results so the side-panel Timeline works on resume the same way it
      // does live. Only normal annotation tools create Timeline entries.
      const trailAnnotations = trailAnnotationsFromMessages(messages);
      const recordCitations = recordCitationsFromMessages(messages);
      // Resumed history must NOT repopulate the plan panel — it is a
      // live in-flight progress surface, not persisted state. The
      // `chatMessagesToTurns` helper already filters plan tool_use
      // blocks out of the transcript implicitly (the renderer ignores
      // tool === "plan"), so nothing else to do here.
      return {
        ...state,
        sessionId: action.sessionId,
        model: action.model,
        backend: action.backend,
        turns,
        citations,
        citationsByDocId: byDoc,
        trailAnnotations,
        recordCitations,
        briefOrigin: origin,
        busy,
        terminalFailure,
        messageNextCursor: action.messagePageInfo?.nextCursor ?? null,
        messagePagingTruncated: false,
        messageCount: action.messageCount ?? messages.length,
        loadedHistoryPageKeys: [],
        loadedHistoryPageSignatures: initialHistorySignatures,
        notFoundConvoId: null,
        planItems: [],
        deepResearch: false,
      };
    }
    case "prepend-conversation-history": {
      if (
        action.sessionId !== state.sessionId ||
        state.loadedHistoryPageKeys.includes(action.pageKey)
      ) {
        return state;
      }
      // The dedicated history endpoint guarantees visible, chronological,
      // turn-aligned pages. Never reapply origin.seedMessageCount here: that
      // prefix was removed server-side before paging.
      const messages = action.messages ?? [];
      const pageSignature = historyPageSignature(messages);
      const unprefixedTurns = chatMessagesToTurns(messages);
      const madeProgress =
        historyPageHasVisibleContent(unprefixedTurns) &&
        !state.loadedHistoryPageSignatures.includes(pageSignature);
      const nextCursor = action.pageInfo?.nextCursor ?? null;
      const stoppedBeforeEnd =
        nextCursor != null &&
        (!madeProgress || nextCursor === action.pageKey);
      if (!madeProgress) {
        return {
          ...state,
          messageNextCursor: null,
          messagePagingTruncated: stoppedBeforeEnd,
          loadedHistoryPageKeys: [...state.loadedHistoryPageKeys, action.pageKey],
        };
      }
      const prefix = `history-${action.pageKey ?? "older"}-`;
      const olderTurns = unprefixedTurns.map((turn) => ({
        ...turn,
        id: prefix + turn.id,
      }));

      const olderCitations = citationsFromMessages(messages);
      for (const turn of olderTurns) {
        for (const ref of turn.reportCitations ?? []) {
          if (
            ref?.documentId &&
            !olderCitations.some((citation) => citation.documentId === ref.documentId)
          ) {
            olderCitations.push({ documentId: ref.documentId, ref, entries: [] });
          }
        }
      }
      const citations = [];
      const citationIndex = new Map();
      for (const citation of [...olderCitations, ...state.citations]) {
        const existing = citationIndex.get(citation.documentId);
        if (existing === undefined) {
          citationIndex.set(citation.documentId, citations.length);
          citations.push({
            ...citation,
            entries: [...(citation.entries ?? [])],
          });
        } else {
          const previous = citations[existing];
          citations[existing] = {
            ...previous,
            ...citation,
            entries: [...(previous.entries ?? []), ...(citation.entries ?? [])],
          };
        }
      }

      const olderTrail = trailAnnotationsFromMessages(messages);
      const byDoc = { ...(olderTrail.byDoc ?? {}) };
      for (const [documentId, current] of Object.entries(
        state.trailAnnotations?.byDoc ?? {},
      )) {
        const older = byDoc[documentId];
        byDoc[documentId] = older
          ? {
              ...older,
              ...current,
              quotes: [...(older.quotes ?? []), ...(current.quotes ?? [])],
            }
          : current;
      }
      const recordByKey = new Map();
      for (const event of [
        ...recordCitationsFromMessages(messages),
        ...state.recordCitations,
      ]) {
        // Map.set replaces the value without moving the key: chronological
        // first-arrival order is retained while the newer/current page wins
        // when the same record was cited again with fresher metadata.
        recordByKey.set(event.record?.recordKey ?? event.eventId, event);
      }
      const recordCitations = [...recordByKey.values()];

      return {
        ...state,
        turns: [...olderTurns, ...state.turns],
        citations,
        citationsByDocId: citationIndex,
        trailAnnotations: { byDoc },
        recordCitations,
        // A malformed/older endpoint must not leave a permanently observable
        // boundary that requests the same/duplicate page forever.
        messageNextCursor: stoppedBeforeEnd ? null : nextCursor,
        messagePagingTruncated: stoppedBeforeEnd,
        loadedHistoryPageKeys: [...state.loadedHistoryPageKeys, action.pageKey],
        loadedHistoryPageSignatures: [
          ...state.loadedHistoryPageSignatures,
          pageSignature,
        ],
      };
    }
    case "reset-conversation":
      return {
        ...state,
        sessionId: action.sessionId,
        model: action.model,
        backend: action.backend,
        turns: [],
        citations: [],
        citationsByDocId: new Map(),
        trailAnnotations: { byDoc: {} },
        recordCitations: [],
        briefOrigin: null,
        busy: false,
        terminalFailure: null,
        messageNextCursor: null,
        messagePagingTruncated: false,
        messageCount: 0,
        loadedHistoryPageKeys: [],
        loadedHistoryPageSignatures: [],
        notFoundConvoId: null,
        planItems: [],
        deepResearch: false,
      };
    case "conversation-not-found":
      return {
        ...state,
        notFoundConvoId: action.convoId,
        sessionId: null,
        turns: [],
        citations: [],
        citationsByDocId: new Map(),
        trailAnnotations: { byDoc: {} },
        recordCitations: [],
        briefOrigin: null,
        busy: false,
        terminalFailure: null,
        messageNextCursor: null,
        messagePagingTruncated: false,
        messageCount: 0,
        loadedHistoryPageKeys: [],
        loadedHistoryPageSignatures: [],
        planItems: [],
        deepResearch: false,
      };
    case "plan-clear":
      // View-driven clear, fired after the message-end grace period.
      // Keeps the panel reactive to a stalled turn that never emits a
      // final `done` plan update.
      return { ...state, planItems: [] };
    case "agent.subagent.spawned": {
      // A nested sub-agent started: push a compact progress row onto the
      // current assistant turn. Idempotent on re-delivery (resume / retry).
      const p = action.payload;
      // The stable worker row supersedes its launch control. If the launch
      // result was already gating a tail, drain that tail before removing it.
      const withoutLaunch = p.parentToolCallId
        ? removeToolPart(drainGate(state, p.parentToolCallId), p.parentToolCallId)
        : state;
      const already = withoutLaunch.turns.some(
        (t) =>
          t.role === "assistant" &&
          t.parts.some((part) => part.kind === "subagent" && part.subagentId === p.subagentId),
      );
      if (already) return withoutLaunch;
      const withCard = mutateLastAssistant(withoutLaunch, (turn) => {
        turn.parts.push(emptySubagentCard(p));
      });
      // Generic workers belong to an ordinary conversation: keep their compact
      // progress card without opening the explicit Deep Research workspace.
      // Named private readers still arm the workspace for replay/demo streams
      // that did not arrive through an explicitly armed `/` send.
      if (p.specialist === "generic" || withCard.deepResearch) return withCard;
      return { ...withCard, deepResearch: true };
    }
    case "agent.subagent.event": {
      // A wrapped child AgentEvent: grow the matching card's nested
      // transcript. Unknown child events degrade gracefully inside
      // `reduceChildEvent`.
      const p = action.payload;
      return mutateSubagentCard(state, p.subagentId, (card) => reduceChildEvent(card, p.event));
    }
    case "agent.subagent.result": {
      // The child finished: finalise the card with its status, summary, and
      // token total. The reported `usage` is the authoritative per-sub-agent
      // total — adopt it over the running `tokens` tally when present.
      const p = action.payload;
      let parentToolCallId;
      const withResult = mutateSubagentCard(state, p.subagentId, (card) => {
        parentToolCallId = card.parentToolCallId;
        return {
          ...card,
          status: p.status,
          summary: p.summary,
          retainedCitationCount: Array.isArray(p.citations) ? p.citations.length : 0,
          failureCode: p.failure?.code ?? null,
          failureProvider: providerDetailLine(p.failure?.provider),
          docs: mergeCardDocs(card.docs ?? [], p.citations ?? []),
          ...(hasAnyUsageToken(p.usage)
            ? { tokens: sumUsageTokens(p.usage), completedUsageByMessage: {}, liveUsageByMessage: {} }
            : {}),
        };
      });
      return parentToolCallId
        ? removeToolPart(drainGate(withResult, parentToolCallId), parentToolCallId)
        : withResult;
    }
    case "ephemeral-tail-flush":
      // Dispatched by the ephemeral card AFTER its fade-out animation
      // finishes. The reducer marks the gate as dismissed and replays
      // any queued actions in arrival order, so the user sees a clean
      // causality chain: card mounts → result → card fades away →
      // text/next-tool appears.
      return drainGate(state, action.toolCallId);
    default:
      return state;
  }
}
