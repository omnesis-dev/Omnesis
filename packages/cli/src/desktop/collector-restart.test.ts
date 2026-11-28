// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { describe, expect, test, vi } from "vitest";
import { DesktopCollectorRestart } from "./collector-restart.js";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const identity = {
  deviceId: "00000000-0000-4000-8000-000000000004",
  fingerprint: "fictional-fingerprint",
};
const live = () => ({ exited: new Promise<never>(() => {}) });
const signal = () => AbortSignal.timeout(1000);

describe("owned collector restart", () => {
  test("waits for the new child authenticated identity, never the prior child", async () => {
    const verify = vi.fn(async () => identity);
    const restart = new DesktopCollectorRestart(verify);
    const oldReady = deferred<string>();
    restart.started({ ...live(), collectorReady: oldReady.promise });
    const pending = restart.request(signal());
    await vi.waitFor(() => expect(restart.signal.aborted).toBe(true));
    oldReady.resolve(identity.deviceId);
    let done = false;
    void pending.then(() => {
      done = true;
    });
    expect(restart.consume()).toBe(true);
    expect(done).toBe(false);
    const ready = deferred<string>();
    restart.started({ ...live(), collectorReady: ready.promise });
    expect(done).toBe(false);
    ready.resolve(identity.deviceId);
    expect(await pending).toEqual({
      kind: "desktopCollectorRestart",
      status: "ready",
      deviceId: identity.deviceId,
      permissionRecheckRequired: true,
    });
    expect(verify).toHaveBeenCalledTimes(2);
  });
  test("refuses uncertain ownership and concurrent restart", async () => {
    const restart = new DesktopCollectorRestart(async () => identity);
    await expect(restart.request(signal())).rejects.toThrow("owned local collector");
    restart.started(live());
    const abort = new AbortController();
    const request = restart.request(abort.signal);
    await vi.waitFor(() => expect(restart.signal.aborted).toBe(true));
    await expect(restart.request(signal())).rejects.toThrow("owned local collector");
    abort.abort();
    await expect(request).rejects.toThrow("interrupted");
  });
  test.each(["different-device", "changed-credential", "exited", "missing-readiness"])(
    "refuses %s rather than acknowledging a spawn",
    async (failure) => {
      const verify = vi.fn(async () => identity);
      const restart = new DesktopCollectorRestart(verify);
      restart.started(live());
      const request = restart.request(signal());
      const rejected = expect(request).rejects.toThrow("confirm a paired restart");
      await vi.waitFor(() => expect(restart.signal.aborted).toBe(true));
      restart.consume();
      const ready = deferred<string>(),
        exited = deferred<void>();
      restart.started({
        exited: exited.promise,
        ...(failure === "missing-readiness" ? {} : { collectorReady: ready.promise }),
      });
      if (failure === "changed-credential")
        verify.mockResolvedValue({ ...identity, fingerprint: "changed" });
      if (failure === "exited") exited.resolve();
      else ready.resolve(failure === "different-device" ? "other" : identity.deviceId);
      await rejected;
    },
  );
  test("failed admission never interrupts the owned collector", async () => {
    const restart = new DesktopCollectorRestart(async () => {
      throw new Error("blocked");
    });
    restart.started(live());
    await expect(restart.request(signal())).rejects.toThrow("blocked");
    expect(restart.signal.aborted).toBe(false);
  });
  test("daemon shutdown rejects pending without a ready outcome", async () => {
    const restart = new DesktopCollectorRestart(async () => identity);
    restart.started(live());
    const request = restart.request(signal());
    const rejected = expect(request).rejects.toThrow("service stopped");
    await vi.waitFor(() => expect(restart.signal.aborted).toBe(true));
    restart.close();
    await rejected;
  });
});

test("cancellation during drain cannot admit a second request into the unfinished replacement", async () => {
  const restart = new DesktopCollectorRestart(async () => identity);
  restart.started(live());
  const abort = new AbortController();
  const pending = restart.request(abort.signal);
  await vi.waitFor(() => expect(restart.signal.aborted).toBe(true));
  restart.consume();
  abort.abort();
  await expect(pending).rejects.toThrow("interrupted");
  await expect(restart.request(signal())).rejects.toThrow("owned local collector");
  restart.started({ ...live(), collectorReady: Promise.resolve(identity.deviceId) });
  expect(restart.signal.aborted).toBe(false);
});
