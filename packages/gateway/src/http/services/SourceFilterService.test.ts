// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { SourceFilterService } from "./SourceFilterService.js";
import type { ScopeEditorResult } from "../../access/scope-editor-reads.js";
import type { SourceScopeOptions } from "@omnesis/types";

afterEach(() => vi.unstubAllEnvs());
test("interactive scans apply backpressure and release capacity after worker failure", async () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  const pending: Array<{
    resolve: (result: ScopeEditorResult<SourceScopeOptions>) => void;
    reject: (error: Error) => void;
  }> = [];
  const read = vi.fn(
    () =>
      new Promise<ScopeEditorResult<SourceScopeOptions>>((resolve, reject) =>
        pending.push({ resolve, reject }),
      ),
  );
  const service = new SourceFilterService({
    sourceScopeOptions: read,
    sourceScopePreview: async () => ({ ok: false, error: "source-not-found" }),
  });
  const request = { sourceId: "fictional:one", kind: "conversation" as const };
  const first = service.options(request);
  const second = service.options(request);
  const third = service.options(request);
  const fourth = service.options(request);
  await expect(service.options(request)).rejects.toMatchObject({ status: 503 });
  expect(read).toHaveBeenCalledTimes(4);
  const failed = expect(first).rejects.toThrow("Synthetic worker failure");
  pending[0]!.reject(new Error("Synthetic worker failure"));
  await failed;
  const replacement = service.options(request);
  expect(read).toHaveBeenCalledTimes(5);
  const value: SourceScopeOptions = {
    sourceId: request.sourceId,
    sourceType: "fictional",
    scopes: { items: [] },
    readiness: [],
    items: [],
  };
  for (const entry of pending.slice(1)) entry.resolve({ ok: true, value });
  expect(await Promise.all([second, third, fourth, replacement])).toEqual([
    value,
    value,
    value,
    value,
  ]);
});
