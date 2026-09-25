// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, afterEach } from "vitest";
import { describeQuery } from "./query-log.js";

describe("describeQuery (SEC-17 query-log redaction)", () => {
  afterEach(() => {
    delete process.env.OMNESIS_LOG_QUERIES;
  });

  test("does not leak raw query text by default", () => {
    const secret = "patient diagnosis jane doe ssn 123";
    const out = describeQuery(secret);
    expect(out).not.toContain("jane");
    expect(out).not.toContain("diagnosis");
    expect(out).not.toContain("123");
    expect(out).toContain(`len=${secret.length}`);
  });

  test("is stable for the same input and differs across inputs", () => {
    expect(describeQuery("alpha")).toBe(describeQuery("alpha"));
    expect(describeQuery("alpha")).not.toBe(describeQuery("beta"));
  });

  test("emits raw text only when OMNESIS_LOG_QUERIES=1", () => {
    process.env.OMNESIS_LOG_QUERIES = "1";
    expect(describeQuery("hello world")).toBe('"hello world"');
  });
});
