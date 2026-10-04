// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { FindSearchService } from "./service.js";
import type { DecisionCapability } from "@omnesis/core";
import type { SearchResponse } from "../types.js";
import type { FindStreamEvent } from "./types.js";

function response(): SearchResponse {
  return {
    results: [
      {
        documentId: "doc-web",
        title: "Ownership guide",
        sourceUrl: "https://example.org/guide",
        sourceId: "web:browser",
        chunkText: "Rust ownership guide",
        sourceCreatedAt: "2026-01-01T00:00:00Z",
      },
      {
        documentId: "doc-native",
        title: "Ownership notes",
        sourceUrl: "mobilenotes://note/fictional",
        sourceId: "apple-notes:local",
        chunkText: "Rust ownership notes",
        sourceCreatedAt: "2026-01-01T00:00:00Z",
      },
    ],
  } as unknown as SearchResponse;
}

function fixture(getDecision: () => DecisionCapability | null = () => null) {
  const search = vi.fn().mockResolvedValue(response());
  const getAgentService = vi.fn().mockReturnValue(null);
  const service = new FindSearchService({
    searchPipeline: { search },
    getDecision,
    getAgentService,
  });
  const events: FindStreamEvent[] = [];
  const controller = new AbortController();
  return {
    service,
    search,
    getAgentService,
    events,
    controller,
    execution: { signal: controller.signal, emit: (event: FindStreamEvent) => events.push(event) },
  };
}

describe("Find search orchestration", () => {
  it("announces direct routing before ordinary results and leaves browser eligibility to the client", async () => {
    const f = fixture();
    await f.service.search({ text: "ownership", limit: 25 }, f.execution);
    expect(f.events.map((event) => event.type)).toEqual([
      "find.decision",
      "find.results",
      "find.complete",
    ]);
    const results = f.events.find((event) => event.type === "find.results");
    expect(
      results?.type === "find.results" && results.payload.results.map((hit) => hit.sourceUrl),
    ).toEqual(["https://example.org/guide", "mobilenotes://note/fictional"]);
    expect(f.getAgentService).not.toHaveBeenCalled();
    expect(f.search).toHaveBeenCalledWith({ text: "ownership", limit: 25 });
  });

  it("shows the actual agentic decision when the agent is unavailable, without claiming a completed search", async () => {
    const model: DecisionCapability = {
      modelId: "replay",
      dispose() {},
      decide: vi.fn().mockResolvedValue({
        model: "replay",
        answers: {
          route: { type: "choice", choice: "agentic" },
          reason: { type: "choice", choice: "calculation" },
        },
      }),
    };
    const f = fixture(() => model);
    await f.service.search({ text: "my longest run" }, f.execution);
    expect(f.events.map((event) => event.type)).toEqual(["find.decision", "find.error"]);
    expect(f.search).not.toHaveBeenCalled();
    expect(f.events[0]).toMatchObject({ payload: { mode: "agentic", status: "decided" } });
  });

  it("does not expose a late index result after cancellation", async () => {
    const f = fixture();
    let resolve: (response: SearchResponse) => void = () => {};
    f.search.mockImplementation(
      () =>
        new Promise<SearchResponse>((done) => {
          resolve = done;
        }),
    );
    const running = f.service.search({ text: "ownership" }, f.execution);
    await vi.waitFor(() => expect(f.search).toHaveBeenCalled());
    f.controller.abort();
    resolve(response());
    await expect(running).rejects.toThrow();
    expect(f.events.map((event) => event.type)).toEqual(["find.decision"]);
  });

  it("reports an unavailable index rather than a false empty success", async () => {
    const service = new FindSearchService({ getDecision: () => null, getAgentService: () => null });
    const events: FindStreamEvent[] = [];
    await service.search(
      { text: "ownership" },
      { signal: new AbortController().signal, emit: (event) => events.push(event) },
    );
    expect(events.map((event) => event.type)).toEqual(["find.decision", "find.error"]);
  });
});
