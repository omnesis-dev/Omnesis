// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The shape of a connect flow, exercised by scripting the operator.
 *
 * The point of handing a provider a session rather than a bag of callbacks is
 * that a whole multi-step exchange becomes something a test can drive without
 * a browser, a phone or a network. These tests are that claim, checked.
 */

import { describe, expect, test } from "vitest";
import {
  AUTH_CHALLENGE_KINDS,
  AuthFailure,
  DEFAULT_CLIENT_RENDERS,
  credentialsChallenge,
  isRetryable,
  parseFieldsAnswer,
  toWireChallenge,
  type AskableChallenge,
  type AuthResult,
  type AuthSession,
  type AuthChallenge,
  type ShowableChallenge,
  type WireChallenge,
} from "./auth-session.js";
import { fakeProviderHost } from "./testing/fake-host.js";
import { config as c } from "./index.js";

/** A session that records what was shown and answers what is asked, in order. */
function scriptedSession(answers: unknown[], overrides: Partial<AuthSession> = {}) {
  const shown: ShowableChallenge[] = [];
  const asked: AskableChallenge[] = [];
  const queue = [...answers];
  const session: AuthSession = {
    reason: "connect",
    flowId: "flow-1",
    supplied: {},
    host: fakeProviderHost(),
    // A test drives a client that can draw anything; a provider refusing a
    // kind is its own test, with its own narrower session.
    canShow: () => true,
    show: (challenge) => {
      shown.push(challenge);
    },
    ask: (challenge) => {
      asked.push(challenge);
      if (queue.length === 0) throw new Error(`no scripted answer for ${challenge.kind}`);
      return Promise.resolve(queue.shift() as never);
    },
    ...overrides,
  };
  return { session, shown, asked };
}

describe("a flow that asks more than once", () => {
  // The shape the old callback bag could not express, and which one provider
  // worked around by smuggling its two questions in as source settings.
  const region = c.object({
    country: c.select({
      label: "Country",
      required: true,
      options: [
        { value: "aa", label: "Atlantis" },
        { value: "bb", label: "Borogovia" },
      ],
    }),
  });

  async function connect(session: AuthSession): Promise<AuthResult> {
    const { country } = await session.ask({
      kind: "fields",
      title: "Choose your country",
      schema: region,
    });
    const bank = c.object({
      institution: c.select({
        label: "Bank",
        required: true,
        options: [{ value: `${country}-bank`, label: `A bank in ${country}` }],
      }),
    });
    const chosen = await session.ask({ kind: "fields", title: "Choose your bank", schema: bank });
    session.show({ kind: "wait", title: "Talking to your bank" });
    const { code } = await session.ask({
      kind: "redirect",
      title: "Approve access",
      url: `https://example.com/consent?bank=${chosen.institution}`,
      via: "gateway",
    });
    return {
      accounts: [{ accountId: `${chosen.institution}:${code}`, state: { status: "connected" } }],
    };
  }

  test("the second question is built from the answer to the first", async () => {
    const { session, asked, shown } = scriptedSession([
      { country: "aa" },
      { institution: "aa-bank" },
      { code: "xyz" },
    ]);

    const result = await connect(session);

    expect(asked.map((a) => a.kind)).toEqual(["fields", "fields", "redirect"]);
    expect(asked[1]).toMatchObject({ title: "Choose your bank" });
    expect(shown.map((s) => s.kind)).toEqual(["wait"]);
    expect(result.accounts[0]?.accountId).toBe("aa-bank:xyz");
  });

  test("the flow reports the state it established, so nothing has to go and ask", async () => {
    const { session } = scriptedSession([
      { country: "bb" },
      { institution: "bb-bank" },
      { code: "abc" },
    ]);
    const result = await connect(session);
    expect(result.accounts[0]?.state).toEqual({ status: "connected" });
  });
});

describe("what crosses a wire", () => {
  test("a field challenge becomes a form, because a schema is a parser", () => {
    const wire = toWireChallenge({
      kind: "fields",
      title: "Sign in",
      instructions: "Paste a token with repo scope.",
      schema: c.object({ token: c.secret({ label: "Token", required: true }) }),
    });

    expect(wire.kind).toBe("fields");
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
    if (wire.kind !== "fields") return;
    expect(wire.fields.map((f) => f.name)).toEqual(["token"]);
    expect(wire.instructions).toBe("Paste a token with repo scope.");
    expect(wire).not.toHaveProperty("schema");
  });

  test("every other kind crosses unchanged, and survives a round trip", () => {
    // Every kind but `fields`, whose authoring form carries a parser. For
    // these two the authoring type and the wire type are the same type, which
    // is the point being asserted.
    const kinds: Array<Exclude<AuthChallenge, { kind: "fields" }>> = [
      { kind: "redirect", title: "Approve", url: "https://example.com/a", via: "gateway" },
      { kind: "code", title: "Paste the code", pattern: "^[0-9]{6}$" },
      { kind: "qr", title: "Scan this", data: "otpauth://x", expiresAt: "2026-09-07T12:00:00Z" },
      { kind: "widget", title: "Pick a bank", renderer: "example-link", payload: { t: "1" } },
      { kind: "wait", title: "Finishing up" },
    ];
    for (const challenge of kinds) {
      expect(toWireChallenge(challenge)).toEqual(challenge);
      expect(JSON.parse(JSON.stringify(challenge))).toEqual(challenge);
    }
  });

  test("a challenge carries the words that go with it", () => {
    // The reason a shared client needs no branch per source: the sentence
    // telling the operator what to do with a code travels with the code.
    const qr: WireChallenge = {
      kind: "qr",
      title: "Scan this from your phone",
      instructions: "Open the app, then Settings, then Linked devices.",
      data: "pairing-payload",
    };
    expect(qr.instructions).toContain("Linked devices");
  });
});

describe("an answer is checked where the schema lives", () => {
  const schema = c.object({
    token: c.secret({ label: "Token", required: true, minLength: 8 }),
    label: c.string({ label: "Label" }),
  });
  const challenge = { kind: "fields", title: "Sign in", schema } as const;

  test("a good answer comes back parsed", () => {
    const parsed = parseFieldsAnswer(challenge, { token: "ghp_abcdefgh" });
    expect(parsed).toEqual({ ok: true, value: { token: "ghp_abcdefgh" } });
  });

  test("a bad answer names the field", () => {
    const parsed = parseFieldsAnswer(challenge, { token: "short" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0]).toMatch(/^token: /);
  });

  test("a missing required answer is refused rather than defaulted", () => {
    // The host is the boundary that decides. A client may have applied the
    // serialisable constraints already, and is not the only thing that can
    // post an answer.
    expect(parseFieldsAnswer(challenge, {}).ok).toBe(false);
  });
});

describe("why a flow ended", () => {
  test("a refusal and an outage are opposites, and were the pair a substring list confused", () => {
    // One clears on its own; repeating the other is how a prompt becomes a
    // loop.
    expect(isRetryable("unavailable")).toBe(true);
    expect(isRetryable("denied")).toBe(false);
  });

  test("a stale challenge is retryable, because the retry is what produces a fresh one", () => {
    expect(isRetryable("challenge-expired")).toBe(true);
  });

  test("nothing else is retryable", () => {
    for (const code of [
      "identity-mismatch",
      "missing-credentials",
      "credential-persist-failed",
      "unsupported",
      "unknown",
    ] as const) {
      expect(isRetryable(code), code).toBe(false);
    }
  });

  test("a failure carries a code and, when there is one, something to do", () => {
    const failure = new AuthFailure("identity-mismatch", "Signed in as someone else", {
      remedy: "Sign out of the other account first.",
    });
    expect(failure).toBeInstanceOf(Error);
    expect(failure.code).toBe("identity-mismatch");
    expect(failure.remedy).toContain("Sign out");
  });
});

describe("the session a provider is handed", () => {
  test("it carries the flow id, which is what a redirect embeds to come back", async () => {
    const { session, asked } = scriptedSession([{ code: "c" }]);

    await session.ask({
      kind: "redirect",
      title: "Approve",
      url: `https://example.com/a?state=${session.flowId}`,
      via: "gateway",
    });

    expect(asked[0]).toMatchObject({ url: "https://example.com/a?state=flow-1" });
  });

  test("a re-authentication names the account it is renewing", () => {
    const { session } = scriptedSession([], {
      reason: "reauthenticate",
      accountId: "a@example.com",
    });
    expect(session.reason).toBe("reauthenticate");
    expect(session.accountId).toBe("a@example.com");
  });

  test("a provider can tell whether a gateway-caught redirect is even possible", () => {
    // Absent means the host has no externally reachable origin, which is what
    // a provider checks before offering the browser-elsewhere path.
    const { session } = scriptedSession([]);
    expect(session.publicBaseUrl).toBeUndefined();
    const { session: hosted } = scriptedSession([], { publicBaseUrl: "https://example.com" });
    expect(hosted.publicBaseUrl).toBe("https://example.com");
  });
});

describe("what a challenge shows a client", () => {
  test("carries a field the form would otherwise hide, because a question has nowhere to hide it", () => {
    // `advanced` means "put it behind a disclosure" on a settings form. A
    // challenge is one question with no disclosure, and the answer is checked
    // against every declared field — so filtering here produced a form missing
    // a field whose absence then failed the answer, three times, naming a field
    // the operator was never shown.
    const wire = toWireChallenge({
      kind: "fields",
      title: "Connect",
      schema: c.object({
        host: c.string({ label: "Host", required: true }),
        port: c.string({ label: "Port", required: true, advanced: true }),
      }),
    });
    expect(wire.kind).toBe("fields");
    const names = (wire as { fields: Array<{ name: string }> }).fields.map((f) => f.name);
    expect(names).toEqual(["host", "port"]);
  });
});

describe("what a client says it can draw", () => {
  test("an undeclared client has only the legacy URL and QR transports", () => {
    expect([...DEFAULT_CLIENT_RENDERS].sort()).toEqual(["qr", "redirect"].sort());
    expect(DEFAULT_CLIENT_RENDERS).not.toContain("widget");
  });

  test("the kinds are the challenge kinds, so a new one cannot be forgotten here", () => {
    expect([...AUTH_CHALLENGE_KINDS].sort()).toEqual(
      ["code", "fields", "qr", "redirect", "wait", "widget"].sort(),
    );
  });
});

test("credential challenges preserve explicitly optional fields", () => {
  const challenge = credentialsChallenge(
    {
      fields: [
        { name: "token", label: "Token", secret: true },
        { name: "region", label: "Region", required: false },
      ],
    },
    { title: "Connect" },
  );
  expect(parseFieldsAnswer(challenge, { token: "fictional-token" })).toEqual({
    ok: true,
    value: { token: "fictional-token" },
  });
  expect(parseFieldsAnswer(challenge, {}).ok).toBe(false);
});

describe("whether trying again could work", () => {
  test("says yes for the three that clear by the operator doing something", () => {
    for (const code of ["credential-rejected", "local-conflict", "timeout"] as const) {
      expect(isRetryable(code)).toBe(true);
    }
  });

  test("says no for the ones that will not clear by repeating them", () => {
    for (const code of [
      "denied",
      "insecure-connection",
      "duplicate",
      "identity-mismatch",
      "unsupported",
      "missing-credentials",
    ] as const) {
      expect(isRetryable(code)).toBe(false);
    }
  });
});
