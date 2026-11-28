// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";
import { desktopProfile } from "./environment.js";
import { runDesktopRetirementEntry } from "./background-retirement.js";
type Retire = NonNullable<NonNullable<Parameters<typeof runDesktopRetirementEntry>[2]>["retire"]>;
const profile = desktopProfile("/example/home");
const hint = {
  format: 1 as const,
  scope: { format: 1 as const, ...profile },
  epoch: "a".repeat(64),
  nonce: "00000000-0000-4000-8000-000000000001",
  helperPid: process.ppid,
  daemonPid: process.pid,
  pipe: { device: "1", inode: "2" },
};
function fixture() {
  return { required: () => true, verify: vi.fn(() => hint), input: new PassThrough() };
}
test("a raw packaged selector cannot reach retirement policy without native provenance", async () => {
  const f = fixture(),
    retire = vi.fn();
  f.verify.mockImplementation(() => {
    throw new Error("Native retirement refused");
  });
  await expect(
    runDesktopRetirementEntry(
      profile,
      { backgroundOwner: false, signal: new AbortController().signal },
      { ...f, retire },
    ),
  ).rejects.toThrow("Native retirement refused");
  expect(retire).not.toHaveBeenCalled();
});
test("verified retirement preserves the portable policy and passes a live cancellation signal", async () => {
  const f = fixture(),
    retire = vi.fn<Retire>(async () => "retired" as const);
  await runDesktopRetirementEntry(
    profile,
    { backgroundOwner: true, signal: new AbortController().signal },
    { ...f, retire },
  );
  expect(f.verify).toHaveBeenCalledExactlyOnceWith(profile);
  expect(retire).toHaveBeenCalledExactlyOnceWith(profile, expect.any(AbortSignal));
  expect(retire.mock.calls[0]?.[1].aborted).toBe(false);
  expect(f.input.listenerCount("data")).toBe(0);
});
test.each(["end", "data"])(
  "helper %s aborts retirement but joins its actual cleanup",
  async (event) => {
    const f = fixture();
    let release = () => {},
      started = false,
      aborted = false,
      finished = false;
    const drained = new Promise<void>((resolve) => {
      release = resolve;
    });
    const retire = vi.fn<Retire>(async (_profile, signal: AbortSignal) => {
      started = true;
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      await drained;
      return "stopped" as const;
    });
    const pending = runDesktopRetirementEntry(
      profile,
      { backgroundOwner: true, signal: new AbortController().signal },
      { ...f, retire },
    ).then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(started).toBe(true));
    if (event === "end") f.input.end();
    else f.input.write("forbidden command");
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(finished).toBe(false);
    release();
    await pending;
    expect(finished).toBe(true);
  },
);
test("explicit source execution preserves the existing adapter without consuming stdin", async () => {
  const f = fixture(),
    retire = vi.fn(async () => "absent" as const);
  f.input.end();
  await runDesktopRetirementEntry(
    profile,
    { backgroundOwner: false, signal: new AbortController().signal },
    { ...f, required: () => false, retire },
  );
  expect(f.verify).not.toHaveBeenCalled();
  expect(retire).toHaveBeenCalledOnce();
});
test("an already cancelled request performs no native verification or retirement", async () => {
  const f = fixture(),
    retire = vi.fn(),
    abort = new AbortController();
  abort.abort();
  await expect(
    runDesktopRetirementEntry(
      profile,
      { backgroundOwner: true, signal: abort.signal },
      { ...f, retire },
    ),
  ).rejects.toThrow();
  expect(retire).not.toHaveBeenCalled();
  expect(f.verify).not.toHaveBeenCalled();
});

test("an already ended native lifetime cannot reach retirement policy", async () => {
  const f = fixture(),
    retire = vi.fn();
  f.input.resume();
  await new Promise<void>((resolve) => {
    f.input.once("end", resolve);
    f.input.end();
  });
  await expect(
    runDesktopRetirementEntry(
      profile,
      { backgroundOwner: true, signal: new AbortController().signal },
      { ...f, retire },
    ),
  ).rejects.toThrow();
  expect(f.verify).not.toHaveBeenCalled();
  expect(retire).not.toHaveBeenCalled();
});
test("helper loss during native verification is checked before policy admission", async () => {
  const f = fixture(),
    retire = vi.fn();
  f.verify.mockImplementation(() => {
    f.input.emit("close");
    return hint;
  });
  await expect(
    runDesktopRetirementEntry(
      profile,
      { backgroundOwner: true, signal: new AbortController().signal },
      { ...f, retire },
    ),
  ).rejects.toThrow();
  expect(f.verify).toHaveBeenCalledOnce();
  expect(retire).not.toHaveBeenCalled();
});
