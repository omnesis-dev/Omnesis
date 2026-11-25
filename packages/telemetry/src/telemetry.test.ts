// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { heartbeatSchema, weekSegment, type Heartbeat } from "./schema.js";
import { TelemetryStore } from "./store.js";
import { readLatestStable } from "./release.js";
import { createTelemetryServer } from "./server.js";

const heartbeat: Heartbeat = {
  schemaVersion: 1,
  installationId: "a".repeat(64),
  gatewayVersion: "1.2.3",
  gitCommit: "custom",
  os: "linux",
  arch: "x64",
  period: "2026-11",
};
const stores: TelemetryStore[] = [];
function store() {
  const value = new TelemetryStore(":memory:");
  stores.push(value);
  return value;
}
afterEach(() => {
  for (const value of stores.splice(0)) value.close();
});

describe("installation census", () => {
  it("omits latest stable share when release metadata is missing, invalid or stale", () => {
    const folder = mkdtempSync(join(tmpdir(), "omnesis-telemetry-release-"));
    const path = join(folder, "latest-stable");
    const now = Date.parse("2026-11-25T12:00:00Z");
    try {
      expect(readLatestStable(path, now)).toBe("");
      writeFileSync(path, "1.2.3\n");
      utimesSync(path, new Date(now), new Date(now));
      expect(readLatestStable(path, now)).toBe("1.2.3");
      expect(readLatestStable(path, now + 49 * 60 * 60_000)).toBe("");
      writeFileSync(path, "private-branch");
      expect(readLatestStable(path, now)).toBe("");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
  it("strictly validates fields without admitting arbitrary metadata", () => {
    expect(heartbeatSchema.safeParse(heartbeat).success).toBe(true);
    for (const extra of [
      { hostname: "example" },
      { ip: "127.0.0.1" },
      { sources: [] },
      { accountId: "fiction" },
    ])
      expect(heartbeatSchema.safeParse({ ...heartbeat, ...extra }).success).toBe(false);
    for (const invalid of [
      { installationId: "bad" },
      { gatewayVersion: "private-branch" },
      { gitCommit: "private-name" },
      { period: "2026-13" },
      { os: "hostname" },
      { arch: "hardware-id" },
    ])
      expect(heartbeatSchema.safeParse({ ...heartbeat, ...invalid }).success).toBe(false);
  });
  it("deduplicates heartbeat retries and counts distinct installations", () => {
    const db = store();
    const date = new Date("2026-11-25T12:00:00Z");
    db.ingest(heartbeat, date);
    db.ingest(heartbeat, date);
    db.ingest({ ...heartbeat, installationId: "b".repeat(64) }, date);
    expect(db.metrics(date, "1.2.3")).toContain(
      'omnesis_telemetry_current_installations{kind="day"} 2',
    );
    expect(db.metrics(date, "1.2.3")).toContain(
      'omnesis_telemetry_requests_total{outcome="heartbeats"} 3',
    );
    expect(db.metrics(date, "1.2.3")).not.toContain(heartbeat.installationId);
  });
  it("preserves deduplication and aggregates across service restarts", () => {
    const folder = mkdtempSync(join(tmpdir(), "omnesis-telemetry-"));
    const path = join(folder, "census.db");
    const date = new Date("2026-11-25T12:00:00Z");
    try {
      const first = new TelemetryStore(path);
      first.ingest(heartbeat, date);
      first.close();
      const second = new TelemetryStore(path);
      try {
        second.ingest(heartbeat, date);
        expect(second.metrics(date, "1.2.3")).toContain(
          'omnesis_telemetry_current_installations{kind="month"} 1',
        );
        expect(second.db.pragma("journal_mode", { simple: true })).toBe("delete");
        expect(second.db.pragma("secure_delete", { simple: true })).toBe(1);
      } finally {
        second.close();
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
  it("counts an installation once monthly and attributes its latest observed version", () => {
    const db = store();
    db.ingest(heartbeat, new Date("2026-11-24T12:00:00Z"));
    const date = new Date("2026-11-25T12:00:00Z");
    db.ingest({ ...heartbeat, gatewayVersion: "1.2.4" }, date);
    const metrics = db.metrics(date, "1.2.4");
    expect(metrics).toContain('omnesis_telemetry_current_installations{kind="month"} 1');
    expect(metrics).toContain(
      'omnesis_telemetry_distribution{dimension="version",value="1.2.4"} 1',
    );
    expect(metrics).not.toContain(
      'omnesis_telemetry_distribution{dimension="version",value="1.2.3"}',
    );
    expect(metrics).toContain("omnesis_telemetry_latest_stable_percent 100");
  });
  it("keeps the latest version when request bodies finish out of chronological order", () => {
    const db = store();
    db.ingest({ ...heartbeat, gatewayVersion: "1.2.4" }, new Date("2026-11-25T00:00:01Z"));
    db.ingest(heartbeat, new Date("2026-11-24T23:59:59Z"));
    const metrics = db.metrics(new Date("2026-11-25T12:00:00Z"), "1.2.4");
    expect(metrics).toContain('omnesis_telemetry_current_installations{kind="week"} 1');
    expect(metrics).toContain(
      'omnesis_telemetry_distribution{dimension="version",value="1.2.4"} 1',
    );
  });
  it("splits UTC Monday weeks at month boundaries without adding rotated IDs", () => {
    expect(weekSegment("2026-12-01")).toBe("2026-12-01");
    expect(weekSegment("2026-11-30")).toBe("2026-11-30");
    const db = store();
    db.ingest(heartbeat, new Date("2026-11-30T23:59:59Z"));
    const date = new Date("2026-12-01T00:00:00Z");
    db.ingest({ ...heartbeat, period: "2026-12", installationId: "c".repeat(64) }, date);
    expect(db.metrics(date, "")).toContain(
      'omnesis_telemetry_current_installations{kind="week"} 1',
    );
    expect(() => db.ingest(heartbeat, date)).toThrow("period");
  });
  it("deletes identifiers seven days after month end while preserving aggregates", () => {
    const db = store();
    db.ingest(heartbeat, new Date("2026-11-30T12:00:00Z"));
    expect(db.prune(new Date("2026-12-07T23:59:59Z"))).toBe(0);
    expect(db.prune(new Date("2026-12-08T00:00:00Z"))).toBe(1);
    const metrics = db.metrics(new Date("2027-01-01T00:00:00Z"), "");
    expect(metrics).toContain('kind="month",period="2026-11",dimension="all",value="all"} 1');
    expect(metrics).toContain("omnesis_telemetry_raw_records 0");
  });
  it("compares only completed months for adoption growth", () => {
    const db = store();
    db.ingest({ ...heartbeat, period: "2026-09" }, new Date("2026-09-30T12:00:00Z"));
    db.ingest({ ...heartbeat, period: "2026-10" }, new Date("2026-10-31T12:00:00Z"));
    db.ingest(
      { ...heartbeat, period: "2026-10", installationId: "d".repeat(64) },
      new Date("2026-10-31T12:00:00Z"),
    );
    expect(db.metrics(new Date("2026-11-01T00:00:00Z"), "")).toContain(
      "omnesis_telemetry_month_growth_percent 100",
    );
    expect(db.metrics(new Date("2026-10-15T00:00:00Z"), "")).not.toContain(
      "omnesis_telemetry_month_growth_percent",
    );
  });
  it("rejects invalid, oversized and wrong-period HTTP bodies and protects aggregate metrics", async () => {
    const db = store();
    let clock = new Date("2026-11-25T12:00:00Z");
    const server = createTelemetryServer({
      store: db,
      metricsToken: "x".repeat(32),
      latestStable: () => "1.2.3",
      now: () => clock,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("address");
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const post = (payload: unknown) =>
        fetch(`${url}/v1/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      expect((await post(heartbeat)).status).toBe(204);
      expect((await post({ ...heartbeat, period: "2026-10" })).status).toBe(400);
      expect((await post({ ...heartbeat, extra: "x".repeat(2000) })).status).toBe(400);
      expect((await fetch(`${url}/metrics`)).status).toBe(401);
      const response = await fetch(`${url}/metrics`, {
        headers: { Authorization: `Bearer ${"x".repeat(32)}` },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain(heartbeat.installationId);
      for (let i = 0; i < 120; i++) await post(heartbeat);
      expect((await post(heartbeat)).status).toBe(429);
      const increment = vi.spyOn(db, "increment").mockImplementation(() => {
        throw new Error("database unavailable");
      });
      expect((await post(heartbeat)).status).toBe(503);
      increment.mockRestore();
      clock = new Date("2026-11-25T12:01:00Z");
      expect((await post(heartbeat)).status).toBe(204);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
