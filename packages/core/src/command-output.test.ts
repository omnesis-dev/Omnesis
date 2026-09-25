// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { capDeviceUpdateDetail, summarizeCommandFailure } from "./command-output.js";
import { DEVICE_UPDATE_DETAIL_MAX_CHARS, deviceUpdateResultEvent } from "./ws-messages.js";

describe("summarizeCommandFailure", () => {
  test("keeps the line that names the cause of a multi-line refusal", () => {
    // The refusal a stopped gateway once produced: the first line is the
    // reason, the second the advice, and the advice alone explains nothing.
    const output =
      "Source checkout detected at /opt/omnesis. Target: v9.9.1.\n" +
      "\n" +
      "Could not take a backup through https://gateway.example.org:7600 before updating: fetch failed\n" +
      "This upgrade runs forward-only schema migrations, so the backup is the only way back.\n";
    expect(summarizeCommandFailure(output)).toBe(
      "Could not take a backup through https://gateway.example.org:7600 before updating: fetch failed " +
        "This upgrade runs forward-only schema migrations, so the backup is the only way back.",
    );
  });

  test("a single final line is kept whole", () => {
    expect(
      summarizeCommandFailure(
        "Fetching…\nNo release v9.9.9 exists on this installation's remote.\n",
      ),
    ).toBe("Fetching… No release v9.9.9 exists on this installation's remote.");
  });

  test("keeps at most the last three lines of the final block", () => {
    expect(summarizeCommandFailure("one\ntwo\nthree\nfour\nfive\n")).toBe("three four five");
  });

  test("stops at the blank line before the final block", () => {
    expect(summarizeCommandFailure("progress\n\nfirst\nsecond\n\n\n")).toBe("first second");
  });

  test("strips colour codes, hyperlinks, redraws and other control characters", () => {
    const output =
      "\x1b[31mCould not install\x1b[0m\n" +
      "\x1b]8;;https://example.org\x07the package\x1b]8;;\x07\n" +
      "progress 10%\rprogress 100%\b\n";
    expect(summarizeCommandFailure(output)).toBe("Could not install the package progress 100%");
  });

  test("a line too long to fit gives way to the lines after it", () => {
    // A progress blob printed just before the refusal must not crowd it out.
    const output = `Fetching…\n${"x".repeat(20_000)}\nNo release v9.9.9 exists on this installation's remote.\n\n`;
    expect(summarizeCommandFailure(output)).toBe(
      "No release v9.9.9 exists on this installation's remote.",
    );
  });

  test("over the cap, a third line gives way but a cause and its advice stay together", () => {
    const noise = "n".repeat(300);
    const cause = `Could not take a backup: ${"c".repeat(300)}`;
    const advice = "Pass --no-backup to accept that risk.";
    const summary = summarizeCommandFailure(`${noise}\n${cause}\n${advice}\n`);
    expect(summary.startsWith("Could not take a backup: ccc")).toBe(true);
    expect(summary).toContain(advice);
    // A cause that fits on its own but not beside its advice keeps its start.
    const fits = `Could not take a backup: ${"c".repeat(565)}`;
    const long = summarizeCommandFailure(`${fits}\n${advice}\n`);
    expect(long).toHaveLength(600);
    expect(long.startsWith("Could not take a backup: ccc")).toBe(true);
    expect(long.endsWith("…")).toBe(true);
  });

  test("caps the summary at 600 characters, keeping its start", () => {
    const summary = summarizeCommandFailure(`${"cause ".repeat(200)}\n`);
    expect(summary).toHaveLength(600);
    expect(summary.startsWith("cause cause")).toBe(true);
    expect(summary.endsWith("…")).toBe(true);
  });

  test("output with nothing printable summarizes to nothing", () => {
    expect(summarizeCommandFailure("\n\x1b[0m\n  \n")).toBe("");
  });
});

describe("capDeviceUpdateDetail", () => {
  test("a detail within the gateway's limit is untouched", () => {
    const detail = "x".repeat(DEVICE_UPDATE_DETAIL_MAX_CHARS);
    expect(capDeviceUpdateDetail(detail)).toBe(detail);
  });

  test("a longer detail is cut to one the result event's schema accepts", () => {
    const detail = capDeviceUpdateDetail("y".repeat(DEVICE_UPDATE_DETAIL_MAX_CHARS + 500));
    expect(detail).toHaveLength(DEVICE_UPDATE_DETAIL_MAX_CHARS);
    expect(detail.endsWith("…")).toBe(true);
    expect(
      deviceUpdateResultEvent.safeParse({ version: "0.5.0", state: "failed", detail }).success,
    ).toBe(true);
  });

  test("the cut never splits a surrogate pair", () => {
    // An emoji straddling the cut point would otherwise leave half of it.
    const detail = `${"z".repeat(DEVICE_UPDATE_DETAIL_MAX_CHARS - 2)}😀tail`;
    const capped = capDeviceUpdateDetail(detail);
    expect(capped.length).toBeLessThanOrEqual(DEVICE_UPDATE_DETAIL_MAX_CHARS);
    expect(capped).toBe(`${"z".repeat(DEVICE_UPDATE_DETAIL_MAX_CHARS - 2)}…`);
  });
});
