// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Verify each selected XCTest class independently, including intentional opt-in skips. */
export function verifyIOSE2EResults(report, suites) {
  if (!Array.isArray(report.testNodes)) throw new Error("Missing XCTest test tree");
  const results = new Map(Object.keys(suites).map((name) => [name, new Map()]));
  function visit(node, suite) {
    const matched = Object.keys(suites).find(
      (name) => node.name === name || node.name?.endsWith(`.${name}`),
    );
    suite = matched ?? suite;
    if (node.nodeType === "Test Case" && suite) {
      const name = node.name.replace(/\(\)$/, "");
      const cases = results.get(suite);
      if (cases.has(name)) throw new Error(`Duplicate XCTest case in ${suite}`);
      cases.set(name, node.result);
    }
    for (const child of node.children ?? []) visit(child, suite);
  }
  for (const node of report.testNodes) visit(node);
  return Object.entries(suites).map(([suite, expected]) => {
    const cases = results.get(suite);
    if (!expected.names.length || cases.size !== expected.names.length)
      throw new Error(`Incomplete XCTest class: ${suite}`);
    for (const name of expected.names) {
      if (cases.get(name) !== expected.result)
        throw new Error(`Unexpected XCTest outcome in ${suite}/${name}`);
    }
    return `${suite}: ${cases.size} ${expected.result.toLowerCase()}`;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [reportPath, gatewaySource, captureSource, captureFixture] = process.argv.slice(2);
  const names = (source) =>
    [...readFileSync(source, "utf8").matchAll(/^\s*func (test\w*)\s*\(/gm)].map(
      (match) => match[1],
    );
  let captureEnabled = false;
  try {
    const fixture = JSON.parse(readFileSync(captureFixture, "utf8"));
    if (typeof fixture.enabled !== "boolean") throw new Error("Invalid capture opt-in");
    captureEnabled = fixture.enabled;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const messages = verifyIOSE2EResults(JSON.parse(readFileSync(reportPath, "utf8")), {
    GatewayLiveE2ETests: { names: names(gatewaySource), result: "Passed" },
    RealtimeAudioCaptureDeviceTests: {
      names: names(captureSource),
      result: captureEnabled ? "Passed" : "Skipped",
    },
  });
  for (const message of messages) console.log(message);
}
