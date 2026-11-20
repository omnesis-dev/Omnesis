// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { ownedProcessCleanupReceipt } from "@omnesis/core";
import { createServer } from "./server.js";
import { createDatabase } from "./db.js";
import { DoctorService } from "./http/services/DoctorService.js";

afterEach(() => vi.restoreAllMocks());

test("a composed server transfers doctor ownership without blocking independent route closure", async () => {
  const db = createDatabase(":memory:");
  let release!: () => void;
  const proof = new Promise<void>((resolve) => {
    release = resolve;
  });
  const close = vi.spyOn(DoctorService.prototype, "close").mockReturnValue(proof);
  let owner: Pick<DoctorService, "close" | "cleanupFailure"> | undefined;
  const app = createServer(db, undefined, {
    onDoctorCleanupOwner: (value) => {
      owner = value;
    },
  });
  try {
    expect(owner).toBeInstanceOf(DoctorService);
    const closing = owner!.close();
    await app.close();
    expect(close).toHaveBeenCalledOnce();
    release();
    await closing;
  } finally {
    release();
    await app.close();
    db.close();
  }
});

test("a standalone server retains an undefined doctor marker through route cleanup aggregation", async () => {
  const db = createDatabase(":memory:");
  const failure = Object.assign(new Error("Invented unjoined doctor"), {
    cleanupFailure: undefined,
  });
  vi.spyOn(DoctorService.prototype, "close").mockRejectedValue(failure);
  const app = createServer(db);
  try {
    const closing = app.close();
    expect(app.close()).toBe(closing);
    const error = await closing.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(ownedProcessCleanupReceipt(error)).toEqual({ failure: undefined, pending: false });
    expect(error).toBeInstanceOf(AggregateError);
  } finally {
    await app.close().catch(() => {});
    db.close();
  }
});
