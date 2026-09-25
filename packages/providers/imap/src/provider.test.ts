// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readProviderAccountCredentials, writeProviderAccountCredentials } from "@omnesis/core";
import { AccountId, SyncError } from "@omnesis/types";
import { AuthFailure, isRetryable, type AuthSession } from "@omnesis/source-sdk";
import { fakeProviderHost } from "@omnesis/source-sdk/testing";
import { imapCredentialsSpec } from "./credentials-spec.js";
import { authenticate, authFlow } from "./provider.js";
import { createImapClient } from "./client.js";
import imapProvider from "./index.js";

vi.mock("./client.js", () => ({ createImapClient: vi.fn() }));

const mockedCreateClient = vi.mocked(createImapClient);

describe("IMAP credentials questionnaire", () => {
  it("stays generic across TLS IMAP providers", () => {
    const questionnaire = JSON.stringify(imapCredentialsSpec);

    expect(questionnaire).not.toMatch(/Fastmail|iCloud/i);
    expect(questionnaire).toMatch(/IMAP provider/i);
    expect(questionnaire).toMatch(/TLS.*993/i);
    expect(questionnaire).toMatch(/app-specific password/i);
    expect(imapCredentialsSpec.fields.find((field) => field.name === "app_password")?.label).toBe(
      "IMAP password",
    );
  });
});

describe("IMAP auth flow", () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "omnesis-imap-auth-"));
    mockedCreateClient.mockReset();
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  it("a client that cannot ask is routed to the wizard when the stored password is refused", async () => {
    // This entry point is what an older client drives, and it asks for
    // nothing: a renewal revalidates the stored password, so when that
    // password is the thing that stopped working there is no way to offer a
    // new one. Reporting it as a missing credential is what opens the wizard
    // that collects a replacement, and it is the whole recovery for such a
    // client. The typed path asks directly and must not do this.
    await writeProviderAccountCredentials(
      "imap",
      "maya@example.org",
      {
        host: "imap.example.org",
        username: "maya@example.org",
        app_password: "revoked",
      },
      configDir,
    );
    const connect = vi.fn(() =>
      Promise.reject(
        new SyncError("auth", "IMAP credentials were rejected", { scope: "connection" }),
      ),
    );
    const close = vi.fn(() => Promise.resolve());
    mockedCreateClient.mockReturnValue({ connect, close } as never);

    await expect(
      authFlow(undefined, { accountId: AccountId("maya@example.org") }, { configDir }),
    ).rejects.toMatchObject({ code: "missing-credentials", fileKey: "imap" });
  });

  it("but a client that pasted a password is told it was refused, not that none exists", async () => {
    const connect = vi.fn(() =>
      Promise.reject(
        new SyncError("auth", "IMAP credentials were rejected", { scope: "connection" }),
      ),
    );
    const close = vi.fn(() => Promise.resolve());
    mockedCreateClient.mockReturnValue({ connect, close } as never);

    await expect(
      authFlow(
        undefined,
        {
          accountId: AccountId("maya@example.org"),
          credentials: {
            host: "imap.example.org",
            username: "maya@example.org",
            app_password: "also-wrong",
          },
        },
        { configDir },
      ),
    ).rejects.toMatchObject({ kind: "auth" });
  });

  it("reuses the account-scoped credential when reauth sends no fields", async () => {
    await writeProviderAccountCredentials(
      "imap",
      "account@example.com",
      {
        host: "imap.example.com",
        username: "account@example.com",
        app_password: "stored-app-password",
      },
      configDir,
    );
    const connect = vi.fn(() => Promise.resolve());
    const close = vi.fn(() => Promise.resolve());
    mockedCreateClient.mockReturnValue({ connect, close } as never);

    await expect(authFlow({}, { accountId: "account@example.com" }, { configDir })).resolves.toBe(
      "account@example.com",
    );

    expect(mockedCreateClient).toHaveBeenCalledWith({
      host: "imap.example.com",
      username: "account@example.com",
      password: "stored-app-password",
    });
  });

  it("rejects account rebinding before contacting a server", async () => {
    await expect(
      authFlow(
        {},
        {
          accountId: "first@example.com",
          credentials: {
            host: "imap.example.com",
            username: "second@example.com",
            app_password: "invented-app-password",
          },
        },
        { configDir },
      ),
    ).rejects.toThrow(/separate IMAP account/);
    expect(mockedCreateClient).not.toHaveBeenCalled();
  });

  it("leaves no credential when login fails", async () => {
    const close = vi.fn(() => Promise.resolve());
    mockedCreateClient.mockReturnValue({
      connect: vi.fn(() => Promise.reject(new Error("authentication failed"))),
      close,
    } as never);

    await expect(
      authFlow(
        {},
        {
          credentials: {
            host: "imap.example.com",
            username: "account@example.com",
            app_password: "invented-app-password",
          },
        },
        { configDir },
      ),
    ).rejects.toThrow("authentication failed");

    expect(close).toHaveBeenCalledOnce();
    await expect(
      readProviderAccountCredentials("imap", "account@example.com", configDir),
    ).resolves.toBeNull();
  });

  it("validates TLS login before storing per-account credentials", async () => {
    const connect = vi.fn(() => Promise.resolve());
    const close = vi.fn(() => Promise.resolve());
    mockedCreateClient.mockReturnValue({ connect, close } as never);

    const accountId = await authFlow(
      {},
      {
        credentials: {
          host: "imap.example.com",
          username: "account@example.com",
          app_password: "invented-app-password",
        },
      },
      { configDir },
    );

    expect(accountId).toBe("account@example.com");
    expect(mockedCreateClient).toHaveBeenCalledWith({
      host: "imap.example.com",
      username: "account@example.com",
      password: "invented-app-password",
    });
    expect(connect).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    await expect(
      readProviderAccountCredentials("imap", "account@example.com", configDir),
    ).resolves.toEqual({
      host: "imap.example.com",
      username: "account@example.com",
      app_password: "invented-app-password",
    });
  });
});

describe("connecting an IMAP mailbox through the typed session", () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "omnesis-imap-session-"));
    mockedCreateClient.mockReset();
  });

  afterEach(async () => {
    await chmod(join(configDir, "imap", "account@example.com"), 0o700).catch(() => {});
    await rm(configDir, { recursive: true, force: true });
  });

  const CREDENTIALS = {
    host: "imap.example.com",
    username: "account@example.com",
    app_password: "invented-app-password",
  };

  /** A session that answers the one question this flow asks. */
  function session(answer: Record<string, string>, overrides: Partial<AuthSession> = {}) {
    const shown: Array<{ kind: string; title: string }> = [];
    const asked: Array<{ kind: string; title: string; prefill?: Record<string, string> }> = [];
    const s: AuthSession = {
      reason: overrides.accountId ? "reauthenticate" : "connect",
      flowId: "flow-1",
      supplied: {},
      host: { ...fakeProviderHost(), configDir },
      canShow: () => true,
      show: (c) => void shown.push({ kind: c.kind, title: c.title }),
      ask: (c) => {
        asked.push({
          kind: c.kind,
          title: c.title,
          ...(c.kind === "fields" && c.prefill ? { prefill: c.prefill } : {}),
        });
        return Promise.resolve(answer as never);
      },
      ...overrides,
    };
    return { session: s, shown, asked };
  }

  /** A client whose login succeeds. */
  function loginSucceeds() {
    const connect = vi.fn(() => Promise.resolve());
    const close = vi.fn(() => Promise.resolve());
    mockedCreateClient.mockReturnValue({ connect, close } as never);
    return { connect, close };
  }

  /** A client whose login fails with `error`. */
  function loginFails(error: unknown) {
    const close = vi.fn(() => Promise.resolve());
    mockedCreateClient.mockReturnValue({
      connect: vi.fn(() => Promise.reject(error)),
      close,
    } as never);
    return { close };
  }

  async function seedStored(fields: Record<string, string>): Promise<void> {
    await writeProviderAccountCredentials("imap", "account@example.com", fields, configDir);
  }

  async function failureFrom(
    upstream: unknown,
    answer: Record<string, string> = CREDENTIALS,
  ): Promise<AuthFailure> {
    loginFails(upstream);
    const caught = await authenticate(session(answer).session).then(
      () => null,
      (e: unknown) => e,
    );
    expect(caught).toBeInstanceOf(AuthFailure);
    return caught as AuthFailure;
  }

  it("wires the descriptor to the session flow", () => {
    expect(typeof imapProvider.authenticate).toBe("function");
  });

  it("asks for the whole triple, checks the login, then stores it", async () => {
    // None of the three is a source setting: the hostname is how the
    // connection is made and the address is the account's own identity, so
    // both belong to the credential and are asked for with the password.
    const { connect, close } = loginSucceeds();
    const { session: s, asked, shown } = session(CREDENTIALS);

    const result = await authenticate(s);

    expect(asked).toEqual([{ kind: "fields", title: "Connect an IMAP account" }]);
    expect(shown).toEqual([{ kind: "wait", title: "Checking the connection" }]);
    expect(mockedCreateClient).toHaveBeenCalledWith({
      host: "imap.example.com",
      username: "account@example.com",
      password: "invented-app-password",
    });
    expect(connect).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(result.accounts).toEqual([
      { accountId: "account@example.com", state: { status: "connected" } },
    ]);
    await expect(
      readProviderAccountCredentials("imap", "account@example.com", configDir),
    ).resolves.toEqual(CREDENTIALS);
  });

  it("offers a renewal the stored hostname and address, without the password", async () => {
    // Prefilled so the operator retypes only what changed, and never the
    // secret: what is on disk is what stopped working.
    await seedStored({ ...CREDENTIALS, app_password: "revoked-app-password" });
    loginSucceeds();
    const { session: s, asked } = session(CREDENTIALS, { accountId: "account@example.com" });

    await authenticate(s);

    expect(asked).toEqual([
      {
        kind: "fields",
        title: "Reconnect account@example.com",
        prefill: { host: "imap.example.com", username: "account@example.com" },
      },
    ]);
  });

  it("takes a replacement password when the stored one is refused", async () => {
    // A renewal asks, so a revoked password is answered with a fresh one on
    // the spot rather than ending the flow on the credential that is the very
    // thing that stopped working.
    await seedStored({ ...CREDENTIALS, app_password: "revoked-app-password" });
    loginSucceeds();
    const { session: s } = session(
      { ...CREDENTIALS, app_password: "replacement-app-password" },
      { accountId: "account@example.com" },
    );

    const result = await authenticate(s);

    expect(result.accounts[0]?.accountId).toBe("account@example.com");
    await expect(
      readProviderAccountCredentials("imap", "account@example.com", configDir),
    ).resolves.toEqual({ ...CREDENTIALS, app_password: "replacement-app-password" });
  });

  it("lets a renewal move the mailbox to the hostname its provider now publishes", async () => {
    // The prefill is a starting point, not a fixed value: a provider that
    // renames its IMAP host is repaired here, and the account is unchanged
    // because the address is what names it.
    await seedStored(CREDENTIALS);
    loginSucceeds();
    const { session: s } = session(
      { ...CREDENTIALS, host: "imap2.example.com" },
      { accountId: "account@example.com" },
    );

    const result = await authenticate(s);

    expect(mockedCreateClient).toHaveBeenCalledWith({
      host: "imap2.example.com",
      username: "account@example.com",
      password: "invented-app-password",
    });
    expect(result.accounts[0]?.accountId).toBe("account@example.com");
    await expect(
      readProviderAccountCredentials("imap", "account@example.com", configDir),
    ).resolves.toEqual({ ...CREDENTIALS, host: "imap2.example.com" });
  });

  it("does not rewrite the secret when the renewal changed nothing", async () => {
    // Storing goes through the keyring, and re-encrypting three unchanged
    // values buys nothing. The account directory is made unwritable, so a
    // write that should not happen fails loudly instead of passing unnoticed.
    await seedStored(CREDENTIALS);
    loginSucceeds();
    await chmod(join(configDir, "imap", "account@example.com"), 0o500);
    const { session: s } = session(CREDENTIALS, { accountId: "account@example.com" });

    const result = await authenticate(s);

    expect(result.accounts[0]?.accountId).toBe("account@example.com");
  });

  it("refuses another mailbox before contacting any server", async () => {
    loginSucceeds();
    const { session: s } = session(
      { ...CREDENTIALS, username: "second@example.com" },
      { accountId: "account@example.com" },
    );

    const failure = await authenticate(s).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(AuthFailure);
    expect((failure as AuthFailure).code).toBe("identity-mismatch");
    expect((failure as AuthFailure).remedy).toMatch(/separate IMAP account/);
    expect(mockedCreateClient).not.toHaveBeenCalled();
  });

  it("takes a triple a client already collected rather than asking twice", async () => {
    loginSucceeds();
    const { session: s, asked } = session(
      { host: "never.example.com", username: "never@example.com", app_password: "never" },
      { supplied: CREDENTIALS },
    );

    const result = await authenticate(s);

    expect(asked).toEqual([]);
    expect(result.accounts[0]?.accountId).toBe("account@example.com");
  });

  it("still asks when a client collected only part of the triple", async () => {
    loginSucceeds();
    const { session: s, asked } = session(CREDENTIALS, {
      supplied: { host: "imap.example.com", username: "account@example.com" },
    });

    await authenticate(s);

    expect(asked).toHaveLength(1);
  });

  it("tells a refused password apart from a server that is simply not there", async () => {
    const rejected = await failureFrom(new SyncError("auth", "IMAP credentials were rejected"));
    expect(rejected.code).toBe("credential-rejected");
    expect(rejected.remedy).toMatch(/app-specific password/);
    expect(isRetryable(rejected.code)).toBe(true);

    for (const kind of ["network", "transient"] as const) {
      const down = await failureFrom(new SyncError(kind, `IMAP ${kind}`));
      expect(down.code).toBe("unavailable");
      expect(isRetryable(down.code)).toBe(true);
    }
  });

  it("names a certificate it cannot verify instead of quoting the library", async () => {
    // A trust failure is not classified upstream, so left alone it reaches the
    // operator as text about issuers and chains, and as something that might
    // clear by waiting. It will not.
    const untrusted = Object.assign(new Error("unable to verify the first certificate"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });

    const failure = await failureFrom(untrusted);

    expect(failure.code).toBe("insecure-connection");
    expect(failure.message).toContain("imap.example.com");
    expect(failure.message).toContain("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
    expect(failure.message).not.toContain("unable to verify the first certificate");
    expect(failure.remedy).toMatch(/hostname/i);
    expect(isRetryable(failure.code)).toBe(false);
  });

  it("finds a certificate failure the library wrapped in another error", async () => {
    const wrapped = new Error("IMAP connection failed", {
      cause: Object.assign(new Error("self signed certificate in certificate chain"), {
        code: "SELF_SIGNED_CERT_IN_CHAIN",
      }),
    });

    const failure = await failureFrom(wrapped);

    expect(failure.code).toBe("insecure-connection");
  });

  it("says it does not know when the server fails in a way nothing names", async () => {
    const failure = await failureFrom(new Error("mailbox unavailable"));

    expect(failure.code).toBe("unknown");
    expect(failure.message).toBe("mailbox unavailable");
  });

  it("leaves no credential behind when the login fails", async () => {
    const { close } = loginFails(new SyncError("auth", "IMAP credentials were rejected"));

    await expect(authenticate(session(CREDENTIALS).session)).rejects.toBeInstanceOf(AuthFailure);

    expect(close).toHaveBeenCalledOnce();
    await expect(
      readProviderAccountCredentials("imap", "account@example.com", configDir),
    ).resolves.toBeNull();
  });

  it("refuses a hostname that is not one, and says what to check", async () => {
    loginSucceeds();
    const { session: s } = session({ ...CREDENTIALS, host: "not a hostname" });

    const failure = await authenticate(s).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(AuthFailure);
    expect((failure as AuthFailure).code).toBe("credential-rejected");
    expect((failure as AuthFailure).remedy).toMatch(/hostname/);
    expect(mockedCreateClient).not.toHaveBeenCalled();
  });

  it("declares every field it asks for, so a client can render the form", () => {
    expect(imapCredentialsSpec.fields.map((f) => f.name)).toEqual([
      "host",
      "username",
      "app_password",
    ]);
    expect(imapCredentialsSpec.fields.find((f) => f.name === "app_password")?.secret).toBe(true);
  });
});

describe("IMAP account subjects", () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "omnesis-imap-discover-"));
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  it("names an address login as an email and a bare login as a handle", async () => {
    // A server may accept the part of the address before the `@` as the
    // login; that is a user name, not an address anyone could be mailed at.
    for (const login of ["maya@example.org", "jamie"]) {
      await writeProviderAccountCredentials(
        "imap",
        login,
        { host: "imap.example.org", username: login, app_password: "fictional" },
        configDir,
      );
    }

    const accounts = await imapProvider.discover!({ configDir } as never);

    expect(accounts).toEqual(
      expect.arrayContaining([
        { id: "maya@example.org", subject: { kind: "email", value: "maya@example.org" } },
        { id: "jamie", subject: { kind: "handle", value: "jamie" } },
      ]),
    );
  });
});
