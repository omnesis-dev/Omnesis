// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { processFailureVerdict } from "./process-failure-policy.js";

const baileysRace = Object.assign(new Error("ENOENT: no such file or directory"), {
  code: "ENOENT",
  path: "/tmp/example-auth/creds.json",
});

describe("processFailureVerdict", () => {
  test("an unhandled rejection is logged and the collector continues", () => {
    expect(processFailureVerdict("unhandledRejection", new Error("bad XRef entry"))).toBe(
      "continue",
    );
    expect(processFailureVerdict("unhandledRejection", "a bare string reason")).toBe("continue");
    expect(processFailureVerdict("unhandledRejection", undefined)).toBe("continue");
  });

  test("an uncaught exception exits so the supervisor restarts the process", () => {
    expect(processFailureVerdict("uncaughtException", new TypeError("x is undefined"))).toBe(
      "exit",
    );
  });

  test("the Baileys auth-state race is suppressed either way", () => {
    expect(processFailureVerdict("unhandledRejection", baileysRace)).toBe("suppress");
    expect(processFailureVerdict("uncaughtException", baileysRace)).toBe("suppress");
  });

  test("other ENOENT errors are not mistaken for the Baileys race", () => {
    const other = Object.assign(new Error("ENOENT"), {
      code: "ENOENT",
      path: "/tmp/example.db-wal",
    });
    expect(processFailureVerdict("uncaughtException", other)).toBe("exit");
  });
});
