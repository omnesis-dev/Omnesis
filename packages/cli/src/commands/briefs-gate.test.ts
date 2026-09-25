// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Reads (`loops`, `runs`, …) serve stored brain history whenever the
// feature is visible, so they refuse only when hidden; the one mutation
// (`notes --wipe`) still needs the feature active. Pins both predicates
// against a stubbed `/status` payload.

import { describe, expect, it, vi } from "vitest";

const statusPayload: { value: unknown } = { value: null };

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    gatewayJson: vi.fn((path: string) => {
      if (path === "/status") return Promise.resolve(statusPayload.value);
      return Promise.reject(new Error(`unexpected fetch ${path}`));
    }),
  };
});

import { CliError } from "../utils.js";
import { assertBrainVisible, assertBriefsActive } from "./briefs.js";

async function rejectsCliError(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    return String((err as CliError).message);
  }
  throw new Error("expected a CliError");
}

describe("brain CLI gates", () => {
  it("reads pass while visible-but-inactive; writes refuse", async () => {
    statusPayload.value = {
      brain: { visible: true, enabled: true, modelAssigned: false, active: false },
    };
    await assertBrainVisible();
    const message = await rejectsCliError(() => assertBriefsActive());
    expect(message).toContain("currently inactive");
    expect(message).toContain("background-agent model");
  });

  it("both refuse when the feature is hidden (experimental off)", async () => {
    statusPayload.value = {
      brain: { visible: false, enabled: false, modelAssigned: false, active: false },
    };
    const visibleMessage = await rejectsCliError(() => assertBrainVisible());
    expect(visibleMessage).toContain("currently hidden");
    expect(visibleMessage).toContain("OMNESIS_EXPERIMENTAL=1");
    await rejectsCliError(() => assertBriefsActive());
  });

  it("both pass while active", async () => {
    statusPayload.value = {
      brain: { visible: true, enabled: true, modelAssigned: true, active: true },
    };
    await assertBrainVisible();
    await assertBriefsActive();
  });

  it("reads the legacy `briefs` key when `brain` is absent", async () => {
    statusPayload.value = {
      briefs: { visible: true, enabled: true, modelAssigned: false, active: false },
    };
    await assertBrainVisible();
    await rejectsCliError(() => assertBriefsActive());
  });

  it("both refuse when no gate is advertised", async () => {
    statusPayload.value = {};
    await rejectsCliError(() => assertBrainVisible());
    await rejectsCliError(() => assertBriefsActive());
  });
});
