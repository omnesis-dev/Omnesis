// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import {
  renderCognitionRetrievalGuidance,
  renderReadOnlyRetrievalPlaybook,
  renderTemporalRetrievalGuidance,
} from "@omnesis/agent";
import {
  buildSystemPrompt,
  renderSourceRestrictedAnswerSection,
  rendersTimeline,
} from "./system-prompt.js";

describe("buildSystemPrompt — canonical retrieval composition", () => {
  test("embeds the shared core, temporal, and cognition modules verbatim", () => {
    const catalog = [
      {
        sourceId: "fictional-calendar:primary",
        tableName: "fictional_events",
        description: "Invented events.",
        columns: [{ name: "starts_at", type: "TIMESTAMPTZ", nullable: false }],
      },
    ];
    const sourceTypes = ["fictional-calendar"];
    const prompt = buildSystemPrompt({ experimental: true, catalog, sourceTypes });

    expect(prompt).toContain(
      renderReadOnlyRetrievalPlaybook({
        catalog,
        sourceTypes,
        fetchBatchLimit: 16,
        includeTemporal: false,
        includeCognition: false,
      }),
    );
    expect(prompt).toContain(renderTemporalRetrievalGuidance());
    expect(prompt).toContain(renderCognitionRetrievalGuidance());
    expect(prompt.match(/# Search query syntax/g)).toHaveLength(1);
    expect(prompt.match(/\*\*Batch independent work\.\*\*/g)).toHaveLength(1);

    const subagentPrompt = buildSystemPrompt({
      audience: "subagent",
      experimental: true,
      catalog,
      sourceTypes,
    });
    expect(subagentPrompt).toContain(
      renderReadOnlyRetrievalPlaybook({
        catalog,
        sourceTypes,
        fetchBatchLimit: 16,
        includeTemporal: true,
        includeCognition: true,
      }),
    );
  });
});

describe("buildSystemPrompt — read-only loop tools (experimental)", () => {
  test("omits the loop tools + loops section when experimental is off", () => {
    const prompt = buildSystemPrompt({ experimental: false });
    expect(prompt).not.toContain("search_loops");
    expect(prompt).not.toContain("fetch_loop");
    expect(prompt).not.toContain("list_loops");
    expect(prompt).not.toContain("entity_context");
    // The temporal port is wired on the same gate, so a non-experimental
    // gateway must not be told about a tool its registry does not carry.
    expect(prompt).not.toContain("temporal_query");
  });

  test("includes the loop tools + read-only loops section when experimental is on", () => {
    const prompt = buildSystemPrompt({ experimental: true });
    expect(prompt).toContain("`search_loops(query, limit?)`");
    expect(prompt).toContain("`fetch_loop(loopId)`");
    expect(prompt).toContain("`list_loops(limit?)`");
    expect(prompt).toContain("`entity_context(kind, id, depth?)`");
    expect(prompt).toContain(
      "`temporal_query({ from, to, timeZone?, origins?, kinds?, limit?, cursor? })`",
    );
  });
});

describe("buildSystemPrompt — watches (experimental)", () => {
  /**
   * The gate, not the wording: automations are experimental on every client, so
   * the prompt must name the write tools when the toolset carries them and stay
   * silent about them when it does not. Asserting on the tool identifiers keeps
   * this test coupled to the registry rather than to the prose around them.
   */
  test("names the watch tools only in experimental mode", () => {
    const on = buildSystemPrompt({ experimental: true });
    expect(on).toContain("watch_create");
    expect(on).toContain("watch_update");

    const off = buildSystemPrompt({ experimental: false });
    expect(off).not.toContain("watch_create");
    expect(off).not.toContain("watch_update");
    expect(off).not.toContain("triggers_list");
  });
});

describe("buildSystemPrompt — self-memory injection", () => {
  const MARKER = "- (role) ZZUNIQUEPROFILEFACT-CTO-of-Acme";

  test("injects the user's profile in stable and experimental modes", () => {
    const off = buildSystemPrompt({ experimental: false, selfMemory: MARKER });
    // Memory remains useful with the autonomous Brain disabled.
    expect(off).toContain(MARKER);

    const on = buildSystemPrompt({ experimental: true, selfMemory: MARKER });
    expect(on).toContain(MARKER);
  });

  test("treats empty self-memory as absent", () => {
    const absent = buildSystemPrompt({ experimental: true });
    const empty = buildSystemPrompt({ experimental: true, selfMemory: "" });
    const whitespace = buildSystemPrompt({ experimental: true, selfMemory: "   \n  " });
    expect(empty).toBe(absent);
    expect(whitespace).toBe(absent);
  });
});

describe("buildSystemPrompt — citation surface", () => {
  test("omits citation tools and Timeline guidance for external answers", () => {
    const prompt = buildSystemPrompt({ experimental: true, citationSurface: false });
    expect(prompt).toContain("search_many");
    expect(prompt).toContain("fetch_many");
    expect(prompt).not.toContain("annotate_many");
    expect(prompt).not.toContain("cite_record");
  });

  test("keeps citation guidance by default for interactive clients", () => {
    const prompt = buildSystemPrompt({ experimental: true });
    expect(prompt).toContain("`annotate_many");
    expect(prompt).toContain("`cite_record");
  });
});

describe("buildSystemPrompt — sub-agent audience", () => {
  test("shares live retrieval context while withholding parent-only capabilities", () => {
    const prompt = buildSystemPrompt({
      audience: "subagent",
      now: new Date("2026-08-02T18:40:00.000Z"),
      timeZone: "Asia/Tokyo",
      sourceTypes: ["fictional-notes"],
      catalog: [
        {
          tableName: "fictional_metrics",
          displayName: "Fictional metrics",
          description: "Synthetic measurements.",
          sourceId: "fictional-source",
          columns: [
            {
              name: "measured_at",
              type: "TIMESTAMP",
              description: "Measurement time.",
            },
          ],
          primaryKey: ["measured_at"],
          recordCount: 1,
          earliestDate: null,
          latestDate: null,
        },
      ],
      experimental: true,
      selfMemory: "- (role) FICTIONAL-PROFILE-MARKER",
    });

    expect(prompt).toContain("Asia/Tokyo");
    expect(prompt).toContain("fictional-notes");
    expect(prompt).toContain("fictional_metrics");
    expect(prompt).toContain("FICTIONAL-PROFILE-MARKER");
    expect(prompt).toContain("search_loops");
    expect(prompt).toContain("temporal_query");
    expect(prompt).toContain("entity_context");
    expect(prompt).toContain("annotate_many");
    expect(prompt).not.toContain("cite_record");
    expect(prompt).not.toContain("watch_create");
    expect(prompt).not.toContain("spawn_subagent");
    expect(prompt).not.toContain("join_subagents");
  });
});

describe("rendersTimeline", () => {
  /**
   * This is the joint between the prompt and the toolset: the surfaces that
   * render no Timeline also have the citation tools withheld, so if this
   * mapping drifts the model gets guidance for a tool it does not have.
   */
  test("is true only for the interactive chat", () => {
    expect(rendersTimeline("interactive")).toBe(true);
    expect(rendersTimeline("voice")).toBe(false);
    expect(rendersTimeline("answer")).toBe(false);
  });

  test("drives citationSurface, so a voice prompt carries no Timeline guidance", () => {
    const prompt = buildSystemPrompt({
      experimental: true,
      citationSurface: rendersTimeline("voice"),
    });
    expect(prompt).not.toContain("annotate_many");
    // Retrieval still works — only the citation surface goes.
    expect(prompt).toContain("search_many");
  });
});

describe("buildSystemPrompt — the caller's time zone", () => {
  // 2 August 2026, 18:40 UTC. A caller at UTC+01:00 reads that as 19:40; one
  // nine hours ahead is already into the next morning. The same instant, three
  // different things to say — which is why the caller's zone has to travel with
  // the session rather than being assumed from the host.
  const instant = new Date("2026-08-02T18:40:00.000Z");

  test("grounds the prompt in the caller's zone, not the host's", () => {
    const prompt = buildSystemPrompt({ now: instant, timeZone: "Asia/Tokyo" });
    expect(prompt).toContain("Asia/Tokyo");
    expect(prompt).toContain("UTC+09:00");
    // 18:40Z is past midnight in Tokyo — the caller's date is the next day.
    expect(prompt).toContain("Monday, August 3, 2026");
  });

  test("renders the same instant differently for a caller an ocean away", () => {
    const prompt = buildSystemPrompt({ now: instant, timeZone: "America/Los_Angeles" });
    expect(prompt).toContain("America/Los_Angeles");
    expect(prompt).toContain("UTC-07:00");
    expect(prompt).toContain("Sunday, August 2, 2026");
  });

  test("reads the offset in force on the day, not a fixed one", () => {
    const summer = buildSystemPrompt({ now: instant, timeZone: "Europe/London" });
    expect(summer).toContain("UTC+01:00");
    const winter = buildSystemPrompt({
      now: new Date("2026-02-02T18:40:00.000Z"),
      timeZone: "Europe/London",
    });
    expect(winter).toContain("UTC+00:00");
  });

  // The prompt is built once per session, frozen, and prompt-cached. A clock
  // time in it would be wrong within minutes AND would re-key the cache every
  // minute for a block of this size, so the grounding stops at the date.
  test("carries no wall-clock time, which would go stale and bust the cache", () => {
    const morning = buildSystemPrompt({
      now: new Date("2026-08-02T09:15:00.000Z"),
      timeZone: "Europe/London",
    });
    const evening = buildSystemPrompt({
      now: new Date("2026-08-02T21:45:00.000Z"),
      timeZone: "Europe/London",
    });
    expect(morning).toBe(evening);
    expect(morning).not.toContain("10:15");
    expect(morning).not.toContain("22:45");
  });

  // `buildSystemPrompt` takes a plain string, and `Intl` throws on a zone it
  // cannot resolve — so the builder normalizes rather than trusting its caller.
  test("survives an unresolvable zone and uses the ordinary fallback", () => {
    expect(() => buildSystemPrompt({ now: instant, timeZone: "Mars/Olympus_Mons" })).not.toThrow();
    const prompt = buildSystemPrompt({ now: instant, timeZone: "Mars/Olympus_Mons" });
    expect(prompt).toBe(buildSystemPrompt({ now: instant }));
    expect(prompt).not.toContain("Mars/Olympus_Mons");
  });
});

describe("buildSystemPrompt — supersession and past-conversation guidance", () => {
  test("the conflict-resolution rule reaches the built prompt in experimental mode", () => {
    // The tracked-item attachments it governs only exist there.
    const prompt = buildSystemPrompt({ experimental: true });
    expect(prompt).toContain("When a document and what is tracked about it disagree");
    expect(prompt).toContain("is a finding, not noise");
  });

  test("past-conversation guidance is present whether or not experimental is on", () => {
    // Conversations are written back and indexed unconditionally, so an
    // operator running without the loop system still gets the rule.
    for (const experimental of [true, false]) {
      const prompt = buildSystemPrompt({ experimental });
      expect(prompt).toContain("Past conversations in results");
      expect(prompt).toContain("**What the assistant said** is not a source");
    }
  });

  test("each guidance block appears exactly once in the assembled prompt", () => {
    const prompt = buildSystemPrompt({ experimental: true });
    expect(prompt.match(/## Past conversations in results/g)).toHaveLength(1);
    expect(prompt.match(/## When a document and what is tracked about it disagree/g)).toHaveLength(
      1,
    );
  });
});

describe("interactive memory guidance", () => {
  test("offers grounded memory without enabling background tools", () => {
    const prompt = buildSystemPrompt({ experimental: false, memoryWrites: true });
    expect(prompt).toContain("conversation_memory_evidence");
    expect(prompt).toContain("Never use your own reply as user testimony");
    expect(prompt).toContain("annotate_person");
    expect(prompt).not.toContain("watch_create");
    expect(prompt).not.toContain("open_loop_create");
  });
  test("identifies self before any profile memory exists, and handles missing identity", () => {
    const prompt = buildSystemPrompt({
      experimental: false,
      memoryWrites: true,
      selfPersonId: "person_self",
    });
    expect(prompt).toContain('self person ID is "person_self"');
    expect(buildSystemPrompt({ memoryWrites: true })).toContain(
      "self identity has not been established",
    );
    expect(buildSystemPrompt({ selfPersonId: "person_self" })).not.toContain("person_self");
  });
  test("does not offer memory writes to read-only audiences", () => {
    expect(buildSystemPrompt({ experimental: false })).not.toContain(
      "conversation_memory_evidence",
    );
    expect(buildSystemPrompt({ audience: "subagent", memoryWrites: true })).not.toContain(
      "conversation_memory_evidence",
    );
  });
});

describe("buildSystemPrompt — the operator's standing instructions (OMNESIS.md)", () => {
  const MARKER = "ZZUNIQUEOPERATORRULE always report distances in kilometres";

  test("reaches the interactive agent and its sub-agents alike", () => {
    expect(buildSystemPrompt({ operatorInstructions: MARKER })).toContain(MARKER);
    expect(buildSystemPrompt({ audience: "subagent", operatorInstructions: MARKER })).toContain(
      MARKER,
    );
  });

  test("is NOT gated on experimental mode, unlike the self-memory beside it", () => {
    // The cognitive layer that writes self-memory is experimental; a file the
    // operator wrote by hand is not, and a stable gateway must honour it.
    expect(buildSystemPrompt({ experimental: false, operatorInstructions: MARKER })).toContain(
      MARKER,
    );
  });

  test("treats an empty file as absent", () => {
    const absent = buildSystemPrompt({ experimental: true });
    expect(buildSystemPrompt({ experimental: true, operatorInstructions: "" })).toBe(absent);
    expect(buildSystemPrompt({ experimental: true, operatorInstructions: "  \n " })).toBe(absent);
  });

  test("survives the citation-surface subtraction pass", () => {
    const prompt = buildSystemPrompt({
      experimental: true,
      citationSurface: false,
      operatorInstructions: MARKER,
    });
    expect(prompt).toContain(MARKER);
    expect(prompt).not.toContain("# Timeline\n");
  });

  test("the citation subtraction cannot reach inside the operator's own text", () => {
    // That pass drops whole lines by prefix and rewrites sentences at their
    // FIRST occurrence, over the finished string. A file that happens to
    // contain those shapes must come through whole — and must not absorb a
    // rewrite meant for the gateway's own closing note, which would leave the
    // real sentence unrewritten in a prompt that has no Timeline.
    const hostile = [
      "- **`annotate_many(` is how I want you to cite things.",
      "- **`cite_record(` too.",
      "**Cite explicitly.** Always name the sender.",
      "Keep answers grounded in their own data, cited, and brief.",
    ].join("\n");

    const prompt = buildSystemPrompt({ citationSurface: false, operatorInstructions: hostile });
    for (const line of hostile.split("\n")) expect(prompt).toContain(line);

    // The gateway's own closing sentence still got its rewrite: exactly one
    // copy of the edited form, and no un-edited copy left behind.
    expect(prompt).toContain("grounded in their own data and brief");
    const gatewayNote = prompt.slice(0, prompt.indexOf("# The operator's standing instructions"));
    expect(gatewayNote).not.toContain("grounded in their own data, cited, and brief");
  });

  test("keeps operator Markdown structure intact", () => {
    const source = "## Tone\n\n- Be terse.\n- Never open with a greeting.";
    expect(buildSystemPrompt({ operatorInstructions: source })).toContain(source);
  });
});

describe("renderSourceRestrictedAnswerSection — a restricted Answer's grounding", () => {
  const outOfScope =
    "When the question asks about a source or kind of data outside this scope, say plainly that it is outside what this grant can see; never present evidence from a permitted source as if it came from the excluded one.";

  test("names the permitted source types and says what to do outside them", () => {
    const section = renderSourceRestrictedAnswerSection([
      "fictional-chat",
      "fictional-notes",
      "fictional-chat",
    ]);
    expect(section).toContain("# Source-restricted Answer");
    expect(section).toContain("Permitted source types: `fictional-chat`, `fictional-notes`.");
    expect(section).toContain(outOfScope);
    expect(section).toContain("stays attributed to the source it was read from");
  });

  test("says so when the grant reaches no configured source at all", () => {
    const section = renderSourceRestrictedAnswerSection([]);
    expect(section).toContain("No source is currently reachable through this grant.");
    expect(section).not.toContain("Permitted source types:");
    expect(section).toContain(outOfScope);
  });

  test("an unrestricted prompt carries none of it", () => {
    for (const audience of ["interactive", "subagent"] as const) {
      const prompt = buildSystemPrompt({ audience, sourceTypes: ["fictional-chat"] });
      expect(prompt).not.toContain("# Source-restricted Answer");
      expect(prompt).not.toContain("Permitted source types:");
      expect(prompt).not.toContain(outOfScope);
    }
  });
});
