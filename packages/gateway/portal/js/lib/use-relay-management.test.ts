// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
const { request, gatewayVersion } = vi.hoisted(() => ({
  request: vi.fn(),
  gatewayVersion: vi.fn(async () => ""),
}));
vi.mock("./cloud-relay-api.js", async (original) => ({
  ...((await original()) as object),
  relayManagement: request,
  gatewayVersion,
}));
// @ts-expect-error portal JS
import { useRelayManagement } from "./use-relay-management.js";
let host: HTMLElement;
let current: {
  status: unknown;
  error: string;
  busy: string;
  version: string;
  run: (op?: string, input?: unknown, method?: string) => Promise<void>;
};
function Probe() {
  current = useRelayManagement();
  return h("div", null, JSON.stringify(current.status));
}
function pending() {
  let resolve!: (x: unknown) => void, reject!: (x: unknown) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.useFakeTimers();
  const dom = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", dom.document);
  vi.stubGlobal("window", dom.window);
  host = dom.document.querySelector("main") as unknown as HTMLElement;
  request.mockReset();
  gatewayVersion.mockReset();
  gatewayVersion.mockResolvedValue("");
});
afterEach(() => {
  render(null, host);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => render(h(Probe, {}), host));
}
test("polls visible status with single in-flight request and pauses hidden tabs", async () => {
  const first = pending();
  request.mockReturnValueOnce(first.promise).mockResolvedValue({ revision: 2 });
  await mount();
  expect(current.busy).toBe("refresh");
  await act(async () => {
    await current.run();
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => first.resolve({ revision: 1 }));
  expect(current.status).toEqual({ revision: 1 });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(request).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(current.status).toEqual({ revision: 2 });
});
test("mutation invalidates stale poll and blocks a second mutation until it finishes", async () => {
  const old = pending(),
    mutation = pending();
  request.mockReturnValueOnce(old.promise).mockReturnValueOnce(mutation.promise);
  await mount();
  const oldSignal = request.mock.calls[0][2] as AbortSignal;
  let work!: Promise<void>;
  await act(async () => {
    work = current.run("enable", { invitation: "fake" });
    await current.run("disable");
  });
  expect(oldSignal.aborted).toBe(true);
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => old.resolve({ revision: 0 }));
  expect(current.status).toBeNull();
  expect(current.busy).toBe("enable");
  await act(async () => {
    mutation.resolve({ revision: 2 });
    await work;
  });
  expect(current.status).toEqual({ revision: 2 });
  expect(current.busy).toBe("");
});
test("errors are static, timeout aborts, and recovery clears the error", async () => {
  request.mockRejectedValueOnce(new Error("private-secret"));
  await mount();
  expect(current.error).toContain("Couldn't load");
  expect(current.error).not.toContain("private-secret");
  const slow = pending();
  request.mockReturnValueOnce(slow.promise);
  let work!: Promise<void>;
  await act(async () => {
    work = current.run("renew");
  });
  const signal = request.mock.calls[1][2] as AbortSignal;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(signal.aborted).toBe(true);
  await act(async () => {
    slow.resolve({ revision: 3 });
    await work;
  });
  expect(current.status).toBeNull();
  expect(current.error).toContain("Couldn't load");
  request.mockResolvedValue({ revision: 4 });
  await act(async () => current.run());
  expect(current.error).toBe("");
  expect(current.status).toEqual({ revision: 4 });
});
test("unmount aborts and late success or rejection cannot mutate a replacement component", async () => {
  const old = pending();
  request.mockReturnValueOnce(old.promise);
  await mount();
  const signal = request.mock.calls[0][2] as AbortSignal;
  const staleRun = current.run;
  await act(async () => render(null, host));
  expect(signal.aborted).toBe(true);
  await act(async () => staleRun("enable"));
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => old.resolve({ revision: 99 }));
  const failed = pending();
  request.mockReturnValueOnce(failed.promise);
  await mount();
  await act(async () => render(null, host));
  await act(async () => failed.reject(new Error("late")));
  expect(vi.getTimerCount()).toBe(0);
});

test("known backend refusal codes become actionable static guidance", async () => {
  request.mockRejectedValueOnce(
    Object.assign(new Error("never display this"), { code: "ca-terms-required" }),
  );
  await mount();
  expect(current.error).toContain("Accept the configured certificate authority");
});

test("Google linking navigates only after an authorized start and refuses substituted endpoints", async () => {
  const assign = vi.fn();
  Object.defineProperty(window, "location", { configurable: true, value: { assign } });
  request
    .mockResolvedValueOnce({ revision: 1 })
    .mockResolvedValueOnce({
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=fictional",
    })
    .mockResolvedValueOnce({ authorizeUrl: "https://attacker.example.test" });
  await mount();
  await act(async () => current.run("google/link"));
  expect(assign).toHaveBeenCalledExactlyOnceWith(
    "https://accounts.google.com/o/oauth2/v2/auth?state=fictional",
  );
  expect(current.status).toEqual({ revision: 1 });
  await act(async () => current.run("google/link"));
  expect(assign).toHaveBeenCalledOnce();
  expect(current.error).toContain("Couldn't load or update");
});

test("managed owner linking navigates through the installation service with its one-use launch ticket", async () => {
  const assign = vi.fn();
  Object.defineProperty(window, "location", { configurable: true, value: { assign } });
  const relayUrl = "https://relay.example.test";
  const authorizeUrl =
    relayUrl +
    "/_relay/v2/google/browser/begin?operationId=00000000-0000-4000-8000-000000000000&ticket=" +
    "a".repeat(43);
  request
    .mockResolvedValueOnce({ revision: 1, config: { relayUrl } })
    .mockResolvedValueOnce({ authorizeUrl });
  await mount();
  await act(async () => current.run("google/link"));
  expect(assign).toHaveBeenCalledExactlyOnceWith(authorizeUrl);
  expect(current.error).toBe("");
});

test("account linking navigates only to the configured authority's single-use handoff", async () => {
  const assign = vi.fn();
  Object.defineProperty(window, "location", { configurable: true, value: { assign } });
  const origin = "https://relay.example.test",
    destination =
      origin +
      "/_relay/v3/account-browser/begin?operationId=00000000-0000-4000-8000-000000000001&ticket=" +
      "a".repeat(43);
  request
    .mockResolvedValueOnce({ config: { relayUrl: origin } })
    .mockResolvedValueOnce({ authorizeUrl: destination });
  await mount();
  await act(async () => current.run("account/link"));
  expect(assign).toHaveBeenCalledWith(destination);
});

// @ts-expect-error portal JS
import { relayPollInterval } from "./use-relay-management.js";
test("follows a connect in progress closely and otherwise polls slowly", () => {
  for (const state of ["waiting", "registering", "linking"])
    expect(relayPollInterval({ connect: { state } })).toBe(2000);
  for (const status of [null, {}, { connect: { state: "idle" } }, { connect: { state: "failed" } }])
    expect(relayPollInterval(status)).toBe(5000);
});
test("run resolves to the result, passes the method through, and switches polling speed with the connect state", async () => {
  request.mockResolvedValueOnce({ connect: { state: "idle" } });
  await mount();
  request.mockResolvedValueOnce({ connect: { state: "waiting" } });
  let result: unknown;
  await act(async () => {
    result = await current.run("connect", { termsAccepted: true });
  });
  expect(result).toEqual({ connect: { state: "waiting" } });
  expect(request).toHaveBeenLastCalledWith(
    "connect",
    { termsAccepted: true },
    expect.any(AbortSignal),
    "POST",
  );
  request.mockResolvedValue({ connect: { state: "waiting" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(request).toHaveBeenCalledTimes(3);
  request.mockResolvedValueOnce({ deviceEnrollment: { policy: "ask" } });
  await act(async () => {
    result = await current.run("enrollment", { policy: "ask" }, "PUT");
  });
  expect(request).toHaveBeenLastCalledWith(
    "enrollment",
    { policy: "ask" },
    expect.any(AbortSignal),
    "PUT",
  );
  const calls = request.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(request).toHaveBeenCalledTimes(calls);
});
test("a refused operation resolves to undefined and shows a fixed message", async () => {
  request.mockResolvedValueOnce({ revision: 1 });
  await mount();
  request.mockRejectedValueOnce(new Error("private backend detail"));
  let result: unknown = "unset";
  await act(async () => {
    result = await current.run("enrollment", { policy: "ask" }, "PUT");
  });
  expect(result).toBeUndefined();
  expect(current.error).toContain("Couldn't load or update your Omnesis account settings.");
  let blocked: unknown = "unset";
  const slow = pending();
  request.mockReturnValueOnce(slow.promise);
  await act(async () => {
    void current.run("disable");
    blocked = await current.run("enable");
  });
  expect(blocked).toBeUndefined();
  await act(async () => slow.resolve({ revision: 2 }));
});
test("reads the gateway version once, for the details a person copies", async () => {
  gatewayVersion.mockResolvedValue("9.8.7");
  request.mockResolvedValue({ revision: 1 });
  await mount();
  expect(current.version).toBe("9.8.7");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(gatewayVersion).toHaveBeenCalledTimes(1);
});
