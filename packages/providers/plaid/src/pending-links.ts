// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Link sessions this host started but never accounted for, and how they are
 * settled afterwards.
 *
 * A Plaid item is created the moment the user finishes signing in on Plaid's
 * hosted page — before Omnesis learns anything about it. Between that instant
 * and the item's credential reaching disk the connection exists only at Plaid:
 * it bills, it holds a live bank consent, and Plaid publishes no listing of an
 * app's items, so an item nothing here stored is unreachable forever.
 *
 * The one durable handle to such a session is the **Link token**. Both halves
 * of settling one outlive the sign-in it belongs to: `/link/token/get` keeps
 * answering for the token long after it stops being usable for signing in, and
 * `/item/public_token/exchange` resolves a session's `public_token` to the same
 * item even after the add that connected it exchanged it already. So the token
 * is written down before its URL is handed to the user, and a record still on
 * disk afterwards is a session whose outcome was never accounted for.
 *
 * Three rules keep settling from doing harm, and they are most of why this is
 * more than a loop over a directory:
 *
 * - **Only a finished session is settled**, and a record is kept while any of
 *   its sessions is still running. A user part-way through typing a password
 *   has connected nothing yet, and dropping their record would throw away the
 *   only handle to the bank they are about to connect.
 * - **Only a record older than any add that could still be running is swept.**
 *   The add runs in the auth subprocess and a sweep runs in the collector, with
 *   no lock between them; without this, a sweep could exchange and disconnect
 *   the bank an add was at that moment storing.
 * - **A bank belongs to this host if its item file is on disk** — a question
 *   about the file existing, never about its contents parsing. An item whose
 *   credential cannot be decoded is still a connected bank, and "I could not
 *   read it" must not authorise disconnecting it at Plaid.
 *
 * Two windows stay open and cannot be closed from this side, because Plaid
 * offers nothing to close them with:
 *
 * - A `public_token` lives about thirty minutes from the end of the sign-in.
 *   A session settled after that can be recognised but not disconnected, so it
 *   is reported instead — by name, so the operator can remove it from the Plaid
 *   dashboard.
 * - A process that dies between exchanging the token and storing the result
 *   holds the only access token there was. Nothing recovers that.
 *
 * Sweeping runs where a client already exists and costs one directory read
 * when there is nothing to do: at the top of each add, which is what the
 * operator does after one fails, and when a source's context is built, which is
 * what a collector restart does. An add that succeeds settles its own token
 * directly rather than waiting out the grace period — it is the one caller that
 * knows both that the session is over and which item it claimed.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  createLogger,
  isSecretFileRootKeyUnavailableError,
  readSecretJsonFileSync,
  toErrorMessage,
  writeSecretJsonFileSync,
} from "@omnesis/core";
import { SyncError } from "@omnesis/types";
import { z } from "zod";
import { findStoredItem, isRetryable, plaidDir, revokeItem } from "./items.js";
import type { PlaidClient } from "./client.js";
import type { PlaidLinkSession, PlaidLinkTokenGetResponse } from "./schemas.js";

const log = createLogger("provider:plaid");

/**
 * Where the records live. A dot-prefixed sibling of the per-item directories,
 * which hold an `item.json` and are therefore never confused for one another:
 * `discoverAccounts()` only counts a directory that has that file.
 */
const PENDING_DIR = ".pending-links";

/**
 * How long after a record is written a sweep leaves it alone.
 *
 * An add waits `LINK_SESSION_TIMEOUT_MS` — thirteen minutes — for the user, and
 * runs in the auth subprocess while a sweep runs in the collector. Waiting past
 * the point where any add could still be behind a record is what stops the two
 * colliding: otherwise a sweep could exchange the `public_token` an add was at
 * that moment turning into a stored connection, and disconnect the bank the
 * user had just added.
 */
const SETTLE_GRACE_MS = 15 * 60 * 1000;

/**
 * How long a record is worth retrying when Plaid keeps refusing to answer for
 * it, or when a bank it named will not disconnect. Those are failures that can
 * pass, so the horizon is far longer than any transient outage and far shorter
 * than the life of an install.
 */
const RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a session stays visible at all.
 *
 * Plaid serves a finished session's details — its banks included — from
 * `/link/token/get` for six hours after it completes, and the hosted URL that
 * starts one lives half an hour. Past the sum of those, a token Plaid answers
 * for while reporting no finished session is telling us everything it ever
 * will: waiting the full retry horizon would only delay saying so by a week.
 */
const SESSION_VISIBLE_MS = 7 * 60 * 60 * 1000;

const recordSchema = z.object({
  link_token: z.string().min(1),
  created_at: z.string().datetime(),
});

type PendingLinkRecord = z.infer<typeof recordSchema>;

/**
 * What a settle did, so a caller — in practice a test — can tell the arms apart
 * without reading the log. Nothing in the product acts on it: the operator-
 * facing account of an unreachable bank is the warning, not this.
 */
export interface SettleOutcome {
  /** Items disconnected at Plaid because nothing on this host claimed them. */
  disconnected: string[];
  /** Banks that were connected but can no longer be reached from this host. */
  unreachable: string[];
  /** Sessions closed without Plaid ever saying what, if anything, they did. */
  unaccounted: number;
  /** Records left on disk for a later sweep. */
  kept: number;
}

function emptyOutcome(): SettleOutcome {
  return { disconnected: [], unreachable: [], unaccounted: 0, kept: 0 };
}

function pendingDir(configDir?: string): string {
  return join(plaidDir(configDir), PENDING_DIR);
}

/**
 * The record's filename. A digest rather than the token itself: the token is
 * a credential, and a directory listing is not a place to leave one.
 */
function recordPath(linkToken: string, configDir?: string): string {
  const name = createHash("sha256").update(linkToken).digest("hex").slice(0, 32);
  return join(pendingDir(configDir), `${name}.json`);
}

/**
 * Write down a Link token before its URL reaches the user, so a session that
 * completes without this host hearing about it can still be settled.
 *
 * Recording is best effort: a host that cannot write here can still connect a
 * bank, and failing the add over it would trade a rare unreachable item for a
 * certain one.
 */
export function rememberPendingLink(linkToken: string, configDir?: string, now = Date.now): void {
  try {
    mkdirSync(pendingDir(configDir), { recursive: true, mode: 0o700 });
    writeSecretJsonFileSync(
      recordPath(linkToken, configDir),
      { link_token: linkToken, created_at: new Date(now()).toISOString() },
      { configDir },
    );
  } catch (err) {
    log.warn(
      `Could not record the pending Plaid Link session (${toErrorMessage(err)}); ` +
        `a sign-in that finishes after this add gives up will not be settled automatically`,
    );
  }
}

/** Drop a session's record because its outcome is now accounted for. */
export async function forgetPendingLink(linkToken: string, configDir?: string): Promise<void> {
  await rm(recordPath(linkToken, configDir), { force: true });
}

/**
 * Settle the token of a session this host saw finish, disconnecting any bank it
 * connected other than `keepItemId`.
 *
 * The add's own path. It needs no grace period — the add is the thing a sweep
 * waits for — and no guess about which item is claimed, because the caller just
 * stored it. It exists because Plaid's page lets the user go back and link
 * again, so one token can carry more banks than the one add returns.
 */
export async function settleLinkToken(
  client: PlaidClient,
  linkToken: string,
  configDir: string | undefined,
  keepItemId: string,
): Promise<SettleOutcome> {
  const outcome = emptyOutcome();
  try {
    const response = await client.linkTokenGet(linkToken);
    for (const bank of connectedBanks(response)) {
      await settleBank(client, bank, outcome, configDir, keepItemId);
    }
  } catch (err) {
    log.warn(
      `Could not check the finished Plaid Link session for extra banks: ${toErrorMessage(err)}`,
    );
  }
  await forgetPendingLink(linkToken, configDir);
  return outcome;
}

/**
 * Settle every Link session this host started, gave up on, and has not
 * accounted for since.
 *
 * Never throws: it runs on paths whose own job — building a sync context,
 * starting an add — must not fail because a past session could not be settled.
 */
export async function settlePendingLinks(
  client: PlaidClient,
  configDir?: string,
  now = Date.now,
): Promise<SettleOutcome> {
  const outcome = emptyOutcome();
  let read: { records: PendingLinkRecord[]; discard: string[] };
  try {
    read = readRecords(configDir, now);
  } catch (err) {
    log.warn(`Could not list pending Plaid Link sessions: ${toErrorMessage(err)}`);
    return outcome;
  }
  for (const path of read.discard) await rm(path, { force: true });
  for (const record of read.records) {
    const age = now() - Date.parse(record.created_at);
    // Still young enough that the add which wrote it may be running.
    if (age < SETTLE_GRACE_MS) {
      outcome.kept += 1;
      continue;
    }
    try {
      await settleRecord(client, record, age, outcome, configDir);
    } catch (err) {
      outcome.kept += 1;
      log.warn(`Could not settle a pending Plaid Link session: ${toErrorMessage(err)}`);
    }
  }
  return outcome;
}

async function settleRecord(
  client: PlaidClient,
  record: PendingLinkRecord,
  age: number,
  outcome: SettleOutcome,
  configDir?: string,
): Promise<void> {
  const exhausted = age >= RECORD_MAX_AGE_MS;
  let response: PlaidLinkTokenGetResponse;
  try {
    response = await client.linkTokenGet(record.link_token);
  } catch (err) {
    if (!exhausted) {
      outcome.kept += 1;
      log.debug(`Pending Plaid Link session not readable yet: ${toErrorMessage(err)}`);
      return;
    }
    await giveUp(record, `Plaid will not say how it ended (${toErrorMessage(err)})`, configDir);
    return;
  }

  let settled = true;
  for (const bank of connectedBanks(response)) {
    if (!(await settleBank(client, bank, outcome, configDir))) settled = false;
  }

  // A session the user has not finished has connected nothing yet, and this
  // record is the only handle to the bank they may still be connecting. No
  // session at all says the same thing more strongly: Plaid has not heard from
  // them, and the hosted URL outlives the grace period, so they still might.
  const sessions = response.link_sessions ?? [];
  const running = sessions.length === 0 || sessions.some((s) => !s.finished_at);

  // Settled means every bank Plaid named has been dealt with. The record can
  // then go as soon as no session is still open — or, once Plaid has stopped
  // describing this token's sessions at all, whether or not one looks open,
  // because nothing further will ever arrive to change the answer.
  if (settled && (!running || age >= SESSION_VISIBLE_MS)) {
    await closeSettled(record, sessions, age, outcome, configDir);
    return;
  }
  if (exhausted) {
    await giveUp(record, "it could not be settled", configDir);
    return;
  }
  outcome.kept += 1;
}

/**
 * Drop a settled record, saying something only when there is doubt.
 *
 * While Plaid still describes a session, a finished one carrying no bank
 * connected no bank, and closing it deserves no remark. Once the description
 * has aged out, the same shape is ambiguous: it may have connected something
 * whose details are simply no longer served. That case is worth the operator's
 * attention, and the ones that are not — a session that ended in an exit, a
 * link never opened — are deliberately left quiet, because a warning the
 * operator learns to ignore protects nothing.
 */
async function closeSettled(
  record: PendingLinkRecord,
  sessions: PlaidLinkSession[],
  age: number,
  outcome: SettleOutcome,
  configDir?: string,
): Promise<void> {
  const undescribed =
    age >= SESSION_VISIBLE_MS &&
    sessions.some((s) => s.finished_at && !s.exit?.error && !s.on_exit?.error && !hasBanks(s));
  if (undescribed) {
    outcome.unaccounted += 1;
    log.warn(
      `A Plaid Link session from ${record.created_at} finished without saying what it ` +
        `connected, and Plaid no longer serves its details. If it connected a bank, that bank ` +
        `is not connected here — check the Plaid dashboard.`,
    );
  }
  await forgetPendingLink(record.link_token, configDir);
}

function hasBanks(session: PlaidLinkSession): boolean {
  return Boolean(
    session.results?.item_add_results?.some((r) => r.public_token) ||
    session.on_success?.public_token,
  );
}

async function giveUp(
  record: PendingLinkRecord,
  because: string,
  configDir?: string,
): Promise<void> {
  log.warn(
    `Giving up on a Plaid Link session from ${record.created_at}: ${because}. If a bank was ` +
      `connected in that session it is not connected here — check the Plaid dashboard.`,
  );
  await forgetPendingLink(record.link_token, configDir);
}

/**
 * Settle one bank a session connected. Returns false when the answer is not
 * final, so the record is kept and the next sweep asks again.
 */
async function settleBank(
  client: PlaidClient,
  bank: ConnectedBank,
  outcome: SettleOutcome,
  configDir?: string,
  keepItemId?: string,
): Promise<boolean> {
  let exchanged: { access_token: string; item_id: string };
  try {
    exchanged = await client.itemPublicTokenExchange(bank.publicToken);
  } catch (err) {
    // An outage, a rate limit, or an app credential Plaid is refusing are all
    // answers about this host rather than about the session: ask again later.
    if (isRetryable(err) || isAppCredentialFailure(err)) return false;
    outcome.unreachable.push(describe(bank));
    log.warn(
      `A Plaid Link session connected ${describe(bank)}, but it can no longer be reached from ` +
        `this host (${toErrorMessage(err)}). If it is not among the banks connected here, remove ` +
        `it from the Plaid dashboard to stop its subscriptions and end its bank consent.`,
    );
    return true;
  }

  // Existence, not readability: an item whose credential cannot be decoded is
  // still a connected bank, and must never be disconnected on that basis.
  if (exchanged.item_id === keepItemId || findStoredItem(exchanged.item_id, configDir)) return true;

  const failure = await revokeItem(client, exchanged.item_id, exchanged.access_token);
  if (failure) {
    log.warn(`Could not disconnect the unclaimed Plaid item ${exchanged.item_id}: ${failure}`);
    return false;
  }
  outcome.disconnected.push(exchanged.item_id);
  log.info(
    `Disconnected a Plaid item from an unfinished sign-in (${describe(bank)}) — the connection ` +
      `was never completed on this host`,
  );
  return true;
}

/** An app credential Plaid refuses stops every item, not just this session. */
function isAppCredentialFailure(err: unknown): boolean {
  return err instanceof SyncError && err.kind === "auth" && err.scope === "connection";
}

/** One bank a Link session connected, as `/link/token/get` reports it. */
interface ConnectedBank {
  publicToken: string;
  institutionId?: string;
  institutionName?: string;
}

/**
 * Every distinct bank the token's sessions connected. One token accumulates a
 * session per attempt, a session can add more than one bank, and the same
 * connection is reported through both the current `results` shape and the
 * deprecated `on_success` one — so tokens are de-duplicated. Exchanging one
 * twice would ask Plaid to disconnect the same item twice.
 */
function connectedBanks(response: PlaidLinkTokenGetResponse): ConnectedBank[] {
  const banks = new Map<string, ConnectedBank>();
  const add = (
    publicToken: string | null | undefined,
    institution: { institution_id?: string | null; name?: string | null } | null | undefined,
  ): void => {
    if (!publicToken || banks.has(publicToken)) return;
    banks.set(publicToken, {
      publicToken,
      institutionId: institution?.institution_id ?? undefined,
      institutionName: institution?.name ?? undefined,
    });
  };
  for (const session of response.link_sessions ?? []) {
    for (const added of session.results?.item_add_results ?? []) {
      add(added.public_token, added.institution);
    }
    add(session.on_success?.public_token, session.on_success?.metadata?.institution);
  }
  return [...banks.values()];
}

/** What to call a bank in an operator-facing message. */
function describe(bank: ConnectedBank): string {
  return bank.institutionName ?? bank.institutionId ?? "a bank";
}

/**
 * The records on disk.
 *
 * A record whose content is not a record is deleted at once — the token it was
 * supposed to carry is not in there, so it is a handle to nothing. A record
 * that *threw* on the way in is left alone until it is older than any outage
 * worth waiting through, because the read failing is not proof the file is
 * bad, and a token deleted is a bank that can never be disconnected.
 */
function readRecords(
  configDir?: string,
  now = Date.now,
): { records: PendingLinkRecord[]; discard: string[] } {
  const dir = pendingDir(configDir);
  if (!existsSync(dir)) return { records: [], discard: [] };
  const records: PendingLinkRecord[] = [];
  const discard: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(dir, entry.name);
    let readable = false;
    try {
      const parsed = recordSchema.safeParse(readSecretJsonFileSync<unknown>(path, { configDir }));
      if (parsed.success) {
        records.push(parsed.data);
        continue;
      }
      readable = true;
    } catch (err) {
      // A locked secret store is not a broken record: every record is
      // unreadable until it is unlocked, and deleting them would be permanent.
      if (isSecretFileRootKeyUnavailableError(err)) throw err;
    }
    if (!readable && now() - statSync(path).mtimeMs < RECORD_MAX_AGE_MS) {
      log.debug(`A pending Plaid Link record could not be read (${entry.name}); keeping it`);
      continue;
    }
    log.warn(`Discarding a pending Plaid Link record that cannot be read (${entry.name})`);
    discard.push(path);
  }
  return { records, discard };
}
