// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createLogger,
  computeContentHash,
  normalizeEmail,
  normalizePhone,
  countryNameToISO2,
} from "@omnesis/core";
import { emptySync, SnapshotEnumeration } from "@omnesis/source-sdk";
import { SourceId, ProviderId } from "@omnesis/types";
import { validateAppleContactsSyncCursor } from "./types.js";
import { coreDataToISO } from "./note-parser.js";
import { contactsDbFile } from "./paths.js";
import { throwOnOpenFailure } from "./db-helpers/internal.js";
import type { SnapshotClaim, SyncCursor, SyncResult } from "@omnesis/source-sdk";
import type { AppleProvider } from "./provider.js";
import type { CountryCode } from "libphonenumber-js";
import type {
  AppleContactsSyncCursor,
  RawContact,
  RawContactEmail,
  RawContactPhone,
  RawContactAddress,
  RawContactUrl,
  RawContactSocial,
  RawContactDate,
} from "./types.js";
import type { DocumentInput, PersonMention, SyncIssue } from "@omnesis/types";

const log = createLogger("source:apple-contacts");

const PAGE_SIZE = 100;

/** Strip Apple's internal label markers like _$!<Home>!$_ → Home */
function cleanLabel(label: string | null): string | undefined {
  if (!label) return undefined;
  const match = label.match(/_\$!<(.+?)>!\$_/);
  return match ? match[1] : label;
}

/**
 * Run a SELECT defensively. Returns [] if the table or columns don't exist on
 * this macOS version. The AddressBook schema has been stable for years but
 * we still treat missing fields as a soft failure rather than crashing sync.
 */
function safeSelect<T>(db: import("better-sqlite3").Database, sql: string, params: unknown[]): T[] {
  try {
    // better-sqlite3's `.all` accepts variadic SQL bind params; the
    // method signature uses `unknown` so the cast just spreads our
    // typed array of bindable values into the variadic slot.
    return db.prepare(sql).all(...params) as T[];
  } catch (err) {
    log.debug(
      `Optional contacts query skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/** Format a postal address into a single-line string. */
function formatAddress(a: RawContactAddress): string {
  const parts: string[] = [];
  if (a.street) parts.push(a.street);
  const cityParts: string[] = [];
  if (a.city) cityParts.push(a.city);
  if (a.state) cityParts.push(a.state);
  if (a.zip) cityParts.push(a.zip);
  if (cityParts.length > 0) parts.push(cityParts.join(", "));
  if (a.country) parts.push(a.country);
  return parts.join(", ");
}

/** Build a display name from contact fields. */
function buildName(contact: RawContact): string {
  const parts: string[] = [];
  if (contact.firstName) parts.push(contact.firstName);
  if (contact.middleName) parts.push(contact.middleName);
  if (contact.lastName) parts.push(contact.lastName);
  if (parts.length > 0) return parts.join(" ");
  if (contact.organization) return contact.organization;
  if (contact.nickname) return contact.nickname;
  return "Unnamed Contact";
}

/**
 * Apple Contacts source.
 * Reads contacts from the local AddressBook database and produces one document per contact.
 */
export class AppleContactsSource {
  readonly id: SourceId;
  readonly providerId: ProviderId;

  readonly watchPaths: string[];
  readonly dataCutoff?: string;

  constructor(
    private provider: AppleProvider,
    private opts: {
      sourceId: string;
      providerId: string;
      dataCutoff?: string;
      phoneRegion?: string;
    },
  ) {
    this.id = SourceId(opts.sourceId);
    this.providerId = ProviderId(opts.providerId);
    // Watch the actual DB + WAL files in each source directory
    const dirPath = provider.contactsDirFilePath;
    const sourcesDir = join(dirPath, "Sources");
    const paths: string[] = [];
    if (existsSync(sourcesDir)) {
      try {
        for (const dir of readdirSync(sourcesDir)) {
          const dbPath = contactsDbFile(join(sourcesDir, dir));
          paths.push(dbPath, `${dbPath}-wal`);
        }
      } catch {
        /* skip */
      }
    }
    // Fallback to main DB
    if (paths.length === 0) {
      const mainDb = contactsDbFile(dirPath);
      paths.push(mainDb, `${mainDb}-wal`);
    }
    this.watchPaths = paths;
    this.dataCutoff = opts?.dataCutoff;
  }

  async sync(cursor: SyncCursor | null): Promise<SyncResult> {
    // Every address book the scan found, readable or not. The unreadable ones
    // are what stops this cycle from claiming a complete snapshot.
    const stores = this.provider.getContactsStores();
    const open = stores.filter((s) => s.kind === "open");
    const dbs = open.map((s) => s.db);
    // Which address book each row came from, by its position in `dbs`. It is
    // stamped on every document so a per-book claim can be acted on: a claim
    // says "this book holds exactly these", and that is only actionable if the
    // gateway can tell which of its documents are in the book.
    const partitionOf = (dbIndex: number): string => open[dbIndex]?.key ?? "";
    if (dbs.length === 0) {
      for (const store of stores) {
        if (store.kind === "unavailable") {
          log.warn(`Address book ${store.key} ${store.reason}; no contacts read this cycle`);
        }
      }
      // Not one address book opened. If that is because of a denial or a lock,
      // it is this source's failure to report rather than an empty sync.
      throwOnOpenFailure(this.provider.getContactsOpenFailure());
      return emptySync(cursor ?? { lastModifiedTimestamp: 0 });
    }

    const state = validateAppleContactsSyncCursor(cursor);
    const lastModified = state?.lastModifiedTimestamp ?? 0;
    // Secondary cursor key. Paired with `lastModified` it forms a composite
    // `(modificationDate, uniqueId)` watermark so contacts sharing the
    // page-boundary modificationDate aren't dropped: the next page resumes
    // at the same timestamp for any `uniqueId` strictly after this one.
    const lastUniqueId = state?.lastUniqueId ?? "";

    // Query all source databases and merge results
    let totalContacts = 0;
    const allRows: (RawContact & { _dbIndex: number })[] = [];
    const emailsByUniqueId = new Map<string, RawContactEmail[]>();
    const phonesByUniqueId = new Map<string, RawContactPhone[]>();
    const addressesByUniqueId = new Map<string, RawContactAddress[]>();
    const urlsByUniqueId = new Map<string, RawContactUrl[]>();
    const socialsByUniqueId = new Map<string, RawContactSocial[]>();
    const datesByUniqueId = new Map<string, RawContactDate[]>();
    // Tombstones from `ZABCDDELETEDRECORDLOG`. That log is empty on
    // iCloud-backed Macs, where the snapshot below is the only reliable
    // deletion signal.
    const deletedIds = new Set<string>();

    // Compute the cycle queue total (contacts modified-since-cursor across
    // every source DB) once on the first page and pin it in the cursor so
    // pages 2+ don't re-count. Same shape as the Notes/Reminders sources.
    let pinnedQueueTotal: number | undefined = state?.cycleQueueTotal;

    for (let i = 0; i < dbs.length; i++) {
      const db = dbs[i];

      if (pinnedQueueTotal === undefined) {
        const countResult = db
          .prepare(
            `SELECT COUNT(*) as count FROM ZABCDRECORD
             WHERE Z_ENT = 22
               AND (ZMODIFICATIONDATE > ? OR (ZMODIFICATIONDATE = ? AND ZUNIQUEID > ?))`,
          )
          .get(lastModified, lastModified, lastUniqueId) as { count: number };
        totalContacts += countResult.count;
      }

      // Push the page bound into SQL: fetch up to PAGE_SIZE+1 modified rows
      // ordered by the composite `(modificationDate, uniqueId)` key so each
      // DB contributes at most a small chunk to the in-memory merge. The
      // composite ordering + `(modDate > cursor) OR (modDate = cursor AND
      // uniqueId > cursorUid)` predicate guarantees contacts tied on the
      // page-boundary modificationDate aren't skipped when paging resumes.
      const rows = db
        .prepare(
          `SELECT
            Z_PK as pk,
            ZFIRSTNAME as firstName,
            ZLASTNAME as lastName,
            ZMIDDLENAME as middleName,
            ZORGANIZATION as organization,
            ZDEPARTMENT as department,
            ZJOBTITLE as jobTitle,
            ZNICKNAME as nickname,
            ZCREATIONDATE as creationDate,
            ZMODIFICATIONDATE as modificationDate,
            ZUNIQUEID as uniqueId,
            ZCONTAINERWHERECONTACTISME as isMe
          FROM ZABCDRECORD
          WHERE Z_ENT = 22
            AND (ZMODIFICATIONDATE > ? OR (ZMODIFICATIONDATE = ? AND ZUNIQUEID > ?))
          ORDER BY ZMODIFICATIONDATE ASC, ZUNIQUEID ASC
          LIMIT ?`,
        )
        .all(lastModified, lastModified, lastUniqueId, PAGE_SIZE + 1) as RawContact[];

      for (const row of rows) {
        allRows.push({ ...row, _dbIndex: i });
      }

      // Fetch emails and phones for modified contacts
      const pks = rows.map((r) => r.pk);
      if (pks.length > 0) {
        const placeholders = pks.map(() => "?").join(",");

        const emails = db
          .prepare(
            `SELECT ZOWNER as ownerPk, ZADDRESS as address, ZLABEL as label
             FROM ZABCDEMAILADDRESS
             WHERE ZOWNER IN (${placeholders})
             ORDER BY ZORDERINGINDEX ASC`,
          )
          .all(...pks) as RawContactEmail[];

        // Map emails by uniqueId (via pk→uniqueId lookup)
        const pkToUniqueId = new Map(rows.map((r) => [r.pk, r.uniqueId]));
        for (const e of emails) {
          const uid = pkToUniqueId.get(e.ownerPk);
          if (!uid) continue;
          if (!emailsByUniqueId.has(uid)) emailsByUniqueId.set(uid, []);
          emailsByUniqueId.get(uid)!.push(e);
        }

        let phones = safeSelect<RawContactPhone>(
          db,
          `SELECT ZOWNER as ownerPk, ZFULLNUMBER as fullNumber, ZLABEL as label,
                  ZCOUNTRYCODE as countryCode
             FROM ZABCDPHONENUMBER
             WHERE ZOWNER IN (${placeholders})
             ORDER BY ZORDERINGINDEX ASC`,
          pks,
        );
        if (phones.length === 0) {
          phones = safeSelect<RawContactPhone>(
            db,
            `SELECT ZOWNER as ownerPk, ZFULLNUMBER as fullNumber, ZLABEL as label,
                    NULL as countryCode
               FROM ZABCDPHONENUMBER
               WHERE ZOWNER IN (${placeholders})
               ORDER BY ZORDERINGINDEX ASC`,
            pks,
          );
        }

        for (const p of phones) {
          const uid = pkToUniqueId.get(p.ownerPk);
          if (!uid) continue;
          if (!phonesByUniqueId.has(uid)) phonesByUniqueId.set(uid, []);
          phonesByUniqueId.get(uid)!.push(p);
        }

        // Postal addresses, URLs, social profiles, dates — all use safeSelect
        // because column names vary slightly between macOS versions and we'd
        // rather degrade gracefully than crash sync on a schema mismatch.
        const addresses = safeSelect<RawContactAddress>(
          db,
          `SELECT ZOWNER as ownerPk,
                  ZSTREET as street, ZCITY as city, ZSTATE as state,
                  ZZIPCODE as zip, ZCOUNTRYNAME as country, ZLABEL as label
           FROM ZABCDPOSTALADDRESS
           WHERE ZOWNER IN (${placeholders})
           ORDER BY ZORDERINGINDEX ASC`,
          pks,
        );
        for (const a of addresses) {
          const uid = pkToUniqueId.get(a.ownerPk);
          if (!uid) continue;
          if (!addressesByUniqueId.has(uid)) addressesByUniqueId.set(uid, []);
          addressesByUniqueId.get(uid)!.push(a);
        }

        const urls = safeSelect<RawContactUrl>(
          db,
          `SELECT ZOWNER as ownerPk, ZURL as url, ZLABEL as label
           FROM ZABCDURLADDRESS
           WHERE ZOWNER IN (${placeholders})
             AND ZURL IS NOT NULL
           ORDER BY ZORDERINGINDEX ASC`,
          pks,
        );
        for (const u of urls) {
          const uid = pkToUniqueId.get(u.ownerPk);
          if (!uid) continue;
          if (!urlsByUniqueId.has(uid)) urlsByUniqueId.set(uid, []);
          urlsByUniqueId.get(uid)!.push(u);
        }

        const socials = safeSelect<RawContactSocial>(
          db,
          `SELECT ZOWNER as ownerPk,
                  ZSERVICENAME as service, ZUSERNAME as username,
                  ZURL as url, ZLABEL as label
           FROM ZABCDSOCIALPROFILE
           WHERE ZOWNER IN (${placeholders})
           ORDER BY ZORDERINGINDEX ASC`,
          pks,
        );
        for (const s of socials) {
          const uid = pkToUniqueId.get(s.ownerPk);
          if (!uid) continue;
          if (!socialsByUniqueId.has(uid)) socialsByUniqueId.set(uid, []);
          socialsByUniqueId.get(uid)!.push(s);
        }

        const dates = safeSelect<RawContactDate>(
          db,
          `SELECT ZOWNER as ownerPk, ZVALUE as value, ZLABEL as label
           FROM ZABCDDATE
           WHERE ZOWNER IN (${placeholders})
           ORDER BY ZORDERINGINDEX ASC`,
          pks,
        );
        for (const d of dates) {
          const uid = pkToUniqueId.get(d.ownerPk);
          if (!uid) continue;
          if (!datesByUniqueId.has(uid)) datesByUniqueId.set(uid, []);
          datesByUniqueId.get(uid)!.push(d);
        }
      }

      // Detect deleted contacts (works on local-only Macs; empty on
      // iCloud-backed Macs — covered separately by snapshot reconciliation
      // below).
      const deletedRows = db
        .prepare("SELECT ZDELETEDRECORDUNIQUEID as uniqueId FROM ZABCDDELETEDRECORDLOG")
        .all() as { uniqueId: string }[];
      for (const r of deletedRows) deletedIds.add(r.uniqueId);
    }

    // Pin the queue total once we've summed it on the first page.
    if (pinnedQueueTotal === undefined) pinnedQueueTotal = totalContacts;
    else totalContacts = pinnedQueueTotal;

    // Deduplicate by uniqueId — keep the most recently modified version
    const byUniqueId = new Map<string, RawContact & { _dbIndex: number }>();
    for (const row of allRows) {
      const existing = byUniqueId.get(row.uniqueId);
      if (!existing || row.modificationDate > existing.modificationDate) {
        byUniqueId.set(row.uniqueId, row);
      }
    }
    // Secondary sort uses code-unit comparison (not `localeCompare`) to match
    // SQLite's default BINARY collation on `ZUNIQUEID`, so the in-memory page
    // ordering and the SQL `ZUNIQUEID > ?` cursor predicate stay consistent.
    const pageRows = Array.from(byUniqueId.values())
      .sort(
        (a, b) =>
          a.modificationDate - b.modificationDate ||
          (a.uniqueId < b.uniqueId ? -1 : a.uniqueId > b.uniqueId ? 1 : 0),
      )
      .slice(0, PAGE_SIZE);
    const hasMore = byUniqueId.size > PAGE_SIZE;

    // Advance the composite `(modificationDate, uniqueId)` watermark to the
    // last row of this page (the highest key, since pageRows is sorted ASC).
    // The watermark must cover every pageRow — emitted or skipped below — or
    // a skipped boundary-tied row would re-surface forever. An empty page
    // leaves the cursor untouched.
    const lastPageRow = pageRows.length > 0 ? pageRows[pageRows.length - 1] : undefined;
    const maxModified = lastPageRow ? lastPageRow.modificationDate : lastModified;
    const maxUniqueId = lastPageRow ? lastPageRow.uniqueId : lastUniqueId;

    const documents: DocumentInput[] = [];

    for (const row of pageRows) {
      const name = buildName(row);
      const contactEmails = emailsByUniqueId.get(row.uniqueId) ?? [];
      const contactPhones = phonesByUniqueId.get(row.uniqueId) ?? [];
      const contactAddresses = addressesByUniqueId.get(row.uniqueId) ?? [];
      const contactUrls = urlsByUniqueId.get(row.uniqueId) ?? [];
      const contactSocials = socialsByUniqueId.get(row.uniqueId) ?? [];
      const contactDates = datesByUniqueId.get(row.uniqueId) ?? [];

      // Skip empty duplicate cards (Apple syncs 'me' across multiple
      // containers; only the isMe=true one or ones with real data are
      // useful). Confirms the audit on 2026-05-05.
      const hasIdentifyingData =
        contactEmails.length > 0 ||
        contactPhones.length > 0 ||
        contactAddresses.length > 0 ||
        contactUrls.length > 0 ||
        contactSocials.length > 0 ||
        contactDates.length > 0;
      if (!hasIdentifyingData && !row.isMe) {
        continue;
      }

      // Build markdown content
      const contentParts: string[] = [`# ${name}`];

      if (row.organization || row.jobTitle || row.department) {
        const orgParts: string[] = [];
        if (row.jobTitle) orgParts.push(row.jobTitle);
        if (row.department) orgParts.push(row.department);
        if (row.organization) orgParts.push(row.organization);
        contentParts.push("", orgParts.join(", "));
      }

      if (contactEmails.length > 0) {
        contentParts.push("");
        for (const e of contactEmails) {
          const label = cleanLabel(e.label);
          contentParts.push(`- **Email${label ? ` (${label})` : ""}:** ${e.address}`);
        }
      }

      if (contactPhones.length > 0) {
        contentParts.push("");
        for (const p of contactPhones) {
          const label = cleanLabel(p.label);
          contentParts.push(`- **Phone${label ? ` (${label})` : ""}:** ${p.fullNumber}`);
        }
      }

      // Birthdays + custom dates: surface separately so birthday-driven
      // calendar/event linking can later key off metadata.extra.birthday.
      let birthdayIso: string | undefined;
      const datesForExtra: Array<{ label?: string; iso: string }> = [];
      if (contactDates.length > 0) {
        for (const d of contactDates) {
          if (d.value === null || d.value === undefined) continue;
          let iso: string;
          try {
            iso = coreDataToISO(d.value);
          } catch {
            continue;
          }
          const label = cleanLabel(d.label);
          datesForExtra.push({ label, iso });
          // Heuristic: a label of "Birthday" (any case) becomes the
          // canonical extra.birthday field.
          if (!birthdayIso && label?.toLowerCase() === "birthday") {
            birthdayIso = iso.split("T")[0];
          }
        }
        if (datesForExtra.length > 0) {
          contentParts.push("");
          for (const d of datesForExtra) {
            const lbl = d.label ?? "Date";
            contentParts.push(`- **${lbl}:** ${d.iso.split("T")[0]}`);
          }
        }
      }

      if (contactAddresses.length > 0) {
        contentParts.push("");
        for (const a of contactAddresses) {
          const label = cleanLabel(a.label);
          const formatted = formatAddress(a);
          if (!formatted) continue;
          contentParts.push(`- **Address${label ? ` (${label})` : ""}:** ${formatted}`);
        }
      }

      if (contactUrls.length > 0) {
        contentParts.push("");
        for (const u of contactUrls) {
          const label = cleanLabel(u.label);
          contentParts.push(`- **URL${label ? ` (${label})` : ""}:** ${u.url}`);
        }
      }

      if (contactSocials.length > 0) {
        contentParts.push("");
        for (const s of contactSocials) {
          const service = s.service ?? cleanLabel(s.label) ?? "Social";
          const handle = s.username ?? s.url ?? "";
          if (!handle) continue;
          contentParts.push(`- **${service}:** ${handle}`);
        }
      }

      if (row.nickname) {
        contentParts.push("", `**Nickname:** ${row.nickname}`);
      }

      const content = contentParts.join("\n");

      // Build PersonMention with all emails and phones
      const normalizedEmails = contactEmails.map((e) => normalizeEmail(e.address)).filter(Boolean);
      // Prefer Apple's per-number country, then the first postal address,
      // then the collector's captured OS region. Explicit +/00 numbers remain
      // self-describing and are handled before this hint chain.
      const addressRegion = countryNameToISO2(contactAddresses[0]?.country ?? undefined);
      const deviceRegion = countryNameToISO2(this.opts.phoneRegion);
      const normalizedPhones = contactPhones
        .map((p) => {
          const hints: CountryCode[] = [];
          const numberRegion = countryNameToISO2(
            typeof p.countryCode === "string" ? p.countryCode : undefined,
          );
          for (const region of [numberRegion, addressRegion, deviceRegion]) {
            if (region && !hints.includes(region)) hints.push(region);
          }
          return normalizePhone(p.fullNumber, hints.length > 0 ? hints : undefined);
        })
        .filter((p): p is string => p !== null);

      const person: PersonMention = {
        role: "contact",
        name,
        emails: normalizedEmails.length > 0 ? normalizedEmails : undefined,
        phones: normalizedPhones.length > 0 ? normalizedPhones : undefined,
      };

      const addressesForExtra = contactAddresses
        .map((a) => ({
          label: cleanLabel(a.label),
          street: a.street ?? undefined,
          city: a.city ?? undefined,
          state: a.state ?? undefined,
          zip: a.zip ?? undefined,
          country: a.country ?? undefined,
          formatted: formatAddress(a),
        }))
        .filter((a) => a.formatted.length > 0);

      const urlsForExtra = contactUrls.map((u) => ({
        label: cleanLabel(u.label),
        url: u.url,
      }));

      const socialsForExtra = contactSocials
        .filter((s) => (s.username ?? s.url ?? "").length > 0)
        .map((s) => ({
          service: s.service ?? undefined,
          username: s.username ?? undefined,
          url: s.url ?? undefined,
          label: cleanLabel(s.label),
        }));

      const doc: DocumentInput = {
        providerId: this.providerId,
        sourceId: this.id,
        externalId: row.uniqueId,
        partitionKey: partitionOf(row._dbIndex),
        title: name,
        content,
        contentHash: computeContentHash(content),
        metadata: {
          documentType: "contact",
          people: [person],
          extra: {
            organization: row.organization ?? undefined,
            jobTitle: row.jobTitle ?? undefined,
            department: row.department ?? undefined,
            isMe: !!row.isMe,
            addresses: addressesForExtra.length > 0 ? addressesForExtra : undefined,
            urls: urlsForExtra.length > 0 ? urlsForExtra : undefined,
            socialProfiles: socialsForExtra.length > 0 ? socialsForExtra : undefined,
            dates: datesForExtra.length > 0 ? datesForExtra : undefined,
            birthday: birthdayIso,
          },
        },
        sourceCreatedAt: coreDataToISO(row.creationDate),
        sourceUpdatedAt: coreDataToISO(row.modificationDate),
      };

      documents.push(doc);
    }

    const deletedExternalIds = Array.from(deletedIds);

    // Operation-level bootstrap flag: page 1 sets it (cursor was empty);
    // subsequent pages preserve it until the run completes. Without this,
    // pages 2+ of a multi-page bootstrap log as "incremental" because the
    // cursor advanced past 0 between pages — confusing in production logs.
    const startedAsBootstrap = lastModified === 0;
    const inBootstrap = startedAsBootstrap || (state?.bootstrapInProgress ?? false);
    // Snapshot reconciliation: only emit on the final page of the sync run,
    // and only when the snapshot actually changed since last cycle. The
    // signature is one
    // `<book>=<count>:<MAX(modificationDate)>:<MAX(pk)>:<SUM(modificationDate)>`
    // term per readable address book, sorted so it does not depend on the
    // order the books happened to open.
    //
    // Count and newest-modification alone cannot tell "nothing happened" from
    // "one contact joined and one left": deleting the most recently edited
    // contact returns both to the values the last published snapshot carried,
    // and the deletion is then invisible until some unrelated contact changes.
    // `MAX(Z_PK)` catches a join — Core Data keys are monotone, so a row that
    // ever existed raises it permanently — and the modification-date total
    // catches an exchange that leaves the count alone. Same four terms, for
    // the same reason, as the notes signature.
    //
    // The full ID enumeration is the costly bit (one SELECT per DB returning
    // every contact); skipping it on a no-op cycle is the dominant win for a
    // large address book.
    let presentExternalIds: string[] | undefined;
    let issues: SyncIssue[] | undefined;
    let presentClaims: SnapshotClaim[] | undefined;
    let snapshotSignature = state?.lastSnapshotSignature;
    if (!hasMore) {
      // Keyed by address book so the signature identifies which books it
      // describes, rather than being a positional list of whichever ones were
      // readable — a book returning after a failure then changes it and forces
      // a re-enumeration, and a change in open order does not.
      const openStores = stores.flatMap((s) => (s.kind === "open" ? [s] : []));
      const sigParts: string[] = [];
      for (const store of openStores) {
        const row = store.db
          .prepare(
            `SELECT COUNT(*) as cnt, COALESCE(MAX(ZMODIFICATIONDATE), 0) as maxMod,
                    COALESCE(MAX(Z_PK), 0) as maxPk,
                    CAST(ROUND(COALESCE(TOTAL(ZMODIFICATIONDATE), 0)) AS INTEGER) as sumMod
             FROM ZABCDRECORD WHERE Z_ENT = 22`,
          )
          .get() as { cnt: number; maxMod: number; maxPk: number; sumMod: number };
        sigParts.push(`${store.key}=${row.cnt}:${row.maxMod}:${row.maxPk}:${row.sumMod}`);
      }
      const newSignature = sigParts.sort().join("|");

      // The signature short-circuit is an optimisation for the healthy path. A
      // cycle that could not read an address book always walks the enumeration
      // anyway, so the warning can name exactly which books are missing from it
      // — a degraded cycle whose readable stores happen to be unchanged would
      // otherwise pass in silence.
      const degraded = stores.some((s) => s.kind === "unavailable");
      if (degraded || newSignature !== state?.lastSnapshotSignature) {
        const snapshot = new SnapshotEnumeration(stores.map((s) => s.key));
        for (const store of stores) {
          if (store.kind === "unavailable") {
            snapshot.gap(store.key, store.reason);
            continue;
          }
          const allRowsInDb = store.db
            .prepare("SELECT ZUNIQUEID as uniqueId FROM ZABCDRECORD WHERE Z_ENT = 22")
            .all() as { uniqueId: string }[];
          snapshot.cover(
            store.key,
            allRowsInDb.map((r) => r.uniqueId),
          );
        }
        for (const id of deletedIds) snapshot.exclude(id);
        // A read that covered every book vouches for the whole source, which
        // is the strongest thing it can say and the only thing that reaches a
        // document stored before this source knew about books at all.
        //
        // Claims are the degraded cycle's form. Withholding the snapshot
        // outright would suspend deletion detection for every book that did
        // open, for as long as the broken one stays broken — which, for a
        // revoked permission, is until someone notices. Instead the books
        // that opened vouch for themselves, and only for what they name.
        const issue = snapshot.withheldIssue();
        issues = issue ? [issue] : [];
        if (snapshot.complete) {
          presentExternalIds = snapshot.result();
          // Only a cycle that vouched for every book advances the signature,
          // so a degraded one keeps comparing against the last complete read.
          snapshotSignature = newSignature;
        } else {
          presentClaims = snapshot.claims();
          log.warn(snapshot.withheldReason()!);
        }
      }
    }
    log.info(
      `Sync produced ${documents.length} contacts, -${deletedExternalIds.length} (${inBootstrap ? "bootstrap" : "incremental"}, hasMore: ${hasMore}, snapshot: ${presentExternalIds ? `${presentExternalIds.length} ids` : presentClaims ? `${presentClaims.length} book(s)` : "unchanged"})`,
    );

    return {
      documents,
      deletedExternalIds,
      presentExternalIds,
      presentClaims,
      issues,
      cursor: {
        lastModifiedTimestamp: maxModified,
        // Secondary key of the composite `(modificationDate, uniqueId)`
        // watermark; omit the default empty value so the cursor stays tidy.
        lastUniqueId: maxUniqueId === "" ? undefined : maxUniqueId,
        // Carry the bootstrap flag forward across pages; clear once the
        // walk finishes (so the next sync cycle doesn't mis-label).
        bootstrapInProgress: inBootstrap && hasMore ? true : undefined,
        // Pin the queue total across the cycle so pages 2+ skip the
        // re-count (the count is one extra SELECT per source DB).
        cycleQueueTotal: hasMore ? pinnedQueueTotal : undefined,
        lastSnapshotSignature: snapshotSignature,
      } satisfies AppleContactsSyncCursor,
      hasMore,
      progress: inBootstrap
        ? {
            phase: "bootstrap",
            processed: documents.length,
            total: totalContacts,
          }
        : undefined,
    };
  }
}
