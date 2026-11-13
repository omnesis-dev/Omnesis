// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { parseResponsePayload } from "@omnesis/core";
import { handleHarnessCommand } from "./harness-commands.js";
test("acknowledges engine triggers promptly with real protocol counts and restart semantics", () => {
  const engine = {
    triggerSync: vi.fn().mockReturnValue({
      triggered: ["notes:fixture"],
      skipped: ["calendar:fixture"],
      disabled: [],
      restarting: [],
      unhosted: [],
    }),
  };
  const result = handleHarnessCommand(engine, {
    type: "source.sync",
    payload: { sourceId: "notes:fixture" },
  });
  expect(result).toEqual({ ok: true, triggered: 1, skipped: 1, disabled: 0, restarting: 0 });
  expect(engine.triggerSync).toHaveBeenCalledWith("notes:fixture", { restart: false });
  expect(parseResponsePayload("source.sync", result).ok).toBe(true);
  engine.triggerSync.mockReturnValue({
    triggered: [],
    skipped: [],
    disabled: [],
    restarting: ["notes:fixture"],
    unhosted: [],
    error: "fixture sync refusal",
  });
  expect(
    handleHarnessCommand(engine, {
      type: "source.sync",
      payload: { sourceId: "notes:fixture", restart: true },
    }),
  ).toMatchObject({ ok: false, restarting: 1, error: "fixture sync refusal" });
  expect(engine.triggerSync).toHaveBeenLastCalledWith("notes:fixture", { restart: true });
});
test("retains snapshot acknowledgement and rejects malformed sync or unsupported commands before engine invocation", () => {
  const engine = { triggerSync: vi.fn() };
  expect(handleHarnessCommand(engine, { type: "sources.snapshot", payload: {} })).toEqual({
    ok: true,
    applied: true,
  });
  for (const payload of [null, {}, { sourceId: "" }, { sourceId: "notes:fixture", restart: "yes" }])
    expect(() => handleHarnessCommand(engine, { type: "source.sync", payload })).toThrow(
      "Invalid synthetic source sync payload",
    );
  expect(() => handleHarnessCommand(engine, { type: "source.disable", payload: {} })).toThrow(
    "Unsupported synthetic harness command",
  );
  expect(engine.triggerSync).not.toHaveBeenCalled();
});
