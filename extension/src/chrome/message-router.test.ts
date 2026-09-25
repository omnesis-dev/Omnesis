// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi, type Mock } from "vitest";
import {
  DEFAULT_WEB_CAPTURE_RULES,
  MAX_CAPTURE_DOMAIN_CHARS,
} from "@omnesis/provider-web/capture-policy";
import {
  MAX_CAPTURE_TITLE_CHARS,
  MAX_CAPTURE_URL_CHARS,
  type CaptureEmission,
} from "../capture/lifecycle.js";
import { routeBackgroundMessage, type BackgroundMessageDeps } from "./message-router.js";
import { CAPTURE_PENDING_PREFIX, type CaptureAck, type CapturePolicySnapshot } from "./messages.js";

/**
 * The router is the only thing standing between an arbitrary `chrome.runtime`
 * message and the worker's privileged seams (queue, pairing, policy edits), so
 * this suite pins down every cell of its accept/reject matrix: which sender
 * may send which message, what the dep receives, what the sender hears back,
 * and that a refused message reaches no dep at all.
 */

const runtimeId = "extension-test";
const popupUrl = "chrome-extension://extension-test/popup.html";
const optionsUrl = "chrome-extension://extension-test/options.html";
const TEST_CONTENT_HASH = "a".repeat(64);
const TEST_PAIRING_ID = "b".repeat(64);
const PAGE_URL = "https://news.example.com/articles/quarterly-budget-review";

const sender = {
  contentTab: { id: runtimeId, tab: { id: 7 } },
  incognitoTab: { id: runtimeId, tab: { id: 7, incognito: true } },
  popup: { id: runtimeId, url: popupUrl },
  options: { id: runtimeId, url: optionsUrl },
  foreignPopup: { id: "other-extension", url: popupUrl },
  foreignTab: { id: "other-extension", tab: { id: 7 } },
  bare: { id: runtimeId },
} as const;
type SenderName = keyof typeof sender;
const SENDER_NAMES = Object.keys(sender) as SenderName[];

type DepName = Exclude<keyof BackgroundMessageDeps, "runtimeId" | "popupUrl" | "optionsUrl">;
type FakeDeps = Pick<BackgroundMessageDeps, "runtimeId" | "popupUrl" | "optionsUrl"> & {
  [K in DepName]: Mock<BackgroundMessageDeps[K]>;
};
const DEP_NAMES: DepName[] = [
  "handleCapture",
  "drain",
  "judgeEligibility",
  "handlePause",
  "dismissDiagnostics",
  "checkNow",
  "readPolicy",
  "mutateExclusions",
  "changePairing",
];

const POLICY_SNAPSHOT: CapturePolicySnapshot = {
  policy: {
    updatedAt: "2026-03-14T09:00:00.000Z",
    pause: null,
    excludedDomains: ["ads.example.com"],
    ownedDomains: [],
    rules: DEFAULT_WEB_CAPTURE_RULES,
    removedPages: [],
    removedPagesTruncated: false,
  },
  fetchedAt: 1_700_000_000_000,
};

/** Every dep answers with a plausible success so a routed message resolves. */
function makeDeps(): FakeDeps {
  return {
    runtimeId,
    popupUrl,
    optionsUrl,
    handleCapture: vi.fn(() => Promise.resolve<CaptureAck>({ ok: true, accepted: true })),
    drain: vi.fn(() => Promise.resolve()),
    judgeEligibility: vi.fn(() => Promise.resolve({ eligible: true, skipPasswordForms: true })),
    handlePause: vi.fn(() => Promise.resolve()),
    dismissDiagnostics: vi.fn(() => Promise.resolve()),
    checkNow: vi.fn(() => Promise.resolve()),
    readPolicy: vi.fn(() => Promise.resolve(POLICY_SNAPSHOT)),
    mutateExclusions: vi.fn(() => Promise.resolve({ purged: 2 })),
    changePairing: vi.fn(() => Promise.resolve()),
  };
}

function validEmission(overrides: Partial<CaptureEmission> = {}): CaptureEmission {
  return {
    kind: "visit",
    normalizedUrl: PAGE_URL,
    title: "Quarterly budget review",
    text: "The finance team met to walk through the Q4 numbers.",
    contentHash: TEST_CONTENT_HASH,
    visitedAt: "2026-03-14T09:26:53.000Z",
    dwellMs: 12_000,
    contentChanged: true,
    ...overrides,
  };
}

/** A capture envelope as the content script hands it off; overrides may break any field. */
function validCapture(
  emission: Partial<CaptureEmission> = {},
  envelope: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "capture",
    emission: validEmission(emission),
    handoffKey: `${CAPTURE_PENDING_PREFIX}test.1`,
    pairingId: TEST_PAIRING_ID,
    ...envelope,
  };
}

function eligibility(url: unknown): Record<string, unknown> {
  return { type: "capture-eligibility", url };
}

function pairBrowser(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "pair-browser",
    gatewayUrl: "https://gateway.example.com:7600",
    pairingCode: "ABCD-1234",
    profileLabel: "Work",
    ...overrides,
  };
}

interface Routed {
  kept: boolean;
  response: Promise<unknown>;
  sendResponse: Mock<(response?: unknown) => void>;
  deps: FakeDeps;
}

/** Route one message and expose the promise the async `sendResponse` settles. */
function route(message: unknown, from: (typeof sender)[SenderName], deps = makeDeps()): Routed {
  let settle: (value: unknown) => void = () => undefined;
  const response = new Promise<unknown>((resolve) => {
    settle = resolve;
  });
  const sendResponse = vi.fn((value?: unknown) => settle(value));
  const kept = routeBackgroundMessage(message, from, sendResponse, deps);
  return { kept, response, sendResponse, deps };
}

/** Let every pending microtask and the router's detached `.then` chains run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function expectNoDepCalled(deps: FakeDeps, except: DepName[] = []): void {
  for (const name of DEP_NAMES) {
    if (!except.includes(name)) expect(deps[name], name).not.toHaveBeenCalled();
  }
}

async function expectRefused(message: unknown, from: (typeof sender)[SenderName]): Promise<void> {
  const { kept, sendResponse, deps } = route(message, from);
  expect(kept).toBe(false);
  await flush();
  expect(sendResponse).not.toHaveBeenCalled();
  expectNoDepCalled(deps);
}

interface MessageCase {
  message: unknown;
  /** The single dep a routed message reaches, and the argument list it receives. */
  dep: DepName;
  args: unknown[];
  response: unknown;
  acceptedBy: readonly SenderName[];
}

const SET_PAUSE = { type: "set-pause", until: 1_700_000_000_000 };
const REMOVE_DOMAIN = { type: "remove-excluded-domain", domain: "news.example.com" };
const ADD_DOMAIN = { type: "add-excluded-domain", input: "News.Example.com/path", purge: true };
const PAIR = pairBrowser();
const SET_LABEL = { type: "set-profile-label", profileLabel: "Home" };
const CAPTURE = validCapture();
const ELIGIBILITY = eligibility(PAGE_URL);

const OK = { ok: true };
const MESSAGE_CASES: Record<string, MessageCase> = {
  capture: {
    message: CAPTURE,
    dep: "handleCapture",
    args: [CAPTURE],
    response: { ok: true, accepted: true },
    acceptedBy: ["contentTab"],
  },
  "capture-eligibility": {
    message: ELIGIBILITY,
    dep: "judgeEligibility",
    args: [PAGE_URL],
    response: { eligible: true, skipPasswordForms: true },
    acceptedBy: ["contentTab"],
  },
  "set-pause": {
    message: SET_PAUSE,
    dep: "handlePause",
    args: [SET_PAUSE],
    response: OK,
    acceptedBy: ["popup"],
  },
  resume: {
    message: { type: "resume" },
    dep: "handlePause",
    args: [{ type: "resume" }],
    response: OK,
    acceptedBy: ["popup"],
  },
  "dismiss-diagnostics": {
    message: { type: "dismiss-diagnostics" },
    dep: "dismissDiagnostics",
    args: [],
    response: OK,
    acceptedBy: ["popup"],
  },
  "check-now": {
    message: { type: "check-now" },
    dep: "checkNow",
    args: [],
    response: OK,
    acceptedBy: ["popup", "options"],
  },
  "read-policy": {
    message: { type: "read-policy" },
    dep: "readPolicy",
    args: [],
    response: POLICY_SNAPSHOT,
    acceptedBy: ["popup", "options"],
  },
  "add-excluded-domain": {
    message: ADD_DOMAIN,
    dep: "mutateExclusions",
    args: [ADD_DOMAIN],
    response: { ok: true, purged: 2 },
    acceptedBy: ["popup", "options"],
  },
  "remove-excluded-domain": {
    message: REMOVE_DOMAIN,
    dep: "mutateExclusions",
    args: [REMOVE_DOMAIN],
    response: { ok: true, purged: 2 },
    acceptedBy: ["popup", "options"],
  },
  "pair-browser": {
    message: PAIR,
    dep: "changePairing",
    args: [PAIR],
    response: OK,
    acceptedBy: ["options"],
  },
  unpair: {
    message: { type: "unpair" },
    dep: "changePairing",
    args: [{ type: "unpair" }],
    response: OK,
    acceptedBy: ["options"],
  },
  "revoke-capture-access": {
    message: { type: "revoke-capture-access" },
    dep: "changePairing",
    args: [{ type: "revoke-capture-access" }],
    response: OK,
    acceptedBy: ["options"],
  },
  "set-profile-label": {
    message: SET_LABEL,
    dep: "changePairing",
    args: [SET_LABEL],
    response: OK,
    acceptedBy: ["options"],
  },
  // The last two are never accepted by anyone; `dep` is a placeholder the
  // accepted table never reads.
  unknown: {
    message: { type: "reboot-universe" },
    dep: "checkNow",
    args: [],
    response: undefined,
    acceptedBy: [],
  },
  "non-object": {
    message: "capture",
    dep: "checkNow",
    args: [],
    response: undefined,
    acceptedBy: [],
  },
};

const MESSAGE_NAMES = Object.keys(MESSAGE_CASES);
const ACCEPTED_CELLS = MESSAGE_NAMES.flatMap((name) =>
  MESSAGE_CASES[name].acceptedBy.map((from) => [name, from] as const),
);
const REJECTED_CELLS = MESSAGE_NAMES.flatMap((name) =>
  SENDER_NAMES.filter((from) => !MESSAGE_CASES[name].acceptedBy.includes(from)).map(
    (from) => [name, from] as const,
  ),
);

describe("routeBackgroundMessage sender × message matrix", () => {
  it.each(ACCEPTED_CELLS)("%s from %s reaches exactly its dep and is acked", async (name, from) => {
    const kase = MESSAGE_CASES[name];
    const { kept, response, deps } = route(kase.message, sender[from]);
    expect(kept).toBe(true);
    await expect(response).resolves.toEqual(kase.response);
    expect(deps[kase.dep]).toHaveBeenCalledTimes(1);
    expect(deps[kase.dep]).toHaveBeenCalledWith(...kase.args);
    // An accepted capture also kicks the drain; nothing else reaches a second dep.
    expectNoDepCalled(deps, name === "capture" ? [kase.dep, "drain"] : [kase.dep]);
  });

  it.each(REJECTED_CELLS)("%s from %s is refused without touching any dep", async (name, from) => {
    await expectRefused(MESSAGE_CASES[name].message, sender[from]);
  });

  it("covers every sender for every message", () => {
    expect(ACCEPTED_CELLS.length + REJECTED_CELLS.length).toBe(
      MESSAGE_NAMES.length * SENDER_NAMES.length,
    );
  });
});

describe("failure acks", () => {
  it.each([
    [
      "capture",
      CAPTURE,
      sender.contentTab,
      "handleCapture",
      { ok: false, reason: "queue-unavailable" },
    ],
    [
      "capture-eligibility",
      ELIGIBILITY,
      sender.contentTab,
      "judgeEligibility",
      { eligible: true, skipPasswordForms: true },
    ],
    [
      "read-policy",
      { type: "read-policy" },
      sender.options,
      "readPolicy",
      { policy: null, fetchedAt: null },
    ],
  ] as const)(
    "%s answers its fixed fallback when the dep rejects",
    async (_name, message, from, dep, fallback) => {
      const deps = makeDeps();
      deps[dep].mockRejectedValue(new Error("worker storage is gone"));
      const { kept, response } = route(message, from, deps);
      expect(kept).toBe(true);
      // The fallback never carries the error text: content scripts and pages
      // must not learn why the worker failed.
      await expect(response).resolves.toEqual(fallback);
    },
  );

  const GENERIC_FAILURES: readonly [string, unknown, (typeof sender)[SenderName], DepName][] = [
    ["set-pause", SET_PAUSE, sender.popup, "handlePause"],
    ["resume", { type: "resume" }, sender.popup, "handlePause"],
    ["dismiss-diagnostics", { type: "dismiss-diagnostics" }, sender.popup, "dismissDiagnostics"],
    ["check-now", { type: "check-now" }, sender.options, "checkNow"],
    ["add-excluded-domain", ADD_DOMAIN, sender.popup, "mutateExclusions"],
    ["remove-excluded-domain", REMOVE_DOMAIN, sender.options, "mutateExclusions"],
    ["pair-browser", PAIR, sender.options, "changePairing"],
    ["unpair", { type: "unpair" }, sender.options, "changePairing"],
    ["revoke-capture-access", { type: "revoke-capture-access" }, sender.options, "changePairing"],
    ["set-profile-label", SET_LABEL, sender.options, "changePairing"],
  ];

  it.each(GENERIC_FAILURES)(
    "%s relays an Error's message as the reason",
    async (_n, message, from, dep) => {
      const deps = makeDeps();
      deps[dep].mockRejectedValue(new Error("gateway unreachable"));
      const { response } = route(message, from, deps);
      await expect(response).resolves.toEqual({ ok: false, reason: "gateway unreachable" });
    },
  );

  it("stringifies a non-Error rejection", async () => {
    const deps = makeDeps();
    deps.changePairing.mockRejectedValue("pairing code expired");
    const { response } = route({ type: "unpair" }, sender.options, deps);
    await expect(response).resolves.toEqual({ ok: false, reason: "pairing code expired" });
  });
});

describe("capture drain kick", () => {
  it("drains once after a capture the queue accepted", async () => {
    const { response, deps } = route(CAPTURE, sender.contentTab);
    await response;
    expect(deps.drain).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["refused by the queue", { ok: true, accepted: false }],
    ["unavailable queue", { ok: false, reason: "queue-unavailable" }],
  ] as const)("does not drain after a capture %s", async (_label, ack) => {
    const deps = makeDeps();
    deps.handleCapture.mockResolvedValue(ack);
    const { response } = route(CAPTURE, sender.contentTab, deps);
    await expect(response).resolves.toEqual(ack);
    expect(deps.drain).not.toHaveBeenCalled();
  });

  it("swallows a rejected drain so the ack still reaches the page", async () => {
    // Vitest fails the run on an unhandled rejection, so this test also proves
    // the detached drain promise is caught rather than left dangling.
    const deps = makeDeps();
    deps.drain.mockRejectedValue(new Error("drain crashed"));
    const { response } = route(CAPTURE, sender.contentTab, deps);
    await expect(response).resolves.toEqual({ ok: true, accepted: true });
    await flush();
    expect(deps.drain).toHaveBeenCalledTimes(1);
  });
});

describe("pairing ack shape", () => {
  it.each([
    ["undefined", undefined, { ok: true }],
    ["an empty result", {}, { ok: true }],
    ["an empty warning", { warning: "" }, { ok: true }],
    [
      "a warning",
      { warning: "profile name not saved" },
      { ok: true, warning: "profile name not saved" },
    ],
  ] as const)("changePairing resolving %s acks %o", async (_label, result, ack) => {
    const deps = makeDeps();
    deps.changePairing.mockResolvedValue(result);
    const { response } = route({ type: "unpair" }, sender.options, deps);
    await expect(response).resolves.toStrictEqual(ack);
  });
});

/** Boundary strings: exactly at a limit must pass, one past it must fail. */
const URL_AT_LIMIT = `https://news.example.com/${"a".repeat(MAX_CAPTURE_URL_CHARS - "https://news.example.com/".length)}`;
const DOMAIN_AT_LIMIT = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
const HANDOFF_KEY_AT_LIMIT = `${CAPTURE_PENDING_PREFIX}${"k".repeat(256 - CAPTURE_PENDING_PREFIX.length)}`;

describe("malformed payloads are refused before any dep runs", () => {
  describe("capture (from a content tab)", () => {
    it.each([
      ["an http: page", validCapture({ normalizedUrl: "http://news.example.com/story" })],
      [
        "credentials in the URL",
        validCapture({ normalizedUrl: "https://maya:secret@news.example.com/" }),
      ],
      ["an unparseable URL", validCapture({ normalizedUrl: "not a url" })],
      ["a URL past the limit", validCapture({ normalizedUrl: `${URL_AT_LIMIT}a` })],
      ["an uppercase content hash", validCapture({ contentHash: "A".repeat(64) })],
      ["a 63-char content hash", validCapture({ contentHash: "a".repeat(63) })],
      ["a title past the limit", validCapture({ title: "t".repeat(MAX_CAPTURE_TITLE_CHARS + 1) })],
      ["text past 250 000 chars", validCapture({ text: "x".repeat(250_001) })],
      ["a negative dwell", validCapture({ dwellMs: -1 })],
      ["a NaN dwell", validCapture({ dwellMs: Number.NaN })],
      ["an unparseable visitedAt", validCapture({ visitedAt: "yesterday" })],
      ["a numeric visitedAt", validCapture({ visitedAt: 1_700_000_000_000 as unknown as string })],
      ["an unknown kind", validCapture({ kind: "bookmark" as CaptureEmission["kind"] })],
      [
        "a non-boolean contentChanged",
        validCapture({ contentChanged: "yes" as unknown as boolean }),
      ],
      [
        "no emission",
        { type: "capture", handoffKey: `${CAPTURE_PENDING_PREFIX}x`, pairingId: TEST_PAIRING_ID },
      ],
      ["no handoffKey", validCapture({}, { handoffKey: undefined })],
      ["a handoffKey outside the pending prefix", validCapture({}, { handoffKey: "pending.1" })],
      ["a handoffKey past 256 chars", validCapture({}, { handoffKey: `${HANDOFF_KEY_AT_LIMIT}k` })],
      ["a non-hex pairingId", validCapture({}, { pairingId: "z".repeat(64) })],
      ["no pairingId", validCapture({}, { pairingId: undefined })],
    ])("refuses %s", async (_label, message) => {
      await expectRefused(message, sender.contentTab);
    });

    it.each([
      ["a URL exactly at the limit", validCapture({ normalizedUrl: URL_AT_LIMIT })],
      [
        "a title exactly at the limit",
        validCapture({ title: "t".repeat(MAX_CAPTURE_TITLE_CHARS) }),
      ],
      ["text of exactly 250 000 chars", validCapture({ text: "x".repeat(250_000) })],
      ["a zero dwell", validCapture({ dwellMs: 0 })],
      ["a re-extract", validCapture({ kind: "re-extract" })],
      ["a handoffKey of exactly 256 chars", validCapture({}, { handoffKey: HANDOFF_KEY_AT_LIMIT })],
    ])("accepts %s", (_label, message) => {
      const { kept, deps } = route(message, sender.contentTab);
      expect(kept).toBe(true);
      expect(deps.handleCapture).toHaveBeenCalledWith(message);
    });
  });

  describe("capture-eligibility (from a content tab)", () => {
    it.each([
      ["a numeric url", eligibility(42)],
      ["no url", { type: "capture-eligibility" }],
      ["a url past the limit", eligibility(`${URL_AT_LIMIT}a`)],
    ])("refuses %s", async (_label, message) => {
      await expectRefused(message, sender.contentTab);
    });

    it("accepts a url exactly at the limit", () => {
      const { kept, deps } = route(eligibility(URL_AT_LIMIT), sender.contentTab);
      expect(kept).toBe(true);
      expect(deps.judgeEligibility).toHaveBeenCalledWith(URL_AT_LIMIT);
    });
  });

  describe("set-pause (from the popup)", () => {
    it.each([
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["-Infinity", Number.NEGATIVE_INFINITY],
      ["a string", "tomorrow"],
      ["undefined", undefined],
    ])("refuses until = %s", async (_label, until) => {
      await expectRefused({ type: "set-pause", until }, sender.popup);
    });

    it("refuses a missing until", async () => {
      await expectRefused({ type: "set-pause" }, sender.popup);
    });

    it.each([
      ["null (indefinite)", null],
      ["zero", 0],
    ])("accepts until = %s", (_label, until) => {
      const message = { type: "set-pause", until };
      const { kept, deps } = route(message, sender.popup);
      expect(kept).toBe(true);
      expect(deps.handlePause).toHaveBeenCalledWith(message);
    });
  });

  describe("add-excluded-domain (from the popup)", () => {
    it.each([
      ["a numeric input", { type: "add-excluded-domain", input: 42 }],
      ["no input", { type: "add-excluded-domain", purge: true }],
      ["an input past 8192 chars", { type: "add-excluded-domain", input: "a".repeat(8_193) }],
      ["a string purge", { type: "add-excluded-domain", input: "news.example.com", purge: "yes" }],
      ["a numeric purge", { type: "add-excluded-domain", input: "news.example.com", purge: 1 }],
      ["a null purge", { type: "add-excluded-domain", input: "news.example.com", purge: null }],
    ])("refuses %s", async (_label, message) => {
      await expectRefused(message, sender.popup);
    });

    it.each([
      ["no purge flag", { type: "add-excluded-domain", input: "news.example.com" }],
      ["purge false", { type: "add-excluded-domain", input: "news.example.com", purge: false }],
      // The input is raw user text; normalization is the dep's job, so a
      // not-yet-normalized but bounded string passes through untouched.
      ["an input of exactly 8192 chars", { type: "add-excluded-domain", input: "a".repeat(8_192) }],
    ])("accepts %s", (_label, message) => {
      const { kept, deps } = route(message, sender.popup);
      expect(kept).toBe(true);
      expect(deps.mutateExclusions).toHaveBeenCalledWith(message);
    });
  });

  describe("remove-excluded-domain (from the options page)", () => {
    it.each([
      ["mixed case", "News.Example.com"],
      ["a trailing dot", "news.example.com."],
      ["a path", "news.example.com/path"],
      ["a scheme", "https://news.example.com"],
      ["surrounding whitespace", " news.example.com"],
      ["a single label", "localhost"],
      ["a domain past the limit", `${DOMAIN_AT_LIMIT}d`],
    ])(
      "refuses %s (only an already-normalized domain names a stored exclusion)",
      async (_l, domain) => {
        await expectRefused({ type: "remove-excluded-domain", domain }, sender.options);
      },
    );

    it("refuses an empty domain", async () => {
      await expectRefused({ type: "remove-excluded-domain", domain: "" }, sender.options);
    });

    it("refuses a non-string domain", async () => {
      await expectRefused({ type: "remove-excluded-domain", domain: 42 }, sender.options);
    });

    it("accepts a normalized domain of exactly MAX_CAPTURE_DOMAIN_CHARS", () => {
      expect(DOMAIN_AT_LIMIT).toHaveLength(MAX_CAPTURE_DOMAIN_CHARS);
      const message = { type: "remove-excluded-domain", domain: DOMAIN_AT_LIMIT };
      const { kept, deps } = route(message, sender.options);
      expect(kept).toBe(true);
      expect(deps.mutateExclusions).toHaveBeenCalledWith(message);
    });
  });

  describe("pair-browser (from the options page)", () => {
    it.each([
      ["a gatewayUrl past 2048 chars", { gatewayUrl: `https://${"g".repeat(2_041)}` }],
      ["a trailing slash", { gatewayUrl: "https://gateway.example.com/" }],
      ["http://", { gatewayUrl: "http://gateway.example.com" }],
      ["an IPv4 literal", { gatewayUrl: "https://203.0.113.10:7600" }],
      ["an IPv6 literal", { gatewayUrl: "https://[2001:db8::1]:7600" }],
      ["a path", { gatewayUrl: "https://gateway.example.com/api" }],
      ["an uppercase host", { gatewayUrl: "https://GATEWAY.example.com" }],
      ["surrounding whitespace", { gatewayUrl: " https://gateway.example.com" }],
      ["not a URL", { gatewayUrl: "gateway" }],
      ["a numeric gatewayUrl", { gatewayUrl: 7600 }],
      ["no gatewayUrl", { gatewayUrl: undefined }],
      ["an empty pairingCode", { pairingCode: "" }],
      ["a pairingCode past 256 chars", { pairingCode: "c".repeat(257) }],
      ["a numeric pairingCode", { pairingCode: 1234 }],
      ["no pairingCode", { pairingCode: undefined }],
      ["an empty profileLabel", { profileLabel: "" }],
      ["a whitespace profileLabel", { profileLabel: "   " }],
      ["a profileLabel past 120 chars", { profileLabel: "p".repeat(121) }],
      ["a numeric profileLabel", { profileLabel: 42 }],
    ])(
      "refuses %s (the options page sends the canonical form or nothing)",
      async (_l, overrides) => {
        await expectRefused(pairBrowser(overrides), sender.options);
      },
    );

    it.each([
      ["no profileLabel", { profileLabel: undefined }],
      ["a profileLabel of exactly 120 chars", { profileLabel: "p".repeat(120) }],
      ["a one-char pairingCode", { pairingCode: "x" }],
      ["a pairingCode of exactly 256 chars", { pairingCode: "c".repeat(256) }],
      ["a bare origin without a port", { gatewayUrl: "https://gateway.example.com" }],
    ])("accepts %s", (_label, overrides) => {
      const message = pairBrowser(overrides);
      const { kept, deps } = route(message, sender.options);
      expect(kept).toBe(true);
      expect(deps.changePairing).toHaveBeenCalledWith(message);
    });
  });

  describe("set-profile-label (from the options page)", () => {
    it.each([
      ["an empty label", ""],
      ["a whitespace label", "   "],
      ["a label past 120 chars", "p".repeat(121)],
      ["a numeric label", 42],
      ["no label", undefined],
    ])("refuses %s", async (_label, profileLabel) => {
      await expectRefused({ type: "set-profile-label", profileLabel }, sender.options);
    });

    it("accepts a label of exactly 120 chars", () => {
      const message = { type: "set-profile-label", profileLabel: "p".repeat(120) };
      const { kept, deps } = route(message, sender.options);
      expect(kept).toBe(true);
      expect(deps.changePairing).toHaveBeenCalledWith(message);
    });
  });
});
