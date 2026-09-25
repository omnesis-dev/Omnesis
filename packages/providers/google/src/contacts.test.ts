// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, vi } from "vitest";
import type { PersonMention } from "@omnesis/types";

/**
 * Google Contacts source tests.
 * Since we can't mock the googleapis module without affecting other tests,
 * we test the normalization logic directly by importing and calling the
 * source with a fake auth client. The actual API calls are tested via
 * integration tests with real credentials.
 */

// Test the normalization by creating the source and checking its properties
describe("GoogleContactsSource", () => {
  test("source id includes account", async () => {
    // Dynamic import to avoid googleapis initialization issues in test
    const { GoogleContactsSource } = await import("./contacts.js");
    const source = new GoogleContactsSource({} as any, "test@gmail.com");
    expect(String(source.id)).toBe("google-contacts:test@gmail.com");
  });

  test("source id without account", async () => {
    const { GoogleContactsSource } = await import("./contacts.js");
    const source = new GoogleContactsSource({} as any);
    expect(String(source.id)).toBe("google-contacts");
  });

  test("renders extended fields (addresses, birthday, urls, events, bio) and surfaces them via metadata.extra", async () => {
    // Reproduces google-contacts-missing-fields: previously PERSON_FIELDS
    // omitted addresses/birthdays/urls/events so even when set in Google
    // Contacts they never reached the rendered card or metadata.extra.
    const { GoogleContactsSource } = await import("./contacts.js");
    const source = new GoogleContactsSource({} as any, "u@example.com");
    const mockPerson = {
      resourceName: "people/c123",
      names: [{ displayName: "Alice Example" }],
      emailAddresses: [{ value: "alice@example.com", type: "home" }],
      phoneNumbers: [{ value: "+15551234567", canonicalForm: "+15551234567", type: "mobile" }],
      addresses: [
        {
          type: "home",
          formattedValue: "10 Main St, NYC, NY 10001, USA",
          streetAddress: "10 Main St",
          city: "NYC",
        },
      ],
      urls: [{ value: "https://alice.example.com", type: "blog" }],
      birthdays: [{ date: { year: 1990, month: 4, day: 15 } }],
      events: [{ date: { month: 6, day: 20 }, type: "anniversary" }],
      biographies: [{ value: "Software engineer who likes climbing." }],
      nicknames: [{ value: "Ali" }],
      organizations: [{ name: "Acme", title: "Engineer" }],
      metadata: { sources: [{ updateTime: "2026-01-01T00:00:00Z" }] },
    };
    const listMock = vi.fn(() =>
      Promise.resolve({ data: { connections: [mockPerson], nextSyncToken: "tok-1" } }),
    );
    const mockPeople = { people: { connections: { list: listMock } } };
    Object.defineProperty(source, "people", {
      value: mockPeople,
      writable: true,
      configurable: true,
    });

    const result = await source.sync(null);
    const doc = result.documents[0];

    expect(doc.content).toContain("**Birthday:** 1990-04-15");
    expect(doc.content).toContain("10 Main St, NYC, NY 10001, USA");
    expect(doc.content).toContain("https://alice.example.com");
    expect(doc.content).toContain("Anniversary");
    expect(doc.content).toContain("Software engineer who likes climbing.");

    const extra = doc.metadata.extra as Record<string, any>;
    expect(extra.birthday).toBe("1990-04-15");
    expect(extra.addresses).toHaveLength(1);
    expect(extra.urls).toEqual([{ label: "Blog", url: "https://alice.example.com" }]);
    expect(extra.events).toEqual([{ label: "Anniversary", iso: "--06-20" }]);
    expect(extra.biography).toBe("Software engineer who likes climbing.");
    expect(extra.nickname).toBe("Ali");

    const requested = (listMock as any).mock.calls[0][0].personFields;
    expect(requested).toContain("addresses");
    expect(requested).toContain("birthdays");
    expect(requested).toContain("urls");
    expect(requested).toContain("events");
  });

  test('phones with the "00" international gateway prefix normalize to E.164 in mentions and survive raw in the body', async () => {
    // Reproduces the bug: real Google contacts often store phones
    // with a "00" prefix instead of "+", which pre-fix dropped to null
    // (or got mis-attributed). Verify both ends of the body↔mention
    // invariant: the markdown body keeps the user-typed string, the
    // PersonMention.phones array carries E.164.
    const { GoogleContactsSource } = await import("./contacts.js");
    const source = new GoogleContactsSource({} as any, "u@example.com");
    const rawPhone = "00 33 6 39 98 00 33";
    const expectedE164 = "+33639980033";
    const mockPerson = {
      resourceName: "people/c280",
      names: [{ displayName: "Bob French" }],
      phoneNumbers: [{ value: rawPhone, type: "mobile" }],
      metadata: { sources: [{ updateTime: "2026-01-01T00:00:00Z" }] },
    };
    const listMock = vi.fn(() =>
      Promise.resolve({ data: { connections: [mockPerson], nextSyncToken: "tok-280" } }),
    );
    Object.defineProperty(source, "people", {
      value: { people: { connections: { list: listMock } } },
      writable: true,
      configurable: true,
    });

    const result = await source.sync(null);
    const doc = result.documents[0];

    // Mention side: phone is normalized to E.164.
    const people = doc.metadata.people as PersonMention[];
    expect(people).toHaveLength(1);
    expect(people[0].phones).toEqual([expectedE164]);

    // Body side: the user-typed raw form is preserved in the markdown.
    expect(doc.content).toContain(rawPhone);
  });

  test("region inference from address.countryCode: bare-national French phone normalizes to E.164", async () => {
    // Covers region inference for Google Contacts: a
    // contact with `addresses[0].countryCode: "FR"` and a bare-national
    // phone like "06 39 98 00 33" used to drop because Google's
    // canonicalForm wasn't populated and the value path had no region
    // hint. Now the provider feeds address.countryCode (or address.country
    // mapped via countryNameToISO2) as a region hint, so the phone
    // parses to +33639980033.
    const { GoogleContactsSource } = await import("./contacts.js");
    const source = new GoogleContactsSource({} as any, "u@example.com");
    const rawPhone = "06 39 98 00 33";
    const expectedE164 = "+33639980033";
    const mockPerson = {
      resourceName: "people/c280-fr",
      names: [{ displayName: "Jamie Lopez" }],
      // No canonicalForm — forces the value path through normalizePhone
      // with the region hint derived from the address.
      phoneNumbers: [{ value: rawPhone, type: "mobile" }],
      addresses: [{ type: "home", countryCode: "FR", country: "France" }],
      metadata: { sources: [{ updateTime: "2026-01-01T00:00:00Z" }] },
    };
    const listMock = vi.fn(() =>
      Promise.resolve({ data: { connections: [mockPerson], nextSyncToken: "tok-280-fr" } }),
    );
    Object.defineProperty(source, "people", {
      value: { people: { connections: { list: listMock } } },
      writable: true,
      configurable: true,
    });

    const result = await source.sync(null);
    const doc = result.documents[0];

    const people = doc.metadata.people as PersonMention[];
    expect(people).toHaveLength(1);
    expect(people[0].phones).toEqual([expectedE164]);
    // Body still preserves the raw form.
    expect(doc.content).toContain(rawPhone);
  });

  test("region inference falls back to address.country (display name) when countryCode is missing", async () => {
    // Some Google contact cards have only the display name, no ISO
    // code. countryNameToISO2 must catch the common ones and map them.
    const { GoogleContactsSource } = await import("./contacts.js");
    const source = new GoogleContactsSource({} as any, "u@example.com");
    const mockPerson = {
      resourceName: "people/c280-fr-name",
      names: [{ displayName: "FR by name" }],
      phoneNumbers: [{ value: "06 39 98 00 33", type: "mobile" }],
      addresses: [{ type: "home", country: "France" }],
      metadata: { sources: [{ updateTime: "2026-01-01T00:00:00Z" }] },
    };
    const listMock = vi.fn(() => Promise.resolve({ data: { connections: [mockPerson] } }));
    Object.defineProperty(source, "people", {
      value: { people: { connections: { list: listMock } } },
      writable: true,
      configurable: true,
    });

    const result = await source.sync(null);
    const doc = result.documents[0];
    const people = doc.metadata.people as PersonMention[];
    expect(people[0].phones).toEqual(["+33639980033"]);
  });

  test("region inference: contact with no address still parses E.164 phones via existing chain", async () => {
    // No-address contact: the region-hint list stays empty, but an
    // already-international phone still parses thanks to the "starts
    // with +" path of normalizePhone.
    const { GoogleContactsSource } = await import("./contacts.js");
    const source = new GoogleContactsSource({} as any, "u@example.com");
    const mockPerson = {
      resourceName: "people/c280-no-addr",
      names: [{ displayName: "No Address" }],
      phoneNumbers: [{ value: "+33639980033", type: "mobile" }],
      metadata: { sources: [{ updateTime: "2026-01-01T00:00:00Z" }] },
    };
    const listMock = vi.fn(() => Promise.resolve({ data: { connections: [mockPerson] } }));
    Object.defineProperty(source, "people", {
      value: { people: { connections: { list: listMock } } },
      writable: true,
      configurable: true,
    });

    const result = await source.sync(null);
    const doc = result.documents[0];
    const people = doc.metadata.people as PersonMention[];
    expect(people[0].phones).toEqual(["+33639980033"]);
  });

  test("bootstrap requests requestSyncToken=true so it can transition to incremental", async () => {
    // Reproduces google-contacts-bootstrap-loop-no-synctoken: previously
    // bootstrap omitted requestSyncToken so Google never returned a
    // nextSyncToken, the cursor never carried syncToken, and every sync
    // re-walked every contact.
    const { GoogleContactsSource } = await import("./contacts.js");
    const source = new GoogleContactsSource({} as any, "u@example.com");
    let captured: any = null;
    const mockPeople = {
      people: {
        connections: {
          list: vi.fn((params: any) => {
            captured = params;
            return Promise.resolve({
              data: { connections: [], nextSyncToken: "sync-token-1" },
            });
          }),
        },
      },
    };
    Object.defineProperty(source, "people", {
      value: mockPeople,
      writable: true,
      configurable: true,
    });

    const result = await source.sync(null);

    expect(captured).not.toBeNull();
    expect(captured.requestSyncToken).toBe(true);
    // Google rejects DESCENDING when requestSyncToken is set; must be ASCENDING.
    expect(captured.sortOrder).toBe("LAST_MODIFIED_ASCENDING");
    // Cursor carries syncToken so the next sync can call the incremental path.
    expect((result.cursor as any).syncToken).toBe("sync-token-1");
    expect(result.hasMore).toBe(false);
  });

  // People API signals an expired sync token with HTTP 400 + a
  // "Sync token is expired. Clear local cache and retry call without
  // the sync token." message body — Calendar's 410 GONE convention
  // doesn't apply here. The recovery contract: detect either shape
  // and re-bootstrap from scratch, so the source never stays stuck
  // in `error` on a transient cursor problem.
  test("incremental: 400 + 'Sync token is expired' message falls back to bootstrap", async () => {
    const { GoogleContactsSource } = await import("./contacts.js");
    const source = new GoogleContactsSource({} as any, "u@example.com");
    const calls: any[] = [];
    const mockPeople = {
      people: {
        connections: {
          list: vi.fn((params: any) => {
            calls.push(params);
            // First call (incremental, has syncToken) fails with the
            // People-API-specific shape. Second call (bootstrap, no
            // syncToken) succeeds.
            if (params.syncToken) {
              const err: any = new Error(
                "Sync token is expired. Clear local cache and retry call without the sync token.",
              );
              err.code = 400;
              return Promise.reject(err);
            }
            return Promise.resolve({
              data: { connections: [], nextSyncToken: "sync-token-fresh" },
            });
          }),
        },
      },
    };
    Object.defineProperty(source, "people", {
      value: mockPeople,
      writable: true,
      configurable: true,
    });

    const result = await source.sync({ syncToken: "stale-token" } as any);

    expect(calls).toHaveLength(2);
    expect(calls[0].syncToken).toBe("stale-token");
    expect(calls[1].syncToken).toBeUndefined();
    expect((result.cursor as any).syncToken).toBe("sync-token-fresh");
  });

  test("incremental: 410 GONE also falls back to bootstrap (defensive)", async () => {
    // The People API doesn't use 410 today, but Calendar does and
    // Google occasionally aligns APIs. Cheap to handle both shapes;
    // this test pins the 410 branch so it can't silently regress.
    const { GoogleContactsSource } = await import("./contacts.js");
    const source = new GoogleContactsSource({} as any, "u@example.com");
    const mockPeople = {
      people: {
        connections: {
          list: vi.fn((params: any) => {
            if (params.syncToken) {
              const err: any = new Error("Sync token not found");
              err.code = 410;
              return Promise.reject(err);
            }
            return Promise.resolve({
              data: { connections: [], nextSyncToken: "sync-token-fresh" },
            });
          }),
        },
      },
    };
    Object.defineProperty(source, "people", {
      value: mockPeople,
      writable: true,
      configurable: true,
    });

    const result = await source.sync({ syncToken: "stale-token" } as any);
    expect((result.cursor as any).syncToken).toBe("sync-token-fresh");
  });

  test("incremental: non-stale-token 400 still throws (no false positive)", async () => {
    // Pins the boundary of `isExpiredSyncTokenError`: unrelated 400s
    // must continue to surface as errors. Without the call-count
    // assertion, an over-broad regex could trigger a spurious
    // re-bootstrap that also throws `/personFields/` and the test
    // would still pass.
    const { GoogleContactsSource } = await import("./contacts.js");
    const source = new GoogleContactsSource({} as any, "u@example.com");
    const listMock = vi.fn(() => {
      const err: any = new Error("Bad Request: invalid personFields value");
      err.code = 400;
      return Promise.reject(err);
    });
    Object.defineProperty(source, "people", {
      value: { people: { connections: { list: listMock } } },
      writable: true,
      configurable: true,
    });

    await expect(source.sync({ syncToken: "any-token" } as any)).rejects.toThrow(/personFields/);
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  test("incremental: realistic GaxiosError shape (message buried in response.data.error.message) recovers", async () => {
    // When google-auth-library's `transporters.processError` hoists
    // the API message onto `err.message` we already match via
    // `e.message`. This test pins the OTHER shape: a raw GaxiosError
    // whose top-level `.message` is the generic "Request failed with
    // status code 400" and whose API copy lives only at
    // `response.data.error.message`. The helper must dig into the
    // nested field so we don't depend on a particular auth-library
    // version's message-overwrite behaviour.
    const { GoogleContactsSource } = await import("./contacts.js");
    const source = new GoogleContactsSource({} as any, "u@example.com");
    const calls: any[] = [];
    const mockPeople = {
      people: {
        connections: {
          list: vi.fn((params: any) => {
            calls.push(params);
            if (params.syncToken) {
              const err: any = new Error("Request failed with status code 400");
              err.code = 400;
              err.status = 400;
              err.response = {
                status: 400,
                data: {
                  error: {
                    code: 400,
                    message:
                      "Sync token is expired. Clear local cache and retry call without the sync token.",
                    status: "INVALID_ARGUMENT",
                  },
                },
              };
              return Promise.reject(err);
            }
            return Promise.resolve({
              data: { connections: [], nextSyncToken: "sync-token-fresh" },
            });
          }),
        },
      },
    };
    Object.defineProperty(source, "people", {
      value: mockPeople,
      writable: true,
      configurable: true,
    });

    const result = await source.sync({ syncToken: "stale-token" } as any);

    expect(calls).toHaveLength(2);
    expect(calls[1].syncToken).toBeUndefined();
    expect((result.cursor as any).syncToken).toBe("sync-token-fresh");
  });

  test("bootstrap: stale pageToken triggers restart from scratch", async () => {
    // Mid-bootstrap, the saved pageToken from a previous cycle can
    // expire — same recovery path (drop the offending token, walk from
    // the top). Without the pageToken guard this would surface as an
    // error and leave the source stuck.
    const { GoogleContactsSource } = await import("./contacts.js");
    const source = new GoogleContactsSource({} as any, "u@example.com");
    const calls: any[] = [];
    const mockPeople = {
      people: {
        connections: {
          list: vi.fn((params: any) => {
            calls.push(params);
            if (params.pageToken === "stale-page") {
              const err: any = new Error("Sync token is expired.");
              err.code = 400;
              return Promise.reject(err);
            }
            return Promise.resolve({
              data: { connections: [], nextSyncToken: "sync-token-fresh" },
            });
          }),
        },
      },
    };
    Object.defineProperty(source, "people", {
      value: mockPeople,
      writable: true,
      configurable: true,
    });

    const result = await source.sync({ pageToken: "stale-page" } as any);

    expect(calls).toHaveLength(2);
    expect(calls[0].pageToken).toBe("stale-page");
    expect(calls[1].pageToken).toBeUndefined();
    expect((result.cursor as any).syncToken).toBe("sync-token-fresh");
  });
});
