// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  DEFAULT_WEB_CAPTURE_RULES,
  type WebCapturePolicy,
} from "@omnesis/provider-web/capture-policy";
import { QUEUE_STORAGE_KEY } from "../push/queue.js";
import { jsonResponse } from "../push/test-fakes.js";
import { CAPTURE_POLICY_KEY, CAPTURE_POLICY_TTL_MS } from "../capture/policy.js";
import { hashText } from "../capture/content-hash.js";
import { CAPTURE_HANDOFF_FAILURE_KEY, CAPTURE_PENDING_PREFIX } from "./messages.js";
import {
  PERIODIC_DRAIN_ALARM,
  PERMISSION_RECONCILE_ALARM,
  RETRY_DRAIN_ALARM,
} from "./alarm-names.js";
import { capturePairingId } from "./handoff-storage.js";
import { PAIRING_ATTEMPT_KEY } from "./pairing-attempt.js";
import { PAIRING_KEY, PROFILE_LABEL_KEY } from "./storage.js";
import type { CaptureEmission } from "../capture/lifecycle.js";

type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean | void | Promise<unknown>;

interface BackgroundHarness {
  storage: Record<string, unknown>;
  listener: MessageListener;
  alarmListener: (alarm: { name: string; scheduledTime: number }) => void;
  createAlarm: ReturnType<typeof vi.fn>;
  failNextQueueWrite: () => void;
  failNextStorageWrite: (key: string) => void;
  failNextPermissionRead: () => void;
  setHostPermission: (granted: boolean, origins?: string[]) => void;
  blockPermissionRemoval: () => void;
}

function sendMessage(
  listener: MessageListener,
  message: unknown,
  sender: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const keepAlive = listener(message, sender, resolve);
    if (keepAlive !== true) reject(new Error("message was not accepted by the background"));
  });
}

let handoffSequence = 0;
const TEST_CONTENT_HASH = "a".repeat(64);

/** A gateway capture policy with nothing excluded, as `GET /web-capture-policy` returns it. */
function policyBody(overrides: Partial<WebCapturePolicy> = {}): WebCapturePolicy {
  return {
    updatedAt: "",
    pause: null,
    excludedDomains: [],
    ownedDomains: [],
    rules: DEFAULT_WEB_CAPTURE_RULES,
    removedPages: [],
    removedPagesTruncated: false,
    ...overrides,
  };
}

/** The browser's durable copy of a policy, fresh as of now. */
function cachedPolicy(policy: WebCapturePolicy = policyBody(), fetchedAt = Date.now()): string {
  return JSON.stringify({ policy, fetchedAt });
}

const popupSender = { id: "extension-test", url: "chrome-extension://extension-test/popup.html" };
const optionsSender = {
  id: "extension-test",
  url: "chrome-extension://extension-test/options.html",
};

/** A fetch double that answers the policy routes and hands everything else to `rest`. */
function policyAwareFetch(
  policy: () => WebCapturePolicy,
  rest: (
    input: string,
    init: { method?: string; body?: string },
  ) => ReturnType<typeof jsonResponse>,
  onEdit?: (input: string, init: { method?: string; body?: string }) => WebCapturePolicy,
): typeof fetch {
  return vi.fn(async (input: string, init: { method?: string; body?: string } = {}) => {
    if (input.includes("/web-capture-policy")) {
      if (init.method === "GET") return jsonResponse(200, policy());
      const next = onEdit ? onEdit(input, init) : policy();
      return init.method === "POST" && input.endsWith("/excluded-domains")
        ? jsonResponse(200, { policy: next, purged: 0 })
        : jsonResponse(200, next);
    }
    return rest(input, init);
  }) as unknown as typeof fetch;
}
async function boundCapture(
  emission: CaptureEmission,
  gatewayUrl = "https://gateway.example.com",
  deviceId = "0d0e0f10-1111-4222-8333-444455556666",
): Promise<unknown> {
  handoffSequence += 1;
  return {
    type: "capture",
    emission,
    handoffKey: `${CAPTURE_PENDING_PREFIX}test.${handoffSequence}`,
    pairingId: await capturePairingId({ gatewayUrl, deviceId }),
  };
}

async function startBackground(
  fetchImpl: typeof fetch,
  initialStorage: Record<string, unknown> = {},
): Promise<BackgroundHarness> {
  vi.resetModules();
  const storage: Record<string, unknown> = {
    "omnesis.pairing.v1": JSON.stringify({
      gatewayUrl: "https://gateway.example.com",
      scopes: ["write:web"],
      deviceId: "0d0e0f10-1111-4222-8333-444455556666",
      pairedAt: 1,
    }),
    "omnesis.token.v1": "token",
    "omnesis.push.checked.v1": JSON.stringify({ at: Date.now() }),
    // The worker captures nothing without a copy of the gateway's capture
    // settings; most cases start with a fresh, empty one.
    [CAPTURE_POLICY_KEY]: cachedPolicy(),
    [PROFILE_LABEL_KEY]: "Personal",
    [QUEUE_STORAGE_KEY]: "[]",
    ...initialStorage,
  };
  let listener: MessageListener | undefined;
  let alarmListener: ((alarm: { name: string; scheduledTime: number }) => void) | undefined;
  let permissionAddedListener: ((permissions: { origins?: string[] }) => void) | undefined;
  let permissionRemovedListener: ((permissions: { origins?: string[] }) => void) | undefined;
  let hostPermissionGranted = true;
  let permissionRemovalBlocked = false;
  let permissionReadFails = false;
  let captureScriptRegistered = false;
  const setBadgeText = vi.fn(async () => undefined);
  const createAlarm = vi.fn();
  let failNextQueueWrite = false;
  let failNextStorageKey: string | null = null;
  vi.stubGlobal("fetch", fetchImpl);
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (key: string | string[] | null) => {
          if (key === null) return { ...storage };
          const keys = Array.isArray(key) ? key : [key];
          return Object.fromEntries(
            keys
              .filter((candidate) => candidate in storage)
              .map((candidate) => [candidate, storage[candidate]]),
          );
        },
        getKeys: async () => Object.keys(storage),
        set: async (items: Record<string, unknown>) => {
          if (failNextStorageKey && failNextStorageKey in items) {
            failNextStorageKey = null;
            throw new Error("fictional storage write failure");
          }
          if (failNextQueueWrite && QUEUE_STORAGE_KEY in items) {
            failNextQueueWrite = false;
            throw new Error("fictional storage write failure");
          }
          Object.assign(storage, items);
        },
        remove: async (key: string | string[]) => {
          for (const candidate of Array.isArray(key) ? key : [key]) delete storage[candidate];
        },
      },
    },
    runtime: {
      id: "extension-test",
      getURL: (path: string) => `chrome-extension://extension-test/${path}`,
      // The extension's product version, which pairing sends to the gateway's
      // version ledger. The real value comes from the built manifest.
      getManifest: () => ({ version: "9.8.7" }),
      onMessage: {
        addListener: (candidate: MessageListener) => {
          listener = candidate;
        },
      },
    },
    alarms: {
      create: createAlarm,
      clear: vi.fn(async () => true),
      onAlarm: {
        addListener: (candidate: (alarm: { name: string; scheduledTime: number }) => void) => {
          alarmListener = candidate;
        },
      },
    },
    action: {
      setBadgeText,
      setBadgeBackgroundColor: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined),
    },
    permissions: {
      contains: vi.fn(async () => hostPermissionGranted),
      getAll: vi.fn(async () => {
        if (permissionReadFails) {
          permissionReadFails = false;
          throw new Error("fictional permission API failure");
        }
        return {
          origins: hostPermissionGranted ? ["https://*/*"] : [],
          permissions: ["alarms", "storage"],
        };
      }),
      request: vi.fn(async () => {
        hostPermissionGranted = true;
        return true;
      }),
      remove: vi.fn(async () => {
        if (permissionRemovalBlocked) return false;
        const removed = hostPermissionGranted;
        hostPermissionGranted = false;
        return removed;
      }),
      onAdded: {
        addListener: (candidate: (permissions: { origins?: string[] }) => void) => {
          permissionAddedListener = candidate;
        },
      },
      onRemoved: {
        addListener: (candidate: (permissions: { origins?: string[] }) => void) => {
          permissionRemovedListener = candidate;
        },
      },
    },
    scripting: {
      getRegisteredContentScripts: vi.fn(() =>
        Promise.resolve(
          captureScriptRegistered
            ? [
                {
                  id: "omnesis-web-capture-v1",
                  matches: ["https://*/*"],
                  js: ["content.js"],
                  runAt: "document_idle",
                  persistAcrossSessions: true,
                },
              ]
            : [],
        ),
      ),
      registerContentScripts: vi.fn(() => {
        captureScriptRegistered = true;
        return Promise.resolve();
      }),
      updateContentScripts: vi.fn(() => Promise.resolve()),
      unregisterContentScripts: vi.fn(() => {
        captureScriptRegistered = false;
        return Promise.resolve();
      }),
    },
  });
  await import("./background.js");
  if (!listener) throw new Error("background did not register its message listener");
  if (!alarmListener) throw new Error("background did not register its alarm listener");
  // Let the startup empty-queue pass leave the serialized lane.
  await vi.waitFor(() => expect(setBadgeText).toHaveBeenCalled());
  return {
    storage,
    listener,
    alarmListener,
    createAlarm,
    failNextQueueWrite: () => {
      failNextQueueWrite = true;
    },
    failNextStorageWrite: (key) => {
      failNextStorageKey = key;
    },
    failNextPermissionRead: () => {
      permissionReadFails = true;
    },
    setHostPermission: (granted, origins = ["https://*/*"]) => {
      hostPermissionGranted = granted;
      const change = { origins };
      if (granted) permissionAddedListener?.(change);
      else permissionRemovedListener?.(change);
    },
    blockPermissionRemoval: () => {
      permissionRemovalBlocked = true;
    },
  };
}

afterEach(async () => {
  // Background listeners intentionally start fire-and-forget work. Let each
  // bounded event settle before removing the mocked Chrome globals.
  await new Promise((resolve) => setTimeout(resolve, 50));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MV3 background handoff", () => {
  it("wires a distinct periodic alarm to the real drain listener", async () => {
    const { alarmListener, createAlarm } = await startBackground(
      vi.fn(async () => jsonResponse(200, { ingested: 0, deleted: 0 })) as unknown as typeof fetch,
    );
    expect(createAlarm).toHaveBeenCalledWith(PERIODIC_DRAIN_ALARM, { periodInMinutes: 1 });
    expect(() =>
      alarmListener({ name: PERIODIC_DRAIN_ALARM, scheduledTime: Date.now() }),
    ).not.toThrow();
  });

  it("acknowledges only after durable enqueue and before network completion", async () => {
    let resolveFetch: ((value: ReturnType<typeof jsonResponse>) => void) | undefined;
    const fetchImpl = vi.fn(
      () =>
        new Promise<ReturnType<typeof jsonResponse>>((resolve) => {
          resolveFetch = resolve;
        }),
    ) as unknown as typeof fetch;
    const { listener, storage } = await startBackground(fetchImpl);
    const emission: CaptureEmission = {
      kind: "re-extract",
      normalizedUrl: "https://example.com/article",
      title: "Example article",
      text: "Fictional article body",
      contentHash: TEST_CONTENT_HASH,
      visitedAt: "2026-01-01T00:00:00.000Z",
      dwellMs: 5_000,
      contentChanged: true,
    };
    let queuedAtAck = 0;
    const sendResponse = vi.fn(() => {
      queuedAtAck = JSON.parse(String(storage[QUEUE_STORAGE_KEY])).length as number;
    });

    expect(
      listener(
        await boundCapture(emission),
        { id: "extension-test", tab: { id: 7, url: "https://example.com/article" } },
        sendResponse,
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true, accepted: true }));
    expect(queuedAtAck).toBe(1);
    expect(fetchImpl).toHaveBeenCalledOnce();

    resolveFetch?.(jsonResponse(200, { ingested: 0, deleted: 0 }));
    await vi.waitFor(() =>
      expect(JSON.parse(String(storage[QUEUE_STORAGE_KEY])) as unknown[]).toHaveLength(0),
    );
  });

  it("serializes concurrent capture messages without losing either append", async () => {
    const { listener, storage } = await startBackground(
      vi.fn(async () =>
        jsonResponse(503, { error: "temporarily unavailable" }),
      ) as unknown as typeof fetch,
    );
    const makeEmission = (suffix: string): CaptureEmission => ({
      kind: "re-extract",
      normalizedUrl: `https://example.com/${suffix}`,
      title: `Example ${suffix}`,
      text: `Fictional ${suffix} body`,
      contentHash: TEST_CONTENT_HASH,
      visitedAt: "2026-01-01T00:00:00.000Z",
      dwellMs: 5_000,
      contentChanged: true,
    });
    await Promise.all(
      ["one", "two"].map(async (suffix) =>
        sendMessage(listener, await boundCapture(makeEmission(suffix)), {
          id: "extension-test",
          tab: { id: 7, url: `https://example.com/${suffix}` },
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(JSON.parse(String(storage[QUEUE_STORAGE_KEY])) as unknown[]).toHaveLength(2),
    );
  });

  it("attributes captured documents and visits to the paired Chrome profile", async () => {
    const requests: Array<{ input: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn((input: string, init?: { body?: string }) => {
      requests.push({
        input,
        body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      });
      return Promise.resolve(jsonResponse(200, { ingested: 1, deleted: 0 }));
    }) as unknown as typeof fetch;
    const { listener } = await startBackground(fetchImpl, { [PROFILE_LABEL_KEY]: "Personal" });
    const emission: CaptureEmission = {
      kind: "visit",
      normalizedUrl: "https://example.com/profile-attribution",
      title: "Profile attribution",
      text: "Fictional profile attribution body",
      contentHash: TEST_CONTENT_HASH,
      visitedAt: "2026-01-01T00:00:00.000Z",
      dwellMs: 5_000,
      contentChanged: true,
    };

    await sendMessage(listener, await boundCapture(emission), {
      id: "extension-test",
      tab: { id: 7, url: emission.normalizedUrl },
    });
    await vi.waitFor(() =>
      expect(requests.some((request) => request.input.endsWith("/analytics/ingest"))).toBe(true),
    );

    const documentRequest = requests.find(
      (request) =>
        request.input.endsWith("/documents") &&
        Array.isArray(request.body.documents) &&
        request.body.documents.length > 0,
    );
    const document = (documentRequest!.body.documents as Array<Record<string, unknown>>)[0]!;
    expect(document.metadata).toMatchObject({
      extra: {
        browserDeviceId: "0d0e0f10-1111-4222-8333-444455556666",
        browserProfileLabel: "Personal",
      },
    });

    const visitRequest = requests.find((request) => request.input.endsWith("/analytics/ingest"));
    const visit = (visitRequest!.body.records as Array<Record<string, unknown>>)[0]!;
    expect(visit).toMatchObject({
      browser_device_id: "0d0e0f10-1111-4222-8333-444455556666",
      browser_profile_label: "Personal",
    });
  });

  it("chains bounded in-process drains for an already-ready healthy backlog", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ingested: 0, deleted: 0 }),
    ) as unknown as typeof fetch;
    const { listener, storage, createAlarm } = await startBackground(fetchImpl);
    const emissions = ["one", "two", "three"].map(
      (suffix): CaptureEmission => ({
        kind: "re-extract",
        normalizedUrl: `https://example.com/${suffix}`,
        title: `Example ${suffix}`,
        text: `Fictional ${suffix} body`,
        contentHash: TEST_CONTENT_HASH,
        visitedAt: "2026-01-01T00:00:00.000Z",
        dwellMs: 5_000,
        contentChanged: true,
      }),
    );
    await Promise.all(
      emissions.map(async (emission) =>
        sendMessage(listener, await boundCapture(emission), {
          id: "extension-test",
          tab: { id: 7, url: emission.normalizedUrl },
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(JSON.parse(String(storage[QUEUE_STORAGE_KEY])) as unknown[]).toHaveLength(0),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(createAlarm).not.toHaveBeenCalledWith(
      RETRY_DRAIN_ALARM,
      expect.objectContaining({ when: expect.any(Number) }),
    );
  });

  it("schedules and dispatches a future retry alarm", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      return attempts === 1
        ? jsonResponse(503, { error: "temporarily unavailable" })
        : jsonResponse(200, { ingested: 0, deleted: 0 });
    }) as unknown as typeof fetch;
    const { listener, alarmListener, storage, createAlarm } = await startBackground(fetchImpl);
    const emission: CaptureEmission = {
      kind: "re-extract",
      normalizedUrl: "https://example.com/retry",
      title: "Retry example",
      text: "Fictional retry body",
      contentHash: TEST_CONTENT_HASH,
      visitedAt: "2026-01-01T00:00:00.000Z",
      dwellMs: 5_000,
      contentChanged: true,
    };
    await sendMessage(listener, await boundCapture(emission), {
      id: "extension-test",
      tab: { id: 7, url: emission.normalizedUrl },
    });
    await vi.waitFor(() =>
      expect(createAlarm).toHaveBeenCalledWith(RETRY_DRAIN_ALARM, { when: 11_000 }),
    );
    now = 11_000;
    alarmListener({ name: RETRY_DRAIN_ALARM, scheduledTime: now });
    await vi.waitFor(() =>
      expect(JSON.parse(String(storage[QUEUE_STORAGE_KEY])) as unknown[]).toHaveLength(0),
    );
    expect(attempts).toBe(2);
  });

  it("refuses a new pairing until the user supplies a profile name", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, {})) as unknown as typeof fetch;
    const { listener } = await startBackground(fetchImpl, { [PROFILE_LABEL_KEY]: undefined });

    await expect(
      sendMessage(
        listener,
        {
          type: "pair-browser",
          gatewayUrl: "https://new-gateway.example.com",
          pairingCode: "code",
        },
        { id: "extension-test", url: "chrome-extension://extension-test/options.html" },
      ),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/profile's name/) });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a re-pair carries this install's identity and the device id it held before", async () => {
    const pairBodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (input: string, init?: { body?: string }) => {
      if (input.endsWith("/devices/pair")) {
        pairBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse(200, {
          device: { id: "device-new", name: "Browser extension test", kind: "browser" },
          token: "new-token",
          scopes: ["write:web"],
        });
      }
      return jsonResponse(200, { ingested: 0, deleted: 0 });
    }) as unknown as typeof fetch;
    const { listener, storage } = await startBackground(fetchImpl);
    await expect(
      sendMessage(
        listener,
        {
          type: "pair-browser",
          gatewayUrl: "https://new-gateway.example.com",
          pairingCode: "code",
          profileLabel: "Personal",
        },
        { id: "extension-test", url: "chrome-extension://extension-test/options.html" },
      ),
    ).resolves.toEqual({ ok: true });
    const caps = (pairBodies[0] as { capabilities: Record<string, string> }).capabilities;
    expect(caps.previousDeviceId).toBe("0d0e0f10-1111-4222-8333-444455556666");
    expect(caps.installId).toMatch(/^[0-9a-f-]{36}$/);
    expect(storage[PROFILE_LABEL_KEY]).toBe("Personal");
  });

  it("pairs with a crash-recovery key and forgets it once the outcome is known", async () => {
    const pairBodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (input: string, init?: { body?: string }) => {
      if (input.endsWith("/health")) return jsonResponse(200, { status: "ok", version: "9.8.7" });
      if (input.endsWith("/devices/pair")) {
        pairBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return pairBodies.length === 1
          ? jsonResponse(400, { error: "invalid or expired pairing code" })
          : jsonResponse(200, {
              device: { id: "device-new", name: "Browser extension test", kind: "browser" },
              token: "new-token",
              scopes: ["write:web"],
            });
      }
      return jsonResponse(200, { ingested: 0, deleted: 0 });
    }) as unknown as typeof fetch;
    const { listener, storage } = await startBackground(fetchImpl);
    const sender = { id: "extension-test", url: "chrome-extension://extension-test/options.html" };
    const pairMessage = {
      type: "pair-browser",
      gatewayUrl: "https://new-gateway.example.com",
      pairingCode: "code",
      profileLabel: "Personal",
    };

    // A definitive refusal ends the attempt: the next submit is a fresh one.
    await expect(sendMessage(listener, pairMessage, sender)).resolves.toMatchObject({ ok: false });
    expect(storage["omnesis.pairing.attempt.v1"]).toBeUndefined();
    await expect(sendMessage(listener, pairMessage, sender)).resolves.toEqual({ ok: true });

    const keys = pairBodies.map((body) => body.idempotencyKey as string);
    expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(keys[1]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(keys[1]).not.toBe(keys[0]);
    expect(storage["omnesis.pairing.attempt.v1"]).toBeUndefined();
    // The gateway's version rides along with the pairing, token kept apart.
    expect(JSON.parse(String(storage["omnesis.pairing.v1"]))).toMatchObject({
      gatewayVersion: "9.8.7",
    });
  });

  it("keeps the crash-recovery key when the gateway never answered, and reuses it", async () => {
    const pairBodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (input: string, init?: { body?: string }) => {
      if (input.endsWith("/health")) return jsonResponse(200, { status: "ok", version: "9.8.7" });
      if (input.endsWith("/devices/pair")) {
        pairBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        // The first request leaves the client with no HTTP response at all.
        if (pairBodies.length === 1) throw new TypeError("fictional connection reset");
        return jsonResponse(200, {
          device: { id: "device-new", name: "Browser extension test", kind: "browser" },
          token: "new-token",
          scopes: ["write:web"],
        });
      }
      return jsonResponse(200, { ingested: 0, deleted: 0 });
    }) as unknown as typeof fetch;
    const { listener, storage } = await startBackground(fetchImpl);
    const sender = { id: "extension-test", url: "chrome-extension://extension-test/options.html" };
    const pairMessage = {
      type: "pair-browser",
      gatewayUrl: "https://new-gateway.example.com",
      pairingCode: "code",
      profileLabel: "Personal",
    };

    await expect(sendMessage(listener, pairMessage, sender)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/submit the same code again/),
    });
    expect(storage["omnesis.pairing.attempt.v1"]).toBeDefined();
    await expect(sendMessage(listener, pairMessage, sender)).resolves.toEqual({ ok: true });

    const keys = pairBodies.map((body) => body.idempotencyKey as string);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(storage["omnesis.pairing.attempt.v1"]).toBeUndefined();
  });

  it("splits a legacy combined pairing record on start and keeps capturing", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ingested: 1 }),
    ) as unknown as typeof fetch;
    const { listener, storage } = await startBackground(fetchImpl, {
      "omnesis.pairing.v1": undefined,
      "omnesis.token.v1": undefined,
      "omnesis.config.v1": JSON.stringify({
        gatewayUrl: "https://gateway.example.com",
        token: "legacy-token",
        scopes: ["write:web"],
        deviceId: "0d0e0f10-1111-4222-8333-444455556666",
        pairedAt: 1,
      }),
    });
    await vi.waitFor(() => expect(storage["omnesis.config.v1"]).toBeUndefined());
    expect(storage["omnesis.token.v1"]).toBe("legacy-token");
    expect(JSON.parse(String(storage["omnesis.pairing.v1"]))).toEqual({
      gatewayUrl: "https://gateway.example.com",
      scopes: ["write:web"],
      deviceId: "0d0e0f10-1111-4222-8333-444455556666",
      pairedAt: 1,
    });

    const emission: CaptureEmission = {
      kind: "visit",
      normalizedUrl: "https://example.com/after-migration",
      title: "After migration",
      text: "Fictional article body",
      contentHash: TEST_CONTENT_HASH,
      visitedAt: "2026-01-01T00:00:00.000Z",
      dwellMs: 5_000,
      contentChanged: true,
    };
    await expect(
      sendMessage(listener, await boundCapture(emission), {
        id: "extension-test",
        tab: { id: 7, url: emission.normalizedUrl },
      }),
    ).resolves.toEqual({ ok: true, accepted: true });
  });

  it("check-now records a gateway version that moved since pairing", async () => {
    let version = "1.0.0";
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.endsWith("/health")) return jsonResponse(200, { status: "ok", version });
      return jsonResponse(200, { ingested: 0, deleted: 0 });
    }) as unknown as typeof fetch;
    const { listener, storage } = await startBackground(fetchImpl);
    const checkNow = () =>
      sendMessage(
        listener,
        { type: "check-now" },
        { id: "extension-test", url: "chrome-extension://extension-test/popup.html" },
      );

    await checkNow();
    expect(JSON.parse(String(storage["omnesis.pairing.v1"]))).toMatchObject({
      gatewayVersion: "1.0.0",
    });
    version = "1.1.0";
    await checkNow();
    expect(JSON.parse(String(storage["omnesis.pairing.v1"]))).toMatchObject({
      gatewayVersion: "1.1.0",
      deviceId: "0d0e0f10-1111-4222-8333-444455556666",
    });
  });

  it("adds a profile label to an existing pairing without replacing its token", async () => {
    const { listener, storage } = await startBackground(vi.fn() as unknown as typeof fetch);
    const before = storage[PAIRING_KEY];

    await expect(
      sendMessage(
        listener,
        { type: "set-profile-label", profileLabel: "Work" },
        { id: "extension-test", url: "chrome-extension://extension-test/options.html" },
      ),
    ).resolves.toEqual({ ok: true });

    expect(storage[PROFILE_LABEL_KEY]).toBe("Work");
    expect(storage[PAIRING_KEY]).toBe(before);
  });

  it("clears the old identity before committing a new pairing", async () => {
    const fetchImpl = vi.fn(async (input: string) =>
      input.endsWith("/devices/pair")
        ? jsonResponse(200, {
            device: { id: "device-new", name: "Browser extension test", kind: "browser" },
            token: "new-token",
            scopes: ["write:web"],
          })
        : jsonResponse(200, { ingested: 0, deleted: 0 }),
    ) as unknown as typeof fetch;
    const { listener, storage } = await startBackground(fetchImpl);
    storage[QUEUE_STORAGE_KEY] = JSON.stringify([
      {
        kind: "visit",
        id: "visit:old",
        visit: {
          url: "https://example.com/old",
          domain: "example.com",
          title: null,
          visited_at: "2026-01-01T00:00:00.000Z",
          dwell_ms: 5_000,
        },
        attempts: 1,
        notBefore: Date.now() + 60_000,
        enqueuedAt: 1,
      },
    ]);
    const sendResponse = vi.fn();
    expect(
      listener(
        {
          type: "pair-browser",
          gatewayUrl: "https://new-gateway.example.com",
          pairingCode: "new-pairing-code",
        },
        { id: "extension-test", url: "chrome-extension://extension-test/options.html" },
        sendResponse,
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
    expect(JSON.parse(String(storage[QUEUE_STORAGE_KEY]))).toEqual([]);
    expect(JSON.parse(String(storage["omnesis.pairing.v1"]))).toMatchObject({
      gatewayUrl: "https://new-gateway.example.com",
      deviceId: "device-new",
    });
  });

  it("stays unpaired when old-identity queue cleanup fails mid-transition", async () => {
    const fetchImpl = vi.fn(async (input: string) =>
      input.endsWith("/devices/pair")
        ? jsonResponse(200, {
            device: { id: "device-new", name: "Browser extension test", kind: "browser" },
            token: "fresh-token",
            scopes: ["write:web"],
          })
        : jsonResponse(200, { ingested: 0, deleted: 0 }),
    ) as unknown as typeof fetch;
    const { listener, storage, failNextQueueWrite } = await startBackground(fetchImpl);
    storage[QUEUE_STORAGE_KEY] = JSON.stringify([{ fictional: "old identity page" }]);
    failNextQueueWrite();

    await expect(
      sendMessage(
        listener,
        {
          type: "pair-browser",
          gatewayUrl: "https://new-gateway.example.com",
          pairingCode: "fresh-code",
        },
        { id: "extension-test", url: "chrome-extension://extension-test/options.html" },
      ),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/storage write failure/) });

    expect(storage["omnesis.pairing.v1"]).toBeUndefined();
    expect(storage["omnesis.token.v1"]).toBeUndefined();
    expect(JSON.parse(String(storage[QUEUE_STORAGE_KEY]))).toEqual([
      { fictional: "old identity page" },
    ]);
  });

  it("fails safely unpaired when the final new-identity config commit fails", async () => {
    const fetchImpl = vi.fn(async (input: string) =>
      input.endsWith("/devices/pair")
        ? jsonResponse(200, {
            device: { id: "device-new", name: "Browser extension test", kind: "browser" },
            token: "fresh-token",
            scopes: ["write:web"],
          })
        : jsonResponse(200, { ingested: 0, deleted: 0 }),
    ) as unknown as typeof fetch;
    const { listener, storage, failNextStorageWrite } = await startBackground(fetchImpl);
    storage[QUEUE_STORAGE_KEY] = JSON.stringify([{ fictional: "old identity page" }]);
    failNextStorageWrite("omnesis.pairing.v1");

    await expect(
      sendMessage(
        listener,
        {
          type: "pair-browser",
          gatewayUrl: "https://new-gateway.example.com",
          pairingCode: "fresh-code",
        },
        { id: "extension-test", url: "chrome-extension://extension-test/options.html" },
      ),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/storage write failure/) });

    expect(storage["omnesis.pairing.v1"]).toBeUndefined();
    expect(storage["omnesis.token.v1"]).toBeUndefined();
    expect(JSON.parse(String(storage[QUEUE_STORAGE_KEY]))).toEqual([]);
  });

  it("serializes pair-code redemption with config commit across options tabs", async () => {
    let pairRequests = 0;
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.endsWith("/devices/pair")) {
        pairRequests += 1;
        const ordinal = pairRequests;
        if (ordinal === 1) await firstGate;
        return jsonResponse(200, {
          device: {
            id: "0d0e0f10-1111-4222-8333-444455556666",
            name: "Browser extension test",
            kind: "browser",
          },
          token: `token-${ordinal}`,
          scopes: ["write:web"],
        });
      }
      return jsonResponse(200, { ingested: 0, deleted: 0 });
    }) as unknown as typeof fetch;
    const { listener, storage } = await startBackground(fetchImpl);
    const sender = {
      id: "extension-test",
      url: "chrome-extension://extension-test/options.html",
    };
    const first = sendMessage(
      listener,
      { type: "pair-browser", gatewayUrl: "https://gateway.example.com", pairingCode: "code-one" },
      sender,
    );
    await vi.waitFor(() => expect(pairRequests).toBe(1));
    const second = sendMessage(
      listener,
      { type: "pair-browser", gatewayUrl: "https://gateway.example.com", pairingCode: "code-two" },
      sender,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pairRequests).toBe(1);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(pairRequests).toBe(2);
    expect(storage["omnesis.token.v1"]).toBe("token-2");
    expect(JSON.parse(String(storage["omnesis.pairing.v1"]))).toMatchObject({
      deviceId: "0d0e0f10-1111-4222-8333-444455556666",
    });
  });

  it.each(["success-first", "failure-first"] as const)(
    "preserves the successful pairing when another options tab fails (%s)",
    async (order) => {
      let pairRequests = 0;
      const fetchImpl = vi.fn(async (input: string) => {
        if (!input.endsWith("/devices/pair")) {
          return jsonResponse(200, { ingested: 0, deleted: 0 });
        }
        pairRequests += 1;
        const succeeds = order === "success-first" ? pairRequests === 1 : pairRequests === 2;
        return succeeds
          ? jsonResponse(200, {
              device: {
                id: "0d0e0f10-1111-4222-8333-444455556666",
                name: "Browser extension test",
                kind: "browser",
              },
              token: "successful-token",
              scopes: ["write:web"],
            })
          : jsonResponse(400, { error: "invalid or expired pairing code" });
      }) as unknown as typeof fetch;
      const { listener, storage } = await startBackground(fetchImpl);
      const sender = {
        id: "extension-test",
        url: "chrome-extension://extension-test/options.html",
      };

      const results = await Promise.all([
        sendMessage(
          listener,
          {
            type: "pair-browser",
            gatewayUrl: "https://gateway.example.com",
            pairingCode: "first-code",
          },
          sender,
        ),
        sendMessage(
          listener,
          {
            type: "pair-browser",
            gatewayUrl: "https://gateway.example.com",
            pairingCode: "second-code",
          },
          sender,
        ),
      ]);

      expect(results).toContainEqual({ ok: true });
      expect(results).toContainEqual({
        ok: false,
        reason: expect.stringMatching(/invalid or expired pairing code/),
      });
      expect(storage["omnesis.token.v1"]).toBe("successful-token");
      expect(JSON.parse(String(storage["omnesis.pairing.v1"]))).toMatchObject({
        deviceId: "0d0e0f10-1111-4222-8333-444455556666",
      });
      expect(storage["omnesis.capture.hostPermission.v1"]).toBe(true);
    },
  );

  it("does not commit a stale pairing after an ordered unpair revoked access", async () => {
    let pairRequests = 0;
    const fetchImpl = vi.fn((input: string) => {
      if (input.endsWith("/devices/pair")) pairRequests += 1;
      return Promise.resolve(jsonResponse(200, { ingested: 0, deleted: 0 }));
    }) as unknown as typeof fetch;
    const { listener, storage } = await startBackground(fetchImpl);
    const sender = { id: "extension-test", url: "chrome-extension://extension-test/options.html" };

    const unpair = sendMessage(listener, { type: "unpair" }, sender);
    const stalePair = sendMessage(
      listener,
      {
        type: "pair-browser",
        gatewayUrl: "https://gateway.example.com",
        pairingCode: "stale-code",
      },
      sender,
    );

    await expect(unpair).resolves.toEqual({ ok: true });
    await expect(stalePair).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/page access is missing/i),
    });
    expect(pairRequests).toBe(0);
    expect(storage["omnesis.pairing.v1"]).toBeUndefined();
    expect(storage["omnesis.token.v1"]).toBeUndefined();
  });

  it("finishes cleanly unpaired when unpair follows an in-flight pairing", async () => {
    const fetchImpl = vi.fn((input: string) =>
      Promise.resolve(
        input.endsWith("/devices/pair")
          ? jsonResponse(200, {
              device: {
                id: "0d0e0f10-1111-4222-8333-444455556666",
                name: "Browser extension test",
                kind: "browser",
              },
              token: "fresh-token",
              scopes: ["write:web"],
            })
          : jsonResponse(200, { ingested: 0, deleted: 0 }),
      ),
    ) as unknown as typeof fetch;
    const { listener, storage } = await startBackground(fetchImpl);
    const sender = { id: "extension-test", url: "chrome-extension://extension-test/options.html" };

    const pair = sendMessage(
      listener,
      {
        type: "pair-browser",
        gatewayUrl: "https://gateway.example.com",
        pairingCode: "fresh-code",
      },
      sender,
    );
    const unpair = sendMessage(listener, { type: "unpair" }, sender);

    await expect(pair).resolves.toEqual({ ok: true });
    await expect(unpair).resolves.toEqual({ ok: true });
    expect(storage["omnesis.pairing.v1"]).toBeUndefined();
    expect(storage["omnesis.token.v1"]).toBeUndefined();
    expect(storage["omnesis.capture.hostPermission.v1"]).toBe(false);
  });

  it("does not deadlock or orphan the credential when access is removed during pairing", async () => {
    let releasePair: (() => void) | undefined;
    const pairGate = new Promise<void>((resolve) => {
      releasePair = resolve;
    });
    let pairStarted = false;
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.endsWith("/devices/pair")) {
        pairStarted = true;
        await pairGate;
        return jsonResponse(200, {
          device: { id: "device-new", name: "Browser extension test", kind: "browser" },
          token: "fresh-token",
          scopes: ["write:web"],
        });
      }
      return jsonResponse(200, { ingested: 0, deleted: 0 });
    }) as unknown as typeof fetch;
    const { listener, setHostPermission, storage } = await startBackground(fetchImpl, {
      "omnesis.pairing.v1": undefined,
      "omnesis.token.v1": undefined,
    });
    const pair = sendMessage(
      listener,
      {
        type: "pair-browser",
        gatewayUrl: "https://gateway.example.com",
        pairingCode: "fresh-code",
      },
      { id: "extension-test", url: "chrome-extension://extension-test/options.html" },
    );
    await vi.waitFor(() => expect(pairStarted).toBe(true));

    setHostPermission(false);
    releasePair?.();

    await expect(pair).resolves.toEqual({
      ok: true,
      warning: "Paired, but Chrome HTTPS page access needs repair",
    });
    expect(storage["omnesis.token.v1"]).toBe("fresh-token");
    expect(JSON.parse(String(storage["omnesis.pairing.v1"]))).toMatchObject({
      deviceId: "device-new",
    });
    expect(storage["omnesis.capture.hostPermission.v1"]).toBe(false);
  });

  it("retries an unknown permission state without treating it as revoked", async () => {
    const { listener, storage, createAlarm, failNextPermissionRead } = await startBackground(
      vi.fn(() =>
        Promise.resolve(jsonResponse(200, { ingested: 0, deleted: 0 })),
      ) as unknown as typeof fetch,
    );
    const pendingKey = `${CAPTURE_PENDING_PREFIX}permission-unknown`;
    storage[pendingKey] = "fictional pending page";
    failNextPermissionRead();

    await expect(
      sendMessage(
        listener,
        { type: "check-now" },
        { id: "extension-test", url: "chrome-extension://extension-test/options.html" },
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/permission API failure/),
    });

    expect(storage["omnesis.capture.hostPermission.v1"]).toBe(true);
    expect(storage[pendingKey]).toBe("fictional pending page");
    expect(createAlarm).toHaveBeenCalledWith(PERMISSION_RECONCILE_ALARM, {
      delayInMinutes: 1,
    });
  });

  it("unpairs credentials but warns when Chrome keeps page access", async () => {
    const { listener, storage, blockPermissionRemoval } = await startBackground(
      vi.fn(() =>
        Promise.resolve(jsonResponse(200, { ingested: 0, deleted: 0 })),
      ) as unknown as typeof fetch,
    );
    blockPermissionRemoval();

    await expect(
      sendMessage(
        listener,
        { type: "unpair" },
        { id: "extension-test", url: "chrome-extension://extension-test/options.html" },
      ),
    ).resolves.toEqual({
      ok: true,
      warning: "Chrome kept HTTPS page access after the extension was unpaired",
    });
    expect(storage["omnesis.pairing.v1"]).toBeUndefined();
    expect(storage["omnesis.token.v1"]).toBeUndefined();
  });

  it("removes an unpaired grant without running the full unpair transition", async () => {
    const { listener, storage } = await startBackground(
      vi.fn(() =>
        Promise.resolve(jsonResponse(200, { ingested: 0, deleted: 0 })),
      ) as unknown as typeof fetch,
      { "omnesis.pairing.v1": undefined, "omnesis.token.v1": undefined },
    );
    storage[QUEUE_STORAGE_KEY] = JSON.stringify([{ fictional: "preserved" }]);

    await expect(
      sendMessage(
        listener,
        { type: "revoke-capture-access" },
        { id: "extension-test", url: "chrome-extension://extension-test/options.html" },
      ),
    ).resolves.toEqual({ ok: true });

    expect(storage["omnesis.capture.hostPermission.v1"]).toBe(false);
    expect(JSON.parse(String(storage[QUEUE_STORAGE_KEY]))).toEqual([{ fictional: "preserved" }]);
  });

  it("requires unpair before removing a paired extension's page access", async () => {
    const { listener, storage } = await startBackground(
      vi.fn(() =>
        Promise.resolve(jsonResponse(200, { ingested: 0, deleted: 0 })),
      ) as unknown as typeof fetch,
    );

    await expect(
      sendMessage(
        listener,
        { type: "revoke-capture-access" },
        { id: "extension-test", url: "chrome-extension://extension-test/options.html" },
      ),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/unpair/i) });
    expect(storage["omnesis.pairing.v1"]).toBeDefined();
    expect(storage["omnesis.capture.hostPermission.v1"]).toBe(true);
  });

  it("does not let a stale unpaired cleanup click revoke a concurrent successful pair", async () => {
    let releasePair: (() => void) | undefined;
    const pairGate = new Promise<void>((resolve) => {
      releasePair = resolve;
    });
    let pairStarted = false;
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.endsWith("/devices/pair")) {
        pairStarted = true;
        await pairGate;
        return jsonResponse(200, {
          device: { id: "device-new", name: "Browser extension test", kind: "browser" },
          token: "fresh-token",
          scopes: ["write:web"],
        });
      }
      return jsonResponse(200, { ingested: 0, deleted: 0 });
    }) as unknown as typeof fetch;
    const { listener, storage } = await startBackground(fetchImpl, {
      "omnesis.pairing.v1": undefined,
      "omnesis.token.v1": undefined,
    });
    const sender = { id: "extension-test", url: "chrome-extension://extension-test/options.html" };
    const pair = sendMessage(
      listener,
      {
        type: "pair-browser",
        gatewayUrl: "https://gateway.example.com",
        pairingCode: "fresh-code",
      },
      sender,
    );
    await vi.waitFor(() => expect(pairStarted).toBe(true));
    const staleRevoke = sendMessage(listener, { type: "revoke-capture-access" }, sender);
    releasePair?.();

    await expect(pair).resolves.toEqual({ ok: true });
    await expect(staleRevoke).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/unpair/i),
    });
    expect(storage["omnesis.token.v1"]).toBe("fresh-token");
    expect(JSON.parse(String(storage["omnesis.pairing.v1"]))).toMatchObject({});
    expect(storage["omnesis.capture.hostPermission.v1"]).toBe(true);
  });

  it("preserves same-identity handoffs and notices, then clears them on unpair", async () => {
    const fetchImpl = vi.fn(async (input: string) =>
      input.endsWith("/devices/pair")
        ? jsonResponse(200, {
            device: {
              id: "0d0e0f10-1111-4222-8333-444455556666",
              name: "Browser extension test",
              kind: "browser",
            },
            token: "refreshed-token",
            scopes: ["write:web"],
          })
        : jsonResponse(200, { ingested: 0, deleted: 0 }),
    ) as unknown as typeof fetch;
    const { listener, storage } = await startBackground(fetchImpl);
    const key = `${CAPTURE_PENDING_PREFIX}same-identity.re-extract`;
    storage[key] = "staged-page-body";
    storage["omnesis.capture.handoffFailure.v1"] = JSON.stringify({ at: 1, attempts: 4 });
    storage["omnesis.capture.handoffOverflow.v1"] = JSON.stringify({ at: 1, discarded: 2 });
    await sendMessage(
      listener,
      {
        type: "pair-browser",
        gatewayUrl: "https://gateway.example.com",
        pairingCode: "refresh-pairing-code",
      },
      { id: "extension-test", url: "chrome-extension://extension-test/options.html" },
    );
    expect(storage[key]).toBe("staged-page-body");
    expect(storage["omnesis.capture.handoffOverflow.v1"]).not.toBe("");

    await sendMessage(
      listener,
      { type: "unpair" },
      { id: "extension-test", url: "chrome-extension://extension-test/options.html" },
    );
    expect(storage[key]).toBeUndefined();
    expect(storage["omnesis.capture.handoffFailure.v1"]).toBe("");
    expect(storage["omnesis.capture.handoffOverflow.v1"]).toBe("");
  });

  it("makes a pause acknowledgement a real boundary for concurrent captures", async () => {
    let policy = policyBody();
    const { listener, storage } = await startBackground(
      policyAwareFetch(
        () => policy,
        () => jsonResponse(200, { ingested: 0, deleted: 0 }),
        () => {
          policy = policyBody({ pause: { until: null } });
          return policy;
        },
      ),
    );
    const emission: CaptureEmission = {
      kind: "re-extract",
      normalizedUrl: "https://example.com/paused-boundary",
      title: "Paused example",
      text: "Fictional paused body",
      contentHash: TEST_CONTENT_HASH,
      visitedAt: "2026-01-01T00:00:00.000Z",
      dwellMs: 5_000,
      contentChanged: true,
    };
    const pause = sendMessage(listener, { type: "set-pause", until: null }, popupSender);
    const capture = sendMessage(listener, await boundCapture(emission), {
      id: "extension-test",
      tab: { id: 7, url: emission.normalizedUrl },
    });
    await expect(pause).resolves.toEqual({ ok: true });
    await expect(capture).resolves.toEqual({ ok: true, accepted: false });
    expect(JSON.parse(String(storage[QUEUE_STORAGE_KEY]))).toEqual([]);
    // The pause the gateway confirmed is now the browser's copy.
    const cached = JSON.parse(String(storage[CAPTURE_POLICY_KEY])) as { policy: WebCapturePolicy };
    expect(cached.policy.pause).toEqual({ until: null });
  });

  it("returns the gateway's reason when a pause is refused, and keeps the old copy", async () => {
    const { listener, storage } = await startBackground(
      vi.fn(async (input: string) =>
        input.includes("/web-capture-policy")
          ? jsonResponse(503, { error: "gateway is restarting" })
          : jsonResponse(200, { ingested: 0, deleted: 0 }),
      ) as unknown as typeof fetch,
    );
    await expect(
      sendMessage(listener, { type: "set-pause", until: null }, popupSender),
    ).resolves.toEqual({ ok: false, reason: "gateway is restarting" });
    const cached = JSON.parse(String(storage[CAPTURE_POLICY_KEY])) as { policy: WebCapturePolicy };
    expect(cached.policy.pause).toBeNull();
  });

  it("captures nothing without a copy of the gateway's settings, and says so to the page", async () => {
    const { listener, storage } = await startBackground(
      vi.fn(async () => jsonResponse(503, { error: "unavailable" })) as unknown as typeof fetch,
      { [CAPTURE_POLICY_KEY]: "" },
    );
    const emission: CaptureEmission = {
      kind: "visit",
      normalizedUrl: "https://example.com/no-policy",
      title: "No policy yet",
      text: "Fictional body",
      contentHash: TEST_CONTENT_HASH,
      visitedAt: "2026-01-01T00:00:00.000Z",
      dwellMs: 5_000,
      contentChanged: true,
    };
    expect(
      await sendMessage(
        listener,
        { type: "capture-eligibility", url: emission.normalizedUrl },
        {
          id: "extension-test",
          tab: { id: 7 },
        },
      ),
    ).toEqual({ eligible: false, reason: "no-policy", skipPasswordForms: true });
    expect(
      await sendMessage(listener, await boundCapture(emission), {
        id: "extension-test",
        tab: { id: 7, url: emission.normalizedUrl },
      }),
    ).toEqual({ ok: true, accepted: false });
    expect(JSON.parse(String(storage[QUEUE_STORAGE_KEY]))).toEqual([]);
  });

  it("refreshes a stale copy on the drain cadence so another browser's exclusion reaches this one", async () => {
    const { listener, alarmListener, storage } = await startBackground(
      policyAwareFetch(
        () => policyBody({ excludedDomains: ["news.example.com"] }),
        () => jsonResponse(200, { ingested: 0, deleted: 0 }),
      ),
      { [CAPTURE_POLICY_KEY]: cachedPolicy(policyBody(), Date.now() - CAPTURE_POLICY_TTL_MS - 1) },
    );
    alarmListener({ name: PERIODIC_DRAIN_ALARM, scheduledTime: Date.now() });
    await vi.waitFor(() => {
      const cached = JSON.parse(String(storage[CAPTURE_POLICY_KEY])) as {
        policy: WebCapturePolicy;
      };
      expect(cached.policy.excludedDomains).toEqual(["news.example.com"]);
    });
    expect(
      await sendMessage(
        listener,
        { type: "capture-eligibility", url: "https://www.news.example.com/story" },
        { id: "extension-test", tab: { id: 7 } },
      ),
    ).toEqual({ eligible: false, reason: "excluded-domain", skipPasswordForms: true });
    expect(
      await sendMessage(
        listener,
        { type: "capture-eligibility", url: "https://other.example.org/story" },
        { id: "extension-test", tab: { id: 7 } },
      ),
    ).toEqual({ eligible: true, skipPasswordForms: true });
  });

  it("answers from a stale copy at once while the gateway is unreachable", async () => {
    let policyReads = 0;
    const { listener } = await startBackground(
      vi.fn(async (input: string) => {
        if (input.includes("/web-capture-policy")) {
          policyReads += 1;
          return jsonResponse(503, { error: "unavailable" });
        }
        return jsonResponse(200, { ingested: 0, deleted: 0 });
      }) as unknown as typeof fetch,
      {
        [CAPTURE_POLICY_KEY]: cachedPolicy(
          policyBody({ excludedDomains: ["bank.example"] }),
          Date.now() - CAPTURE_POLICY_TTL_MS - 1,
        ),
      },
    );
    const started = Date.now();
    expect(
      await sendMessage(
        listener,
        { type: "capture-eligibility", url: "https://bank.example/x" },
        { id: "extension-test", tab: { id: 7 } },
      ),
    ).toEqual({ eligible: false, reason: "excluded-domain", skipPasswordForms: true });
    // The stale copy governs; the refresh ran alongside, not ahead of the answer.
    expect(Date.now() - started).toBeLessThan(2_000);
    await vi.waitFor(() => expect(policyReads).toBeGreaterThan(0));
  });

  it("refreshes the copy when a page it queued comes back as deleted for good", async () => {
    let policyReads = 0;
    const url = "https://example.com/gone";
    const externalId = await hashText(url);
    const { listener, storage } = await startBackground(
      vi.fn(async (input: string, init: { method?: string; body?: string } = {}) => {
        if (input.includes("/web-capture-policy")) {
          policyReads += 1;
          return jsonResponse(200, policyBody({ removedPages: [externalId] }));
        }
        const body = JSON.parse(init.body ?? "{}") as { documents?: unknown[] };
        return Array.isArray(body.documents) && body.documents.length > 0
          ? jsonResponse(200, { ingested: 0, suppressed: [externalId] })
          : jsonResponse(200, { ingested: 0, deleted: 0 });
      }) as unknown as typeof fetch,
    );
    const emission: CaptureEmission = {
      kind: "re-extract",
      normalizedUrl: url,
      title: "Gone page",
      text: "Fictional body",
      contentHash: TEST_CONTENT_HASH,
      visitedAt: "2026-01-01T00:00:00.000Z",
      dwellMs: 5_000,
      contentChanged: true,
    };
    expect(
      await sendMessage(listener, await boundCapture(emission), {
        id: "extension-test",
        tab: { id: 7, url },
      }),
    ).toEqual({ ok: true, accepted: true });
    await vi.waitFor(() => {
      const cached = JSON.parse(String(storage[CAPTURE_POLICY_KEY])) as {
        policy: WebCapturePolicy;
      };
      expect(cached.policy.removedPages).toEqual([externalId]);
    });
    expect(policyReads).toBeGreaterThan(0);
    expect(JSON.parse(String(storage[QUEUE_STORAGE_KEY]))).toEqual([]);
    expect(storage["omnesis.push.recent.v1"] ?? "").not.toContain("Gone page");
  });

  it("forgets the settings copy on unpair, so a new gateway is read afresh", async () => {
    const { listener, storage } = await startBackground(
      vi.fn(async () => jsonResponse(200, { ingested: 0, deleted: 0 })) as unknown as typeof fetch,
    );
    await sendMessage(listener, { type: "unpair" }, optionsSender);
    expect(storage[CAPTURE_POLICY_KEY] ?? "").toBe("");
  });

  it("keeps a browser-local exclusion list until a pairing exists, and skips a domain the gateway refuses", async () => {
    const unpaired = await startBackground(
      vi.fn(async () => jsonResponse(200, { ingested: 0, deleted: 0 })) as unknown as typeof fetch,
      {
        "omnesis.pairing.v1": undefined,
        "omnesis.token.v1": undefined,
        "omnesis.capture.denylist.v1": JSON.stringify(["bank.example"]),
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unpaired.storage["omnesis.capture.denylist.v1"]).toBeDefined();

    const added: string[] = [];
    const paired = await startBackground(
      vi.fn(async (input: string, init: { method?: string; body?: string } = {}) => {
        if (input.endsWith("/excluded-domains") && init.method === "POST") {
          const { domain } = JSON.parse(init.body ?? "{}") as { domain: string };
          if (domain === "refused.example")
            return jsonResponse(400, { error: "Not a valid domain" });
          added.push(domain);
          return jsonResponse(200, {
            policy: policyBody({ excludedDomains: [...added] }),
            purged: 0,
          });
        }
        return jsonResponse(200, { ingested: 0, deleted: 0 });
      }) as unknown as typeof fetch,
      { "omnesis.capture.denylist.v1": JSON.stringify(["refused.example", "kept.example"]) },
    );
    await vi.waitFor(() => expect(paired.storage["omnesis.capture.denylist.v1"]).toBeUndefined());
    expect(added).toEqual(["kept.example"]);
  });

  it("never re-captures a page the user deleted for good", async () => {
    const url = "https://example.com/deleted-for-good";
    const externalId = await hashText(url);
    const { listener, storage } = await startBackground(
      vi.fn(async () => jsonResponse(200, { ingested: 0, deleted: 0 })) as unknown as typeof fetch,
      { [CAPTURE_POLICY_KEY]: cachedPolicy(policyBody({ removedPages: [externalId] })) },
    );
    const emission: CaptureEmission = {
      kind: "visit",
      normalizedUrl: url,
      title: "Deleted page",
      text: "Fictional body",
      contentHash: TEST_CONTENT_HASH,
      visitedAt: "2026-01-01T00:00:00.000Z",
      dwellMs: 5_000,
      contentChanged: true,
    };
    expect(
      await sendMessage(listener, await boundCapture(emission), {
        id: "extension-test",
        tab: { id: 7, url },
      }),
    ).toEqual({ ok: true, accepted: false });
    expect(JSON.parse(String(storage[QUEUE_STORAGE_KEY]))).toEqual([]);
  });

  it("moves a browser-local exclusion list onto the gateway on start, once", async () => {
    const added: string[] = [];
    const { storage } = await startBackground(
      policyAwareFetch(
        () => policyBody({ excludedDomains: [...added].sort() }),
        () => jsonResponse(200, { ingested: 0, deleted: 0 }),
        (_input, init) => {
          added.push((JSON.parse(init.body ?? "{}") as { domain: string }).domain);
          return policyBody({ excludedDomains: [...added].sort() });
        },
      ),
      {
        "omnesis.capture.denylist.v1": JSON.stringify(["Bank.Example", "shop.example"]),
        "omnesis.capture.pause.v1": JSON.stringify({ until: null }),
      },
    );
    await vi.waitFor(() => expect(storage["omnesis.capture.denylist.v1"]).toBeUndefined());
    expect(storage["omnesis.capture.pause.v1"]).toBeUndefined();
    expect(added).toEqual(["bank.example", "shop.example"]);
    const cached = JSON.parse(String(storage[CAPTURE_POLICY_KEY])) as { policy: WebCapturePolicy };
    expect(cached.policy.excludedDomains).toEqual(["bank.example", "shop.example"]);
  });

  it("contains a failed drain event and retries the intact queue on the next alarm", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ingested: 0, deleted: 0 }),
    ) as unknown as typeof fetch;
    const { alarmListener, storage, failNextQueueWrite } = await startBackground(fetchImpl);
    storage[QUEUE_STORAGE_KEY] = JSON.stringify([
      {
        kind: "document",
        id: "doc:storage-failure",
        doc: {
          source: "web",
          externalId: "fictional-storage-failure",
          title: "Fictional page",
          content: "Fictional body",
        },
        attempts: 0,
        notBefore: 0,
        enqueuedAt: 1,
      },
    ]);
    failNextQueueWrite();
    alarmListener({ name: PERIODIC_DRAIN_ALARM, scheduledTime: Date.now() });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(storage[QUEUE_STORAGE_KEY]))).toHaveLength(1);
    alarmListener({ name: PERIODIC_DRAIN_ALARM, scheduledTime: Date.now() });
    await vi.waitFor(() =>
      expect(JSON.parse(String(storage[QUEUE_STORAGE_KEY])) as unknown[]).toHaveLength(0),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("clears old staged page bodies and rejects a late old-pairing race", async () => {
    const oldPairingId = await capturePairingId({
      gatewayUrl: "https://gateway.example.com",
      deviceId: "0d0e0f10-1111-4222-8333-444455556666",
    });
    const key = `${CAPTURE_PENDING_PREFIX}old-pairing.re-extract`;
    const emission: CaptureEmission = {
      kind: "re-extract",
      normalizedUrl: "https://example.com/private-old-page",
      title: "Old pairing page",
      text: "Fictional old pairing body",
      contentHash: TEST_CONTENT_HASH,
      visitedAt: "2026-01-01T00:00:00.000Z",
      dwellMs: 5_000,
      contentChanged: true,
    };
    const fetchImpl = vi.fn(async (input: string) =>
      input.endsWith("/devices/pair")
        ? jsonResponse(200, {
            device: { id: "device-new", name: "Browser extension test", kind: "browser" },
            token: "new-token",
            scopes: ["write:web"],
          })
        : jsonResponse(200, { ingested: 0, deleted: 0 }),
    ) as unknown as typeof fetch;
    const { listener, alarmListener, storage } = await startBackground(fetchImpl);
    storage[key] = JSON.stringify({ at: 1, order: "0001", pairingId: oldPairingId, emission });
    await sendMessage(
      listener,
      {
        type: "pair-browser",
        gatewayUrl: "https://new-gateway.example.com",
        pairingCode: "new-pairing-code",
      },
      { id: "extension-test", url: "chrome-extension://extension-test/options.html" },
    );
    expect(storage[key]).toBeUndefined();

    // An old tab can race the transition and write after the clear. Identity
    // binding is the backstop: recovery deletes it without uploading.
    storage[key] = JSON.stringify({ at: 2, order: "0002", pairingId: oldPairingId, emission });
    const fetchMock = fetchImpl as unknown as Mock<typeof fetch>;
    fetchMock.mockClear();
    alarmListener({ name: PERIODIC_DRAIN_ALARM, scheduledTime: Date.now() });
    await vi.waitFor(() => expect(storage[key]).toBeUndefined());
    expect(
      fetchMock.mock.calls.some(([, init]) => {
        const body = JSON.parse(String((init as RequestInit).body ?? "{}")) as {
          documents?: unknown[];
        };
        return Array.isArray(body.documents) && body.documents.length > 0;
      }),
    ).toBe(false);
  });

  it("rejects the paired gateway and incognito at the privileged enqueue seam", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ingested: 0, deleted: 0 }),
    ) as unknown as typeof fetch;
    const { listener, storage } = await startBackground(fetchImpl);
    const emission: CaptureEmission = {
      kind: "re-extract",
      normalizedUrl: "https://gateway.example.com/portal/search",
      title: "Private portal",
      text: "Fictional private corpus view",
      contentHash: TEST_CONTENT_HASH,
      visitedAt: "2026-01-01T00:00:00.000Z",
      dwellMs: 5_000,
      contentChanged: true,
    };
    expect(
      await sendMessage(listener, await boundCapture(emission), {
        id: "extension-test",
        tab: { id: 7, url: emission.normalizedUrl },
      }),
    ).toEqual({ ok: true, accepted: false });
    expect(JSON.parse(String(storage[QUEUE_STORAGE_KEY]))).toEqual([]);
    expect(
      listener(
        await boundCapture({ ...emission, normalizedUrl: "https://example.com" }),
        { id: "extension-test", tab: { id: 8, incognito: true } },
        vi.fn(),
      ),
    ).toBe(false);
    expect(
      listener(
        await boundCapture({
          ...emission,
          normalizedUrl: "https://user:password@example.com/article",
        }),
        { id: "extension-test", tab: { id: 9 } },
        vi.fn(),
      ),
    ).toBe(false);
  });

  it("rejects capture and clears staged bodies after Chrome page access is revoked", async () => {
    const { listener, storage, setHostPermission } = await startBackground(
      vi.fn(async () => jsonResponse(200, { ingested: 0, deleted: 0 })) as unknown as typeof fetch,
    );
    const emission: CaptureEmission = {
      kind: "re-extract",
      normalizedUrl: "https://example.com/revoked",
      title: "Revoked example",
      text: "Fictional page body",
      contentHash: TEST_CONTENT_HASH,
      visitedAt: "2026-01-01T00:00:00.000Z",
      dwellMs: 5_000,
      contentChanged: true,
    };
    const capture = (await boundCapture(emission)) as {
      handoffKey: string;
      pairingId: string;
    };
    storage[capture.handoffKey] = JSON.stringify({
      at: 1,
      order: "0001",
      pairingId: capture.pairingId,
      emission,
    });
    setHostPermission(false, ["https://news.example.com/*"]);
    const ack = await sendMessage(
      listener,
      { ...capture, type: "capture", emission },
      {
        id: "extension-test",
        tab: { id: 7, url: emission.normalizedUrl },
      },
    );
    expect(ack).toEqual({ ok: true, accepted: false });
    expect(JSON.parse(String(storage[QUEUE_STORAGE_KEY]))).toEqual([]);
    expect(Object.keys(storage).some((key) => key.startsWith(CAPTURE_PENDING_PREFIX))).toBe(false);
    expect(storage["omnesis.capture.hostPermission.v1"]).toBe(false);
  });

  it("preserves Chrome host-permission event order in content-visible storage", async () => {
    const { storage, setHostPermission } = await startBackground(
      vi.fn(() =>
        Promise.resolve(jsonResponse(200, { ingested: 0, deleted: 0 })),
      ) as unknown as typeof fetch,
    );

    setHostPermission(false);
    await vi.waitFor(() => expect(storage["omnesis.capture.hostPermission.v1"]).toBe(false));
    setHostPermission(true);
    await vi.waitFor(() => expect(storage["omnesis.capture.hostPermission.v1"]).toBe(true));
  });

  it("applies an exclusion made from the options page or the popup to a racing capture", async () => {
    let policy = policyBody();
    const { listener, storage } = await startBackground(
      policyAwareFetch(
        () => policy,
        () => jsonResponse(200, { ingested: 0, deleted: 0 }),
        (_input, init) => {
          const { domain } = JSON.parse(init.body ?? "{}") as { domain: string };
          policy = policyBody({ excludedDomains: [...policy.excludedDomains, domain].sort() });
          return policy;
        },
      ),
    );

    const emission: CaptureEmission = {
      kind: "visit",
      normalizedUrl: "https://news.example.com/article",
      title: "Fictional news",
      text: "Fictional article body",
      contentHash: TEST_CONTENT_HASH,
      visitedAt: "2026-01-01T00:00:00.000Z",
      dwellMs: 5_000,
      contentChanged: true,
    };
    const [fromOptions, fromPopup, captureAck] = await Promise.all([
      sendMessage(listener, { type: "add-excluded-domain", input: "example.com" }, optionsSender),
      sendMessage(
        listener,
        { type: "add-excluded-domain", input: "https://example.org/x", purge: false },
        popupSender,
      ),
      sendMessage(listener, await boundCapture(emission), {
        id: "extension-test",
        tab: { id: 10, url: emission.normalizedUrl },
      }),
    ]);
    expect(fromOptions).toEqual({ ok: true, purged: 0 });
    expect(fromPopup).toEqual({ ok: true, purged: 0 });
    expect(policy.excludedDomains).toEqual(["example.com", "example.org"]);
    expect(captureAck).toEqual({ ok: true, accepted: false });
    expect(JSON.parse(String(storage[QUEUE_STORAGE_KEY]))).toEqual([]);
    expect(await sendMessage(listener, { type: "read-policy" }, popupSender)).toMatchObject({
      policy: { excludedDomains: ["example.com", "example.org"] },
    });
  });

  it("rejects pairing-state messages that did not come from the options page", async () => {
    const { listener, storage } = await startBackground(
      vi.fn(async () => jsonResponse(200, { ingested: 0, deleted: 0 })) as unknown as typeof fetch,
    );
    const before = storage["omnesis.pairing.v1"];
    expect(
      listener(
        { type: "unpair" },
        { id: "extension-test", tab: { id: 9, url: "https://example.com" } },
        vi.fn(),
      ),
    ).toBe(false);
    expect(storage["omnesis.pairing.v1"]).toBe(before);

    expect(
      listener(
        {
          type: "pair-browser",
          gatewayUrl: "https://gateway.example.com/portal",
          pairingCode: "invalid-gateway-path",
        },
        {
          id: "extension-test",
          url: "chrome-extension://extension-test/options.html",
        },
        vi.fn(),
      ),
    ).toBe(false);
    expect(storage["omnesis.pairing.v1"]).toBe(before);
  });

  it("recovers a pre-ack capture after its originating tab has gone away", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ingested: 0, deleted: 0 }),
    ) as unknown as typeof fetch;
    const { alarmListener, storage } = await startBackground(fetchImpl);
    const key = `${CAPTURE_PENDING_PREFIX}closed-tab.re-extract`;
    const pairingId = await capturePairingId({
      gatewayUrl: "https://gateway.example.com",
      deviceId: "0d0e0f10-1111-4222-8333-444455556666",
    });
    storage[key] = JSON.stringify({
      at: 1,
      order: "0001",
      pairingId,
      emission: {
        kind: "re-extract",
        normalizedUrl: "https://example.com/recovered",
        title: "Recovered article",
        text: "Fictional recovered body",
        contentHash: TEST_CONTENT_HASH,
        visitedAt: "2026-01-01T00:00:00.000Z",
        dwellMs: 5_000,
        contentChanged: true,
      },
    });
    alarmListener({ name: PERIODIC_DRAIN_ALARM, scheduledTime: Date.now() });
    await vi.waitFor(() => expect(storage[key]).toBeUndefined());
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(JSON.parse(String(storage[QUEUE_STORAGE_KEY])) as unknown[]).toHaveLength(0),
    );
  });

  it("preserves Retry-After on check-now and resets it only for a fresh pairing", async () => {
    let uploadAttempts = 0;
    const fetchImpl = vi.fn(async (input: string, init: { body?: string }) => {
      if (input.endsWith("/health")) return jsonResponse(200, { status: "ok", version: "9.8.7" });
      if (input.endsWith("/web-capture-policy")) return jsonResponse(200, policyBody());
      if (input.endsWith("/devices/pair")) {
        return jsonResponse(200, {
          device: {
            id: "0d0e0f10-1111-4222-8333-444455556666",
            name: "Browser extension test",
            kind: "browser",
          },
          token: "new-token",
          scopes: ["write:web"],
        });
      }
      const body = JSON.parse(init.body ?? "{}") as { documents?: unknown[] };
      if (Array.isArray(body.documents) && body.documents.length === 0) {
        return jsonResponse(200, { ingested: 0, deleted: 0 });
      }
      uploadAttempts += 1;
      return uploadAttempts === 1
        ? jsonResponse(429, { error: "slow down" }, { "Retry-After": "60" })
        : jsonResponse(200, { ingested: 0, deleted: 0 });
    }) as unknown as typeof fetch;
    const { listener } = await startBackground(fetchImpl);
    const emission: CaptureEmission = {
      kind: "re-extract",
      normalizedUrl: "https://example.com/backoff",
      title: "Backoff article",
      text: "Fictional article body",
      contentHash: TEST_CONTENT_HASH,
      visitedAt: "2026-01-01T00:00:00.000Z",
      dwellMs: 5_000,
      contentChanged: true,
    };
    await sendMessage(listener, await boundCapture(emission), {
      id: "extension-test",
      tab: { id: 7, url: emission.normalizedUrl },
    });
    await vi.waitFor(() => expect(uploadAttempts).toBe(1));

    await sendMessage(
      listener,
      { type: "check-now" },
      { id: "extension-test", url: "chrome-extension://extension-test/popup.html" },
    );
    expect(uploadAttempts).toBe(1);

    await sendMessage(
      listener,
      {
        type: "pair-browser",
        gatewayUrl: "https://gateway.example.com",
        pairingCode: "fresh-pairing-code",
      },
      { id: "extension-test", url: "chrome-extension://extension-test/options.html" },
    );
    await sendMessage(
      listener,
      { type: "check-now" },
      { id: "extension-test", url: "chrome-extension://extension-test/popup.html" },
    );
    expect(uploadAttempts).toBe(2);
  });

  it("accepts the options page's immediate post-pair check", async () => {
    const { listener } = await startBackground(
      vi.fn(async () => jsonResponse(200, { ingested: 0, deleted: 0 })) as unknown as typeof fetch,
    );
    await expect(
      sendMessage(
        listener,
        { type: "check-now" },
        {
          id: "extension-test",
          url: "chrome-extension://extension-test/options.html",
        },
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("uses a fresh capture to recover stale source state after queue repair", async () => {
    const { listener, storage } = await startBackground(
      vi.fn(async () => jsonResponse(200, { ingested: 0, deleted: 0 })) as unknown as typeof fetch,
      {
        [QUEUE_STORAGE_KEY]: "damaged-json",
        "omnesis.push.serverState.v1": JSON.stringify({
          state: "paused",
          reason: "paused",
          at: 1,
        }),
      },
    );
    const emission: CaptureEmission = {
      kind: "re-extract",
      normalizedUrl: "https://example.com/source-recovered",
      title: "Recovered source article",
      text: "Fictional article body",
      contentHash: TEST_CONTENT_HASH,
      visitedAt: "2026-01-01T00:00:00.000Z",
      dwellMs: 5_000,
      contentChanged: true,
    };
    expect(
      await sendMessage(listener, await boundCapture(emission), {
        id: "extension-test",
        tab: { id: 7, url: emission.normalizedUrl },
      }),
    ).toEqual({ ok: true, accepted: true });
    await vi.waitFor(() => expect(storage["omnesis.push.serverState.v1"]).toBe(""));
  });
});

/**
 * Chrome evicts an MV3 service worker within seconds of idle and re-spawns it
 * on the next event with none of its module state. Each scenario here runs a
 * first worker generation, then boots a second one over the very same durable
 * storage record: what the first generation left in `chrome.storage.local` is
 * the only thing the second one may rely on.
 */
describe("MV3 background restart", () => {
  /** The bodies of every `POST /documents` a fetch double saw. */
  const documentBodies = (fetchImpl: Mock): string[] =>
    fetchImpl.mock.calls.flatMap((call: unknown[]) => {
      const [input, init] = call as [string, { method?: string; body?: string } | undefined];
      return input.endsWith("/documents") &&
        init?.method === "POST" &&
        typeof init.body === "string"
        ? [init.body]
        : [];
    });

  /**
   * Re-import the worker over a previous generation's storage. The previous
   * generation's fire-and-forget tails are given a moment to settle first so
   * they cannot land on the new generation's Chrome fakes.
   */
  async function restartBackground(
    previous: BackgroundHarness,
    fetchImpl: typeof fetch,
  ): Promise<BackgroundHarness> {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return startBackground(fetchImpl, previous.storage);
  }

  function restartEmission(suffix: string): CaptureEmission {
    return {
      kind: "re-extract",
      normalizedUrl: `https://example.com/${suffix}`,
      title: `Restart ${suffix}`,
      text: `Fictional ${suffix} body`,
      contentHash: TEST_CONTENT_HASH,
      visitedAt: "2026-01-01T00:00:00.000Z",
      dwellMs: 5_000,
      contentChanged: true,
    };
  }

  it("delivers a capture queued before eviction from the next generation's startup drain", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const outage = vi.fn(async () =>
      jsonResponse(503, { error: "temporarily unavailable" }),
    ) as unknown as typeof fetch;
    const first = await startBackground(outage);
    const emission = restartEmission("survives-eviction");
    expect(
      await sendMessage(first.listener, await boundCapture(emission), {
        id: "extension-test",
        tab: { id: 7, url: emission.normalizedUrl },
      }),
    ).toEqual({ ok: true, accepted: true });
    // The gateway refused the delivery, so the item stays queued with a backoff
    // deadline the first generation asked an alarm to honour.
    await vi.waitFor(() =>
      expect(first.createAlarm).toHaveBeenCalledWith(RETRY_DRAIN_ALARM, { when: 11_000 }),
    );
    const queued = JSON.parse(String(first.storage[QUEUE_STORAGE_KEY])) as Array<{
      notBefore: number;
    }>;
    expect(queued).toHaveLength(1);
    expect(queued[0]!.notBefore).toBe(11_000);

    // The worker is evicted; by the time it is re-spawned the backoff has lapsed.
    now = 11_000;
    const healthy = vi.fn(async () =>
      jsonResponse(200, { ingested: 1, deleted: 0 }),
    ) as unknown as typeof fetch;
    const second = await restartBackground(first, healthy);
    await vi.waitFor(() =>
      expect(JSON.parse(String(second.storage[QUEUE_STORAGE_KEY])) as unknown[]).toHaveLength(0),
    );
    const delivered = documentBodies(healthy as unknown as Mock);
    expect(delivered.some((body) => body.includes("Restart survives-eviction"))).toBe(true);
    expect(outage).toHaveBeenCalled();
  });

  it("keeps a pause set before eviction in force without asking the gateway again", async () => {
    let policy = policyBody();
    const pauseUntil = Date.now() + 60 * 60 * 1000;
    const first = await startBackground(
      policyAwareFetch(
        () => policy,
        () => jsonResponse(200, { ingested: 0, deleted: 0 }),
        () => {
          policy = policyBody({ pause: { until: pauseUntil } });
          return policy;
        },
      ),
    );
    await expect(
      sendMessage(first.listener, { type: "set-pause", until: pauseUntil }, popupSender),
    ).resolves.toEqual({ ok: true });
    const cached = JSON.parse(String(first.storage[CAPTURE_POLICY_KEY])) as {
      policy: WebCapturePolicy;
    };
    expect(cached.policy.pause).toEqual({ until: pauseUntil });

    // The re-spawned worker holds a fresh copy carrying the pause; a gateway
    // that cannot even be reached changes nothing about what it enforces.
    let policyReads = 0;
    const second = await restartBackground(
      first,
      vi.fn(async (input: string) => {
        if (input.includes("/web-capture-policy")) {
          policyReads += 1;
          return jsonResponse(503, { error: "unavailable" });
        }
        return jsonResponse(200, { ingested: 0, deleted: 0 });
      }) as unknown as typeof fetch,
    );
    const emission = restartEmission("paused-across-restart");
    expect(
      await sendMessage(
        second.listener,
        { type: "capture-eligibility", url: emission.normalizedUrl },
        { id: "extension-test", tab: { id: 7 } },
      ),
    ).toEqual({ eligible: false, reason: "paused", skipPasswordForms: true });
    expect(
      await sendMessage(second.listener, await boundCapture(emission), {
        id: "extension-test",
        tab: { id: 7, url: emission.normalizedUrl },
      }),
    ).toEqual({ ok: true, accepted: false });
    expect(JSON.parse(String(second.storage[QUEUE_STORAGE_KEY]))).toEqual([]);
    expect(policyReads).toBe(0);
  });

  it("refreshes a copy that went stale across the eviction on the first alarm", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const first = await startBackground(
      policyAwareFetch(
        () => policyBody(),
        () => jsonResponse(200, { ingested: 0, deleted: 0 }),
      ),
      { [CAPTURE_POLICY_KEY]: "" },
    );
    // A page probe with no copy at hand makes the first generation read one.
    expect(
      await sendMessage(
        first.listener,
        { type: "capture-eligibility", url: "https://news.example.com/story" },
        { id: "extension-test", tab: { id: 7 } },
      ),
    ).toEqual({ eligible: true, skipPasswordForms: true });
    expect(
      (JSON.parse(String(first.storage[CAPTURE_POLICY_KEY])) as { fetchedAt: number }).fetchedAt,
    ).toBe(now);

    // Long enough passes while the worker is gone for the copy to age out; the
    // gateway's settings meanwhile gained an exclusion.
    now += CAPTURE_POLICY_TTL_MS + 1;
    let policyReads = 0;
    const second = await restartBackground(
      first,
      policyAwareFetch(
        () => {
          policyReads += 1;
          return policyBody({ excludedDomains: ["news.example.com"] });
        },
        () => jsonResponse(200, { ingested: 0, deleted: 0 }),
      ),
    );
    // Startup alone does not read the gateway's settings; the copy is still
    // the one the previous generation wrote.
    expect(policyReads).toBe(0);
    expect(
      (JSON.parse(String(second.storage[CAPTURE_POLICY_KEY])) as { policy: WebCapturePolicy })
        .policy.excludedDomains,
    ).toEqual([]);

    second.alarmListener({ name: PERIODIC_DRAIN_ALARM, scheduledTime: now });
    await vi.waitFor(() => {
      const cached = JSON.parse(String(second.storage[CAPTURE_POLICY_KEY])) as {
        policy: WebCapturePolicy;
        fetchedAt: number;
      };
      expect(cached.policy.excludedDomains).toEqual(["news.example.com"]);
      expect(cached.fetchedAt).toBe(now);
    });
    expect(
      await sendMessage(
        second.listener,
        { type: "capture-eligibility", url: "https://news.example.com/story" },
        { id: "extension-test", tab: { id: 7 } },
      ),
    ).toEqual({ eligible: false, reason: "excluded-domain", skipPasswordForms: true });
  });

  it("replays the same pairing idempotency key after an eviction mid-redemption", async () => {
    const pairBodies: Record<string, unknown>[] = [];
    const recordingPairFetch = (
      answer: (body: Record<string, unknown>) => ReturnType<typeof jsonResponse>,
    ): typeof fetch =>
      vi.fn(async (input: string, init?: { body?: string }) => {
        if (input.endsWith("/health")) return jsonResponse(200, { status: "ok", version: "9.8.7" });
        if (input.endsWith("/devices/pair")) {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          pairBodies.push(body);
          return answer(body);
        }
        return jsonResponse(200, { ingested: 0, deleted: 0 });
      }) as unknown as typeof fetch;
    const paired = (id: string): ReturnType<typeof jsonResponse> =>
      jsonResponse(200, {
        device: { id, name: "Browser extension test", kind: "browser" },
        token: `${id}-token`,
        scopes: ["write:web"],
      });
    const pairMessage = {
      type: "pair-browser",
      gatewayUrl: "https://new-gateway.example.com",
      pairingCode: "code",
      profileLabel: "Personal",
    };

    // The request leaves the first generation without any answer: the gateway
    // may or may not have spent the code, so the attempt key stays durable.
    const first = await startBackground(
      recordingPairFetch(() => {
        throw new TypeError("fictional connection reset");
      }),
    );
    await expect(sendMessage(first.listener, pairMessage, optionsSender)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/submit the same code again/),
    });
    const storedAttempt = first.storage[PAIRING_ATTEMPT_KEY];
    expect(storedAttempt).toBeDefined();

    // The user submits the same code to the re-spawned worker.
    const second = await restartBackground(
      first,
      recordingPairFetch(() => paired("device-new")),
    );
    await expect(sendMessage(second.listener, pairMessage, optionsSender)).resolves.toEqual({
      ok: true,
    });
    expect(pairBodies).toHaveLength(2);
    expect(pairBodies[1]!.idempotencyKey).toBe(pairBodies[0]!.idempotencyKey);
    expect(pairBodies[1]!.idempotencyKey).toBe(
      (JSON.parse(String(storedAttempt)) as { key: string }).key,
    );
    expect(second.storage[PAIRING_ATTEMPT_KEY]).toBeUndefined();

    // A different code is a different attempt with a key of its own.
    await expect(
      sendMessage(second.listener, { ...pairMessage, pairingCode: "other-code" }, optionsSender),
    ).resolves.toEqual({ ok: true });
    expect(pairBodies).toHaveLength(3);
    expect(pairBodies[2]!.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pairBodies[2]!.idempotencyKey).not.toBe(pairBodies[0]!.idempotencyKey);
  });

  it("drops a staged page bound to another pairing on start and uploads only the current one", async () => {
    const currentPairingId = await capturePairingId({
      gatewayUrl: "https://gateway.example.com",
      deviceId: "0d0e0f10-1111-4222-8333-444455556666",
    });
    const otherPairingId = await capturePairingId({
      gatewayUrl: "https://other-gateway.example.com",
      deviceId: "7a7b7c7d-2222-4333-8444-555566667777",
    });
    const currentKey = `${CAPTURE_PENDING_PREFIX}closed-tab.current`;
    const otherKey = `${CAPTURE_PENDING_PREFIX}closed-tab.other`;
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ingested: 1, deleted: 0 }),
    ) as unknown as typeof fetch;
    const { storage } = await startBackground(fetchImpl, {
      [otherKey]: JSON.stringify({
        at: 1,
        order: "0001",
        pairingId: otherPairingId,
        emission: restartEmission("other-gateway-page"),
      }),
      [currentKey]: JSON.stringify({
        at: 2,
        order: "0002",
        pairingId: currentPairingId,
        emission: restartEmission("current-gateway-page"),
      }),
      [CAPTURE_HANDOFF_FAILURE_KEY]: JSON.stringify({ at: 1, attempts: 3 }),
    });

    await vi.waitFor(() => {
      expect(storage[otherKey]).toBeUndefined();
      expect(storage[currentKey]).toBeUndefined();
    });
    await vi.waitFor(() =>
      expect(JSON.parse(String(storage[QUEUE_STORAGE_KEY])) as unknown[]).toHaveLength(0),
    );
    const delivered = documentBodies(fetchImpl as unknown as Mock);
    expect(delivered.some((body) => body.includes("Restart current-gateway-page"))).toBe(true);
    expect(delivered.some((body) => body.includes("Restart other-gateway-page"))).toBe(false);
    // With the outbox empty the standing handoff-failure notice is withdrawn.
    expect(storage[CAPTURE_HANDOFF_FAILURE_KEY]).toBe("");
  });
});
