// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLogger, isMissingCredentialsError } from "@omnesis/core";
import { AuthFailure } from "@omnesis/source-sdk";

/**
 * The googleapis SDK, replaced wholesale.
 *
 * Every network leg of the flow — the authorize URL, the token exchange, the
 * profile lookup that names the account — goes through it, so substituting it
 * here is what lets the loopback listener, the racing paste path and the
 * failure vocabulary all be driven without reaching Google.
 */
const gapi = vi.hoisted(() => ({
  generateAuthUrl: vi.fn(),
  getToken: vi.fn(),
  setCredentials: vi.fn(),
  getProfile: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: vi.fn().mockImplementation(function OAuth2() {
        return {
          generateAuthUrl: gapi.generateAuthUrl,
          getToken: gapi.getToken,
          setCredentials: gapi.setCredentials,
          on: vi.fn(),
          credentials: {},
        };
      }),
    },
    gmail: vi.fn(() => ({ users: { getProfile: gapi.getProfile } })),
  },
}));

import { authenticateWith, parseOAuthCallbackUrl, SCOPES } from "./provider.js";
import type { AddressInfo } from "node:net";
import type {
  AskableChallenge,
  AuthChallenge,
  AuthSession,
  ShowableChallenge,
} from "@omnesis/source-sdk";

const ACCOUNT = "maya.reeves@example.com";
const GRANTED_SCOPES = SCOPES.join(" ");

const tmpDirs: string[] = [];

async function makeConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-google-auth-"));
  tmpDirs.push(dir);
  return dir;
}

/** A config dir holding an OAuth client whose redirect lands on `port`. */
async function configDirWithClient(port: number): Promise<string> {
  const dir = await makeConfigDir();
  await writeFile(
    join(dir, "google-credentials.json"),
    JSON.stringify({
      client_id: "123456789012-abc.apps.googleusercontent.com",
      client_secret: "GOCSPX-not-a-real-secret",
      redirect_uri: `http://127.0.0.1:${port}/oauth2callback`,
    }),
  );
  return dir;
}

/** A port nothing is listening on. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((ready) => probe.listen(0, ready));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((closed) => probe.close(() => closed()));
  return port;
}

/** A port something else already holds, and the way to give it back. */
async function occupiedPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const squatter = createServer();
  await new Promise<void>((ready) => squatter.listen(0, ready));
  const { port } = squatter.address() as AddressInfo;
  return {
    port,
    release: () => new Promise<void>((closed) => squatter.close(() => closed())),
  };
}

/** The `state` this attempt minted, read back out of the authorize URL. */
function stateOf(challenge: AskableChallenge): string {
  if (challenge.kind !== "redirect") throw new Error("not a redirect challenge");
  return new URL(challenge.url).searchParams.get("state") ?? "";
}

interface ScriptedSession {
  session: AuthSession;
  /** Everything put in front of the operator, in order. */
  shown: AuthChallenge[];
  /** Everything they were asked, in order. */
  asked: AskableChallenge[];
}

/**
 * An operator's side of a flow, scripted.
 *
 * `answer` stands in for the client: it is handed each challenge and returns
 * what comes back. Returning a promise that never settles is how a test says
 * "the operator's browser is answering this, not the operator" — which is the
 * shape of every loopback case below.
 */
function scriptedSession(options: {
  configDir: string;
  accountId?: string;
  answer?: (challenge: AskableChallenge) => Promise<Record<string, unknown>>;
}): ScriptedSession {
  const shown: AuthChallenge[] = [];
  const asked: AskableChallenge[] = [];
  const session: AuthSession = {
    reason: options.accountId ? "reauthenticate" : "connect",
    flowId: "flow-1",
    accountId: options.accountId,
    supplied: {},
    host: {
      log: createLogger("test:google"),
      now: () => new Date(),
      stateDir: join(options.configDir, "google"),
      configDir: options.configDir,
    },
    canShow: () => true,
    show: (challenge: ShowableChallenge) => {
      shown.push(challenge);
    },
    ask: (async (challenge: AskableChallenge) => {
      asked.push(challenge);
      const answer = options.answer ?? (() => new Promise<never>(() => {}));
      return await answer(challenge);
    }) as AuthSession["ask"],
  };
  return { session, shown, asked };
}

/**
 * Complete the browser's half of the flow against the loopback listener.
 *
 * Called the moment the redirect is put to the operator, which is what makes
 * it a check on ordering as well as on the happy path: a listener bound after
 * the URL was shown would refuse this connection outright.
 */
async function completeInBrowser(
  challenge: AskableChallenge,
  port: number,
  params: Record<string, string>,
): Promise<string> {
  const query = new URLSearchParams({ state: stateOf(challenge), ...params });
  const response = await fetch(`http://127.0.0.1:${port}/oauth2callback?${query.toString()}`);
  return await response.text();
}

beforeEach(() => {
  vi.clearAllMocks();
  gapi.generateAuthUrl.mockImplementation(
    (opts: { state: string }) =>
      `https://accounts.example.com/o/oauth2/auth?state=${encodeURIComponent(opts.state)}`,
  );
  gapi.getToken.mockResolvedValue({
    tokens: {
      access_token: "access-token",
      refresh_token: "refresh-token",
      scope: GRANTED_SCOPES,
      expiry_date: 1_800_000_000_000,
    },
  });
  gapi.getProfile.mockResolvedValue({ data: { emailAddress: ACCOUNT } });
});

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("parseOAuthCallbackUrl", () => {
  test("a code with the expected state is the authorization", () => {
    expect(parseOAuthCallbackUrl("/oauth2callback?code=abc&state=flow-1", "flow-1")).toMatchObject({
      kind: "code",
      code: "abc",
      state: "flow-1",
      status: 200,
    });
  });

  test("a code carrying somebody else's state is refused", () => {
    // Without this any local process could race a poisoned `?code=…` to
    // loopback while the authorization window is open.
    expect(parseOAuthCallbackUrl("/oauth2callback?code=abc&state=other", "flow-1")).toMatchObject({
      kind: "error",
      reason: "state-mismatch",
      status: 400,
    });
  });

  test("Google's own refusal is carried by name", () => {
    expect(
      parseOAuthCallbackUrl("/oauth2callback?error=access_denied&state=flow-1", "flow-1"),
    ).toMatchObject({ kind: "error", reason: "oauth-error", error: "access_denied" });
  });

  test("another path on the same port is not this flow", () => {
    expect(parseOAuthCallbackUrl("/elsewhere?code=abc&state=flow-1", "flow-1")).toMatchObject({
      kind: "ignored",
      status: 404,
    });
  });

  test("a request carrying neither is nothing yet", () => {
    expect(parseOAuthCallbackUrl("/oauth2callback", "flow-1")).toMatchObject({
      kind: "ignored",
      status: 400,
    });
  });

  test("the listener answers on the path the redirect names", () => {
    expect(
      parseOAuthCallbackUrl("/other/cb?code=abc&state=flow-1", "flow-1", "/other/cb"),
    ).toMatchObject({ kind: "code", code: "abc" });
  });
});

describe("Google authenticate", () => {
  test("the browser's redirect is caught on the port the flow is already holding", async () => {
    const port = await freePort();
    const configDir = await configDirWithClient(port);
    let browserSaw = "";
    const { session, shown, asked } = scriptedSession({
      configDir,
      // Answering the instant the redirect is shown is the whole point: an
      // operator already signed in completes Google's consent in under a
      // second, and a listener bound afterwards would never see it.
      answer: async (challenge) => {
        browserSaw = await completeInBrowser(challenge, port, { code: "browser-code" });
        return await new Promise<never>(() => {});
      },
    });

    const result = await authenticateWith(session, {});

    expect(browserSaw).toBe("Authentication successful! You can close this tab.");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: "redirect", via: "loopback" });
    expect(shown.map((c) => c.kind)).toContain("wait");
    expect(gapi.getToken).toHaveBeenCalledWith("browser-code");
    expect(result.accounts).toEqual([
      { accountId: ACCOUNT, state: { status: "connected", scopes: SCOPES } },
    ]);
    expect(result.notices).toBeUndefined();

    const saved = JSON.parse(
      await readFile(join(configDir, "google", ACCOUNT, "tokens.json"), "utf-8"),
    );
    expect(saved.refresh_token).toBe("refresh-token");
  });

  test("a code brought back by hand finishes the same flow", async () => {
    // The browser is on another machine, so nothing reaches the loopback
    // listener and the operator pastes the code out of the address bar.
    const port = await freePort();
    const configDir = await configDirWithClient(port);
    const { session } = scriptedSession({
      configDir,
      answer: async () => ({ code: "pasted-code" }),
    });

    const result = await authenticateWith(session, {});

    expect(gapi.getToken).toHaveBeenCalledWith("pasted-code");
    expect(result.accounts[0].accountId).toBe(ACCOUNT);
  });

  // Regression: with `consent` alone and one signed-in Google session, the
  // browser silently re-authorizes that account — so adding a second mailbox
  // overwrote the first account's tokens and registered no new source.
  test("a first-time add forces the account chooser", async () => {
    const configDir = await configDirWithClient(await freePort());
    await authenticateWith(
      scriptedSession({ configDir, answer: async () => ({ code: "c" }) }).session,
      {},
    );
    expect(gapi.generateAuthUrl.mock.calls[0][0]).toMatchObject({
      prompt: "select_account consent",
      access_type: "offline",
      scope: SCOPES,
    });
  });

  test("a renewal pins the account it is refreshing and skips the chooser", async () => {
    const configDir = await configDirWithClient(await freePort());
    await authenticateWith(
      scriptedSession({ configDir, accountId: ACCOUNT, answer: async () => ({ code: "c" }) })
        .session,
      {},
    );
    expect(gapi.generateAuthUrl.mock.calls[0][0]).toMatchObject({
      prompt: "consent",
      login_hint: ACCOUNT,
    });
  });

  test("a renewal that authorized somebody else is refused before anything is written", async () => {
    const port = await freePort();
    const configDir = await configDirWithClient(port);
    const { session } = scriptedSession({
      configDir,
      accountId: "jamie.lopez@example.com",
      answer: async () => ({ code: "code" }),
    });

    const failure = await authenticateWith(session, {}).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(AuthFailure);
    expect((failure as AuthFailure).code).toBe("identity-mismatch");
    expect(existsSync(join(configDir, "google", ACCOUNT))).toBe(false);
    expect(existsSync(join(configDir, "google", "jamie.lopez@example.com"))).toBe(false);
  });

  test("the token file that predates per-account storage is removed", async () => {
    const port = await freePort();
    const configDir = await configDirWithClient(port);
    const legacy = join(configDir, "google-tokens.json");
    await writeFile(legacy, JSON.stringify({ refresh_token: "old" }));

    await authenticateWith(
      scriptedSession({ configDir, answer: async () => ({ code: "c" }) }).session,
      {},
    );

    expect(existsSync(legacy)).toBe(false);
  });

  test("a grant missing some of what was asked for connects, and says so", async () => {
    const port = await freePort();
    const configDir = await configDirWithClient(port);
    gapi.getToken.mockResolvedValue({
      tokens: { refresh_token: "refresh-token", scope: SCOPES[0] },
    });

    const result = await authenticateWith(
      scriptedSession({ configDir, answer: async () => ({ code: "c" }) }).session,
      {},
    );

    expect(result.accounts[0].state).toEqual({ status: "connected", scopes: [SCOPES[0]] });
    expect(result.notices?.[0].detail).toContain(SCOPES[1]);
  });

  test("no client credentials is the first-run state, not a flow failure", async () => {
    const configDir = await makeConfigDir();
    const { session } = scriptedSession({ configDir });

    const failure = await authenticateWith(session, {}).catch((err: unknown) => err);

    expect(isMissingCredentialsError(failure)).toBe(true);
  });
});

describe("Google authenticate failure vocabulary", () => {
  /** Run the flow to whatever it fails with, answering with `params`. */
  async function failureFrom(
    params: Record<string, string>,
    options: { accountId?: string } = {},
  ): Promise<AuthFailure> {
    const port = await freePort();
    const configDir = await configDirWithClient(port);
    const { session } = scriptedSession({
      configDir,
      accountId: options.accountId,
      answer: async (challenge) => {
        await completeInBrowser(challenge, port, params);
        return await new Promise<never>(() => {});
      },
    });
    const err = await authenticateWith(session, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthFailure);
    return err as AuthFailure;
  }

  test("the operator declining at the consent screen is `denied`", async () => {
    const failure = await failureFrom({ error: "access_denied" });
    expect(failure.code).toBe("denied");
    expect(failure.remedy).toBeTruthy();
  });

  test("a refusal nobody in this flow made carries Google's own name for it", async () => {
    const failure = await failureFrom({ error: "admin_policy_enforced" });
    expect(failure.code).toBe("unknown");
    expect(failure.message).toContain("admin_policy_enforced");
    expect(failure.remedy).toBeTruthy();
  });

  test("an authorization for another sign-in attempt is refused", async () => {
    const port = await freePort();
    const configDir = await configDirWithClient(port);
    const { session } = scriptedSession({
      configDir,
      answer: async (challenge) => {
        const query = new URLSearchParams({ code: "abc", state: "some-other-attempt" });
        await fetch(`http://127.0.0.1:${port}/oauth2callback?${query.toString()}`);
        return await new Promise<never>(() => {});
      },
    });

    const failure = (await authenticateWith(session, {}).catch(
      (err: unknown) => err,
    )) as AuthFailure;

    expect(failure).toBeInstanceOf(AuthFailure);
    expect(failure.code).toBe("unknown");
    expect(failure.remedy).toBeTruthy();
  });

  test("a state that does not match the one this attempt minted is refused", async () => {
    // The pasted-code path: the answer carries a state of its own, and it
    // belongs to a different sign-in.
    const port = await freePort();
    const configDir = await configDirWithClient(port);
    const { session } = scriptedSession({
      configDir,
      answer: async () => ({ code: "abc", state: "some-other-attempt" }),
    });

    const failure = (await authenticateWith(session, {}).catch(
      (err: unknown) => err,
    )) as AuthFailure;

    expect(failure.code).toBe("unknown");
    expect(gapi.getToken).not.toHaveBeenCalled();
  });

  test("a port something else holds is a local conflict, named", async () => {
    const { port, release } = await occupiedPort();
    try {
      const configDir = await configDirWithClient(port);
      const { session } = scriptedSession({ configDir });

      const failure = (await authenticateWith(session, {}).catch(
        (err: unknown) => err,
      )) as AuthFailure;

      expect(failure).toBeInstanceOf(AuthFailure);
      expect(failure.code).toBe("local-conflict");
      expect(failure.message).toContain(String(port));
    } finally {
      await release();
    }
  });

  test("nobody finishing the sign-in is a timeout, not an expired challenge", async () => {
    const port = await freePort();
    const configDir = await configDirWithClient(port);
    const { session } = scriptedSession({ configDir });

    const failure = (await authenticateWith(session, { timeoutMs: 25 }).catch(
      (err: unknown) => err,
    )) as AuthFailure;

    expect(failure).toBeInstanceOf(AuthFailure);
    expect(failure.code).toBe("timeout");
  });

  test("a spent or stale authorization code is an expired challenge", async () => {
    gapi.getToken.mockRejectedValue(
      Object.assign(new Error("invalid_grant"), {
        response: {
          data: {
            error: "invalid_grant",
            error_description: "the authorization code has already been used",
          },
        },
      }),
    );
    const failure = await failureFrom({ code: "abc" });
    expect(failure.code).toBe("challenge-expired");
  });

  test("an OAuth client Google will not accept is a rejected credential", async () => {
    gapi.getToken.mockRejectedValue(
      Object.assign(new Error("invalid_client"), {
        response: { data: { error: "invalid_client" } },
      }),
    );
    const failure = await failureFrom({ code: "abc" });
    expect(failure.code).toBe("credential-rejected");
  });

  test("Google being unreachable is retryable, not a bad credential", async () => {
    gapi.getToken.mockRejectedValue(new Error("getaddrinfo ENOTFOUND oauth2.googleapis.com"));
    const failure = await failureFrom({ code: "abc" });
    expect(failure.code).toBe("unavailable");
  });

  test("an exchange failure with nothing to go on stays unknown", async () => {
    gapi.getToken.mockRejectedValue(new Error("something else entirely"));
    const failure = await failureFrom({ code: "abc" });
    expect(failure.code).toBe("unknown");
  });

  test("a grant too narrow to name its own account asks for a wider one", async () => {
    gapi.getProfile.mockRejectedValue(
      Object.assign(new Error("Request had insufficient authentication scopes."), { code: 403 }),
    );
    const failure = await failureFrom({ code: "abc" });
    expect(failure.code).toBe("credential-rejected");
    expect(failure.remedy).toContain("ticked");
  });

  test("Gmail being unwell while naming the account is retryable", async () => {
    gapi.getProfile.mockRejectedValue(Object.assign(new Error("backend error"), { code: 503 }));
    const failure = await failureFrom({ code: "abc" });
    expect(failure.code).toBe("unavailable");
  });

  test("an authorization with no account behind it stays unknown", async () => {
    gapi.getProfile.mockResolvedValue({ data: {} });
    const failure = await failureFrom({ code: "abc" });
    expect(failure.code).toBe("unknown");
  });

  test("tokens that cannot be stored are reported as such, by their own class", async () => {
    const port = await freePort();
    const configDir = await configDirWithClient(port);
    // A directory where the token file belongs makes the write fail.
    await mkdir(join(configDir, "google", ACCOUNT, "tokens.json"), { recursive: true });
    const { session } = scriptedSession({
      configDir,
      answer: async () => ({ code: "abc" }),
    });

    const failure = (await authenticateWith(session, {}).catch((err: unknown) => err)) as {
      name?: string;
      accountId?: string;
    };

    expect(failure.name).toBe("CredentialPersistError");
    expect(failure.accountId).toBe(ACCOUNT);
  });
});
