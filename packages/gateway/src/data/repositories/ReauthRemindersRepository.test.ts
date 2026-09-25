// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { unlinkSync, existsSync } from "node:fs";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../db.js";
import { isReminderDue, resolveReauthBackoffConfig } from "../../push/reauth-reminder-policy.js";
import {
  commitReauthReminder,
  getReauthReminder,
  clearReauthReminder,
  reserveReauthReminder,
} from "./ReauthRemindersRepository.js";

let dbPath: string;
let db: ReturnType<typeof createDatabase>;

beforeEach(() => {
  dbPath = `/tmp/omnesis-reauth-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

const PRINCIPAL = "google:user@example.com";
const LAPTOP = "device-maya-laptop";
const STUDIO = "device-studio-mini";
const DAY = 24 * 60 * 60 * 1000;
const cfg = resolveReauthBackoffConfig(undefined); // 1d → ×2 → cap 7d

function recordIfDue(principal: string, deviceId: string, now: number): boolean {
  const token = reserveReauthReminder(
    db,
    principal,
    deviceId,
    now,
    cfg.reservationTtlMs,
    (existing) => isReminderDue(existing, now, cfg),
  );
  return token ? commitReauthReminder(db, token, now) : false;
}

describe("reauth reminder backoff gate (persisted)", () => {
  test("first call for a connection on a device is due; the row is created", () => {
    expect(getReauthReminder(db, PRINCIPAL, LAPTOP)).toBeNull();
    expect(recordIfDue(PRINCIPAL, LAPTOP, 0)).toBe(true);
    const row = getReauthReminder(db, PRINCIPAL, LAPTOP);
    expect(row).not.toBeNull();
    expect(row?.device_id).toBe(LAPTOP);
    expect(row?.notify_count).toBe(1);
    expect(row?.first_needed_at).toBe(0);
    expect(row?.last_notified_at).toBe(0);
  });

  test("multiple sources / ticks on one connection within the window fire ONCE", () => {
    // Gmail, Calendar, Contacts, Drive all flip to needs-auth on the same
    // tick, then re-emit every tick — all share one principal on one device.
    expect(recordIfDue(PRINCIPAL, LAPTOP, 0)).toBe(true); // gmail, first → due
    expect(recordIfDue(PRINCIPAL, LAPTOP, 0)).toBe(false); // calendar, same instant
    expect(recordIfDue(PRINCIPAL, LAPTOP, 60_000)).toBe(false); // contacts, +1m
    expect(recordIfDue(PRINCIPAL, LAPTOP, 6 * 60 * 60 * 1000)).toBe(false); // drive, +6h
    // Still exactly one reminder recorded.
    expect(getReauthReminder(db, PRINCIPAL, LAPTOP)?.notify_count).toBe(1);
  });

  test("reminder re-fires on the 1d → 2d → 4d → 7d ladder", () => {
    expect(recordIfDue(PRINCIPAL, LAPTOP, 0)).toBe(true); // #1 at t=0
    expect(recordIfDue(PRINCIPAL, LAPTOP, DAY - 1)).toBe(false); // before 1d
    expect(recordIfDue(PRINCIPAL, LAPTOP, DAY)).toBe(true); // #2 at +1d
    expect(recordIfDue(PRINCIPAL, LAPTOP, DAY + 2 * DAY - 1)).toBe(false); // before 2d gap
    expect(recordIfDue(PRINCIPAL, LAPTOP, DAY + 2 * DAY)).toBe(true); // #3 at +2d
    const afterThird = DAY + 2 * DAY;
    expect(recordIfDue(PRINCIPAL, LAPTOP, afterThird + 4 * DAY - 1)).toBe(false); // before 4d gap
    expect(recordIfDue(PRINCIPAL, LAPTOP, afterThird + 4 * DAY)).toBe(true); // #4 at +4d
    expect(getReauthReminder(db, PRINCIPAL, LAPTOP)?.notify_count).toBe(4);
  });

  test("successful re-auth resets state — the next expiry starts fresh", () => {
    expect(recordIfDue(PRINCIPAL, LAPTOP, 0)).toBe(true);
    expect(recordIfDue(PRINCIPAL, LAPTOP, DAY)).toBe(true); // now 2 reminders deep
    expect(getReauthReminder(db, PRINCIPAL, LAPTOP)?.notify_count).toBe(2);

    // The device re-auths the connection.
    clearReauthReminder(db, PRINCIPAL, LAPTOP);
    expect(getReauthReminder(db, PRINCIPAL, LAPTOP)).toBeNull();

    // A later re-expiry fires immediately again (ladder back at the start),
    // not gated by the prior backoff.
    expect(recordIfDue(PRINCIPAL, LAPTOP, 100 * DAY)).toBe(true);
    expect(getReauthReminder(db, PRINCIPAL, LAPTOP)?.notify_count).toBe(1);
  });

  test("distinct connections back off independently", () => {
    const outlook = "outlook:other@example.com";
    expect(recordIfDue(PRINCIPAL, LAPTOP, 0)).toBe(true);
    expect(recordIfDue(outlook, LAPTOP, 0)).toBe(true); // unrelated principal still due
    expect(recordIfDue(PRINCIPAL, LAPTOP, 60_000)).toBe(false);
    expect(recordIfDue(outlook, LAPTOP, 60_000)).toBe(false);
    expect(getReauthReminder(db, PRINCIPAL, LAPTOP)?.notify_count).toBe(1);
    expect(getReauthReminder(db, outlook, LAPTOP)?.notify_count).toBe(1);
  });

  test("two devices on one connection back off independently", () => {
    // Each member holds its own grant: the laptop's reminder does not
    // satisfy the studio machine's, and each ladder advances on its own.
    expect(recordIfDue(PRINCIPAL, LAPTOP, 0)).toBe(true);
    expect(recordIfDue(PRINCIPAL, STUDIO, 60_000)).toBe(true);
    expect(recordIfDue(PRINCIPAL, LAPTOP, 60_000)).toBe(false);
    expect(recordIfDue(PRINCIPAL, STUDIO, 120_000)).toBe(false);
    expect(recordIfDue(PRINCIPAL, LAPTOP, DAY)).toBe(true);
    expect(recordIfDue(PRINCIPAL, STUDIO, DAY)).toBe(false); // its own 1d rung is 60s later
    expect(recordIfDue(PRINCIPAL, STUDIO, DAY + 60_000)).toBe(true);
    expect(getReauthReminder(db, PRINCIPAL, LAPTOP)?.notify_count).toBe(2);
    expect(getReauthReminder(db, PRINCIPAL, STUDIO)?.notify_count).toBe(2);
  });

  test("clearing one device's reminder leaves the sibling device's untouched", () => {
    expect(recordIfDue(PRINCIPAL, LAPTOP, 0)).toBe(true);
    expect(recordIfDue(PRINCIPAL, STUDIO, 0)).toBe(true);

    clearReauthReminder(db, PRINCIPAL, LAPTOP);

    expect(getReauthReminder(db, PRINCIPAL, LAPTOP)).toBeNull();
    expect(getReauthReminder(db, PRINCIPAL, STUDIO)?.notify_count).toBe(1);
    // The studio machine is still inside its backoff window.
    expect(recordIfDue(PRINCIPAL, STUDIO, 60_000)).toBe(false);
    // The laptop's next expiry starts a fresh episode.
    expect(recordIfDue(PRINCIPAL, LAPTOP, 60_000)).toBe(true);
  });

  test("clear is a no-op when no row exists", () => {
    expect(() => clearReauthReminder(db, "nope:none@example.com", LAPTOP)).not.toThrow();
  });
});

describe("the device-less row (device_id = ''): a principal-wide episode awaiting adoption", () => {
  function insertLegacyRow(lastNotifiedAt: number, notifyCount: number): void {
    db.prepare(
      `INSERT INTO reauth_reminders (principal, device_id, first_needed_at, last_notified_at, notify_count)
       VALUES (?, '', 0, ?, ?)`,
    ).run(PRINCIPAL, lastNotifiedAt, notifyCount);
  }

  test("the first device to need a reminder adopts the row and continues its backoff", () => {
    insertLegacyRow(0, 2); // two reminders deep; next rung is 2d out
    expect(recordIfDue(PRINCIPAL, LAPTOP, DAY)).toBe(false);
    const adopted = getReauthReminder(db, PRINCIPAL, LAPTOP);
    expect(adopted?.notify_count).toBe(2);
    expect(getReauthReminder(db, PRINCIPAL, "")).toBeNull();
    expect(recordIfDue(PRINCIPAL, LAPTOP, 2 * DAY)).toBe(true);
    expect(getReauthReminder(db, PRINCIPAL, LAPTOP)?.notify_count).toBe(3);
  });

  test("a sibling device that needs a reminder after the adoption starts its own episode", () => {
    insertLegacyRow(0, 1);
    expect(recordIfDue(PRINCIPAL, LAPTOP, 1_000)).toBe(false); // adopted, inside 1d window
    expect(recordIfDue(PRINCIPAL, STUDIO, 1_000)).toBe(true); // nothing left to adopt
    expect(getReauthReminder(db, PRINCIPAL, STUDIO)?.notify_count).toBe(1);
    expect(getReauthReminder(db, PRINCIPAL, LAPTOP)?.notify_count).toBe(1);
  });

  test("a sibling's recovery leaves the row for the device that lapses next to adopt", () => {
    insertLegacyRow(0, 3); // three reminders deep; next rung is 4d out
    // The laptop is healthy: its recovery clears its own (absent) row only.
    clearReauthReminder(db, PRINCIPAL, LAPTOP);
    expect(getReauthReminder(db, PRINCIPAL, "")?.notify_count).toBe(3);
    // The studio machine lapses: it adopts the episode mid-backoff rather
    // than re-firing at once.
    expect(recordIfDue(PRINCIPAL, STUDIO, DAY)).toBe(false);
    expect(getReauthReminder(db, PRINCIPAL, "")).toBeNull();
    expect(getReauthReminder(db, PRINCIPAL, STUDIO)?.notify_count).toBe(3);
    expect(recordIfDue(PRINCIPAL, STUDIO, 4 * DAY)).toBe(true);
    expect(getReauthReminder(db, PRINCIPAL, STUDIO)?.notify_count).toBe(4);
  });
});
