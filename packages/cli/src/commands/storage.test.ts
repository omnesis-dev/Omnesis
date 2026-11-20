// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { runCommand } from "citty";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { assertKnownFlags } from "../unknown-flags.js";
import { EXIT_AUTH } from "../utils.js";
import { storageCommand, storageCutoff } from "./storage.js";
import { renderStorage, storageJobLine } from "./storage-display.js";
import { pendingStorageJob, storageSnapshotSchema } from "./storage-wire.js";

const mock = vi.hoisted(() => ({ fetch: vi.fn(), json: true }));
vi.mock("../utils.js", async (original) => ({
  ...(await original<typeof import("../utils.js")>()),
  gatewayFetch: mock.fetch,
  get isJSON() {
    return mock.json;
  },
}));

const trimId = "11111111-1111-4111-8111-111111111111";
const cleanupId = "22222222-2222-4222-8222-222222222222";
const before = "2024-01-01T00:00:00.000Z";
const trim = (extra = {}) => ({
  id: trimId,
  kind: "manual",
  sourceId: "invented:archive",
  before,
  state: "queued",
  deleted: 0,
  examinedDocuments: 0,
  skippedDocuments: 0,
  cleanupPending: false,
  error: null,
  ...extra,
});
const cleanup = (extra = {}) => ({
  id: cleanupId,
  target: "conversations",
  before,
  state: "queued",
  scanned: 0,
  removed: 0,
  protected: 0,
  protectedReasons: {},
  removedBytesEstimate: 0,
  cancelRequested: false,
  hasPendingRemoval: false,
  error: null,
  ...extra,
});
const snapshot = (extra = {}) => ({
  physical: null,
  logical: null,
  index: null,
  pressure: { state: "normal", reasons: [], volumes: [] },
  policy: {
    maxBytes: null,
    maxDiskUsedPercent: 95,
    resumeMarginPercent: 2,
    minFreeBytes: 500 * 1024 * 1024,
  },
  retention: [],
  trimJobs: [],
  cleanupJobs: [],
  accounting: null,
  ...extra,
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
async function run(...rawArgs: string[]) {
  await assertKnownFlags({ subCommands: { storage: () => storageCommand } }, [
    "storage",
    ...rawArgs,
  ]);
  await runCommand(storageCommand, { rawArgs });
}
function body(call = 0) {
  return JSON.parse(mock.fetch.mock.calls[call]?.[1]?.body ?? "null");
}
function lastJSON() {
  const calls = vi.mocked(console.log).mock.calls;
  return JSON.parse(String(calls.at(-1)?.[0]));
}
beforeEach(() => {
  mock.fetch.mockReset();
  mock.json = true;
  mock.fetch.mockImplementation(async () => response(snapshot()));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("storage command routing and read-only inspection", () => {
  test("defaults to status and preserves complete measurement JSON", async () => {
    const data = snapshot({ unknownFutureField: { value: "kept" } });
    mock.fetch.mockResolvedValue(response(data));
    await run();
    expect(mock.fetch).toHaveBeenCalledOnce();
    expect(mock.fetch.mock.calls[0]?.[0]).toBe("/admin/storage");
    expect(lastJSON()).toEqual(data);
  });
  test("source-filtered JSON is an explicit projection excluding other sources", async () => {
    mock.fetch.mockImplementation(async () =>
      response(
        snapshot({
          logical: {
            measuredAt: before,
            sources: ["invented:archive", "invented:other"].map((sourceId) => ({
              sourceId,
              documents: 1,
              payloadBytes: 10,
              months: [],
            })),
          },
          index: {
            measuredAt: before,
            lexicalBytes: 400,
            embeddingBytes: 80,
            sources: ["invented:archive", "invented:other"].map((sourceId) => ({
              sourceId,
              month: "2023-01",
              chunkCount: 1,
              embeddingBytes: 40,
              textBytes: 20,
            })),
          },
        }),
      ),
    );
    await run("status", "--source", "invented:archive", "--history", "--json");
    expect(lastJSON()).toMatchObject({
      sourceId: "invented:archive",
      documentMeasurement: { sourceId: "invented:archive", measuredAt: before },
      indexMeasurement: { measuredAt: before, rows: [{ sourceId: "invented:archive" }] },
    });
    expect(JSON.stringify(lastJSON())).not.toContain("invented:other");
    expect(lastJSON()).not.toHaveProperty("physical");
    expect(mock.fetch).toHaveBeenCalledOnce();
  });
  test("refresh requests a fresh snapshot with the configurable long deadline", async () => {
    await run("refresh", "--timeout", "120");
    expect(mock.fetch.mock.calls[0]?.[0]).toBe("/admin/storage/refresh");
    expect(mock.fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: "{}",
      signal: expect.any(AbortSignal),
    });
  });
  test("reads policy and rolling retention without changing configuration", async () => {
    await run("policy");
    await run("retention", "invented:archive");
    expect(mock.fetch.mock.calls.every((call) => !call[1].method)).toBe(true);
    expect(lastJSON()).toEqual({ retention: [] });
  });
  test("retention lists policies without requiring a source positional", async () => {
    await run("retention");
    expect(lastJSON()).toEqual({ retention: [] });
  });
  test("lists both job families through one cached snapshot", async () => {
    mock.fetch.mockResolvedValue(
      response(snapshot({ trimJobs: [trim()], cleanupJobs: [cleanup()] })),
    );
    await run("jobs");
    expect(mock.fetch).toHaveBeenCalledOnce();
    expect(lastJSON()).toEqual({ trimJobs: [trim()], cleanupJobs: [cleanup()] });
  });
  test("accepts older storage snapshots without history jobs", async () => {
    const data = snapshot();
    delete (data as Partial<typeof data>).cleanupJobs;
    mock.fetch.mockResolvedValue(response(data));
    await run("jobs");
    expect(lastJSON()).toEqual({ trimJobs: [], cleanupJobs: [] });
  });
  test("rejects unknown flags before any request", async () => {
    await expect(run("trim", "invented:archive", "--befor", "2024-01-01", "--yes")).rejects.toThrow(
      "befor",
    );
    expect(mock.fetch).not.toHaveBeenCalled();
  });
  test("unknown subcommands fail rather than falling back to a successful status", async () => {
    await expect(run("typo")).rejects.toThrow("Unknown command");
    expect(mock.fetch).not.toHaveBeenCalled();
  });
});

describe("storage input and consent boundaries", () => {
  test.each([
    "2024-02-30",
    "2023-02-29",
    "01/02/2024",
    "yesterday",
    "2024-01-01T24:00:00Z",
    "2024-01-01T00:00:00+01:00",
  ])("refuses invalid or ambiguous cutoff %s", async (date) => {
    await expect(run("cleanup", "conversations", "--before", date, "--yes")).rejects.toThrow();
    expect(mock.fetch).not.toHaveBeenCalled();
  });
  test("accepts leap dates and normalizes explicit UTC seconds", () => {
    expect(storageCutoff("2024-02-29")).toBe("2024-02-29T00:00:00.000Z");
    expect(storageCutoff("2024-02-29T01:02:03Z")).toBe("2024-02-29T01:02:03.000Z");
    expect(storageCutoff("2024-02-29T01:02:03.004Z")).toBe("2024-02-29T01:02:03.004Z");
  });
  test.each([
    ["trim", "invented:archive", "--before", "2024-01-01"],
    ["cleanup", "conversations", "--before", "2024-01-01"],
    ["cleanup", "backups", "--before", "2024-01-01", "--include-newest"],
    ["retention", "invented:archive", "--days", "20"],
    ["cancel", cleanupId],
  ])("requires explicit consent for %j", async (...args) => {
    await expect(run(...args)).rejects.toThrow("--yes");
    expect(mock.fetch).not.toHaveBeenCalled();
  });
  test.each([
    ["policy", "--max-bytes", "0"],
    ["policy", "--max-bytes", "NaN"],
    ["policy", "--max-bytes", "9007199254740992"],
    ["policy", "--disk-used-percent", "100"],
    ["policy", "--resume-margin-percent", "0"],
    ["retention", "invented:archive", "--days", "1.5", "--yes"],
    ["retention", "invented:archive", "--days", "20", "--off", "--yes"],
    ["trim", "invented:too:many", "--before", "2024-01-01", "--yes"],
    ["trim", "invented:archive", "--before", "2099-01-01", "--yes"],
    ["cleanup", "conversations", "--before", "2024-01-01", "--include-newest", "--yes"],
    ["cleanup", "unknown", "--before", "2024-01-01", "--yes"],
    ["wait", "not-a-job"],
    ["refresh", "--timeout", "0"],
    ["wait", cleanupId, "--timeout", "NaN"],
    ["trim", "invented:archive", "invented:other", "--before", "2024-01-01", "--yes"],
    ["cleanup", "backups", "conversations", "--before", "2024-01-01", "--yes"],
    ["retention", "invented:archive", "invented:other", "--off"],
    ["policy", "extra"],
    ["status", "extra"],
    ["jobs", "extra"],
    ["wait", cleanupId, trimId],
    ["cancel", cleanupId, trimId, "--yes"],
  ])("refuses invalid arguments %j without HTTP", async (...args) => {
    await expect(run(...args)).rejects.toThrow();
    expect(mock.fetch).not.toHaveBeenCalled();
  });
});

describe("storage mutations reuse gateway authority", () => {
  test("patches only supplied quota settings and leaves disk protection on when clearing quota", async () => {
    await run("policy", "--max-bytes", "unlimited");
    expect(body()).toEqual({ maxBytes: null });
    await run(
      "policy",
      "--max-bytes",
      "12345",
      "--disk-used-percent",
      "94",
      "--resume-margin-percent",
      "1.5",
    );
    expect(body(1)).toEqual({ maxBytes: 12345, maxDiskUsedPercent: 94, resumeMarginPercent: 1.5 });
  });
  test("sets rolling retention via the bound gateway service and turns it off without destructive consent", async () => {
    await run("retention", "invented:archive", "--days", "20", "--yes");
    expect(mock.fetch.mock.calls[0]?.[0]).toBe("/admin/storage/retention");
    expect(body()).toEqual({ sourceId: "invented:archive", maxAgeDays: 20 });
    await run("retention", "invented:archive", "--off");
    expect(body(1)).toEqual({ sourceId: "invented:archive", maxAgeDays: null });
  });
  test("starts one complete source-trim intent and handles the bare job response", async () => {
    mock.fetch.mockResolvedValue(response(trim(), 202));
    await run("trim", "invented:archive", "--before", "2024-01-01", "--yes");
    expect(mock.fetch.mock.calls[0]?.[0]).toBe("/admin/storage/trim/jobs");
    expect(body()).toEqual({ sourceId: "invented:archive", before });
    expect(lastJSON()).toEqual(trim());
  });
  test("valid account IDs containing literal wildcard characters are sent exactly, without expansion", async () => {
    const sourceId = "invented:literal*account?@example.org";
    mock.fetch.mockResolvedValue(response(trim({ sourceId }), 202));
    await run("trim", sourceId, "--before", "2024-01-01", "--yes");
    expect(mock.fetch).toHaveBeenCalledOnce();
    expect(body()).toEqual({ sourceId, before });
    expect(lastJSON()).toMatchObject({ sourceId });
  });
  test.each(["brain-transcripts", "conversations", "backups"])(
    "starts %s cleanup with an explicit cutoff",
    async (target) => {
      mock.fetch.mockResolvedValue(response({ job: cleanup({ target }) }, 202));
      await run("cleanup", target, "--before", "2099-01-01", "--yes");
      expect(body()).toEqual({
        target,
        before: "2099-01-01T00:00:00.000Z",
        ...(target === "backups" ? { keepNewest: true } : {}),
      });
    },
  );
  test("permits newest-backup removal only with the explicit option", async () => {
    mock.fetch.mockResolvedValue(
      response({ job: cleanup({ target: "backups", keepNewest: false }) }, 202),
    );
    await run("cleanup", "backups", "--before", "2024-01-01", "--include-newest", "--yes");
    expect(body()).toEqual({ target: "backups", before, keepNewest: false });
  });
  test("cancellation displays the actual race result, not an invented cancelled state", async () => {
    mock.fetch
      .mockResolvedValueOnce(response({ kind: "cleanup", job: cleanup() }))
      .mockResolvedValueOnce(response({ job: cleanup({ state: "completed" }) }));
    await run("cancel", cleanupId, "--yes");
    expect(mock.fetch.mock.calls[0]?.[0]).toBe(`/admin/storage/jobs/${cleanupId}`);
    expect(mock.fetch.mock.calls[1]?.[0]).toBe(`/admin/storage/cleanup/jobs/${cleanupId}/cancel`);
    expect(lastJSON()).toMatchObject({ state: "completed" });
  });
  test("does not pretend a source trim can be cancelled", async () => {
    mock.fetch.mockResolvedValue(response({ kind: "trim", job: trim() }));
    await expect(run("cancel", trimId, "--yes")).rejects.toThrow("cannot be cancelled");
    expect(mock.fetch).toHaveBeenCalledOnce();
  });
});

describe("storage progress and failure handling", () => {
  test("wait uses only indexed job lookup, waits for search cleanup, and emits one final JSON job", async () => {
    vi.useFakeTimers();
    mock.fetch
      .mockResolvedValueOnce(
        response({ kind: "trim", job: trim({ state: "completed", cleanupPending: true }) }),
      )
      .mockResolvedValueOnce(
        response({ kind: "trim", job: trim({ state: "completed", deleted: 130 }) }),
      );
    const waiting = run("wait", trimId);
    await vi.advanceTimersByTimeAsync(0);
    expect(console.log).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await waiting;
    expect(mock.fetch.mock.calls.map((call) => call[0])).toEqual([
      `/admin/storage/jobs/${trimId}`,
      `/admin/storage/jobs/${trimId}`,
    ]);
    expect(console.log).toHaveBeenCalledOnce();
    expect(lastJSON()).toMatchObject({ state: "completed", deleted: 130 });
  });
  test("history failures with committed pending removal keep waiting for automatic retry", async () => {
    vi.useFakeTimers();
    mock.fetch
      .mockResolvedValueOnce(
        response({
          kind: "cleanup",
          job: cleanup({
            state: "failed",
            hasPendingRemoval: true,
            error: "Pending removal will retry",
          }),
        }),
      )
      .mockResolvedValueOnce(
        response({ kind: "cleanup", job: cleanup({ state: "completed", removed: 1 }) }),
      );
    const waiting = run("wait", cleanupId);
    await vi.advanceTimersByTimeAsync(1000);
    await waiting;
    expect(lastJSON()).toMatchObject({ state: "completed", removed: 1 });
  });
  test("start --wait retains the accepted job ID and waits through direct lookup", async () => {
    vi.useFakeTimers();
    mock.fetch
      .mockResolvedValueOnce(response({ job: cleanup() }, 202))
      .mockResolvedValueOnce(
        response({ kind: "cleanup", job: cleanup({ state: "completed", removed: 2 }) }),
      );
    const waiting = run("cleanup", "conversations", "--before", "2024-01-01", "--yes", "--wait");
    await vi.advanceTimersByTimeAsync(1000);
    await waiting;
    expect(mock.fetch.mock.calls[1]?.[0]).toBe(`/admin/storage/jobs/${cleanupId}`);
    expect(console.log).toHaveBeenCalledOnce();
    expect(lastJSON()).toMatchObject({ removed: 2 });
  });
  test("accepted job ID remains available when waiting fails after successful submission", async () => {
    vi.useFakeTimers();
    mock.fetch
      .mockResolvedValueOnce(response({ job: cleanup() }, 202))
      .mockRejectedValueOnce(new Error("Invented connection refusal"));
    const waiting = expect(
      run("cleanup", "conversations", "--before", "2024-01-01", "--yes", "--wait"),
    ).rejects.toThrow("Any accepted background job continues");
    await vi.advanceTimersByTimeAsync(1000);
    await waiting;
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining(cleanupId));
    expect(console.log).not.toHaveBeenCalled();
  });
  test.each(["failed", "cancelled"])("returns nonzero for terminal %s jobs", async (state) => {
    mock.fetch.mockResolvedValue(
      response({
        kind: "cleanup",
        job: cleanup({ state, error: state === "failed" ? "Failure" : null }),
      }),
    );
    await expect(run("wait", cleanupId)).rejects.toThrow(state);
  });
  test("timeout does not send cancellation or claim success", async () => {
    vi.useFakeTimers();
    mock.fetch.mockResolvedValue(response({ kind: "cleanup", job: cleanup() }));
    const waiting = expect(run("wait", cleanupId, "--timeout", "1")).rejects.toThrow(
      "Background jobs continue",
    );
    await vi.advanceTimersByTimeAsync(1000);
    await waiting;
    expect(mock.fetch.mock.calls.every((call) => !String(call[0]).includes("cancel"))).toBe(true);
    expect(console.log).not.toHaveBeenCalled();
  });
  test("watch tracks invocation's active jobs, emits NDJSON and excludes terminal history", async () => {
    vi.useFakeTimers();
    mock.fetch
      .mockResolvedValueOnce(
        response(
          snapshot({ cleanupJobs: [cleanup(), cleanup({ id: trimId, state: "completed" })] }),
        ),
      )
      .mockResolvedValueOnce(response({ kind: "cleanup", job: cleanup({ state: "completed" }) }));
    const waiting = run("jobs", "--watch");
    await vi.advanceTimersByTimeAsync(1000);
    await waiting;
    expect(console.log).toHaveBeenCalledTimes(2);
    expect(lastJSON()).toEqual({ trimJobs: [], cleanupJobs: [cleanup({ state: "completed" })] });
  });
  test("missing jobs are errors, not assumed completed", async () => {
    mock.fetch.mockResolvedValue(response({ error: "not found" }, 404));
    await expect(run("wait", cleanupId)).rejects.toThrow("completion cannot be confirmed");
    expect(console.log).not.toHaveBeenCalled();
  });
  test("a wrong job ID returned by lookup cannot authorize cancellation", async () => {
    mock.fetch.mockResolvedValue(
      response({ kind: "cleanup", job: cleanup({ id: trimId, state: "completed" }) }),
    );
    await expect(run("cancel", cleanupId, "--yes")).rejects.toThrow("did not match requested ID");
    expect(mock.fetch).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalled();
  });
  test("two-job watch refuses duplicate lookup results instead of falsely completing both jobs", async () => {
    vi.useFakeTimers();
    mock.fetch
      .mockResolvedValueOnce(response(snapshot({ trimJobs: [trim()], cleanupJobs: [cleanup()] })))
      .mockResolvedValueOnce(response({ kind: "trim", job: trim({ state: "completed" }) }))
      .mockResolvedValueOnce(response({ kind: "trim", job: trim({ state: "completed" }) }));
    const waiting = expect(run("jobs", "--watch")).rejects.toThrow(`requested ID ${cleanupId}`);
    await vi.advanceTimersByTimeAsync(1000);
    await waiting;
    expect(mock.fetch.mock.calls.map((call) => call[0])).toEqual([
      "/admin/storage",
      `/admin/storage/jobs/${trimId}`,
      `/admin/storage/jobs/${cleanupId}`,
    ]);
    expect(console.log).toHaveBeenCalledOnce();
    expect(lastJSON()).toMatchObject({
      trimJobs: [{ state: "queued" }],
      cleanupJobs: [{ state: "queued" }],
    });
  });
  test("old gateways receive an actionable cleanup API error", async () => {
    mock.fetch.mockResolvedValue(response({ error: "not found" }, 404));
    await expect(
      run("cleanup", "conversations", "--before", "2024-01-01", "--yes"),
    ).rejects.toThrow("upgrade");
  });
  test("permission refusal remains a nonzero error", async () => {
    mock.fetch.mockResolvedValue(response({ error: "Admin required" }, 403));
    await expect(run("status")).rejects.toMatchObject({ exitCode: EXIT_AUTH });
  });
  test("malformed successful response cannot be reported as accepted", async () => {
    mock.fetch.mockResolvedValue(response({ ok: true }, 202));
    await expect(
      run("trim", "invented:archive", "--before", "2024-01-01", "--yes"),
    ).rejects.toThrow("invalid storage response");
    expect(console.log).not.toHaveBeenCalled();
  });
});

describe("honest storage presentation", () => {
  test("keeps pending accounting distinct from zero and avoids inventing source totals", () => {
    const rendered = renderStorage(storageSnapshotSchema.parse(snapshot()), { history: true });
    expect(rendered).toContain("measurement pending");
    expect(rendered).toContain("unavailable values are not zero");
    expect(rendered).toContain("Shared lexical-index structures: pending");
  });
  test("renders source/month raw payload and shared lexical allocation separately", () => {
    const data = storageSnapshotSchema.parse(
      snapshot({
        logical: {
          measuredAt: before,
          sources: [
            {
              sourceId: "invented:archive",
              documents: 2,
              payloadBytes: 90,
              months: [{ month: "2023-01", documents: 2, payloadBytes: 90 }],
            },
            { sourceId: "invented:other", documents: 1, payloadBytes: 20, months: [] },
          ],
        },
        index: {
          measuredAt: before,
          embeddingBytes: 120,
          lexicalBytes: 900,
          sources: [
            {
              sourceId: "invented:archive",
              month: "2023-01",
              chunkCount: 2,
              embeddingBytes: 120,
              textBytes: 30,
            },
          ],
        },
      }),
    );
    const rendered = renderStorage(data, { source: "invented:archive", history: true });
    expect(rendered).toContain("Shared lexical-index structures: 900 B");
    expect(rendered).toContain("documents 90 B, vectors 120 B, indexed text 30 B");
    expect(rendered).toContain("2023-01");
    expect(rendered).not.toContain("invented:other");
  });
  test("retryable and committed-cleanup states stay visibly pending", () => {
    const job = storageSnapshotSchema.parse(
      snapshot({ cleanupJobs: [cleanup({ state: "failed", hasPendingRemoval: true })] }),
    ).cleanupJobs![0]!;
    expect(pendingStorageJob(job)).toBe(true);
    expect(storageJobLine(job)).toContain("retrying pending removal");
  });
  test("large monthly histories aggregate raw index rows without losing duplicate buckets", () => {
    const sources = Array.from({ length: 40 }, (_, sourceIndex) => ({
      sourceId: `invented:source-${sourceIndex}`,
      documents: 240,
      payloadBytes: 480,
      months: Array.from({ length: 240 }, (_, m) => ({
        month: `${2000 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}`,
        documents: 1,
        payloadBytes: 2,
      })),
    }));
    const data = storageSnapshotSchema.parse(
      snapshot({
        logical: { measuredAt: before, sources },
        index: {
          measuredAt: before,
          lexicalBytes: 900,
          embeddingBytes: 9600,
          sources: sources.flatMap((source) =>
            source.months.flatMap((month) =>
              [1, 2].map(() => ({
                sourceId: source.sourceId,
                month: month.month,
                chunkCount: 1,
                embeddingBytes: 3,
                textBytes: 4,
              })),
            ),
          ),
        },
      }),
    );
    const rendered = renderStorage(data, { source: "invented:source-2", history: true });
    expect(rendered.match(/documents 2 B, vectors 6 B, indexed text 8 B/g)).toHaveLength(240);
    expect(rendered).not.toContain("invented:source-3");
    expect(rendered).toMatch(/below 500(?:\.0)? M(?:i)?B free/);
  });
});
