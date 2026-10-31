// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { CATALOG } from "@omnesis/core";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return { ...actual, gatewayJson: vi.fn(), gatewayFetch: vi.fn() };
});

import { gatewayFetch, gatewayJson } from "../utils.js";
import { modelCommand, redrawProgressLine } from "./model.js";

/**
 * What a terminal shows after `writes`: a carriage return moves the cursor to
 * the start of the line, a newline starts a new one, and every other character
 * overwrites the cell under the cursor. Only the screen, not the bytes, says
 * whether a shorter line left the end of a longer one behind.
 */
function screen(writes: readonly string[]): string[] {
  const lines: string[][] = [[]];
  let column = 0;
  for (const char of writes.join("")) {
    const line = lines[lines.length - 1]!;
    if (char === "\r") column = 0;
    else if (char === "\n") {
      lines.push([]);
      column = 0;
    } else {
      line[column] = char;
      column += 1;
    }
  }
  return lines.map((cells) => cells.join(""));
}

describe("redrawProgressLine", () => {
  it("covers what a longer previous line left behind", () => {
    const shown = screen([
      redrawProgressLine("ETA 156s", ""),
      redrawProgressLine("ETA 57s", "ETA 156s"),
      redrawProgressLine("ETA 1s", "ETA 57s"),
    ]);
    expect(shown).toEqual(["ETA 1s  "]);
    expect(shown[0]!.trimEnd()).toBe("ETA 1s");
  });

  it("adds nothing when the new line is as long or longer", () => {
    expect(redrawProgressLine("ETA 57s", "ETA 9s")).toBe("\rETA 57s");
    expect(redrawProgressLine("ETA 57s", "ETA 58s")).toBe("\rETA 57s");
  });
});

describe("model install: the in-place progress line", () => {
  const entry = CATALOG.find((e) => e.kind === "gguf")!;
  const download = (downloadedBytes: number, speed: number, etaMs: number) => ({
    downloadId: "d1",
    modelId: entry.id,
    filename: "fictional.gguf",
    startedAt: "2026-01-01T00:00:00.000Z",
    progress: { downloadedBytes, totalBytes: 1_000_000_000, speedBytesPerSec: speed, etaMs },
  });
  const overview = (activeDownloads: unknown[], installed: unknown[] = []) => ({
    catalog: [entry],
    installed,
    activeDownloads,
    capabilities: [],
    inference: {
      assignments: {
        embedder: { kind: "disabled" },
        agent: { kind: "disabled" },
        transcriber: { kind: "disabled" },
      },
    },
  });
  let writes: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    writes = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    (gatewayFetch as Mock).mockResolvedValue({ ok: true, status: 202 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("leaves no stale characters when the ETA and speed get shorter", async () => {
    const polls = [
      overview([]),
      overview([download(100_000_000, 12_500_000, 156_000)]),
      overview([download(500_000_000, 9_000_000, 57_000)]),
      overview([download(990_000_000, 950_000, 1_000)]),
      overview(
        [],
        [{ id: entry.id, sizeBytes: 1_000_000_000, sha256: "a".repeat(64), filename: "x" }],
      ),
    ];
    (gatewayJson as Mock).mockImplementation(() => Promise.resolve(polls.shift()));
    const commands = modelCommand.subCommands as Record<
      string,
      { run: (context: { args: Record<string, unknown> }) => Promise<void> }
    >;

    const done = commands.install!.run({ args: { id: entry.id } });
    await vi.runAllTimersAsync();
    await done;

    const progress = writes.filter((w) => w.startsWith("\r"));
    expect(progress).toHaveLength(3);
    const last = screen(progress)[0]!.trimEnd();
    expect(last).toMatch(/ETA 1s$/u);
    expect(last).not.toMatch(/ETA 1s\S/u);
    // Every redraw covers the whole previous line.
    for (let i = 1; i < progress.length; i += 1) {
      expect(progress[i]!.length).toBeGreaterThanOrEqual(progress[i - 1]!.length);
    }
  });
});
