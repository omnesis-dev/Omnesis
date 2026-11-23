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
import { Hono } from "hono";
import { SCOPE_ADMIN } from "@omnesis/types";
import { mountCloudRelayManagementRoutes } from "../../../src/http/routes/admin/cloud-relay.js";
import { strictRoute } from "../../../src/http/scope.js";
import type { AppEnv } from "../../../src/http/routes/types.js";
import type { CloudRelayManagement, CloudRelayManagementStatus } from "@omnesis/cloud-relay";
// @ts-expect-error portal JS
import { useRelayManagement } from "./use-relay-management.js";
let host: HTMLElement;
let current: {
  status: unknown;
  error: string;
  errorCode: string;
  clearError: () => void;
  busy: string;
  version: string;
  run: (op?: string, input?: unknown) => Promise<void>;
  adopt: (status: unknown) => void;
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
  // The pages this hook serves show how to sign up, so their status read asks for it.
  expect(request.mock.calls[0]).toEqual(["", {}, expect.any(AbortSignal), "POST", { signup: true }]);
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
test("follows a connect under way even while the tab is hidden, and pauses again once it ends", async () => {
  request.mockResolvedValueOnce({ connect: { state: "waiting" } });
  await mount();
  await act(async () => {});
  expect(current.status).toEqual({ connect: { state: "waiting" } });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  request.mockResolvedValueOnce({ connect: { state: "done" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2500);
  });
  expect(request).toHaveBeenCalledTimes(2);
  expect(current.status).toEqual({ connect: { state: "done" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(request).toHaveBeenCalledTimes(2);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
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
  expect(request.mock.calls[1]).toEqual(["enable", { invitation: "fake" }, expect.any(AbortSignal), "POST"]);
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
test("a step-up failure is said in its own words, and any other failure in the page's", async () => {
  request.mockResolvedValueOnce({ revision: 1 });
  await mount();
  request.mockRejectedValueOnce(
    Object.assign(new Error("Security lock is on. This change can only be made on the computer running Omnesis right now."), {
      stepUp: true,
    }),
  );
  await act(async () => current.run("enable", {}));
  expect(current.error).toBe(
    "Security lock is on. This change can only be made on the computer running Omnesis right now.",
  );
  request.mockRejectedValueOnce(Object.assign(new Error("private detail"), { stepUp: false }));
  await act(async () => current.run("enable", {}));
  expect(current.error).toContain("Couldn't load or update");
});
test("after another relay action, the page still says the passkey comes next", async () => {
  // The gateway's own routes answer, for a session whose loosening actions ask for a passkey.
  const status = { revision: 1, enabled: true } as unknown as CloudRelayManagementStatus;
  const service = {
    status: vi.fn(async () => status),
    reconnect: vi.fn(async () => ({ ...status, revision: 2 })),
  } as unknown as CloudRelayManagement;
  const router = strictRoute(new Hono<AppEnv>());
  router.use("*", async (c, next) => {
    c.set("auth", { authMethod: "bearer", deviceId: null, tokenId: null, scopes: [SCOPE_ADMIN] });
    c.set("stepUps", { required: () => true } as unknown as AppEnv["Variables"]["stepUps"]);
    await next();
  });
  mountCloudRelayManagementRoutes(router, service);
  request.mockImplementation(async (operation: string, input: unknown) => {
    const response = await router.request(
      `/admin/cloud-relay${operation ? `/${operation}` : ""}`,
      operation
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          }
        : {},
    );
    return response.json();
  });
  await mount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(current.status).toEqual({ revision: 1, enabled: true, stepUpRequired: true });
  await act(async () => current.run("reconnect", {}));
  expect(service.reconnect).toHaveBeenCalledOnce();
  // The action's answer replaced the status, and the next read is five seconds away.
  expect(current.status).toEqual({ revision: 2, enabled: true, stepUpRequired: true });
  expect(request).toHaveBeenCalledTimes(2);
});
test("a status another route answered with replaces the status, and a read that started before it can't undo it", async () => {
  request.mockResolvedValueOnce({ revision: 1 });
  await mount();
  const stale = pending();
  request.mockReturnValueOnce(stale.promise);
  let read!: Promise<void>;
  await act(async () => {
    read = current.run();
  });
  await act(async () => current.adopt({ revision: 2 }));
  expect(current.status).toEqual({ revision: 2 });
  await act(async () => {
    stale.resolve({ revision: 1 });
    await read;
  });
  expect(current.status).toEqual({ revision: 2 });
  // The next read is current again.
  request.mockResolvedValueOnce({ revision: 3 });
  await act(async () => current.run());
  expect(current.status).toEqual({ revision: 3 });
  // An answer that arrives once the page is gone changes nothing.
  const late = current.adopt;
  await act(async () => render(null, host));
  expect(() => late({ revision: 4 })).not.toThrow();
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
test("run resolves to the result, posts the operation, and switches polling speed with the connect state", async () => {
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
  request.mockResolvedValueOnce({ enabled: false });
  await act(async () => {
    result = await current.run("disable", {});
  });
  expect(request).toHaveBeenLastCalledWith("disable", {}, expect.any(AbortSignal), "POST");
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
    result = await current.run("enable", {});
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

// @ts-expect-error portal JS
import { useAccountRefresh } from "./use-relay-management.js";
test("asks the gateway to read the account on opening and on coming back into view, then rereads the status", async () => {
  const refreshed = vi.fn();
  function Refresher() {
    useAccountRefresh(refreshed);
    return null;
  }
  const shown = async (value: "visible" | "hidden", event = "visibilitychange") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value });
    await act(async () => {
      (event === "focus" ? window : document).dispatchEvent(
        new (globalThis.window as unknown as { Event: typeof Event }).Event(event),
      );
    });
  };
  request.mockResolvedValue({ revision: 1 });
  await act(async () => render(h(Refresher, {}), host));
  expect(request).toHaveBeenCalledExactlyOnceWith("account/refresh", {}, expect.any(AbortSignal));
  expect(refreshed).toHaveBeenCalledOnce();
  // Leaving the tab for the account page asks nothing.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  await shown("hidden");
  expect(request).toHaveBeenCalledOnce();
  // Coming back fires both events; one refresh follows, then the status is read again.
  await shown("visible");
  await shown("visible", "focus");
  expect(request).toHaveBeenCalledTimes(2);
  expect(refreshed).toHaveBeenCalledTimes(2);
  // A refusal (say, a gateway without the account feature) is quiet and reads nothing more.
  request.mockRejectedValueOnce(new Error("private detail"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  await shown("visible", "focus");
  expect(request).toHaveBeenCalledTimes(3);
  expect(refreshed).toHaveBeenCalledTimes(2);
  // A slow gateway is given up on, and the page never waits on it.
  const slow = pending();
  request.mockReturnValueOnce(slow.promise);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  await shown("visible", "focus");
  const signal = request.mock.calls[3][2] as AbortSignal;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(signal.aborted).toBe(true);
  // Leaving the page stops listening and a late answer calls nothing.
  const late = pending();
  request.mockReturnValueOnce(late.promise);
  await shown("visible", "focus");
  await act(async () => render(null, host));
  await act(async () => late.resolve({ revision: 2 }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  await shown("visible", "focus");
  await shown("visible");
  expect(request).toHaveBeenCalledTimes(5);
  expect(refreshed).toHaveBeenCalledTimes(2);
});

test("what an operation was refused for outlasts the page's status reads until it is cleared or another operation runs", async () => {
  request.mockResolvedValue({ revision: 1 });
  await mount();
  const refused = Object.assign(new Error("refused"), { code: "invite-used" });
  request.mockRejectedValueOnce(refused);
  await act(async () => {
    await current.run("connect", { intent: "create" });
  });
  expect(current.errorCode).toBe("invite-used");
  expect(current.error).toBe("That invite was already used to create an account. Ask for a new one.");
  // The page reads its status every few seconds; none of those reads takes the refusal away.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(request.mock.calls.filter(([operation]) => operation === "").length).toBeGreaterThan(2);
  expect(current.errorCode).toBe("invite-used");
  // Nor does a status read that failed.
  request.mockRejectedValueOnce(new Error("offline"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(current.errorCode).toBe("invite-used");
  await act(async () => current.clearError());
  expect(current.error).toBe("");
  // A failed status read is said only until a read succeeds.
  request.mockRejectedValueOnce(new Error("offline"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(current.error).toContain("Couldn't load or update");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(current.error).toBe("");
  // The next operation starts without the last one's refusal.
  request.mockRejectedValueOnce(refused);
  await act(async () => {
    await current.run("connect", { intent: "create" });
  });
  expect(current.errorCode).toBe("invite-used");
  await act(async () => {
    await current.run("connect/cancel", {});
  });
  expect(current.error).toBe("");
});
