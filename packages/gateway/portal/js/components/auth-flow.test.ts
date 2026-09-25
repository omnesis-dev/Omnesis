// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import {
  offersAuthCodePaste,
  parseAuthCodeInput,
  reduceAuthEvent,
  redirectsToLoopback,
  // @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
} from "./auth-flow.js";

describe("reduceAuthEvent", () => {
  test("url event surfaces the auth URL on top of prev state", () => {
    const { next, sideEffect } = reduceAuthEvent({ flowId: "F" }, {
      type: "url",
      url: "https://accounts.google.com/o/oauth2/auth?…",
    }, "F");
    expect(next.url).toBe("https://accounts.google.com/o/oauth2/auth?…");
    expect(next.flowId).toBe("F");
    expect(sideEffect).toBeNull();
  });

  test("qr event with string data surfaces the payload", () => {
    const { next, sideEffect } = reduceAuthEvent(null, {
      type: "qr",
      data: "2@whatsapp-pairing-payload",
    }, "F");
    expect(next.qr).toBe("2@whatsapp-pairing-payload");
    expect(sideEffect).toBeNull();
  });

  test("qr event with non-string data normalizes to empty string", () => {
    // The gateway shouldn't send this, but the SSE payload is JSON so
    // we guard. Asserting the contract.
    const { next } = reduceAuthEvent(null, { type: "qr", data: 12345 }, "F");
    expect(next.qr).toBe("");
  });

  test("complete ok=true with accountId → account side effect", () => {
    const { next, sideEffect } = reduceAuthEvent({ flowId: "F", url: "U" }, {
      type: "complete",
      ok: true,
      accountId: "user@gmail.com",
    }, "F");
    expect(next.done).toBe(true);
    expect(next.accountId).toBe("user@gmail.com");
    expect(next.error).toBeUndefined();
    expect(sideEffect).toEqual({ kind: "account", accountId: "user@gmail.com" });
  });

  test("complete ok=false (non-missing-creds) → error side effect", () => {
    const { next, sideEffect } = reduceAuthEvent({ flowId: "F" }, {
      type: "complete",
      ok: false,
      error: "User denied access",
    }, "F");
    expect(next.done).toBe(true);
    expect(next.error).toBe("User denied access");
    expect(sideEffect).toEqual({ kind: "error", message: "User denied access" });
  });

  test("complete ok=false without error string falls back to default text", () => {
    const { sideEffect } = reduceAuthEvent({ flowId: "F" }, {
      type: "complete",
      ok: false,
    }, "F");
    expect(sideEffect).toEqual({ kind: "error", message: "Authentication failed" });
  });

  test("error event surfaces an error side effect", () => {
    const { next, sideEffect } = reduceAuthEvent({ flowId: "F" }, {
      type: "error",
      error: "OAuth callback timed out",
    }, "F");
    expect(next.done).toBe(true);
    expect(next.error).toBe("OAuth callback timed out");
    expect(sideEffect).toEqual({ kind: "error", message: "OAuth callback timed out" });
  });

  test("missing-credentials complete event clears error and emits wizard side effect", () => {
    // The auth subprocess refused for missing creds — the caller (modal)
    // is expected to open the wizard, not surface the failure message.
    const { next, sideEffect } = reduceAuthEvent({ flowId: "F" }, {
      type: "complete",
      ok: false,
      code: "missing-credentials",
      fileKey: "google-credentials",
      providerName: "Google",
      error: "Missing client credentials",
    }, "F");
    expect(next.done).toBe(true);
    expect(next.error).toBeNull();
    expect(sideEffect).toEqual({
      kind: "missingCredentials",
      fileKey: "google-credentials",
      providerName: "Google",
    });
  });

  test("missing-credentials error event emits wizard side effect too", () => {
    // Some providers surface missing-creds via `type: "error"` rather
    // than `type: "complete", ok: false`. Same outcome.
    const { sideEffect } = reduceAuthEvent({ flowId: "F" }, {
      type: "error",
      code: "missing-credentials",
      fileKey: "strava-credentials",
      providerName: "Strava",
      error: "Strava client id is not configured",
    }, "F");
    expect(sideEffect).toEqual({
      kind: "missingCredentials",
      fileKey: "strava-credentials",
      providerName: "Strava",
    });
  });

  test("missing-credentials without fileKey is treated as a regular error", () => {
    // Defensive: the missing-creds path requires both fileKey AND
    // providerName so we don't mistakenly route a malformed payload to
    // the wizard with junk inputs.
    const { sideEffect } = reduceAuthEvent({ flowId: "F" }, {
      type: "error",
      code: "missing-credentials",
      providerName: "Strava",
      error: "Strava client id is not configured",
    }, "F");
    expect(sideEffect?.kind).toBe("error");
  });

  test("subsequent events accumulate URL / QR onto the same flow", () => {
    let state = null;
    state = reduceAuthEvent(state, { type: "url", url: "U1" }, "F").next;
    state = reduceAuthEvent(state, { type: "qr", data: "Q1" }, "F").next;
    expect(state).toMatchObject({ flowId: "F", url: "U1", qr: "Q1" });
  });

  test("complete after url preserves accumulated fields", () => {
    const stateWithUrl = reduceAuthEvent(null, {
      type: "url",
      url: "https://accounts.google.com/…",
    }, "F").next;
    const { next } = reduceAuthEvent(stateWithUrl, {
      type: "complete",
      ok: true,
      accountId: "user@gmail.com",
    }, "F");
    expect(next.url).toBe("https://accounts.google.com/…");
    expect(next.accountId).toBe("user@gmail.com");
    expect(next.done).toBe(true);
  });

  test("widget event surfaces a generic {kind, payload} on the flow state", () => {
    const { next, sideEffect } = reduceAuthEvent({ flowId: "F" }, {
      type: "widget",
      kind: "demo-widget",
      payload: { session_token: "widget-session-abc" },
    }, "F");
    expect(next.widget).toEqual({
      kind: "demo-widget",
      payload: { session_token: "widget-session-abc" },
    });
    expect(next.flowId).toBe("F");
    // A widget config is non-terminal — the surface opens the widget and waits.
    expect(sideEffect).toBeNull();
  });

  test("widget event without kind/payload is ignored (no crash, no widget set)", () => {
    const a = reduceAuthEvent({ flowId: "F" }, { type: "widget", payload: { x: "y" } }, "F");
    expect(a.next.widget).toBeUndefined();
    const b = reduceAuthEvent({ flowId: "F" }, { type: "widget", kind: "k" }, "F");
    expect(b.next.widget).toBeUndefined();
  });

  test("complete after a widget event still resolves to an account side effect", () => {
    const withWidget = reduceAuthEvent(null, {
      type: "widget",
      kind: "demo-widget",
      payload: { session_token: "wt" },
    }, "F").next;
    const { next, sideEffect } = reduceAuthEvent(withWidget, {
      type: "complete",
      ok: true,
      accountId: "item-1",
    }, "F");
    // The accumulated widget config is preserved; completion drives the account.
    expect(next.widget).toEqual({ kind: "demo-widget", payload: { session_token: "wt" } });
    expect(sideEffect).toEqual({ kind: "account", accountId: "item-1" });
  });

  test("unknown event type leaves state unchanged but tags the flowId", () => {
    // Defensive: future-proof the reducer against gateway events we
    // don't yet handle. Should not crash and should not move terminal.
    const { next, sideEffect } = reduceAuthEvent({ flowId: "F", url: "U" }, {
      type: "future-event",
    }, "F");
    expect(next).toEqual({ flowId: "F", url: "U" });
    expect(sideEffect).toBeNull();
  });
});

describe("offersAuthCodePaste", () => {
  const urlState = { flowId: "F", url: "https://auth.example.com/consent" };

  test("offered only when the descriptor declares acceptsAuthCode", () => {
    expect(offersAuthCodePaste({ authType: "oauth", acceptsAuthCode: true }, urlState)).toBe(true);
  });

  test("NOT offered for an oauth descriptor without the capability (localhost-listener provider)", () => {
    // A pasted code for such a provider is buffered unread by the auth
    // subprocess and the flow strands in `completing` — the form must
    // never be rendered, regardless of authType.
    expect(offersAuthCodePaste({ authType: "oauth" }, urlState)).toBe(false);
    expect(offersAuthCodePaste({ authType: "oauth", acceptsAuthCode: false }, urlState)).toBe(false);
  });

  test("requires a surfaced URL and flowId", () => {
    const descriptor = { authType: "oauth", acceptsAuthCode: true };
    expect(offersAuthCodePaste(descriptor, { flowId: "F" })).toBe(false);
    expect(offersAuthCodePaste(descriptor, { url: "https://auth.example.com" })).toBe(false);
    expect(offersAuthCodePaste(descriptor, null)).toBe(false);
  });

  test("tolerates a missing descriptor", () => {
    expect(offersAuthCodePaste(undefined, urlState)).toBe(false);
  });
});

describe("parseAuthCodeInput", () => {
  // Mirrors packages/cli/src/auth-code-input.ts — same accepted shapes.

  test("full redirect URL → code from the ?code= param (percent-decoded)", () => {
    const code = parseAuthCodeInput(
      "https://127.0.0.1:8182/?code=C0.abc%40def&state=flow-1",
    );
    expect(code).toBe("C0.abc@def");
  });

  test("gateway /oauth/callback shape works too", () => {
    const code = parseAuthCodeInput(
      "https://gateway.example.com:7600/oauth/callback?state=flow-1&code=xyz789",
    );
    expect(code).toBe("xyz789");
  });

  test("surrounding whitespace is trimmed", () => {
    expect(parseAuthCodeInput("  abc123\n")).toBe("abc123");
  });

  test("bare code without % passes through verbatim", () => {
    expect(parseAuthCodeInput("4/0AbC-dEf_123")).toBe("4/0AbC-dEf_123");
  });

  test("bare code containing % is percent-decoded", () => {
    expect(parseAuthCodeInput("C0.abc%40def%2Fg")).toBe("C0.abc@def/g");
  });

  test("URL without a code param throws", () => {
    expect(() => parseAuthCodeInput("https://example.com/?state=flow-1")).toThrow(
      /No `code` query parameter/,
    );
  });

  test("empty input throws", () => {
    expect(() => parseAuthCodeInput("   ")).toThrow(/Empty input/);
  });

  test("input with internal whitespace throws", () => {
    expect(() => parseAuthCodeInput("not a code")).toThrow(/doesn't look like/);
  });

  test("malformed percent-encoding throws", () => {
    expect(() => parseAuthCodeInput("abc%zz")).toThrow(/could not be decoded/);
  });

  test("unparseable https:// prefix throws the URL guidance", () => {
    expect(() => parseAuthCodeInput("https://")).toThrow(/could not be parsed/);
  });
});

describe("redirectsToLoopback", () => {
  test("a provider redirecting to the collector's loopback needs the host warning", () => {
    expect(
      redirectsToLoopback(
        "https://example.com/oauth?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcb",
      ),
    ).toBe(true);
    expect(
      redirectsToLoopback("https://example.com/oauth?redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fcb"),
    ).toBe(true);
  });

  test("a redirect to the gateway's public URL works from any browser", () => {
    expect(
      redirectsToLoopback(
        "https://example.com/oauth?redirect_uri=https%3A%2F%2Fgw.example.com%2Foauth%2Fcallback",
      ),
    ).toBe(false);
  });

  test("a provider-hosted sign-in page carries no redirect at all", () => {
    expect(redirectsToLoopback("https://hosted.example.com/link?token=abc")).toBe(false);
  });

  test("a missing or unparseable URL never warns", () => {
    expect(redirectsToLoopback(undefined)).toBe(false);
    expect(redirectsToLoopback("not a url")).toBe(false);
    expect(redirectsToLoopback("https://example.com/oauth?redirect_uri=not-a-url")).toBe(false);
  });
});

describe("a typed challenge", () => {
  test("is carried whole, under the id an answer will name", () => {
    const { next, sideEffect } = reduceAuthEvent({ flowId: "F" }, {
      type: "challenge",
      id: "c1",
      challenge: {
        kind: "qr",
        title: "Scan this from your phone",
        instructions: "Open the app, then Settings, then Linked devices.",
        data: "pairing-payload",
      },
    }, "F");

    // Nothing here inspects the kind or composes the sentence: the words came
    // with the challenge, which is what keeps one platform's instructions out
    // of a component every platform renders.
    expect(next.challenge).toEqual({
      id: "c1",
      expectsAnswer: true,
      kind: "qr",
      title: "Scan this from your phone",
      instructions: "Open the app, then Settings, then Linked devices.",
      data: "pairing-payload",
    });
    expect(sideEffect).toBeNull();
  });

  test("carries whether an answer is wanted, and assumes one when unsaid", () => {
    const shown = reduceAuthEvent({ flowId: "F" }, {
      type: "challenge",
      id: "c1",
      expectsAnswer: false,
      challenge: { kind: "redirect", via: "loopback", title: "Sign in", url: "https://example.com/a" },
    }, "F");
    expect(shown.next.challenge.expectsAnswer).toBe(false);

    const asked = reduceAuthEvent({ flowId: "F" }, {
      type: "challenge",
      id: "c2",
      expectsAnswer: true,
      challenge: { kind: "redirect", via: "loopback", title: "Sign in", url: "https://example.com/a" },
    }, "F");
    expect(asked.next.challenge.expectsAnswer).toBe(true);

    // A collector that predates the field. Assuming a question is what keeps
    // every kind this client already rendered an input for working.
    const older = reduceAuthEvent({ flowId: "F" }, {
      type: "challenge",
      id: "c3",
      challenge: { kind: "code", title: "Paste the code" },
    }, "F");
    expect(older.next.challenge.expectsAnswer).toBe(true);
  });

  test("a notice becomes a status line rather than something to answer", () => {
    const { next } = reduceAuthEvent({ flowId: "F" }, {
      type: "challenge",
      id: "c2",
      challenge: { kind: "wait", title: "Checking the token" },
    }, "F");

    expect(next.status).toBe("Checking the token");
    expect(next.challenge).toBeUndefined();
  });

  test("a notice does not erase the question the operator is answering", () => {
    // A flow may narrate while something is still being asked. Taking the form
    // off screen would leave the operator with an answer they cannot send, for
    // a question the flow is still waiting on.
    const asking = reduceAuthEvent({ flowId: "F" }, {
      type: "challenge",
      id: "c1",
      challenge: { kind: "fields", title: "Choose your bank", fields: [] },
    }, "F").next;

    const { next } = reduceAuthEvent(asking, {
      type: "challenge",
      id: "c2",
      challenge: { kind: "wait", title: "Contacting your bank" },
    }, "F");

    expect(next.status).toBe("Contacting your bank");
    expect(next.challenge).toMatchObject({ id: "c1", title: "Choose your bank" });
  });

  test("a second question replaces the first, because a flow waits on one at a time", () => {
    const first = reduceAuthEvent({ flowId: "F" }, {
      type: "challenge",
      id: "c1",
      challenge: { kind: "fields", title: "Choose your country", fields: [] },
    }, "F").next;

    const second = reduceAuthEvent(first, {
      type: "challenge",
      id: "c2",
      challenge: { kind: "fields", title: "Choose your bank", fields: [] },
    }, "F").next;

    expect(second.challenge).toMatchObject({ id: "c2", title: "Choose your bank" });
  });

  test("a malformed challenge is ignored rather than rendered empty", () => {
    const { next } = reduceAuthEvent({ flowId: "F" }, { type: "challenge", id: "c1" }, "F");
    expect(next.challenge).toBeUndefined();
  });
});


describe("a connection that succeeded with something to say", () => {
  test("keeps what the flow reported about the credential and what went wrong anyway", () => {
    const { next } = reduceAuthEvent({ flowId: "F" }, {
      type: "complete",
      ok: true,
      accountId: "acct-1",
      accountStates: { "acct-1": { status: "connected", expiresAt: "2027-03-12T00:00:00.000Z" } },
      notices: [{ title: "Only the last 90 days were captured.", detail: "Connect again to retry." }],
    }, "F");

    expect(next.accountId).toBe("acct-1");
    expect(next.accountExpiresAt).toBe("2027-03-12T00:00:00.000Z");
    expect(next.notices).toEqual([
      { title: "Only the last 90 days were captured.", detail: "Connect again to retry." },
    ]);
  });

  test("says nothing extra when the flow said nothing extra", () => {
    const { next } = reduceAuthEvent({ flowId: "F" }, {
      type: "complete",
      ok: true,
      accountId: "acct-1",
    }, "F");
    expect(next.accountExpiresAt).toBeUndefined();
    expect(next.notices).toBeUndefined();
  });
});

describe("a failure that says what to do about it", () => {
  test("keeps the sentence, on both terminal shapes", () => {
    for (const type of ["error", "complete"] as const) {
      const { next } = reduceAuthEvent({ flowId: "F" }, {
        type,
        ...(type === "complete" ? { ok: false } : {}),
        error: "Signed in as someone else",
        code: "identity-mismatch",
        remedy: "Sign out in your browser, then try again.",
      }, "F");
      // The code says which class of thing went wrong; this is the sentence
      // only the source can write, and for a platform with no account chooser
      // it is the whole recovery. It reached this client and stopped here.
      expect(next.remedy).toBe("Sign out in your browser, then try again.");
      expect(next.error).toBe("Signed in as someone else");
    }
  });

  test("says nothing extra when the source said nothing", () => {
    const { next } = reduceAuthEvent({ flowId: "F" }, {
      type: "error",
      error: "Authentication failed",
    }, "F");
    expect(next.remedy).toBeUndefined();
  });

  test("ignores a blank one rather than rendering an empty line", () => {
    const { next } = reduceAuthEvent({ flowId: "F" }, {
      type: "error",
      error: "Authentication failed",
      remedy: "   ",
    }, "F");
    expect(next.remedy).toBeUndefined();
  });
});
