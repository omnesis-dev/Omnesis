// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearSecretFileKeyCacheForTests,
  ensureInstallRootKey,
  isCredentialPersistError,
  isMissingCredentialsError,
} from "@omnesis/core";
import { AUTH_CHALLENGE_KINDS, AuthFailure, isRetryable } from "@omnesis/source-sdk";
import { fakeProviderHost } from "@omnesis/source-sdk/testing";
import {
  discoverAccounts,
  hasCredentials,
  loadItemCredential,
  saveItemCredential,
} from "./items.js";
import { rememberPendingLink } from "./pending-links.js";
import { authenticate, authFlow, cleanupCredentials, loadCredentials } from "./provider.js";
import { PLAID_RATE_LIMIT_RETRY_MS } from "./client.js";
import type { LinkPollTiming } from "./provider.js";
import type {
  AskableChallenge,
  AuthChallengeKind,
  AuthFlowCallbacks,
  AuthSession,
  ShowableChallenge,
} from "@omnesis/source-sdk";

let configDir: string;
let oldSecretStore: string | undefined;

beforeEach(() => {
  oldSecretStore = process.env.OMNESIS_SECRET_STORE;
  process.env.OMNESIS_SECRET_STORE = "file";
  configDir = mkdtempSync(join(tmpdir(), "omnesis-plaid-test-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  clearSecretFileKeyCacheForTests();
  if (oldSecretStore === undefined) delete process.env.OMNESIS_SECRET_STORE;
  else process.env.OMNESIS_SECRET_STORE = oldSecretStore;
  rmSync(configDir, { recursive: true, force: true });
});

function writeCreds(environment = "sandbox", countries = "US,CA"): void {
  writeFileSync(
    join(configDir, "plaid-credentials.json"),
    JSON.stringify({
      client_id: "test-client",
      secret: "test-secret",
      environment,
      countries,
    }),
    { mode: 0o600 },
  );
}

/** One `/link/token/get` session, in the shape Plaid serves it. */
type Session = Record<string, unknown>;

/** A session that connected a bank. */
function linked(
  publicToken: string,
  institution?: { name: string; institution_id: string },
): Session {
  return {
    link_session_id: "sess-1",
    finished_at: "2026-05-15T12:00:05Z",
    results: { item_add_results: [{ public_token: publicToken, institution }] },
  };
}

/** A session the user abandoned, carrying Plaid's reason. */
function exited(displayMessage: string): Session {
  return {
    link_session_id: "sess-1",
    finished_at: "2026-05-15T12:00:05Z",
    exit: { error: { error_code: "USER_EXIT", display_message: displayMessage } },
  };
}

/** A session still in progress. */
const pending: Session = { link_session_id: "sess-1", finished_at: null };

interface FakeOpts {
  hostedUrl?: string | null;
  /** How `/link/token/create` refuses, when it does. */
  linkTokenError?: { status: number; errorCode?: string } | "network";
  /** `/link/token/get` responses, served one per poll; the last repeats. */
  sessions?: Session[][];
  /** `/link/token/get` answers for a specific token, as a sweep asks for. */
  sessionsFor?: Record<string, Session[]>;
  exchange?: unknown | ((publicToken: string) => unknown);
  institution?: unknown;
  /** The `item` body `/item/get` serves, or a server error instead. */
  itemGet?: { consent_expiration_time?: string | null } | "fails";
  remove?: { status: number; errorCode?: string } | "network";
  calls?: { path: string; body: Record<string, unknown> }[];
}

let nextLinkToken = 0;

/** A fake fetch routing the Plaid endpoints this provider uses to canned JSON. */
function fakeFetch(opts: FakeOpts): typeof fetch {
  const polls = [...(opts.sessions ?? [[linked("public-a")]])];
  // Plaid mints a distinct token per add; sharing one would let two adds
  // collide on a single pending record and hide a clobbering regression.
  const linkToken = `link-sandbox-${(nextLinkToken += 1)}`;
  return (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    opts.calls?.push({ path, body });
    const json = (value: unknown, status = 200): Response =>
      new Response(JSON.stringify(value), { status });

    if (path === "/link/token/create") {
      const failure = opts.linkTokenError;
      if (failure === "network") throw new TypeError("fetch failed");
      if (failure) {
        return json({ error_type: "INVALID_INPUT", error_code: failure.errorCode }, failure.status);
      }
      return json({
        link_token: linkToken,
        ...(opts.hostedUrl === null
          ? {}
          : { hosted_link_url: opts.hostedUrl ?? "https://hosted.plaid.com/link?token=abc" }),
      });
    }
    if (path === "/link/token/get") {
      const asked = String(body.link_token);
      const forToken = opts.sessionsFor?.[asked];
      if (forToken) return json({ link_token: asked, link_sessions: forToken });
      const next = polls.length > 1 ? polls.shift()! : polls[0];
      return json({ link_token: asked, link_sessions: next });
    }
    if (path === "/item/public_token/exchange") {
      const exchange =
        typeof opts.exchange === "function"
          ? (opts.exchange as (t: string) => unknown)(String(body.public_token))
          : opts.exchange;
      return json(exchange ?? { access_token: "access-a", item_id: "item-a" });
    }
    if (path === "/item/get") {
      if (opts.itemGet === "fails") return json({ error_code: "INTERNAL_SERVER_ERROR" }, 500);
      return json({ item: { item_id: "item-1", ...(opts.itemGet ?? {}) } });
    }
    if (path === "/institutions/get_by_id") {
      return json(opts.institution ?? { institution: { institution_id: "ins_a" } });
    }
    if (path === "/item/remove") {
      const remove = opts.remove ?? { status: 200 };
      if (remove === "network") throw new TypeError("fetch failed");
      return remove.status === 200
        ? json({ request_id: "req-remove" })
        : json(
            { error_type: "ITEM_ERROR", error_code: remove.errorCode ?? "INTERNAL_SERVER_ERROR" },
            remove.status,
          );
    }
    throw new Error(`fakeFetch: unexpected request ${path}`);
  }) as unknown as typeof fetch;
}

/** Callbacks that record the hosted URL the flow hands the client. */
function urlCallbacks(extra: Partial<AuthFlowCallbacks> = {}): {
  callbacks: AuthFlowCallbacks;
  urls: string[];
} {
  const urls: string[] = [];
  return { callbacks: { onAuthUrl: (u: string) => urls.push(u), ...extra }, urls };
}

/** Poll instantly, with a clock the test advances only by the timeout check. */
const fastPoll: LinkPollTiming = { pollIntervalMs: 0, sleep: () => Promise.resolve() };

/** Old enough that a sweep will act on it rather than wait out the add. */
const LONG_AGO = (): number => Date.now() - 60 * 60 * 1000;

/** Link sessions this host started and has not accounted for yet. */
function pendingRecords(): string[] {
  const dir = join(configDir, "plaid", ".pending-links");
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe("loadCredentials", () => {
  test("throws MissingCredentialsError when absent", async () => {
    await expect(loadCredentials(configDir)).rejects.toSatisfy(isMissingCredentialsError);
  });

  test("throws when the environment is not a recognized value", async () => {
    writeCreds("staging");
    await expect(loadCredentials(configDir)).rejects.toSatisfy(isMissingCredentialsError);
  });

  test("loads the app credential, parsing the country list", async () => {
    writeCreds("production", " gb , us ");
    const creds = await loadCredentials(configDir);
    expect(creds).toMatchObject({
      client_id: "test-client",
      secret: "test-secret",
      environment: "production",
    });
    expect(creds.countries).toEqual(["GB", "US"]);
  });

  test("an unusable country list falls back to the default markets", async () => {
    writeCreds("sandbox", "");
    expect((await loadCredentials(configDir)).countries).toEqual(["US", "CA"]);
  });
});

describe("authFlow — Plaid hosted sign-in", () => {
  test("hands the user Plaid's hosted URL and registers the bank it connects", async () => {
    writeCreds();
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const { callbacks, urls } = urlCallbacks();
    const ids = await authFlow(
      undefined,
      callbacks,
      configDir,
      {
        fetchImpl: fakeFetch({
          calls,
          sessions: [
            [pending],
            [linked("public-a", { name: "Northstar Bank", institution_id: "ins_a" })],
          ],
          institution: {
            institution: { institution_id: "ins_a", logo: "aGVsbG8=", primary_color: "#0055aa" },
          },
        }),
      },
      fastPoll,
    );

    expect(urls).toEqual(["https://hosted.plaid.com/link?token=abc"]);
    expect(ids.map(String)).toEqual(["item-a"]);

    // The token is minted for a hosted session, with the operator's countries.
    const create = calls.find((c) => c.path === "/link/token/create")!;
    expect(create.body.hosted_link).toEqual({});
    expect(create.body.country_codes).toEqual(["US", "CA"]);

    const stored = loadItemCredential("item-a", configDir);
    expect(stored?.institution_name).toBe("Northstar Bank");
    expect(stored?.institution_logo).toBe("aGVsbG8=");
    expect(stored?.institution_color).toBe("#0055aa");
    expect(discoverAccounts(configDir).map(String)).toEqual(["item-a"]);
  });

  test("polls until a session finishes rather than giving up on the first look", async () => {
    writeCreds();
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const { callbacks } = urlCallbacks();
    await authFlow(
      undefined,
      callbacks,
      configDir,
      { fetchImpl: fakeFetch({ calls, sessions: [[pending], [pending], [linked("public-a")]] }) },
      fastPoll,
    );
    // Three reads before the exchange: the flow kept asking while the session
    // was unfinished rather than failing the add on the first empty answer.
    // Counted up to the exchange because settling the add's own record reads
    // the token once more afterwards.
    const exchangeAt = calls.findIndex((c) => c.path === "/item/public_token/exchange");
    expect(exchangeAt).toBeGreaterThan(-1);
    const polls = calls.slice(0, exchangeAt).filter((c) => c.path === "/link/token/get");
    expect(polls).toHaveLength(3);
  });

  test("an add that times out leaves its Link token behind to be settled later", async () => {
    // Plaid creates the item the moment the sign-in finishes, which can be
    // after this add stopped listening. The token is the only handle to that.
    writeCreds();
    let clock = 0;
    await expect(
      authFlow(
        undefined,
        urlCallbacks().callbacks,
        configDir,
        { fetchImpl: fakeFetch({ sessions: [[pending]] }) },
        { ...fastPoll, timeoutMs: 1000, now: () => (clock += 400) },
      ),
    ).rejects.toBeInstanceOf(AuthFailure);
    expect(pendingRecords()).toHaveLength(1);
  });

  test("the next add disconnects the bank an earlier one never heard about", async () => {
    // The retry the timeout's remedy asks for. By now the earlier session has
    // completed at Plaid and its bank was never stored here.
    writeCreds();
    rememberPendingLink("link-late", configDir, LONG_AGO);
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const ids = await authFlow(
      undefined,
      urlCallbacks().callbacks,
      configDir,
      {
        fetchImpl: fakeFetch({
          calls,
          sessionsFor: { "link-late": [linked("public-late")] },
          sessions: [[linked("public-new")]],
          exchange: (token: string) =>
            token === "public-late"
              ? { access_token: "access-late", item_id: "item-late" }
              : { access_token: "access-new", item_id: "item-new" },
        }),
      },
      fastPoll,
    );

    // The abandoned bank is disconnected; the one this add connected is kept.
    expect(calls.filter((c) => c.path === "/item/remove").map((c) => c.body.access_token)).toEqual([
      "access-late",
    ]);
    expect(ids.map(String)).toEqual(["item-new"]);
    expect(discoverAccounts(configDir).map(String)).toEqual(["item-new"]);
    expect(pendingRecords()).toEqual([]);
  });

  test("an add that connects a bank leaves no session behind", async () => {
    writeCreds();
    await authFlow(
      undefined,
      urlCallbacks().callbacks,
      configDir,
      { fetchImpl: fakeFetch({}) },
      fastPoll,
    );
    expect(pendingRecords()).toEqual([]);
  });

  test("a re-consent records nothing — update mode creates no item to strand", async () => {
    writeCreds();
    saveItemCredential({ access_token: "access-1", item_id: "item-1" }, configDir);
    await authFlow(
      undefined,
      urlCallbacks({ accountId: "item-1" }).callbacks,
      configDir,
      {
        fetchImpl: fakeFetch({
          sessions: [[{ link_session_id: "s", finished_at: "2026-05-15T12:00:05Z" }]],
        }),
      },
      fastPoll,
    );
    expect(pendingRecords()).toEqual([]);
  });

  test("a session the user abandons fails the add with Plaid's own reason", async () => {
    writeCreds();
    const { callbacks } = urlCallbacks();
    await expect(
      authFlow(
        undefined,
        callbacks,
        configDir,
        { fetchImpl: fakeFetch({ sessions: [[exited("You closed the window.")]] }) },
        fastPoll,
      ),
    ).rejects.toThrow(/You closed the window/);
    expect(discoverAccounts(configDir)).toEqual([]);
  });

  test("a sign-in nobody completes times out instead of waiting forever", async () => {
    writeCreds();
    const { callbacks } = urlCallbacks();
    let clock = 0;
    await expect(
      authFlow(
        undefined,
        callbacks,
        configDir,
        { fetchImpl: fakeFetch({ sessions: [[pending]] }) },
        { ...fastPoll, timeoutMs: 1000, now: () => (clock += 400) },
      ),
    ).rejects.toThrow(/not completed within/);
  });

  test("refuses a bank this host already connected, and revokes the duplicate item", async () => {
    // Plaid mints a distinct item id for a second login at the same bank, so
    // only the institution id can tell the duplicate apart. Left alone it
    // would double every row and carry a second Plaid subscription.
    writeCreds();
    const { callbacks } = urlCallbacks();
    const first = fakeFetch({
      sessions: [[linked("public-a", { name: "Northstar Bank", institution_id: "ins_a" })]],
    });
    await authFlow(undefined, callbacks, configDir, { fetchImpl: first }, fastPoll);

    const calls: { path: string; body: Record<string, unknown> }[] = [];
    await expect(
      authFlow(
        undefined,
        urlCallbacks().callbacks,
        configDir,
        {
          fetchImpl: fakeFetch({
            calls,
            sessions: [[linked("public-b", { name: "Northstar Bank", institution_id: "ins_a" })]],
            exchange: { access_token: "access-b", item_id: "item-b" },
          }),
        },
        fastPoll,
      ),
    ).rejects.toThrow(/already connected/);

    expect(calls.filter((c) => c.path === "/item/remove")).toHaveLength(1);
    expect(discoverAccounts(configDir).map(String)).toEqual(["item-a"]);
  });

  test("a retry after a stumble still connects the bank", async () => {
    // Plaid's hosted page lets the user try again, and each attempt is its own
    // session on the same token. Failing on the abandoned first attempt would
    // report an error for a sign-in that actually succeeded — and leave the
    // item it created billing, with nothing local pointing at it.
    writeCreds();
    const { callbacks } = urlCallbacks();
    const ids = await authFlow(
      undefined,
      callbacks,
      configDir,
      {
        fetchImpl: fakeFetch({
          sessions: [[exited("You closed the window."), linked("public-a")]],
        }),
      },
      fastPoll,
    );
    expect(ids.map(String)).toEqual(["item-a"]);
  });

  test("an abandoned attempt still open elsewhere is waited on, not failed", async () => {
    writeCreds();
    const { callbacks } = urlCallbacks();
    const ids = await authFlow(
      undefined,
      callbacks,
      configDir,
      {
        fetchImpl: fakeFetch({
          sessions: [
            [exited("You closed the window."), pending],
            [exited("You closed the window."), linked("public-a")],
          ],
        }),
      },
      fastPoll,
    );
    expect(ids.map(String)).toEqual(["item-a"]);
  });

  test("a finished session that has not yet reported a bank is polled, not failed", async () => {
    // Plaid can stamp `finished_at` a moment before the result is readable.
    // Failing there would tell the user the add failed while a live, billed
    // item exists that Omnesis would never revoke.
    writeCreds();
    const { callbacks } = urlCallbacks();
    const ids = await authFlow(
      undefined,
      callbacks,
      configDir,
      {
        fetchImpl: fakeFetch({
          sessions: [
            [{ link_session_id: "s", finished_at: "2026-05-15T12:00:05Z" }],
            [linked("public-a")],
          ],
        }),
      },
      fastPoll,
    );
    expect(ids.map(String)).toEqual(["item-a"]);
  });

  test("without a hosted URL the add fails with something the operator can act on", async () => {
    writeCreds();
    const { callbacks } = urlCallbacks();
    await expect(
      authFlow(
        undefined,
        callbacks,
        configDir,
        { fetchImpl: fakeFetch({ hostedUrl: null }) },
        fastPoll,
      ),
    ).rejects.toThrow(/hosted sign-in URL/);
  });

  test("requires a client that can show a URL", async () => {
    writeCreds();
    await expect(
      authFlow(undefined, {}, configDir, { fetchImpl: fakeFetch({}) }, fastPoll),
    ).rejects.toThrow(/show a URL/);
  });

  test("a failed credential save revokes the just-minted item at Plaid", async () => {
    // The exchange already created a live, billed item; if the token cannot be
    // stored nothing could ever revoke it, so the flow must do it now.
    writeCreds();
    writeFileSync(join(configDir, "plaid"), "not a directory");
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const { callbacks } = urlCallbacks();
    await expect(
      authFlow(undefined, callbacks, configDir, { fetchImpl: fakeFetch({ calls }) }, fastPoll),
    ).rejects.toThrow(/ENOTDIR/);
    const removes = calls.filter((c) => c.path === "/item/remove");
    expect(removes).toHaveLength(1);
    expect(removes[0].body.access_token).toBe("access-a");
  });

  test("propagates a client error from link-token creation", async () => {
    writeCreds();
    const { callbacks } = urlCallbacks();
    const failing = (async () =>
      new Response(JSON.stringify({ error_code: "INVALID_SECRET" }), {
        status: 400,
      })) as unknown as typeof fetch;
    await expect(
      authFlow(undefined, callbacks, configDir, { fetchImpl: failing }, fastPoll),
    ).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("authFlow — re-consent via Link update mode", () => {
  async function connect(): Promise<void> {
    writeCreds();
    await authFlow(
      undefined,
      urlCallbacks().callbacks,
      configDir,
      { fetchImpl: fakeFetch({ sessions: [[linked("public-a")]] }) },
      fastPoll,
    );
  }

  test("re-consent reuses the SAME item and never exchanges a token", async () => {
    await connect();
    const before = loadItemCredential("item-a", configDir);
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const { callbacks, urls } = urlCallbacks();

    const ids = await authFlow(
      undefined,
      { ...callbacks, accountId: "item-a" },
      configDir,
      {
        fetchImpl: fakeFetch({
          calls,
          // Update mode mints no public token: the session simply finishes.
          sessions: [[{ link_session_id: "s", finished_at: "2026-05-15T12:00:05Z" }]],
        }),
      },
      fastPoll,
    );

    expect(ids.map(String)).toEqual(["item-a"]);
    expect(urls).toHaveLength(1);
    // The link token is created FROM the stored access token — that is what
    // makes Plaid open the session in update mode on this item.
    const create = calls.find((c) => c.path === "/link/token/create")!;
    expect(create.body.access_token).toBe("access-a");
    expect(create.body.products).toBeUndefined();
    expect(calls.some((c) => c.path === "/item/public_token/exchange")).toBe(false);
    expect(loadItemCredential("item-a", configDir)).toEqual(before);
  });

  test("a re-consent the user abandons re-throws so the banner stays red", async () => {
    await connect();
    const { callbacks } = urlCallbacks();
    await expect(
      authFlow(
        undefined,
        { ...callbacks, accountId: "item-a" },
        configDir,
        { fetchImpl: fakeFetch({ sessions: [[exited("Cancelled.")]] }) },
        fastPoll,
      ),
    ).rejects.toThrow(/Cancelled/);
  });

  test("a re-auth for an unknown account falls back to a first-time add", async () => {
    writeCreds();
    const { callbacks } = urlCallbacks();
    const ids = await authFlow(
      undefined,
      { ...callbacks, accountId: "item-nope" },
      configDir,
      { fetchImpl: fakeFetch({ sessions: [[linked("public-a")]] }) },
      fastPoll,
    );
    expect(ids.map(String)).toEqual(["item-a"]);
  });
});

describe("discover / hasCredentials / cleanup", () => {
  async function connectItem(id = "a"): Promise<void> {
    writeCreds();
    await authFlow(
      undefined,
      urlCallbacks().callbacks,
      configDir,
      {
        fetchImpl: fakeFetch({
          sessions: [[linked(`public-${id}`, { name: "Bank", institution_id: `ins_${id}` })]],
          exchange: { access_token: `access-${id}`, item_id: `item-${id}` },
        }),
      },
      fastPoll,
    );
  }

  test("discoverAccounts is empty before any bank is connected", () => {
    expect(discoverAccounts(configDir)).toEqual([]);
  });

  test("hasCredentials needs both the app credential and the item dir", async () => {
    expect(hasCredentials("item-a", configDir)).toBe(false);
    await connectItem();
    expect(hasCredentials("item-a", configDir)).toBe(true);
    expect(hasCredentials("item-other", configDir)).toBe(false);
  });

  test("hasCredentials fails closed when an encrypted item exists but the root key is gone", async () => {
    await ensureInstallRootKey({ backend: "file", configDir });
    await connectItem();

    rmSync(join(configDir, "keyring"), { recursive: true, force: true });
    clearSecretFileKeyCacheForTests();

    expect(() => hasCredentials("item-a", configDir)).toThrow(/install root key/);
  });

  test("cleanupCredentials revokes the bank at Plaid, then removes the item dir", async () => {
    await connectItem();
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    await cleanupCredentials("item-a", configDir, { fetchImpl: fakeFetch({ calls }) });
    const removes = calls.filter((c) => c.path === "/item/remove");
    expect(removes).toHaveLength(1);
    expect(removes[0].body.access_token).toBe("access-a");
    expect(removes[0].body.client_id).toBe("test-client");
    expect(existsSync(join(configDir, "plaid", "item-a"))).toBe(false);
    expect(discoverAccounts(configDir)).toEqual([]);
  });

  test.each(["INVALID_ACCESS_TOKEN", "ITEM_NOT_FOUND", "ITEM_CONCURRENTLY_DELETED"])(
    "cleanupCredentials treats a bank Plaid no longer has (%s) as revoked",
    async (errorCode) => {
      await connectItem();
      await expect(
        cleanupCredentials("item-a", configDir, {
          fetchImpl: fakeFetch({ remove: { status: 400, errorCode } }),
        }),
      ).resolves.toBeUndefined();
      expect(existsSync(join(configDir, "plaid", "item-a"))).toBe(false);
    },
  );

  test("cleanupCredentials does NOT treat a bad app credential as already-revoked", async () => {
    await connectItem();
    await expect(
      cleanupCredentials("item-a", configDir, {
        fetchImpl: fakeFetch({ remove: { status: 400, errorCode: "INVALID_API_KEYS" } }),
      }),
    ).rejects.toThrow(/could not be revoked at Plaid.*INVALID_API_KEYS/);
    expect(existsSync(join(configDir, "plaid", "item-a"))).toBe(false);
  });

  test("cleanupCredentials retries a transient revoke failure once before giving up", async () => {
    await connectItem();
    let attempts = 0;
    const flaky = (async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path !== "/item/remove") throw new Error(`unexpected ${path}`);
      attempts += 1;
      return new Response(JSON.stringify(init ? { request_id: "r" } : {}), {
        status: attempts === 1 ? 503 : 200,
      });
    }) as unknown as typeof fetch;
    await expect(
      cleanupCredentials("item-a", configDir, { fetchImpl: flaky }, () => Promise.resolve()),
    ).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  test("cleanupCredentials still deletes locally when the revoke fails, then reports it", async () => {
    // The local delete must never be skipped (discover() would resurrect the
    // bank), but the operator must learn it is still live at Plaid.
    await connectItem();
    await expect(
      cleanupCredentials("item-a", configDir, { fetchImpl: fakeFetch({ remove: "network" }) }),
    ).rejects.toThrow(/could not be revoked at Plaid/);
    expect(existsSync(join(configDir, "plaid", "item-a"))).toBe(false);
    expect(discoverAccounts(configDir)).toEqual([]);
  });

  test("cleanupCredentials removes only the named bank; a sibling is untouched", async () => {
    await connectItem("a");
    await connectItem("b");
    expect(discoverAccounts(configDir).map(String).sort()).toEqual(["item-a", "item-b"]);
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    await cleanupCredentials("item-a", configDir, { fetchImpl: fakeFetch({ calls }) });
    expect(calls.filter((c) => c.path === "/item/remove").map((c) => c.body.access_token)).toEqual([
      "access-a",
    ]);
    expect(discoverAccounts(configDir).map(String)).toEqual(["item-b"]);
    expect(loadItemCredential("item-b", configDir)?.access_token).toBe("access-b");
  });

  test("cleanupCredentials for a never-connected bank makes no Plaid call", async () => {
    writeCreds();
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    await cleanupCredentials("never", configDir, { fetchImpl: fakeFetch({ calls }) });
    expect(calls).toHaveLength(0);
  });
});

// ── authenticate (the session contract) ─────────────────────────────

/**
 * A scripted `AuthSession`: everything the flow puts in front of the operator
 * is recorded, so a test can read what they would have seen. Nothing answers,
 * because nothing is asked — Plaid's page collects the whole sign-in and the
 * outcome comes back through the poll — so a challenge that arrives at `ask`
 * fails the test rather than hanging it.
 */
function scriptSession(
  options: {
    accountId?: string;
    renders?: AuthChallengeKind[];
    /** Stands in for a client that fails while the challenge is delivered. */
    onShow?: (challenge: ShowableChallenge) => void;
  } = {},
): {
  session: AuthSession;
  shown: ShowableChallenge[];
  asked: AskableChallenge[];
} {
  const shown: ShowableChallenge[] = [];
  const asked: AskableChallenge[] = [];
  const renders = options.renders ?? [...AUTH_CHALLENGE_KINDS];
  const session: AuthSession = {
    reason: options.accountId ? "reauthenticate" : "connect",
    flowId: "flow-1",
    accountId: options.accountId,
    supplied: {},
    host: { ...fakeProviderHost(), configDir },
    canShow: (kind) => renders.includes(kind),
    show: (challenge) => {
      shown.push(challenge);
      options.onShow?.(challenge);
    },
    ask: (challenge) => {
      asked.push(challenge);
      return Promise.reject(
        new Error(`nothing should be asked; got a ${challenge.kind} challenge`),
      ) as never;
    },
  };
  return { session, shown, asked };
}

async function failureOf(promise: Promise<unknown>): Promise<AuthFailure> {
  const caught = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(caught instanceof AuthFailure)) {
    throw new Error(`expected an AuthFailure, got ${String(caught)}`);
  }
  return caught;
}

describe("authenticate — the client has to be able to open Plaid's page", () => {
  test("a client that cannot show a redirect is refused before any Plaid call", async () => {
    writeCreds();
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const { session, shown, asked } = scriptSession({ renders: ["fields", "code", "qr"] });

    const failure = await failureOf(
      authenticate(session, { fetchImpl: fakeFetch({ calls }) }, fastPoll),
    );

    expect(failure.code).toBe("unsupported");
    expect(failure.remedy).toMatch(/portal/i);
    // Nothing was put in front of the operator and no Link token was minted:
    // a hosted link nobody can open can only sit there until it times out.
    expect(shown).toEqual([]);
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("authenticate — connecting an item", () => {
  test("the hosted page is shown, and the item is stored and reported", async () => {
    writeCreds();
    const { session, shown, asked } = scriptSession();
    const result = await authenticate(
      session,
      {
        fetchImpl: fakeFetch({
          sessions: [[pending], [linked("public-a")]],
          exchange: { access_token: "access-1", item_id: "item-1" },
          itemGet: { consent_expiration_time: "2027-01-01T00:00:00Z" },
        }),
      },
      fastPoll,
    );

    expect(shown).toHaveLength(1);
    const challenge = shown[0];
    expect(challenge.kind).toBe("redirect");
    if (challenge.kind !== "redirect") throw new Error("expected a redirect challenge");
    expect(challenge.url).toBe("https://hosted.plaid.com/link?token=abc");
    // Plaid's page reports the outcome through the poll, so the client is told
    // not to wait for anything to come back through it.
    expect(challenge.via).toBe("elsewhere");
    // The challenge carries its own words rather than relying on the client.
    expect(challenge.title.length).toBeGreaterThan(0);
    // Nothing is asked: the operator answers at Plaid, not here.
    expect(asked).toEqual([]);

    expect(result.accounts).toEqual([
      {
        accountId: "item-1",
        // The consent deadline Plaid reports is the whole reason to read
        // /item/get here: nothing else on the connect path ever sees it.
        state: { status: "connected", expiresAt: "2027-01-01T00:00:00Z" },
      },
    ]);
    expect(loadItemCredential("item-1", configDir)?.access_token).toBe("access-1");
    expect(discoverAccounts(configDir).map(String)).toEqual(["item-1"]);
  });

  test("the institution from the Link session is stored with the item", async () => {
    writeCreds();
    const { session } = scriptSession();
    await authenticate(
      session,
      {
        fetchImpl: fakeFetch({
          sessions: [[linked("public-a", { name: "Northstar Bank", institution_id: "ins_a" })]],
          exchange: { access_token: "access-1", item_id: "item-1" },
        }),
      },
      fastPoll,
    );
    expect(loadItemCredential("item-1", configDir)?.institution_name).toBe("Northstar Bank");
  });

  test("an unreadable consent deadline never turns a good connect into a failure", async () => {
    writeCreds();
    const { session } = scriptSession();
    const result = await authenticate(
      session,
      {
        fetchImpl: fakeFetch({
          exchange: { access_token: "access-1", item_id: "item-1" },
          itemGet: "fails",
        }),
      },
      fastPoll,
    );
    expect(result.accounts).toEqual([{ accountId: "item-1", state: { status: "connected" } }]);
    expect(loadItemCredential("item-1", configDir)?.access_token).toBe("access-1");
  });

  test("an item with no consent deadline is connected without one", async () => {
    writeCreds();
    const { session } = scriptSession();
    const result = await authenticate(
      session,
      {
        fetchImpl: fakeFetch({
          exchange: { access_token: "access-1", item_id: "item-1" },
          itemGet: { consent_expiration_time: null },
        }),
      },
      fastPoll,
    );
    expect(result.accounts[0].state).toEqual({ status: "connected" });
  });

  test("no app credential raises into the credentials wizard", async () => {
    const { session } = scriptSession();
    const err = await authenticate(session, { fetchImpl: fakeFetch({}) }, fastPoll).catch(
      (e: unknown) => e,
    );
    expect(isMissingCredentialsError(err)).toBe(true);
  });
});

describe("authenticate — a credential that cannot be stored", () => {
  /** A regular file where the item tree must go makes the store throw. */
  function blockTheItemStore(): void {
    writeFileSync(join(configDir, "plaid"), "not a directory");
  }

  test("a failed store revokes the just-minted item, and stays a persist failure", async () => {
    // The exchange already created a live, billed item; with no stored token
    // nothing here could ever revoke it, so the flow must do it there and
    // then. What comes back must still read as a store failure, because that
    // is what a client keeps the attempt open for.
    writeCreds();
    blockTheItemStore();
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const { session } = scriptSession();

    const err = await authenticate(
      session,
      {
        fetchImpl: fakeFetch({ calls, exchange: { access_token: "access-a", item_id: "item-a" } }),
      },
      fastPoll,
    ).catch((e: unknown) => e);

    expect(isCredentialPersistError(err)).toBe(true);
    const removes = calls.filter((c) => c.path === "/item/remove");
    expect(removes).toHaveLength(1);
    expect(removes[0].body.access_token).toBe("access-a");
  });

  test("a revoke that fails too still names the item the operator now owns", async () => {
    writeCreds();
    blockTheItemStore();
    const { session } = scriptSession();

    const failure = await failureOf(
      authenticate(
        session,
        {
          fetchImpl: fakeFetch({
            exchange: { access_token: "access-a", item_id: "item-a" },
            // Refused outright rather than as a blip, so the revoke gives up
            // at once instead of taking its one retry.
            remove: { status: 400, errorCode: "INVALID_API_KEYS" },
          }),
        },
        fastPoll,
      ),
    );

    // The revoke failing is not what the operator is told about — the store is
    // — but it is why the remedy has to name the item: this is the only place
    // its id is ever written down.
    expect(failure.code).toBe("credential-persist-failed");
    expect(failure.remedy).toMatch(/Plaid dashboard/);
    expect(failure.remedy).toContain("item-a");
  });
});

describe("authenticate — renewing an item's consent", () => {
  async function connectOne(): Promise<void> {
    const { session } = scriptSession();
    await authenticate(
      session,
      { fetchImpl: fakeFetch({ exchange: { access_token: "access-1", item_id: "item-1" } }) },
      fastPoll,
    );
  }

  test("a renewal opens update mode on the same item and exchanges nothing", async () => {
    writeCreds();
    await connectOne();
    const before = loadItemCredential("item-1", configDir);

    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const { session, shown } = scriptSession({ accountId: "item-1" });
    const result = await authenticate(
      session,
      {
        fetchImpl: fakeFetch({
          calls,
          // Update mode mints no public token: the session simply finishes.
          sessions: [[{ link_session_id: "s", finished_at: "2026-05-15T12:00:05Z" }]],
          itemGet: { consent_expiration_time: "2027-03-01T00:00:00Z" },
        }),
      },
      fastPoll,
    );

    expect(result.accounts).toEqual([
      { accountId: "item-1", state: { status: "connected", expiresAt: "2027-03-01T00:00:00Z" } },
    ]);
    const create = calls.find((c) => c.path === "/link/token/create")!;
    // Passing the existing token is what makes Plaid open the session in
    // update mode on this item.
    expect(create.body.access_token).toBe("access-1");
    // Reaching the exchange at all would mint a second item and orphan
    // everything already synced under this one.
    expect(calls.some((c) => c.path === "/item/public_token/exchange")).toBe(false);
    expect(shown).toHaveLength(1);
    expect(loadItemCredential("item-1", configDir)).toEqual(before);
  });

  test("a renewal the operator stops leaves the stored credential intact", async () => {
    writeCreds();
    await connectOne();
    const { session } = scriptSession({ accountId: "item-1" });
    const failure = await failureOf(
      authenticate(
        session,
        { fetchImpl: fakeFetch({ sessions: [[exited("You closed the window.")]] }) },
        fastPoll,
      ),
    );
    expect(failure.code).toBe("cancelled");
    expect(loadItemCredential("item-1", configDir)?.access_token).toBe("access-1");
  });

  test("a renewal for an account with no stored item is refused, not turned into a new add", async () => {
    // Falling through to the first-time add would mint a SECOND Plaid item
    // under a different id and leave this account's transactions attached to
    // an id nothing connects to any more.
    writeCreds();
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const { session, shown, asked } = scriptSession({ accountId: "item-ghost" });

    const failure = await failureOf(
      authenticate(session, { fetchImpl: fakeFetch({ calls }) }, fastPoll),
    );

    expect(failure.message).toContain("item-ghost");
    expect(failure.remedy).toMatch(/second Plaid item/);
    expect(shown).toEqual([]);
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);
    expect(discoverAccounts(configDir)).toEqual([]);
  });
});

describe("authenticate — what a Plaid refusal means", () => {
  test.each(["INVALID_API_KEYS", "INVALID_CLIENT_ID", "INVALID_SECRET"])(
    "%s is the operator's own app credential being refused",
    async (errorCode) => {
      writeCreds();
      const { session } = scriptSession();
      const failure = await failureOf(
        authenticate(
          session,
          { fetchImpl: fakeFetch({ linkTokenError: { status: 400, errorCode } }) },
          fastPoll,
        ),
      );
      // Not `missing-credentials`: something IS configured, and Plaid refused
      // it. The remedy is the only place that can say which of the two.
      expect(failure.code).toBe("credential-rejected");
      expect(failure.remedy).toMatch(/environment/);
    },
  );

  test("an item-level refusal is a denial, not a bad app credential", async () => {
    writeCreds();
    const { session } = scriptSession();
    const failure = await failureOf(
      authenticate(
        session,
        {
          fetchImpl: fakeFetch({
            linkTokenError: { status: 400, errorCode: "ITEM_LOGIN_REQUIRED" },
          }),
        },
        fastPoll,
      ),
    );
    expect(failure.code).toBe("denied");
  });

  test.each([
    ["a rate limit", { status: 429, errorCode: "RATE_LIMIT_EXCEEDED" } as const],
    ["a server error", { status: 503 } as const],
  ])("%s is Plaid being unreachable, which clears on its own", async (_name, linkTokenError) => {
    writeCreds();
    const { session } = scriptSession();
    const failure = await failureOf(
      authenticate(session, { fetchImpl: fakeFetch({ linkTokenError }) }, fastPoll),
    );
    expect(failure.code).toBe("unavailable");
    expect(isRetryable(failure.code)).toBe(true);
  });

  test("a rate limit carries the wait Plaid asked for, not just a shrug", async () => {
    writeCreds();
    const { session } = scriptSession();
    const failure = await failureOf(
      authenticate(
        session,
        {
          fetchImpl: fakeFetch({
            linkTokenError: { status: 429, errorCode: "RATE_LIMIT_EXCEEDED" },
          }),
        },
        fastPoll,
      ),
    );
    expect(failure.retryAfterMs).toBe(PLAID_RATE_LIMIT_RETRY_MS);
  });

  test("a network failure is unreachable too", async () => {
    writeCreds();
    const { session } = scriptSession();
    const failure = await failureOf(
      authenticate(session, { fetchImpl: fakeFetch({ linkTokenError: "network" }) }, fastPoll),
    );
    expect(failure.code).toBe("unavailable");
  });

  test("a session the operator abandons is a cancellation, and leaves nothing behind", async () => {
    writeCreds();
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const { session, shown } = scriptSession();
    const failure = await failureOf(
      authenticate(
        session,
        { fetchImpl: fakeFetch({ calls, sessions: [[exited("You closed the window.")]] }) },
        fastPoll,
      ),
    );

    expect(failure.code).toBe("cancelled");
    // Plaid's own wording is what the operator reads.
    expect(failure.message).toMatch(/You closed the window/);
    expect(shown).toHaveLength(1);
    // Nothing was exchanged, so no item exists and there is nothing to revoke.
    expect(calls.map((c) => c.path)).toEqual(["/link/token/create", "/link/token/get"]);
    expect(discoverAccounts(configDir)).toEqual([]);
  });

  test("a sign-in nobody finishes times out, pointing at the retry that settles it", async () => {
    // The wait is bounded, and a session that finishes after it cannot report
    // the bank it connected — so the remedy is the next add, which settles the
    // Link token this one wrote down.
    writeCreds();
    const { session } = scriptSession();
    let clock = 0;
    const failure = await failureOf(
      authenticate(
        session,
        { fetchImpl: fakeFetch({ sessions: [[pending]] }) },
        { ...fastPoll, timeoutMs: 1000, now: () => (clock += 400) },
      ),
    );
    expect(failure.code).toBe("timeout");
    expect(failure.remedy).toMatch(/starting another add disconnects it/);
  });

  test("refusing a duplicate leaves no session behind to re-derive", async () => {
    writeCreds();
    saveItemCredential(
      { access_token: "access-1", item_id: "item-1", institution_id: "ins_a" },
      configDir,
    );
    await expect(
      authFlow(
        undefined,
        urlCallbacks().callbacks,
        configDir,
        {
          fetchImpl: fakeFetch({
            sessions: [[linked("public-a", { name: "Northstar Bank", institution_id: "ins_a" })]],
            exchange: { access_token: "access-dup", item_id: "item-dup" },
          }),
        },
        fastPoll,
      ),
    ).rejects.toBeInstanceOf(AuthFailure);
    expect(pendingRecords()).toEqual([]);
  });

  test("a bank this host already connected is refused as a duplicate", async () => {
    writeCreds();
    const { session } = scriptSession();
    await authenticate(
      session,
      {
        fetchImpl: fakeFetch({
          sessions: [[linked("public-a", { name: "Northstar Bank", institution_id: "ins_a" })]],
          exchange: { access_token: "access-1", item_id: "item-1" },
        }),
      },
      fastPoll,
    );

    const second = scriptSession();
    const failure = await failureOf(
      authenticate(
        second.session,
        {
          fetchImpl: fakeFetch({
            sessions: [[linked("public-b", { name: "Northstar Bank", institution_id: "ins_a" })]],
            exchange: { access_token: "access-2", item_id: "item-2" },
          }),
        },
        fastPoll,
      ),
    );
    expect(failure.code).toBe("duplicate");
    expect(discoverAccounts(configDir).map(String)).toEqual(["item-1"]);
  });

  test("a failure the session itself raised is reported unchanged", async () => {
    // A client that has gone away fails while the challenge is delivered, and
    // it has already said why. Re-reading that as a Plaid outcome would file
    // an expired flow record under "the operator closed the page".
    writeCreds();
    const raised = new AuthFailure("challenge-expired", "the flow record is gone");
    const { session } = scriptSession({
      onShow: () => {
        throw raised;
      },
    });
    const failure = await failureOf(authenticate(session, { fetchImpl: fakeFetch({}) }, fastPoll));
    expect(failure).toBe(raised);
  });

  test("an account with no hosted sign-in is refused with something to enable", async () => {
    writeCreds();
    const { session, shown } = scriptSession();
    const failure = await failureOf(
      authenticate(session, { fetchImpl: fakeFetch({ hostedUrl: null }) }, fastPoll),
    );
    expect(failure.code).toBe("unsupported");
    expect(failure.remedy).toMatch(/hosted link/i);
    expect(shown).toEqual([]);
  });
});
