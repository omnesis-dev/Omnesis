// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { parseArgs, type ArgsDef } from "citty";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return { ...actual, gw: vi.fn(), isJSON: true };
});

import { gw, EXIT_AUTH, EXIT_GATEWAY_ERROR, EXIT_USER_ERROR } from "../utils.js";
import { searchCommand } from "./search.js";
import { renderAgentSearch, type AgentSearchResult } from "./search-agent-context.js";

const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const run = searchCommand.run as (context: { args: Record<string, unknown> }) => Promise<void>;
const fx = { images: false, hyperlinks: false, meta: {} };
const agent: AgentSearchResult = {
  kind: "search.results",
  query: "agreement",
  durationMs: 8,
  candidates: 5,
  results: [
    {
      documentId: "doc-first-full-id",
      sourceId: "files:example",
      sourceType: "files",
      title: "Example agreement",
      snippet: "An invented equipment rental agreement.",
      url: "https://example.com/agreement",
      appUrl: "example-app://agreement",
      provenance: {
        summary:
          "Matching extracted text appears on the Example laptop and was shared by a participant.",
        copies: [
          {
            documentId: "doc-first-full-id",
            sourceId: "files:example",
            title: "Example agreement",
            url: "https://example.com/agreement",
            appUrl: "example-app://agreement",
            deviceName: "Example laptop",
            path: "~/Contracts/example.pdf",
          },
          { documentId: "doc-second-full-id", sourceId: "messages:example" },
        ],
        paths: [
          {
            documentIds: ["doc-first-full-id", "doc-second-full-id", "doc-third-full-id"],
            edges: ["inbound:contains", "outbound:url"],
          },
        ],
        truncated: true,
        stopReasons: ["hub"],
      },
    },
  ],
};
const legacy = {
  query: { original: "agreement", effectiveText: "agreement" },
  timing: { totalMs: 6, bm25Ms: 2 },
  results: [{ documentId: "legacy-doc", chunkText: "An ordinary search snippet", score: 0.8 }],
};

beforeEach(() => {
  vi.mocked(gw).mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("search agent context requests", () => {
  test("the option parses explicitly and ordinary search preserves its request and JSON", async () => {
    const args = parseArgs(["agreement", "--agent-context", "-v"], searchCommand.args as ArgsDef);
    expect(args["agent-context"]).toBe(true);
    expect(args.verbose).toBe(true);
    vi.mocked(gw).mockResolvedValue(Response.json(legacy));
    await run({ args: { query: "agreement", limit: "10" } });
    // Ordinary search carries this machine's zone for the query's own dates.
    expect(gw).toHaveBeenCalledExactlyOnceWith("/search", {
      method: "POST",
      body: JSON.stringify({ text: "agreement", limit: 10, timeZone: localZone }),
    });
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string)).toEqual(legacy);
    expect(console.error).not.toHaveBeenCalled();
  });

  test("debug JSON preserves canonical provenance and keeps verbose text off stdout", async () => {
    vi.mocked(gw).mockResolvedValue(Response.json(agent));
    await run({ args: { query: "agreement", limit: "3", "agent-context": true, verbose: true } });
    expect(gw).toHaveBeenCalledExactlyOnceWith("/admin/search/agent-context", {
      method: "POST",
      body: JSON.stringify({ text: "agreement", limit: 3 }),
    });
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string)).toEqual(agent);
    expect(console.error).not.toHaveBeenCalled();
  });

  test.each([404, 405])(
    "an absent debug endpoint (%i) falls back with notice on stderr",
    async (status) => {
      vi.mocked(gw)
        .mockResolvedValueOnce(Response.json({ error: "Unavailable" }, { status }))
        .mockResolvedValueOnce(Response.json(legacy));
      await run({ args: { query: "agreement", limit: "10", "agent-context": true } });
      expect(vi.mocked(gw).mock.calls.map(([path]) => path)).toEqual([
        "/admin/search/agent-context",
        "/search",
      ]);
      expect(JSON.parse(vi.mocked(gw).mock.calls[1]![1]!.body as string)).toMatchObject({
        timeZone: localZone,
      });
      expect(console.error).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("ordinary search"),
      );
      expect(console.log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string)).toEqual(legacy);
    },
  );

  test.each([
    [401, EXIT_AUTH],
    [403, EXIT_AUTH],
    [400, EXIT_USER_ERROR],
    [500, EXIT_GATEWAY_ERROR],
    [503, EXIT_GATEWAY_ERROR],
  ])("debug HTTP %i is not masked by fallback", async (status, code) => {
    vi.mocked(gw).mockResolvedValue(Response.json({ error: "Request refused" }, { status }));
    await expect(
      run({ args: { query: "agreement", limit: "10", "agent-context": true } }),
    ).rejects.toMatchObject({ exitCode: code });
    expect(gw).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  test("transport failures and malformed successful debug payloads do not trigger fallback", async () => {
    vi.mocked(gw).mockRejectedValueOnce(new Error("Transport unavailable"));
    await expect(
      run({ args: { query: "agreement", limit: "10", "agent-context": true } }),
    ).rejects.toThrow("Transport unavailable");
    expect(gw).toHaveBeenCalledTimes(1);
    vi.mocked(gw).mockReset().mockResolvedValue(Response.json(legacy));
    await expect(
      run({ args: { query: "agreement", limit: "10", "agent-context": true } }),
    ).rejects.toMatchObject({ exitCode: EXIT_GATEWAY_ERROR });
    expect(gw).toHaveBeenCalledTimes(1);
  });
});

describe("agent context terminal rendering", () => {
  test("unqualified legacy edge labels do not invent direction", () => {
    const result = structuredClone(agent);
    result.results[0]!.provenance!.paths[0]!.edges[0] = "contains";
    expect(renderAgentSearch(result, false, fx).join("\n")).toContain(
      "doc-first-full-id --[contains]-- doc-second-full-id",
    );
  });
  test("shows prose, full copy identities, source URLs, device/path and directed graph evidence", () => {
    const output = renderAgentSearch(agent, false, fx).join("\n");
    expect(output).toContain(agent.results[0]!.provenance!.summary);
    expect(output).toContain(
      "doc-first-full-id | files:example | Example agreement | Example laptop | ~/Contracts/example.pdf",
    );
    expect(output).toContain("doc-second-full-id | messages:example");
    expect(output).toContain("https://example.com/agreement");
    expect(output).toContain("example-app://agreement");
    expect(output).toContain(
      "doc-first-full-id <--[contains]-- doc-second-full-id --[url]--> doc-third-full-id",
    );
    expect(output).toContain("Context truncated: hub");
    expect(output).not.toContain("NaN");
    expect(output).not.toContain("undefined");
  });

  test("verbose mode shows canonical timing/candidate fields and missing snippets are valid", () => {
    const result: AgentSearchResult = {
      ...agent,
      results: [{ documentId: "doc-1", sourceId: "files:example", sourceType: "files" }],
    };
    const output = renderAgentSearch(result, true, fx).join("\n");
    expect(output).toContain('Query: "agreement"');
    expect(output).toContain("Timing: 8ms");
    expect(output).toContain("Candidates: 5");
    expect(output).not.toContain("NaN");
  });

  test("third-party terminal controls cannot escape into titles, snippets, prose, copy metadata or paths", () => {
    const injected = JSON.parse(
      JSON.stringify(agent).replaceAll("doc-", "doc-\\u001b\\u009b\\u0007"),
    ) as AgentSearchResult;
    injected.results[0]!.title = "Title\u001b\u009b\u0007";
    injected.results[0]!.snippet = "Snippet\n\u001b";
    injected.results[0]!.provenance!.summary = "Summary\u001b";
    const output = renderAgentSearch(injected, false, fx).join("\n");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u009b");
    expect(output).not.toContain("\u0007");
  });
});
