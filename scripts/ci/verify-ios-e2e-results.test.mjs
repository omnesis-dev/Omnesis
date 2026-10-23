// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { verifyIOSE2EResults } from "./verify-ios-e2e-results.mjs";

const suite = (name, results) => ({
  name,
  nodeType: "Test Suite",
  children: Object.entries(results).map(([name, result]) => ({
    name: `${name}()`,
    nodeType: "Test Case",
    result,
  })),
});
const report = (gateway, capture) => ({
  testNodes: [
    suite("GatewayLiveE2ETests", gateway),
    suite("RealtimeAudioCaptureDeviceTests", capture),
  ],
});
const expected = (capture = "Skipped") => ({
  GatewayLiveE2ETests: { names: ["testGateway"], result: "Passed" },
  RealtimeAudioCaptureDeviceTests: { names: ["testCapture"], result: capture },
});

describe("iOS E2E class results", () => {
  it("accepts gateway coverage with hardware probes intentionally disabled", () => {
    expect(
      verifyIOSE2EResults(
        report({ testGateway: "Passed" }, { testCapture: "Skipped" }),
        expected(),
      ),
    ).toEqual(["GatewayLiveE2ETests: 1 passed", "RealtimeAudioCaptureDeviceTests: 1 skipped"]);
  });
  it("requires real capture tests to pass when explicitly enabled", () => {
    expect(
      verifyIOSE2EResults(
        report({ testGateway: "Passed" }, { testCapture: "Passed" }),
        expected("Passed"),
      ),
    ).toHaveLength(2);
    expect(() =>
      verifyIOSE2EResults(
        report({ testGateway: "Passed" }, { testCapture: "Skipped" }),
        expected("Passed"),
      ),
    ).toThrow();
  });
  it("cannot hide a skipped gateway test behind a passed capture test", () => {
    expect(() =>
      verifyIOSE2EResults(
        report({ testGateway: "Skipped" }, { testCapture: "Passed" }),
        expected(),
      ),
    ).toThrow();
  });
  it("rejects missing, duplicate, failed and unknown test outcomes", () => {
    for (const result of ["Failed", "unknown", "Expected Failure"]) {
      expect(() =>
        verifyIOSE2EResults(
          report({ testGateway: result }, { testCapture: "Skipped" }),
          expected(),
        ),
      ).toThrow();
    }
    expect(() => verifyIOSE2EResults({ testNodes: [] }, expected())).toThrow();
    const duplicate = report({ testGateway: "Passed" }, { testCapture: "Skipped" });
    duplicate.testNodes[0].children.push(duplicate.testNodes[0].children[0]);
    expect(() => verifyIOSE2EResults(duplicate, expected())).toThrow();
  });
});
