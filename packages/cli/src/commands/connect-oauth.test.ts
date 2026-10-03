// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IntegrationReauthorizationRequiredError,
  loadIntegrationCredentials,
  loadPendingAuthorization,
  savePendingAuthorization,
  type IntegrationCredentials,
  type PendingIntegrationAuthorization,
} from "@omnesis/agent-integration";

type OAuthFetch = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
type Provider = {
  readonly redirectUrl: string;
  state(): string;
  tokens(): Record<string, unknown> | undefined;
  codeVerifier(): string;
  saveClientInformation(value: Record<string, unknown>): void;
  saveCodeVerifier(value: string): void;
  saveTokens(value: Record<string, unknown>): void;
  invalidateCredentials(scope: "tokens"): void;
  redirectToAuthorization(url: URL): Promise<void>;
};

const mocks = vi.hoisted(() => ({
  /** The SDK's refresh-or-redirect pass (and its code exchange). */
  authorize: vi.fn<(provider: unknown, ...rest: unknown[]) => Promise<"AUTHORIZED" | "REDIRECT">>(),
  reissue: vi.fn<(provider: unknown) => Promise<void>>(),
  fetch: vi.fn<OAuthFetch>(),
  postJson: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(() => ({ status: 0 })),
}));
vi.mock("@omnesis/agent-integration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@omnesis/agent-integration")>();
  return {
    ...actual,
    authorizeIntegrationOAuth: mocks.authorize,
    authorizeIntegrationOAuthWithCredentialLock: mocks.authorize,
    reissueIntegrationOAuthTokens: mocks.reissue,
    integrationOAuthFetch: () => mocks.fetch,
    PinnedGatewayHttpClient: class {
      postJson(...args: unknown[]): Promise<unknown> {
        return mocks.postJson(...args);
      }
    },
  };
});

const { authorizeHarness, HarnessApprovalRequiredError } = await import("./connect-oauth.js");

const GATEWAY = "http://127.0.0.1:17699";
const CLIENT = "client_fictional";
const homes: string[] = [];

function seed(tokens: Record<string, unknown>, client: Record<string, unknown> = {}): string {
  const home = mkdtempSync(join(tmpdir(), "omnesis-connect-oauth-"));
  homes.push(home);
  mkdirSync(join(home, "omnesis"), { recursive: true });
  writeFileSync(
    credentialsPath(home),
    `${JSON.stringify({
      gatewayUrl: GATEWAY,
      deliveryToken: "omn_delivery_fictional",
      ingestionToken: "omn_ingestion_fictional",
      managementToken: "omn_management_fictional",
      oauth: {
        redirectUri: "http://127.0.0.1:0/callback",
        clientInformation: { client_id: CLIENT, ...client },
        tokens,
        discoveryState: { authorizationServerUrl: GATEWAY },
      },
    })}\n`,
    { mode: 0o600 },
  );
  return home;
}

function credentialsPath(home: string): string {
  return join(home, "omnesis", "integration.json");
}

function load(home: string): IntegrationCredentials {
  return loadIntegrationCredentials(credentialsPath(home));
}

function record(
  home: string,
  overrides: Partial<PendingIntegrationAuthorization> = {},
): PendingIntegrationAuthorization {
  const pending: PendingIntegrationAuthorization = {
    gatewayUrl: GATEWAY,
    clientId: CLIENT,
    handle: "omn_oar_earlier_fictional",
    consentUrl: `${GATEWAY}/oauth/consent?request=omn_oar_earlier_fictional`,
    expiresAt: Date.now() + 5 * 60_000,
    codeVerifier: "earlier-verifier-fictional",
    state: "earlier-state-fictional-0123456789-0123456789",
    ...overrides,
  };
  savePendingAuthorization(credentialsPath(home), pending);
  return pending;
}

/** A gateway's OAuth routes, answering status from `statuses` in turn. */
function gateway(statuses: Array<string | number | Error>, decided: URL | (() => URL)): void {
  mocks.fetch.mockImplementation(async (input) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.pathname === "/oauth/authorize/status") {
      const next = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
      if (next instanceof Error) throw next;
      if (typeof next === "number") return new Response("{}", { status: next });
      return Response.json({ status: next, expiresAt: Date.now() + 60_000 });
    }
    if (url.pathname === "/oauth/authorize/complete") {
      return new Response(null, {
        status: 303,
        headers: { location: (typeof decided === "function" ? decided() : decided).toString() },
      });
    }
    if (url.pathname === "/oauth/authorize") {
      return new Response(null, {
        status: 303,
        headers: { location: "/oauth/consent?request=omn_oar_new_fictional" },
      });
    }
    if (url.pathname === "/oauth/consent") return new Response("Enter ABCD-EFGH");
    throw new Error(`Unexpected OAuth request to ${url.pathname}`);
  });
}

/** What the SDK does when it needs a browser: prepare PKCE and state, then redirect. */
async function redirect(provider: unknown): Promise<"REDIRECT"> {
  const oauth = provider as Provider;
  oauth.saveCodeVerifier("new-verifier-fictional");
  const state = oauth.state();
  const url = new URL(`${GATEWAY}/oauth/authorize`);
  url.searchParams.set("client_id", CLIENT);
  url.searchParams.set("state", state);
  await oauth.redirectToAuthorization(url);
  return "REDIRECT";
}

/** The SDK's code exchange: record the verifier it was given, save tokens. */
const exchangedWith: string[] = [];
async function exchange(provider: unknown, ...rest: unknown[]): Promise<"AUTHORIZED"> {
  const oauth = provider as Provider;
  expect(rest[2]).toBe("code_fictional");
  exchangedWith.push(oauth.codeVerifier());
  oauth.saveTokens({ access_token: "access_approved", refresh_token: "refresh_approved" });
  return "AUTHORIZED";
}

function authorizeRequests(): number {
  return mocks.fetch.mock.calls.filter(([input]) => {
    const url = input instanceof URL ? input : new URL(String(input));
    return url.pathname === "/oauth/authorize";
  }).length;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  exchangedWith.length = 0;
  mocks.postJson.mockResolvedValue({ binding: "binding_fictional" });
  mocks.reissue.mockImplementation(async () => {
    throw new IntegrationReauthorizationRequiredError("hermes");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("an unattended refresh", () => {
  it("leaves a token set on file to the plugin and asks the gateway nothing", async () => {
    const home = seed({ access_token: "access_live", refresh_token: "refresh_live" });

    await authorizeHarness(home, "hermes", load(home), { consent: false });

    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.reissue).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(load(home).oauth.tokens).toEqual({
      access_token: "access_live",
      refresh_token: "refresh_live",
    });
  });

  it("re-issues a missing token set headlessly instead of opening a request", async () => {
    const home = seed({});
    mocks.reissue.mockImplementation(async (provider) => {
      (provider as Provider).saveTokens({
        access_token: "access_reissued",
        refresh_token: "refresh_reissued",
      });
    });

    const result = await authorizeHarness(home, "hermes", load(home), { consent: false });

    expect(result.oauth.tokens).toMatchObject({ access_token: "access_reissued" });
    expect(authorizeRequests()).toBe(0);
  });

  it("fails naming the repair when nothing is approved, and changes nothing on file", async () => {
    const home = seed({});
    const before = load(home);

    await expect(
      authorizeHarness(home, "hermes", before, { consent: false }),
    ).rejects.toBeInstanceOf(HarnessApprovalRequiredError);
    await expect(authorizeHarness(home, "hermes", before, { consent: false })).rejects.toThrow(
      /omnesis connect hermes --refresh/u,
    );

    expect(authorizeRequests()).toBe(0);
    expect(mocks.postJson).not.toHaveBeenCalled();
    expect(load(home)).toEqual(before);
  });

  it("reports a gateway it could not reach rather than asking for an approval", async () => {
    const home = seed({});
    mocks.reissue.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(authorizeHarness(home, "hermes", load(home), { consent: false })).rejects.toThrow(
      /ECONNREFUSED/u,
    );
    expect(authorizeRequests()).toBe(0);
  });

  it("collects an approval given after the run that requested it stopped", async () => {
    const home = seed({});
    const pending = record(home);
    gateway(
      ["approved"],
      new URL(`http://127.0.0.1:1/callback?code=code_fictional&state=${pending.state}`),
    );
    mocks.authorize.mockImplementation(exchange);

    const result = await authorizeHarness(home, "hermes", load(home), { consent: false });

    expect(result.oauth.tokens).toMatchObject({ access_token: "access_approved" });
    expect(exchangedWith).toEqual([pending.codeVerifier]);
    expect(authorizeRequests()).toBe(0);
    expect(mocks.reissue).not.toHaveBeenCalled();
    expect(loadPendingAuthorization(credentialsPath(home))).toBeNull();
  });
});

describe("an interactive refresh", () => {
  it("prefers the headless re-issue to a new approval when the refresh token is spent", async () => {
    const home = seed({ access_token: "access_old", refresh_token: "refresh_spent" });
    // The SDK's answer to `invalid_grant`: invalidate the tokens, then ask for a browser.
    mocks.authorize.mockImplementation(async (provider) => {
      (provider as Provider).invalidateCredentials("tokens");
      return redirect(provider);
    });
    mocks.reissue.mockImplementation(async (provider) => {
      (provider as Provider).saveTokens({
        access_token: "access_reissued",
        refresh_token: "refresh_reissued",
      });
    });

    const result = await authorizeHarness(home, "hermes", load(home));

    expect(result.oauth.tokens).toMatchObject({ access_token: "access_reissued" });
    expect(result.oauth.codeVerifier).toBeUndefined();
    expect(authorizeRequests()).toBe(0);
  });

  it("keeps the stored tokens when neither the refresh nor the re-issue reaches the gateway", async () => {
    const home = seed({ access_token: "access_old", refresh_token: "refresh_old" });
    mocks.authorize.mockImplementation(async (provider) => {
      (provider as Provider).invalidateCredentials("tokens");
      return redirect(provider);
    });
    mocks.reissue.mockRejectedValue(new Error("The gateway did not answer in time"));

    await expect(authorizeHarness(home, "hermes", load(home))).rejects.toThrow(/did not answer/u);

    const after = load(home).oauth;
    expect(after.tokens).toEqual({ access_token: "access_old", refresh_token: "refresh_old" });
    expect(after.codeVerifier).toBeUndefined();
    expect(authorizeRequests()).toBe(0);
  });

  it("records a new request before waiting, so an interrupted run leaves it findable", async () => {
    const home = seed({});
    mocks.authorize.mockImplementation(redirect);
    const stop = new Error("interrupted");
    // The run is cut short loading the consent page, after the request exists.
    mocks.fetch.mockImplementationOnce(
      async () =>
        new Response(null, {
          status: 303,
          headers: { location: "/oauth/consent?request=omn_oar_new_fictional" },
        }),
    );
    mocks.fetch.mockImplementationOnce(async () => {
      throw stop;
    });

    await expect(authorizeHarness(home, "hermes", load(home))).rejects.toBe(stop);

    expect(loadPendingAuthorization(credentialsPath(home))).toMatchObject({
      clientId: CLIENT,
      handle: "omn_oar_new_fictional",
      codeVerifier: "new-verifier-fictional",
    });
  });

  it("waits on the request already open instead of opening a second one", async () => {
    const home = seed({});
    const pending = record(home);
    // The plugin's SDK has since overwritten the verifier in the credential
    // file; the record's copy is the one the request was opened with.
    const current = load(home);
    writeFileSync(
      credentialsPath(home),
      JSON.stringify({
        ...current,
        oauth: { ...current.oauth, codeVerifier: "someone-elses-verifier" },
      }),
    );
    gateway(
      ["pending", "pending", "approved"],
      new URL(`http://127.0.0.1:1/callback?code=code_fictional&state=${pending.state}`),
    );
    mocks.authorize.mockImplementation(exchange);

    const result = await authorizeHarness(home, "hermes", load(home));

    expect(result.oauth.tokens).toMatchObject({ access_token: "access_approved" });
    expect(exchangedWith).toEqual([pending.codeVerifier]);
    expect(authorizeRequests()).toBe(0);
    expect(mocks.reissue).not.toHaveBeenCalled();
    expect(loadPendingAuthorization(credentialsPath(home))).toBeNull();
  }, 15_000);

  it("keeps polling through a stalled gateway until the operator decides", async () => {
    const home = seed({});
    const pending = record(home);
    gateway(
      ["pending", 503, new Error("socket hang up"), "approved"],
      new URL(`http://127.0.0.1:1/callback?code=code_fictional&state=${pending.state}`),
    );
    mocks.authorize.mockImplementation(exchange);

    const result = await authorizeHarness(home, "hermes", load(home));

    expect(result.oauth.tokens).toMatchObject({ access_token: "access_approved" });
    expect(authorizeRequests()).toBe(0);
  }, 15_000);

  it("drops a request that expired and opens exactly one new one", async () => {
    const home = seed({});
    record(home);
    let state = "";
    mocks.authorize
      .mockImplementationOnce(async (provider) => {
        state = (provider as Provider).state();
        return redirect(provider);
      })
      .mockImplementation(exchange);
    gateway(
      [404, "approved"],
      () => new URL(`http://127.0.0.1:1/callback?code=code_fictional&state=${state}`),
    );

    const result = await authorizeHarness(home, "hermes", load(home));

    expect(result.oauth.tokens).toMatchObject({ access_token: "access_approved" });
    expect(authorizeRequests()).toBe(1);
    expect(exchangedWith).toEqual(["new-verifier-fictional"]);
    expect(loadPendingAuthorization(credentialsPath(home))).toBeNull();
  });

  it("ends the record when the request expires unapproved", async () => {
    const home = seed({});
    record(home);
    gateway(["pending", 404], new URL("http://127.0.0.1:1/callback"));

    await expect(authorizeHarness(home, "hermes", load(home))).rejects.toThrow(/expired/u);

    expect(loadPendingAuthorization(credentialsPath(home))).toBeNull();
  });
});
