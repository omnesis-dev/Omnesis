// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Smoke test for the subpath exports declared in `package.json#exports`.
 *
 * Each subpath barrel re-exports a known set of symbols; this test
 * imports each barrel and verifies the headline exports resolve.
 * If a subpath drops a symbol that consumers depend on (or a barrel
 * regresses to bare `re-export *` and silently changes shape), the
 * test fails fast.
 *
 * The bigger architectural test — that the subpath structure stays
 * coherent over time — is enforced socially via the per-subpath
 * docstring (each barrel says what belongs there and what doesn't).
 */

import { describe, expect, test } from "vitest";

describe("@omnesis/core/protocol", () => {
  test("re-exports the WS envelope constructors + typed registry", async () => {
    const mod = await import("./protocol.js");
    expect(typeof mod.makeCommand).toBe("function");
    expect(typeof mod.makeResponseOk).toBe("function");
    expect(typeof mod.makeEvent).toBe("function");
    expect(typeof mod.isWsCommand).toBe("function");
    expect(typeof mod.parseRequestPayload).toBe("function");
    expect(typeof mod.PROTOCOL_VERSION).toBe("number");
    expect(mod.wsCommandSchemas).toBeDefined();
    expect(mod.wsEventSchemas).toBeDefined();
  });
});

describe("@omnesis/core/config", () => {
  test("re-exports the unified omnesisConfigSchema + helpers", async () => {
    const mod = await import("./config.js");
    expect(typeof mod.validateConfig).toBe("function");
    expect(typeof mod.applyMergePatch).toBe("function");
    expect(mod.omnesisConfigSchema).toBeDefined();
    // Sanity: the schema is a zod object with parse + safeParse
    const parsed = mod.omnesisConfigSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });
});

describe("@omnesis/core/sources", () => {
  test("re-exports the defineSource contract + sync helpers", async () => {
    const mod = await import("./sources.js");
    expect(typeof mod.defineSource).toBe("function");
    expect(typeof mod.defineProvider).toBe("function");
    expect(typeof mod.defineStructuredSource).toBe("function");
    expect(typeof mod.syncPage).toBe("function");
    expect(typeof mod.serializeDescriptor).toBe("function");
    expect(typeof mod.makeCursorValidator).toBe("function");
  });
});

describe("@omnesis/core/people", () => {
  test("re-exports the normalisation helpers", async () => {
    const mod = await import("./people.js");
    expect(typeof mod.normalizeEmail).toBe("function");
    expect(typeof mod.normalizePhone).toBe("function");
    expect(typeof mod.parseEmailHeader).toBe("function");
    expect(typeof mod.countryNameToISO2).toBe("function");
  });
});

describe("@omnesis/core/models", () => {
  test("re-exports the catalog + manifest API", async () => {
    const mod = await import("./models.js");
    expect(mod.MODEL_ROLES).toBeDefined();
    expect(mod.CATALOG).toBeDefined();
    expect(typeof mod.loadManifest).toBe("function");
    expect(typeof mod.getCatalogEntry).toBe("function");
    expect(typeof mod.defaultForRole).toBe("function");
  });
});

describe("@omnesis/core/terminal", () => {
  test("re-exports the terminal-fx primitives", async () => {
    const mod = await import("./terminal.js");
    expect(typeof mod.imagesSupported).toBe("function");
    expect(typeof mod.hyperlinksSupported).toBe("function");
    expect(typeof mod.inlineImage).toBe("function");
    expect(typeof mod.hyperlink).toBe("function");
  });
});

describe("@omnesis/core/devices", () => {
  test("re-exports device + scope branded constructors", async () => {
    const mod = await import("./devices.js");
    expect(typeof mod.DeviceId).toBe("function");
    expect(typeof mod.TokenId).toBe("function");
    expect(typeof mod.parseScope).toBe("function");
    expect(typeof mod.scopeSatisfies).toBe("function");
    expect(mod.SCOPE_READ).toBeDefined();
    expect(mod.SCOPE_ADMIN).toBeDefined();
    expect(Array.isArray(mod.DEVICE_KINDS)).toBe(true);
  });
});

describe("@omnesis/core/doctor", () => {
  test("re-exports the shared evaluator + host security collector", async () => {
    const mod = await import("./doctor.js");
    expect(typeof mod.evaluateDoctor).toBe("function");
    expect(typeof mod.collectSecurityData).toBe("function");
    expect(typeof mod.PROCESS_VITALS_WINDOW_SECONDS).toBe("number");
  });
});

describe("subpath ↔ root parity", () => {
  test("root re-export and subpath produce the same symbol identities", async () => {
    const root = await import("../index.js");
    const protocol = await import("./protocol.js");
    const sources = await import("./sources.js");
    const config = await import("./config.js");

    // Spot-check identities across a few domains. If a subpath and
    // the root barrel drift to different module instances of the
    // same export, the strict-equality check catches it.
    expect(protocol.makeCommand).toBe(root.makeCommand);
    expect(protocol.PROTOCOL_VERSION).toBe(root.PROTOCOL_VERSION);
    expect(sources.defineSource).toBe(root.defineSource);
    expect(config.omnesisConfigSchema).toBe(root.omnesisConfigSchema);
  });
});
