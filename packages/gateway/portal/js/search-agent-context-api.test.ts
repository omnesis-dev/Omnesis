// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error — plain-JS portal API.
import { searchAgentContext } from "./api.js";
afterEach(() => vi.unstubAllGlobals());
it("requests operator diagnostics separately with the same text and limit", async () => {
  const payload = { kind: "search.results", query: "agreement", durationMs: 1, results: [] };
  const fetch = vi.fn(async () => Response.json(payload)); vi.stubGlobal("fetch", fetch);
  await expect(searchAgentContext("agreement", 12)).resolves.toEqual(payload);
  expect(fetch).toHaveBeenCalledWith("/admin/search/agent-context", expect.objectContaining({ method: "POST", body: JSON.stringify({ text: "agreement", limit: 12 }) }));
});
it("retains HTTP failure status for the nonblocking diagnostic fallback", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("Unavailable", { status: 403 })));
  await expect(searchAgentContext("agreement")).rejects.toMatchObject({ status: 403 });
});
