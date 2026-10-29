// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { DeviceId, type DeviceKind } from "@omnesis/types";
import {
  MAX_REPORTED_VERSION_CHARS,
  createReportedVersionRecorder,
  parseReportedClientVersion,
} from "./reported-client-version.js";

describe("parseReportedClientVersion", () => {
  test.each(["0.7.0", "1.12.3", "0.8.0-rc.1", "0.7.0+abc123", "10.0.0-beta.2"])(
    "accepts the product version %s",
    (raw) => {
      expect(parseReportedClientVersion(raw)).toBe(raw);
    },
  );

  test.each([
    undefined,
    "",
    "0.7",
    "v0.7.0",
    " 0.7.0",
    "0.7.0 ",
    "01.7.0",
    "0.7.0-",
    "0.7.0-rc 1",
    "0.7.0\n",
    "latest",
    "<script>",
  ])("ignores %j", (raw) => {
    expect(parseReportedClientVersion(raw)).toBeNull();
  });

  test("ignores an over-long value even when it is shaped like a version", () => {
    const long = `0.7.0-${"a".repeat(MAX_REPORTED_VERSION_CHARS)}`;
    expect(parseReportedClientVersion(long)).toBeNull();
    const atLimit = `0.7.0-${"a".repeat(MAX_REPORTED_VERSION_CHARS - 6)}`;
    expect(atLimit).toHaveLength(MAX_REPORTED_VERSION_CHARS);
    expect(parseReportedClientVersion(atLimit)).toBe(atLimit);
  });
});

describe("createReportedVersionRecorder", () => {
  const BROWSER = DeviceId("0d0e0f10-1111-4222-8333-444455556666");
  const OTHER = DeviceId("1a2b3c4d-1111-4222-8333-444455556666");

  function setup() {
    let clock = 1_700_000_000_000;
    const record = vi.fn(async (_id: DeviceId, _version: string) => true);
    const recorder = createReportedVersionRecorder({ record, now: () => clock });
    const flush = () => new Promise((r) => setTimeout(r, 0));
    return {
      record,
      recorder,
      flush,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  const row = (version: string | null, kind: DeviceKind = "browser", id = BROWSER) => ({
    id,
    kind,
    version,
  });

  test("writes a browser's new version once", async () => {
    const { record, recorder, flush } = setup();
    recorder.note(row("0.6.0"), "0.7.0");
    await flush();
    expect(record).toHaveBeenCalledExactlyOnceWith(BROWSER, "0.7.0");
  });

  test("writes nothing when the row already reads the reported version", async () => {
    const { record, recorder, flush } = setup();
    for (let i = 0; i < 20; i += 1) recorder.note(row("0.7.0"), "0.7.0");
    await flush();
    expect(record).not.toHaveBeenCalled();
  });

  test("a storm of requests before the write lands adds no writer load", async () => {
    const { record, recorder, flush } = setup();
    // Every request read the row before the write committed, so each still
    // sees the old version.
    for (let i = 0; i < 50; i += 1) recorder.note(row("0.6.0"), "0.7.0");
    await flush();
    expect(record).toHaveBeenCalledTimes(1);
  });

  test("a different version reported meanwhile is written at once", async () => {
    const { record, recorder, flush } = setup();
    recorder.note(row("0.6.0"), "0.7.0");
    recorder.note(row("0.6.0"), "0.7.1");
    await flush();
    expect(record.mock.calls).toEqual([
      [BROWSER, "0.7.0"],
      [BROWSER, "0.7.1"],
    ]);
  });

  test("retries the same version only after the cooldown", async () => {
    const { record, recorder, flush, advance } = setup();
    record.mockRejectedValueOnce(new Error("writer busy"));
    recorder.note(row("0.6.0"), "0.7.0");
    await flush();
    advance(30_000);
    recorder.note(row("0.6.0"), "0.7.0");
    await flush();
    expect(record).toHaveBeenCalledTimes(1);

    advance(31_000);
    recorder.note(row("0.6.0"), "0.7.0");
    await flush();
    expect(record).toHaveBeenCalledTimes(2);
  });

  test("ignores a malformed or absent report", async () => {
    const { record, recorder, flush } = setup();
    recorder.note(row("0.6.0"), undefined);
    recorder.note(row("0.6.0"), "");
    recorder.note(row("0.6.0"), "not-a-version");
    recorder.note(row("0.6.0"), `0.7.0-${"x".repeat(100)}`);
    await flush();
    expect(record).not.toHaveBeenCalled();
  });

  test("ignores devices that report their version over the device socket", async () => {
    const { record, recorder, flush } = setup();
    for (const kind of ["collector", "cli", "portal", "ios", "android", "agent"] as const) {
      recorder.note(row("0.6.0", kind, OTHER), "0.7.0");
    }
    await flush();
    expect(record).not.toHaveBeenCalled();
  });

  test("a failed write never escapes to the request", async () => {
    const { record, recorder, flush } = setup();
    record.mockImplementationOnce(() => {
      throw new Error("synchronous failure");
    });
    expect(() => recorder.note(row("0.6.0"), "0.7.0")).not.toThrow();
    await flush();
    expect(record).toHaveBeenCalledTimes(1);
  });
});
