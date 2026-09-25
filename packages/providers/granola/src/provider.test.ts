// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, afterEach, vi } from "vitest";
import {
  isCredentialPersistError,
  isMissingCredentialsError,
  loadOrAdoptProviderAccountCredentials,
  writeProviderAccountCredentials,
  writeProviderCredentials,
} from "@omnesis/core";
import { SyncError } from "@omnesis/types";
import { AuthFailure, isRetryable, type AuthSession } from "@omnesis/source-sdk";
import { fakeProviderHost } from "@omnesis/source-sdk/testing";
import { GranolaClient } from "./client.js";
import { granolaCredentialsSpec } from "./credentials-spec.js";
import {
  authenticate,
  discoverAccounts,
  hasCredentials,
  isKeyFingerprintAccount,
} from "./provider.js";
import granolaProvider from "./index.js";
import type { GranolaContext } from "./types.js";

/**
 * The collector's provider-instantiation path derives accounts SOLELY from
 * `discover()` and silently skips a provider that returns an empty list, so
 * `discover()` must resolve every configured account offline.
 */
describe("discoverAccounts", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const d of created) rmSync(d, { recursive: true, force: true });
    created.length = 0;
  });

  function tempConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "granola-cfg-"));
    created.push(dir);
    return dir;
  }

  test("returns every account with a stored credential", async () => {
    const cfg = tempConfigDir();
    await writeProviderAccountCredentials(
      "granola",
      "maya.reeves@example.com",
      { api_key: "k1" },
      cfg,
    );
    await writeProviderAccountCredentials(
      "granola",
      "jamie.lopez@example.org",
      { api_key: "k2" },
      cfg,
    );
    expect(discoverAccounts(cfg).map(String).sort()).toEqual([
      "jamie.lopez@example.org",
      "maya.reeves@example.com",
    ]);
  });

  test("discover declares what each account is: an owner's email, or an opaque key fingerprint", async () => {
    // The id is the owner's email when Granola reported one, and a fingerprint
    // of the key when it did not. Calling the fingerprint an email would hand
    // the self-identity resolver something that is not an address.
    const cfg = tempConfigDir();
    await writeProviderAccountCredentials(
      "granola",
      "maya.reeves@example.com",
      { api_key: "k1" },
      cfg,
    );
    await writeProviderAccountCredentials(
      "granola",
      "granola-0a1b2c3d4e5f",
      { api_key: "k2" },
      cfg,
    );

    const accounts = await granolaProvider.discover!({ configDir: cfg });

    expect(
      [...accounts].sort((a, b) =>
        (typeof a === "string" ? a : a.id).localeCompare(typeof b === "string" ? b : b.id),
      ),
    ).toEqual([
      { id: "granola-0a1b2c3d4e5f", subject: { kind: "opaque", value: "granola-0a1b2c3d4e5f" } },
      {
        id: "maya.reeves@example.com",
        subject: { kind: "email", value: "maya.reeves@example.com" },
      },
    ]);
  });

  test("an address that merely starts like a fingerprint is still an email", () => {
    expect(isKeyFingerprintAccount("granola-0a1b2c3d4e5f")).toBe(true);
    expect(isKeyFingerprintAccount("granola-team@example.com")).toBe(false);
    expect(isKeyFingerprintAccount("granola-0a1b2c3d4e5fff")).toBe(false);
  });

  test("returns the marker dirs of an install that predates per-account storage", async () => {
    // Such an install has an EMPTY account dir plus the shared credentials
    // file. Returning nothing here would be terminal rather than cosmetic: the
    // provider would never instantiate, so its credential would never be
    // adopted, so the predicate would stay false forever and the source would
    // vanish with no route back.
    const cfg = tempConfigDir();
    mkdirSync(join(cfg, "granola", "maya.reeves@example.com"), { recursive: true });
    await writeProviderCredentials("granola", { api_key: "legacy" }, cfg);
    expect(discoverAccounts(cfg).map(String)).toEqual(["maya.reeves@example.com"]);
  });

  test("ignores an orphan account dir with no credential anywhere", async () => {
    const cfg = tempConfigDir();
    mkdirSync(join(cfg, "granola", "maya.reeves@example.com"), { recursive: true });
    expect(discoverAccounts(cfg)).toEqual([]);
  });

  test("returns empty when the granola dir is absent", () => {
    expect(discoverAccounts(tempConfigDir())).toEqual([]);
  });
});

describe("hasCredentials", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const d of created) rmSync(d, { recursive: true, force: true });
    created.length = 0;
  });

  function tempConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "granola-has-"));
    created.push(dir);
    return dir;
  }

  test("sees an account's own stored credential", async () => {
    const cfg = tempConfigDir();
    await writeProviderAccountCredentials(
      "granola",
      "maya.reeves@example.com",
      { api_key: "k" },
      cfg,
    );
    expect(hasCredentials("maya.reeves@example.com", cfg)).toBe(true);
  });

  test("sees a not-yet-adopted shared credential", async () => {
    const cfg = tempConfigDir();
    await writeProviderCredentials("granola", { api_key: "legacy" }, cfg);
    expect(hasCredentials("maya.reeves@example.com", cfg)).toBe(true);
  });

  test("is false when nothing is stored", () => {
    expect(hasCredentials("maya.reeves@example.com", tempConfigDir())).toBe(false);
  });
});

/**
 * The provider-level auth probe gates every sync cycle: returning false parks
 * the source in needs-auth and prompts a re-auth. It answers offline from
 * stored credentials, so a lapsed subscription, a rate limit or a network blip
 * — none of which invalidate the key — can never produce a re-auth prompt that
 * the user has no way to satisfy. The real error surfaces on the next sync.
 */
describe("isAuthenticated", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const d of created) rmSync(d, { recursive: true, force: true });
    created.length = 0;
  });

  function tempConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "granola-auth-"));
    created.push(dir);
    return dir;
  }

  function contextFor(accountId: string, configDir: string): GranolaContext {
    return {
      accountId,
      configDir,
      client: {
        probe: async () => {
          throw new Error("isAuthenticated must not hit the network");
        },
      },
    } as unknown as GranolaContext;
  }

  test("reports authenticated from stored credentials, without probing", async () => {
    const cfg = tempConfigDir();
    await writeProviderAccountCredentials(
      "granola",
      "maya.reeves@example.com",
      { api_key: "k" },
      cfg,
    );
    await expect(
      granolaProvider.credentialState?.(contextFor("maya.reeves@example.com", cfg)),
    ).resolves.toEqual({ status: "connected" });
  });

  test("reports unauthenticated when the account has no credential", async () => {
    await expect(
      granolaProvider.credentialState?.(contextFor("maya.reeves@example.com", tempConfigDir())),
    ).resolves.toEqual({ status: "never-connected" });
  });
});

describe("connecting through the typed session", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const d of created) rmSync(d, { recursive: true, force: true });
    created.length = 0;
    vi.restoreAllMocks();
  });

  function tempConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "granola-session-"));
    created.push(dir);
    return dir;
  }

  /** A session that answers the one question this flow asks. */
  function session(
    answer: Record<string, string>,
    overrides: Partial<AuthSession> & { configDir?: string } = {},
  ) {
    const { configDir = tempConfigDir(), ...rest } = overrides;
    const shown: Array<{ kind: string; title: string }> = [];
    const asked: Array<{ kind: string; title: string; prefill?: Record<string, string> }> = [];
    const s: AuthSession = {
      reason: rest.accountId ? "reauthenticate" : "connect",
      flowId: "flow-1",
      supplied: {},
      host: { ...fakeProviderHost(), configDir },
      canShow: () => true,
      show: (c) => void shown.push({ kind: c.kind, title: c.title }),
      ask: (c) => {
        asked.push({ kind: c.kind, title: c.title });
        return Promise.resolve(answer as never);
      },
      ...rest,
    };
    return { session: s, shown, asked, configDir };
  }

  function withProbe(owner: { ownerName?: string; ownerEmail?: string }) {
    vi.spyOn(GranolaClient.prototype, "probe").mockResolvedValue(owner);
  }

  async function failureFrom(
    upstream: unknown,
    overrides: Partial<AuthSession> & { configDir?: string } = {},
  ): Promise<AuthFailure> {
    vi.spyOn(GranolaClient.prototype, "probe").mockRejectedValue(upstream);
    const caught = await authenticate(session({ api_key: "grn_key" }, overrides).session).then(
      () => null,
      (e: unknown) => e,
    );
    expect(caught).toBeInstanceOf(AuthFailure);
    return caught as AuthFailure;
  }

  test("the descriptor connects through the session", () => {
    expect(typeof granolaProvider.authenticate).toBe("function");
  });

  test("asks for the key, says it is checking it, and stores it under the owner", async () => {
    withProbe({ ownerEmail: "maya.reeves@example.com" });
    const { session: s, asked, shown, configDir } = session({ api_key: "grn_fresh" });

    const result = await authenticate(s);

    expect(asked).toEqual([{ kind: "fields", title: "Connect a Granola account" }]);
    expect(shown).toEqual([{ kind: "wait", title: "Checking the API key" }]);
    expect(result.accounts).toEqual([
      { accountId: "maya.reeves@example.com", state: { status: "connected" } },
    ]);
    await expect(
      loadOrAdoptProviderAccountCredentials("granola", "maya.reeves@example.com", configDir),
    ).resolves.toEqual({ api_key: "grn_fresh" });
  });

  test("a re-auth replaces a revoked key with the one the operator pastes", async () => {
    // The whole point of asking: the stored key is the thing that stopped
    // working, so a flow that could only re-present it had nothing to offer.
    const configDir = tempConfigDir();
    await writeProviderAccountCredentials(
      "granola",
      "maya.reeves@example.com",
      { api_key: "grn_revoked" },
      configDir,
    );
    withProbe({ ownerEmail: "maya.reeves@example.com" });
    const { session: s, asked } = session(
      { api_key: "grn_replacement" },
      { accountId: "maya.reeves@example.com", configDir },
    );

    const result = await authenticate(s);

    expect(asked[0]?.title).toBe("Reconnect maya.reeves@example.com");
    expect(result.accounts[0]?.accountId).toBe("maya.reeves@example.com");
    await expect(
      loadOrAdoptProviderAccountCredentials("granola", "maya.reeves@example.com", configDir),
    ).resolves.toEqual({ api_key: "grn_replacement" });
  });

  test("takes a key a client already collected rather than asking twice", async () => {
    withProbe({ ownerEmail: "jamie.lopez@example.org" });
    const { session: s, asked } = session(
      { api_key: "grn_never_asked" },
      { supplied: { api_key: "grn_from_wizard" } },
    );

    const result = await authenticate(s);

    expect(asked).toEqual([]);
    expect(result.accounts[0]?.accountId).toBe("jamie.lopez@example.org");
  });

  test("refuses a key belonging to somebody else, and says what to do instead", async () => {
    withProbe({ ownerEmail: "david.lin@example.com" });
    const { session: s } = session(
      { api_key: "grn_other" },
      { accountId: "maya.reeves@example.com" },
    );

    const failure = await authenticate(s).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(AuthFailure);
    expect((failure as AuthFailure).code).toBe("identity-mismatch");
    expect((failure as AuthFailure).remedy).toMatch(/separate source/);
  });

  test("lets a workspace with no notes rotate its key", async () => {
    // With no note to name an owner the id is a function of the key itself, so
    // a rotated key never matches the account being renewed. Enforcing the
    // guard there would make rotation impossible rather than catch a mistake.
    const configDir = tempConfigDir();
    withProbe({});
    const { session: s } = session(
      { api_key: "grn_rotated" },
      { accountId: "granola-abc123def456", configDir },
    );

    const result = await authenticate(s);

    expect(result.accounts[0]?.accountId).toBe("granola-abc123def456");
    await expect(
      loadOrAdoptProviderAccountCredentials("granola", "granola-abc123def456", configDir),
    ).resolves.toEqual({ api_key: "grn_rotated" });
  });

  test("a rejected key and a plan without the API are both the operator's to fix", async () => {
    // Neither is `denied` — nobody was asked anything — and neither is
    // `missing-credentials`, which is having nothing to present. They differ
    // only in the remedy.
    const rejected = await failureFrom(
      new SyncError("auth", "Granola rejected the API key (HTTP 401)."),
    );
    expect(rejected.code).toBe("credential-rejected");
    expect(rejected.remedy).toMatch(/new key/i);
    expect(isRetryable(rejected.code)).toBe(true);

    const noPlan = await failureFrom(
      new SyncError("permission", "Granola refused the request (HTTP 403)."),
    );
    expect(noPlan.code).toBe("credential-rejected");
    expect(noPlan.remedy).toMatch(/plan/i);
  });

  test("tells an unreachable platform apart from an answer it cannot read", async () => {
    for (const kind of ["network", "transient", "rate-limit"] as const) {
      const down = await failureFrom(new SyncError(kind, `Granola ${kind}`));
      expect(down.code).toBe("unavailable");
      expect(isRetryable(down.code)).toBe(true);
    }

    const strange = await failureFrom(new SyncError("unknown", "Granola resource not found."));
    expect(strange.code).toBe("unknown");
  });

  test("an empty answer is missing credentials, not a rejected one", async () => {
    const probe = vi.spyOn(GranolaClient.prototype, "probe");
    const err = await authenticate(session({ api_key: "  " }).session).catch((e: unknown) => e);
    expect(isMissingCredentialsError(err)).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  test("an authenticated key that cannot be stored is reported as such", async () => {
    // The key may be unrecoverable — Granola shows it once — so a client has
    // to know to keep what was typed and offer a retry.
    withProbe({ ownerEmail: "maya.reeves@example.com" });
    const notADir = join(mkdtempSync(join(tmpdir(), "granola-persist-")), "occupied");
    created.push(notADir);
    writeFileSync(notADir, "");
    const { session: s } = session({ api_key: "grn_fresh" }, { configDir: notADir });

    const err = await authenticate(s).catch((e: unknown) => e);

    expect(isCredentialPersistError(err)).toBe(true);
  });

  test("declares the shape of a key so a client can reject one that is not", async () => {
    const field = granolaCredentialsSpec.fields.find((f) => f.name === "api_key");
    expect(field?.pattern).toBeDefined();
    expect(new RegExp(field!.pattern!).test("grn_abcdef123456")).toBe(true);
    expect(new RegExp(field!.pattern!).test("not-a-granola-key")).toBe(false);
    expect(field?.patternHint).toMatch(/grn_/);
  });
});
