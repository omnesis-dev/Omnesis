// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { clearSecretFileKeyCacheForTests, writeSecretJsonFileSync } from "@omnesis/core";
import { PlaidClient } from "./client.js";
import { discoverAccounts, saveItemCredential } from "./items.js";
import {
  forgetPendingLink,
  rememberPendingLink,
  settleLinkToken,
  settlePendingLinks,
} from "./pending-links.js";

let configDir: string;
let oldSecretStore: string | undefined;

beforeEach(() => {
  oldSecretStore = process.env.OMNESIS_SECRET_STORE;
  process.env.OMNESIS_SECRET_STORE = "file";
  configDir = mkdtempSync(join(tmpdir(), "omnesis-plaid-pending-"));
});

afterEach(() => {
  clearSecretFileKeyCacheForTests();
  if (oldSecretStore === undefined) delete process.env.OMNESIS_SECRET_STORE;
  else process.env.OMNESIS_SECRET_STORE = oldSecretStore;
  // A test may have made the directory unreadable to drive a failure path.
  const dir = pendingPath();
  if (existsSync(dir)) chmodSync(dir, 0o700);
  rmSync(configDir, { recursive: true, force: true });
});

function pendingPath(): string {
  return join(configDir, "plaid", ".pending-links");
}

function records(): string[] {
  return existsSync(pendingPath()) ? readdirSync(pendingPath()) : [];
}

/** Older than the grace period, so a sweep will act on it. */
const LONG_AGO = () => Date.now() - 60 * 60 * 1000;
/** Older than the retry horizon, so a sweep will give up on it. */
const ANCIENT = () => Date.now() - 8 * 24 * 60 * 60 * 1000;
/** Past the point where Plaid still describes a session, but well inside the
 *  retry horizon — so only the visibility rule can close a record this old. */
const STALE = () => Date.now() - 9 * 60 * 60 * 1000;

type Session = Record<string, unknown>;

/** A finished session that connected a bank. */
function linked(
  publicToken: string,
  institution?: { name: string; institution_id: string },
): Session {
  return {
    link_session_id: `sess-${publicToken}`,
    finished_at: "2026-05-15T12:00:05Z",
    results: { item_add_results: [{ public_token: publicToken, institution }] },
  };
}

/** A finished session, in the deprecated shape Plaid still serves. */
function linkedLegacy(
  publicToken: string,
  institution?: { name: string; institution_id: string },
): Session {
  return {
    link_session_id: `legacy-${publicToken}`,
    finished_at: "2026-05-15T12:00:05Z",
    on_success: { public_token: publicToken, metadata: { institution } },
  };
}

/** A session the user has not finished. */
const running: Session = { link_session_id: "sess-open", finished_at: null };

type ExchangeResult =
  | { access_token: string; item_id: string }
  | { status: number; errorCode?: string };

interface FakeOpts {
  sessions?: Session[];
  linkTokenGet?: { status: number; errorCode?: string } | "network";
  exchange?: Record<string, ExchangeResult>;
  /** Default for a public token with no entry above. */
  exchangeDefault?: ExchangeResult;
  remove?: { status: number; errorCode?: string };
  calls: { path: string; body: Record<string, unknown> }[];
}

function fakeFetch(opts: FakeOpts): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    opts.calls.push({ path, body });
    const json = (value: unknown, status = 200): Response =>
      new Response(JSON.stringify(value), { status });

    if (path === "/link/token/get") {
      if (opts.linkTokenGet === "network") throw new TypeError("fetch failed");
      if (opts.linkTokenGet) {
        return json(
          { error_type: "INVALID_INPUT", error_code: opts.linkTokenGet.errorCode },
          opts.linkTokenGet.status,
        );
      }
      return json({ link_token: "link-1", link_sessions: opts.sessions ?? [] });
    }
    if (path === "/item/public_token/exchange") {
      const result = opts.exchange?.[String(body.public_token)] ??
        opts.exchangeDefault ?? { status: 400, errorCode: "INVALID_PUBLIC_TOKEN" };
      if ("status" in result) {
        return json({ error_type: "INVALID_INPUT", error_code: result.errorCode }, result.status);
      }
      return json(result);
    }
    if (path === "/item/remove") {
      const remove = opts.remove ?? { status: 200 };
      return remove.status === 200
        ? json({ request_id: "req-remove" })
        : json({ error_type: "ITEM_ERROR", error_code: remove.errorCode }, remove.status);
    }
    throw new Error(`fakeFetch: unexpected request ${path}`);
  }) as unknown as typeof fetch;
}

function client(opts: FakeOpts): PlaidClient {
  return new PlaidClient({
    clientId: "test-client",
    secret: "test-secret",
    environment: "sandbox",
    fetchImpl: fakeFetch(opts),
  });
}

const removals = (calls: FakeOpts["calls"]): unknown[] =>
  calls.filter((c) => c.path === "/item/remove").map((c) => c.body.access_token);

describe("rememberPendingLink", () => {
  test("writes one record per session and forgets it by token", async () => {
    rememberPendingLink("link-1", configDir);
    rememberPendingLink("link-2", configDir);
    expect(records()).toHaveLength(2);

    await forgetPendingLink("link-1", configDir);
    expect(records()).toHaveLength(1);
  });

  test("keeps the token out of the filename", () => {
    rememberPendingLink("link-sandbox-supersecret", configDir);
    expect(records()[0]).not.toContain("supersecret");
  });

  test("a recorded session is not mistaken for a connected item", () => {
    rememberPendingLink("link-1", configDir);
    expect(discoverAccounts(configDir)).toEqual([]);
  });

  test("a host that cannot write a record still lets the add proceed", () => {
    // A file where the directory must go: the record cannot be written, and
    // recording must not be what fails the add.
    writeFileSync(join(configDir, "plaid"), "not a directory");
    expect(() => rememberPendingLink("link-1", configDir)).not.toThrow();
  });
});

describe("settlePendingLinks — what it refuses to touch", () => {
  test("makes no call when no session is outstanding", async () => {
    const calls: FakeOpts["calls"] = [];
    expect(await settlePendingLinks(client({ calls }), configDir)).toEqual({
      disconnected: [],
      unreachable: [],
      unaccounted: 0,
      kept: 0,
    });
    expect(calls).toEqual([]);
  });

  test("leaves a record the add that wrote it could still be running", async () => {
    // The add waits thirteen minutes in another process. Until it cannot be
    // running, a sweep must not exchange the token out from under it.
    rememberPendingLink("link-1", configDir);
    const calls: FakeOpts["calls"] = [];
    const outcome = await settlePendingLinks(client({ calls }), configDir);
    expect(calls).toEqual([]);
    expect(outcome.kept).toBe(1);
    expect(records()).toHaveLength(1);
  });

  test("keeps the record while the user is still signing in", async () => {
    // The session has not finished, so nothing is connected yet — and this
    // record is the only handle to the bank they are about to connect.
    rememberPendingLink("link-1", configDir, LONG_AGO);
    const calls: FakeOpts["calls"] = [];
    const outcome = await settlePendingLinks(client({ calls, sessions: [running] }), configDir);
    expect(removals(calls)).toEqual([]);
    expect(outcome.kept).toBe(1);
    expect(records()).toHaveLength(1);
  });

  test("keeps the record when the user has not opened the link at all", async () => {
    rememberPendingLink("link-1", configDir, LONG_AGO);
    const calls: FakeOpts["calls"] = [];
    const outcome = await settlePendingLinks(client({ calls, sessions: [] }), configDir);
    expect(outcome.kept).toBe(1);
    expect(records()).toHaveLength(1);
  });

  test("forgets a finished session that connected nothing", async () => {
    rememberPendingLink("link-1", configDir, LONG_AGO);
    const calls: FakeOpts["calls"] = [];
    await settlePendingLinks(
      client({ calls, sessions: [{ link_session_id: "s", finished_at: "2026-05-15T12:00:05Z" }] }),
      configDir,
    );
    expect(records()).toEqual([]);
  });
});

describe("settlePendingLinks — disconnecting what nobody claimed", () => {
  test("disconnects a bank that was connected at Plaid but never stored here", async () => {
    rememberPendingLink("link-1", configDir, LONG_AGO);
    const calls: FakeOpts["calls"] = [];
    const outcome = await settlePendingLinks(
      client({
        calls,
        sessions: [linked("public-a", { name: "Northstar Bank", institution_id: "ins_a" })],
        exchange: { "public-a": { access_token: "access-a", item_id: "item-a" } },
      }),
      configDir,
    );

    expect(removals(calls)).toEqual(["access-a"]);
    expect(outcome.disconnected).toEqual(["item-a"]);
    expect(records()).toEqual([]);
  });

  test("leaves a bank this host did store alone", async () => {
    saveItemCredential({ access_token: "access-a", item_id: "item-a" }, configDir);
    rememberPendingLink("link-1", configDir, LONG_AGO);
    const calls: FakeOpts["calls"] = [];
    const outcome = await settlePendingLinks(
      client({
        calls,
        sessions: [linked("public-a")],
        exchange: { "public-a": { access_token: "access-a", item_id: "item-a" } },
      }),
      configDir,
    );

    expect(removals(calls)).toEqual([]);
    expect(outcome.disconnected).toEqual([]);
    expect(discoverAccounts(configDir).map(String)).toEqual(["item-a"]);
    expect(records()).toEqual([]);
  });

  test("an item whose credential cannot be read is still a connected bank", async () => {
    // `loadItemCredential` answers null for an unreadable file exactly as it
    // does for an absent one. Disconnecting a live bank because its credential
    // failed to decode would be the worst possible reading of that.
    mkdirSync(join(configDir, "plaid", "item-a"), { recursive: true });
    writeFileSync(join(configDir, "plaid", "item-a", "item.json"), "}not json{");
    rememberPendingLink("link-1", configDir, LONG_AGO);
    const calls: FakeOpts["calls"] = [];
    const outcome = await settlePendingLinks(
      client({
        calls,
        sessions: [linked("public-a")],
        exchange: { "public-a": { access_token: "access-a", item_id: "item-a" } },
      }),
      configDir,
    );

    expect(removals(calls)).toEqual([]);
    expect(outcome.disconnected).toEqual([]);
  });

  test("disconnects every extra bank one session token connected", async () => {
    saveItemCredential({ access_token: "access-a", item_id: "item-a" }, configDir);
    rememberPendingLink("link-1", configDir, LONG_AGO);
    const calls: FakeOpts["calls"] = [];
    const outcome = await settlePendingLinks(
      client({
        calls,
        sessions: [linked("public-a"), linked("public-b")],
        exchange: {
          "public-a": { access_token: "access-a", item_id: "item-a" },
          "public-b": { access_token: "access-b", item_id: "item-b" },
        },
      }),
      configDir,
    );

    expect(removals(calls)).toEqual(["access-b"]);
    expect(outcome.disconnected).toEqual(["item-b"]);
  });

  test("reads two banks added inside one session", async () => {
    rememberPendingLink("link-1", configDir, LONG_AGO);
    const calls: FakeOpts["calls"] = [];
    await settlePendingLinks(
      client({
        calls,
        sessions: [
          {
            link_session_id: "one",
            finished_at: "2026-05-15T12:00:05Z",
            results: {
              item_add_results: [{ public_token: "public-a" }, { public_token: "public-b" }],
            },
          },
        ],
        exchange: {
          "public-a": { access_token: "access-a", item_id: "item-a" },
          "public-b": { access_token: "access-b", item_id: "item-b" },
        },
      }),
      configDir,
    );

    expect(removals(calls)).toEqual(["access-a", "access-b"]);
  });

  test("reads a session Plaid reports in its deprecated shape", async () => {
    rememberPendingLink("link-1", configDir, LONG_AGO);
    const calls: FakeOpts["calls"] = [];
    const outcome = await settlePendingLinks(
      client({
        calls,
        sessions: [linkedLegacy("public-a", { name: "Northstar Bank", institution_id: "ins_a" })],
        exchange: { "public-a": { access_token: "access-a", item_id: "item-a" } },
      }),
      configDir,
    );

    expect(outcome.disconnected).toEqual(["item-a"]);
  });

  test("disconnects a bank once even when Plaid reports it twice", async () => {
    rememberPendingLink("link-1", configDir, LONG_AGO);
    const calls: FakeOpts["calls"] = [];
    await settlePendingLinks(
      client({
        calls,
        // The same connection through both the current and the legacy shape.
        sessions: [linked("public-a"), linkedLegacy("public-a")],
        exchange: { "public-a": { access_token: "access-a", item_id: "item-a" } },
      }),
      configDir,
    );

    expect(removals(calls)).toEqual(["access-a"]);
  });
});

describe("settlePendingLinks — when the answer is not final", () => {
  test("keeps the record when Plaid cannot be reached, and settles on a later sweep", async () => {
    rememberPendingLink("link-1", configDir, LONG_AGO);
    const calls: FakeOpts["calls"] = [];
    expect(
      (await settlePendingLinks(client({ calls, linkTokenGet: "network" }), configDir)).kept,
    ).toBe(1);
    expect(records()).toHaveLength(1);

    const outcome = await settlePendingLinks(
      client({
        calls,
        sessions: [linked("public-a")],
        exchange: { "public-a": { access_token: "access-a", item_id: "item-a" } },
      }),
      configDir,
    );
    expect(outcome.disconnected).toEqual(["item-a"]);
    expect(records()).toEqual([]);
  });

  test("keeps the record when the exchange fails for a reason that may pass", async () => {
    rememberPendingLink("link-1", configDir, LONG_AGO);
    const calls: FakeOpts["calls"] = [];
    const outcome = await settlePendingLinks(
      client({
        calls,
        sessions: [linked("public-a")],
        exchangeDefault: { status: 500, errorCode: "INTERNAL_SERVER_ERROR" },
      }),
      configDir,
    );
    expect(outcome).toMatchObject({ disconnected: [], unreachable: [], kept: 1 });
    expect(records()).toHaveLength(1);
  });

  test("keeps the record when the app credential is what Plaid is refusing", async () => {
    // Nothing about this session is spent — the operator rotated the secret.
    // Giving up here would throw the handle away before it could be used.
    rememberPendingLink("link-1", configDir, LONG_AGO);
    const calls: FakeOpts["calls"] = [];
    const outcome = await settlePendingLinks(
      client({
        calls,
        sessions: [linked("public-a")],
        exchangeDefault: { status: 400, errorCode: "INVALID_API_KEYS" },
      }),
      configDir,
    );
    expect(outcome).toMatchObject({ unreachable: [], kept: 1 });
    expect(records()).toHaveLength(1);
  });

  test("keeps the record when the disconnect itself fails, and still tries the next bank", async () => {
    rememberPendingLink("link-1", configDir, LONG_AGO);
    const calls: FakeOpts["calls"] = [];
    const outcome = await settlePendingLinks(
      client({
        calls,
        sessions: [linked("public-a"), linked("public-b")],
        exchange: {
          "public-a": { access_token: "access-a", item_id: "item-a" },
          "public-b": { access_token: "access-b", item_id: "item-b" },
        },
        remove: { status: 400, errorCode: "INVALID_FIELD" },
      }),
      configDir,
    );
    expect(removals(calls)).toEqual(["access-a", "access-b"]);
    expect(outcome.kept).toBe(1);
    expect(records()).toHaveLength(1);
  });

  test("reports a bank it can no longer reach, and stops retrying it", async () => {
    rememberPendingLink("link-1", configDir, LONG_AGO);
    const calls: FakeOpts["calls"] = [];
    const outcome = await settlePendingLinks(
      client({
        calls,
        sessions: [linked("public-a", { name: "Northstar Bank", institution_id: "ins_a" })],
        // The public token outlived its half-hour: recognisable, not usable.
        exchangeDefault: { status: 400, errorCode: "INVALID_PUBLIC_TOKEN" },
      }),
      configDir,
    );

    expect(outcome).toMatchObject({ disconnected: [], unreachable: ["Northstar Bank"], kept: 0 });
    expect(removals(calls)).toEqual([]);
    expect(records()).toEqual([]);
  });

  test("closes a record once Plaid no longer describes its session", async () => {
    // Plaid serves a finished session's details for six hours. Past that there
    // is nothing left to learn, and waiting out the week-long retry horizon
    // would only delay saying so.
    rememberPendingLink("link-1", configDir, STALE);
    const calls: FakeOpts["calls"] = [];
    const outcome = await settlePendingLinks(client({ calls, sessions: [] }), configDir);
    // Plaid never reported a session, so nothing was connected: closed quietly.
    expect(outcome).toMatchObject({ kept: 0, unaccounted: 0 });
    expect(records()).toEqual([]);
  });

  test("still waits out a session that is merely stale but visible and unfinished", async () => {
    // The visibility rule closes a record only when every bank Plaid named is
    // settled. A session still running is not settled, so it keeps waiting.
    rememberPendingLink("link-1", configDir, STALE);
    const calls: FakeOpts["calls"] = [];
    const outcome = await settlePendingLinks(
      client({
        calls,
        sessions: [linked("public-a"), running],
        // The named bank will not disconnect, so the record is not settled.
        exchange: { "public-a": { access_token: "access-a", item_id: "item-a" } },
        remove: { status: 400, errorCode: "INVALID_FIELD" },
      }),
      configDir,
    );
    expect(outcome.kept).toBe(1);
    expect(records()).toHaveLength(1);
  });

  test("reports a stale session that finished without saying what it did", async () => {
    // The ambiguous one: it may have connected a bank whose details have since
    // aged out, and only the Plaid dashboard can now tell.
    rememberPendingLink("link-1", configDir, STALE);
    const calls: FakeOpts["calls"] = [];
    const outcome = await settlePendingLinks(
      client({
        calls,
        sessions: [{ link_session_id: "s", finished_at: "2026-05-15T12:00:05Z" }],
      }),
      configDir,
    );
    expect(outcome).toMatchObject({ unaccounted: 1, kept: 0 });
    expect(records()).toEqual([]);
  });

  test("closes a stale session quietly when the user abandoned it", async () => {
    rememberPendingLink("link-1", configDir, STALE);
    const calls: FakeOpts["calls"] = [];
    const outcome = await settlePendingLinks(
      client({
        calls,
        sessions: [
          {
            link_session_id: "s",
            finished_at: "2026-05-15T12:00:05Z",
            exit: { error: { error_code: "USER_EXIT" } },
          },
        ],
      }),
      configDir,
    );
    expect(outcome).toMatchObject({ unaccounted: 0, kept: 0 });
    expect(records()).toEqual([]);
  });

  test("a finished session with no bank is closed without remark while still described", async () => {
    rememberPendingLink("link-1", configDir, LONG_AGO);
    const outcome = await settlePendingLinks(
      client({
        calls: [],
        sessions: [{ link_session_id: "s", finished_at: "2026-05-15T12:00:05Z" }],
      }),
      configDir,
    );
    expect(outcome).toMatchObject({ unaccounted: 0, kept: 0 });
    expect(records()).toEqual([]);
  });

  test("gives up on a record Plaid has refused for longer than the retry horizon", async () => {
    rememberPendingLink("link-1", configDir, ANCIENT);
    const calls: FakeOpts["calls"] = [];
    await settlePendingLinks(
      client({ calls, linkTokenGet: { status: 400, errorCode: "INVALID_FIELD" } }),
      configDir,
    );
    expect(records()).toEqual([]);
  });

  test("gives up on a record that has stayed unsettleable for longer than the horizon", async () => {
    rememberPendingLink("link-1", configDir, ANCIENT);
    const calls: FakeOpts["calls"] = [];
    await settlePendingLinks(
      client({
        calls,
        sessions: [linked("public-a")],
        exchangeDefault: { status: 500, errorCode: "INTERNAL_SERVER_ERROR" },
      }),
      configDir,
    );
    expect(records()).toEqual([]);
  });
});

describe("settlePendingLinks — records it cannot read", () => {
  test("deletes a record whose content is not a record", async () => {
    writeSecretJsonFileSync(join(pendingPath(), "junk.json"), { nonsense: true }, { configDir });
    const calls: FakeOpts["calls"] = [];
    await settlePendingLinks(client({ calls }), configDir);
    expect(records()).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("keeps a record that merely failed to decode, until it is stale", async () => {
    mkdirSync(pendingPath(), { recursive: true });
    const path = join(pendingPath(), "opaque.json");
    writeFileSync(path, "not decodable");
    await settlePendingLinks(client({ calls: [] }), configDir);
    expect(records()).toEqual(["opaque.json"]);

    // Once it is older than the retry horizon there is nothing left to wait for.
    const old = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(path, old, old);
    await settlePendingLinks(client({ calls: [] }), configDir);
    expect(records()).toEqual([]);
  });

  test("settles the records it can read even when one of them is unreadable", async () => {
    rememberPendingLink("link-good", configDir, LONG_AGO);
    writeSecretJsonFileSync(join(pendingPath(), "junk.json"), { nonsense: true }, { configDir });
    const calls: FakeOpts["calls"] = [];
    const outcome = await settlePendingLinks(
      client({
        calls,
        sessions: [linked("public-a")],
        exchange: { "public-a": { access_token: "access-a", item_id: "item-a" } },
      }),
      configDir,
    );
    expect(outcome.disconnected).toEqual(["item-a"]);
    expect(records()).toEqual([]);
  });

  test("never throws when the record directory cannot be listed", async () => {
    // The contract every call site depends on: building a source context must
    // not fail because a past session could not be settled.
    mkdirSync(pendingPath(), { recursive: true });
    chmodSync(pendingPath(), 0o000);
    const outcome = await settlePendingLinks(client({ calls: [] }), configDir);
    expect(outcome).toEqual({ disconnected: [], unreachable: [], unaccounted: 0, kept: 0 });
  });
});

describe("settleLinkToken — the add settling its own session", () => {
  test("keeps the item the add stored and disconnects the rest, with no grace period", async () => {
    rememberPendingLink("link-1", configDir);
    const calls: FakeOpts["calls"] = [];
    const outcome = await settleLinkToken(
      client({
        calls,
        sessions: [linked("public-a"), linked("public-b")],
        exchange: {
          "public-a": { access_token: "access-a", item_id: "item-a" },
          "public-b": { access_token: "access-b", item_id: "item-b" },
        },
      }),
      "link-1",
      configDir,
      "item-a",
    );

    expect(removals(calls)).toEqual(["access-b"]);
    expect(outcome.disconnected).toEqual(["item-b"]);
    expect(records()).toEqual([]);
  });

  test("forgets the record even when Plaid cannot be asked", async () => {
    // The add knows its own outcome. Leaving the record behind would make the
    // next sweep re-derive it and report a bank that is connected here.
    rememberPendingLink("link-1", configDir);
    await settleLinkToken(
      client({ calls: [], linkTokenGet: "network" }),
      "link-1",
      configDir,
      "item-a",
    );
    expect(records()).toEqual([]);
  });
});
