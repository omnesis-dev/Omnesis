// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import {
  validateOneDriveCursor,
  fingerprintDriveItem,
  type DriveItem,
  type OneDriveCursor,
} from "./onedrive-types.js";

describe("validateOneDriveCursor", () => {
  it("accepts a bootstrap cursor with no link", () => {
    const cursor: OneDriveCursor = { phase: "bootstrap" };
    expect(validateOneDriveCursor(cursor)).toEqual(cursor);
  });

  it("accepts a bootstrap cursor carrying an @odata.nextLink", () => {
    const cursor: OneDriveCursor = {
      phase: "bootstrap",
      link: "https://graph.microsoft.com/v1.0/me/drive/root/delta?$skiptoken=abc",
    };
    expect(validateOneDriveCursor(cursor)).toEqual(cursor);
  });

  it("accepts an incremental cursor carrying an @odata.deltaLink", () => {
    const cursor: OneDriveCursor = {
      phase: "incremental",
      link: "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=latest",
    };
    expect(validateOneDriveCursor(cursor)).toEqual(cursor);
  });

  it("rejects null / undefined so the source falls back to a fresh bootstrap", () => {
    expect(validateOneDriveCursor(null)).toBeNull();
    expect(validateOneDriveCursor(undefined)).toBeNull();
  });

  it("rejects an unknown phase", () => {
    expect(validateOneDriveCursor({ phase: "done" })).toBeNull();
    expect(validateOneDriveCursor({ phase: "body-backfill" })).toBeNull();
  });

  it("rejects a non-string link", () => {
    expect(validateOneDriveCursor({ phase: "incremental", link: 42 })).toBeNull();
    expect(validateOneDriveCursor({ phase: "bootstrap", link: {} })).toBeNull();
  });

  it("rejects a non-object cursor", () => {
    expect(validateOneDriveCursor("bootstrap")).toBeNull();
    expect(validateOneDriveCursor(7)).toBeNull();
  });

  it("accepts a cursor carrying a seen fingerprint map", () => {
    const cursor: OneDriveCursor = {
      phase: "incremental",
      link: "delta",
      seen: { "item-1": "12|2024-01-02T00:00:00Z|etag-1" },
    };
    expect(validateOneDriveCursor(cursor)).toEqual(cursor);
  });

  it("rejects a malformed seen map", () => {
    // `seen` is the set of files the re-walk reports as still present, so a
    // shape the source never wrote would hand the snapshot reconciliation an
    // arbitrary id set: an array offers its indices, a string its character
    // positions. All of these must send the cursor back to a clean bootstrap.
    expect(validateOneDriveCursor({ phase: "incremental", seen: "item-1" })).toBeNull();
    expect(validateOneDriveCursor({ phase: "incremental", seen: ["item-1"] })).toBeNull();
    expect(validateOneDriveCursor({ phase: "incremental", seen: null })).toBeNull();
    expect(validateOneDriveCursor({ phase: "incremental", seen: { "item-1": 42 } })).toBeNull();
  });
});

describe("fingerprintDriveItem", () => {
  it("changes when size / lastModifiedDateTime / eTag change, stable otherwise", () => {
    const base: DriveItem = {
      id: "i",
      size: 10,
      lastModifiedDateTime: "2024-01-02T00:00:00Z",
      eTag: "v1",
    };
    const fp = fingerprintDriveItem(base);
    expect(fingerprintDriveItem({ ...base })).toBe(fp);
    expect(fingerprintDriveItem({ ...base, size: 11 })).not.toBe(fp);
    expect(
      fingerprintDriveItem({ ...base, lastModifiedDateTime: "2024-02-02T00:00:00Z" }),
    ).not.toBe(fp);
    expect(fingerprintDriveItem({ ...base, eTag: "v2" })).not.toBe(fp);
  });

  it("falls back to cTag when eTag is absent", () => {
    const fp = fingerprintDriveItem({ id: "i", size: 1, cTag: "c1" });
    expect(fp).toContain("c1");
  });
});

describe("validateOneDriveCursor — an in-flight re-walk", () => {
  const walk = {
    link: "https://graph.microsoft.com/v1.0/next",
    seen: { "file-1": "fp" },
    total: 1,
  };

  it("accepts the shape the walk writes, with and without its optional fields", () => {
    expect(validateOneDriveCursor({ phase: "incremental", rewalk: walk })).toMatchObject({
      rewalk: walk,
    });
    expect(
      validateOneDriveCursor({
        phase: "incremental",
        rewalk: { ...walk, deleted: ["gone"], restarts: 1 },
      }),
    ).not.toBeNull();
    // A walk that has not read a page yet has no link to resume from.
    expect(
      validateOneDriveCursor({ phase: "incremental", rewalk: { seen: {}, total: 0 } }),
    ).not.toBeNull();
  });

  it("rejects a malformed accumulator, because it decides what survives reconciliation", () => {
    // The set this holds becomes the whole-drive snapshot, and the gateway
    // deletes every document the snapshot omits. An array would offer its
    // indices as file ids; a string, its character positions.
    for (const rewalk of [
      { seen: ["fp"], total: 1 },
      { seen: "fp", total: 1 },
      { seen: null, total: 1 },
      { seen: { "file-1": 7 }, total: 1 },
      { total: 1 },
    ]) {
      expect(
        validateOneDriveCursor({ phase: "incremental", rewalk }),
        JSON.stringify(rewalk),
      ).toBeNull();
    }
  });

  it("rejects a malformed resume pointer, deletion list, or counter", () => {
    for (const rewalk of [
      { ...walk, link: 42 },
      { ...walk, deleted: "gone" },
      { ...walk, deleted: [7] },
      { ...walk, total: "1" },
      { ...walk, total: -1 },
      { ...walk, total: Number.NaN },
      { ...walk, restarts: -1 },
      { ...walk, restarts: "1" },
    ]) {
      expect(
        validateOneDriveCursor({ phase: "incremental", rewalk }),
        JSON.stringify(rewalk),
      ).toBeNull();
    }
  });

  it("rejects a rewalk that is not an object at all", () => {
    for (const rewalk of ["walking", 7, [], null]) {
      expect(
        validateOneDriveCursor({ phase: "incremental", rewalk }),
        JSON.stringify(rewalk),
      ).toBeNull();
    }
  });
});
