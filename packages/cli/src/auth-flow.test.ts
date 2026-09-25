// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit coverage for `runAuthFlowDetailed`'s code-paste channel:
 *
 *   - the paste prompt is armed only for descriptors with
 *     `acceptsAuthCode` (a pasted code for any other provider is
 *     buffered unread by the auth subprocess and strands the flow);
 *   - a network-level failure of the code POST is rendered as an error
 *     line + re-armed prompt, never an unhandled rejection (the paste
 *     handler runs fire-and-forget, so an uncaught rejection would kill
 *     the whole CLI process);
 *   - the re-auth `accountId` rides on the `POST /admin/auth-flows` body.
 *
 * The gateway is mocked at the `gatewayJson` / `gatewayFetch` seam and
 * the SSE stream is a hand-driven web ReadableStream; `node:readline`
 * is mocked so the prompt arming is observable without a real TTY.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

const rlHolder = vi.hoisted(() => ({
  callbacks: [] as Array<(answer: string) => void>,
  createCount: 0,
}));

const utilsMocks = vi.hoisted(() => ({
  gatewayFetch: vi.fn(),
  gatewayJson: vi.fn(),
}));

const promptMocks = vi.hoisted(() => ({
  text: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
  isCancel: vi.fn(() => false),
}));
const qrMock = vi.hoisted(() => vi.fn());
vi.mock("@clack/prompts", () => promptMocks);
vi.mock("qrcode-terminal", () => ({ default: { generate: qrMock } }));

vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => {
    rlHolder.createCount++;
    return {
      question: (_prompt: string, cb: (answer: string) => void) => {
        rlHolder.callbacks.push(cb);
      },
      close: () => {},
    };
  }),
}));

vi.mock("./utils.js", () => ({
  c: new Proxy({}, { get: () => "" }) as Record<string, string>,
  gatewayFetch: utilsMocks.gatewayFetch,
  gatewayJson: utilsMocks.gatewayJson,
  buildCliFx: async () => ({}),
  linkify: (text: string) => text,
  withSpinner: async (_label: string, fn: (spin: { message: (m: string) => void }) => unknown) =>
    fn({ message: () => {} }),
}));

import { describeWait, runAuthFlowDetailed } from "./auth-flow.js";

/** Hand-driven SSE channel masquerading as the events fetch Response. */
function sseChannel(): {
  response: Response;
  push: (event: string, data: unknown) => void;
  close: () => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const enc = new TextEncoder();
  return {
    response: { ok: true, status: 200, body: stream } as unknown as Response,
    push: (event, data) =>
      controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
    close: () => controller.close(),
  };
}

async function waitFor(predicate: () => boolean, maxTicks = 500): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
  if (!predicate()) throw new Error("waitFor: predicate never became true");
}

const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  rlHolder.callbacks.length = 0;
  rlHolder.createCount = 0;
  utilsMocks.gatewayFetch.mockReset();
  utilsMocks.gatewayJson.mockReset();
  for (const mock of [promptMocks.text, promptMocks.password, promptMocks.select, qrMock])
    mock.mockReset();
  // The paste prompt only arms on a TTY.
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (ttyDescriptor) Object.defineProperty(process.stdin, "isTTY", ttyDescriptor);
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("runAuthFlowDetailed — paste prompt gating + code delivery", () => {
  test("paste prompt is NOT armed on a url event when the descriptor lacks acceptsAuthCode", async () => {
    const sse = sseChannel();
    utilsMocks.gatewayJson.mockResolvedValue({ flowId: "flow-1" });
    utilsMocks.gatewayFetch.mockResolvedValue(sse.response);

    const run = runAuthFlowDetailed({ deviceId: "dev-1" }, "listener-source", {});
    sse.push("auth", { type: "url", url: "https://auth.example.com/consent" });
    // Let the url handler run a few ticks — the prompt must stay down.
    await waitFor(() =>
      logSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes("Open this URL")),
    );
    expect(rlHolder.createCount).toBe(0);

    sse.push("auth", { type: "complete", ok: true, accountId: "maya@example.com" });
    sse.close();
    await expect(run).resolves.toEqual({ accountId: "maya@example.com" });
    expect(rlHolder.createCount).toBe(0);
  });

  test("network failure of the code POST prints an error and re-arms the prompt (no unhandled rejection)", async () => {
    const sse = sseChannel();
    utilsMocks.gatewayJson.mockResolvedValue({ flowId: "flow-2" });
    utilsMocks.gatewayFetch.mockImplementation((path: string) => {
      if (path.includes("/events")) return Promise.resolve(sse.response);
      // The code POST hits a gateway restart / transient network blip.
      return Promise.reject(new Error("socket hang up"));
    });

    const run = runAuthFlowDetailed(
      { deviceId: "dev-1" },
      "code-channel-source",
      {},
      {
        acceptsAuthCode: true,
      },
    );
    sse.push("auth", { type: "url", url: "https://auth.example.com/consent" });
    await waitFor(() => rlHolder.createCount === 1);

    // User pastes a code; the POST rejects at the network level.
    rlHolder.callbacks[0]("abc123");
    await waitFor(() => rlHolder.createCount === 2); // prompt re-armed
    expect(
      errorSpy.mock.calls.some((call: unknown[]) =>
        String(call[0]).includes("Code delivery failed"),
      ),
    ).toBe(true);
    expect(
      errorSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes("socket hang up")),
    ).toBe(true);

    // The flow still completes via SSE afterwards.
    sse.push("auth", { type: "complete", ok: true, accountId: "maya@example.com" });
    sse.close();
    await expect(run).resolves.toEqual({ accountId: "maya@example.com" });
  });

  test("a successful paste POST reports delivery and leaves completion to the SSE stream", async () => {
    const sse = sseChannel();
    const postCalls: Array<{ path: string; body: unknown }> = [];
    utilsMocks.gatewayJson.mockResolvedValue({ flowId: "flow-3" });
    utilsMocks.gatewayFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path.includes("/events")) return Promise.resolve(sse.response);
      postCalls.push({ path, body: JSON.parse(String(init?.body)) });
      return Promise.resolve({ ok: true, status: 200 } as unknown as Response);
    });

    const run = runAuthFlowDetailed(
      { deviceId: "dev-1" },
      "code-channel-source",
      {},
      {
        acceptsAuthCode: true,
      },
    );
    sse.push("auth", { type: "url", url: "https://auth.example.com/consent" });
    await waitFor(() => rlHolder.createCount === 1);
    rlHolder.callbacks[0]("https://gateway.example.com/oauth/callback?state=flow-3&code=xyz%40789");
    await waitFor(() => postCalls.length === 1);

    expect(postCalls[0].path).toBe("/admin/auth-flows/flow-3/code");
    expect(postCalls[0].body).toEqual({ code: "xyz@789" }); // percent-decoded
    expect(rlHolder.createCount).toBe(1); // not re-armed — waiting on SSE

    sse.push("auth", { type: "complete", ok: true, accountId: "maya@example.com" });
    sse.close();
    await expect(run).resolves.toEqual({ accountId: "maya@example.com" });
  });

  test("re-auth accountId rides on the POST /admin/auth-flows body", async () => {
    const sse = sseChannel();
    utilsMocks.gatewayJson.mockResolvedValue({ flowId: "flow-4" });
    utilsMocks.gatewayFetch.mockResolvedValue(sse.response);

    const run = runAuthFlowDetailed(
      { deviceId: "dev-1" },
      "code-channel-source",
      {},
      {
        accountId: "maya@example.com",
      },
    );
    sse.push("auth", { type: "complete", ok: true, accountId: "maya@example.com" });
    sse.close();
    await run;

    expect(utilsMocks.gatewayJson).toHaveBeenCalledWith(
      "/admin/auth-flows",
      expect.objectContaining({ method: "POST" }),
    );
    const init = utilsMocks.gatewayJson.mock.calls[0][1] as { body: string };
    expect(JSON.parse(init.body)).toEqual({
      deviceId: "dev-1",
      sourceType: "code-channel-source",
      accountId: "maya@example.com",
      // Declared on every start: a provider needing something a terminal
      // cannot draw is refused with a sentence instead of emitting it and
      // waiting out the timeout. A widget is the kind that is absent.
      renders: ["redirect", "code", "qr", "fields", "wait"],
    });
  });

  test("says what a terminal can draw, and a hosted widget is not on the list", async () => {
    const sse = sseChannel();
    utilsMocks.gatewayJson.mockResolvedValue({ flowId: "flow-5" });
    utilsMocks.gatewayFetch.mockResolvedValue(sse.response);

    const run = runAuthFlowDetailed({ deviceId: "dev-1" }, "code-channel-source", {}, {});
    sse.push("auth", { type: "complete", ok: true, accountId: "someone" });
    sse.close();
    await run;

    const init = utilsMocks.gatewayJson.mock.calls[0][1] as { body: string };
    // A hosted widget is a page a client loads and renders; a terminal has no
    // equivalent. Saying so is what lets the provider refuse in a sentence
    // rather than emitting one and waiting out its timeout.
    expect(JSON.parse(init.body).renders).not.toContain("widget");
  });
});

describe("typed challenge rendering through the live event loop", () => {
  test("a new shown challenge invalidates the previous paste prompt even for legacy-code-capable providers", async () => {
    const sse = sseChannel();
    utilsMocks.gatewayJson.mockResolvedValue({ flowId: "flow-steps" });
    utilsMocks.gatewayFetch.mockImplementation((path: string) =>
      Promise.resolve(path.endsWith("/events") ? sse.response : { ok: true }),
    );
    const run = runAuthFlowDetailed(
      { deviceId: "dev-1" },
      "fixture",
      {},
      { acceptsAuthCode: true },
    );
    sse.push("auth", {
      type: "challenge",
      id: "redirect",
      expectsAnswer: true,
      challenge: {
        kind: "redirect",
        title: "Connect",
        url: "https://example.com/connect",
        via: "elsewhere",
      },
    });
    await waitFor(() => rlHolder.createCount === 1);
    sse.push("auth", {
      type: "challenge",
      id: "wait",
      expectsAnswer: false,
      challenge: { kind: "wait", title: "Approval in progress" },
    });
    await waitFor(() =>
      logSpy.mock.calls.some(([line]: unknown[]) => String(line).includes("Approval in progress")),
    );
    rlHolder.callbacks[0]("stale-answer");
    sse.push("auth", { type: "complete", ok: true, accountId: "owner@example.com" });
    sse.close();
    await run;
    expect(utilsMocks.gatewayFetch.mock.calls.filter(([path]) => path.endsWith("/code"))).toEqual(
      [],
    );
    expect(rlHolder.createCount).toBe(1);
  });
  async function render(
    challenge: Record<string, unknown>,
    expectsAnswer = true,
    echoes: Record<string, unknown>[] = [],
  ) {
    const sse = sseChannel();
    utilsMocks.gatewayJson.mockResolvedValue({ flowId: "flow/typed" });
    utilsMocks.gatewayFetch.mockImplementation((path: string) =>
      Promise.resolve(path.endsWith("/events") ? sse.response : { ok: true }),
    );
    const run = runAuthFlowDetailed({ deviceId: "dev-1" }, "fixture", {});
    sse.push("auth", { type: "challenge", id: "question-1", challenge, expectsAnswer });
    for (const echo of echoes) sse.push("auth", echo);
    sse.push("auth", { type: "complete", ok: true, accountId: "owner@example.com" });
    sse.close();
    await expect(run).resolves.toEqual({ accountId: "owner@example.com" });
  }

  test("an asked code posts its challenge identity, not the legacy paste channel", async () => {
    promptMocks.text.mockResolvedValue(" 123456 ");
    await render({ kind: "code", title: "Enter verification code" });
    expect(utilsMocks.gatewayFetch).toHaveBeenCalledWith(
      "/admin/auth-flows/flow%2Ftyped/answer",
      expect.objectContaining({
        body: JSON.stringify({ challengeId: "question-1", answer: { code: "123456" } }),
      }),
    );
    expect(rlHolder.createCount).toBe(0);
  });

  test("fields choose password and select prompts without echoing the secret", async () => {
    promptMocks.password.mockResolvedValue("fictional-private-token");
    promptMocks.select.mockResolvedValue("read");
    await render({
      kind: "fields",
      title: "Connect",
      fields: [
        { name: "token", label: "Token", type: "secret" },
        { name: "mode", label: "Mode", options: [{ value: "read", label: "Read only" }] },
      ],
    });
    expect(promptMocks.password).toHaveBeenCalledWith({ message: "Token" });
    expect(promptMocks.select).toHaveBeenCalledWith({
      message: "Mode",
      options: [{ value: "read", label: "Read only" }],
    });
    expect(utilsMocks.gatewayFetch).toHaveBeenCalledWith(
      "/admin/auth-flows/flow%2Ftyped/answer",
      expect.objectContaining({
        body: JSON.stringify({
          challengeId: "question-1",
          answer: { token: "fictional-private-token", mode: "read" },
        }),
      }),
    );
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain("fictional-private-token");
  });

  test.each(["code", "fields", "wait"])("a shown %s is not a question", async (kind) => {
    await render(
      { kind, title: "Connection information", fields: [{ name: "token", type: "secret" }] },
      false,
    );
    expect(promptMocks.text).not.toHaveBeenCalled();
    expect(promptMocks.password).not.toHaveBeenCalled();
    expect(utilsMocks.gatewayFetch.mock.calls.filter(([path]) => path.endsWith("/answer"))).toEqual(
      [],
    );
  });

  test("typed QR suppresses its legacy duplicate", async () => {
    await render({ kind: "qr", title: "Scan", data: "fixture-pairing" }, false, [
      { type: "qr", data: "fixture-pairing" },
    ]);
    expect(qrMock).toHaveBeenCalledTimes(1);
  });

  test("typed redirect suppresses its legacy duplicate and does not ask when shown", async () => {
    await render(
      {
        kind: "redirect",
        title: "Open connection",
        url: "https://example.com/connect",
        via: "elsewhere",
      },
      false,
      [{ type: "url", url: "https://example.com/connect" }],
    );
    expect(
      logSpy.mock.calls.filter(([line]: unknown[]) =>
        String(line).includes("https://example.com/connect"),
      ),
    ).toHaveLength(1);
    expect(rlHolder.createCount).toBe(0);
  });
});

describe("a failed flow says why", () => {
  // A rejected password or an unreachable server has nothing for a wizard to
  // recover; its message is the only explanation the operator gets.
  async function fail(event: "complete" | "error", payload: Record<string, unknown>) {
    const sse = sseChannel();
    utilsMocks.gatewayJson.mockResolvedValue({ flowId: "flow-failed" });
    utilsMocks.gatewayFetch.mockResolvedValue(sse.response);
    const run = runAuthFlowDetailed({ deviceId: "dev-1" }, "imap", {});
    sse.push(
      "auth",
      event === "complete"
        ? { type: "complete", ok: false, ...payload }
        : { type: "error", ...payload },
    );
    sse.close();
    const result = await run;
    const printed = errorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    return { result, printed };
  }

  test.each(["complete", "error"] as const)(
    "a typed failure prints its message and its remedy (%s event)",
    async (event) => {
      const { result, printed } = await fail(event, {
        code: "credential-rejected",
        error: "IMAP credentials were rejected",
        remedy: { summary: "Paste a current app password" },
      });
      expect(printed).toContain("IMAP credentials were rejected");
      expect(result).toEqual({ errorMessage: "IMAP credentials were rejected" });
    },
  );

  test("a typed failure without a remedy still prints its message", async () => {
    const { printed } = await fail("complete", {
      code: "unavailable",
      error: "IMAP server is unreachable",
    });
    expect(printed).toContain("IMAP server is unreachable");
  });

  test("a missing application credential is left to the setup wizard", async () => {
    const { result, printed } = await fail("complete", {
      code: "missing-credentials",
      error: "Google credentials are not set up",
      fileKey: "google",
      providerName: "Google",
    });
    expect(printed).not.toContain("Google credentials are not set up");
    expect(result).toMatchObject({
      missingCredentials: { fileKey: "google", providerName: "Google" },
    });
  });
});

describe("a wait an operator can act on", () => {
  test("rounds, because what it answers is whether to stay or come back", () => {
    expect(describeWait(30_000)).toBe("a minute");
    expect(describeWait(60_000)).toBe("a minute");
    expect(describeWait(9 * 60_000)).toBe("about 9 minutes");
    expect(describeWait(60 * 60_000)).toBe("about an hour");
    expect(describeWait(6 * 60 * 60_000)).toBe("about 6 hours");
  });
});
