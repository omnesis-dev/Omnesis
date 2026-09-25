// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { EventBus, type DocumentProjection } from "../events.js";
import { DEFAULT_NEAR_DUP_CONFIG } from "./config.js";
import { decideUpsertReason, subscribeNearDupInbox } from "./event-handler.js";
import type { ResolvedNearDupConfig } from "./config.js";

function proj(id: string, documentType: string | null): DocumentProjection {
  return {
    id,
    providerId: "p",
    sourceId: "s",
    externalId: id,
    documentType,
    title: "title",
    contentHash: "h",
    metadata: {},
    sourceCreatedAt: "2025-01-01T00:00:00Z",
    sourceUpdatedAt: "2025-01-01T00:00:00Z",
    people: [],
  };
}

describe("decideUpsertReason", () => {
  test("insert: before === null + eligible type → 'insert'", () => {
    const r = decideUpsertReason(
      {
        before: null,
        after: proj("a", "email"),
        afterContent: "body",
        changedFields: [],
        contentChanged: true,
      },
      DEFAULT_NEAR_DUP_CONFIG,
    );
    expect(r).toBe("insert");
  });

  test("update with content change → 'update'", () => {
    const r = decideUpsertReason(
      {
        before: proj("a", "email"),
        after: proj("a", "email"),
        afterContent: "body",
        changedFields: ["contentHash"],
        contentChanged: true,
      },
      DEFAULT_NEAR_DUP_CONFIG,
    );
    expect(r).toBe("update");
  });

  test("update without content change (metadata-only) → null", () => {
    const r = decideUpsertReason(
      {
        before: proj("a", "email"),
        after: proj("a", "email"),
        afterContent: "body",
        changedFields: ["title"],
        contentChanged: false,
      },
      DEFAULT_NEAR_DUP_CONFIG,
    );
    expect(r).toBeNull();
  });

  test("ineligible doc type → null", () => {
    const r = decideUpsertReason(
      {
        before: null,
        after: proj("a", "contact"),
        afterContent: "body",
        changedFields: [],
        contentChanged: true,
      },
      DEFAULT_NEAR_DUP_CONFIG,
    );
    expect(r).toBeNull();
  });

  test("null documentType → null", () => {
    const r = decideUpsertReason(
      {
        before: null,
        after: proj("a", null),
        afterContent: "body",
        changedFields: [],
        contentChanged: true,
      },
      DEFAULT_NEAR_DUP_CONFIG,
    );
    expect(r).toBeNull();
  });

  test("disabled config → null even for eligible types", () => {
    const disabled: ResolvedNearDupConfig = { ...DEFAULT_NEAR_DUP_CONFIG, enabled: false };
    const r = decideUpsertReason(
      {
        before: null,
        after: proj("a", "email"),
        afterContent: "body",
        changedFields: [],
        contentChanged: true,
      },
      disabled,
    );
    expect(r).toBeNull();
  });
});

function fakeBuffer() {
  const add = vi.fn();
  return { add, buffer: { add } };
}

describe("subscribeNearDupInbox", () => {
  test("buffers an eligible insert (no writer op on the hot path)", () => {
    const bus = new EventBus();
    const { add, buffer } = fakeBuffer();
    subscribeNearDupInbox({
      eventBus: bus,
      buffer,
      getConfig: () => DEFAULT_NEAR_DUP_CONFIG,
    });
    bus.emit("document.upserted", {
      before: null,
      after: proj("a", "email"),
      afterContent: "body",
      changedFields: [],
      contentChanged: true,
    });
    // Synchronous — the subscriber only touches the in-memory buffer.
    expect(add).toHaveBeenCalledWith("a", "insert");
  });

  test("skips ineligible doc types entirely", () => {
    const bus = new EventBus();
    const { add, buffer } = fakeBuffer();
    subscribeNearDupInbox({
      eventBus: bus,
      buffer,
      getConfig: () => DEFAULT_NEAR_DUP_CONFIG,
    });
    bus.emit("document.upserted", {
      before: null,
      after: proj("a", "contact"),
      afterContent: "body",
      changedFields: [],
      contentChanged: true,
    });
    expect(add).not.toHaveBeenCalled();
  });

  test("config is re-read on every event (eligibility flip works live)", () => {
    const bus = new EventBus();
    const { add, buffer } = fakeBuffer();
    // Start with email ineligible, then flip live.
    let eligibleTypes = new Set<string>(["note"]);
    subscribeNearDupInbox({
      eventBus: bus,
      buffer,
      getConfig: () => ({ ...DEFAULT_NEAR_DUP_CONFIG, eligibleDocTypes: eligibleTypes }),
    });
    bus.emit("document.upserted", {
      before: null,
      after: proj("a", "email"),
      afterContent: "body",
      changedFields: [],
      contentChanged: true,
    });
    expect(add).not.toHaveBeenCalled();
    // Live config change — email now eligible.
    eligibleTypes = new Set<string>(["note", "email"]);
    bus.emit("document.upserted", {
      before: null,
      after: proj("b", "email"),
      afterContent: "body",
      changedFields: [],
      contentChanged: true,
    });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith("b", "insert");
  });

  test("unsubscribe stops further buffering", () => {
    const bus = new EventBus();
    const { add, buffer } = fakeBuffer();
    const off = subscribeNearDupInbox({
      eventBus: bus,
      buffer,
      getConfig: () => DEFAULT_NEAR_DUP_CONFIG,
    });
    bus.emit("document.upserted", {
      before: null,
      after: proj("a", "email"),
      afterContent: "body",
      changedFields: [],
      contentChanged: true,
    });
    expect(add).toHaveBeenCalledTimes(1);
    off();
    bus.emit("document.upserted", {
      before: null,
      after: proj("b", "email"),
      afterContent: "body",
      changedFields: [],
      contentChanged: true,
    });
    expect(add).toHaveBeenCalledTimes(1);
  });
});
