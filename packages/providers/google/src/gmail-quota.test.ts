// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer, type Server } from "node:http";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { google } from "googleapis";
import { SyncError } from "@omnesis/types";
import { createMockGmail, createGmailSource, makeGmailMessage } from "./testing/mock-google.js";
import { GmailSource, GMAIL_RETRY_CONFIG, gmailQuotaPacer, type GmailSyncCursor } from "./gmail.js";
import { QuotaPacer } from "./quota-pacer.js";
import {
  GMAIL_PAGE_SIZE,
  GMAIL_QUOTA_BURST_UNITS,
  GMAIL_QUOTA_FLOOR_UNITS_PER_MINUTE,
  GMAIL_QUOTA_QUIET_PERIOD_MS,
  GMAIL_QUOTA_UNITS,
  GMAIL_QUOTA_UNITS_PER_MINUTE,
  GOOGLE_RATE_LIMIT_MAX_DELAY_MS,
} from "./constants.js";
import type { AddressInfo } from "node:net";

/** A Gmail rate-limit failure shaped the way gaxios throws it, with no Retry-After. */
function rateLimited(status = 429, reason = "rateLimitExceeded"): Error {
  const message = "Too many requests";
  return Object.assign(new Error(message), {
    code: status,
    status,
    response: {
      status,
      headers: {},
      data: {
        error: { code: status, message, errors: [{ reason, domain: "usageLimits", message }] },
      },
    },
  });
}

/** A listing served in pages of the requested `maxResults`, newest first. */
function pagedMailbox(ids: string[]) {
  return vi.fn((params: { pageToken?: string; maxResults?: number }) => {
    const size = params.maxResults ?? 100;
    const start = params.pageToken ? Number(params.pageToken) : 0;
    const page = ids.slice(start, start + size);
    const next = start + size < ids.length ? String(start + size) : undefined;
    return Promise.resolve({ data: { messages: page.map((id) => ({ id })), nextPageToken: next } });
  });
}

function mailbox(count: number, prefix = "m"): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(3, "0")}`);
}

/** A message with one PDF attachment, so a fetch also spends an attachment download. */
function messageWithAttachment(id: string): Record<string, unknown> {
  return {
    ...makeGmailMessage(id),
    payload: {
      headers: [
        { name: "Subject", value: "Quarterly budget review" },
        { name: "From", value: "maya.reeves@example.com" },
        { name: "To", value: "jamie.lopez@example.org" },
        { name: "Date", value: "Mon, 01 Jan 2024 00:00:00 +0000" },
      ],
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "text/plain",
          body: { data: Buffer.from("See attached.").toString("base64url") },
        },
        {
          filename: "budget.pdf",
          mimeType: "application/pdf",
          body: { attachmentId: `att-${id}`, size: 2048 },
        },
      ],
    },
  };
}

const attachmentOptions = {
  attachmentConfig: {
    enabled: true,
    maxSizeBytes: 25_000_000,
    allowedTypes: ["application/pdf"],
    maxTextLength: 500_000,
  },
  extractAttachment: vi.fn(() =>
    Promise.resolve({ text: "Budget lines", pages: 1, truncated: false }),
  ),
};

/** Advance fake time until `promise` settles, then return what it settled to. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  while (!done) await vi.advanceTimersByTimeAsync(50);
  return promise;
}

/** The most units spent inside any window of `windowMs`. */
function busiestWindow(spend: Array<{ at: number; units: number }>, windowMs: number): number {
  let busiest = 0;
  for (const start of spend) {
    const total = spend
      .filter((s) => s.at >= start.at && s.at < start.at + windowMs)
      .reduce((sum, s) => sum + s.units, 0);
    busiest = Math.max(busiest, total);
  }
  return busiest;
}

describe("Gmail quota pacing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-02T09:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("a bootstrap never spends more than the per-user minute budget", async () => {
    const gmail = createMockGmail();
    const startedAt = Date.now();
    const spend: Array<{ at: number; units: number }> = [];
    const record =
      <A extends unknown[], R>(units: number, fn: (...args: A) => R) =>
      (...args: A): R => {
        spend.push({ at: Date.now() - startedAt, units });
        return fn(...args);
      };
    gmail.users.getProfile = vi.fn(
      record(GMAIL_QUOTA_UNITS.getProfile, () =>
        Promise.resolve({ data: { messagesTotal: 600, historyId: "h-1" } }),
      ),
    );
    gmail.users.labels.list = vi.fn(
      record(GMAIL_QUOTA_UNITS.labelsList, () => Promise.resolve({ data: { labels: [] } })),
    );
    gmail.users.messages.list = vi.fn(
      record(GMAIL_QUOTA_UNITS.messagesList, pagedMailbox(mailbox(600))),
    );
    gmail.users.messages.get = vi.fn(
      record(GMAIL_QUOTA_UNITS.messagesGetFull, (params: { id: string }) =>
        Promise.resolve({ data: messageWithAttachment(params.id) }),
      ),
    );
    gmail.users.messages.attachments.get = vi.fn(
      record(GMAIL_QUOTA_UNITS.attachmentsGet, () =>
        Promise.resolve({ data: { data: Buffer.from("%PDF-1.4").toString("base64url") } }),
      ),
    );
    const source = createGmailSource(gmail, {
      ...attachmentOptions,
      quota: new QuotaPacer({
        unitsPerMinute: GMAIL_QUOTA_UNITS_PER_MINUTE,
        burstUnits: GMAIL_QUOTA_BURST_UNITS,
      }),
    });

    let cursor: GmailSyncCursor | null = null;
    let fetched = 0;
    while (Date.now() - startedAt < 3 * 60_000) {
      const result = await settle(source.sync(cursor));
      fetched += result.documents.filter((d) => !d.externalId.includes(":")).length;
      cursor = result.cursor as GmailSyncCursor;
      if (!result.hasMore) break;
    }

    expect(gmail.users.messages.list).toHaveBeenCalledWith(
      expect.objectContaining({ maxResults: GMAIL_PAGE_SIZE }),
    );
    expect(busiestWindow(spend, 60_000)).toBeLessThanOrEqual(
      GMAIL_QUOTA_UNITS_PER_MINUTE + GMAIL_QUOTA_BURST_UNITS,
    );
    expect(busiestWindow(spend, 60_000)).toBeLessThan(6_000);
    // Paced, not stalled: roughly 4,000 units a minute at 80 units a message.
    expect(fetched).toBeGreaterThan(140);
  });

  test("a rate limit stops the sync's queued requests from being sent", async () => {
    const gmail = createMockGmail();
    gmail.users.messages.list = pagedMailbox(mailbox(25));
    gmail.users.messages.get = vi.fn(() => Promise.reject(rateLimited()));
    const source = createGmailSource(gmail, {
      quota: new QuotaPacer({ unitsPerMinute: 3_600, burstUnits: 60 }),
    });

    const error = await settle(source.sync(null)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).kind).toBe("rate-limit");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gmail.users.messages.get).toHaveBeenCalledTimes(1);
  });
});

describe("Gmail rate limit mid-page", () => {
  test("a 429 part-way through a page keeps the pages before it and fetches nothing twice", async () => {
    const gmail = createMockGmail();
    const ids = mailbox(50);
    gmail.users.messages.list = pagedMailbox(ids);
    let refused = false;
    gmail.users.messages.get = vi.fn((params: { id: string }) => {
      if (params.id === "m-030" && !refused) {
        refused = true;
        // Refused once the page's other fetches have finished, so the test
        // is about what they leave behind rather than about what was in flight.
        return new Promise((_, reject) => setTimeout(() => reject(rateLimited()), 10));
      }
      return Promise.resolve({ data: makeGmailMessage(params.id) });
    });
    const source = createGmailSource(gmail);

    const committed: string[] = [];
    const first = await source.sync(null);
    committed.push(...first.documents.map((d) => d.externalId));
    const kept = first.cursor as GmailSyncCursor;
    expect(first.hasMore).toBe(true);

    const error = await source.sync(kept).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).kind).toBe("rate-limit");

    const resumed = await source.sync(kept);
    committed.push(...resumed.documents.map((d) => d.externalId));

    expect(resumed.hasMore).toBe(false);
    expect(committed).toEqual(ids);
    const fetchesOf = (id: string) =>
      gmail.users.messages.get.mock.calls.filter(([p]: [{ id: string }]) => p.id === id).length;
    expect(fetchesOf("m-030")).toBe(2);
    for (const id of ids.filter((id) => id !== "m-030")) expect(fetchesOf(id), id).toBe(1);
  });

  test("a 429 on an attachment download fails the page instead of recording the attachment as failed", async () => {
    const gmail = createMockGmail();
    gmail.users.messages.list = pagedMailbox(["m-001"]);
    gmail.users.messages.get = vi.fn((params: { id: string }) =>
      Promise.resolve({ data: messageWithAttachment(params.id) }),
    );
    gmail.users.messages.attachments.get = vi
      .fn()
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValue({ data: { data: Buffer.from("%PDF-1.4").toString("base64url") } });
    const source = createGmailSource(gmail, attachmentOptions);

    const error = await source.sync(null).catch((e: unknown) => e);
    expect((error as SyncError).kind).toBe("rate-limit");

    const result = await source.sync(null);
    const email = result.documents.find((d) => d.externalId === "m-001");
    const attachments = (email?.metadata.extra as { attachments?: Array<{ extracted: boolean }> })
      .attachments;
    expect(attachments).toEqual([expect.objectContaining({ extracted: true })]);
    expect(result.documents).toHaveLength(2);
  });
});

describe("What a rate-limited attempt carries", () => {
  test("an incremental page is fetched afresh on retry, so a label change since is not lost", async () => {
    const gmail = createMockGmail();
    let read = false;
    let refuse = true;
    gmail.users.history.list = vi.fn(() =>
      Promise.resolve({
        data: {
          history: [
            { messagesAdded: [{ message: { id: "a" } }, { message: { id: "b" } }] },
            ...(read ? [{ labelsRemoved: [{ message: { id: "a" }, labelIds: ["UNREAD"] }] }] : []),
          ],
          historyId: read ? "h-3" : "h-2",
        },
      }),
    );
    gmail.users.messages.get = vi.fn((params: { id: string }) => {
      if (params.id === "b" && refuse) {
        refuse = false;
        return Promise.reject(rateLimited());
      }
      const labelIds = params.id === "a" && !read ? ["INBOX", "UNREAD"] : ["INBOX"];
      return Promise.resolve({ data: makeGmailMessage(params.id, { labelIds }) });
    });
    const source = createGmailSource(gmail);
    const cursor: GmailSyncCursor = { phase: "incremental", historyId: "h-1" };

    const error = await source.sync(cursor).catch((e: unknown) => e);
    expect((error as SyncError).kind).toBe("rate-limit");

    read = true;
    const retried = await source.sync(cursor);
    const a = retried.documents.find((d) => d.externalId === "a")!;

    expect((retried.cursor as GmailSyncCursor).historyId).toBe("h-3");
    expect(a.metadata.tags).not.toContain("UNREAD");
    const fetchesOfA = gmail.users.messages.get.mock.calls.filter(
      ([p]: [{ id: string }]) => p.id === "a",
    ).length;
    expect(fetchesOfA).toBe(2);
  });

  test("a message whose label lookup the halt cut short is fetched again with named labels", async () => {
    const gmail = createMockGmail();
    gmail.users.labels.list = vi.fn(() =>
      Promise.resolve({
        data: {
          labels: [
            { id: "INBOX", name: "INBOX" },
            { id: "Label_7", name: "Projects" },
          ],
        },
      }),
    );
    gmail.users.messages.list = vi.fn(() =>
      Promise.resolve({ data: { messages: [{ id: "slow" }, { id: "boom" }] } }),
    );
    let refuse = true;
    gmail.users.messages.get = vi.fn((params: { id: string }) => {
      if (params.id === "boom" && refuse) {
        refuse = false;
        return Promise.reject(rateLimited());
      }
      const msg = { data: makeGmailMessage(params.id, { labelIds: ["INBOX", "Label_7"] }) };
      return params.id === "slow"
        ? new Promise((resolve) => setTimeout(() => resolve(msg), 20))
        : Promise.resolve(msg);
    });
    const source = createGmailSource(gmail);

    const error = await source.sync(null).catch((e: unknown) => e);
    expect((error as SyncError).kind).toBe("rate-limit");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const retried = await source.sync(null);

    for (const id of ["slow", "boom"]) {
      const tags = retried.documents.find((d) => d.externalId === id)!.metadata.tags;
      expect(tags, id).toContain("Projects");
      expect(tags, id).not.toContain("Label_7");
    }
  });

  test("a rate limit on the label listing fails the page instead of tagging raw label ids", async () => {
    const gmail = createMockGmail();
    gmail.users.messages.list = pagedMailbox(["m-001"]);
    gmail.users.messages.get = vi.fn((params: { id: string }) =>
      Promise.resolve({ data: makeGmailMessage(params.id, { labelIds: ["Label_7"] }) }),
    );
    gmail.users.labels.list = vi
      .fn()
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValue({ data: { labels: [{ id: "Label_7", name: "Projects" }] } });
    const source = createGmailSource(gmail);

    const error = await source.sync(null).catch((e: unknown) => e);
    expect((error as SyncError).kind).toBe("rate-limit");

    const retried = await source.sync(null);
    expect(retried.documents[0]!.metadata.tags).toEqual(["Projects"]);
  });
});

describe("Gmail rate-limit back-off", () => {
  test("a 429 without Retry-After defers at least a minute, doubling on each one in a row", async () => {
    const gmail = createMockGmail();
    gmail.users.getProfile = vi.fn(() => Promise.reject(rateLimited()));
    const source = createGmailSource(gmail);

    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const error = (await source.sync(null).catch((e: unknown) => e)) as SyncError;
      expect(error).toBeInstanceOf(SyncError);
      expect(error.kind).toBe("rate-limit");
      delays.push(error.retryAfterMs!);
    }

    expect(delays).toEqual([
      60_000,
      120_000,
      240_000,
      480_000,
      960_000,
      GOOGLE_RATE_LIMIT_MAX_DELAY_MS,
      GOOGLE_RATE_LIMIT_MAX_DELAY_MS,
    ]);
  });

  test.each(["userRateLimitExceeded", "rateLimitExceeded"])(
    "a 403 %s is a rate limit with the same back-off",
    async (reason) => {
      const gmail = createMockGmail();
      gmail.users.history.list = vi.fn(() => Promise.reject(rateLimited(403, reason)));
      const source = createGmailSource(gmail);

      const error = (await source
        .sync({ phase: "incremental", historyId: "h-7" })
        .catch((e: unknown) => e)) as SyncError;

      expect(error.kind).toBe("rate-limit");
      expect(error.retryAfterMs).toBe(60_000);
    },
  );

  test("the time Gmail's message names to retry after is honoured", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-02T09:00:00Z"));
    try {
      const gmail = createMockGmail();
      const message = "User-rate limit exceeded.  Retry after 2026-03-02T09:00:45.000Z";
      gmail.users.getProfile = vi.fn(() =>
        Promise.reject(Object.assign(rateLimited(), { message })),
      );
      const source = createGmailSource(gmail);

      const error = (await source.sync(null).catch((e: unknown) => e)) as SyncError;

      expect(error.retryAfterMs).toBe(45_000);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the delay a Retry-After header names is honoured", async () => {
    const gmail = createMockGmail();
    const withHeader = Object.assign(rateLimited(), {
      response: { status: 429, headers: { "retry-after": "90" } },
    });
    gmail.users.getProfile = vi.fn(() => Promise.reject(withHeader));
    const source = createGmailSource(gmail);

    const error = (await source.sync(null).catch((e: unknown) => e)) as SyncError;

    expect(error.retryAfterMs).toBe(90_000);
  });
});

describe("Gmail rate-limit back-off across pages", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-02T09:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A mailbox whose message fetches are refused while `refuse` is set. */
  function refusableSource() {
    const gmail = createMockGmail();
    gmail.users.getProfile = vi.fn(() =>
      Promise.resolve({ data: { messagesTotal: 1_000, historyId: "h-1" } }),
    );
    gmail.users.messages.list = pagedMailbox(mailbox(1_000));
    let refuse = false;
    gmail.users.messages.get = vi.fn((params: { id: string }) =>
      refuse
        ? Promise.reject(rateLimited())
        : Promise.resolve({ data: makeGmailMessage(params.id) }),
    );
    const source = createGmailSource(gmail);
    let cursor: GmailSyncCursor | null = null;
    return {
      /** Sync one page that lands. */
      land: async () => {
        refuse = false;
        const result = await source.sync(cursor);
        expect(result.documents.length).toBeGreaterThan(0);
        cursor = result.cursor as GmailSyncCursor;
      },
      /** Sync one page that Google refuses, and return the wait it asks for. */
      refused: async () => {
        refuse = true;
        const error = (await source.sync(cursor).catch((e: unknown) => e)) as SyncError;
        refuse = false;
        expect(error.kind).toBe("rate-limit");
        return error.retryAfterMs;
      },
    };
  }

  /** The host's interval between ticks, which a short rate-limit wait never undercuts. */
  const TICK_MS = 5 * 60_000;

  test("the back-off keeps doubling while pages land between rate limits", async () => {
    const mail = refusableSource();
    await mail.land();

    const delays: Array<number | undefined> = [];
    for (let i = 0; i < 5; i++) {
      delays.push(await mail.refused());
      await vi.advanceTimersByTimeAsync(TICK_MS);
      await mail.land();
      await mail.land();
    }

    expect(delays).toEqual([60_000, 120_000, 240_000, 480_000, 960_000]);
  });

  test("a sync that lands a quiet period after the last rate limit resets the back-off", async () => {
    const mail = refusableSource();
    expect(await mail.refused()).toBe(60_000);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    await mail.land();
    expect(await mail.refused()).toBe(120_000);

    await vi.advanceTimersByTimeAsync(GMAIL_QUOTA_QUIET_PERIOD_MS - 1);
    await mail.land();
    expect(await mail.refused(), "a sync landing inside the quiet period").toBe(240_000);

    await vi.advanceTimersByTimeAsync(GMAIL_QUOTA_QUIET_PERIOD_MS);
    expect(await mail.refused(), "a quiet period with no sync that landed").toBe(480_000);

    await vi.advanceTimersByTimeAsync(GMAIL_QUOTA_QUIET_PERIOD_MS);
    await mail.land();
    expect(await mail.refused()).toBe(60_000);
  });
});

describe("Gmail adaptive pace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-02T09:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("a rate limit slows the pace once per sync, however many requests in flight it refuses", async () => {
    const gmail = createMockGmail();
    gmail.users.messages.list = pagedMailbox(mailbox(25));
    gmail.users.messages.get = vi.fn(
      () => new Promise((_, reject) => setTimeout(() => reject(rateLimited()), 10)),
    );
    const quota = gmailQuotaPacer();
    const source = createGmailSource(gmail, { quota });

    const error = await settle(source.sync(null)).catch((e: unknown) => e);

    expect((error as SyncError).kind).toBe("rate-limit");
    expect(gmail.users.messages.get.mock.calls.length).toBeGreaterThan(1);
    expect(quota.unitsPerMinute).toBe(GMAIL_QUOTA_UNITS_PER_MINUTE * 0.75);
  });

  /**
   * Gmail's per-user quota, shared with another client of the same account
   * that spends `neighbourPerMinute` steadily: a request is refused when it
   * would take the units spent in the last minute past the limit. Refused
   * requests spend nothing.
   */
  function sharedQuotaMailbox(neighbourPerMinute: number) {
    const LIMIT = 6_000;
    const startedAt = Date.now();
    const spent: Array<{ at: number; units: number }> = [];
    const refusedAt: number[] = [];
    const charge = <T>(units: number, answer: () => T): Promise<T> => {
      const now = Date.now();
      while (spent.length > 0 && spent[0]!.at <= now - 60_000) spent.shift();
      const ours = spent.reduce((sum, s) => sum + s.units, 0);
      if (ours + units + neighbourPerMinute > LIMIT) {
        refusedAt.push(now - startedAt);
        return Promise.reject(rateLimited(429, "rateLimitExceeded"));
      }
      spent.push({ at: now, units });
      return Promise.resolve(answer());
    };
    const gmail = createMockGmail();
    const listing = pagedMailbox(mailbox(50_000, "n"));
    gmail.users.getProfile = vi.fn(() =>
      charge(GMAIL_QUOTA_UNITS.getProfile, () => ({
        data: { messagesTotal: 50_000, historyId: "h-1" },
      })),
    );
    gmail.users.labels.list = vi.fn(() =>
      charge(GMAIL_QUOTA_UNITS.labelsList, () => ({ data: { labels: [] } })),
    );
    gmail.users.messages.list = vi.fn((params: { pageToken?: string; maxResults?: number }) =>
      charge(GMAIL_QUOTA_UNITS.messagesList, () => listing(params)).then((page) => page),
    );
    gmail.users.messages.get = vi.fn((params: { id: string }) =>
      charge(GMAIL_QUOTA_UNITS.messagesGetFull, () => ({ data: makeGmailMessage(params.id) })),
    );
    return { gmail, refusedAt };
  }

  /** Advance fake time in whole seconds until `promise` settles. */
  async function settleCoarse<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    promise.then(
      () => (done = true),
      () => (done = true),
    );
    while (!done) await vi.advanceTimersByTimeAsync(1_000);
    return promise;
  }

  /**
   * Drive the source the way the collector does: pages back to back while
   * the source says there are more, then the 5-minute interval, or the rate
   * limit's wait when it is longer.
   */
  async function host(source: GmailSource, quota: QuotaPacer, forMs: number) {
    const startedAt = Date.now();
    const paces: Array<{ at: number; pace: number }> = [];
    let cursor: GmailSyncCursor | null = null;
    let fetched = 0;
    while (Date.now() - startedAt < forMs) {
      let waitMs = 5 * 60_000;
      try {
        for (;;) {
          const result = await settleCoarse(source.sync(cursor));
          fetched += result.documents.length;
          cursor = result.cursor as GmailSyncCursor;
          paces.push({ at: Date.now() - startedAt, pace: quota.unitsPerMinute });
          if (!result.hasMore) break;
        }
      } catch (error: unknown) {
        expect((error as SyncError).kind).toBe("rate-limit");
        paces.push({ at: Date.now() - startedAt, pace: quota.unitsPerMinute });
        waitMs = Math.max(waitMs, (error as SyncError).retryAfterMs ?? 0);
      }
      await vi.advanceTimersByTimeAsync(waitMs);
    }
    return { paces, fetched };
  }

  const NEIGHBOUR = 2_600;
  const LEFT = 6_000 - NEIGHBOUR;
  const RUN_MS = 180 * 60_000;
  const HOUR = 60 * 60_000;

  test("a source sharing the quota with another client settles under what is left and stops being refused", async () => {
    const { gmail, refusedAt } = sharedQuotaMailbox(NEIGHBOUR);
    const quota = gmailQuotaPacer();
    const source = createGmailSource(gmail, { quota });

    const { paces, fetched } = await host(source, quota, RUN_MS);

    expect(refusedAt[0], "the ceiling is more than the neighbour leaves").toBeLessThan(2 * 60_000);
    // The longest stretch without a refusal is over an hour, and for the
    // hour it holds the pace a step under the one refused, so under what the
    // neighbour leaves; after it, the pace probes upwards again.
    const bounds = [...refusedAt, RUN_MS];
    let quietest = { from: 0, to: 0 };
    for (let i = 1; i < bounds.length; i++) {
      if (bounds[i]! - bounds[i - 1]! > quietest.to - quietest.from) {
        quietest = { from: bounds[i - 1]!, to: bounds[i]! };
      }
    }
    expect(quietest.to - quietest.from).toBeGreaterThan(HOUR);
    const held = paces.filter((p) => p.at > quietest.from && p.at < quietest.from + HOUR);
    expect(held.length).toBeGreaterThan(0);
    for (const { pace } of held) expect(pace).toBeLessThan(LEFT);
    // Once settled, the source meets the limit at most once an hour, when it
    // probes for room the neighbour may have left.
    expect(refusedAt.filter((at) => at >= HOUR).length).toBeLessThanOrEqual(2);
    for (const { pace } of paces)
      expect(pace).toBeGreaterThanOrEqual(GMAIL_QUOTA_FLOOR_UNITS_PER_MINUTE);
    // Near what is left, not crushed to the floor: about 3,000 units a minute
    // is 49 messages, for 20 minutes of every 25, less the refusals.
    expect(fetched).toBeGreaterThan(6_000);
  });

  test("without the adaptive pace the same neighbour refuses the source all along", async () => {
    const { gmail, refusedAt } = sharedQuotaMailbox(NEIGHBOUR);
    const quota = new QuotaPacer({
      unitsPerMinute: GMAIL_QUOTA_UNITS_PER_MINUTE,
      burstUnits: GMAIL_QUOTA_BURST_UNITS,
    });
    const source = createGmailSource(gmail, { quota });

    const { fetched } = await host(source, quota, RUN_MS);

    expect(refusedAt.filter((at) => at >= HOUR).length).toBeGreaterThan(10);
    expect(fetched).toBeLessThan(2_000);
  });
});

describe("Gmail client retries", () => {
  let server: Server;
  let hits: string[];

  beforeEach(async () => {
    hits = [];
    server = createServer((req, res) => {
      hits.push(req.url ?? "");
      const status = req.url?.includes("/profile") ? 429 : 503;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: status, message: "Too many requests" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("NO_PROXY", "127.0.0.1,localhost");
    vi.stubEnv("no_proxy", "127.0.0.1,localhost");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function realSource(): GmailSource {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: "test-access-token", expiry_date: Date.now() + 3_600_000 });
    const source = new GmailSource(auth, "maya.reeves@example.com", undefined, {
      quota: QuotaPacer.unlimited(),
    });
    const { port } = server.address() as AddressInfo;
    const client = (source as unknown as { gmail: { context: { _options: { rootUrl?: string } } } })
      .gmail;
    client.context._options.rootUrl = `http://127.0.0.1:${port}/`;
    return source;
  }

  test("the client library sends a rate-limited request once and does not retry it", async () => {
    const error = (await realSource()
      .sync(null)
      .catch((e: unknown) => e)) as SyncError;

    expect(error).toBeInstanceOf(SyncError);
    expect(error.kind).toBe("rate-limit");
    expect(error.retryAfterMs).toBe(60_000);
    expect(hits.filter((url) => url.includes("/profile"))).toHaveLength(1);
  });

  test("the retry config keeps server-error retries and drops 429", () => {
    const ranges = GMAIL_RETRY_CONFIG.statusCodesToRetry;
    const retried = (status: number) => ranges.some(([lo, hi]) => status >= lo! && status <= hi!);
    expect(retried(429)).toBe(false);
    expect(retried(503)).toBe(true);
    expect(retried(408)).toBe(true);
  });
});
