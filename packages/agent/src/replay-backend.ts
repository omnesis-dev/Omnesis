// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `ReplayBackend` — emits a recorded conversation from a `.jsonl` fixture.
 *
 * Fixture format (one JSON object per line):
 *
 *   { "afterMs": 30,  "event": { "type": "agent.message.start", "payload": { … } } }
 *   { "afterMs": 12,  "event": { "type": "agent.text.delta",   "payload": { … } } }
 *   …
 *   { "afterMs": 0,   "event": { "type": "agent.message.end",  "payload": { … } } }
 *
 * Event payloads may use placeholder strings `"$SESSION"` and `"$MSG"`
 * (anywhere a string is expected) — the replay engine substitutes the
 * runtime values at emit time. This keeps fixtures portable across
 * session/message IDs without baking specific UUIDs into every event.
 *
 * Timing: each event sleeps `afterMs` before being yielded. The clamp is
 * `[clampMs, +Infinity)` to keep tests fast — at clampMs=0 the entire
 * fixture replays as fast as `setImmediate` allows. The portal demo uses
 * `clampMs = 30` so it feels like a real model is typing.
 *
 * Cancellation: an aborted signal causes the iterator to break, but the
 * backend does NOT synthesise an `agent.message.end { canceled }` — the
 * session does that, because the session owns the cancellation semantics.
 *
 * Tool calls come in two flavours, distinguished by whether the fixture also
 * records the result:
 *
 *   - **Recorded** — an `agent.tool.start` followed later in the same fixture
 *     by an `agent.tool.result` carrying the same `toolCallId`. Both events
 *     replay verbatim; the tool is never run. This is what a recorded demo
 *     wants: the corpus has moved on since the recording and a live `search`
 *     would return something else.
 *   - **Live** — an `agent.tool.start` with no recorded result. The backend
 *     looks the tool up in the turn's registry, invokes it with the recorded
 *     arguments, and emits the real result. This is for a flow whose tool call
 *     IS the outcome rather than a step towards it — the privacy reviewer
 *     completes its review by calling `submit_privacy_review`, and a replayed
 *     result would leave the reviewer with nothing submitted. A live call to a
 *     tool the turn does not offer yields an error result, so a fixture naming
 *     a tool that no longer exists fails visibly rather than hanging the turn.
 *
 * Because a live call's result is REAL, ids in it differ from the ones the
 * recording saw. An entry may therefore declare `capture` — dot paths into
 * the live result, held under a name for the rest of the turn — and later
 * entries reference them as `$CAP_<name>`. That is what lets a cassette
 * create a loop and then append to it: the append reads the id the gateway
 * just minted rather than the one the recording happened to get.
 *
 * `RoutingReplayBackend` wraps multiple scenarios so a single gateway boot
 * can serve several distinct demos: the first user message picks the
 * scenario (case-insensitive substring match against each scenario's
 * `triggers`), and that choice is locked for the rest of the session.
 * Useful for live demos where you don't want to restart the gateway
 * between scenarios — start one demo gateway, then steer between
 * scripted conversations by what you type as the first message.
 */

import {
  parseEventPayload,
  type AgentEvent,
  type AgentEventType,
  type ToolResult,
} from "@omnesis/core";

import { probeTurnEvents } from "./backend.js";
import type { ChatBackend, TurnInput } from "./backend.js";

export interface ReplayBackendOptions {
  /** One fixture per call to runTurn; if multiple, they're consumed in order. */
  fixtures: ReadonlyArray<ReplayFixture>;
  /** Minimum sleep between events, in ms. Default 0 (test-mode). */
  clampMs?: number;
  /** Maximum sleep between events, in ms. Default Infinity. */
  capMs?: number;
  /** Model name to report. Default "replay". */
  model?: string;
  /**
   * Extra string-literal substitutions applied to every payload field
   * before validation. Keys are matched as full-string equality against
   * any string in the event (e.g. `$DOC_demo-gmail-001` →
   * `"abc123-uuid-…"`). The built-in `$SESSION` / `$MSG` substitutions
   * fire alongside these.
   */
  substitutions?: Readonly<Record<string, string>>;
  /**
   * If set (> 0), every `agent.text.delta` event is split into chunks of
   * roughly this many characters and emitted one at a time, with
   * `textStreamMs` ms between chunks. Makes long pre-recorded paragraphs
   * feel like live model streaming on screen. Off by default — tests rely
   * on a 1:1 event count.
   */
  textStreamChars?: number;
  /** Ms between sub-chunks when `textStreamChars` is set. Default 25. */
  textStreamMs?: number;
}

export interface ReplayFixture {
  /** Optional label, useful in tests and logs. */
  name?: string;
  entries: ReadonlyArray<ReplayEntry>;
}

export interface ReplayEntry {
  afterMs: number;
  event: AgentEvent;
  /**
   * Values to lift out of a LIVE tool call's real result and hold for the
   * rest of the turn, keyed by capture name. Each value is a dot path into
   * the result — `"data.loop.id"` — and later entries reference what was
   * captured as `$CAP_<name>` anywhere a string appears.
   *
   * This exists because a live call's result is real: when a recorded
   * session created a loop and then appended to its ledger, the replayed
   * create mints a NEW id, and the recorded ledger call would otherwise
   * point at a loop that never existed. Ignored on recorded (non-live)
   * calls, which already replay a self-consistent result.
   */
  capture?: Readonly<Record<string, string>>;
}

export class ReplayBackend implements ChatBackend {
  readonly name = "replay";
  readonly model: string;

  private readonly fixtures: ReplayFixture[];
  // Per-instance counter of how many turns this backend has served. Each
  // call to `runTurn` captures the value at entry into a local so concurrent
  // sessions sharing the instance don't interleave cursor advances.
  private turnsServed = 0;
  private readonly clampMs: number;
  private readonly capMs: number;
  private readonly substitutions: Readonly<Record<string, string>>;
  private readonly textStreamChars: number;
  private readonly textStreamMs: number;

  constructor(opts: ReplayBackendOptions) {
    if (opts.fixtures.length === 0) {
      throw new Error("ReplayBackend requires at least one fixture");
    }
    this.fixtures = [...opts.fixtures];
    this.clampMs = opts.clampMs ?? 0;
    this.capMs = opts.capMs ?? Number.POSITIVE_INFINITY;
    this.model = opts.model ?? "replay";
    this.substitutions = opts.substitutions ?? {};
    this.textStreamChars = opts.textStreamChars ?? 0;
    this.textStreamMs = opts.textStreamMs ?? 25;
  }

  async *runTurn(input: TurnInput, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    // Replayed fixtures pace out recorded events; the probe measures the
    // replay (backend name stays "replay", so profiles never confuse it
    // with live inference) with one span per turn.
    yield* probeTurnEvents(input.llmProbe, this.playFixture(input, signal));
  }

  private async *playFixture(input: TurnInput, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const myTurn = this.turnsServed;
    this.turnsServed++;
    const fixture = this.fixtures[myTurn];
    if (!fixture) {
      // Emit a typed error + clean end instead of throwing — a fixture
      // exhaustion mid-conversation should surface in the portal as a
      // readable message ("demo over"), not crash the session loop.
      const { sessionId, messageId } = input;
      yield { type: "agent.message.start", payload: { sessionId, messageId, role: "assistant" } };
      yield {
        type: "agent.error",
        payload: {
          sessionId,
          messageId,
          code: "fixture_exhausted",
          message: `Replay fixture exhausted after ${myTurn} turn(s).`,
        },
      };
      yield {
        type: "agent.message.end",
        payload: { sessionId, messageId, stopReason: "error" },
      };
      return;
    }

    const liveToolCallIds = liveToolCalls(fixture);
    // Values lifted from live tool results, referenced by later entries as
    // `$CAP_<name>`. Per turn, so replays never leak ids into each other.
    const captured: Record<string, string> = {};
    for (const entry of fixture.entries) {
      if (signal?.aborted) return;
      const wait = clamp(entry.afterMs, this.clampMs, this.capMs);
      if (wait > 0) {
        await sleep(wait, signal);
        if (signal?.aborted) return;
      }
      const substituted = substituteIds(entry.event, input.sessionId, input.messageId, {
        ...this.substitutions,
        ...captured,
      });
      if (this.textStreamChars > 0 && substituted.type === "agent.text.delta") {
        for await (const sub of streamTextDelta(
          substituted,
          this.textStreamChars,
          this.textStreamMs,
          signal,
        )) {
          if (signal?.aborted) return;
          yield sub;
        }
        continue;
      }
      yield substituted;
      const call = liveToolCall(substituted, liveToolCallIds);
      if (!call) continue;
      const started = Date.now();
      const result = await invokeLiveTool(input, call, signal);
      if (signal?.aborted) return;
      if (entry.capture) {
        for (const [name, path] of Object.entries(entry.capture)) {
          const value = readResultPath(result, path);
          // Only a string is substitutable, and a miss must be visible: a
          // silently-absent capture would make every later reference
          // replay the literal `$CAP_x` into a real tool call.
          captured[`$CAP_${name}`] = typeof value === "string" ? value : `__CAPTURE_MISS_${name}__`;
        }
      }
      yield {
        type: "agent.tool.result",
        payload: {
          sessionId: input.sessionId,
          messageId: input.messageId,
          toolCallId: call.toolCallId,
          result,
          durationMs: Date.now() - started,
        },
      } as AgentEvent;
    }
  }
}

interface LiveToolCall {
  toolCallId: string;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * The `toolCallId`s this fixture starts but never resolves. Collected once per
 * turn so each `agent.tool.start` can be classified as recorded or live in a
 * single pass, without look-ahead over the entry list.
 */
function liveToolCalls(fixture: ReplayFixture): Set<string> {
  const started = new Set<string>();
  const resolved = new Set<string>();
  for (const entry of fixture.entries) {
    const id = toolCallIdOf(entry.event);
    if (id === null) continue;
    if (entry.event.type === "agent.tool.start") started.add(id);
    else if (entry.event.type === "agent.tool.result") resolved.add(id);
  }
  for (const id of resolved) started.delete(id);
  return started;
}

function toolCallIdOf(event: AgentEvent): string | null {
  const payload = event.payload as { toolCallId?: unknown };
  return typeof payload.toolCallId === "string" ? payload.toolCallId : null;
}

function liveToolCall(event: AgentEvent, liveIds: ReadonlySet<string>): LiveToolCall | null {
  if (event.type !== "agent.tool.start") return null;
  const payload = event.payload as { toolCallId?: unknown; tool?: unknown; args?: unknown };
  if (typeof payload.toolCallId !== "string" || !liveIds.has(payload.toolCallId)) return null;
  if (typeof payload.tool !== "string") return null;
  const args =
    payload.args !== null && typeof payload.args === "object" && !Array.isArray(payload.args)
      ? (payload.args as Record<string, unknown>)
      : {};
  return { toolCallId: payload.toolCallId, tool: payload.tool, args };
}

/**
 * Run one live tool call. A tool that is absent or throws produces an error
 * result rather than aborting the stream, so the session still sees a
 * `tool_use`/`tool_result` pair and the turn lands in a shape history accepts.
 */
async function invokeLiveTool(
  input: TurnInput,
  call: LiveToolCall,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  const handle = input.tools.find((tool) => tool.name === call.tool);
  if (!handle) {
    return {
      kind: "error",
      code: "tool_not_available",
      message: `Replay fixture called '${call.tool}', which this turn does not offer.`,
    };
  }
  try {
    return await handle.invoke(call.args, {
      sessionId: input.sessionId,
      messageId: input.messageId,
      timeZone: input.timeZone,
      caller: input.caller,
      ...(signal ? { abortSignal: signal } : {}),
    });
  } catch (err) {
    return {
      kind: "error",
      code: "tool_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function* streamTextDelta(
  event: AgentEvent,
  chunkChars: number,
  perChunkMs: number,
  signal: AbortSignal | undefined,
): AsyncIterable<AgentEvent> {
  const payload = event.payload as { delta?: unknown };
  const fullDelta = typeof payload.delta === "string" ? payload.delta : "";
  if (fullDelta.length <= chunkChars) {
    yield event;
    return;
  }
  // Word-aware chunking: try to land on whitespace when possible so we
  // don't visibly split tiny words like "ok" mid-letter. Falls back to a
  // hard char-count slice when the next whitespace is far away.
  let i = 0;
  let first = true;
  while (i < fullDelta.length) {
    let end = Math.min(i + chunkChars, fullDelta.length);
    if (end < fullDelta.length) {
      const ws = fullDelta.indexOf(" ", end);
      if (ws !== -1 && ws - end <= chunkChars) end = ws + 1;
    }
    const chunk = fullDelta.slice(i, end);
    if (!first) {
      await sleep(perChunkMs, signal);
      if (signal?.aborted) return;
    }
    first = false;
    yield {
      type: event.type,
      payload: { ...(event.payload as Record<string, unknown>), delta: chunk },
    } as AgentEvent;
    i = end;
  }
}

// ─── fixture I/O ──────────────────────────────────────────────────────────

/**
 * Parse a JSONL string into validated entries. Each line is one
 * `ReplayEntry`. Empty lines and lines starting with `#` are ignored.
 */
export function parseFixture(name: string, source: string): ReplayFixture {
  const entries: ReplayEntry[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw === "" || raw.startsWith("#")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `fixture ${name}: line ${i + 1} is not valid JSON: ${(err as Error).message}`,
        { cause: err },
      );
    }
    const entry = validateEntry(name, i + 1, parsed);
    entries.push(entry);
  }
  return { name, entries };
}

/** Serialize a fixture back to JSONL. Used by the record-wrapper later. */
export function serializeFixture(fixture: ReplayFixture): string {
  return fixture.entries
    .map((e) =>
      JSON.stringify({
        afterMs: e.afterMs,
        event: e.event,
        ...(e.capture ? { capture: e.capture } : {}),
      }),
    )
    .join("\n");
}

// ─── internal helpers ────────────────────────────────────────────────────

function validateEntry(name: string, lineNo: number, raw: unknown): ReplayEntry {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`fixture ${name}: line ${lineNo} is not an object`);
  }
  const obj = raw as Record<string, unknown>;
  const afterMs = obj.afterMs;
  if (typeof afterMs !== "number" || afterMs < 0) {
    throw new Error(`fixture ${name}: line ${lineNo} missing or invalid 'afterMs'`);
  }
  const eventRaw = obj.event;
  if (typeof eventRaw !== "object" || eventRaw === null) {
    throw new Error(`fixture ${name}: line ${lineNo} missing 'event' object`);
  }
  const evt = eventRaw as Record<string, unknown>;
  const type = evt.type;
  if (typeof type !== "string" || !type.startsWith("agent.")) {
    throw new Error(`fixture ${name}: line ${lineNo} event.type must be an "agent.*" string`);
  }
  // Replace placeholders BEFORE schema validation so the typed parser doesn't
  // reject a stand-in like "$SESSION".
  const payloadStandin = substitutePlaceholders(
    evt.payload,
    "__stub_session__",
    "__stub_msg__",
    {},
  );
  const parsed = parseEventPayload(type as AgentEventType, payloadStandin);
  if (!parsed.ok) {
    throw new Error(`fixture ${name}: line ${lineNo} payload for ${type}: ${parsed.error}`);
  }
  const capture = validateCapture(name, lineNo, obj.capture);
  return {
    afterMs,
    event: { type, payload: evt.payload } as AgentEvent,
    ...(capture ? { capture } : {}),
  };
}

function validateCapture(
  name: string,
  lineNo: number,
  raw: unknown,
): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`fixture ${name}: line ${lineNo} 'capture' must be an object of name → path`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    // The reference syntax is `$CAP_<name>`, and the readers scan for
    // `[A-Za-z0-9_]+` — so a name outside that alphabet would be captured
    // under one spelling and looked up under a shorter one, reported as a
    // reference nothing captures. An empty name is worse still: `$CAP_` is a
    // prefix of every other reference.
    if (!/^[A-Za-z0-9_]+$/.test(key)) {
      throw new Error(
        `fixture ${name}: line ${lineNo} capture name '${key}' must match [A-Za-z0-9_]+`,
      );
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`fixture ${name}: line ${lineNo} capture '${key}' must be a non-empty path`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Read a dot path out of a tool result. Paths are rooted at the result
 * object, so a structured result's minted id is `"data.loop.id"`; numeric
 * segments index arrays.
 */
function readResultPath(result: ToolResult, path: string): unknown {
  let cur: unknown = result;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    const idx = Number.parseInt(seg, 10);
    cur =
      Array.isArray(cur) && !Number.isNaN(idx) ? cur[idx] : (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function substituteIds(
  event: AgentEvent,
  sessionId: string,
  messageId: string,
  extras: Readonly<Record<string, string>>,
): AgentEvent {
  const payload = substitutePlaceholders(event.payload, sessionId, messageId, extras);
  return { type: event.type, payload } as AgentEvent;
}

/** Substitution pairs ordered longest key first, so no key shadows a longer one. */
function longestFirst(extras: Readonly<Record<string, string>>): Array<[string, string]> {
  return Object.entries(extras).sort(([a], [b]) => b.length - a.length);
}

function substitutePlaceholders(
  value: unknown,
  sessionId: string,
  messageId: string,
  extras: Readonly<Record<string, string>>,
): unknown {
  if (typeof value === "string") {
    // Whole-value `$SESSION` / `$MSG` first (most common case).
    if (value === "$SESSION") return sessionId;
    if (value === "$MSG") return messageId;
    // Whole-value extras (back-compat: scenarios authored before
    // substring substitution existed expect `value === "$DOC_X"` to
    // return the UUID unchanged in shape).
    const whole = extras[value];
    if (whole !== undefined) return whole;
    // Substring extras: a fixture string like `"person:$PERSON_X"`
    // contains the placeholder as a substring. Replace every
    // occurrence of every declared extras key. The keys are
    // user-defined (`$DOC_<externalId>`, `$PERSON_<Name>`) and
    // distinctive enough that incidental matches in real content are
    // extremely unlikely — but we still skip strings that don't start
    // with `$` to avoid scanning every event field.
    if (!value.includes("$")) return value;
    let result = value;
    // Longest key first, so a key that is a PREFIX of another cannot eat it:
    // captures are minted as `loop1 … loop9, loop10`, and substituting
    // `$CAP_loop1` before `$CAP_loop10` would rewrite the latter into the
    // former's value followed by a stray `0`.
    for (const [key, replacement] of longestFirst(extras)) {
      if (result.includes(key)) {
        result = result.split(key).join(replacement);
      }
    }
    return result;
  }
  if (Array.isArray(value)) {
    return value.map((v) => substitutePlaceholders(v, sessionId, messageId, extras));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = substitutePlaceholders(v, sessionId, messageId, extras);
    }
    return out;
  }
  return value;
}

// ─── Routing replay backend ──────────────────────────────────────────────

export interface ReplayScenario {
  /** Stable name for logging — usually the fixture's bare filename. */
  name: string;
  /**
   * Case-insensitive substrings checked against the first user message.
   * Any match picks this scenario; scenarios are checked in array order
   * so the first listed wins on overlap.
   */
  triggers: ReadonlyArray<string>;
  fixture: ReplayFixture;
  /** Per-scenario placeholder substitutions resolved at session-create. */
  substitutions?: Readonly<Record<string, string>>;
}

export interface RoutingReplayBackendOptions {
  scenarios: ReadonlyArray<ReplayScenario>;
  /** Minimum sleep between events, in ms. Default 0 (test-mode). */
  clampMs?: number;
  /** Maximum sleep between events, in ms. Default Infinity. */
  capMs?: number;
  /** Model name to report. Default "replay". */
  model?: string;
  /** Forwarded to the inner ReplayBackend — see `ReplayBackendOptions`. */
  textStreamChars?: number;
  /** Forwarded to the inner ReplayBackend — see `ReplayBackendOptions`. */
  textStreamMs?: number;
}

/**
 * Routes the first user message of a session to one of N scripted scenarios,
 * then locks the session to whatever happened on that first turn:
 *
 *   - First turn matched a scenario  → replay that fixture; subsequent
 *     turns emit `fixture_exhausted`.
 *   - First turn matched nothing     → emit a synthetic "no scenario
 *     matched, try one of: …" stream; subsequent turns also emit
 *     `fixture_exhausted`.
 *
 * One instance per session — concurrent sessions get their own.
 */
export class RoutingReplayBackend implements ChatBackend {
  readonly name = "replay";
  readonly model: string;

  private readonly scenarios: ReadonlyArray<ReplayScenario>;
  private readonly clampMs: number;
  private readonly capMs: number;
  private readonly textStreamChars: number;
  private readonly textStreamMs: number;
  private locked = false;

  constructor(opts: RoutingReplayBackendOptions) {
    if (opts.scenarios.length === 0) {
      throw new Error("RoutingReplayBackend requires at least one scenario");
    }
    this.scenarios = opts.scenarios;
    this.clampMs = opts.clampMs ?? 0;
    this.capMs = opts.capMs ?? Number.POSITIVE_INFINITY;
    this.model = opts.model ?? "replay";
    this.textStreamChars = opts.textStreamChars ?? 0;
    this.textStreamMs = opts.textStreamMs ?? 25;
  }

  async *runTurn(input: TurnInput, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    yield* probeTurnEvents(input.llmProbe, this.routeTurn(input, signal));
  }

  private async *routeTurn(input: TurnInput, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    if (this.locked) {
      yield* exhaustedStream(input, this.scenarios.length);
      return;
    }
    this.locked = true;

    const picked = pickScenario(this.scenarios, input.userMessage);
    if (!picked) {
      yield* noMatchStream(input, this.scenarios);
      return;
    }

    const inner = new ReplayBackend({
      fixtures: [picked.fixture],
      clampMs: this.clampMs,
      capMs: this.capMs,
      substitutions: picked.substitutions,
      textStreamChars: this.textStreamChars,
      textStreamMs: this.textStreamMs,
    });
    // The outer probeTurnEvents already spans this turn: suppress the inner
    // backend's own span so one turn is not counted twice.
    for await (const event of inner.runTurn({ ...input, llmProbe: undefined }, signal)) {
      yield event;
    }
  }
}

function pickScenario(
  scenarios: ReadonlyArray<ReplayScenario>,
  userMessage: string,
): ReplayScenario | undefined {
  const haystack = userMessage.toLowerCase();
  for (const scenario of scenarios) {
    for (const trigger of scenario.triggers) {
      if (trigger.length === 0) continue;
      if (haystack.includes(trigger.toLowerCase())) return scenario;
    }
  }
  return undefined;
}

async function* noMatchStream(
  input: TurnInput,
  scenarios: ReadonlyArray<ReplayScenario>,
): AsyncIterable<AgentEvent> {
  const { sessionId, messageId } = input;
  const summary = scenarios
    .map((s) => `- **${s.name}** — try: ${s.triggers.map((t) => `\`${t}\``).join(", ")}`)
    .join("\n");
  const delta = `No demo scenario matched your message. Available scenarios:\n\n${summary}\n\nStart a new conversation and mention one of the keywords above.`;
  yield { type: "agent.message.start", payload: { sessionId, messageId, role: "assistant" } };
  yield { type: "agent.text.delta", payload: { sessionId, messageId, delta } };
  yield {
    type: "agent.message.end",
    payload: { sessionId, messageId, stopReason: "end_turn" },
  };
}

async function* exhaustedStream(
  input: TurnInput,
  scenarioCount: number,
): AsyncIterable<AgentEvent> {
  const { sessionId, messageId } = input;
  yield { type: "agent.message.start", payload: { sessionId, messageId, role: "assistant" } };
  yield {
    type: "agent.error",
    payload: {
      sessionId,
      messageId,
      code: "fixture_exhausted",
      message: `Demo scenarios are single-turn. Start a new conversation to pick another one (${scenarioCount} available).`,
    },
  };
  yield {
    type: "agent.message.end",
    payload: { sessionId, messageId, stopReason: "error" },
  };
}

function clamp(n: number, lo: number, hi: number): number {
  // Guard against caller passing the bounds in either order — Math.min/max
  // make the result well-defined regardless.
  return Math.max(Math.min(lo, hi), Math.min(Math.max(lo, hi), n));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
