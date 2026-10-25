// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    gatewayFetch: vi.fn(),
    isJSON: false,
    withSpinner: (_label: string, operation: () => unknown) => operation(),
  };
});

vi.mock("@clack/prompts", () => ({ confirm: vi.fn(), isCancel: () => false, cancel: vi.fn() }));
import { confirm } from "@clack/prompts";

import { gatewayFetch } from "../utils.js";
import {
  confirmMessage,
  legacyRowsCommand,
  renderLegacyRows,
  renderSettled,
  type LegacyRowsTable,
} from "./legacy-rows.js";

const SOURCE = "events-synth:maya@example.com";
const tables: LegacyRowsTable[] = [
  { tableName: "events_synth_rows", rows: 1200, remaining: 1200 },
  { tableName: "events_synth_attendees", rows: 1, remaining: 1 },
];
const done = tables.map((table) => ({ ...table, remaining: 0 }));

function run(args: Record<string, unknown>): Promise<void> {
  return (
    legacyRowsCommand as { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }
  ).run({ args });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("rendering", () => {
  test("the report names each table's count and the two ways out", () => {
    const lines = renderLegacyRows(SOURCE, tables);
    expect(lines[0]).toContain("1201 rows of events-synth:maya@example.com's shared tables");
    expect(lines[1]).toContain("events_synth_rows");
    expect(lines[1]).toContain("1200 rows");
    expect(lines[2]).toContain("1 row");
    expect(lines.at(-1)).toContain("--claim");
    expect(lines.at(-1)).toContain("--drop");
    expect(renderLegacyRows(SOURCE, [])[0]).toContain("No unattributed rows");
  });

  test("the confirmation says what each action does to the rows", () => {
    expect(confirmMessage(SOURCE, "claim", tables)).toContain(
      "Mark 1201 unattributed rows in 2 tables as events-synth:maya@example.com's?",
    );
    expect(confirmMessage(SOURCE, "drop", tables)).toContain(
      "Delete 1201 unattributed rows in 2 tables?",
    );
  });

  test("the result names the action and the per-table counts", () => {
    expect(renderSettled(SOURCE, "claim", tables)[0]).toContain("Claimed 1201 rows");
    expect(renderSettled(SOURCE, "drop", tables.slice(1))[0]).toContain("Dropped 1 row");
  });
});

describe("legacy-rows command", () => {
  let log: Mock;
  let isTTY: boolean | undefined;
  beforeEach(() => {
    log = vi.spyOn(console, "log").mockImplementation(() => {}) as unknown as Mock;
    isTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    (gatewayFetch as Mock).mockReset();
    (confirm as Mock).mockReset();
  });
  afterEach(() => {
    log.mockRestore();
    Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
  });

  test("without a flag it reports and changes nothing", async () => {
    (gatewayFetch as Mock).mockResolvedValueOnce(jsonResponse(200, { tables }));
    await run({ sourceId: SOURCE });
    expect(gatewayFetch).toHaveBeenCalledTimes(1);
    expect(gatewayFetch).toHaveBeenCalledWith(
      "/admin/sources/events-synth%3Amaya%40example.com/legacy-rows",
    );
    expect(log.mock.calls.flat().join("\n")).toContain("1201 rows");
  });

  test("--drop confirms, posts the action and prints what went", async () => {
    (gatewayFetch as Mock)
      .mockResolvedValueOnce(jsonResponse(200, { tables }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, action: "drop", tables: done }));
    (confirm as Mock).mockResolvedValue(true);
    await run({ sourceId: SOURCE, drop: true });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect((gatewayFetch as Mock).mock.calls[1]).toEqual([
      "/admin/sources/events-synth%3Amaya%40example.com/legacy-rows",
      { method: "POST", body: JSON.stringify({ action: "drop" }) },
    ]);
    expect(log.mock.calls.flat().join("\n")).toContain("Dropped 1201 rows");
  });

  test("--claim --yes skips the prompt; a declined prompt sends nothing", async () => {
    (gatewayFetch as Mock)
      .mockResolvedValueOnce(jsonResponse(200, { tables }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, action: "claim", tables: done }));
    await run({ sourceId: SOURCE, claim: true, yes: true });
    expect(confirm).not.toHaveBeenCalled();
    expect(gatewayFetch).toHaveBeenCalledTimes(2);

    (gatewayFetch as Mock).mockReset();
    (gatewayFetch as Mock).mockResolvedValueOnce(jsonResponse(200, { tables }));
    (confirm as Mock).mockResolvedValue(false);
    await expect(run({ sourceId: SOURCE, claim: true })).rejects.toMatchObject({ exitCode: 130 });
    expect(gatewayFetch).toHaveBeenCalledTimes(1);
  });

  test("nothing to settle ends with the report, and both flags are refused", async () => {
    (gatewayFetch as Mock).mockResolvedValueOnce(jsonResponse(200, { tables: [] }));
    await run({ sourceId: SOURCE, drop: true, yes: true });
    expect(gatewayFetch).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().join("\n")).toContain("No unattributed rows");
    await expect(run({ sourceId: SOURCE, claim: true, drop: true })).rejects.toThrow(/not both/);
  });

  test("a bounded settlement is repeated until nothing remains, and --json sums it", async () => {
    const first = [{ tableName: "events_synth_rows", rows: 1000, remaining: 200 }];
    const second = [{ tableName: "events_synth_rows", rows: 200, remaining: 0 }];
    (gatewayFetch as Mock)
      .mockResolvedValueOnce(jsonResponse(200, { tables: tables.slice(0, 1) }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, action: "claim", tables: first }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, action: "claim", tables: second }));
    await run({ sourceId: SOURCE, claim: true, yes: true, json: true });
    expect(gatewayFetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toEqual({
      sourceId: SOURCE,
      action: "claim",
      tables: [{ tableName: "events_synth_rows", rows: 1200, remaining: 0 }],
    });
  });

  test("a non-interactive run refuses to act without --yes", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    (gatewayFetch as Mock).mockResolvedValueOnce(jsonResponse(200, { tables }));
    await expect(run({ sourceId: SOURCE, drop: true })).rejects.toThrow(/Re-run with --yes/);
    expect(gatewayFetch).toHaveBeenCalledTimes(1);
  });

  test("the gateway's refusal is the command's error", async () => {
    (gatewayFetch as Mock).mockResolvedValueOnce(
      jsonResponse(404, { error: "source not found", code: "NOT_FOUND" }),
    );
    await expect(run({ sourceId: SOURCE })).rejects.toThrow(/source not found/);
  });
});
