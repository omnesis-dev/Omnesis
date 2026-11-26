// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { classifyRestoreFailure, restoreFailureCode, RestoreWorkerFailure } from "./failure.js";
import { runRestoreProcess } from "./process-launcher.js";

test("unknown private exceptions become only a fixed code with no message, cause, path or SQL", () => {
  const secret = "invented-private-key-and-SQL-text";
  const original = Object.assign(new Error(secret, { cause: new Error(secret) }), { code: secret });
  const envelope = { ok: false, failureCode: classifyRestoreFailure(original) };
  expect(envelope).toEqual({ ok: false, failureCode: "unknown" });
  expect(JSON.stringify(envelope)).not.toContain(secret);
  const projected = new RestoreWorkerFailure(envelope.failureCode);
  expect(projected.message).toBe("The backup database could not be prepared safely");
  expect(projected.cause).toBeUndefined();
  expect(JSON.stringify(projected)).toBe('{"failureCode":"unknown"}');
  expect(restoreFailureCode(secret)).toBeUndefined();
});

test("only exact reviewed invariant messages and SQLite codes receive recognized classifications", () => {
  expect(classifyRestoreFailure(new Error("Encrypted database page authentication failed"))).toBe(
    "page-authentication",
  );
  expect(classifyRestoreFailure(new Error("The backup database schema is incomplete"))).toBe(
    "incomplete-schema",
  );
  expect(
    classifyRestoreFailure(
      new Error("This backup contains a database table without a reviewed restore policy"),
    ),
  ).toBe("unreviewed-table");
  expect(
    classifyRestoreFailure(
      Object.assign(new Error("invented SQL including secret"), { code: "SQLITE_NOTADB" }),
    ),
  ).toBe("sqlite-notadb");
  expect(
    classifyRestoreFailure(
      Object.assign(new Error("invented SQL"), { code: "SQLITE_NOTADB_private" }),
    ),
  ).toBe("unknown");
  expect(classifyRestoreFailure({ message: "Encrypted database page authentication failed" })).toBe(
    "unknown",
  );
});

test("actual owned worker input rejection exposes a finite input-schema reason only", async () => {
  expect(
    await runRestoreProcess({ action: "invented-private-input" }, new AbortController().signal),
  ).toEqual({ ok: false, failureCode: "input-schema" });
});
