// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { operatorCommand } from "./operator-command.js";

describe("operatorCommand", () => {
  test("is omnesis by default", () => {
    expect(operatorCommand({})).toBe("omnesis");
  });

  test("is the command a native collector beside a Docker install answers to", () => {
    expect(operatorCommand({ OMNESIS_CLI_COMMAND: "omnesis-collector" })).toBe("omnesis-collector");
  });

  test.each(["rm -rf /", "omnesis; reboot", "other-tool", ""])(
    "ignores %j, which is no command of this product",
    (value) => {
      expect(operatorCommand({ OMNESIS_CLI_COMMAND: value })).toBe("omnesis");
    },
  );
});
