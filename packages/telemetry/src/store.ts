// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { utcDay, weekSegment, type Heartbeat } from "./schema.js";

interface Count {
  count: number;
}
interface Aggregate {
  kind: string;
  period: string;
  dimension: string;
  value: string;
  count: number;
}

/** Stores day-level reports only. Neither HTTP metadata nor precise arrival times enter SQLite. */
export class TelemetryStore {
  readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = DELETE");
    this.db.pragma("secure_delete = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reports (
        day TEXT NOT NULL, period TEXT NOT NULL, id TEXT NOT NULL,
        version TEXT NOT NULL, commit_sha TEXT NOT NULL, os TEXT NOT NULL, arch TEXT NOT NULL,
        PRIMARY KEY (day, id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS reports_period ON reports(period, id, day);
      CREATE TABLE IF NOT EXISTS aggregates (
        kind TEXT NOT NULL, period TEXT NOT NULL, dimension TEXT NOT NULL,
        value TEXT NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY(kind, period, dimension, value)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL) WITHOUT ROWID;
    `);
  }

  ingest(payload: Heartbeat, now: Date): void {
    const day = utcDay(now);
    if (payload.period !== day.slice(0, 7)) throw new Error("period");
    this.db.transaction(() => {
      const week = weekSegment(day);
      const weekEnd = new Date(`${week}T00:00:00Z`);
      // A segment starting on the first may be shorter than seven days.
      weekEnd.setUTCDate(weekEnd.getUTCDate() + (7 - ((weekEnd.getUTCDay() + 6) % 7)));
      const knownInWeek = this.db
        .prepare("SELECT 1 FROM reports WHERE period=? AND id=? AND day>=? AND day<? LIMIT 1")
        .get(payload.period, payload.installationId, week, utcDay(weekEnd));
      const prior = this.db
        .prepare(
          "SELECT day,version,commit_sha,os,arch FROM reports WHERE period=? AND id=? ORDER BY day DESC LIMIT 1",
        )
        .get(payload.period, payload.installationId) as
        { day: string; version: string; commit_sha: string; os: string; arch: string } | undefined;
      // First accepted report for a UTC day wins: retry storms never multiply installations.
      const inserted = this.db
        .prepare("INSERT OR IGNORE INTO reports VALUES (?,?,?,?,?,?,?)")
        .run(
          day,
          payload.period,
          payload.installationId,
          payload.gatewayVersion,
          payload.gitCommit,
          payload.os,
          payload.arch,
        ).changes;
      this.increment("heartbeats");
      if (!inserted) return;
      this.add("day", day, "all", "all", 1);
      if (!knownInWeek) this.add("week", week, "all", "all", 1);
      if (!prior) this.add("month", payload.period, "all", "all", 1);
      if (prior && prior.day > day) return;
      for (const [dimension, value, old] of [
        ["version", payload.gatewayVersion, prior?.version],
        ["commit", payload.gitCommit, prior?.commit_sha],
        ["os", payload.os, prior?.os],
        ["arch", payload.arch, prior?.arch],
      ] as const) {
        if (old === value) continue;
        if (old) this.add("month", payload.period, dimension, old, -1);
        this.add("month", payload.period, dimension, value, 1);
      }
    })();
  }

  increment(name: "heartbeats" | "rejected" | "limited"): void {
    this.db
      .prepare("INSERT INTO counters VALUES (?,1) ON CONFLICT(name) DO UPDATE SET value=value+1")
      .run(name);
  }

  private add(
    kind: string,
    period: string,
    dimension: string,
    value: string,
    amount: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO aggregates VALUES (?,?,?,?,?) ON CONFLICT(kind,period,dimension,value)
      DO UPDATE SET count=count+excluded.count`,
      )
      .run(kind, period, dimension, value, amount);
    this.db
      .prepare(
        "DELETE FROM aggregates WHERE kind=? AND period=? AND dimension=? AND value=? AND count=0",
      )
      .run(kind, period, dimension, value);
  }

  /** Completed-month identifiers are no longer needed: calendar aggregates are already durable. */
  prune(now: Date): number {
    const before = now.toISOString().slice(0, 7);
    return this.db.prepare("DELETE FROM reports WHERE period < ?").run(before).changes;
  }

  metrics(now: Date, latestStable: string): string {
    const rows = this.db.prepare("SELECT * FROM aggregates").all() as Aggregate[];
    const current = utcDay(now);
    const escape = (value: string) => JSON.stringify(value);
    const lines = ["# TYPE omnesis_telemetry_active_installations gauge"];
    for (const row of rows) {
      // The date label is part of the metric's identity; it must never be summed across months.
      lines.push(
        `omnesis_telemetry_active_installations{kind=${escape(row.kind)},period=${escape(row.period)},dimension=${escape(row.dimension)},value=${escape(row.value)}} ${row.count}`,
      );
    }
    for (const [kind, period] of [
      ["day", current],
      ["week", weekSegment(current)],
      ["month", current.slice(0, 7)],
    ]) {
      const count =
        rows.find((row) => row.kind === kind && row.period === period && row.dimension === "all")
          ?.count ?? 0;
      lines.push(`omnesis_telemetry_current_installations{kind=${escape(kind)}} ${count}`);
    }
    const monthRows = rows.filter(
      (row) => row.kind === "month" && row.period === current.slice(0, 7),
    );
    for (const row of monthRows.filter((row) => row.dimension !== "all")) {
      lines.push(
        `omnesis_telemetry_distribution{dimension=${escape(row.dimension)},value=${escape(row.value)}} ${row.count}`,
      );
    }
    const latest =
      monthRows.find((row) => row.dimension === "version" && row.value === latestStable)?.count ??
      0;
    const total = monthRows.find((row) => row.dimension === "all")?.count ?? 0;
    if (latestStable)
      lines.push(`omnesis_telemetry_latest_stable_percent ${total ? (latest / total) * 100 : 0}`);
    const previous = new Date(`${current.slice(0, 7)}-01T00:00:00Z`);
    previous.setUTCMonth(previous.getUTCMonth() - 1);
    const completedTotal = rows.find(
      (row) =>
        row.kind === "month" &&
        row.period === previous.toISOString().slice(0, 7) &&
        row.dimension === "all",
    )?.count;
    previous.setUTCMonth(previous.getUTCMonth() - 1);
    const prevTotal = rows.find(
      (row) =>
        row.kind === "month" &&
        row.period === previous.toISOString().slice(0, 7) &&
        row.dimension === "all",
    )?.count;
    if (prevTotal && completedTotal !== undefined)
      lines.push(
        `omnesis_telemetry_month_growth_percent ${(completedTotal / prevTotal - 1) * 100}`,
      );
    for (const row of this.db.prepare("SELECT name,value FROM counters").all() as {
      name: string;
      value: number;
    }[]) {
      lines.push(`omnesis_telemetry_requests_total{outcome=${escape(row.name)}} ${row.value}`);
    }
    lines.push(
      `omnesis_telemetry_raw_records ${(this.db.prepare("SELECT count(*) AS count FROM reports").get() as Count).count}`,
    );
    return `${lines.join("\n")}\n`;
  }

  close(): void {
    this.db.close();
  }
}
