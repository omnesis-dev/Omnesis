// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearSecretFileKeyCacheForTests,
  createSecretStore,
  ensureInstallRootKey,
  OMNESIS_INSTALL_ROOT_KEY,
  writeSecretTextFile,
  createLogger,
} from "@omnesis/core";

/**
 * The real `writeSecretTextFile`, behind a spy. The provider is expected
 * to skip the write when the cache has not changed, and a spy is the only
 * way to tell "wrote the same bytes again" from "wrote nothing".
 */
const core = vi.hoisted(() => ({ writeSecretTextFile: vi.fn() }));

vi.mock("@omnesis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@omnesis/core")>();
  core.writeSecretTextFile.mockImplementation(actual.writeSecretTextFile);
  return { ...actual, writeSecretTextFile: core.writeSecretTextFile };
});

const msal = vi.hoisted(() => ({
  getAuthCodeUrl: vi.fn(),
  acquireTokenByCode: vi.fn(),
  acquireTokenSilent: vi.fn(),
  serialize: vi.fn(),
  getAllAccounts: vi.fn(),
  generatePkceCodes: vi.fn(),
}));

vi.mock("@azure/msal-node", async (importOriginal) => ({
  // Keep the real error types and codes — the provider classifies silent-token
  // failures against them.
  ...(await importOriginal<typeof import("@azure/msal-node")>()),
  PublicClientApplication: vi.fn().mockImplementation(function PublicClientApplication() {
    return {
      getAuthCodeUrl: msal.getAuthCodeUrl,
      acquireTokenByCode: msal.acquireTokenByCode,
      acquireTokenSilent: msal.acquireTokenSilent,
      getTokenCache: () => ({
        serialize: msal.serialize,
        deserialize: vi.fn(),
        getAllAccounts: msal.getAllAccounts,
        removeAccount: vi.fn(),
      }),
    };
  }),
  CryptoProvider: vi.fn().mockImplementation(function CryptoProvider() {
    return {
      generatePkceCodes: msal.generatePkceCodes,
    };
  }),
}));

import { InteractionRequiredAuthError } from "@azure/msal-node";
import { AuthFailure } from "@omnesis/source-sdk";
import {
  MicrosoftProvider,
  authFlow,
  authenticateWith,
  parseOAuthCallbackUrl,
} from "./provider.js";
import type { AddressInfo } from "node:net";
import type {
  AskableChallenge,
  AuthChallenge,
  AuthSession,
  ShowableChallenge,
} from "@omnesis/source-sdk";

const tmpDirs: string[] = [];

async function makeConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-outlook-auth-"));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.clearAllMocks();
  msal.getAuthCodeUrl.mockResolvedValue("https://login.example.com/auth");
  msal.acquireTokenByCode.mockResolvedValue({ account: { username: "user@example.com" } });
  msal.serialize.mockReturnValue('{"cache":true}');
  msal.acquireTokenSilent.mockResolvedValue({ accessToken: "access-token" });
  msal.getAllAccounts.mockResolvedValue([{ username: "user@example.com" }]);
  msal.generatePkceCodes.mockResolvedValue({
    verifier: "pkce-verifier",
    challenge: "pkce-challenge",
  });
});

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Microsoft OAuth flow", () => {
  test("parseOAuthCallbackUrl accepts only matching state", () => {
    expect(parseOAuthCallbackUrl("/auth/callback?code=abc&state=flow-1", "flow-1")).toEqual({
      kind: "code",
      code: "abc",
    });
    expect(parseOAuthCallbackUrl("/auth/callback?code=abc&state=other", "flow-1")).toMatchObject({
      kind: "error",
      status: 400,
    });
    expect(parseOAuthCallbackUrl("/elsewhere?code=abc&state=flow-1", "flow-1")).toMatchObject({
      kind: "not-found",
      status: 404,
    });
  });

  test("public callback mode uses flowId as state and exchanges the delivered code", async () => {
    const configDir = await makeConfigDir();
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

    expect(String(accountId)).toBe("user@example.com");
    expect(authUrls).toEqual(["https://login.example.com/auth"]);
    expect(msal.getAuthCodeUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri: "https://gateway.example.com/oauth/callback",
        codeChallenge: "pkce-challenge",
        codeChallengeMethod: "S256",
        state: "flow-1",
      }),
    );
    expect(msal.acquireTokenByCode).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "delivered-code",
        redirectUri: "https://gateway.example.com/oauth/callback",
        codeVerifier: "pkce-verifier",
      }),
    );

    const saved = await readFile(
      join(configDir, "outlook", "user@example.com", "tokens.json"),
      "utf-8",
    );
    expect(saved).toBe('{"cache":true}');
  });

  // This subprocess's stdout is the NDJSON protocol the parent reads, so a
  // flow with nowhere to publish its authorize URL must stop rather than
  // write one there.
  test("a caller with nowhere to publish the URL is refused", async () => {
    const configDir = await makeConfigDir();
    await expect(authFlow({ configDir, callbacks: {} })).rejects.toThrow(
      /requires a callbacks\.onAuthUrl handler/,
    );
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

  // Without an explicit prompt, Microsoft reuses the browser's signed-in
  // account, so adding a second mailbox silently re-authorizes the first and
  // registers nothing new.
  test("a first-time add forces the account chooser", async () => {
    const configDir = await makeConfigDir();
    await authFlow({
      configDir,
      callbacks: {
        publicBaseUrl: "https://gateway.example.com",
        flowId: "flow-1",
        onAuthUrl: () => {},
        receiveCode: async () => "delivered-code",
      },
    });

    const args = msal.getAuthCodeUrl.mock.calls[0][0];
    expect(args.prompt).toBe("select_account");
    expect(args.loginHint).toBeUndefined();
  });

  // A re-auth already knows which account it is refreshing, so it pins that
  // account instead of asking the user to pick it again.
  test("a re-auth pins the account it is refreshing and skips the chooser", async () => {
    const configDir = await makeConfigDir();
    await authFlow({
      configDir,
      callbacks: {
        publicBaseUrl: "https://gateway.example.com",
        flowId: "flow-1",
        accountId: "user@example.com",
        onAuthUrl: () => {},
        receiveCode: async () => "delivered-code",
      },
    });

    const args = msal.getAuthCodeUrl.mock.calls[0][0];
    expect(args.loginHint).toBe("user@example.com");
    expect(args.prompt).toBeUndefined();
  });
});

describe("Microsoft token cache persistence", () => {
  const ACCOUNT = "user@example.com";

  /** A provider holding the cache in `startingCache`, ready to be driven. */
  async function initializedProvider(startingCache = '{"cache":true}'): Promise<{
    provider: MicrosoftProvider;
    tokensPath: string;
  }> {
    const configDir = await makeConfigDir();
    const tokensPath = join(configDir, "outlook", ACCOUNT, "tokens.json");
    await mkdir(dirname(tokensPath), { recursive: true });
    await writeFile(tokensPath, startingCache);

    const provider = new MicrosoftProvider(ACCOUNT, configDir);
    await provider.initialize();
    core.writeSecretTextFile.mockClear();
    return { provider, tokensPath };
  }

  test("writes nothing while MSAL reports the cache unchanged", async () => {
    const { provider } = await initializedProvider();

    // `getAccessToken` runs once per Graph request — a single OneDrive
    // sync issues hundreds. Rewriting an unchanged cache each time is a
    // needless encrypt-and-fsync on the hot path.
    await Promise.all(Array.from({ length: 16 }, () => provider.getAccessToken()));

    expect(core.writeSecretTextFile).not.toHaveBeenCalled();
  });

  test("credentialState is offline and distinguishes missing, locked and observed revoked grants", async () => {
    const { provider, tokensPath } = await initializedProvider();
    msal.acquireTokenSilent.mockClear();
    await expect(provider.credentialState()).resolves.toEqual({ status: "connected" });
    expect(msal.acquireTokenSilent).not.toHaveBeenCalled();
    msal.acquireTokenSilent.mockRejectedValueOnce({ errorCode: "interaction_required" });
    await expect(provider.getAccessToken()).rejects.toThrow();
    await expect(provider.credentialState()).resolves.toEqual({ status: "revoked" });
    const configDir = dirname(dirname(dirname(tokensPath)));
    vi.stubEnv("OMNESIS_SECRET_STORE", "file");
    try {
      await ensureInstallRootKey({ configDir, backend: "file" });
      await writeSecretTextFile(tokensPath, '{"cache":true}', { configDir });
      await createSecretStore({ configDir, backend: "file" }).delete(OMNESIS_INSTALL_ROOT_KEY);
      clearSecretFileKeyCacheForTests();
      await expect(provider.credentialState()).resolves.toMatchObject({ status: "unknown" });
      await rm(tokensPath);
      await expect(provider.credentialState()).resolves.toEqual({ status: "never-connected" });
    } finally {
      vi.unstubAllEnvs();
      clearSecretFileKeyCacheForTests();
    }
  });

  test("commits a rotated cache exactly once across concurrent callers", async () => {
    const { provider, tokensPath } = await initializedProvider();
    msal.serialize.mockReturnValue('{"cache":"rotated"}');

    const tokens = await Promise.all(Array.from({ length: 16 }, () => provider.getAccessToken()));

    expect(tokens).toEqual(Array(16).fill("access-token"));
    expect(core.writeSecretTextFile).toHaveBeenCalledTimes(1);
    expect(await readFile(tokensPath, "utf-8")).toBe('{"cache":"rotated"}');

    // Settled again: the rotation is on disk, so nothing more is written.
    await provider.getAccessToken();
    expect(core.writeSecretTextFile).toHaveBeenCalledTimes(1);
  });

  test("commits a cache that was unreadable at startup", async () => {
    // An empty (or otherwise unloadable) file leaves the provider with no
    // baseline, so the first acquisition has to commit whatever MSAL holds.
    const { provider, tokensPath } = await initializedProvider("");

    await provider.getAccessToken();

    expect(core.writeSecretTextFile).toHaveBeenCalledTimes(1);
    expect(await readFile(tokensPath, "utf-8")).toBe('{"cache":true}');
  });

  test("a failed commit leaves the next one to retry rather than wedging", async () => {
    const { provider, tokensPath } = await initializedProvider();

    // A directory in the cache file's place makes the write fail.
    await rm(tokensPath);
    await mkdir(tokensPath, { recursive: true });
    msal.serialize.mockReturnValue('{"cache":"rotated"}');
    await expect(provider.getAccessToken()).rejects.toThrow();

    await rm(tokensPath, { recursive: true });
    await expect(provider.getAccessToken()).resolves.toBe("access-token");
    expect(await readFile(tokensPath, "utf-8")).toBe('{"cache":"rotated"}');
  });

  test("isAuthenticated commits a rotation it triggered", async () => {
    const { provider, tokensPath } = await initializedProvider();
    msal.serialize.mockReturnValue('{"cache":"rotated"}');

    await expect(provider.isAuthenticated()).resolves.toBe(true);

    expect(await readFile(tokensPath, "utf-8")).toBe('{"cache":"rotated"}');
  });

  // A silent-token failure is not evidence about the grant unless MSAL says the
  // user has to come back. Answering `false` for a network blip parks every
  // Microsoft source in needs-auth and pushes a re-auth reminder that nothing
  // about the credentials warranted.
  test("isAuthenticated holds while Microsoft is unreachable", async () => {
    const { provider } = await initializedProvider();
    msal.acquireTokenSilent.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(provider.isAuthenticated()).resolves.toBe(true);
  });

  test("isAuthenticated reports false when MSAL asks for interaction", async () => {
    const { provider } = await initializedProvider();
    for (const code of ["interaction_required", "consent_required", "no_tokens_found"]) {
      // MSAL builds `message` from the code itself; the description argument
      // is required but does not reach the thrown error.
      msal.acquireTokenSilent.mockRejectedValueOnce(
        new InteractionRequiredAuthError(code, "the token cache cannot satisfy this silently"),
      );
      await expect(provider.isAuthenticated()).resolves.toBe(false);
    }
  });

  test("isAuthenticated recognizes an interaction-required code without the class", async () => {
    // Two copies of msal-common in the dependency tree make `instanceof`
    // compare against a different class object and never match; the code alone
    // still identifies the failure.
    const { provider } = await initializedProvider();
    msal.acquireTokenSilent.mockRejectedValueOnce(
      Object.assign(new Error("the refresh token has expired"), {
        errorCode: "refresh_token_expired",
      }),
    );

    await expect(provider.isAuthenticated()).resolves.toBe(false);
  });

  test("getAccessToken surfaces an interaction-required failure as AuthError", async () => {
    // The same condition `isAuthenticated` reads as revoked, but on the path
    // every Outlook source actually calls. Typed as `AuthError` so mail,
    // calendar and OneDrive all recognize it as their shared account's
    // credential being dead, not a plain error the collector has to guess at
    // from its message.
    const { AuthError } = await import("./graph-client.js");
    const { provider } = await initializedProvider();
    msal.acquireTokenSilent.mockRejectedValueOnce(
      new InteractionRequiredAuthError(
        "consent_required",
        "the token cache cannot satisfy this silently",
      ),
    );

    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(AuthError);
  });

  test("getAccessToken leaves an unrelated silent-token failure untyped", async () => {
    const { AuthError } = await import("./graph-client.js");
    const { provider } = await initializedProvider();
    msal.acquireTokenSilent.mockRejectedValueOnce(new TypeError("fetch failed"));

    const error = await provider.getAccessToken().catch((err: unknown) => err);
    expect(error).not.toBeInstanceOf(AuthError);
  });

  test("disconnect waits for an in-flight write rather than letting it land later", async () => {
    const { provider } = await initializedProvider();
    msal.serialize.mockReturnValue('{"cache":"rotated"}');

    let releaseWrite!: () => void;
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => (writeStarted = resolve));
    core.writeSecretTextFile.mockImplementationOnce(async () => {
      writeStarted();
      await new Promise<void>((resolve) => (releaseWrite = resolve));
      return { encrypted: false };
    });

    const pending = provider.getAccessToken();
    await started;

    // The caller deletes the account directory once disconnect resolves.
    // Returning while a write is still in flight would let that write
    // recreate the directory — refresh token and all — and resurrect the
    // account on the next discovery pass.
    let disconnected = false;
    const disconnecting = provider.disconnect().then(() => (disconnected = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(disconnected).toBe(false);

    releaseWrite();
    await disconnecting;
    await pending;
    expect(disconnected).toBe(true);
  });
});

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
  publicBaseUrl?: string;
  flowId?: string;
  answer?: (challenge: AskableChallenge) => Promise<Record<string, unknown>>;
}): ScriptedSession {
  const shown: AuthChallenge[] = [];
  const asked: AskableChallenge[] = [];
  const session: AuthSession = {
    reason: options.accountId ? "reauthenticate" : "connect",
    flowId: options.flowId ?? "flow-1",
    accountId: options.accountId,
    // The host withholds the origin when the attempt has no id, so a session
    // that offers one always carries a flow id too.
    publicBaseUrl: options.publicBaseUrl,
    supplied: {},
    host: {
      log: createLogger("test:microsoft"),
      now: () => new Date(),
      stateDir: join(options.configDir, "outlook"),
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
 * The redirect this run's listener binds, with the state the flow minted.
 *
 * MSAL's `getAuthCodeUrl` is the only place the state reaches, so the mock
 * hands it back through here rather than through a URL a test would parse.
 */
function captureState(): () => string {
  let captured = "";
  msal.getAuthCodeUrl.mockImplementation(async (args: { state: string }) => {
    captured = args.state;
    return "https://login.example.com/auth";
  });
  return () => captured;
}

describe("Microsoft authenticate", () => {
  const ACCOUNT = "user@example.com";

  test("the browser's redirect is caught on the port the flow is already holding", async () => {
    const port = await freePort();
    const configDir = await makeConfigDir();
    const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
    const stateOf = captureState();
    let browserSaw = "";
    const { session, shown, asked } = scriptedSession({
      configDir,
      // Answering the instant the redirect is shown is the whole point: an
      // operator already signed in completes consent in under a second, and a
      // listener bound afterwards would never see it.
      answer: async () => {
        const query = new URLSearchParams({ code: "browser-code", state: stateOf() });
        const response = await fetch(`http://127.0.0.1:${port}/auth/callback?${query}`);
        browserSaw = await response.text();
        return await new Promise<never>(() => {});
      },
    });

    const result = await authenticateWith(session, { redirectUri });

    expect(browserSaw).toBe("Authentication successful! You can close this tab.");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: "redirect", via: "loopback" });
    expect(shown.map((c) => c.kind)).toContain("wait");
    expect(msal.acquireTokenByCode).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "browser-code",
        redirectUri,
        codeVerifier: "pkce-verifier",
      }),
    );
    expect(result.accounts).toEqual([{ accountId: ACCOUNT, state: { status: "connected" } }]);

    const saved = await readFile(join(configDir, "outlook", ACCOUNT, "tokens.json"), "utf-8");
    expect(saved).toBe('{"cache":true}');
  });

  test("a code brought back by hand finishes the same flow", async () => {
    // The browser is on another machine, so nothing reaches the loopback
    // listener and the operator pastes the code out of the address bar.
    const port = await freePort();
    const configDir = await makeConfigDir();
    const { session } = scriptedSession({ configDir, answer: async () => ({ code: "pasted" }) });

    const result = await authenticateWith(session, {
      redirectUri: `http://127.0.0.1:${port}/auth/callback`,
    });

    expect(msal.acquireTokenByCode).toHaveBeenCalledWith(
      expect.objectContaining({ code: "pasted" }),
    );
    expect(result.accounts[0].accountId).toBe(ACCOUNT);
  });

  test("an install with a reachable origin sends the browser to the gateway", async () => {
    const configDir = await makeConfigDir();
    const { session, asked } = scriptedSession({
      configDir,
      publicBaseUrl: "https://gateway.example.com/",
      flowId: "flow-7",
      answer: async () => ({ code: "delivered-code" }),
    });

    const result = await authenticateWith(session, {});

    expect(asked[0]).toMatchObject({ kind: "redirect", via: "gateway" });
    expect(msal.getAuthCodeUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri: "https://gateway.example.com/oauth/callback",
        codeChallenge: "pkce-challenge",
        codeChallengeMethod: "S256",
        // The gateway routes the callback back by the id of the attempt it
        // belongs to, so that id is what the redirect has to carry.
        state: "flow-7",
      }),
    );
    expect(msal.acquireTokenByCode).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "delivered-code",
        redirectUri: "https://gateway.example.com/oauth/callback",
      }),
    );
    expect(result.accounts[0].accountId).toBe(ACCOUNT);
  });

  test("the gateway path binds nothing on this machine", async () => {
    // Proved by holding port 3001 throughout: a flow that still bound a
    // loopback listener would fail with a local conflict.
    const configDir = await makeConfigDir();
    const { port, release } = await occupiedPort();
    try {
      const result = await authenticateWith(
        scriptedSession({
          configDir,
          publicBaseUrl: "https://gateway.example.com",
          answer: async () => ({ code: "delivered-code" }),
        }).session,
        { redirectUri: `http://127.0.0.1:${port}/auth/callback` },
      );
      expect(result.accounts[0].accountId).toBe(ACCOUNT);
    } finally {
      await release();
    }
  });

  // Without an explicit prompt, Microsoft reuses the browser's signed-in
  // account, so adding a second mailbox silently re-authorizes the first.
  test("a first-time add forces the account chooser", async () => {
    const configDir = await makeConfigDir();
    await authenticateWith(
      scriptedSession({
        configDir,
        publicBaseUrl: "https://gateway.example.com",
        answer: async () => ({ code: "c" }),
      }).session,
      {},
    );
    const args = msal.getAuthCodeUrl.mock.calls[0][0];
    expect(args.prompt).toBe("select_account");
    expect(args.loginHint).toBeUndefined();
  });

  test("a renewal pins the account it is refreshing and skips the chooser", async () => {
    const configDir = await makeConfigDir();
    await authenticateWith(
      scriptedSession({
        configDir,
        accountId: ACCOUNT,
        publicBaseUrl: "https://gateway.example.com",
        answer: async () => ({ code: "c" }),
      }).session,
      {},
    );
    const args = msal.getAuthCodeUrl.mock.calls[0][0];
    expect(args.loginHint).toBe(ACCOUNT);
    expect(args.prompt).toBeUndefined();
  });

  test("a renewal that signed in as somebody else is refused before anything is written", async () => {
    const configDir = await makeConfigDir();
    const { session } = scriptedSession({
      configDir,
      accountId: "jamie.lopez@example.com",
      publicBaseUrl: "https://gateway.example.com",
      answer: async () => ({ code: "c" }),
    });

    const failure = await authenticateWith(session, {}).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(AuthFailure);
    expect((failure as AuthFailure).code).toBe("identity-mismatch");
    expect(existsSync(join(configDir, "outlook", ACCOUNT))).toBe(false);
    expect(existsSync(join(configDir, "outlook", "jamie.lopez@example.com"))).toBe(false);
  });

  test("the scopes the sign-in asks for are the ones the silent refresh uses", async () => {
    // One shared constant, in both places. A drift between them degrades an
    // existing grant to needs-auth at the next silent acquisition, with
    // nothing in the flow that ran to say why.
    const configDir = await makeConfigDir();
    await authenticateWith(
      scriptedSession({
        configDir,
        publicBaseUrl: "https://gateway.example.com",
        answer: async () => ({ code: "c" }),
      }).session,
      {},
    );
    const requested = msal.getAuthCodeUrl.mock.calls[0][0].scopes;
    expect(msal.acquireTokenByCode.mock.calls[0][0].scopes).toEqual(requested);

    const tokensPath = join(configDir, "outlook", ACCOUNT, "tokens.json");
    expect(existsSync(tokensPath)).toBe(true);
    const provider = new MicrosoftProvider(ACCOUNT, configDir);
    await provider.initialize();
    await provider.getAccessToken();
    expect(msal.acquireTokenSilent.mock.calls[0][0].scopes).toEqual(requested);
  });
});

describe("Microsoft authenticate failure vocabulary", () => {
  /** Run the loopback flow to whatever it fails with, answering with `params`. */
  async function failureFrom(params: Record<string, string>): Promise<AuthFailure> {
    const port = await freePort();
    const configDir = await makeConfigDir();
    const stateOf = captureState();
    const { session } = scriptedSession({
      configDir,
      answer: async () => {
        const query = new URLSearchParams({ state: stateOf(), ...params });
        await fetch(`http://127.0.0.1:${port}/auth/callback?${query}`);
        return await new Promise<never>(() => {});
      },
    });
    const err = await authenticateWith(session, {
      redirectUri: `http://127.0.0.1:${port}/auth/callback`,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthFailure);
    return err as AuthFailure;
  }

  test("the operator declining at the consent screen is `denied`", async () => {
    const failure = await failureFrom({ error: "access_denied" });
    expect(failure.code).toBe("denied");
    expect(failure.remedy).toBeTruthy();
  });

  test("a refusal nobody in this flow made carries Microsoft's own name for it", async () => {
    const failure = await failureFrom({ error: "invalid_request" });
    expect(failure.code).toBe("unknown");
    expect(failure.message).toContain("invalid_request");
    expect(failure.remedy).toBeTruthy();
  });

  test("a sign-in belonging to a different attempt is refused", async () => {
    const port = await freePort();
    const configDir = await makeConfigDir();
    const { session } = scriptedSession({
      configDir,
      answer: async () => {
        const query = new URLSearchParams({ code: "abc", state: "some-other-attempt" });
        await fetch(`http://127.0.0.1:${port}/auth/callback?${query}`);
        return await new Promise<never>(() => {});
      },
    });

    const failure = (await authenticateWith(session, {
      redirectUri: `http://127.0.0.1:${port}/auth/callback`,
    }).catch((err: unknown) => err)) as AuthFailure;

    expect(failure).toBeInstanceOf(AuthFailure);
    expect(failure.code).toBe("unknown");
    expect(failure.remedy).toBeTruthy();
  });

  test("a pasted answer carrying another attempt's state is refused", async () => {
    const configDir = await makeConfigDir();
    const { session } = scriptedSession({
      configDir,
      publicBaseUrl: "https://gateway.example.com",
      answer: async () => ({ code: "abc", state: "some-other-attempt" }),
    });

    const failure = (await authenticateWith(session, {}).catch(
      (err: unknown) => err,
    )) as AuthFailure;

    expect(failure.code).toBe("unknown");
    expect(msal.acquireTokenByCode).not.toHaveBeenCalled();
  });

  // Without an `error` listener a bind failure is an uncaught exception that
  // kills the auth subprocess with no terminal event, which the parent can
  // only report as a flow that ended without completing.
  test("a port something else holds is a local conflict, named", async () => {
    const { port, release } = await occupiedPort();
    try {
      const configDir = await makeConfigDir();
      const { session } = scriptedSession({ configDir });

      const failure = (await authenticateWith(session, {
        redirectUri: `http://127.0.0.1:${port}/auth/callback`,
      }).catch((err: unknown) => err)) as AuthFailure;

      expect(failure).toBeInstanceOf(AuthFailure);
      expect(failure.code).toBe("local-conflict");
      expect(failure.message).toContain(String(port));
    } finally {
      await release();
    }
  });

  test("nobody finishing the sign-in is a timeout, not an expired challenge", async () => {
    const port = await freePort();
    const configDir = await makeConfigDir();
    const { session } = scriptedSession({ configDir });

    const failure = (await authenticateWith(session, {
      redirectUri: `http://127.0.0.1:${port}/auth/callback`,
      timeoutMs: 25,
    }).catch((err: unknown) => err)) as AuthFailure;

    expect(failure).toBeInstanceOf(AuthFailure);
    expect(failure.code).toBe("timeout");
  });

  /** Run the gateway flow, with MSAL refusing the exchange. */
  async function exchangeFailure(err: unknown): Promise<AuthFailure> {
    msal.acquireTokenByCode.mockRejectedValue(err);
    const configDir = await makeConfigDir();
    const failure = await authenticateWith(
      scriptedSession({
        configDir,
        publicBaseUrl: "https://gateway.example.com",
        answer: async () => ({ code: "abc" }),
      }).session,
      {},
    ).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AuthFailure);
    return failure as AuthFailure;
  }

  test("a spent or stale authorization code is an expired challenge", async () => {
    const failure = await exchangeFailure(
      Object.assign(new Error("the code has expired"), { errorCode: "invalid_grant" }),
    );
    expect(failure.code).toBe("challenge-expired");
  });

  test("an app registration Microsoft will not accept is a rejected credential", async () => {
    const failure = await exchangeFailure(
      Object.assign(new Error("client not found"), { errorCode: "unauthorized_client" }),
    );
    expect(failure.code).toBe("credential-rejected");
  });

  test("consent withheld during the exchange is `denied`", async () => {
    const failure = await exchangeFailure(
      Object.assign(new Error("the user refused"), { errorCode: "access_denied" }),
    );
    expect(failure.code).toBe("denied");
  });

  test("Microsoft being unreachable is retryable, not a bad credential", async () => {
    const failure = await exchangeFailure(new TypeError("fetch failed"));
    expect(failure.code).toBe("unavailable");
  });

  test("an exchange failure with nothing to go on stays unknown", async () => {
    const failure = await exchangeFailure(new Error("something else entirely"));
    expect(failure.code).toBe("unknown");
  });

  test("a sign-in with no account behind it stays unknown", async () => {
    msal.acquireTokenByCode.mockResolvedValue({ account: null });
    const configDir = await makeConfigDir();
    const failure = (await authenticateWith(
      scriptedSession({
        configDir,
        publicBaseUrl: "https://gateway.example.com",
        answer: async () => ({ code: "abc" }),
      }).session,
      {},
    ).catch((err: unknown) => err)) as AuthFailure;

    expect(failure).toBeInstanceOf(AuthFailure);
    expect(failure.code).toBe("unknown");
  });

  test("a token cache that cannot be stored is reported by its own class", async () => {
    const configDir = await makeConfigDir();
    // A directory where the cache file belongs makes the write fail.
    await mkdir(join(configDir, "outlook", "user@example.com", "tokens.json"), {
      recursive: true,
    });

    const failure = (await authenticateWith(
      scriptedSession({
        configDir,
        publicBaseUrl: "https://gateway.example.com",
        answer: async () => ({ code: "abc" }),
      }).session,
      {},
    ).catch((err: unknown) => err)) as { name?: string; accountId?: string };

    expect(failure.name).toBe("CredentialPersistError");
    expect(failure.accountId).toBe("user@example.com");
  });
});
