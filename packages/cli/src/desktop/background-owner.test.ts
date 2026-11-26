// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";
import { desktopProfile } from "./environment.js";
import { runDesktopDaemonEntry } from "./background-owner.js";
type Run = NonNullable<NonNullable<Parameters<typeof runDesktopDaemonEntry>[2]>["run"]>;
const profile = desktopProfile("/example/home");
const hint = {
  format: 1 as const,
  scope: {
    format: 1 as const,
    configDir: profile.configDir,
    instance: profile.instance,
    secretService: profile.secretService,
  },
  epoch: "a".repeat(64),
  nonce: "00000000-0000-4000-8000-000000000001",
  helperPid: process.ppid,
  daemonPid: process.pid,
  pipe: { device: "1", inode: "2" },
};
function fixture() {
  return {
    required: () => true,
    verify: vi.fn(() => hint),
    assert: vi.fn(() => hint),
    input: new PassThrough(),
    output: new PassThrough(),
  };
}
test("forged selector cannot start daemon before native owner verification", async () => {
  const f = fixture(),
    run = vi.fn();
  f.verify.mockImplementation(() => {
    throw new Error("Native owner refused");
  });
  await expect(
    runDesktopDaemonEntry(profile, { backgroundOwner: true }, { ...f, run }),
  ).rejects.toThrow("Native owner refused");
  expect(run).not.toHaveBeenCalled();
});
test("one private safe readiness frame waits for actual daemon admission", async () => {
  const f = fixture();
  const chunks: Buffer[] = [];
  f.output.on("data", (chunk) => chunks.push(chunk));
  let admit: () => void = () => {};
  const admission = new Promise<void>((resolve) => {
    admit = resolve;
  });
  const run = vi.fn<Run>(async (_profile, options) => {
    await admission;
    await options.onOwned?.();
    return "stopped" as const;
  });
  const pending = runDesktopDaemonEntry(profile, { backgroundOwner: true }, { ...f, run });
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  expect(chunks).toEqual([]);
  admit();
  await pending;
  expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({
    version: 1,
    kind: "desktop-daemon-ready",
    nonce: hint.nonce,
    pid: process.pid,
    epoch: hint.epoch,
    scope: hint.scope,
  });
  expect(f.verify).toHaveBeenCalledOnce();
});
test("helper EOF passively aborts and waits actual daemon drain without an early success", async () => {
  const f = fixture();
  let listening = false;
  let aborted = false,
    done = false,
    drain: () => void = () => {};
  const joined = new Promise<void>((resolve) => {
    drain = resolve;
  });
  const run = vi.fn<Run>(async (_profile, options) => {
    await options.onOwned?.();
    listening = true;
    await new Promise<void>((resolve) =>
      options.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          resolve();
        },
        { once: true },
      ),
    );
    await joined;
    return "stopped" as const;
  });
  const pending = runDesktopDaemonEntry(profile, { backgroundOwner: true }, { ...f, run }).then(
    () => {
      done = true;
    },
  );
  await vi.waitFor(() => expect(listening).toBe(true));
  f.input.end();
  await vi.waitFor(() => expect(aborted).toBe(true));
  expect(done).toBe(false);
  drain();
  await pending;
  expect(done).toBe(true);
});
test("changed owner before readiness emits no frame", async () => {
  const f = fixture();
  f.assert.mockReturnValue({ ...hint, nonce: "00000000-0000-4000-8000-000000000002" });
  let bytes = 0;
  f.output.on("data", (b) => {
    bytes += b.length;
  });
  await expect(
    runDesktopDaemonEntry(
      profile,
      { backgroundOwner: true },
      {
        ...f,
        run: async (_profile, options) => {
          await options.onOwned?.();
          return "stopped";
        },
      },
    ),
  ).rejects.toThrow("ownership changed");
  expect(bytes).toBe(0);
});
test("explicit source adapter never treats ignored stdin EOF as helper loss", async () => {
  const f = fixture();
  f.input.end();
  const run = vi.fn<Run>(async (_profile, options) => {
    expect(options.onOwned).toBeUndefined();
    expect(options.signal.aborted).toBe(false);
    return "stopped" as const;
  });
  await runDesktopDaemonEntry(
    profile,
    { backgroundOwner: false },
    { ...f, required: () => false, run },
  );
  expect(f.verify).not.toHaveBeenCalled();
});
