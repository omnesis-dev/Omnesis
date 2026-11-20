// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { encodeHelperCommand, parseHelperEvent, type HelperCommand } from "./protocol.js";

/** The messages the helper's Go tests read too (internal/protocol/wire_test.go). */
const wire = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../tailnet-helper/internal/protocol/testdata/wire.json", import.meta.url),
    ),
    "utf8",
  ),
) as { commands: HelperCommand[]; events: unknown[] };

describe("the helper protocol, as the helper speaks it", () => {
  test("every event the helper writes is read exactly as written", () => {
    for (const event of wire.events) {
      expect(parseHelperEvent(JSON.stringify(event)), JSON.stringify(event)).toEqual(event);
    }
  });

  test("every command is written as the helper parses it, one per line", () => {
    for (const command of wire.commands) {
      const line = encodeHelperCommand(command);
      expect(line.endsWith("\n") && !line.slice(0, -1).includes("\n")).toBe(true);
      expect(JSON.parse(line)).toEqual(command);
    }
  });

  test("private certificate commands reject missing, oversized and unexpected fields", () => {
    for (const certificate of [
      { cert: "", key: "invented" },
      { cert: "invented", key: "" },
      { cert: "x".repeat(256 * 1024 + 1), key: "invented" },
      { cert: "invented", key: "x".repeat(64 * 1024 + 1) },
      { cert: "invented", key: "invented", extra: true },
    ]) {
      expect(() => encodeHelperCommand({ type: "gateway-certificate", certificate })).toThrow();
    }
  });

  test("anything else is not an event", () => {
    for (const line of [
      "",
      "not json",
      JSON.stringify({ type: "status" }),
      JSON.stringify({ ...(wire.events[0] as object), extra: true }),
      JSON.stringify({ type: "unknown" }),
    ]) {
      expect(parseHelperEvent(line), line).toBeNull();
    }
  });
});
