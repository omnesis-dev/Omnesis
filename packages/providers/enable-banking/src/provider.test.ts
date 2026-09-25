// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearSecretFileKeyCacheForTests,
  createSecretStore,
  ensureInstallRootKey,
  MissingCredentialsError,
  OMNESIS_INSTALL_ROOT_KEY,
  readProviderCredentials,
  writeProviderCredentials,
} from "@omnesis/core";
import { AuthFailure, isRetryable, parseFieldsAnswer } from "@omnesis/source-sdk";
import { fakeProviderHost } from "@omnesis/source-sdk/testing";
import { EB_RATE_LIMIT_RETRY_MS } from "./client.js";
import {
  authenticateWith,
  authFlow,
  bankAccountSlug,
  cleanupCredentials,
  closestAspspNames,
  discoverAccounts,
  loadCredentials,
  normalizePrivateKeyPem,
} from "./provider.js";
import {
  bootstrapAccountDir,
  completedBootstrapMarker,
  loadSession,
  readBootstrapPage,
  saveSession,
  sessionPath,
} from "./session.js";
import providerDefinition from "./index.js";
import type {
  AskableChallenge,
  AuthFlowCallbacks,
  AuthSession,
  FieldsChallenge,
} from "@omnesis/source-sdk";
import type { EnableBankingClient } from "./client.js";
import type { EnableBankingContext, StoredSession } from "./types.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const APP_ID = "11111111-2222-3333-4444-555555555555";
const NOW = new Date("2026-06-01T12:00:00.000Z");

let configDir: string;
let oldSecretStore: string | undefined;

beforeEach(() => {
  oldSecretStore = process.env.OMNESIS_SECRET_STORE;
  process.env.OMNESIS_SECRET_STORE = "file";
  configDir = mkdtempSync(join(tmpdir(), "omnesis-eb-provider-"));
});

afterEach(() => {
  clearSecretFileKeyCacheForTests();
  if (oldSecretStore === undefined) delete process.env.OMNESIS_SECRET_STORE;
  else process.env.OMNESIS_SECRET_STORE = oldSecretStore;
  rmSync(configDir, { recursive: true, force: true });
});

async function writeCredentials(privateKeyValue: string): Promise<void> {
  await writeProviderCredentials(
    "enable-banking",
    {
      application_id: APP_ID,
      private_key: privateKeyValue,
      redirect_url: "https://gateway.example:7600/oauth/callback",
    },
    configDir,
  );
}

function signsCorrectly(pem: string): boolean {
  const signer = createSign("RSA-SHA256");
  signer.update("probe");
  signer.end();
  const sig = signer.sign(pem);
  const verifier = createVerify("RSA-SHA256");
  verifier.update("probe");
  verifier.end();
  return verifier.verify(publicKey, sig);
}

describe("normalizePrivateKeyPem", () => {
  test("a well-formed PEM stays usable", () => {
    expect(signsCorrectly(normalizePrivateKeyPem(PEM))).toBe(true);
  });

  test("re-wraps a PEM with literal \\n escapes", () => {
    const mangled = PEM.replace(/\n/g, "\\n");
    expect(mangled).not.toContain("\n");
    expect(signsCorrectly(normalizePrivateKeyPem(mangled))).toBe(true);
  });

  test("re-wraps a single-line PEM whose body newlines became spaces", () => {
    const mangled = PEM.replace(/\n/g, " ");
    expect(signsCorrectly(normalizePrivateKeyPem(mangled))).toBe(true);
  });

  test("rejects non-PEM content with an actionable error", () => {
    expect(() => normalizePrivateKeyPem("not a key")).toThrow(/BEGIN\/END/);
  });
});

describe("loadCredentials", () => {
  test("missing file throws MissingCredentialsError", async () => {
    await expect(loadCredentials(configDir)).rejects.toBeInstanceOf(MissingCredentialsError);
  });

  test("accepts inline PEM content", async () => {
    await writeCredentials(PEM);
    const creds = await loadCredentials(configDir);
    expect(creds.applicationId).toBe(APP_ID);
    expect(creds.privateKeySourcePath).toBeUndefined();
    expect(signsCorrectly(creds.privateKeyPem)).toBe(true);
  });

  test("accepts an absolute path and reads the PEM from disk", async () => {
    const pemPath = join(configDir, "app.pem");
    writeFileSync(pemPath, PEM);
    await writeCredentials(pemPath);
    const creds = await loadCredentials(configDir);
    expect(creds.privateKeySourcePath).toBe(pemPath);
    expect(signsCorrectly(creds.privateKeyPem)).toBe(true);
  });

  test("a path that does not exist fails with guidance", async () => {
    await writeCredentials("/nonexistent/path/app.pem");
    await expect(loadCredentials(configDir)).rejects.toThrow(/not found/);
  });
});

describe("bankAccountSlug / closestAspspNames", () => {
  test("slug is <bank>-<country> lowercased and filesystem-safe", () => {
    expect(bankAccountSlug("Revolut", "DE")).toBe("revolut-de");
    expect(bankAccountSlug("Banque Du Nord (Personal)", "FR")).toBe("banque-du-nord-personal-fr");
  });

  test("closest names rank substring matches first", () => {
    const names = ["Riverside Bank", "Revolut", "Northstar Savings", "Stellar Credit Union"];
    const ranked = closestAspspNames("revolu", names, 2);
    expect(ranked[0]).toBe("Revolut");
  });
});

// ── authFlow with a fully mocked API ───────────────────────────────

interface MockApiOptions {
  transactionPages?: Array<Record<string, unknown>>;
  transactionsStatus?: number;
}

function mockApi(opts: MockApiOptions = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const pages = opts.transactionPages ?? [
    {
      transactions: [
        {
          entry_reference: "ref-1",
          booking_date: "2020-02-01",
          transaction_amount: { currency: "EUR", amount: "10.00" },
          credit_debit_indicator: "DBIT",
          status: "BOOK",
        },
      ],
      continuation_key: "ck-1",
    },
    { transactions: [] },
  ];
  let pageIdx = 0;

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (url.includes("/aspsps")) {
      return json({
        aspsps: [
          { name: "Revolut", country: "DE" },
          { name: "Riverside Bank", country: "DE" },
        ],
      });
    }
    if (url.endsWith("/auth")) {
      return json({ url: "https://bank.example/sca", authorization_id: "auth-1" });
    }
    if (url.endsWith("/sessions")) {
      return json({
        session_id: "sess-1",
        accounts: [
          {
            uid: "uid-1",
            identification_hash: "hash-aaa",
            account_id: { iban: "DE89975713758667268881" },
            currency: "EUR",
            name: "Main EUR",
            cash_account_type: "CACC",
          },
        ],
        access: { valid_until: "2026-11-28T12:00:00.000Z" },
        aspsp: { name: "Revolut", country: "DE" },
      });
    }
    if (url.includes("/transactions")) {
      if (opts.transactionsStatus) {
        return json({ error: "WRONG_REQUEST_PARAMETERS" }, opts.transactionsStatus);
      }
      const page = pages[Math.min(pageIdx, pages.length - 1)];
      pageIdx++;
      return json(page);
    }
    return json({ error: "NOT_FOUND" }, 404);
  });

  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function makeCallbacks(overrides: Partial<AuthFlowCallbacks> = {}): AuthFlowCallbacks {
  return {
    flowId: "flow-123",
    onAuthUrl: vi.fn(),
    receiveCode: async () => "decoded-code",
    ...overrides,
  };
}

function storedSession(): StoredSession {
  return {
    session_id: "sess-1",
    valid_until: "2026-11-28T00:00:00.000Z",
    aspsp: { name: "Revolut", country: "DE" },
    accounts: [],
  };
}

describe("authFlow", () => {
  test("happy path: validates the bank, runs consent, prefetches history, persists the session", async () => {
    await writeCredentials(PEM);
    const api = mockApi();
    const callbacks = makeCallbacks();

    const accountId = await authFlow({ country: "DE", bank: "revolut" }, callbacks, {
      configDir,
      fetchImpl: api.fetchImpl,
      now: () => NOW,
    });

    expect(String(accountId)).toBe("revolut-de");
    expect(callbacks.onAuthUrl).toHaveBeenCalledWith("https://bank.example/sca");

    // POST /auth carried the flow id as state and a ~180d valid_until.
    const authCall = api.calls.find((c) => c.url.endsWith("/auth"))!;
    const authBody = JSON.parse(String(authCall.init?.body));
    expect(authBody.state).toBe("flow-123");
    expect(authBody.redirect_url).toBe("https://gateway.example:7600/oauth/callback");
    expect(authBody.access.valid_until).toBe(
      new Date(NOW.getTime() + 180 * 86_400_000).toISOString(),
    );

    // POST /sessions used the delivered code verbatim.
    const sessionCall = api.calls.find((c) => c.url.endsWith("/sessions"))!;
    expect(JSON.parse(String(sessionCall.init?.body))).toEqual({ code: "decoded-code" });

    // session.json: atomic, 0600, account_key = identification_hash.
    const path = sessionPath("revolut-de", configDir);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const session = loadSession("revolut-de", configDir)!;
    expect(session.valid_until).toBe("2026-11-28T12:00:00.000Z");
    expect(session.aspsp).toEqual({ name: "Revolut", country: "DE" });
    expect(session.accounts).toEqual([
      {
        account_key: "hash-aaa",
        uid: "uid-1",
        iban: "DE89975713758667268881",
        currency: "EUR",
        name: "Main EUR",
        cash_account_type: "CACC",
        product: null,
      },
    ]);

    // Full-history prefetch: 2 raw pages cached + complete marker stamped
    // with the consent epoch; the history fetch ran WITHOUT date_from (full
    // window) and booked-only.
    const dir = bootstrapAccountDir("revolut-de", "hash-aaa", configDir);
    expect(completedBootstrapMarker(dir)).toEqual({ pages: 2, sessionId: "sess-1" });
    expect(readBootstrapPage(dir, 0).transactions[0].entry_reference).toBe("ref-1");
    const historyCalls = api.calls.filter((c) => c.url.includes("/transactions"));
    expect(historyCalls[0].url).not.toContain("date_from");
    expect(historyCalls[0].url).toContain("transaction_status=BOOK");
    expect(historyCalls[1].url).toContain("continuation_key=ck-1");
  });

  test("re-running authFlow yields the same accountId and replaces the session", async () => {
    await writeCredentials(PEM);
    const first = await authFlow({ country: "DE", bank: "Revolut" }, makeCallbacks(), {
      configDir,
      fetchImpl: mockApi().fetchImpl,
      now: () => NOW,
    });
    const second = await authFlow({ country: "DE", bank: "REVOLUT" }, makeCallbacks(), {
      configDir,
      fetchImpl: mockApi().fetchImpl,
      now: () => NOW,
    });
    expect(String(second)).toBe(String(first));
    expect(discoverAccounts(configDir).map(String)).toEqual(["revolut-de"]);
  });

  test("an unknown bank lists the closest ASPSP names", async () => {
    await writeCredentials(PEM);
    await expect(
      authFlow({ country: "DE", bank: "Revoult Bank" }, makeCallbacks(), {
        configDir,
        fetchImpl: mockApi().fetchImpl,
        now: () => NOW,
      }),
    ).rejects.toThrow(/Closest matches: .*Revolut/);
  });

  test("a failed history prefetch degrades gracefully — auth still succeeds, no marker", async () => {
    await writeCredentials(PEM);
    const api = mockApi({ transactionsStatus: 422 });
    const accountId = await authFlow({ country: "DE", bank: "Revolut" }, makeCallbacks(), {
      configDir,
      fetchImpl: api.fetchImpl,
      now: () => NOW,
    });
    expect(String(accountId)).toBe("revolut-de");
    expect(loadSession("revolut-de", configDir)).not.toBeNull();
    const dir = bootstrapAccountDir("revolut-de", "hash-aaa", configDir);
    expect(completedBootstrapMarker(dir)).toBeNull();
  });

  test("a key failure during prefetch fails consent completion instead of silently dropping history", async () => {
    await ensureInstallRootKey({ configDir, backend: "file" });
    await writeCredentials(PEM);
    const api = mockApi();
    let removedKeyDuringPrefetch = false;
    const losingKey: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/transactions")) {
        await createSecretStore({ configDir, backend: "file" }).delete(OMNESIS_INSTALL_ROOT_KEY);
        clearSecretFileKeyCacheForTests();
        removedKeyDuringPrefetch = true;
      }
      return api.fetchImpl(input, init);
    }) as typeof fetch;
    await expect(
      authFlow({ country: "DE", bank: "Revolut" }, makeCallbacks(), {
        configDir,
        fetchImpl: losingKey,
        now: () => NOW,
      }),
    ).rejects.toThrow(/install root key/);
    expect(removedKeyDuringPrefetch).toBe(true);
    const dir = bootstrapAccountDir("revolut-de", "hash-aaa", configDir);
    expect(existsSync(sessionPath("revolut-de", configDir))).toBe(true);
    expect(existsSync(join(dir, "page-0000.json"))).toBe(false);
    expect(completedBootstrapMarker(dir)).toBeNull();
  });

  test("session.json is persisted BEFORE the full-history prefetch starts", async () => {
    // A crash mid-prefetch must not burn the SCA: by the time the first
    // history request goes out, the session must already be on disk.
    await writeCredentials(PEM);
    const api = mockApi();
    let sessionOnDiskAtFirstHistoryFetch: boolean | undefined;
    const probing: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (
        String(input).includes("/transactions") &&
        sessionOnDiskAtFirstHistoryFetch === undefined
      ) {
        sessionOnDiskAtFirstHistoryFetch = loadSession("revolut-de", configDir) !== null;
      }
      return api.fetchImpl(input, init);
    }) as typeof fetch;

    await authFlow({ country: "DE", bank: "Revolut" }, makeCallbacks(), {
      configDir,
      fetchImpl: probing,
      now: () => NOW,
    });
    expect(sessionOnDiskAtFirstHistoryFetch).toBe(true);
  });

  test("a path-supplied private key is re-persisted as PEM content after success", async () => {
    const pemPath = join(configDir, "app.pem");
    writeFileSync(pemPath, PEM);
    await writeCredentials(pemPath);

    await authFlow({ country: "DE", bank: "Revolut" }, makeCallbacks(), {
      configDir,
      fetchImpl: mockApi().fetchImpl,
      now: () => NOW,
    });

    const fields = await readProviderCredentials("enable-banking", configDir);
    expect(fields?.private_key).toContain("-----BEGIN");
    expect(fields?.application_id).toBe(APP_ID);
    const credsFile = join(configDir, "enable-banking-credentials.json");
    expect(statSync(credsFile).mode & 0o777).toBe(0o600);
  });

  test("missing receiveCode fails fast with channel guidance", async () => {
    await writeCredentials(PEM);
    await expect(
      authFlow({ country: "DE", bank: "Revolut" }, { onAuthUrl: vi.fn() }, { configDir }),
    ).rejects.toThrow(/code-delivery channel/);
  });

  test("missing params fail fast", async () => {
    await expect(authFlow(undefined, makeCallbacks(), { configDir })).rejects.toThrow(
      /country.*bank|bank.*country/i,
    );
  });

  test("re-auth: missing params recover bank+country from the accountId's stored session", async () => {
    await writeCredentials(PEM);
    saveSession(
      "revolut-de",
      {
        session_id: "sess-expired",
        valid_until: "2026-05-01T00:00:00.000Z",
        aspsp: { name: "Revolut", country: "DE" },
        accounts: [],
      },
      configDir,
    );

    const api = mockApi();
    const accountId = await authFlow(undefined, makeCallbacks({ accountId: "revolut-de" }), {
      configDir,
      fetchImpl: api.fetchImpl,
      now: () => NOW,
    });

    expect(String(accountId)).toBe("revolut-de");
    // The ASPSP lookup ran against the stored country.
    const aspspsCall = api.calls.find((c) => c.url.includes("/aspsps"))!;
    expect(aspspsCall.url).toContain("country=DE");
    // The session was replaced by the fresh consent.
    expect(loadSession("revolut-de", configDir)?.session_id).toBe("sess-1");
  });

  test("loadSession fails closed when an encrypted session exists but the root key is unavailable", async () => {
    await ensureInstallRootKey({ backend: "file", configDir });
    saveSession("revolut-de", storedSession(), configDir);
    rmSync(join(configDir, "keyring"), { recursive: true, force: true });
    clearSecretFileKeyCacheForTests();

    expect(() => loadSession("revolut-de", configDir)).toThrow(/install root key/);
  });

  test("re-auth: an accountId without a stored session still fails with params guidance", async () => {
    await expect(
      authFlow(undefined, makeCallbacks({ accountId: "ghost-bank-xx" }), { configDir }),
    ).rejects.toThrow(/country.*bank|bank.*country/i);
  });
});

describe("discoverAccounts / cleanupCredentials", () => {
  test("discover returns only directories with a session.json", () => {
    expect(discoverAccounts(configDir)).toEqual([]);
    saveSession("revolut-de", storedSession(), configDir);
    saveSession("riverside-bank-fr", storedSession(), configDir);
    expect(discoverAccounts(configDir).map(String).sort()).toEqual([
      "revolut-de",
      "riverside-bank-fr",
    ]);
  });

  test("cleanup removes the account; credentials file only goes with the last account", async () => {
    await writeCredentials(PEM);
    saveSession("revolut-de", storedSession(), configDir);
    saveSession("riverside-bank-fr", storedSession(), configDir);
    const credsFile = join(configDir, "enable-banking-credentials.json");

    await cleanupCredentials("revolut-de", configDir);
    expect(discoverAccounts(configDir).map(String)).toEqual(["riverside-bank-fr"]);
    expect(existsSync(credsFile)).toBe(true);

    await cleanupCredentials("riverside-bank-fr", configDir);
    expect(discoverAccounts(configDir)).toEqual([]);
    expect(existsSync(credsFile)).toBe(false);
  });

  test("an orphan dir without session.json never keeps the credentials file alive", async () => {
    await writeCredentials(PEM);
    saveSession("revolut-de", storedSession(), configDir);
    // Orphan: a directory discover() ignores (no session.json inside).
    mkdirSync(join(configDir, "enable-banking", "half-added-bank", "bootstrap"), {
      recursive: true,
    });
    const credsFile = join(configDir, "enable-banking-credentials.json");

    await cleanupCredentials("revolut-de", configDir);
    expect(discoverAccounts(configDir)).toEqual([]);
    expect(existsSync(credsFile)).toBe(false);
  });
});

describe("provider definition", () => {
  test("the credential state is offline: the consent's deadline against the injected clock", async () => {
    const VALID_UNTIL = "2026-11-28T00:00:00.000Z";
    const session: StoredSession = {
      session_id: "sess-1",
      valid_until: VALID_UNTIL,
      aspsp: { name: "Revolut", country: "DE" },
      accounts: [],
    };
    saveSession("revolut-de", session, configDir);

    const ctx = (now: Date): EnableBankingContext => ({
      client: {} as EnableBankingClient,
      accountId: "revolut-de",
      now: () => now,
      configDir,
    });

    // A consent under this scheme lapses on a schedule, so the useful answer
    // before the deadline is not "working" but "working, until this date" —
    // which is what lets a host warn instead of discovering the lapse.
    await expect(
      providerDefinition.credentialState!(ctx(new Date("2026-06-01T00:00:00.000Z"))),
    ).resolves.toEqual({ status: "connected", expiresAt: VALID_UNTIL });
    // Past the deadline it is expired, and says when — not revoked, which
    // would claim something withdrew a consent that simply ran out.
    await expect(
      providerDefinition.credentialState!(ctx(new Date("2026-11-29T00:00:00.000Z"))),
    ).resolves.toEqual({ status: "expired", at: VALID_UNTIL });
    // No session at all is an account that was never connected, which asks the
    // operator for a different thing than one whose consent lapsed.
    rmSync(sessionPath("revolut-de", configDir), { force: true });
    await expect(
      providerDefinition.credentialState!(ctx(new Date("2026-06-01T00:00:00.000Z"))),
    ).resolves.toEqual({ status: "never-connected" });
  });

  test("descriptor surface: id, schemas, prior, interval, no source parameters", () => {
    expect(providerDefinition.provider.id).toBe("enable-banking");
    expect(providerDefinition.authType).toBe("oauth");
    // Gates the portal/CLI paste affordances: this provider consumes
    // externally delivered authorization codes via callbacks.receiveCode.
    expect(providerDefinition.acceptsAuthCode).toBe(true);
    const source = providerDefinition.sources[0];
    expect(source.id).toBe("enable-banking-accounts");
    expect(source.unitName).toBe("transactions");
    expect(source.defaultSourcePrior).toBe(-0.04);
    expect(source.defaultSyncInterval).toBe("12h");
    expect(source.analyticsSchemas?.map((s) => s.tableName)).toEqual([
      "bank_accounts",
      "bank_balances",
      "bank_transactions",
    ]);
    for (const schema of source.analyticsSchemas ?? []) {
      expect(schema.sharedDiscriminatorColumn).toBe("source_account_id");
      expect(schema.primaryKey.length).toBeGreaterThan(0);
    }
    // Which country and which bank are answered during the connect flow, not
    // configured on a form beforehand, so the source declares no parameters.
    expect(source.params).toBeUndefined();
    expect(source.icon?.url).toBe("https://enablebanking.com/apple-touch-icon.png");
  });
});

// ── authenticate (the session contract) ─────────────────────────────

interface AuthApiOptions {
  /** Banks `GET /aspsps` serves for the country asked about. */
  aspsps?: Array<{ name: string; country: string }>;
  /** Fail `GET /aspsps` with this status instead of answering. */
  aspspsStatus?: number;
  /** Fail every `/transactions` fetch, as an expired post-approval window does. */
  transactionsStatus?: number;
  /** Refuse `POST /auth` with this machine-readable error code (HTTP 400). */
  authError?: string;
  calls?: Array<{ url: string; init?: RequestInit }>;
}

/** A fake upstream covering every endpoint `authenticate` reaches. */
function authApi(opts: AuthApiOptions = {}): typeof fetch {
  const calls = opts.calls ?? [];
  const pages = [
    {
      transactions: [
        {
          entry_reference: "ref-1",
          booking_date: "2020-02-01",
          transaction_amount: { currency: "EUR", amount: "10.00" },
          credit_debit_indicator: "DBIT",
          status: "BOOK",
        },
      ],
      continuation_key: "ck-1",
    },
    { transactions: [] },
  ];
  let pageIdx = 0;

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (url.includes("/aspsps")) {
      if (opts.aspspsStatus) return json({ error: "REFUSED" }, opts.aspspsStatus);
      return json({
        aspsps: opts.aspsps ?? [
          { name: "Revolut", country: "DE" },
          { name: "Riverside Bank", country: "DE" },
        ],
      });
    }
    if (url.endsWith("/auth")) {
      if (opts.authError) return json({ error: opts.authError }, 400);
      return json({ url: "https://bank.example/sca", authorization_id: "auth-1" });
    }
    if (url.endsWith("/sessions")) {
      return json({
        session_id: "sess-1",
        accounts: [
          {
            uid: "uid-1",
            identification_hash: "hash-aaa",
            account_id: { iban: "DE89975713758667268881" },
            currency: "EUR",
            name: "Everyday EUR",
            cash_account_type: "CACC",
          },
        ],
        access: { valid_until: "2026-11-28T12:00:00.000Z" },
        aspsp: { name: "Revolut", country: "DE" },
      });
    }
    if (url.includes("/transactions")) {
      if (opts.transactionsStatus) {
        return json({ error: "WRONG_REQUEST_PARAMETERS" }, opts.transactionsStatus);
      }
      const page = pages[Math.min(pageIdx, pages.length - 1)];
      pageIdx++;
      return json(page);
    }
    return json({ error: "NOT_FOUND" }, 404);
  }) as unknown as typeof fetch;
}

/**
 * A scripted `AuthSession`. A `fields` answer runs through the same schema the
 * challenge was built from, exactly as the host does — so a test that answers
 * with a bank the challenge never offered fails here rather than passing on a
 * value no operator could have produced.
 */
function scriptSession(
  options: {
    accountId?: string;
    supplied?: Record<string, string>;
    answers?: Record<string, string>;
    answerCode?: () => Promise<{ code: string }>;
  } = {},
): { session: AuthSession; asked: AskableChallenge[] } {
  const asked: AskableChallenge[] = [];
  const session: AuthSession = {
    reason: options.accountId ? "reauthenticate" : "connect",
    flowId: "flow-123",
    accountId: options.accountId,
    supplied: options.supplied ?? {},
    host: { ...fakeProviderHost({ now: NOW }), configDir },
    canShow: () => true,
    show: () => {},
    ask: (challenge) => {
      asked.push(challenge);
      if (challenge.kind === "fields") {
        const parsed = parseFieldsAnswer(challenge, { ...(options.answers ?? {}) });
        if (!parsed.ok) {
          return Promise.reject(
            new AuthFailure("unknown", `answer rejected: ${parsed.issues.join("; ")}`),
          ) as never;
        }
        return Promise.resolve(parsed.value) as never;
      }
      const code = options.answerCode ?? (() => Promise.resolve({ code: "decoded-code" }));
      return code() as never;
    },
  };
  return { session, asked };
}

function fieldsAsked(asked: AskableChallenge[]): FieldsChallenge[] {
  return asked.filter((c): c is FieldsChallenge => c.kind === "fields");
}

/** The values a `select` field offers, in the order the operator sees them. */
function optionsOf(challenge: FieldsChallenge, field: string): string[] {
  const declared = challenge.schema.fields[field];
  if (!declared || declared.kind !== "select") throw new Error(`${field} is not a select`);
  return declared.options.map((o) => o.value);
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

describe("authenticate — which bank, asked in two steps", () => {
  test("the country is asked first, then the bank, from the live list for that country", async () => {
    await writeCredentials(PEM);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const { session, asked } = scriptSession({
      answers: { country: "DE", bank: "Revolut" },
    });

    const result = await authenticateWith(session, { fetchImpl: authApi({ calls }) });

    const fields = fieldsAsked(asked);
    expect(fields).toHaveLength(2);
    // The country comes from the covered markets, which is a fixed list.
    expect(optionsOf(fields[0], "country")).toContain("DE");
    expect(optionsOf(fields[0], "country")).toContain("GB");
    // The bank list is whatever the upstream is serving for the answered
    // country right now — which is what makes a bank that is not there
    // unpickable, rather than a failure after the fact.
    expect(optionsOf(fields[1], "bank")).toEqual(["Revolut", "Riverside Bank"]);
    // …and the list was fetched for the country that was just answered.
    expect(calls.find((c) => c.url.includes("/aspsps"))!.url).toContain("country=DE");

    expect(result.accounts).toEqual([
      {
        accountId: "revolut-de",
        state: { status: "connected", expiresAt: "2026-11-28T12:00:00.000Z" },
      },
    ]);
    expect(loadSession("revolut-de", configDir)?.session_id).toBe("sess-1");
  });

  test("the list is fetched for the country the operator answered, not a fixed one", async () => {
    await writeCredentials(PEM);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const { session } = scriptSession({ answers: { country: "FR", bank: "Northstar Savings" } });

    const result = await authenticateWith(session, {
      fetchImpl: authApi({ aspsps: [{ name: "Northstar Savings", country: "FR" }], calls }),
    });

    expect(calls.find((c) => c.url.includes("/aspsps"))!.url).toContain("country=FR");
    const authBody = JSON.parse(String(calls.find((c) => c.url.endsWith("/auth"))!.init?.body));
    expect(authBody.aspsp).toEqual({ name: "Northstar Savings", country: "FR" });
    // The account id is the bank and the country it was connected in, so two
    // countries' branches of one bank never collapse into one account.
    expect(result.accounts[0].accountId).toBe("northstar-savings-fr");
  });

  test("the bank list is deduplicated and ordered, whatever the API returns", async () => {
    await writeCredentials(PEM);
    const { session, asked } = scriptSession({
      answers: { country: "DE", bank: "Northstar Savings" },
    });
    await authenticateWith(session, {
      fetchImpl: authApi({
        aspsps: [
          { name: "Riverside Bank", country: "DE" },
          { name: "Northstar Savings", country: "DE" },
          { name: "Riverside Bank", country: "DE" },
        ],
      }),
    });
    expect(optionsOf(fieldsAsked(asked)[1], "bank")).toEqual([
      "Northstar Savings",
      "Riverside Bank",
    ]);
  });

  test("a country with no banks behind it is refused, not offered an empty list", async () => {
    await writeCredentials(PEM);
    const { session } = scriptSession({ answers: { country: "MT", bank: "anything" } });
    const failure = await failureOf(
      authenticateWith(session, { fetchImpl: authApi({ aspsps: [] }) }),
    );
    expect(failure.code).toBe("unsupported");
    expect(failure.message).toContain("Malta");
  });

  test("the redirect is the one the gateway catches, and carries the flow id as state", async () => {
    await writeCredentials(PEM);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const { session, asked } = scriptSession({ answers: { country: "DE", bank: "Revolut" } });
    await authenticateWith(session, { fetchImpl: authApi({ calls }) });

    const redirect = asked.find((c) => c.kind === "redirect");
    if (!redirect || redirect.kind !== "redirect") throw new Error("no redirect challenge");
    expect(redirect.url).toBe("https://bank.example/sca");
    expect(redirect.via).toBe("gateway");
    const authBody = JSON.parse(String(calls.find((c) => c.url.endsWith("/auth"))!.init?.body));
    expect(authBody.state).toBe("flow-123");
    expect(authBody.redirect_url).toBe("https://gateway.example:7600/oauth/callback");
    expect(authBody.access.valid_until).toBe(
      new Date(NOW.getTime() + 180 * 86_400_000).toISOString(),
    );
  });
});

describe("authenticate — values an older client already collected", () => {
  test("a country and bank supplied on the add form are used, and nothing is asked", async () => {
    await writeCredentials(PEM);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    // Lowercase, as a form value can be: `supplied` never went through a
    // challenge, so nothing has normalised it.
    const { session, asked } = scriptSession({ supplied: { country: " de ", bank: "revolut" } });

    const result = await authenticateWith(session, { fetchImpl: authApi({ calls }) });

    expect(fieldsAsked(asked)).toEqual([]);
    expect(calls.find((c) => c.url.includes("/aspsps"))!.url).toContain("country=DE");
    expect(result.accounts[0].accountId).toBe("revolut-de");
  });

  test("only the missing half is asked for", async () => {
    await writeCredentials(PEM);
    const { session, asked } = scriptSession({
      supplied: { country: "DE" },
      answers: { bank: "Revolut" },
    });
    await authenticateWith(session, { fetchImpl: authApi({}) });
    const fields = fieldsAsked(asked);
    expect(fields).toHaveLength(1);
    expect(Object.keys(fields[0].schema.fields)).toEqual(["bank"]);
  });

  test("a country outside the covered markets is treated as unanswered", async () => {
    await writeCredentials(PEM);
    const { session, asked } = scriptSession({
      supplied: { country: "ZZ", bank: "Revolut" },
      answers: { country: "DE" },
    });
    const result = await authenticateWith(session, { fetchImpl: authApi({}) });
    // The country is asked; the bank, which does resolve once the country is
    // known, is not asked again.
    expect(fieldsAsked(asked).map((c) => Object.keys(c.schema.fields)[0])).toEqual(["country"]);
    expect(result.accounts[0].accountId).toBe("revolut-de");
  });

  test("a supplied bank the country does not serve becomes the question, not a failure", async () => {
    await writeCredentials(PEM);
    const { session, asked } = scriptSession({
      supplied: { country: "DE", bank: "Revoult Bank" },
      answers: { bank: "Revolut" },
    });
    const result = await authenticateWith(session, { fetchImpl: authApi({}) });
    const fields = fieldsAsked(asked);
    expect(fields).toHaveLength(1);
    expect(fields[0].instructions).toContain("Revoult Bank");
    expect(result.accounts[0].accountId).toBe("revolut-de");
  });
});

describe("authenticate — renewing a consent", () => {
  function storeConsent(): void {
    saveSession(
      "revolut-de",
      {
        session_id: "sess-expired",
        valid_until: "2026-05-01T00:00:00.000Z",
        aspsp: { name: "Revolut", country: "DE" },
        accounts: [],
      },
      configDir,
    );
  }

  test("the bank comes from the stored consent, and nothing is asked", async () => {
    await writeCredentials(PEM);
    storeConsent();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const { session, asked } = scriptSession({ accountId: "revolut-de" });

    const result = await authenticateWith(session, { fetchImpl: authApi({ calls }) });

    expect(fieldsAsked(asked)).toEqual([]);
    expect(calls.find((c) => c.url.includes("/aspsps"))!.url).toContain("country=DE");
    expect(result.accounts[0].accountId).toBe("revolut-de");
    // The consent was replaced by the fresh one.
    expect(loadSession("revolut-de", configDir)?.session_id).toBe("sess-1");
  });

  test("parameters that arrive alongside a renewal never redirect it to another bank", async () => {
    // A renewal is started from a banner that posts no parameters; anything
    // that does arrive would otherwise attach a different bank to this
    // account's existing data under its old slug.
    await writeCredentials(PEM);
    storeConsent();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const { session } = scriptSession({
      accountId: "revolut-de",
      supplied: { country: "FR", bank: "Riverside Bank" },
    });

    const result = await authenticateWith(session, { fetchImpl: authApi({ calls }) });

    expect(calls.find((c) => c.url.includes("/aspsps"))!.url).toContain("country=DE");
    expect(result.accounts[0].accountId).toBe("revolut-de");
    expect(loadSession("revolut-de", configDir)?.aspsp).toEqual({ name: "Revolut", country: "DE" });
  });

  test("a renewal for an account with no stored consent is refused, not asked again", async () => {
    await writeCredentials(PEM);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const { session, asked } = scriptSession({ accountId: "ghost-bank-xx" });

    const failure = await failureOf(authenticateWith(session, { fetchImpl: authApi({ calls }) }));

    expect(failure.message).toContain("ghost-bank-xx");
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);
    expect(discoverAccounts(configDir)).toEqual([]);
  });

  test("a stored bank the upstream no longer lists is named, not silently re-asked", async () => {
    await writeCredentials(PEM);
    storeConsent();
    const { session, asked } = scriptSession({ accountId: "revolut-de" });
    const failure = await failureOf(
      authenticateWith(session, {
        fetchImpl: authApi({ aspsps: [{ name: "Riverside Bank", country: "DE" }] }),
      }),
    );
    expect(failure.code).toBe("unsupported");
    expect(asked).toEqual([]);
  });
});

describe("authenticate — the one-shot history capture", () => {
  test("a storage key lost during capture refuses consent completion and preserves the consent", async () => {
    await ensureInstallRootKey({ configDir, backend: "file" });
    await writeCredentials(PEM);
    const inner = authApi({});
    const losingKey: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/transactions")) {
        await createSecretStore({ configDir, backend: "file" }).delete(OMNESIS_INSTALL_ROOT_KEY);
        clearSecretFileKeyCacheForTests();
      }
      return inner(input, init);
    }) as typeof fetch;
    const { session } = scriptSession({ answers: { country: "DE", bank: "Revolut" } });
    await expect(authenticateWith(session, { fetchImpl: losingKey })).rejects.toThrow(
      /install root key/,
    );
    const dir = bootstrapAccountDir("revolut-de", "hash-aaa", configDir);
    expect(existsSync(sessionPath("revolut-de", configDir))).toBe(true);
    expect(existsSync(join(dir, "page-0000.json"))).toBe(false);
    expect(completedBootstrapMarker(dir)).toBeNull();
  });

  test("the consent is on disk before the first history request goes out", async () => {
    // The strong authentication is already spent by then: a crash mid-prefetch
    // must cost history, never the consent that bought it.
    await writeCredentials(PEM);
    const inner = authApi({});
    let onDiskAtFirstHistoryFetch: boolean | undefined;
    const probing: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/transactions") && onDiskAtFirstHistoryFetch === undefined) {
        onDiskAtFirstHistoryFetch = loadSession("revolut-de", configDir) !== null;
      }
      return inner(input, init);
    }) as typeof fetch;

    const { session } = scriptSession({ answers: { country: "DE", bank: "Revolut" } });
    await authenticateWith(session, { fetchImpl: probing });
    expect(onDiskAtFirstHistoryFetch).toBe(true);
  });

  test("a capture that fails is reported beside the success, not only logged", async () => {
    await writeCredentials(PEM);
    const { session } = scriptSession({ answers: { country: "DE", bank: "Revolut" } });

    const result = await authenticateWith(session, {
      fetchImpl: authApi({ transactionsStatus: 422 }),
    });

    // The bank is connected: the capture is what failed, and it costs history
    // rather than the connection.
    expect(result.accounts[0].state).toEqual({
      status: "connected",
      expiresAt: "2026-11-28T12:00:00.000Z",
    });
    expect(result.notices).toHaveLength(1);
    const notice = result.notices![0];
    expect(notice.title).toContain("1 account");
    // Named the way the operator sees the account, and told what it costs.
    expect(notice.detail).toContain("Everyday EUR");
    expect(notice.detail).toContain("90 days");
    // No completion marker, so sync takes the 90-day fallback.
    expect(
      completedBootstrapMarker(bootstrapAccountDir("revolut-de", "hash-aaa", configDir)),
    ).toBeNull();
  });

  test("a capture that succeeds reports nothing extra", async () => {
    await writeCredentials(PEM);
    const { session } = scriptSession({ answers: { country: "DE", bank: "Revolut" } });
    const result = await authenticateWith(session, { fetchImpl: authApi({}) });
    expect(result.notices).toBeUndefined();
    expect(
      completedBootstrapMarker(bootstrapAccountDir("revolut-de", "hash-aaa", configDir)),
    ).toEqual({ pages: 2, sessionId: "sess-1" });
  });

  test("a key given as a path is re-persisted as content once the flow succeeds", async () => {
    const pemPath = join(configDir, "app.pem");
    writeFileSync(pemPath, PEM);
    await writeCredentials(pemPath);

    const { session } = scriptSession({ answers: { country: "DE", bank: "Revolut" } });
    await authenticateWith(session, { fetchImpl: authApi({}) });

    const fields = await readProviderCredentials("enable-banking", configDir);
    expect(fields?.private_key).toContain("-----BEGIN");
  });
});

describe("authenticate — what a refusal means", () => {
  test("nothing configured raises into the credentials wizard", async () => {
    const { session } = scriptSession({ answers: { country: "DE", bank: "Revolut" } });
    await expect(authenticateWith(session, { fetchImpl: authApi({}) })).rejects.toBeInstanceOf(
      MissingCredentialsError,
    );
  });

  test("a private key stored as a missing path names the field, never the path", async () => {
    // The message is copied onto a flow record the admin listing hands to
    // every caller, so an absolute path on this machine must not ride on it.
    const secretPath = join(configDir, "nowhere", "app.pem");
    await writeCredentials(secretPath);
    const { session } = scriptSession({});

    const failure = await failureOf(authenticateWith(session, { fetchImpl: authApi({}) }));

    expect(failure.code).toBe("credential-rejected");
    expect(failure.message).not.toContain(secretPath);
    expect(failure.remedy).not.toContain(secretPath);
    expect(failure.message).toMatch(/private key/i);
  });

  test("a private key that is not a PEM is a credential to replace", async () => {
    await writeCredentials(
      "-----BEGIN EXAMPLE KEY-----\nnot base64 ***\n-----END EXAMPLE KEY-----",
    );
    const { session } = scriptSession({});
    const failure = await failureOf(authenticateWith(session, { fetchImpl: authApi({}) }));
    expect(failure.code).toBe("credential-rejected");
  });

  test("an application key the upstream refuses is a credential to replace, not a denial", async () => {
    await writeCredentials(PEM);
    const { session } = scriptSession({ answers: { country: "DE", bank: "Revolut" } });
    const failure = await failureOf(
      authenticateWith(session, { fetchImpl: authApi({ aspspsStatus: 401 }) }),
    );
    expect(failure.code).toBe("credential-rejected");
    expect(failure.remedy).toMatch(/application/i);
  });

  test("a redirect URL the application does not allow names the URL and where to allow it", async () => {
    // The default redirect URL is built from the gateway's own address, so a
    // second gateway sends a different one from the first and is refused. The
    // bare platform code named neither the URL nor what to do about it, and
    // the failure read as `unknown` — which a client cannot act on.
    await writeCredentials(PEM);
    const { session } = scriptSession({ answers: { country: "DE", bank: "Revolut" } });

    const failure = await failureOf(
      authenticateWith(session, { fetchImpl: authApi({ authError: "REDIRECT_URI_NOT_ALLOWED" }) }),
    );

    expect(failure.code).toBe("credential-rejected");
    expect(failure.message).toContain("https://gateway.example:7600/oauth/callback");
    expect(failure.remedy).toContain("https://gateway.example:7600/oauth/callback");
    expect(failure.remedy).toMatch(/allowed redirect URLs/);
  });

  test("any other refusal of the authorization request stays unknown", async () => {
    // Only a code whose meaning is known is translated; guessing at the rest
    // would send the operator to fix something that is not broken.
    await writeCredentials(PEM);
    const { session } = scriptSession({ answers: { country: "DE", bank: "Revolut" } });

    const failure = await failureOf(
      authenticateWith(session, { fetchImpl: authApi({ authError: "SOMETHING_ELSE" }) }),
    );

    expect(failure.code).toBe("unknown");
    expect(failure.message).toContain("SOMETHING_ELSE");
  });

  test.each([429, 503])("HTTP %s is the upstream being unreachable", async (status) => {
    await writeCredentials(PEM);
    const { session } = scriptSession({ answers: { country: "DE", bank: "Revolut" } });
    const failure = await failureOf(
      authenticateWith(session, { fetchImpl: authApi({ aspspsStatus: status }) }),
    );
    expect(failure.code).toBe("unavailable");
    expect(isRetryable(failure.code)).toBe(true);
  });

  test("a bank that says when it will answer again passes that on", async () => {
    // Telling an operator to come back is a different instruction from telling
    // them when, and for this platform the answer is six hours: without it they
    // spend the afternoon retrying a flow that cannot succeed yet.
    await writeCredentials(PEM);
    const { session } = scriptSession({ answers: { country: "DE", bank: "Revolut" } });
    const failure = await failureOf(
      authenticateWith(session, { fetchImpl: authApi({ aspspsStatus: 429 }) }),
    );
    expect(failure.retryAfterMs).toBe(EB_RATE_LIMIT_RETRY_MS);
  });

  test("and says nothing about waiting when the platform did not", async () => {
    await writeCredentials(PEM);
    const { session } = scriptSession({ answers: { country: "DE", bank: "Revolut" } });
    const failure = await failureOf(
      authenticateWith(session, { fetchImpl: authApi({ aspspsStatus: 503 }) }),
    );
    expect(failure.retryAfterMs).toBeUndefined();
  });

  test("an operator who refuses at the bank ends the flow as a denial", async () => {
    // The bank redirects with an error the gateway catches, and the challenge
    // waiting on it reports that itself — the provider only passes it on.
    await writeCredentials(PEM);
    const { session } = scriptSession({
      answers: { country: "DE", bank: "Revolut" },
      answerCode: () => Promise.reject(new AuthFailure("denied", "access was refused")),
    });
    const failure = await failureOf(authenticateWith(session, { fetchImpl: authApi({}) }));
    expect(failure.code).toBe("denied");
    // Nothing was stored: the consent never existed.
    expect(discoverAccounts(configDir)).toEqual([]);
  });
});
