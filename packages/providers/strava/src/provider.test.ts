// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthFailure, isRetryable } from "@omnesis/source-sdk";
import { fakeProviderHost } from "@omnesis/source-sdk/testing";
import { authenticate, authFlow, buildAuthorizeUrl, parseOAuthCallbackUrl } from "./provider.js";
import type {
  AskableChallenge,
  AuthChallenge,
  AuthFailureCode,
  AuthSession,
} from "@omnesis/source-sdk";

/**
 * A credentials file that is present and cannot be decrypted: a well-formed
 * envelope whose key this install does not hold.
 */
const SEALED_ENVELOPE = {
  omnesis: "omnesis.secret-file",
  version: 1,
  alg: "aes-256-gcm",
  kdf: "hkdf-sha256",
  scope: "strava-credentials",
  salt: "c2FsdA",
  iv: "aXYtdmFsdWU",
  tag: "dGFnLXZhbHVl",
  ciphertext: "Y2lwaGVydGV4dA",
};

/**
 * Take the loopback callback port, waiting for whatever holds it to let go.
 *
 * A listener is closed on a short grace so the browser receives its last
 * response, so the port can still be held for a moment after the flow that
 * bound it has finished.
 */
async function holdCallbackPort(): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const server = createServer((_req, res) => res.end());
    const bound = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(3003, "localhost", () => resolve(true));
    });
    if (bound) return () => new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the loopback callback port never became free");
}

/** Wait until the flow has put a challenge in front of the operator. */
async function waitForChallenge(asked: AskableChallenge[]): Promise<AskableChallenge> {
  for (let i = 0; i < 200 && asked.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const challenge = asked[0];
  if (!challenge) throw new Error("no challenge was asked");
  return challenge;
}

/**
 * Land a browser on the loopback callback the flow is listening on.
 *
 * Over `node:http` rather than `fetch`, because the tests that need this also
 * replace the global `fetch` with the token endpoint's scripted reply.
 */
function visitCallback(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = httpGet(
      { host: "localhost", port: 3003, path },
      (res) => void res.on("data", () => {}).on("end", resolve),
    );
    req.on("error", reject);
  });
}

const tmpDirs: string[] = [];

async function makeConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-strava-auth-"));
  tmpDirs.push(dir);
  await writeFile(
    join(dir, "strava-credentials.json"),
    JSON.stringify({ client_id: "strava-client", client_secret: "strava-secret" }),
  );
  return dir;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Strava OAuth flow", () => {
  test("buildAuthorizeUrl embeds redirect URI, scopes, and state", () => {
    const url = new URL(
      buildAuthorizeUrl(
        { client_id: "strava-client" },
        "https://gateway.example.com/oauth/callback",
        "flow-1",
      ),
    );

    expect(url.origin + url.pathname).toBe("https://www.strava.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("strava-client");
    expect(url.searchParams.get("redirect_uri")).toBe("https://gateway.example.com/oauth/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    // `force`, not `auto`: under `auto` Strava skips the authorization
    // screen once the athlete has approved, so a second add silently
    // re-authorizes whoever is already signed in.
    expect(url.searchParams.get("approval_prompt")).toBe("force");
    expect(url.searchParams.get("scope")).toContain("activity:read_all");
    expect(url.searchParams.get("state")).toBe("flow-1");
  });

  test("parseOAuthCallbackUrl accepts only matching state", () => {
    expect(
      parseOAuthCallbackUrl(
        "/oauth2callback?code=abc&state=flow-1&scope=read,activity:read_all",
        "flow-1",
      ),
    ).toEqual({ kind: "code", code: "abc", scope: "read,activity:read_all" });
    expect(parseOAuthCallbackUrl("/oauth2callback?code=abc", "flow-1")).toMatchObject({
      kind: "ignored",
      status: 400,
    });
    expect(parseOAuthCallbackUrl("/elsewhere?code=abc&state=flow-1", "flow-1")).toEqual({
      kind: "ignored",
      status: 404,
      body: "Not found.",
    });
  });

  test("parseOAuthCallbackUrl returns provider errors only with matching state", () => {
    expect(parseOAuthCallbackUrl("/oauth2callback?error=access_denied&state=s-1", "s-1")).toEqual({
      kind: "error",
      error: "access_denied",
    });

    expect(
      parseOAuthCallbackUrl("/oauth2callback?error=access_denied&state=s-2", "s-1"),
    ).toMatchObject({ kind: "ignored", status: 400 });
  });

  test("public callback mode uses flowId as state and exchanges the delivered code", async () => {
    const configDir = await makeConfigDir();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      json: async () => ({
        access_token: "strava-access",
        refresh_token: "strava-refresh",
        expires_at: 1_900_000_000,
        expires_in: 3600,
        token_type: "Bearer",
        athlete: { id: 4242 },
      }),
      text: async () => "",
      status: 200,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const authUrls: string[] = [];
    const accountId = await authFlow({
      configDir,
      callbacks: {
        publicBaseUrl: "https://gateway.example.com/",
        flowId: "flow-1",
        onAuthUrl: (url) => authUrls.push(url),
        receiveCode: async () => "delivered-code",
      },
    });

    expect(String(accountId)).toBe("4242");
    const authUrl = new URL(authUrls[0]!);
    expect(authUrl.searchParams.get("state")).toBe("flow-1");
    expect(authUrl.searchParams.get("redirect_uri")).toBe(
      "https://gateway.example.com/oauth/callback",
    );

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init.body))).toMatchObject({ code: "delivered-code" });

    const saved = JSON.parse(
      await readFile(join(configDir, "strava", "4242", "tokens.json"), "utf-8"),
    );
    expect(saved.access_token).toBe("strava-access");
  });

  test("public callback mode requires receiveCode", async () => {
    const configDir = await makeConfigDir();
    await expect(
      authFlow({
        configDir,
        callbacks: { publicBaseUrl: "https://gateway.example.com", flowId: "flow-1" },
      }),
    ).rejects.toThrow(/receiveCode/);
  });
});

describe("connecting an athlete through the typed session", () => {
  // Each of these binds the loopback callback port, and a listener lingers for
  // a moment after the flow that bound it is done.
  beforeEach(async () => {
    await (
      await holdCallbackPort()
    )();
  });

  /**
   * A session that records what the flow put in front of the operator and
   * answers with whatever the test scripts.
   */
  function scriptedSession(options: {
    configDir: string;
    answer?: (challenge: AskableChallenge) => Promise<{ code: string; state?: string }>;
    accountId?: string;
    publicBaseUrl?: string;
    flowId?: string;
  }) {
    const shown: AuthChallenge[] = [];
    const asked: AskableChallenge[] = [];
    const session: AuthSession = {
      reason: options.accountId ? "reauthenticate" : "connect",
      flowId: options.flowId ?? "flow-1",
      accountId: options.accountId,
      publicBaseUrl: options.publicBaseUrl,
      supplied: {},
      host: { ...fakeProviderHost(), configDir: options.configDir },
      canShow: () => true,
      show: (challenge) => void shown.push(challenge),
      ask: (challenge) => {
        asked.push(challenge);
        const answer = options.answer ?? (() => new Promise<never>(() => {}));
        return answer(challenge) as never;
      },
    };
    return { session, shown, asked };
  }

  /** The token endpoint's reply, in the shape `fetch` hands back. */
  function tokenResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  }

  const grant = {
    access_token: "strava-access",
    refresh_token: "strava-refresh",
    // Six hours out — the access token's own deadline, deliberately not the
    // grant's.
    expires_at: 1_900_021_600,
    expires_in: 21_600,
    token_type: "Bearer",
    athlete: { id: 4242, firstname: "Maya", lastname: "Reeves" },
  };

  /** The `state` the flow minted, read back off the URL it showed. */
  function stateOf(challenge: AskableChallenge): string {
    if (challenge.kind !== "redirect") throw new Error("not a redirect challenge");
    return new URL(challenge.url).searchParams.get("state")!;
  }

  async function failureFrom(promise: Promise<unknown>): Promise<AuthFailure> {
    const caught = await promise.then(
      () => null,
      (err: unknown) => err,
    );
    expect(caught).toBeInstanceOf(AuthFailure);
    return caught as AuthFailure;
  }

  test("asks the gateway branch to authorize, then stores the athlete's tokens", async () => {
    const configDir = await makeConfigDir();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tokenResponse(grant)),
    );
    const { session, asked, shown } = scriptedSession({
      configDir,
      publicBaseUrl: "https://gateway.example.com/",
      flowId: "flow-7",
      answer: async () => ({ code: "delivered-code" }),
    });

    const result = await authenticate(session);

    expect(asked).toHaveLength(1);
    const challenge = asked[0]!;
    expect(challenge.kind).toBe("redirect");
    if (challenge.kind !== "redirect") throw new Error("unreachable");
    expect(challenge.via).toBe("gateway");
    expect(new URL(challenge.url).searchParams.get("state")).toBe("flow-7");
    expect(new URL(challenge.url).searchParams.get("redirect_uri")).toBe(
      "https://gateway.example.com/oauth/callback",
    );
    expect(shown.map((c) => c.kind)).toEqual(["wait"]);
    // The access token expires in six hours and the grant renews itself from
    // the refresh token, so reporting that deadline here would warn about a
    // lapse every six hours forever.
    expect(result.accounts).toEqual([{ accountId: "4242", state: { status: "connected" } }]);
    const saved = JSON.parse(
      await readFile(join(configDir, "strava", "4242", "tokens.json"), "utf-8"),
    );
    expect(saved.access_token).toBe("strava-access");
  });

  test("catches the loopback redirect on its own listener", async () => {
    const configDir = await makeConfigDir();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tokenResponse(grant)),
    );
    const { session, asked } = scriptedSession({ configDir });

    const connected = authenticate(session);
    const challenge = await waitForChallenge(asked);
    expect(challenge.kind).toBe("redirect");
    if (challenge.kind !== "redirect") throw new Error("unreachable");
    expect(challenge.via).toBe("loopback");
    await visitCallback(
      `/oauth2callback?code=browser-code&state=${stateOf(challenge)}` +
        `&scope=read,activity:read_all,profile:read_all`,
    );

    const result = await connected;
    expect(result.accounts).toEqual([{ accountId: "4242", state: { status: "connected" } }]);
  });

  test("reports the scopes the athlete unticked, which nothing else ever sees", async () => {
    const configDir = await makeConfigDir();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tokenResponse(grant)),
    );
    const { session, asked } = scriptedSession({ configDir });

    const connected = authenticate(session);
    const challenge = await waitForChallenge(asked);
    await visitCallback(`/oauth2callback?code=browser-code&state=${stateOf(challenge)}&scope=read`);

    const result = await connected;
    expect(result.accounts[0]?.state).toEqual({
      status: "scope-insufficient",
      missing: ["activity:read_all", "profile:read_all"],
    });
  });

  test("reports a port it cannot bind as a local conflict, before showing anything", async () => {
    const configDir = await makeConfigDir();
    const release = await holdCallbackPort();
    try {
      const { session, asked } = scriptedSession({ configDir });
      const failure = await failureFrom(authenticate(session));
      expect(failure.code).toBe("local-conflict");
      expect(isRetryable(failure.code)).toBe(true);
      expect(failure.remedy).toMatch(/3003/);
      // Nothing was put in front of the operator: a URL they cannot finish
      // costs them the whole round trip.
      expect(asked).toEqual([]);
    } finally {
      await release();
    }
  });

  test("reports a declined authorization as denied", async () => {
    const configDir = await makeConfigDir();
    const { session, asked } = scriptedSession({ configDir });

    // The failure is read before the browser lands, so the rejection never
    // passes through a turn of the loop with nobody waiting on it.
    const settled = failureFrom(authenticate(session));
    const challenge = await waitForChallenge(asked);
    await visitCallback(`/oauth2callback?error=access_denied&state=${stateOf(challenge)}`);

    const failure = await settled;
    expect(failure.code).toBe("denied");
    expect(isRetryable(failure.code)).toBe(false);
  });

  test("refuses an answer carrying somebody else's state", async () => {
    const configDir = await makeConfigDir();
    const { session } = scriptedSession({
      configDir,
      publicBaseUrl: "https://gateway.example.com",
      flowId: "flow-7",
      answer: async () => ({ code: "c", state: "flow-9" }),
    });

    const failure = await failureFrom(authenticate(session));
    expect(failure.code).toBe("unknown");
    expect(failure.remedy).toMatch(/other Strava sign-in/);
  });

  test("refuses a renewal that authorized a different athlete", async () => {
    const configDir = await makeConfigDir();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tokenResponse(grant)),
    );
    const { session } = scriptedSession({
      configDir,
      accountId: "9999",
      publicBaseUrl: "https://gateway.example.com",
      answer: async () => ({ code: "delivered-code" }),
    });

    const failure = await failureFrom(authenticate(session));
    expect(failure.code).toBe("identity-mismatch");
    // Strava has no account chooser, so signing out of the browser is the
    // whole recovery.
    expect(failure.remedy).toMatch(/Sign out of Strava in your browser/);
    // Nothing written: the athlete being repaired keeps the account they had.
    expect(existsSync(join(configDir, "strava", "4242"))).toBe(false);
  });

  test("tells the four token-exchange failures apart", async () => {
    const cases: Array<[{ status: number; body: unknown }, AuthFailureCode]> = [
      [{ status: 400, body: { error: "invalid_grant" } }, "challenge-expired"],
      [{ status: 400, body: { error: "invalid_client" } }, "credential-rejected"],
      [{ status: 503, body: { message: "the platform is briefly unreachable" } }, "unavailable"],
      [
        { status: 400, body: { message: "an error shape this build does not recognise" } },
        "unknown",
      ],
    ];
    for (const [reply, expected] of cases) {
      const configDir = await makeConfigDir();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => tokenResponse(reply.body, { ok: false, status: reply.status })),
      );
      const { session } = scriptedSession({
        configDir,
        publicBaseUrl: "https://gateway.example.com",
        answer: async () => ({ code: "delivered-code" }),
      });
      const failure = await failureFrom(authenticate(session));
      expect(failure.code).toBe(expected);
    }
  });

  test("reports an unreachable token endpoint as unavailable", async () => {
    const configDir = await makeConfigDir();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const { session } = scriptedSession({
      configDir,
      publicBaseUrl: "https://gateway.example.com",
      answer: async () => ({ code: "delivered-code" }),
    });

    const failure = await failureFrom(authenticate(session));
    expect(failure.code).toBe("unavailable");
    expect(isRetryable(failure.code)).toBe(true);
  });

  test("asks for OAuth credentials only when there are none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnesis-strava-nocreds-"));
    tmpDirs.push(dir);
    const { session } = scriptedSession({ configDir: dir });
    await expect(authenticate(session)).rejects.toMatchObject({ code: "missing-credentials" });
  });

  test("does not call a credentials file it cannot decrypt missing", async () => {
    // Reporting an undecryptable file as absent asks the operator to paste a
    // client secret that is already stored — the keyring is what is wrong.
    const dir = await mkdtemp(join(tmpdir(), "omnesis-strava-locked-"));
    tmpDirs.push(dir);
    await writeFile(join(dir, "strava-credentials.json"), JSON.stringify(SEALED_ENVELOPE));
    const { session } = scriptedSession({ configDir: dir });

    const failure = await failureFrom(authenticate(session));
    expect(failure.code).toBe("unavailable");
    expect(failure.remedy).toMatch(/keyring/i);
  });

  test("reports a grant it could not store as a persistence failure", async () => {
    const configDir = await makeConfigDir();
    // A file where the athlete's directory has to go, so the write fails after
    // Strava has already issued the tokens.
    await writeFile(join(configDir, "strava"), "not a directory");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tokenResponse(grant)),
    );
    const { session } = scriptedSession({
      configDir,
      publicBaseUrl: "https://gateway.example.com",
      answer: async () => ({ code: "delivered-code" }),
    });

    await expect(authenticate(session)).rejects.toMatchObject({
      code: "credential-persist-failed",
    });
  });
});
