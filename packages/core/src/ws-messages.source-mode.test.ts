// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from "vitest";
import { parseRequestPayload } from "./ws-messages.js";

describe("source registry multi-device mode wire contract", () => {
  test.each(["sources.snapshot", "source.added", "source.updated"] as const)(
    "%s preserves the gateway's persisted mode",
    (type) => {
      const source = {
        id: "notes:local",
        type: "notes",
        accountId: "local",
        config: { enabled: true },
        enabled: true,
        multiDeviceMode: "partitioned",
      };
      const raw = type === "sources.snapshot" ? { sources: [source] } : { source };
      const result = parseRequestPayload(type, raw);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const parsedSource =
        "sources" in result.value ? result.value.sources[0] : result.value.source;
      expect(parsedSource?.multiDeviceMode).toBe("partitioned");
    },
  );

  test("the field remains optional for an older gateway", () => {
    const result = parseRequestPayload("source.added", {
      source: { id: "notes:local", enabled: true },
    });
    expect(result.ok).toBe(true);
  });

  test("source.updated still requires the enabled state", () => {
    const result = parseRequestPayload("source.updated", {
      source: { id: "notes:local", multiDeviceMode: "partitioned" },
    });
    expect(result.ok).toBe(false);
  });
});
