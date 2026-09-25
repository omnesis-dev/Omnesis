// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { canDenyReads } from "../testing/apple-db-fixtures.js";
import { SingleFileAppleDb } from "./single-file-db.js";
import { classifyOpenError, fullDiskAccessDenial, type Db } from "./internal.js";
import type { Logger } from "@omnesis/core";

function fakeLogger(): Logger {
  const noop = vi.fn();
  return {
    debug: noop,
    info: noop,
    warn: vi.fn(),
    error: noop,
    child: () => fakeLogger(),
  } as unknown as Logger;
}

class TestDb extends SingleFileAppleDb {
  /** Set to a reason to make the accept-check reject whatever opens. */
  rejection: string | null = null;
  /** Set to make the accept-check fault the way a truncated file would. */
  throwOnAccept = false;

  constructor(
    path: string,
    readonly logger: Logger,
  ) {
    super(path, "Test", { hint: "the test says so." }, logger);
  }

  protected override reject(_db: Db): string | null {
    if (this.throwOnAccept) throw new Error("file is not a database");
    return this.rejection;
  }

  warnings(): string[] {
    return (this.logger.warn as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0]),
    );
  }
}

class TestDbWithRealHint extends SingleFileAppleDb {
  constructor(path: string, log: Logger) {
    super(path, "Test", fullDiskAccessDenial(), log);
  }
}

describe("SingleFileAppleDb", () => {
  let dir: string;
  let path: string;
  let helper: TestDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-apple-single-file-test-"));
    path = join(dir, "store.sqlite");
    const db = new Database(path);
    db.exec("CREATE TABLE t (x INTEGER)");
    db.close();
    helper = new TestDb(path, fakeLogger());
  });

  afterEach(() => {
    helper.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("an absent database is not a failure", () => {
    const absent = new TestDb(join(dir, "missing.sqlite"), fakeLogger());
    expect(absent.isAvailable()).toBe(false);
    absent.open();
    expect(absent.getLastOpenFailure()).toBeNull();
    expect(absent.getDb()).toBeNull();
  });

  // The provider opens all seven Apple databases in one pass. A helper that
  // threw would end that pass, so every failure below is recorded instead.
  test.skipIf(!canDenyReads)("a denied read is recorded, not thrown", () => {
    chmodSync(path, 0o000);

    expect(() => helper.open()).not.toThrow();

    expect(helper.hasOpenDb()).toBe(false);
    expect(helper.getLastOpenFailure()).toMatchObject({ kind: "denied" });
    expect(helper.getLastOpenFailure()?.message).toContain("Test");
  });

  test("a rejected schema is a failure the source can name", () => {
    helper.rejection = "the schema is one this provider has not been taught.";

    helper.open();

    expect(helper.hasOpenDb()).toBe(false);
    expect(helper.getLastOpenFailure()).toEqual({
      kind: "error",
      message: "the schema is one this provider has not been taught.",
    });
  });

  // A file that opens and faults on first read is still this helper's failure
  // to record, not an exception for the provider's open pass to trip over.
  test("a database that faults while being inspected is recorded, not thrown", () => {
    helper.throwOnAccept = true;

    expect(() => helper.open()).not.toThrow();

    expect(helper.getLastOpenFailure()).toMatchObject({ kind: "error" });
    expect(helper.getLastOpenFailure()?.message).toContain("file is not a database");
  });

  test.skipIf(!canDenyReads)(
    "access restored on a later cycle opens and clears the failure",
    () => {
      chmodSync(path, 0o000);
      helper.open();
      expect(helper.getLastOpenFailure()).not.toBeNull();

      chmodSync(path, 0o644);

      expect(helper.getDb()).not.toBeNull();
      expect(helper.getLastOpenFailure()).toBeNull();
    },
  );

  // Otherwise the source would keep telling the operator to grant access to a
  // database that is no longer on the host.
  test.skipIf(!canDenyReads)("a failure does not outlive the database it was about", () => {
    chmodSync(path, 0o000);
    helper.open();
    expect(helper.getLastOpenFailure()).not.toBeNull();

    chmodSync(path, 0o644);
    rmSync(path, { force: true });

    expect(helper.getDb()).toBeNull();
    expect(helper.getLastOpenFailure()).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  // `open()` runs on every cycle and on every lazy `getDb()`. The durable
  // channel for a standing failure is the source's sync error, not the log.
  test.skipIf(!canDenyReads)("a standing failure is announced once, not once a call", () => {
    chmodSync(path, 0o000);

    helper.open();
    helper.getDb();
    helper.getDb();

    expect(helper.warnings()).toHaveLength(1);
  });

  test("a failure that changes is announced again", () => {
    helper.rejection = "the first reason.";
    helper.open();
    helper.rejection = "a different reason.";
    helper.open();

    expect(helper.warnings()).toEqual(["the first reason.", "a different reason."]);
  });
});

describe("classifyOpenError", () => {
  // macOS reports a database behind a grant the process lacks the same way a
  // file mode does, and on some releases as an authorization denial. Both mean
  // the same thing to an operator, and both must reach them as one.
  test("a refused read is a denial, however macOS phrases it", () => {
    expect(classifyOpenError("SQLITE_CANTOPEN: unable to open database file")).toBe("denied");
    expect(classifyOpenError("authorization denied")).toBe("denied");
  });

  test("a lock is transient, whichever form SQLite reports", () => {
    expect(classifyOpenError("SQLITE_BUSY: database is locked")).toBe("busy");
    expect(classifyOpenError("database is locked")).toBe("busy");
  });

  test("anything else stays unclassified", () => {
    expect(classifyOpenError("file is not a database")).toBe("error");
  });
});

describe("a file that is not a database", () => {
  test("is not mistaken for a denial", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-apple-not-a-db-test-"));
    try {
      const path = join(dir, "store.sqlite");
      writeFileSync(path, "not a database");
      const helper = new TestDb(path, fakeLogger());
      helper.open();
      // SQLite validates the header lazily, so the open itself may well
      // succeed; what must not happen is a thrown error or a denial verdict.
      expect(helper.getLastOpenFailure()?.kind).not.toBe("denied");
      helper.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the remediation an operator is handed", () => {
  // The grant has no consent prompt, and its pane lists binaries rather than
  // apps — the one that must be listed is the process actually running, which
  // is the detail an operator has no way to guess.
  test.skipIf(!canDenyReads)("names the grant, the pane, and the binary that needs it", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-apple-hint-test-"));
    try {
      const path = join(dir, "store.sqlite");
      new Database(path).close();
      const helper = new TestDbWithRealHint(path, fakeLogger());
      chmodSync(path, 0o000);
      helper.open();

      const failure = helper.getLastOpenFailure();
      const message = failure?.message ?? "";
      expect(message).toMatch(/full disk access/i);
      expect(message).toMatch(/system settings/i);
      expect(message).toContain(process.execPath);
      expect(message).toContain("restart the collector");
      // The same remedy, structured, for the clients that render it as an
      // affordance rather than quoting the sentence.
      expect(failure?.remediation).toMatchObject({
        summary: expect.stringMatching(/full disk access is required/i),
        executable: process.execPath,
        restartRequired: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
