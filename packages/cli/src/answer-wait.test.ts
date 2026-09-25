// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  ANSWER_WAIT_POLL_INTERVAL_MS,
  DEFAULT_ANSWER_WAIT_TIMEOUT_S,
  FOREGROUND_ANSWER_WAIT_TIMEOUT_S,
  HARNESS_ANSWER_WAIT_TIMEOUT_S,
  MAX_ANSWER_WAIT_TIMEOUT_S,
} from "./answer-wait.js";

describe("answer wait timing contract", () => {
  it("keeps polls responsive and every surrounding timeout safely ordered", () => {
    expect(ANSWER_WAIT_POLL_INTERVAL_MS).toBeLessThan(FOREGROUND_ANSWER_WAIT_TIMEOUT_S * 1_000);
    expect(FOREGROUND_ANSWER_WAIT_TIMEOUT_S).toBeLessThan(DEFAULT_ANSWER_WAIT_TIMEOUT_S);
    expect(HARNESS_ANSWER_WAIT_TIMEOUT_S).toBeGreaterThan(DEFAULT_ANSWER_WAIT_TIMEOUT_S);
    expect(MAX_ANSWER_WAIT_TIMEOUT_S).toBeGreaterThanOrEqual(HARNESS_ANSWER_WAIT_TIMEOUT_S);
  });
});
