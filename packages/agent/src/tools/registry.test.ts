// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import {
  buildBuiltinTools,
  findTool,
  selectNonCitationTools,
  selectGenericSubagentTools,
  selectSubagentTools,
  CITATION_TOOL_NAMES,
} from "./registry.js";
import type {
  DocumentByUrlPort,
  DocumentPort,
  EntityContextPort,
  LoopReadPort,
  PersonPort,
  RecordPort,
  SearchPort,
  SubagentPort,
  WatchPort,
} from "./types.js";

const noopSearch: SearchPort = {
  search: async (input) => ({
    query: input.query,
    durationMs: 0,
    results: [],
  }),
};
const noopDocument: DocumentPort = { fetch: async () => null };
const noopSubagent: SubagentPort = {
  spawn: async (input) => ({
    subagentId: `${input.parentSessionId}.sub.1`,
    specialist: input.specialist ?? "generic",
    status: "running",
  }),
  join: async () => ({ results: [] }),
};

describe("tool registry", () => {
  it("builds at minimum the batch retrieval/citation tools + plan", () => {
    const tools = buildBuiltinTools({
      ports: { search: noopSearch, document: noopDocument },
    });
    // Retrieval + citation are exposed as batch-only tools; a batch of one
    // covers the singular case.
    expect(tools.map((t) => t.name).sort()).toEqual([
      "annotate_many",
      "fetch_many",
      "plan",
      "search_many",
    ]);
  });

  it("findTool returns the handle by name", () => {
    const tools = buildBuiltinTools({
      ports: { search: noopSearch, document: noopDocument },
    });
    expect(findTool(tools, "search_many")?.name).toBe("search_many");
    expect(findTool(tools, "nope")).toBeUndefined();
  });

  it("rejects an out-of-range item argument instead of forwarding it", async () => {
    // The batched item schema is the singular tool's schema, so an argument
    // outside the offered bounds (`limit` is capped at 50) must come back as
    // an argument error rather than reach the search port.
    const ctx = { sessionId: "S", messageId: "M" };
    let called = false;
    const tools = buildBuiltinTools({
      ports: {
        search: {
          search: async (input) => {
            called = true;
            return { query: input.query, durationMs: 0, results: [] };
          },
        },
        document: noopDocument,
      },
    });
    const search = findTool(tools, "search_many")!;
    const r = await search.invoke({ queries: [{ query: "x", limit: 500 }] }, ctx);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("invalid_args");
    expect(called).toBe(false);
  });

  it("registers lookup_people when the person port is provided", () => {
    const noopPerson: PersonPort = {
      lookup: async (input) => ({ query: input.query, durationMs: 0, results: [] }),
    };
    const tools = buildBuiltinTools({
      ports: { search: noopSearch, document: noopDocument, person: noopPerson },
    });
    expect(tools.map((t) => t.name)).toContain("lookup_people");
  });

  it("omits lookup_people when the person port is not provided", () => {
    const tools = buildBuiltinTools({
      ports: { search: noopSearch, document: noopDocument },
    });
    expect(tools.map((t) => t.name)).not.toContain("lookup_people");
  });

  it("registers lookup_document_by_url when the documentByUrl port is provided", () => {
    const noopDocByUrl: DocumentByUrlPort = {
      lookup: async (url) => ({ url, durationMs: 0 }),
    };
    const tools = buildBuiltinTools({
      ports: {
        search: noopSearch,
        document: noopDocument,
        documentByUrl: noopDocByUrl,
      },
    });
    expect(tools.map((t) => t.name)).toContain("lookup_document_by_url");
  });

  it("omits lookup_document_by_url when the documentByUrl port is not provided", () => {
    const tools = buildBuiltinTools({
      ports: { search: noopSearch, document: noopDocument },
    });
    expect(tools.map((t) => t.name)).not.toContain("lookup_document_by_url");
  });

  it("registers generic sub-agent tools regardless of experimental mode", () => {
    for (const experimental of [false, true]) {
      const tools = buildBuiltinTools({
        ports: { search: noopSearch, document: noopDocument, subagent: noopSubagent },
        experimental,
      });
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["spawn_subagent", "join_subagents"]),
      );
    }
  });

  it("registers cite_record when the record port is provided", () => {
    const noopRecord: RecordPort = {
      resolve: async () => {
        throw new Error("unused");
      },
    };
    const tools = buildBuiltinTools({
      ports: { search: noopSearch, document: noopDocument, record: noopRecord },
    });
    expect(tools.map((t) => t.name)).toContain("cite_record");
  });

  it("omits cite_record when the record port is not provided", () => {
    const tools = buildBuiltinTools({
      ports: { search: noopSearch, document: noopDocument },
    });
    expect(tools.map((t) => t.name)).not.toContain("cite_record");
  });

  // Every member supplied and every member throwing, rather than a partial
  // object: an omission is indistinguishable from a forgotten one, where a
  // throw names the case this suite has to grow the day something reaches it.
  const unused = (): never => {
    throw new Error("unused");
  };
  const noopWatch: WatchPort = {
    create: unused,
    update: unused,
    remove: unused,
    list: unused,
    get: unused,
    probe: unused,
  };

  it("registers the watch tools only when the port is wired AND experimental", () => {
    const on = buildBuiltinTools({
      ports: { search: noopSearch, document: noopDocument, watch: noopWatch },
      experimental: true,
    });
    expect(on.map((t) => t.name)).toEqual(expect.arrayContaining(["watch_create", "watch_update"]));

    const off = buildBuiltinTools({
      ports: { search: noopSearch, document: noopDocument, watch: noopWatch },
      experimental: false,
    });
    expect(off.map((t) => t.name)).not.toContain("watch_create");
    expect(off.map((t) => t.name)).not.toContain("watch_update");

    const noPort = buildBuiltinTools({
      ports: { search: noopSearch, document: noopDocument },
      experimental: true,
    });
    expect(noPort.map((t) => t.name)).not.toContain("watch_create");
  });

  /**
   * Raw TriggerSpec authoring was retired from the agent: a spec reaches the
   * store only from the operator, over HTTP or the CLI. Nothing in the
   * registry may reintroduce it under any port/flag combination.
   */
  it("never registers a raw-spec authoring tool", () => {
    for (const experimental of [true, false]) {
      const tools = buildBuiltinTools({
        ports: {
          search: noopSearch,
          document: noopDocument,
          watch: noopWatch,
        },
        experimental,
      });
      const names = tools.map((t) => t.name);
      expect(names).not.toContain("trigger_upsert");
      expect(names).not.toContain("trigger_toggle");
    }
  });

  it("keeps the watch tools off a sub-agent, whatever it asks for", () => {
    const parent = buildBuiltinTools({
      ports: {
        search: noopSearch,
        document: noopDocument,
        watch: noopWatch,
      },
      experimental: true,
    });
    expect(parent.map((t) => t.name)).toContain("watch_create");

    const inherited = selectSubagentTools(parent).map((t) => t.name);
    expect(inherited).not.toContain("watch_create");
    expect(inherited).not.toContain("watch_update");
    // Read-only inspection still crosses — only writes are withheld.
    expect(inherited).toContain("search_many");

    // An explicit allowlist cannot re-grant a write tool.
    const requested = selectSubagentTools(parent, ["watch_create", "search_many"]).map(
      (t) => t.name,
    );
    expect(requested).not.toContain("watch_create");
    expect(requested).toContain("search_many");
  });

  it("gives generic workers a fixed read/evidence tool set without parent orchestration", () => {
    const parent = buildBuiltinTools({
      ports: {
        search: noopSearch,
        document: noopDocument,
        watch: noopWatch,
      },
      experimental: true,
    });
    const generic = selectGenericSubagentTools(parent);
    const names = generic.map((tool) => tool.name);
    expect(names).toContain("search_many");
    expect(names).toContain("annotate_many");
    expect(names).not.toContain("triggers_list");
    expect(names).not.toContain("cite_record");
    expect(names).not.toContain("watch_create");
    expect(names).not.toContain("watch_update");
    expect(names).not.toContain("plan");
    expect(generic.find((tool) => tool.name === "annotate_many")?.description).toContain(
      "evidence for the parent agent",
    );
  });

  it("treats an empty private specialist allowlist as no tools", () => {
    const parent = buildBuiltinTools({
      ports: { search: noopSearch, document: noopDocument },
      experimental: false,
    });
    expect(selectSubagentTools(parent, [])).toEqual([]);
  });

  const noopLoopRead: LoopReadPort = {
    search: async (input) => ({ query: input.query, durationMs: 0, loops: [] }),
    fetch: async () => null,
    list: async () => ({ durationMs: 0, loops: [], truncated: false }),
  };

  it("registers search_loops + fetch_loop + list_loops only when loopRead is wired AND experimental", () => {
    const tools = buildBuiltinTools({
      ports: { search: noopSearch, document: noopDocument, loopRead: noopLoopRead },
      experimental: true,
    });
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["search_loops", "fetch_loop", "list_loops"]),
    );
  });

  it("omits the loop tools when experimental is off, even with the port wired", () => {
    const tools = buildBuiltinTools({
      ports: { search: noopSearch, document: noopDocument, loopRead: noopLoopRead },
      experimental: false,
    });
    expect(tools.map((t) => t.name)).not.toContain("search_loops");
    expect(tools.map((t) => t.name)).not.toContain("fetch_loop");
    expect(tools.map((t) => t.name)).not.toContain("list_loops");
  });

  it("omits the loop tools when experimental is on but the port is absent", () => {
    const tools = buildBuiltinTools({
      ports: { search: noopSearch, document: noopDocument },
      experimental: true,
    });
    expect(tools.map((t) => t.name)).not.toContain("search_loops");
  });

  const noopEntityContext: EntityContextPort = {
    reap: async () => ({
      seed: null,
      loops: [],
      documents: [],
      people: [],
      temporalAnnotations: [],
      truncated: false,
      counts: { loops: 0, documents: 0, people: 0, temporalAnnotations: 0 },
    }),
  };

  it("registers entity_context only when the port is wired AND experimental", () => {
    const tools = buildBuiltinTools({
      ports: { search: noopSearch, document: noopDocument, entityContext: noopEntityContext },
      experimental: true,
    });
    expect(tools.map((t) => t.name)).toContain("entity_context");
  });

  it("omits entity_context when experimental is off, even with the port wired", () => {
    const tools = buildBuiltinTools({
      ports: { search: noopSearch, document: noopDocument, entityContext: noopEntityContext },
      experimental: false,
    });
    expect(tools.map((t) => t.name)).not.toContain("entity_context");
  });

  it("omits entity_context when experimental is on but the port is absent", () => {
    const tools = buildBuiltinTools({
      ports: { search: noopSearch, document: noopDocument },
      experimental: true,
    });
    expect(tools.map((t) => t.name)).not.toContain("entity_context");
  });

  it("selectNonCitationTools drops only the Timeline-citation tools", () => {
    const tools = buildBuiltinTools({
      ports: { search: noopSearch, document: noopDocument },
    });
    const before = tools.map((t) => t.name);
    const trimmed = selectNonCitationTools(tools).map((t) => t.name);
    expect(before).toContain("annotate_many");
    for (const name of CITATION_TOOL_NAMES) {
      expect(trimmed).not.toContain(name);
    }
    // Everything that is not a citation tool survives untouched.
    expect(trimmed).toEqual(before.filter((n) => !CITATION_TOOL_NAMES.has(n)));
  });

  it("selectNonCitationTools is idempotent", () => {
    const tools = buildBuiltinTools({
      ports: { search: noopSearch, document: noopDocument },
    });
    const once = selectNonCitationTools(tools);
    expect(selectNonCitationTools(once).map((t) => t.name)).toEqual(once.map((t) => t.name));
  });
});
