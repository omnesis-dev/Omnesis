// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { google, type people_v1 } from "googleapis";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;
import {
  createLogger,
  computeContentHash,
  normalizeEmail,
  normalizePhone,
  countryNameToISO2,
} from "@omnesis/core";
import { makeCursorValidator } from "@omnesis/source-sdk";
import { SourceId, ProviderId } from "@omnesis/types";
import { mapGoogleApiError } from "./api-error.js";
import { GOOGLE_PAGE_SIZE, CONTACTS_PERSON_FIELDS } from "./constants.js";
import type { SyncCursor, SyncResult } from "@omnesis/source-sdk";
import type { DocumentInput, PersonMention } from "@omnesis/types";
import type { CountryCode } from "libphonenumber-js";

const log = createLogger("source:google-contacts");

export interface ContactsSyncCursor extends SyncCursor {
  syncToken?: string;
  pageToken?: string;
  /** Documents ingested so far in the current cycle; resets between cycles. */
  processedThisCycle?: number;
}

export function isContactsSyncCursor(v: unknown): v is ContactsSyncCursor {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  if (c.syncToken !== undefined && typeof c.syncToken !== "string") return false;
  if (c.pageToken !== undefined && typeof c.pageToken !== "string") return false;
  if (c.processedThisCycle !== undefined && typeof c.processedThisCycle !== "number") return false;
  return true;
}

const validateContactsSyncCursor = makeCursorValidator(isContactsSyncCursor);

const EXPIRED_SYNC_TOKEN_PATTERN = /\bsync\s*token\b.*\bexpired\b/i;

/**
 * Detect the Google People API's "stale cursor" error so we can drop
 * the local syncToken / pageToken and re-bootstrap. Two distinct shapes:
 *
 *   1. **HTTP 410 GONE** — Google's general convention (e.g. Calendar).
 *      The People API doesn't emit this shape, but accepting it here
 *      protects against alignment in either direction.
 *   2. **HTTP 400 + "Sync token is expired. …" message** — the People
 *      API's shape. There's no machine-readable reason code; the
 *      message text is the only signal. The text can live either on
 *      the error's own `.message` (google-auth-library's
 *      `transporters.processError` copies it there) or on
 *      `response.data.error.message` (raw shape if the auth-library
 *      transport is bypassed). We check both so version drift in the
 *      `processError` overwrite can't break recovery.
 *
 * Returning `true` here means the caller should retry from a fresh
 * bootstrap. Returning `false` means the error is something else
 * (auth, rate-limit, …) and should fall through to `mapGoogleApiError`.
 */
function isExpiredSyncTokenError(err: unknown): boolean {
  const e = err as
    | {
        code?: number;
        message?: string;
        response?: { data?: { error?: { message?: string } | string } };
      }
    | undefined;
  if (!e) return false;
  if (e.code === 410) return true;
  if (e.code !== 400) return false;
  if (typeof e.message === "string" && EXPIRED_SYNC_TOKEN_PATTERN.test(e.message)) {
    return true;
  }
  const nested = e.response?.data?.error;
  if (nested && typeof nested === "object" && typeof nested.message === "string") {
    return EXPIRED_SYNC_TOKEN_PATTERN.test(nested.message);
  }
  return false;
}

/** Clean a phone number label from Google's format. */
function cleanLabel(label: string | undefined): string | undefined {
  if (!label) return undefined;
  // Google uses labels like "home", "work", "mobile", etc.
  return label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();
}

/**
 * Google Contacts source.
 * Fetches contacts from the Google People API and produces one document per contact.
 */
export class GoogleContactsSource {
  readonly id: SourceId;
  readonly providerId: ProviderId;

  private people: people_v1.People;

  constructor(auth: OAuth2Client, accountId?: string) {
    this.people = google.people({ version: "v1", auth });
    this.id = SourceId(accountId ? `google-contacts:${accountId}` : "google-contacts");
    this.providerId = ProviderId(accountId ? `google:${accountId}` : "google");
  }

  async sync(cursor: SyncCursor | null): Promise<SyncResult> {
    const state = validateContactsSyncCursor(cursor) ?? {};

    // One typed boundary for every phase. The mapper returns an existing
    // `SyncError` unchanged, so paths that already classify themselves are
    // unaffected; this is what stops an unclassified SDK throw — a transport
    // failure above all — reaching the collector as kind `unknown` with a
    // message that names neither the API nor the request.
    try {
      if (state.syncToken) {
        return await this.incrementalSync(state);
      }
      return await this.bootstrapSync(state);
    } catch (error: unknown) {
      throw mapGoogleApiError(error);
    }
  }

  private async bootstrapSync(state: ContactsSyncCursor): Promise<SyncResult> {
    const documents: DocumentInput[] = [];
    let syncToken: string | undefined;
    let nextPageToken: string | undefined;

    try {
      // `requestSyncToken: true` is what makes Google return a `nextSyncToken`
      // on the final bootstrap page. Without it, syncToken stays undefined
      // and the cursor never transitions to incremental — every cycle
      // re-walks every contact. Google rejects sortOrder=DESCENDING when
      // requestSyncToken is set, so we use ASCENDING here.
      const res = await this.people.people.connections.list({
        resourceName: "people/me",
        pageSize: GOOGLE_PAGE_SIZE,
        personFields: CONTACTS_PERSON_FIELDS,
        pageToken: state.pageToken ?? undefined,
        sortOrder: "LAST_MODIFIED_ASCENDING",
        requestSyncToken: true,
      });

      const connections = res.data.connections ?? [];
      for (const person of connections) {
        const doc = this.normalizePerson(person);
        if (doc) documents.push(doc);
      }

      nextPageToken = res.data.nextPageToken ?? undefined;
      if (!nextPageToken) {
        syncToken = res.data.nextSyncToken ?? undefined;
      }
    } catch (err) {
      // A stale `pageToken` left over from a partially-completed
      // bootstrap cycle (Google rotates connection list pageTokens
      // fairly aggressively) shows up exactly the same way an expired
      // syncToken does on the incremental path — HTTP 400 with the
      // "Sync token is expired" message text. Drop the offending
      // pageToken and start the bootstrap walk from scratch instead of
      // surfacing the failure to the user.
      //
      // The recursive `bootstrapSync({})` discards `processedThisCycle`;
      // that's the right call here because the restarted walk replays
      // the same connections from the top, so preserving the counter
      // would double-count. Users see the progress bar reset for this
      // cycle.
      if (state.pageToken && isExpiredSyncTokenError(err)) {
        log.warn("Contacts bootstrap pageToken expired, restarting from scratch");
        return this.bootstrapSync({});
      }
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Bootstrap sync failed: ${msg}`);
      throw mapGoogleApiError(err);
    }

    const hasMore = !!nextPageToken;
    const processedThisCycle = (state.processedThisCycle ?? 0) + documents.length;

    log.info(
      `Bootstrap sync: ${documents.length} contacts (cycle total: ${processedThisCycle}, hasMore: ${hasMore})`,
    );

    return {
      documents,
      deletedExternalIds: [],
      cursor: {
        syncToken,
        pageToken: nextPageToken,
        processedThisCycle: hasMore ? processedThisCycle : undefined,
      } satisfies ContactsSyncCursor,
      hasMore,
      progress: {
        phase: "bootstrap",
        processed: processedThisCycle,
      },
    };
  }

  private async incrementalSync(state: ContactsSyncCursor): Promise<SyncResult> {
    const documents: DocumentInput[] = [];
    const deletedExternalIds: string[] = [];

    try {
      // When `pageToken` is present we're resuming a multi-page incremental
      // walk: pass both the original `syncToken` and the `pageToken` so Google
      // continues the same delta stream instead of starting a new one.
      const res = await this.people.people.connections.list({
        resourceName: "people/me",
        pageSize: GOOGLE_PAGE_SIZE,
        personFields: CONTACTS_PERSON_FIELDS,
        syncToken: state.syncToken,
        pageToken: state.pageToken ?? undefined,
        requestSyncToken: true,
      });

      const connections = res.data.connections ?? [];
      for (const person of connections) {
        // Check if person was deleted (metadata.deleted is true for sync responses)
        if (person.metadata?.deleted) {
          if (person.resourceName) {
            deletedExternalIds.push(person.resourceName);
          }
          continue;
        }

        const doc = this.normalizePerson(person);
        if (doc) documents.push(doc);
      }

      const nextPageToken = res.data.nextPageToken ?? undefined;
      // Advance `syncToken` only on the last page (Google only sets
      // `nextSyncToken` once the delta is fully drained). Otherwise hold the
      // existing token unchanged so the next sync resumes pagination.
      const newSyncToken = nextPageToken
        ? state.syncToken
        : (res.data.nextSyncToken ?? state.syncToken);

      const hasMore = !!nextPageToken;
      const processedThisCycle = (state.processedThisCycle ?? 0) + documents.length;

      log.info(
        `Incremental sync: ${documents.length} updated, ${deletedExternalIds.length} deleted (cycle total: ${processedThisCycle}, hasMore: ${hasMore})`,
      );

      return {
        documents,
        deletedExternalIds,
        cursor: {
          syncToken: newSyncToken,
          pageToken: nextPageToken,
          processedThisCycle: hasMore ? processedThisCycle : undefined,
        } satisfies ContactsSyncCursor,
        hasMore,
        progress: {
          phase: "incremental",
          processed: processedThisCycle,
        },
      };
    } catch (err: unknown) {
      // People API signals an expired syncToken with HTTP 400 + the
      // message "Sync token is expired. …" — NOT 410 GONE like
      // Calendar uses. `isExpiredSyncTokenError` recognises both
      // shapes; recovery is a full re-bootstrap, which discards
      // accumulated delta progress but is the only way back to a
      // useful cursor.
      if (isExpiredSyncTokenError(err)) {
        log.warn("Contacts sync token expired, triggering full re-sync");
        return this.bootstrapSync({});
      }
      throw mapGoogleApiError(err);
    }
  }

  private normalizePerson(person: people_v1.Schema$Person): DocumentInput | null {
    if (!person.resourceName) return null;

    // Build display name
    const primaryName = person.names?.[0];
    const displayName =
      primaryName?.displayName ??
      person.nicknames?.[0]?.value ??
      person.organizations?.[0]?.name ??
      person.emailAddresses?.[0]?.value ??
      "Unnamed Contact";

    const emails = (person.emailAddresses ?? [])
      .filter((e) => e.value)
      .map((e) => normalizeEmail(e.value!));
    // Region inference (closes the #280 follow-up): Google's first
    // address carries `countryCode` (already ISO-2 when populated) and/or
    // `country` (display name). Use them as a region hint so bare-national
    // numbers like "06 39 98 00 33" for a French contact normalize to
    // +33639980033. countryCode wins because it's already ISO-2 — the
    // mapper short-circuits two-letter input.
    const phoneRegionHints: CountryCode[] = [];
    const firstAddress = person.addresses?.[0];
    const inferredRegion = countryNameToISO2(
      firstAddress?.countryCode ?? firstAddress?.country ?? undefined,
    );
    if (inferredRegion) phoneRegionHints.push(inferredRegion);
    // Prefer Google's `canonicalForm` (already E.164 when Google parsed
    // it successfully) before falling back to the user-typed `value`.
    // For the value path, normalizePhone tries the inferred address
    // region first, then the system locale, then "US" — covers the
    // common case where the user typed a national-format number against
    // their own country.
    const phones = (person.phoneNumbers ?? [])
      .map((p) => {
        const candidate = p.canonicalForm ?? p.value;
        if (!candidate) return null;
        return normalizePhone(
          candidate,
          phoneRegionHints.length > 0 ? phoneRegionHints : undefined,
        );
      })
      .filter((p): p is string => p !== null);

    // Build markdown content
    const contentParts: string[] = [`# ${displayName}`];

    const org = person.organizations?.[0];
    if (org) {
      const orgParts: string[] = [];
      if (org.title) orgParts.push(org.title);
      if (org.department) orgParts.push(org.department);
      if (org.name) orgParts.push(org.name);
      if (orgParts.length > 0) contentParts.push("", orgParts.join(", "));
    }

    if (person.emailAddresses?.length) {
      contentParts.push("");
      for (const e of person.emailAddresses) {
        const label = cleanLabel(e.type ?? undefined);
        contentParts.push(`- **Email${label ? ` (${label})` : ""}:** ${e.value}`);
      }
    }

    if (person.phoneNumbers?.length) {
      contentParts.push("");
      for (const p of person.phoneNumbers) {
        const label = cleanLabel(p.type ?? undefined);
        contentParts.push(`- **Phone${label ? ` (${label})` : ""}:** ${p.value}`);
      }
    }

    // Birthday: Google's date is `{ year?, month, day }`, year is often
    // omitted. Render and surface a YYYY-MM-DD where year exists, or
    // `--MM-DD` style otherwise.
    let birthdayIso: string | undefined;
    const birthday = person.birthdays?.[0]?.date;
    if (birthday && birthday.month && birthday.day) {
      const m = String(birthday.month).padStart(2, "0");
      const d = String(birthday.day).padStart(2, "0");
      birthdayIso = birthday.year ? `${birthday.year}-${m}-${d}` : `--${m}-${d}`;
    }
    if (birthdayIso) {
      contentParts.push("", `**Birthday:** ${birthdayIso}`);
    }

    if (person.addresses?.length) {
      contentParts.push("");
      for (const a of person.addresses) {
        const label = cleanLabel(a.type ?? undefined);
        const formatted =
          a.formattedValue ??
          [a.streetAddress, a.city, a.region, a.postalCode, a.country].filter(Boolean).join(", ");
        if (!formatted) continue;
        contentParts.push(`- **Address${label ? ` (${label})` : ""}:** ${formatted}`);
      }
    }

    if (person.urls?.length) {
      contentParts.push("");
      for (const u of person.urls) {
        if (!u.value) continue;
        const label = cleanLabel(u.type ?? undefined);
        contentParts.push(`- **URL${label ? ` (${label})` : ""}:** ${u.value}`);
      }
    }

    if (person.events?.length) {
      contentParts.push("");
      for (const e of person.events) {
        const label = cleanLabel(e.type ?? undefined) ?? "Event";
        const d = e.date;
        if (!d?.month || !d?.day) continue;
        const m = String(d.month).padStart(2, "0");
        const day = String(d.day).padStart(2, "0");
        const iso = d.year ? `${d.year}-${m}-${day}` : `--${m}-${day}`;
        contentParts.push(`- **${label}:** ${iso}`);
      }
    }

    if (person.biographies?.[0]?.value) {
      contentParts.push("", person.biographies[0].value);
    }

    const content = contentParts.join("\n");

    // Machine-readable copies for downstream queries / future cross-source
    // linking (birthday → calendar events, etc.).
    const addressesForExtra = (person.addresses ?? [])
      .map((a) => ({
        label: cleanLabel(a.type ?? undefined),
        formatted: a.formattedValue ?? undefined,
        street: a.streetAddress ?? undefined,
        city: a.city ?? undefined,
        region: a.region ?? undefined,
        postalCode: a.postalCode ?? undefined,
        country: a.country ?? undefined,
      }))
      .filter((a) => a.formatted || a.street || a.city);

    const urlsForExtra = (person.urls ?? [])
      .filter((u) => u.value)
      .map((u) => ({ label: cleanLabel(u.type ?? undefined), url: u.value! }));

    const eventsForExtra = (person.events ?? [])
      .filter((e) => e.date?.month && e.date?.day)
      .map((e) => {
        const d = e.date!;
        const m = String(d.month).padStart(2, "0");
        const day = String(d.day).padStart(2, "0");
        return {
          label: cleanLabel(e.type ?? undefined),
          iso: d.year ? `${d.year}-${m}-${day}` : `--${m}-${day}`,
        };
      });

    // Build PersonMention
    const mention: PersonMention = {
      role: "contact",
      name: displayName !== "Unnamed Contact" ? displayName : undefined,
      emails: emails.length > 0 ? emails : undefined,
      phones: phones.length > 0 ? phones : undefined,
    };

    // Timestamps
    const sourceMeta = person.metadata?.sources?.[0];
    const updateTime = sourceMeta?.updateTime ?? new Date().toISOString();

    return {
      providerId: this.providerId,
      sourceId: this.id,
      externalId: person.resourceName,
      title: displayName,
      content,
      contentHash: computeContentHash(content),
      metadata: {
        documentType: "contact",
        people: [mention],
        extra: {
          organization: org?.name ?? undefined,
          jobTitle: org?.title ?? undefined,
          department: org?.department ?? undefined,
          birthday: birthdayIso,
          addresses: addressesForExtra.length > 0 ? addressesForExtra : undefined,
          urls: urlsForExtra.length > 0 ? urlsForExtra : undefined,
          events: eventsForExtra.length > 0 ? eventsForExtra : undefined,
          biography: person.biographies?.[0]?.value ?? undefined,
          nickname: person.nicknames?.[0]?.value ?? undefined,
        },
      },
      sourceCreatedAt: updateTime,
      sourceUpdatedAt: updateTime,
    };
  }
}
