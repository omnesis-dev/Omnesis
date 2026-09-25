// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import {
  PROTOCOL_VERSION,
  wsCommandSchemas,
  wsEventSchemas,
  isKnownCommandType,
  isKnownEventType,
  parseRequestPayload,
  parseResponsePayload,
  parseEventPayload,
  type WsCommandType,
  type WsEventType,
  type WsRequestPayload,
  type WsResponsePayload,
  type WsEventPayload,
} from "./ws-messages.js";

describe("PROTOCOL_VERSION", () => {
  test("keeps the general device protocol independent from integration delivery v3", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect("subscription.prepare" in wsCommandSchemas).toBe(true);
    expect("subscription.commit" in wsCommandSchemas).toBe(true);
    expect("subscription.cancel" in wsCommandSchemas).toBe(true);
    expect("subscription.deliver" in wsCommandSchemas).toBe(false);
    expect("action.deliver" in wsCommandSchemas).toBe(false);
  });

  test("pins integration delivery itself to protocol v3", () => {
    const parsed = parseRequestPayload("subscription.commit", {
      protocolVersion: 3,
      deliveryId: "sdel_fictional",
    });
    expect(parsed.ok).toBe(true);
    expect(
      parseRequestPayload("subscription.commit", {
        protocolVersion: PROTOCOL_VERSION,
        deliveryId: "sdel_fictional",
      }).ok,
    ).toBe(false);
  });
});

describe("registry coverage", () => {
  test("device updates accept exactly one validated release or commit target", () => {
    const commit = "a".repeat(40);
    expect(parseRequestPayload("device.update", { version: "0.5.4" }).ok).toBe(true);
    expect(parseRequestPayload("device.update", { commit }).ok).toBe(true);
    expect(parseRequestPayload("device.update", { version: "0.5.4", commit }).ok).toBe(false);
    expect(parseRequestPayload("device.update", { commit: "abc" }).ok).toBe(false);
    expect(parseEventPayload("device.update.result", { commit, state: "installed" }).ok).toBe(true);
    expect(
      parseEventPayload("device.update.result", { version: "0.5.4", commit, state: "installed" })
        .ok,
    ).toBe(false);
  });

  test("hello is a known command", () => {
    expect(isKnownCommandType("hello")).toBe(true);
  });

  test("ping is a known event", () => {
    expect(isKnownEventType("ping")).toBe(true);
  });

  test("push.available is a content-free event", () => {
    expect(isKnownEventType("push.available")).toBe(true);
    expect(parseEventPayload("push.available", {}).ok).toBe(true);
    expect(parseEventPayload("push.available", { kind: "brief" }).ok).toBe(false);
  });

  test("unknown command type is rejected", () => {
    expect(isKnownCommandType("not.a.real.command")).toBe(false);
  });

  test("unknown event type is rejected", () => {
    expect(isKnownEventType("not.a.real.event")).toBe(false);
  });

  test("every registry entry has request and response schemas", () => {
    for (const [name, spec] of Object.entries(wsCommandSchemas)) {
      expect(spec, `${name} missing spec`).toBeDefined();
      expect(spec.request, `${name} missing request`).toBeDefined();
      expect(spec.response, `${name} missing response`).toBeDefined();
    }
  });

  test("every event has a schema", () => {
    for (const [name, schema] of Object.entries(wsEventSchemas)) {
      expect(schema, `${name} missing schema`).toBeDefined();
    }
  });
});

describe("answer completion delivery", () => {
  const delivery = {
    protocolVersion: 4,
    deliveryId: "acdel_fictional",
    taskId: "task_fictional",
    nativeConversationId: "native_fictional",
  };

  test("accepts a task-identity-only completion wake", () => {
    expect(parseRequestPayload("answer-completion.prepare", delivery).ok).toBe(true);
  });

  test("rejects the retired completion bearer shape", () => {
    expect(
      parseRequestPayload("answer-completion.prepare", {
        ...delivery,
        answer: { token: "retired", endpoint: "/mcp", expiresAt: 1_800_000_000_000 },
      }).ok,
    ).toBe(false);
  });

  test("rejects the old protocol version", () => {
    expect(
      parseRequestPayload("answer-completion.prepare", {
        ...delivery,
        protocolVersion: 3,
      }).ok,
    ).toBe(false);
  });
});

describe("hello handshake schemas", () => {
  test("accepts a well-formed request", () => {
    const r = parseRequestPayload("hello", {
      token: "omn_abc",
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { platform: "ios" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.token).toBe("omn_abc");
      expect(r.value.protocolVersion).toBe(PROTOCOL_VERSION);
    }
  });

  test("accepts source-type capability arrays", () => {
    const r = parseRequestPayload("hello", {
      token: "omn_abc",
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        hostableSourceTypes: ["gmail"],
        pushBasedSourceTypes: ["browser"],
      },
    });
    expect(r.ok).toBe(true);
  });

  test("accepts only the affirmative device-doctor capability", () => {
    expect(
      parseRequestPayload("hello", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { deviceDoctor: true },
      }).ok,
    ).toBe(true);
    expect(
      parseRequestPayload("hello", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { deviceDoctor: false },
      }).ok,
    ).toBe(false);
  });

  test("rejects line and bidi controls in device-doctor result and refusal text", () => {
    for (const unsafe of ["\n", "\u2028", "\u2029", "\u061c", "\u200e", "\u200f", "\u202e"]) {
      expect(
        parseResponsePayload("device.doctor", {
          accepted: false,
          reason: `refused${unsafe}with another line`,
        }).ok,
      ).toBe(false);
      expect(
        parseEventPayload("device.doctor.result", {
          runId: "run-1",
          error: `failed${unsafe}override`,
        }).ok,
      ).toBe(false);
    }
  });

  test("rejects malformed source-type capability entries", () => {
    const r = parseRequestPayload("hello", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        pushBasedSourceTypes: ["Browser"],
      },
    });
    expect(r.ok).toBe(false);
  });

  test("accepts a tokenless hello because tokens authenticate the WS upgrade", () => {
    const r = parseRequestPayload("hello", { protocolVersion: PROTOCOL_VERSION });
    expect(r.ok).toBe(true);
  });

  test("rejects a missing protocolVersion", () => {
    const r = parseRequestPayload("hello", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toContain("protocolversion");
  });

  test("accepts the response with all required fields", () => {
    const r = parseResponsePayload("hello", {
      deviceId: "d1",
      scopes: ["admin"],
      deviceName: "Macbook",
      deviceKind: "collector",
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(r.ok).toBe(true);
  });
});

describe("source.add schemas", () => {
  test("accepts a request with one accountId", () => {
    const r = parseRequestPayload("source.add", {
      descriptorId: "gmail",
      accountIds: ["a@b.com"],
    });
    expect(r.ok).toBe(true);
  });

  test("rejects a request with empty accountIds", () => {
    const r = parseRequestPayload("source.add", {
      descriptorId: "gmail",
      accountIds: [],
    });
    expect(r.ok).toBe(false);
  });

  test("rejects a request without descriptorId", () => {
    const r = parseRequestPayload("source.add", {
      accountIds: ["a@b.com"],
    });
    expect(r.ok).toBe(false);
  });
});

describe("sync.status event", () => {
  test("accepts a typical syncing payload", () => {
    const r = parseEventPayload("sync.status", {
      sourceId: "gmail:a@b.com",
      state: "syncing",
      progress: { processed: 10, total: 100, percentComplete: 10 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.state).toBe("syncing");
      expect(r.value.progress?.processed).toBe(10);
    }
  });

  test("rejects an unknown state", () => {
    const r = parseEventPayload("sync.status", {
      sourceId: "gmail:a@b.com",
      state: "weird",
    });
    expect(r.ok).toBe(false);
  });

  test("rejects a missing sourceId", () => {
    const r = parseEventPayload("sync.status", { state: "syncing" });
    expect(r.ok).toBe(false);
  });

  // The freshness block is how a source's claim about its own local data feed
  // reaches the gateway. A field-name or type mismatch here would be invisible
  // on both sides — the gateway would simply never derive a `stale` warning.
  test("round-trips a freshness declaration", () => {
    const r = parseEventPayload("sync.status", {
      sourceId: "example:local",
      state: "completed",
      freshness: {
        quietPeriodMs: 1_209_600_000,
        hint: "Open the app to resume syncing.",
        processRunning: false,
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.freshness?.quietPeriodMs).toBe(1_209_600_000);
      expect(r.value.freshness?.processRunning).toBe(false);
      expect(r.value.freshness?.hint).toBe("Open the app to resume syncing.");
    }
  });

  // "Could not determine" must survive the wire as absent rather than being
  // coerced to false, which the gateway would read as "definitely not running".
  test("an omitted processRunning stays undefined rather than becoming false", () => {
    const r = parseEventPayload("sync.status", {
      sourceId: "example:local",
      state: "completed",
      freshness: { quietPeriodMs: 1000, hint: "Open the app." },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.freshness?.processRunning).toBeUndefined();
  });

  test("rejects a non-positive quiet period", () => {
    for (const quietPeriodMs of [0, -1]) {
      const r = parseEventPayload("sync.status", {
        sourceId: "example:local",
        state: "completed",
        freshness: { quietPeriodMs, hint: "Open the app." },
      });
      expect(r.ok).toBe(false);
    }
  });

  test("a payload without freshness stays valid — most sources declare none", () => {
    const r = parseEventPayload("sync.status", {
      sourceId: "gmail:a@b.com",
      state: "completed",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.freshness).toBeUndefined();
  });
});

describe("auth.update / auth.complete events", () => {
  test("auth.update accepts an url frame", () => {
    const r = parseEventPayload("auth.update", {
      flowId: "f1",
      type: "url",
      url: "https://accounts.google.com/...",
    });
    expect(r.ok).toBe(true);
  });

  test("auth.complete with ok=false carries an error", () => {
    const r = parseEventPayload("auth.complete", {
      flowId: "f1",
      ok: false,
      error: "cancelled",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.ok).toBe(false);
  });

  test("auth.update without flowId is rejected", () => {
    const r = parseEventPayload("auth.update", { type: "url" });
    expect(r.ok).toBe(false);
  });
});

describe("device doctor protocol", () => {
  const report = {
    ok: true,
    summary: { errors: 0, warnings: 0 },
    checks: [
      {
        id: "storage.db",
        section: "Storage",
        status: "not-applicable" as const,
        message: "Gateway database size is evaluated only on the gateway host",
      },
    ],
  };

  test("accepts a bounded run request and acknowledgement", () => {
    expect(parseRequestPayload("device.doctor", { runId: "doctor_01.fixture" }).ok).toBe(true);
    expect(
      parseResponsePayload("device.doctor", {
        accepted: false,
        reason: "another doctor run is already active",
      }).ok,
    ).toBe(true);
  });

  test("accepts exactly one report or error result", () => {
    expect(parseEventPayload("device.doctor.result", { runId: "doctor_01", report }).ok).toBe(true);
    expect(
      parseEventPayload("device.doctor.result", { runId: "doctor_02", error: "scan failed" }).ok,
    ).toBe(true);
    expect(
      parseEventPayload("device.doctor.result", {
        runId: "doctor_03",
        report,
        error: "ambiguous",
      }).ok,
    ).toBe(false);
  });

  test("rejects unbounded identifiers, errors, and malformed reports", () => {
    expect(parseRequestPayload("device.doctor", { runId: "x".repeat(129) }).ok).toBe(false);
    expect(
      parseEventPayload("device.doctor.result", {
        runId: "doctor_01",
        error: "x".repeat(2_001),
      }).ok,
    ).toBe(false);
    expect(
      parseEventPayload("device.doctor.result", {
        runId: "doctor_01",
        report: { ...report, summary: { errors: 1, warnings: 0 } },
      }).ok,
    ).toBe(false);
  });
});

describe("type-level wiring", () => {
  test("WsCommandType is a string union of registered keys", () => {
    // Compile-time assertion via a no-op assignment.
    const valid: WsCommandType = "source.add";
    expect(typeof valid).toBe("string");
  });

  test("WsRequestPayload<K> resolves to the request type", () => {
    const payload: WsRequestPayload<"source.add"> = {
      descriptorId: "gmail",
      accountIds: ["a@b.com"],
    };
    expect(payload.descriptorId).toBe("gmail");
  });

  test("WsResponsePayload<K> resolves to the response type", () => {
    const payload: WsResponsePayload<"source.add"> = {
      sourceIds: ["gmail:a@b.com"],
    };
    expect(payload.sourceIds.length).toBe(1);
  });

  test("WsEventType / WsEventPayload<K> resolve correctly", () => {
    const ev: WsEventType = "sync.status";
    const payload: WsEventPayload<"sync.status"> = {
      sourceId: "gmail:a@b.com",
      state: "completed",
    };
    expect(ev).toBe("sync.status");
    expect(payload.state).toBe("completed");
  });
});

describe("error formatting", () => {
  test("returns a path-prefixed message on validation failure", () => {
    const r = parseRequestPayload("source.discover", {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/descriptorId/);
    }
  });
});
