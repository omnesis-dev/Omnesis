// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The session a provider is handed, driven directly.
 *
 * Everything here was previously covered only at the ends of the path — a
 * scripted session on the provider side, a hand-written event on the client
 * side — and this is the middle, which is where the faults were both times a
 * review found any. Each test drives the real factory against a scripted
 * receiver and reads the protocol lines it puts on the wire.
 */

import { describe, expect, test } from "vitest";
import {
  AUTH_CHALLENGE_KINDS,
  AuthFailure,
  config as c,
  type AuthChallenge,
} from "@omnesis/source-sdk";

import { makeSession, type SessionInputs } from "./auth-subprocess-session.js";
import { AnswerUnavailable, type StdinReceiver } from "./auth-subprocess-stdin.js";
import { parseAuthSubprocessEvent, type AuthSubprocessEvent } from "./auth-subprocess-protocol.js";

const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLog,
};

function build(overrides: Partial<SessionInputs> = {}) {
  const emitted: AuthSubprocessEvent[] = [];
  const secretValues: string[] = [];
  const receiver: StdinReceiver = {
    flowId: () => Promise.resolve("flow-1"),
    accountId: () => Promise.resolve(undefined),
    credentials: () => Promise.resolve(undefined),
    publicBaseUrl: () => Promise.resolve(undefined),
    renders: () => Promise.resolve(undefined),
    receiveCode: () => Promise.resolve("the-code"),
    receiveWidgetResult: () => Promise.resolve({ token: "the-token" }),
    // A `code` challenge is answered through this channel, so the default has
    // to satisfy the shape that kind fixes.
    receiveAnswer: () => Promise.resolve({ code: "the-code" }),
    ...(overrides.receiver ?? {}),
  } as StdinReceiver;
  const session = makeSession({
    flowId: "flow-1",
    configDir: "/config",
    providerDir: "example",
    supplied: {},
    declaredRenders: AUTH_CHALLENGE_KINDS,
    secretValues,
    receiver,
    emit: (event) => void emitted.push(event),
    log: silentLog,
    ...overrides,
    // `receiver` is spread above so a caller can override one method; keep the
    // assembled one rather than the partial.
    ...(overrides.receiver ? { receiver } : {}),
  });
  return { session, emitted, secretValues, receiver };
}

const qr: AuthChallenge = { kind: "qr", title: "Scan this", data: "payload" };
const code: AuthChallenge = { kind: "code", title: "Paste the code" };

describe("what reaches the wire", () => {
  test.each(["loopback", "gateway", "elsewhere"] as const)(
    "a shown %s redirect survives the subprocess parser",
    (via) => {
      const { session, emitted } = build();
      session.show({ kind: "redirect", via, title: "Connect", url: "https://example.org/connect" });
      expect(parseAuthSubprocessEvent(JSON.parse(JSON.stringify(emitted[0])))).toEqual(emitted[0]);
    },
  );
  test("a shown challenge says no answer is wanted; an asked one says it is", async () => {
    const { session, emitted } = build();
    session.show(qr);
    await session.ask(code);

    const challenges = emitted.filter((e) => e.type === "challenge");
    expect(challenges.map((e) => (e as { expectsAnswer: boolean }).expectsAnswer)).toEqual([
      false,
      true,
    ]);
  });

  test("every challenge gets its own id, so a late answer resolves the wait it belongs to", () => {
    const { session, emitted } = build();
    session.show(qr);
    session.show(qr);
    const ids = emitted.filter((e) => e.type === "challenge").map((e) => (e as { id: string }).id);
    expect(new Set(ids).size).toBe(2);
  });

  test("a shown redirect is echoed in the older shape, for a gateway one version behind", () => {
    const { session, emitted } = build();
    session.show({
      kind: "redirect",
      via: "loopback",
      title: "Sign in",
      url: "https://example.org/a",
    });
    expect(emitted.map((e) => e.type)).toEqual(["challenge", "url"]);
  });

  test("an asked redirect is echoed too — that gateway's code route answers the same wait", async () => {
    const { session, emitted } = build();
    await session.ask({
      kind: "redirect",
      via: "gateway",
      title: "Sign in",
      url: "https://example.org/a",
    });
    expect(emitted.map((e) => e.type)).toEqual(["challenge", "url"]);
  });
});

describe("what the client can draw", () => {
  test("a client that said nothing has only legacy renderers", () => {
    const { session } = build({ declaredRenders: undefined });
    expect(session.canShow("qr")).toBe(true);
    expect(session.canShow("fields")).toBe(false);
    expect(session.canShow("widget")).toBe(false);
  });

  test("a client that said so draws exactly what it named", () => {
    const { session } = build({ declaredRenders: ["code", "widget"] });
    expect(session.canShow("widget")).toBe(true);
    expect(session.canShow("qr")).toBe(false);
  });

  test("an explicitly empty list advertises no renderers", () => {
    const { session } = build({ declaredRenders: [] });
    expect(session.canShow("code")).toBe(false);
    expect(session.canShow("widget")).toBe(false);
  });

  test.each([undefined, [], ["redirect"]])(
    "unsupported questions fail before emission or waiting (%j)",
    async (declaredRenders) => {
      const { session, emitted } = build({ declaredRenders });
      await expect(
        session.ask({
          kind: "fields",
          title: "Connect",
          schema: c.object({ token: c.secret({ label: "Token" }) }),
        }),
      ).rejects.toMatchObject({ code: "unsupported" });
      expect(emitted).toEqual([]);
    },
  );

  test("show also refuses an explicitly unsupported renderer", () => {
    const { session, emitted } = build({ declaredRenders: ["code"] });
    expect(() => session.show(qr)).toThrow(AuthFailure);
    expect(emitted).toEqual([]);
  });
});

describe("an answer that does not fit", () => {
  test("is asked again, with what was wrong, and gives up after three", async () => {
    const receiver = {
      receiveAnswer: () => Promise.resolve({ token: "" }),
    } as unknown as StdinReceiver;
    const { session, emitted } = build({ receiver });

    await expect(
      session.ask({
        kind: "fields",
        title: "Connect",
        schema: c.object({ token: c.secret({ label: "Token", required: true }) }),
      }),
    ).rejects.toMatchObject({ code: "credential-rejected" });

    const challenges = emitted.filter((e) => e.type === "challenge");
    // Three attempts, not one: a mistyped character in a token used to cost the
    // operator the whole flow. Bounded, because a client sending the same
    // rejected answer forever is a client, not an operator.
    expect(challenges).toHaveLength(3);
    for (const later of challenges.slice(1)) {
      const c2 = (later as { challenge: { instructions?: string } }).challenge;
      expect(c2.instructions ?? "").not.toBe("");
    }
  });

  test("a secret that fits is added to the redaction set before the provider sees it", async () => {
    const receiver = {
      receiveAnswer: () => Promise.resolve({ token: "tok_9f3a2b7c" }),
    } as unknown as StdinReceiver;
    const { session, secretValues } = build({ receiver });

    await session.ask({
      kind: "fields",
      title: "Connect",
      schema: c.object({ token: c.secret({ label: "Token", required: true }) }),
    });

    // A provider that echoes its input into an error message would otherwise
    // put the token on a record the admin listing hands to every caller.
    expect(secretValues).toContain("tok_9f3a2b7c");
  });
});

describe("a wait that ends without an answer", () => {
  test.each([
    ["timed-out", "timeout"],
    ["denied", "denied"],
    ["cancelled", "cancelled"],
    ["closed", "cancelled"],
  ] as const)("%s becomes %s", async (reason, expected) => {
    const receiver = {
      receiveCode: () => Promise.reject(new AnswerUnavailable(reason, "over")),
    } as unknown as StdinReceiver;
    const { session } = build({ receiver });

    await expect(
      session.ask({
        kind: "redirect",
        via: "gateway",
        title: "Sign in",
        url: "https://example.org/a",
      }),
    ).rejects.toMatchObject({ name: "AuthFailure", code: expected });
  });
});

describe("what a provider is told about its own run", () => {
  test("a first connection gets the provider's directory, not an account's", () => {
    const { session } = build();
    expect(session.reason).toBe("connect");
    expect(session.host.stateDir).toBe("/config/example");
  });

  test("a renewal gets the account's own directory and says which account", () => {
    const { session } = build({ reauthAccountId: "maya@example.org" });
    expect(session.reason).toBe("reauthenticate");
    expect(session.accountId).toBe("maya@example.org");
    expect(session.host.stateDir).toBe("/config/example/maya@example.org");
  });

  test("the gateway's origin is withheld when there is no flow to route a callback to", () => {
    // Its presence is what a provider checks before offering a redirect the
    // host catches, and the host routes that callback by the flow id carried as
    // `state`. Offering the origin without one produces an authorize URL the
    // gateway rejects after the operator has already consented.
    const withFlow = build({ flowId: "flow-1", publicBaseUrl: "https://gateway.example.org" });
    expect(withFlow.session.publicBaseUrl).toBe("https://gateway.example.org");

    const without = build({ flowId: "", publicBaseUrl: "https://gateway.example.org" });
    expect(without.session.publicBaseUrl).toBeUndefined();
  });
});

describe("an answer a client posted", () => {
  test("is checked against the shape the kind fixes, not trusted", async () => {
    // A client is not the only thing that can post one, and a provider reading
    // `answer.code` should not have to defend against it being blank.
    const receiver = {
      receiveAnswer: () => Promise.resolve({ code: "   " }),
    } as unknown as StdinReceiver;
    const { session } = build({ receiver });

    await expect(session.ask({ kind: "code", title: "Paste the code" })).rejects.toBeInstanceOf(
      AuthFailure,
    );
  });

  test("a widget's result keeps its metadata and drops what is not a token", async () => {
    const receiver = {
      receiveWidgetResult: () =>
        Promise.resolve({ token: "public-token", metadata: { institution: "an institution" } }),
    } as unknown as StdinReceiver;
    const { session } = build({ receiver });

    const answer = await session.ask({
      kind: "widget",
      title: "Choose your bank",
      renderer: "example-link",
      payload: {},
    });
    expect(answer).toEqual({ token: "public-token", metadata: { institution: "an institution" } });
  });
});

describe("a notice", () => {
  test("an unadvertised progress renderer does not abort a legacy OAuth exchange", () => {
    const { session, emitted } = build({ declaredRenders: undefined });
    expect(() => session.show({ kind: "wait", title: "Finishing authorization" })).not.toThrow();
    expect(emitted).toEqual([]);
  });
  test("says what is happening without becoming a question", () => {
    const { session, emitted } = build();
    session.show({ kind: "wait", title: "Exchanging the authorization" });
    const [event] = emitted;
    expect(event).toMatchObject({ type: "challenge", expectsAnswer: false });
    expect((event as { challenge: { kind: string } }).challenge.kind).toBe("wait");
  });
});
