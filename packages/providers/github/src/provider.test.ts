// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accountEmail,
  AuthFailure,
  credentialsChallenge,
  isRetryable,
  toWireChallenge,
  type AccountDescriptor,
  type AuthSession,
} from "@omnesis/source-sdk";
import { fakeProviderHost } from "@omnesis/source-sdk/testing";
import { writeProviderAccountCredentials } from "@omnesis/core";
import { GithubClient } from "./client.js";
import { githubCredentialsSpec } from "./credentials-spec.js";
import {
  accountIdFor,
  accountLogin,
  authenticate,
  authFlow,
  discoverAccounts,
  hasCredentials,
} from "./provider.js";
import githubProvider from "./index.js";

describe("accountIdFor", () => {
  it("is the bare login when no label is given", () => {
    expect(accountIdFor("OctoCat")).toBe("octocat");
    expect(accountIdFor("octocat", "")).toBe("octocat");
    expect(accountIdFor("octocat", "   ")).toBe("octocat");
  });

  it("appends a declared label, so a second token is its own account", () => {
    expect(accountIdFor("octocat", "acme-org")).toBe("octocat@acme-org");
    expect(accountIdFor("Octocat", "Acme-Org")).toBe("octocat@acme-org");
  });

  it("refuses a label that would corrupt the account id", () => {
    // Account ids become credential directory names and sit after the `:` in a
    // source id, so a label may not smuggle a separator in.
    for (const bad of ["acme/org", "acme:org", "acme org", "a@b", "-leading"]) {
      expect(() => accountIdFor("octocat", bad)).toThrow(/not usable/);
    }
  });
});

describe("accountLogin", () => {
  it("strips the label so a re-auth compares logins, not scopes", () => {
    expect(accountLogin("octocat")).toBe("octocat");
    expect(accountLogin("octocat@acme-org")).toBe("octocat");
    expect(accountLogin("Octocat@Acme-Org")).toBe("octocat");
  });
});

describe("authFlow re-auth guard", () => {
  const configDir = () => mkdtempSync(join(tmpdir(), "omnesis-github-auth-"));

  function withProbe(login: string) {
    vi.spyOn(GithubClient.prototype, "getUser").mockResolvedValue({ login });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a re-auth of a labelled account when the login matches", async () => {
    // The account carries a scope the token itself cannot report, so the
    // guard has to compare logins rather than whole account ids.
    withProbe("Octocat");
    const dir = configDir();
    const account = await authFlow(
      undefined,
      { accountId: "octocat@acme-org", credentials: { token: "ghp_x" } } as never,
      { configDir: dir } as never,
    );
    expect(String(account)).toBe("octocat@acme-org");
    expect(hasCredentials("octocat@acme-org", dir)).toBe(true);
  });

  it("refuses a re-auth with a token belonging to a different login", async () => {
    withProbe("someone-else");
    await expect(
      authFlow(
        undefined,
        { accountId: "octocat@acme-org", credentials: { token: "ghp_x" } } as never,
        { configDir: configDir() } as never,
      ),
    ).rejects.toThrow(/belongs to GitHub account someone-else/);
  });

  it("stores a labelled account separately from the unlabelled one", async () => {
    withProbe("octocat");
    const dir = configDir();
    await authFlow(
      undefined,
      { credentials: { token: "ghp_a" } } as never,
      {
        configDir: dir,
      } as never,
    );
    await authFlow(
      { accountLabel: "acme-org" },
      { credentials: { token: "ghp_b" } } as never,
      {
        configDir: dir,
      } as never,
    );
    expect(hasCredentials("octocat", dir)).toBe(true);
    expect(hasCredentials("octocat@acme-org", dir)).toBe(true);
    expect(discoverAccounts(dir).map(String).sort()).toEqual(["octocat", "octocat@acme-org"]);
  });
});

describe("connecting through the typed session", () => {
  const configDir = () => mkdtempSync(join(tmpdir(), "omnesis-github-session-"));

  /** A session that answers the one question this flow asks. */
  function session(answer: Record<string, string>, overrides: Partial<AuthSession> = {}) {
    const shown: Array<{ kind: string; title: string }> = [];
    const asked: Array<{ kind: string; title: string }> = [];
    const s: AuthSession = {
      reason: overrides.accountId ? "reauthenticate" : "connect",
      flowId: "flow-1",
      supplied: {},
      host: { ...fakeProviderHost(), configDir: configDir() },
      canShow: () => true,
      show: (c) => void shown.push({ kind: c.kind, title: c.title }),
      ask: (c) => {
        asked.push({ kind: c.kind, title: c.title });
        return Promise.resolve(answer as never);
      },
      ...overrides,
    };
    return { session: s, shown, asked };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks for the token, then says it is checking it", async () => {
    // The token is asked for rather than handed in, which is what lets a
    // re-authentication offer a fresh one instead of failing on the stored
    // credential that is the very thing that stopped working.
    vi.spyOn(GithubClient.prototype, "getUser").mockResolvedValue({ login: "Octocat" });
    const { session: s, asked, shown } = session({ token: "ghp_abcdefghijklmnop" });

    const result = await authenticate(s);

    expect(asked).toEqual([{ kind: "fields", title: "Connect a GitHub account" }]);
    expect(shown).toEqual([{ kind: "wait", title: "Checking the token" }]);
    expect(result.accounts).toEqual([{ accountId: "octocat", state: { status: "connected" } }]);
  });

  it("names the account when it is renewing one", async () => {
    vi.spyOn(GithubClient.prototype, "getUser").mockResolvedValue({ login: "Octocat" });
    const { session: s, asked } = session(
      { token: "ghp_abcdefghijklmnop" },
      { accountId: "octocat@acme-org" },
    );

    const result = await authenticate(s);

    expect(asked[0]?.title).toBe("Reconnect octocat@acme-org");
    expect(result.accounts[0]?.accountId).toBe("octocat@acme-org");
  });

  it("refuses a token belonging to somebody else, and says what to do instead", async () => {
    vi.spyOn(GithubClient.prototype, "getUser").mockResolvedValue({ login: "Someone-Else" });
    const { session: s } = session({ token: "ghp_abcdefghijklmnop" }, { accountId: "octocat" });

    const failure = await authenticate(s).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(AuthFailure);
    expect((failure as AuthFailure).code).toBe("identity-mismatch");
    expect((failure as AuthFailure).remedy).toMatch(/separate source/);
  });

  it("tells a rejected token apart from an unreachable platform", async () => {
    // The pair a substring list kept confusing, and they are opposites: one
    // never clears by retrying, the other may clear on its own.
    const failureFrom = async (upstream: Error): Promise<AuthFailure> => {
      vi.spyOn(GithubClient.prototype, "getUser").mockRejectedValue(upstream);
      const caught = await authenticate(session({ token: "ghp_x" }).session).then(
        () => null,
        (e: unknown) => e,
      );
      expect(caught).toBeInstanceOf(AuthFailure);
      return caught as AuthFailure;
    };

    const denied = await failureFrom(new Error("GitHub API 401"));
    expect(denied.code).toBe("denied");
    expect(isRetryable(denied.code)).toBe(false);

    const down = await failureFrom(new Error("ETIMEDOUT"));
    expect(down.code).toBe("unavailable");
    expect(isRetryable(down.code)).toBe(true);
  });

  it("asks for the token as a secret that still declares its shape", async () => {
    // A pattern describes the form of the value, not the value, so a client
    // can say "that is not a token from this platform" without waiting for a
    // probe to say it more slowly.
    const challenge = credentialsChallenge(githubCredentialsSpec, { title: "t" });
    const wire = toWireChallenge(challenge);
    expect(wire.kind).toBe("fields");
    if (wire.kind !== "fields") return;
    expect(challenge.schema.parse({ token: "not-a-github-token" }).ok).toBe(false);
    expect(challenge.schema.parse({ token: "ghp_abcdefghijklmnop" }).ok).toBe(true);
  });
});

describe("what discovery says about an account", () => {
  const configDir = () => mkdtempSync(join(tmpdir(), "omnesis-github-discover-"));

  it("declares the login and, when there is one, the organization it is scoped to", async () => {
    // Both halves used to be recoverable only by splitting the id on a second
    // separator, which four other places had to know about. Neither is a
    // guess now: the login is who this is, and the tenant is which world the
    // token can see — something no API the token can call reports, which is
    // why the operator supplies it when they connect.
    const dir = configDir();
    await writeProviderAccountCredentials("github", "octocat", { token: "t" }, dir);
    await writeProviderAccountCredentials("github", "octocat@acme-org", { token: "t2" }, dir);

    const found = await githubProvider.discover!({ configDir: dir });
    const byId = new Map(found.map((a) => [typeof a === "string" ? a : a.id, a]));

    expect(byId.get("octocat")).toEqual({
      id: "octocat",
      subject: { kind: "handle", value: "octocat" },
    });
    expect(byId.get("octocat@acme-org")).toEqual({
      id: "octocat@acme-org",
      subject: { kind: "handle", value: "octocat" },
      tenant: { id: "acme-org" },
    });
  });

  it("does not claim an account is an email address", async () => {
    // A labelled account contains an `@` and is not an address. Saying what
    // the value actually is removes the question rather than answering it
    // with a shape test.
    const dir = configDir();
    await writeProviderAccountCredentials("github", "octocat@acme-org", { token: "t" }, dir);

    const [account] = await githubProvider.discover!({ configDir: dir });
    expect(accountEmail(account as AccountDescriptor)).toBeUndefined();
  });
});
