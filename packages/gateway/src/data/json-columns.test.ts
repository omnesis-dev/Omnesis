// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit tests for the JSON-column codec primitive. Per-column codecs all
 * share the same machinery; this exercises round-trip, parse failure, and
 * fallback behaviour through three representative codecs (record, array,
 * scope-filtered array).
 */
import { describe, expect, test, vi, beforeEach } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ, type Scope } from "@omnesis/types";
import {
  documentsMetadataCodec,
  mergeCandidatesMatchedTokensCodec,
  sourceDeviceConfigOverrideCodec,
  tokensScopesCodec,
} from "./json-columns.js";

beforeEach(() => {
  // Quiet the `gateway:db:json-columns` warn on parseWithFallback paths so
  // the test output reads cleanly. Each test that exercises the warn path
  // re-enables it as needed.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("JsonColumnCodec — round trip", () => {
  test("serialize then parse returns the same value", () => {
    const meta = { documentType: "email", extra: { unitCount: 7 } };
    const raw = documentsMetadataCodec.serialize(meta);
    expect(documentsMetadataCodec.parse(raw)).toEqual(meta);
  });

  test("scopes codec filters invalid entries on read", () => {
    // Persisted shape is the raw array — *.parseWithFallback re-validates
    // each scope and drops anything malformed.
    const raw = JSON.stringify([SCOPE_READ, "garbage", SCOPE_ADMIN, ""]);
    expect(tokensScopesCodec.parseWithFallback(raw)).toEqual([SCOPE_READ, SCOPE_ADMIN]);
  });

  test("scopes codec serialize+parse round-trips a clean array", () => {
    const scopes: Scope[] = [SCOPE_READ, SCOPE_ADMIN];
    const raw = tokensScopesCodec.serialize(scopes);
    expect(tokensScopesCodec.parse(raw)).toEqual(scopes);
  });

  test("matched_tokens round-trip", () => {
    const tokens = ["alice@example.com", "+447700000000", "Alice"];
    const raw = mergeCandidatesMatchedTokensCodec.serialize(tokens);
    expect(mergeCandidatesMatchedTokensCodec.parse(raw)).toEqual(tokens);
  });

  test("member source-config overrides round-trip as an opaque object", () => {
    const override = { params: { sessionsPath: "/tmp/fictional-collector/sessions" } };
    expect(
      sourceDeviceConfigOverrideCodec.parse(sourceDeviceConfigOverrideCodec.serialize(override)),
    ).toEqual(override);
  });
});

describe("JsonColumnCodec — parse() throws on corruption", () => {
  test("malformed JSON surfaces as a typed error message", () => {
    expect(() => documentsMetadataCodec.parse("{not json")).toThrow(
      /documents\.metadata contains invalid JSON/,
    );
  });

  test("schema mismatch (top-level array where object expected) throws", () => {
    // metadata schema is z.record() — passing an array fails shape.
    expect(() => documentsMetadataCodec.parse("[1,2,3]")).toThrow();
  });
});

describe("JsonColumnCodec — parseWithFallback() returns typed default + logs", () => {
  test("malformed JSON returns fallback and warns", () => {
    const warn = vi.spyOn(console, "warn");
    expect(documentsMetadataCodec.parseWithFallback("{not json", { rowId: "doc-42" })).toEqual({});
    // The structured logger ultimately writes through console.warn; assert
    // we logged at least one warning carrying the row context.
    expect(warn).toHaveBeenCalled();
  });

  test("shape mismatch returns fallback (top-level array)", () => {
    expect(documentsMetadataCodec.parseWithFallback("[1,2]")).toEqual({});
  });

  test("scopes codec corrupt JSON returns empty array", () => {
    expect(tokensScopesCodec.parseWithFallback("not json")).toEqual([]);
  });

  test("matched_tokens codec corrupt JSON returns empty array", () => {
    expect(mergeCandidatesMatchedTokensCodec.parseWithFallback("?")).toEqual([]);
  });

  test("member source-config override corruption fails safe to an empty object", () => {
    expect(sourceDeviceConfigOverrideCodec.parseWithFallback("not json")).toEqual({});
    expect(sourceDeviceConfigOverrideCodec.parseWithFallback("[]")).toEqual({});
  });

  test("includes the row id in the warning when supplied", () => {
    const warn = vi.spyOn(console, "warn");
    documentsMetadataCodec.parseWithFallback("oops", { rowId: "doc-99" });
    const messages = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(messages).toContain("documents.metadata");
    expect(messages).toContain("doc-99");
  });
});

describe("JsonColumnCodec — serialize rejects out-of-shape values", () => {
  test("scopes codec serialize requires array input (zod throws on object)", () => {
    expect(() => tokensScopesCodec.serialize("not an array" as unknown as Scope[])).toThrow();
  });

  test("metadata codec serialize requires record input", () => {
    expect(() =>
      documentsMetadataCodec.serialize([] as unknown as Record<string, unknown>),
    ).toThrow();
  });
});
