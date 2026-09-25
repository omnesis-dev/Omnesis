// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * End-to-end coverage for every replay-agent scenario in the active
 * synthetic-corpus universe (default: `evals/universes/default/agent-demos/`).
 *
 * For each `.jsonl + .meta.json` pair under `<universe>/agent-demos/`:
 *
 *  1. Boot a real gateway subprocess with the replay agent enabled
 *     (`inference.assignments.agent = "replay"` in omnesis.json, written by
 *     the harness; fixture path via `OMNESIS_AGENT_FIXTURE`).
 *  2. Sync every synth source so $DOC_<externalId> / $PERSON_<Name>
 *     placeholders have docs + people in the gateway DB to resolve against.
 *  3. POST `/agent/sessions` → capture sessionId.
 *  4. Open `/agent/events` SSE (per-scenario; per-caller listener caps mean
 *     short-lived connections are safer than holding one open across all).
 *  5. POST `/agent/sessions/:id/messages` with the scenario's first trigger.
 *  6. Read events until `agent.message.end` for that messageId.
 *  7. Assert: routing picked a scenario (saw `agent.message.start`), no
 *     `agent.error` fired, and no event payload still contains an
 *     unresolved `$DOC_…` / `$PERSON_…` placeholder (meaning the gateway's
 *     placeholder resolver did its job).
 *
 * This is the single highest-leverage agent-harness regression net: catches
 * breakage in routing, the event protocol, placeholder resolution, the
 * substitution wire, and the scenario fixture parser, all in one suite.
 */

import "./synth-env.js";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { loadActiveUniverse, getAgentDemosDir } from "@omnesis/providers-synth-common";
import { SyntheticE2EHarness } from "./synth-harness.js";

interface ScenarioMeta {
  /** Inference role this cassette replays for. Omitted means the chat agent. */
  role?: string;
  triggers: string[];
  placeholders?: {
    docExternalIds?: string[];
    personNames?: string[];
  };
}

interface AgentEvent {
  type: string;
  payload: Record<string, unknown>;
}

interface ScenarioFile {
  name: string;
  meta: ScenarioMeta;
}

// Immediate replay retains every text chunk and yields between chunks. Keep
// generous transport headroom so a loaded runner does not turn speed into flakes.
const PER_SCENARIO_TIMEOUT_MS = 60_000;

/**
 * Scenarios that are intentionally exempted from the placeholder-leak
 * check. Empty by default — every scenario should resolve every
 * placeholder it declares. Add a name here only when there's a clear
 * reason (e.g. the scenario references docs from a source family that
 * doesn't emit Documents) and document that reason inline.
 */
const SKIP_PLACEHOLDER_CHECK = new Set<string>();

/** Whether a cassette is one the chat agent serves, which is all this suite drives. */
function isAgentScenario(meta: ScenarioMeta): boolean {
  return (meta.role ?? "agent") === "agent";
}

describe("Replay-agent scenarios — end-to-end", () => {
  let harness: SyntheticE2EHarness;
  let scenarios: ScenarioFile[] = [];

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic",
      agentBackend: "replay",
      extraGatewayEnv: { OMNESIS_AGENT_REPLAY_IMMEDIATE: "1" },
    });
    await harness.start();

    const universe = loadActiveUniverse();
    const demosDir = getAgentDemosDir(universe);
    if (!demosDir || !existsSync(demosDir)) {
      throw new Error(
        `Universe '${universe.manifest.name}' declares no agent-demos dir; this suite needs one to run.`,
      );
    }

    // A cassette written for another role (the privacy reviewer, say) answers a
    // different kind of session entirely, so driving it as a chat prompt would
    // assert nothing true about it.
    scenarios = readdirSync(demosDir)
      .filter((f) => f.endsWith(".meta.json"))
      .map((f) => ({
        name: f.slice(0, -".meta.json".length),
        meta: JSON.parse(readFileSync(join(demosDir, f), "utf-8")) as ScenarioMeta,
      }))
      .filter((s) => isAgentScenario(s.meta))
      .sort((a, b) => a.name.localeCompare(b.name));
    scenariosRef.current = scenarios;

    // Sync every source before scenarios run. Placeholder resolution at
    // session-create reads `documents` + `people` from the gateway DB —
    // empty DB means every $DOC_/$PERSON_ placeholder ends up unresolved.
    await harness.syncAllSources();

    // Docs land in the documents table synchronously, but people
    // resolution (`people.resolveDocumentPeople`) is a background
    // writer-handler — sync.completed in the collector does NOT imply
    // the people graph is up to date. Wait for every declared
    // `personNames` placeholder across all scenarios to appear in the
    // `people` table before running scenarios, with a generous timeout
    // for slower CI runners.
    const allDeclaredPeople = new Set<string>();
    const allMetas = readdirSync(demosDir)
      .filter((f) => f.endsWith(".meta.json"))
      .map((f) => JSON.parse(readFileSync(join(demosDir, f), "utf-8")) as ScenarioMeta)
      .filter(isAgentScenario);
    for (const m of allMetas) {
      for (const n of m.placeholders?.personNames ?? []) allDeclaredPeople.add(n);
    }
    await waitForPeople(harness, allDeclaredPeople, 60_000);
  }, 240_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("the active universe declares at least one replay scenario", () => {
    expect(scenarios.length, "no scenarios found").toBeGreaterThan(0);
  });

  // One driving test per scenario via `test.each` so failures report
  // per-scenario in the vitest output rather than collapsing to the first
  // assertion to fire. Sequential execution within the suite keeps
  // per-caller SSE-listener pressure flat.
  test.each(EVERY_SCENARIO)(
    "scenario $name routes, streams events, and resolves placeholders",
    async (_placeholder, getScenario) => {
      const scenario = getScenario();
      const trigger = scenario.meta.triggers[0];
      expect(trigger, `${scenario.name}: meta.triggers must be non-empty`).toBeTruthy();

      const events = await runScenario(harness, trigger);

      expect(events.at(-1)?.type, `${scenario.name}: stream must finish`).toBe("agent.message.end");
      expect(
        events.filter((event) => event.type === "agent.text.delta").length,
        `${scenario.name}: text must still stream in chunks`,
      ).toBeGreaterThan(1);

      // Routing — first scenario whose trigger appears in the user message
      // wins; an unmatched message produces a synthetic "no scenario
      // available" reply with no `agent.message.start`. So seeing one
      // means routing fired.
      const messageStart = events.find((e) => e.type === "agent.message.start");
      expect(
        messageStart,
        `${scenario.name}: trigger '${trigger}' did not route to any scenario`,
      ).toBeDefined();

      // No fixture-parse errors, no `fixture_exhausted` on the first turn.
      const errors = events.filter((e) => e.type === "agent.error");
      expect(
        errors.map((e) => e.payload),
        `${scenario.name}: agent.error must not fire on the first turn`,
      ).toEqual([]);

      // The user-message event should echo the trigger we sent.
      const userMsg = events.find((e) => e.type === "agent.user.message");
      expect(userMsg, `${scenario.name}: missing agent.user.message event`).toBeDefined();
      expect(userMsg!.payload.text).toBe(trigger);

      if (!SKIP_PLACEHOLDER_CHECK.has(scenario.name)) {
        // Placeholder resolution — no `$DOC_…` or `$PERSON_…` token
        // (whole-value OR substring) should survive into the event
        // stream. The substitution engine in @omnesis/agent handles
        // both shapes,
        // so any leak now means the gateway's placeholder resolver
        // (replay-factory.ts) couldn't find a matching doc/person row
        // in the live DB at session-create.
        const leaks = collectPlaceholderLeaks(events);
        expect(
          leaks,
          `${scenario.name}: placeholders leaked (declared in meta.json but didn't resolve at session-create)`,
        ).toEqual([]);
      }
    },
    60_000,
  );
});

// `test.each` runs its parameter expansion at file-load time, before the
// `beforeAll` populates `scenarios`. So we expose a fixed table of names
// from the active universe at module-load time and look the meta back up
// lazily inside each test via the `getScenario` thunk.
const EVERY_SCENARIO: Array<[name: string, getScenario: () => ScenarioFile]> = (() => {
  const universe = loadActiveUniverse();
  const demosDir = getAgentDemosDir(universe);
  if (!demosDir || !existsSync(demosDir)) return [];
  return readdirSync(demosDir)
    .filter((f) => f.endsWith(".meta.json"))
    .filter((f) =>
      isAgentScenario(JSON.parse(readFileSync(join(demosDir, f), "utf-8")) as ScenarioMeta),
    )
    .map((f) => f.slice(0, -".meta.json".length))
    .sort()
    .map(
      (name) =>
        [
          name,
          () => {
            const found = scenariosRef.current.find((s) => s.name === name);
            if (!found) throw new Error(`scenario ${name} not found in beforeAll set`);
            return found;
          },
        ] as [string, () => ScenarioFile],
    );
})();

// Shared reference so the `getScenario` thunks created at module-load
// time can see the array `beforeAll` populates.
const scenariosRef: { current: ScenarioFile[] } = { current: [] };

/**
 * Walk an event payload tree and collect every `$DOC_…` / `$PERSON_…`
 * token that survived, including ones embedded as substrings of larger
 * strings (e.g. `"person:$PERSON_X"`). Each distinct leaking token is
 * returned once — multiple occurrences of the same unresolved
 * placeholder collapse to a single entry.
 */
function collectPlaceholderLeaks(events: AgentEvent[]): string[] {
  const PLACEHOLDER_RX = /\$(?:DOC|PERSON)_[\w.-]+/g;
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      const matches = v.match(PLACEHOLDER_RX);
      if (matches) for (const m of matches) out.add(m);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (v && typeof v === "object") {
      for (const sub of Object.values(v)) walk(sub);
    }
  };
  for (const e of events) walk(e.payload);
  return [...out].sort();
}

/**
 * Poll the gateway's `/people/search` endpoint until every declared
 * person name appears in the people graph (or the timeout fires).
 * `resolveDocumentPeople` runs as a background writer-handler after the
 * doc itself is written, so newly-ingested mentions may take a moment
 * to materialize as people rows.
 */
async function waitForPeople(
  harness: SyntheticE2EHarness,
  names: Set<string>,
  timeoutMs: number,
): Promise<void> {
  if (names.size === 0) return;
  const deadline = Date.now() + timeoutMs;
  const remaining = new Set(names);
  while (Date.now() < deadline && remaining.size > 0) {
    for (const name of [...remaining]) {
      // `/people/search` does a case-insensitive LIKE against canonical_name
      // AND aliases — a hit means the resolver will be able to find the
      // person by name-typed alias at session-create. Canonical name is
      // typically an email here (Jane Doe's canonical_name is
      // `jane.doe@acme.example`), so an alias hit is the expected path.
      const res = await fetch(
        `${harness.gatewayUrl}/people/search?q=${encodeURIComponent(name)}&limit=5`,
        { headers: { Authorization: `Bearer ${harness.apiKey}` } },
      );
      if (!res.ok) continue;
      const body = (await res.json()) as { items?: unknown[] };
      const hits = body.items ?? [];
      if (Array.isArray(hits) && hits.length > 0) {
        remaining.delete(name);
      }
    }
    if (remaining.size > 0) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (remaining.size > 0) {
    throw new Error(
      `waitForPeople: timed out waiting for ${[...remaining].join(", ")} to resolve in the people graph after ${timeoutMs}ms`,
    );
  }
}

/**
 * Drive one scenario end-to-end: open SSE, create session, post the trigger
 * message, collect events for that session+message until `agent.message.end`.
 */
async function runScenario(harness: SyntheticE2EHarness, trigger: string): Promise<AgentEvent[]> {
  // Open SSE first so we don't miss events between session-create and
  // the first emit. The SSE endpoint streams ALL events for the caller —
  // we filter by our session id below.
  const sse = await fetch(`${harness.gatewayUrl}/agent/events`, {
    headers: { Authorization: `Bearer ${harness.apiKey}`, Accept: "text/event-stream" },
  });
  if (!sse.ok || !sse.body) {
    throw new Error(`SSE subscribe failed: ${sse.status} ${await sse.text()}`);
  }
  const reader = sse.body.getReader();

  try {
    const sessionRes = await fetch(`${harness.gatewayUrl}/agent/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${harness.apiKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (!sessionRes.ok) {
      throw new Error(`session create failed: ${sessionRes.status} ${await sessionRes.text()}`);
    }
    const session = (await sessionRes.json()) as { sessionId: string };

    const msgRes = await fetch(
      `${harness.gatewayUrl}/agent/sessions/${session.sessionId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${harness.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: trigger }),
      },
    );
    if (!msgRes.ok) {
      throw new Error(`message send failed: ${msgRes.status} ${await msgRes.text()}`);
    }
    const sent = (await msgRes.json()) as { messageId: string };

    return await readEventsUntilMessageEnd(reader, session.sessionId, sent.messageId);
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* best effort */
    }
  }
}

async function readEventsUntilMessageEnd(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  sessionId: string,
  messageId: string,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + PER_SCENARIO_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const readPromise = reader.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<{ done: true; value?: undefined }>((resolve) => {
      timer = setTimeout(() => resolve({ done: true as const }), remaining);
    });
    const next = await Promise.race([readPromise, timeoutPromise]).finally(() =>
      clearTimeout(timer),
    );
    if (next.done || !next.value) break;
    buffer += decoder.decode(next.value, { stream: true });

    // SSE event = lines until a blank line. We only care about `data:` lines.
    let blockEnd: number;
    while ((blockEnd = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, blockEnd);
      buffer = buffer.slice(blockEnd + 2);
      const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      const json = dataLine.slice("data:".length).trim();
      if (!json) continue;
      let parsed: AgentEvent;
      try {
        parsed = JSON.parse(json) as AgentEvent;
      } catch {
        continue;
      }
      const payload = parsed.payload;
      if (!payload || typeof payload !== "object") continue;
      if ((payload as Record<string, unknown>).sessionId !== sessionId) continue;
      events.push(parsed);
      if (
        parsed.type === "agent.message.end" &&
        (payload as Record<string, unknown>).messageId === messageId
      ) {
        return events;
      }
    }
  }
  return events;
}
