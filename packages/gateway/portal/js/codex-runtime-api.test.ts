// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { cancelCodexRuntimeUpdate, getCodexRuntimeUpdate, startCodexRuntimeUpdate } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("Codex runtime update API wrappers", () => {
  it("uses the gateway-hosted plan, start, dry-run, and cancel routes", async () => {
    const snapshot = { plan: { state: "up-to-date" }, operation: null };
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getCodexRuntimeUpdate();
    await startCodexRuntimeUpdate();
    await startCodexRuntimeUpdate(true);
    await cancelCodexRuntimeUpdate();

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["/admin/inference/codex/runtime/update", "GET"],
      ["/admin/inference/codex/runtime/update", "POST"],
      ["/admin/inference/codex/runtime/update", "POST"],
      ["/admin/inference/codex/runtime/update", "DELETE"],
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({});
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ dryRun: true });
  });
});
