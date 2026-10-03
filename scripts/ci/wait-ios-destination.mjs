// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// CoreSimulator can report a booted phone before Xcode discovers it for a
// scheme. Wait for the selected destination without retrying any test run.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PROBE_TIMEOUT_MS = 30_000;

function execute(command, args, timeout) {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function fields(text, separator) {
  return Object.fromEntries(
    text.split(",").map((part) => {
      const index = part.indexOf(separator);
      if (index < 1) throw new Error(`Invalid iOS destination field: ${part}`);
      return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
    }),
  );
}

function eligible(output, requested) {
  let available = false;
  for (const line of output.split("\n")) {
    if (/^\s*Available destinations for /.test(line)) {
      available = true;
      continue;
    }
    if (/^\s*Ineligible destinations for /.test(line)) available = false;
    const row = available && line.match(/^\s*\{(.*)\}\s*$/);
    if (!row) continue;
    const device = fields(row[1], ":");
    if (device.platform !== "iOS Simulator" || !UUID.test(device.id ?? "")) continue;
    if (
      Object.entries(requested).every(([key, value]) =>
        key === "id" ? device.id.toLowerCase() === value.toLowerCase() : device[key] === value,
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Substitute process and clock seams to verify bounded discovery without Xcode. */
export function waitForIOSDestination({
  destination,
  packageFlags = [],
  run = execute,
  now = Date.now,
  wait = (milliseconds) => execute("sleep", [String(milliseconds / 1000)], milliseconds + 1000),
  timeoutMs = 300_000,
  log = (text) => process.stderr.write(`${text}\n`),
} = {}) {
  const requested = fields(destination ?? "", "=");
  if (
    requested.platform !== "iOS Simulator" ||
    (!requested.id && !requested.name) ||
    (requested.id && !UUID.test(requested.id)) ||
    Object.keys(requested).some((key) => !["platform", "id", "name", "OS", "arch"].includes(key))
  ) {
    throw new Error(
      `Expected an iOS Simulator destination with an actual id or name: ${destination}`,
    );
  }
  // Xcode's latest runtime may not yet appear in the eligible inventory.
  // A concrete OS or UDID avoids accepting an older phone with the same name.
  if (requested.OS === "latest") {
    throw new Error("Use a concrete OS version or omit OS and select a simulator by id");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid destination timeout");
  const deadline = now() + timeoutMs;
  const args = [
    "-project",
    "Omnesis.xcodeproj",
    "-scheme",
    "Omnesis",
    "-showdestinations",
    ...packageFlags,
  ];
  let inventory = "No destination inventory returned.";
  log(`Waiting for Xcode destination ${destination} (timeout ${timeoutMs / 1000}s).`);
  while (now() < deadline) {
    try {
      inventory = run("xcodebuild", args, Math.min(PROBE_TIMEOUT_MS, deadline - now()));
      if (now() <= deadline && eligible(inventory, requested)) {
        log(`Xcode destination ready: ${destination}.`);
        return;
      }
    } catch (error) {
      inventory = [error.stdout, error.stderr, error.message].filter(Boolean).join("\n");
    }
    const remaining = deadline - now();
    if (remaining > 0) wait(Math.min(2000, remaining));
  }
  log(`Last Xcode destination inventory:\n${inventory}`);
  throw new Error(
    `Xcode did not discover eligible destination ${destination} within ${timeoutMs / 1000}s`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    waitForIOSDestination({ destination: process.argv[2], packageFlags: process.argv.slice(3) });
  } catch (error) {
    process.stderr.write(`iOS destination discovery failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
